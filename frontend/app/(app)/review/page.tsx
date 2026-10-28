"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CoachRead } from "@/components/CoachRead";
import { NoteCard } from "@/components/NoteCard";
import { PlanDayRow } from "@/components/PlanDayRow";
import { ReadOnlyConversation } from "@/components/ReadOnlyConversation";
import { YourWeek } from "@/components/YourWeek";
import {
  Banner,
  Button,
  ButtonLink,
  ErrorNote,
  Muted,
  Page,
  PageHead,
  PageTitle,
  SectionHeader,
  SectionTitle,
  WaitingState,
} from "@/components/ui";
import {
  CheckInRequiredError,
  ensureCurrentWeek,
  fetchNextWeekPrescribed,
  fetchReplyRun,
  fetchThread,
  fetchWeeks,
  fetchWeekRecap,
  postWeeklyReply,
  retryReplyRun,
  type CheckInStatus,
  type PrescribedWeekRecord,
  type ReplyRun,
  type ThreadNote,
  type UnitPreference,
  type WeekSession,
} from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";
import { isoWeekRangeLabel } from "@/lib/weekLabel";

const POLL_MS = 5000;

function ReviewInner() {
  const weekParam = useSearchParams().get("week");

  const [ready, setReady] = useState(false);
  const [week, setWeek] = useState<WeekSession | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [run, setRun] = useState<ReplyRun | null>(null);
  const [checkIn, setCheckIn] = useState<CheckInStatus | null>(null);
  const [plan, setPlan] = useState<PrescribedWeekRecord | null>(null);
  const [unit, setUnit] = useState<UnitPreference>("imperial");
  const [note, setNote] = useState<ThreadNote | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);

  // Reading the plan here does not clear the Home banner; opening Plan does.
  const loadPlan = useCallback(async (w: WeekSession, runCallId: string | null) => {
    const next = await fetchNextWeekPrescribed(w.id);
    setPlan(next.prescribed);
    setUnit(next.unitPreference);
    // The note came from the same reply as the plan: find it on that reply's message.
    try {
      const thread = await fetchThread(w.id);
      const reply = thread.messages.find(
        (m) => m.role === "coach" && runCallId !== null && m.llmCallId === runCallId,
      );
      setNote(reply?.dossierProposal ?? null);
    } catch {
      setNote(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const current = await ensureCurrentWeek();
        let target = current;
        if (weekParam && weekParam !== current.id) {
          const all = await fetchWeeks();
          target = all.weeks.find((w) => w.id === weekParam) ?? current;
        }
        if (cancelled) return;
        const past = target.id !== current.id;
        setWeek(target);
        setReadOnly(past);

        const { run: latest } = await fetchReplyRun(target.id);
        if (cancelled) return;
        setRun(latest);
        try {
          const gate = await fetchWeekRecap(target.id);
          if (!cancelled) setCheckIn(gate.checkInStatus);
        } catch {
          if (!cancelled) setCheckIn(null);
        }
        if (latest?.status === "ok" || past) {
          await loadPlan(target, latest?.llmCallId ?? null);
        }
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your week. Try again in a minute."));
          setReady(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [weekParam, loadPlan]);

  // While the coach is reading, look again every few seconds.
  const pending = run?.status === "pending";
  useEffect(() => {
    if (!pending || !week) return;
    const timer = setInterval(async () => {
      try {
        const { run: latest } = await fetchReplyRun(week.id);
        setRun(latest);
        if (latest?.status === "ok") await loadPlan(week, latest.llmCallId);
      } catch {
        // Keep waiting; the next look may succeed.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, week, loadPlan]);

  async function onRetry() {
    if (!week) return;
    setBusy(true);
    setError(null);
    try {
      const started = await retryReplyRun(week.id);
      setRun(started.run);
    } catch (err) {
      setError(describeError(err, "Couldn’t restart that. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  }

  async function onAskCoach() {
    if (!week) return;
    setBusy(true);
    setError(null);
    try {
      await postWeeklyReply({ weekSessionId: week.id });
      const { run: latest } = await fetchReplyRun(week.id);
      setRun(latest);
      await loadPlan(week, latest?.llmCallId ?? null);
    } catch (err) {
      if (err instanceof CheckInRequiredError) setCheckIn("needed");
      setError(describeError(err, "Coach Cade couldn’t read your week just now. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <WaitingState>
        <p className="m-0">Loading your week…</p>
      </WaitingState>
    );
  }

  // A run only ever starts once the check-in is finished or skipped, so having one
  // proves it even when the check-in read itself is blocked by pending notes.
  const checkInDone =
    checkIn === "finished" || checkIn === "skipped" || run !== null;

  return (
    <Page>
      <PageHead>
        <PageTitle>Your week</PageTitle>
        {week ? <Muted>{isoWeekRangeLabel(week.isoWeek)}</Muted> : null}
        <ErrorNote error={error} />
      </PageHead>

      {week && (checkInDone || readOnly) ? (
        <section className="flex flex-col gap-3" aria-label="Your week">
          <SectionTitle>How your week went</SectionTitle>
          <YourWeek weekSessionId={week.id} timezone={week.timezone} />
        </section>
      ) : null}

      {!readOnly && !checkInDone && !run ? (
        <Banner
          action={
            <ButtonLink href="/check-in" variant="primary">
              Start your check-in
            </ButtonLink>
          }
        >
          Coach Cade reads your week once you have checked in.
        </Banner>
      ) : null}

      {!readOnly && checkInDone && !run ? (
        <Banner
          action={
            <Button variant="primary" disabled={busy} onClick={() => void onAskCoach()}>
              {busy ? "Coach Cade is reading…" : "Ask Coach Cade to read my week"}
            </Button>
          }
        >
          Coach Cade hasn’t read this week yet.
        </Banner>
      ) : null}

      {pending ? (
        <section
          aria-label="Coach Cade is reading your week"
          className="flex flex-col items-center gap-2 border-y border-border py-8 text-center"
        >
          <p className="m-0 text-xl font-semibold">Coach Cade is reading your week</p>
          <Muted>
            This usually takes a couple of minutes. You can leave this page. Next
            week’s plan will be waiting for you.
          </Muted>
        </section>
      ) : null}

      {run?.status === "failed" && !readOnly ? (
        <Banner
          tone="danger"
          action={
            <Button variant="primary" disabled={busy} onClick={() => void onRetry()}>
              Retry
            </Button>
          }
        >
          Coach Cade couldn’t finish reading your week.
        </Banner>
      ) : null}

      {plan ? (
        <>
          <section className="flex flex-col gap-3" aria-label="Coach Cade’s read">
            <SectionTitle>Coach Cade’s read</SectionTitle>
            <CoachRead record={plan} emptyText="Coach Cade had nothing to add." fullReadOpen />
          </section>

          <section className="flex flex-col gap-3" aria-label="Next week">
            <SectionHeader title="Next week" aside={isoWeekRangeLabel(plan.plan.week)} />
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {plan.plan.days.map((day) => (
                <PlanDayRow key={day.date} day={day} unit={unit} isToday={false} />
              ))}
            </ol>
            {!readOnly ? (
              <div>
                <ButtonLink href="/plan" variant="quiet">
                  Open the plan
                </ButtonLink>
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-2" aria-label="What Coach Cade noted">
            <SectionTitle>What Coach Cade noted</SectionTitle>
            {note ? (
              <NoteCard note={note} weekSessionId={week?.id} />
            ) : (
              <Muted>Nothing new to remember this week.</Muted>
            )}
          </section>
        </>
      ) : null}

      {readOnly && week ? <ReadOnlyConversation weekSessionId={week.id} unit={unit} /> : null}

      {readOnly ? (
        <div>
          <ButtonLink href="/weeks" variant="quiet">
            Back to History
          </ButtonLink>
        </div>
      ) : null}
    </Page>
  );
}

export default function ReviewPage() {
  return (
    <Suspense
      fallback={
        <WaitingState>
          <p className="m-0">Loading your week…</p>
        </WaitingState>
      }
    >
      <ReviewInner />
    </Suspense>
  );
}
