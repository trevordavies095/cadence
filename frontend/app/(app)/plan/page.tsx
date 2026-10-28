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
  fetchNextWeekPrescribed,
  fetchPrescribedWeek,
  fetchReplyRun,
  markReplyRunSeen,
  fetchWeekRecap,
  postWeeklyReply,
  type CheckInStatus,
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
        try {
          const { prescribed } = await fetchPrescribedWeek(current.id);
          if (cancelled) return;
          setThisPlan(prescribed);
        } catch {
          if (!cancelled) setThisPlan(null);
        }
        try {
          const next = await fetchNextWeekPrescribed(current.id);
          if (!cancelled) {
            setNextPlan(next.prescribed);
            setUnit(next.unitPreference);
            setTodayYmd(next.todayYmd);
            // On Sunday the week that matters is the one coming up.
            const weekday = new Date(`${next.todayYmd}T12:00:00Z`).getUTCDay();
            setView(weekday === 0 ? "next" : "this");
            // Opening the plan clears the "plan is ready" banner on Home.
            if (next.prescribed) void markReplyRunSeen(current.id).catch(() => undefined);
          }
        } catch {
          if (!cancelled) setNextPlan(null);
        }
        try {
          const { run } = await fetchReplyRun(current.id);
          if (!cancelled) setRunPending(run?.status === "pending");
        } catch {
          /* leave the redo button as it was */
        }
        try {
          const recap = await fetchWeekRecap(current.id);
          if (!cancelled) setCheckInStatus(recap.checkInStatus);
        } catch {
          if (!cancelled) setCheckInStatus("needed");
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
      ? "next week"
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
            <CoachRead record={selected} />
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {selected.plan.days.map((day) => (
                <PlanDayRow
                  key={day.date}
                  day={day}
                  unit={unit}
                  isToday={day.date === todayYmd}
                />
              ))}
            </ol>
          </>
        ) : (
          <Muted>
            {view === "next"
              ? planUnlocked
                ? "Next week’s plan isn’t ready yet."
                : "Finish or skip this week’s check-in and Coach Cade will plan next week."
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
