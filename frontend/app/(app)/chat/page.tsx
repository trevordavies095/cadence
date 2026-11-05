"use client";

import { IconArrowUp, IconInfoCircle, IconPlus, IconX } from "@tabler/icons-react";
import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import { ConversationMessage } from "@/components/ConversationMessage";
import {
  ButtonLink,
  CoachSurface,
  ErrorNote,
  Muted,
  WaitingState,
  cx,
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
import { useKeyboardViewport } from "@/lib/keyboardViewport";
import { distanceLabel, localYmd } from "@/lib/units";
import { isoWeekRangeLabel } from "@/lib/weekLabel";

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

/**
 * The round buttons either side of the message box: a comfortable thumb target. Their
 * colours are the shared Button's (volt for the page's one primary action), on a circle.
 */
const ROUND =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-opacity disabled:cursor-not-allowed";
const ROUND_VARIANT = {
  primary:
    "bg-volt text-on-volt hover:opacity-90 disabled:bg-border disabled:text-muted disabled:hover:opacity-100",
  secondary: "border border-border bg-raised text-ink hover:border-muted disabled:opacity-50",
};
/** How close to the newest message still counts as reading it. */
const NEAR_BOTTOM_PX = 48;
/** A tap on a button can take focus from the message box on its way; this long after, it still counts as typing. */
const TYPING_GRACE_MS = 300;

/** Your message and the coach's answer on its way, shown until the real ones arrive. */
function PendingExchange({ sending, stored }: { sending: Sending; stored: boolean }) {
  return (
    <>
      {stored ? null : (
        <article data-role="athlete" className="flex flex-col gap-1">
          <header className="flex items-baseline gap-3">
            <span className="font-semibold">You</span>
            <span className="text-sm text-muted">Just now</span>
          </header>
          <p className="m-0 whitespace-pre-wrap">{sending.body}</p>
        </article>
      )}
      <CoachSurface
        as="article"
        data-role="coach"
        className="flex flex-col gap-1"
        role="status"
        aria-live="polite"
      >
        <header className="flex items-baseline gap-3">
          <span className="font-semibold text-accent">Coach Cade</span>
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
      </CoachSurface>
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
  const box = useRef<HTMLTextAreaElement>(null);
  // Whether the conversation is showing its newest message. While it is, it stays on it
  // as the room changes: the keyboard opening, the message box growing, the tab bar going.
  const atBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const content = useRef<HTMLDivElement>(null);
  // Whether the athlete is typing, or was a moment ago.
  const typing = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useKeyboardViewport();

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

  // The room and the messages both change size without anyone scrolling: the keyboard, a
  // card that loads late. Either way a conversation that was on its newest message stays on it.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [loaded]);

  // The message box is one line, and grows with what is typed until its max height.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft, loaded, readOnly]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  /** After a tap on Send or a run: if the athlete was typing, they still are, and the keyboard stays up. */
  function keepTyping() {
    if (typing.current) box.current?.focus();
  }

  function onBoxKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends where there is a real keyboard. On a phone the return key adds a line.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }

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
    setPicking(false);
    atBottom.current = true;
    keepTyping();
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

  // A note waiting for "Looks right" is the one thing to do, so Send steps back until it's answered.
  const noteWaiting = messages.some((m) => m.dossierProposal?.status === "pending");

  if (!loaded) {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your conversation…</p>}
      </WaitingState>
    );
  }

  return (
    // The page fills what the shell's header and tab bar leave, and only the messages scroll.
    // On a phone the visible height follows the on-screen keyboard (useKeyboardViewport).
    <main className="mx-auto flex h-[calc(var(--visible-height,100dvh)-var(--shell-top)-var(--shell-bottom))] w-full max-w-3xl flex-col sm:gap-3 sm:px-6 sm:pt-6">
      {/* On a phone: a slim bar like a conversation's, the name in the middle and About you
          behind the info button. From `sm` up: the page title, with About you as a link. */}
      <header
        className={cx(
          "grid shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center border-b border-border bg-raised px-1 pt-[env(safe-area-inset-top)]",
          "sm:flex sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-3 sm:gap-y-1 sm:border-b-0 sm:bg-transparent sm:px-0 sm:pt-0",
        )}
      >
        <span className="sm:hidden" aria-hidden />
        <div className="flex h-12 flex-col items-center justify-center sm:h-auto sm:items-start">
          <h1 className="m-0 text-base font-semibold leading-tight sm:text-3xl">Coach Cade</h1>
          {readOnly && week ? (
            <p className="m-0 text-xs text-muted sm:hidden">{isoWeekRangeLabel(week.isoWeek)}</p>
          ) : null}
        </div>
        <Link
          href="/dossier"
          aria-label="What Coach Cade knows about you"
          title="What Coach Cade knows about you"
          className="inline-flex h-11 w-11 items-center justify-center text-muted hover:text-ink sm:hidden"
        >
          <IconInfoCircle size={22} stroke={1.75} aria-hidden />
        </Link>
        <ButtonLink href="/dossier" variant="quiet" className="max-sm:hidden">
          What Coach Cade knows about you
        </ButtonLink>
      </header>

      <div
        ref={scroller}
        role="log"
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          const top = el.scrollTop;
          // Only scrolling up leaves the newest message. Messages growing under a
          // conversation that hasn't moved does not.
          if (el.scrollHeight - el.clientHeight - top < NEAR_BOTTOM_PX) atBottom.current = true;
          else if (top < lastScrollTop.current) atBottom.current = false;
          lastScrollTop.current = top;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-0 sm:py-0 sm:pr-1"
      >
        <div ref={content} className="flex flex-col gap-4">
          {messages.length === 0 && !sending ? (
            <Muted>
              {readOnly ? "You and Coach Cade didn’t talk this week." : "Nothing yet. Say hello, or tell Coach Cade how the week is going."}
            </Muted>
          ) : (
            messages.map((m) => (
              <ConversationMessage
                key={m.id}
                message={m}
                unit={unit}
                timeZone={week?.timezone}
                onNoteChange={() => void refresh()?.catch(() => undefined)}
              />
            ))
          )}
          {sending ? (
            <PendingExchange
              sending={sending}
              stored={countRole(messages, "athlete") > sending.athleteBefore}
            />
          ) : null}
        </div>
      </div>

      {readOnly ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-4 sm:px-0">
          <Muted>This is a past week, so it’s here to read.</Muted>
          <ButtonLink href="/chat" variant="primary">
            Go to this week
          </ButtonLink>
        </div>
      ) : (
        <form
          data-composer
          onSubmit={(e) => void onSend(e)}
          // A press on a button here never takes focus from the message box, so on a
          // phone the keyboard stays up and the tab bar stays away.
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) e.preventDefault();
          }}
          className="flex shrink-0 flex-col gap-2 border-t border-border bg-canvas px-3 py-2 sm:px-0 sm:pb-4 sm:pt-3"
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
          {/* Add a run, the message, Send: one row, with the buttons on the last line as the box grows. */}
          <div className="relative flex items-end gap-2">
            {recentRuns.length > 0 && !attached ? (
              <button
                type="button"
                aria-label="Add a run"
                title="Add a run"
                aria-expanded={picking}
                aria-haspopup="dialog"
                onClick={() => setPicking((v) => !v)}
                className={cx(ROUND, ROUND_VARIANT.secondary)}
              >
                <IconPlus size={20} aria-hidden />
              </button>
            ) : null}
            <textarea
              ref={box}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onBoxKeyDown}
              onFocus={() => {
                if (typingTimer.current) clearTimeout(typingTimer.current);
                typing.current = true;
              }}
              onBlur={() => {
                typingTimer.current = setTimeout(() => {
                  typing.current = false;
                }, TYPING_GRACE_MS);
              }}
              placeholder="Write to Coach Cade"
              aria-label="Message to Coach Cade"
              rows={1}
              // 16px text, so a phone doesn't zoom in when the box is tapped. Five lines at most.
              // Focus darkens the border; the page's outline ring would sit round it all the while you type.
              className="max-h-[8.875rem] min-w-0 flex-1 resize-none rounded-[1.375rem] border border-border bg-raised px-4 py-2.5 text-base leading-6 text-ink placeholder:text-muted focus-visible:border-ink focus-visible:outline-none!"
              required
            />
            <button
              type="submit"
              aria-label={sending ? "Sending…" : "Send"}
              title="Send"
              disabled={sending !== null}
              className={cx(ROUND, ROUND_VARIANT[noteWaiting ? "secondary" : "primary"])}
            >
              <IconArrowUp size={22} stroke={2.25} aria-hidden />
            </button>
            {picking ? (
              <div
                role="dialog"
                aria-label="Add a run"
                onKeyDown={(e) => e.key === "Escape" && setPicking(false)}
                // Never taller than the room above the box, keyboard or not.
                className="absolute bottom-full left-0 z-10 mb-2 flex max-h-[min(18rem,calc(var(--visible-height,100dvh)*0.45))] w-full max-w-md flex-col overflow-y-auto rounded-tempo border border-border bg-raised p-1 shadow-lg"
              >
                {recentRuns.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => {
                      setAttached(w);
                      setPicking(false);
                      keepTyping();
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
