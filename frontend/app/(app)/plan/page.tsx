"use client";

import { describeError, type UiError } from "@/lib/errors";
import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  ButtonLink,
  Muted,
  Page,
  PageHead,
  PageTitle,
  SectionHeader,
  WaitingState,
  ErrorNote,
} from "@/components/ui";
import { CoachRead } from "@/components/CoachRead";
import { PlanDayRow } from "@/components/PlanDayRow";
import { isoWeekRangeLabel } from "@/lib/weekLabel";
import {
  CheckInRequiredError,
  ensureCurrentWeek,
  fetchHome,
  fetchNextWeekPrescribed,
  fetchPrescribedWeek,
  fetchReplyRun,
  markReplyRunSeen,
  postPlanDayDetails,
  postWeeklyReply,
  type CheckInStatus,
  type HomeWeekDay,
  type PrescribedWeekRecord,
  type UnitPreference,
  type WeekSession,
} from "@/lib/api";

type GateState = "loading" | "open";

export default function PlanPage() {
  const [gate, setGate] = useState<GateState>("loading");
  const [week, setWeek] = useState<WeekSession | null>(null);
  const [thisPlan, setThisPlan] = useState<PrescribedWeekRecord | null>(null);
  const [nextPlan, setNextPlan] = useState<PrescribedWeekRecord | null>(null);
  const [nextIsoWeek, setNextIsoWeek] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Map<string, HomeWeekDay>>(new Map());
  const [unit, setUnit] = useState<UnitPreference>("imperial");
  const [todayYmd, setTodayYmd] = useState<string | null>(null);
  const [view, setView] = useState<"this" | "next">("this");
  const [confirming, setConfirming] = useState(false);
  const [runPending, setRunPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [checkInStatus, setCheckInStatus] = useState<CheckInStatus | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const current = await ensureCurrentWeek();
        if (cancelled) return;
        setWeek(current);
        // How each day went, from the helper Home uses. It reads the running log,
        // so the plan does not wait for it: the marks appear when it answers.
        void fetchHome()
          .then((home) => {
            if (!cancelled) setOutcomes(new Map(home.week.map((d) => [d.date, d])));
          })
          .catch(() => undefined);
        const [prescribedResult, nextResult, runResult] = await Promise.allSettled([
          fetchPrescribedWeek(current.id),
          fetchNextWeekPrescribed(current.id),
          fetchReplyRun(current.id),
        ]);
        if (cancelled) return;
        setThisPlan(
          prescribedResult.status === "fulfilled"
            ? prescribedResult.value.prescribed
            : null,
        );
        if (nextResult.status === "fulfilled") {
          const next = nextResult.value;
          setNextPlan(next.prescribed);
          // Only the dates beside "Next week" need it, so a reply without it still shows the plan.
          setNextIsoWeek(next.weekSession?.isoWeek ?? null);
          setUnit(next.unitPreference);
          setTodayYmd(next.todayYmd);
          setCheckInStatus(next.checkInStatus);
          // On Sunday the week that matters is the one coming up.
          const weekday = new Date(`${next.todayYmd}T12:00:00Z`).getUTCDay();
          setView(weekday === 0 ? "next" : "this");
          // Opening the plan clears the "plan is ready" banner on Home.
          if (next.prescribed) void markReplyRunSeen(current.id).catch(() => undefined);
        } else {
          setNextPlan(null);
          setCheckInStatus("needed");
        }
        if (runResult.status === "fulfilled") {
          setRunPending(runResult.value.run?.status === "pending");
        }
        setGate("open");
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your plan. Try again in a minute."));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // While the coach is reading, look again; show the new plan when it lands.
  useEffect(() => {
    if (!runPending || !week) return;
    const timer = setInterval(async () => {
      try {
        const { run } = await fetchReplyRun(week.id);
        if (run?.status !== "pending") {
          setRunPending(false);
          const next = await fetchNextWeekPrescribed(week.id);
          setNextPlan(next.prescribed);
          setView("next");
        }
      } catch {
        /* keep waiting */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [runPending, week]);

  /** "Add the details" on an unread day: the row re-renders from the plan sent back. */
  async function addDetails(
    record: PrescribedWeekRecord,
    date: string,
  ): Promise<boolean> {
    try {
      const { prescribed } = await postPlanDayDetails(record.weekSessionId, date);
      const replace = (p: PrescribedWeekRecord | null) =>
        p && p.weekSessionId === prescribed.weekSessionId ? prescribed : p;
      setThisPlan(replace);
      setNextPlan(replace);
      return true;
    } catch {
      return false;
    }
  }

  const planUnlocked =
    checkInStatus === "finished" || checkInStatus === "skipped";

  async function onRequestWeeklyPlan() {
    if (!week || !planUnlocked) return;
    setPlanBusy(true);
    setError(null);
    try {
      setConfirming(false);
      await postWeeklyReply({ weekSessionId: week.id });
      // The weekly reply plans NEXT week; the current-week plan is unchanged.
      const next = await fetchNextWeekPrescribed(week.id);
      setNextPlan(next.prescribed);
      setUnit(next.unitPreference);
      setTodayYmd(next.todayYmd);
      setView("next");
    } catch (err) {
      if (err instanceof CheckInRequiredError) {
        setCheckInStatus("needed");
        setError(describeError(err));
      } else {
        setError(describeError(err, "Coach Cade couldn’t make the plan just now. Try again in a minute."));
      }
    } finally {
      setPlanBusy(false);
    }
  }

  if (gate !== "open") {
    return (
      <WaitingState>
        {error ? (
          <ErrorNote error={error} />
        ) : (
          <p className="m-0">Loading your plan…</p>
        )}
      </WaitingState>
    );
  }

  const selected = view === "next" ? nextPlan : thisPlan;
  const weekLabel = selected
    ? isoWeekRangeLabel(selected.plan.week)
    : view === "next"
      ? nextIsoWeek
        ? isoWeekRangeLabel(nextIsoWeek)
        : null
      : week
        ? isoWeekRangeLabel(week.isoWeek)
        : "this week";

  return (
    <Page>
      <PageHead>
        <PageTitle>Plan</PageTitle>

        <div role="group" aria-label="Which week" className="flex gap-2">
          {(["this", "next"] as const).map((which) => (
            <Button
              key={which}
              aria-pressed={view === which}
              className={
                view === which ? "border-ink" : "border-border text-muted"
              }
              onClick={() => setView(which)}
            >
              {which === "this" ? "This week" : "Next week"}
            </Button>
          ))}
        </div>
      </PageHead>

      <section
        className="flex flex-col gap-3"
        aria-label={view === "next" ? "Next week plan" : "Week plan"}
      >
        <SectionHeader
          title={view === "next" ? "Next week" : "This week"}
          aside={weekLabel}
        />

        {selected ? (
          <>
            {/*
              Next week's read is fresh, so it leads. This week's was written last Sunday: its
              notices stay on top, the days come next, and the read follows them (ADR 0009).
              Keyed on the week so switching resets what was opened, not keeping the last toggle.
            */}
            <CoachRead
              key={view}
              record={selected}
              fresh={view === "next"}
              todayYmd={view === "this" ? todayYmd : null}
              part={view === "this" ? "notices" : "all"}
            />
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {selected.plan.days.map((day) => (
                <PlanDayRow
                  key={day.date}
                  day={day}
                  unit={unit}
                  isToday={day.date === todayYmd}
                  outcome={view === "this" ? outcomes.get(day.date) : undefined}
                  onAddDetails={(date) => addDetails(selected, date)}
                />
              ))}
            </ol>
            {view === "this" ? (
              <CoachRead record={selected} fresh={false} todayYmd={todayYmd} part="read" />
            ) : null}
          </>
        ) : view === "next" && !planUnlocked ? null : (
          // Before the check-in, the line under this section already says when next week is planned.
          <Muted>
            {view === "next"
              ? "Next week’s plan isn’t ready yet."
              : "No plan for this week yet."}
          </Muted>
        )}
      </section>

      <div className="flex flex-col gap-4">
        {runPending ? (
          <Banner>
            Coach Cade is reading your week. Next week’s plan will appear here
            when it’s ready.
          </Banner>
        ) : null}

        {planUnlocked ? (
          confirming ? (
            <Banner
              action={
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={planBusy || !week}
                    onClick={() => void onRequestWeeklyPlan()}
                  >
                    Redo it
                  </Button>
                  <Button onClick={() => setConfirming(false)}>Cancel</Button>
                </div>
              }
            >
              This replaces next week’s plan and takes a couple of minutes.
            </Banner>
          ) : (
            <div>
              <Button
                disabled={planBusy || runPending || !week}
                onClick={() => setConfirming(true)}
              >
                {planBusy
                  ? "Coach Cade is working on it…"
                  : nextPlan
                    ? "Ask Coach Cade to redo next week"
                    : "Ask Coach Cade to plan next week"}
              </Button>
            </div>
          )
        ) : (
          <Muted>
            Coach Cade plans next week once your weekly check-in is done. It opens on Saturday.
          </Muted>
        )}
        <ErrorNote error={error} />
        <Muted>
          <ButtonLink href="/chat" variant="quiet">
            Talk to Coach Cade
          </ButtonLink>{" "}
          or look back at your{" "}
          <ButtonLink href="/weeks" variant="quiet">
            past weeks
          </ButtonLink>
          .
        </Muted>
      </div>
    </Page>
  );
}
