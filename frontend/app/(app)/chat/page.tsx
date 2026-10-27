"use client";

import { IconPlus, IconX } from "@tabler/icons-react";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ConversationMessage } from "@/components/ConversationMessage";
import {
  Button,
  ButtonLink,
  ErrorNote,
  Muted,
  Textarea,
  WaitingState,
} from "@/components/ui";
import {
  ensureCurrentWeek,
  fetchHome,
  fetchTempoWorkouts,
  fetchThread,
  fetchWeeks,
  postMidWeekChat,
  type TempoWorkoutSummary,
  type ThreadMessage,
  type UnitPreference,
  type WeekSession,
} from "@/lib/api";
import { dayLabel, runTypeLabel } from "@/lib/checkIn";
import { ApiError, describeError, mayStillBeRunning, type UiError } from "@/lib/errors";
import { distanceLabel, localYmd } from "@/lib/units";

/** "Tue Oct 20 · Easy run · 6.2 mi" */
function runLabel(w: TempoWorkoutSummary, unit: UnitPreference, timeZone: string): string {
  return [
    dayLabel(localYmd(w.startedAt, timeZone)),
    runTypeLabel(w.runType ?? null),
    distanceLabel(w.distanceM, unit),
  ].join(" · ");
}

/** A message on its way: what was sent and what the thread held before it. */
type Sending = {
  body: string;
  /** The run attached to the message, so a failed send can put it back. */
  run: TempoWorkoutSummary | null;
  athleteBefore: number;
  coachBefore: number;
  /** "waiting" while the request is open; "recovering" once the connection gave up. */
  phase: "waiting" | "recovering";
};

const POLL_MS = 10_000;
/** Ten-second looks for two minutes. */
const POLL_LIMIT = 12;

const countRole = (messages: ThreadMessage[], role: ThreadMessage["role"]) =>
  messages.filter((m) => m.role === role).length;

/** Your message and the coach's answer on its way, shown until the real ones arrive. */
function PendingExchange({ sending, stored }: { sending: Sending; stored: boolean }) {
  return (
    <>
      {stored ? null : (
        <article className="flex flex-col gap-1 border-b border-border pb-3">
          <header className="flex items-baseline gap-3">
            <span className="font-semibold">You</span>
            <span className="text-sm text-muted">Just now</span>
          </header>
          <p className="m-0 whitespace-pre-wrap">{sending.body}</p>
        </article>
      )}
      <article className="flex flex-col gap-1 pb-3" role="status" aria-live="polite">
        <header className="flex items-baseline gap-3">
          <span className="font-semibold">Coach Cade</span>
        </header>
        <p className="m-0 text-muted">
          {sending.phase === "recovering"
            ? "Coach Cade may still be replying; this will update shortly."
            : "Coach Cade is replying…"}
        </p>
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="h-3 w-4/5 animate-pulse rounded-tempo bg-raised" />
          <div className="h-3 w-3/5 animate-pulse rounded-tempo bg-raised" />
        </div>
      </article>
    </>
  );
}

function ChatInner() {
  const params = useSearchParams();
  // "Something came up" on Home arrives here with the day's session quoted.
  const about = params.get("about") ?? "";
  const pastWeekId = params.get("week");

  const [loaded, setLoaded] = useState(false);
  const [week, setWeek] = useState<WeekSession | null>(null);
  // A past week's conversation can be read but not added to.
  const [readOnly, setReadOnly] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState(about);
  const [unit, setUnit] = useState<UnitPreference>("imperial");
  const [recentRuns, setRecentRuns] = useState<TempoWorkoutSummary[]>([]);
  const [picking, setPicking] = useState(false);
  const [attached, setAttached] = useState<TempoWorkoutSummary | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const current = await ensureCurrentWeek();
    let target = current;
    if (pastWeekId && pastWeekId !== current.id) {
      const found = (await fetchWeeks()).weeks.find((w) => w.id === pastWeekId);
      if (found) target = found;
    }
    setWeek(target);
    setReadOnly(target.id !== current.id);
    const data = await fetchThread(target.id);
    setMessages(data.messages);
    setLoaded(true);
    return target;
  }, [pastWeekId]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const target = await load();
        if (cancelled) return;
        try {
          const home = await fetchHome();
          if (!cancelled) setUnit(home.units);
        } catch {
          /* miles until the units are known */
        }
        try {
          // This week and the week before, newest first.
          const lookback = new Date(target.start);
          lookback.setUTCDate(lookback.getUTCDate() - 7);
          const listed = await fetchTempoWorkouts({
            startDate: lookback.toISOString(),
            endDate: target.end,
            pageSize: 20,
            sortBy: "startedAt",
            sortOrder: "desc",
          });
          if (!cancelled) setRecentRuns(listed.items);
        } catch {
          if (!cancelled) setRecentRuns([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your conversation. Try again in a minute."));
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Chat opens on the newest message, and follows it as messages arrive.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loaded, sending?.phase]);

  // The coach has answered once it has said more than it had when the message went.
  const refresh = useCallback(async () => {
    if (!week) return;
    const data = await fetchThread(week.id);
    setMessages(data.messages);
    setSending((s) => (s && countRole(data.messages, "coach") > s.coachBefore ? null : s));
    return data.messages;
  }, [week]);

  // Coming back to the tab: a reply that finished while you were away appears now.
  useEffect(() => {
    if (!week || readOnly) return;
    function onVisible() {
      if (document.visibilityState === "visible") void refresh().catch(() => undefined);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [week, readOnly, refresh]);

  // The connection gave up, but the coach may not have: look every ten seconds for two minutes.
  const recovering = sending?.phase === "recovering";
  useEffect(() => {
    if (!recovering) return;
    let looks = 0;
    const timer = setInterval(async () => {
      looks += 1;
      let latest: ThreadMessage[] | undefined;
      try {
        latest = await refresh();
      } catch {
        /* the next look may work */
      }
      if (looks >= POLL_LIMIT) {
        clearInterval(timer);
        setSending((s) => {
          if (!s) return s; // it arrived
          // If the message never reached Coach Cade, it goes back in the box.
          if (latest && countRole(latest, "athlete") <= s.athleteBefore) {
            setDraft(s.body);
            setAttached(s.run);
          }
          setError("Coach Cade didn’t reply. Check back in a while, or send your message again.");
          return null;
        });
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [recovering, refresh]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !week || readOnly || sending) return;
    const run = attached;
    const runId = run?.id ?? null;
    setError(null);
    setNotice(null);
    setSending({
      body,
      run,
      athleteBefore: countRole(messages, "athlete"),
      coachBefore: countRole(messages, "coach"),
      phase: "waiting",
    });
    setDraft("");
    setAttached(null);
    try {
      await postMidWeekChat(week.id, body, runId);
      // The thread carries side effects of the reply, such as notes and plan changes.
      const data = await fetchThread(week.id);
      setMessages(data.messages);
      setSending(null);
    } catch (err) {
      if (mayStillBeRunning(err)) {
        // Not a failure yet: the reply may arrive by itself. Watch for it.
        setSending((s) => (s ? { ...s, phase: "recovering" } : s));
        return;
      }
      setSending(null);
      setDraft(body);
      setAttached(run);
      if (err instanceof ApiError && err.code === "week_archived") {
        // A new week began while this page was open. Show it; the draft stays in the box.
        try {
          await load();
          setNotice("A new week has started, so your message wasn’t sent. It’s still in the box.");
        } catch (reloadErr) {
          setError(describeError(reloadErr));
        }
      } else {
        setError(describeError(err, "Couldn’t send that. Try again in a minute."));
      }
    }
  }

  if (!loaded) {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your conversation…</p>}
      </WaitingState>
    );
  }

  return (
    // The header is 4rem tall: the page fills the rest, and only the messages scroll.
    <main className="mx-auto flex h-[calc(100dvh-4rem-1px)] w-full max-w-3xl flex-col gap-3 px-4 pt-6 sm:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="m-0 text-3xl font-semibold leading-tight">Coach Cade</h1>
        <ButtonLink href="/dossier" variant="quiet">
          What Coach Cade knows about you
        </ButtonLink>
      </header>

      <div
        ref={scroller}
        role="log"
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1"
      >
        {messages.length === 0 && !sending ? (
          <Muted>
            {readOnly ? "You and Coach Cade didn’t talk this week." : "Nothing yet. Say hello, or tell Coach Cade how the week is going."}
          </Muted>
        ) : (
          messages.map((m) => (
            <ConversationMessage key={m.id} message={m} unit={unit} timeZone={week?.timezone} />
          ))
        )}
        {sending ? (
          <PendingExchange
            sending={sending}
            stored={countRole(messages, "athlete") > sending.athleteBefore}
          />
        ) : null}
      </div>

      {readOnly ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border py-4">
          <Muted>This is a past week, so it’s here to read.</Muted>
          <ButtonLink href="/chat" variant="primary">
            Go to this week
          </ButtonLink>
        </div>
      ) : (
        <form
          onSubmit={(e) => void onSend(e)}
          className="flex shrink-0 flex-col gap-2 border-t border-border bg-canvas pb-4 pt-3"
          aria-label="Write to Coach Cade"
        >
          {notice ? <Muted>{notice}</Muted> : null}
          <ErrorNote error={error} />
          {attached ? (
            <div className="flex">
              <span className="inline-flex items-center gap-2 rounded-tempo border border-border bg-raised py-1.5 pl-3 pr-1.5">
                <span>{runLabel(attached, unit, week?.timezone ?? "UTC")}</span>
                <button
                  type="button"
                  aria-label="Remove the attached run"
                  onClick={() => setAttached(null)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-tempo text-muted hover:text-ink"
                >
                  <IconX size={16} aria-hidden />
                </button>
              </span>
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write to Coach Cade"
            aria-label="Message to Coach Cade"
            rows={3}
            required
          />
          <div className="relative flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={sending !== null}>
              {sending ? "Sending…" : "Send"}
            </Button>
            {recentRuns.length > 0 && !attached ? (
              <Button
                aria-expanded={picking}
                aria-haspopup="dialog"
                onClick={() => setPicking((v) => !v)}
              >
                <IconPlus size={18} aria-hidden />
                Add a run
              </Button>
            ) : null}
            {picking ? (
              <div
                role="dialog"
                aria-label="Add a run"
                onKeyDown={(e) => e.key === "Escape" && setPicking(false)}
                className="absolute bottom-full left-0 z-10 mb-2 flex max-h-72 w-full max-w-md flex-col overflow-y-auto rounded-tempo border border-border bg-raised p-1 shadow-lg"
              >
                {recentRuns.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => {
                      setAttached(w);
                      setPicking(false);
                    }}
                    className="rounded-tempo px-3 py-2 text-left hover:bg-canvas"
                  >
                    {runLabel(w, unit, week?.timezone ?? "UTC")}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </form>
      )}
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <WaitingState>
          <p className="m-0">Loading your conversation…</p>
        </WaitingState>
      }
    >
      <ChatInner />
    </Suspense>
  );
}
