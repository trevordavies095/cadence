"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ScaleSlider, Stepper, WordChoice } from "@/components/CheckInControls";
import {
  Button,
  ButtonLink,
  ErrorNote,
  Field,
  Input,
  Muted,
  Page,
  PageTitle,
  Textarea,
  WaitingState,
} from "@/components/ui";
import {
  ensureCurrentWeek,
  fetchGoalKind,
  fetchHome,
  fetchWeekRecap,
  saveSubjectiveAnswers,
  type NeedsSubjectiveRun,
  type RecapGate,
  type SubjectiveAnswers,
  type UnitPreference,
  type WeekSession,
} from "@/lib/api";
import {
  finalizeAnswers,
  runTitle,
  STRESS_WORDS,
  summaryRows,
  dayLabel,
  withRunAnswer,
  withStrengthAnswer,
  withWeeklyAnswer,
} from "@/lib/checkIn";
import { describeError, type UiError } from "@/lib/errors";

type WeeklyStep = "sleep" | "stress" | "strength" | "body" | "outlook" | "anything";

type CheckInStep =
  | { kind: "run"; run: NeedsSubjectiveRun & { date: string } }
  | { kind: "weekly"; key: WeeklyStep };

/** The weekly questions, in the order they are asked. The words are ours, not the API's. */
const WEEKLY_STEPS: WeeklyStep[] = ["sleep", "stress", "strength", "body", "outlook", "anything"];

const hours = (n: number) => `${n.toFixed(1)} hours`;
const sessions = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

export default function CheckInPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [week, setWeek] = useState<WeekSession | null>(null);
  const [recapGate, setRecapGate] = useState<RecapGate | null>(null);
  const [unit, setUnit] = useState<UnitPreference>("imperial");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<SubjectiveAnswers | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  // The check-in opens on Saturday; before then there is nothing to answer yet.
  const [opens, setOpens] = useState<string | null>(null);
  const [confirmSkipAll, setConfirmSkipAll] = useState(false);
  // True while changing one answer from the summary, so Next goes straight back to it.
  const [fromSummary, setFromSummary] = useState(false);
  // A return to running asks for pain as a 0 to 10 score beside the words.
  const [painScale, setPainScale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const current = await ensureCurrentWeek();
        if (cancelled) return;
        setWeek(current);
        try {
          const next = await fetchWeekRecap(current.id);
          if (cancelled) return;
          setRecapGate(next);
          if (next.status === "needs_subjective") {
            setAnswers({ week: next.week, runs: [] });
            setStep(0);
          }
        } catch (err) {
          if (cancelled) return;
          setError(describeError(err, "Couldn’t load your check-in. Try again in a minute."));
        }
        // Today and the opening day come from the server, in the athlete's time zone.
        // Distances are worded in the running log's units; miles until they are known.
        try {
          const home = await fetchHome();
          if (cancelled) return;
          setUnit(home.units);
          const today = home.week.find((d) => d.isToday)?.date;
          const saturday = home.week[5]?.date;
          if (today && saturday && today < saturday) setOpens(saturday);
        } catch {
          /* open: the server decides whether the check-in can be saved */
        }
        try {
          const kind = await fetchGoalKind();
          if (cancelled) return;
          setPainScale(kind === "return");
        } catch {
          /* no goal to read: pain stays a line of words */
        }
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your check-in. Try again in a minute."));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Finished or skipped: the coach starts reading, and Your week takes over.
  useEffect(() => {
    if (recapGate?.status === "report") router.replace("/review");
  }, [recapGate, router]);

  const steps = useMemo<CheckInStep[]>(() => {
    if (recapGate?.status !== "needs_subjective") return [];
    const runSteps: CheckInStep[] = [];
    for (const run of recapGate.runs) {
      if (run.date) runSteps.push({ kind: "run", run: { ...run, date: run.date } });
    }
    return [...runSteps, ...WEEKLY_STEPS.map((key): CheckInStep => ({ kind: "weekly", key }))];
  }, [recapGate]);

  const current = steps[step] ?? null;

  async function finish(final: SubjectiveAnswers) {
    if (!week || recapGate?.status !== "needs_subjective") return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveSubjectiveAnswers(week.id, finalizeAnswers(final, recapGate.runs));
      setRecapGate(saved.gate);
      setAnswers(null);
    } catch (err) {
      setError(describeError(err, "Couldn’t save your check-in. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function skipEntireCheckIn() {
    if (!week) return;
    setBusy(true);
    setError(null);
    try {
      const next = await fetchWeekRecap(week.id, { skipSubjective: true });
      setRecapGate(next);
      setAnswers(null);
    } catch (err) {
      setError(describeError(err, "Couldn’t skip the check-in. Try again."));
    } finally {
      setBusy(false);
      setConfirmSkipAll(false);
    }
  }

  function advance() {
    if (fromSummary) {
      setFromSummary(false);
      setStep(steps.length);
      return;
    }
    setStep(step + 1);
  }

  /** Skip leaves this question empty. The watch's own effort for a run still goes through. */
  function onSkipStep() {
    if (!current || !answers) return;
    let next = answers;
    if (current.kind === "run") {
      next = withRunAnswer(next, current.run.date, {
        rpe: undefined,
        felt: undefined,
        pain: undefined,
        pain_score: undefined,
      });
    } else if (current.key === "sleep") {
      next = withWeeklyAnswer(next, { sleep_avg_hrs: undefined });
    } else if (current.key === "stress") {
      next = withWeeklyAnswer(next, { stress_level: undefined });
    } else if (current.key === "strength") {
      next = withWeeklyAnswer(next, { strength_sessions: undefined });
    } else if (current.key === "body") {
      next = withWeeklyAnswer(next, { body_check: undefined });
    } else if (current.key === "outlook") {
      next = withWeeklyAnswer(next, { feeling_into_next_week: undefined });
    } else {
      next = withWeeklyAnswer(next, { questions_for_coach: undefined });
    }
    setAnswers(next);
    advance();
  }

  if (!loaded) {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your check-in…</p>}
      </WaitingState>
    );
  }

  if (recapGate?.status === "report") {
    return (
      <WaitingState>
        <p className="m-0">Taking you to your week…</p>
      </WaitingState>
    );
  }

  if (recapGate?.status === "needs_subjective" && opens) {
    return (
      <Page flow>
        <PageTitle>Weekly check-in</PageTitle>
        <p className="m-0 text-lg">Your check-in opens on {dayLabel(opens)}.</p>
        <Muted>
          It’s about how this week went, so it waits until the week is nearly done. Your
          coach plans next week as soon as you finish it.
        </Muted>
        <div>
          <ButtonLink href="/" variant="secondary">
            Back to Home
          </ButtonLink>
        </div>
      </Page>
    );
  }

  const inSummary = step >= steps.length;
  if (recapGate?.status !== "needs_subjective" || (!current && !inSummary) || !answers) {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your check-in…</p>}
      </WaitingState>
    );
  }

  if (inSummary) {
    const runSteps = steps.flatMap((s) => (s.kind === "run" ? [s.run] : []));
    const rows = summaryRows(answers, runSteps, unit);
    return (
      <Page flow>
        <PageTitle>Weekly check-in</PageTitle>
        <p className="m-0 text-lg font-medium">Here’s what you’re sending Coach Cade.</p>
        <dl className="m-0 flex flex-col" aria-label="Your answers">
          {rows.map((row) => (
            <div
              key={row.step}
              className="flex items-baseline justify-between gap-4 border-b border-border py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="font-semibold">{row.label}</dt>
                <dd className={row.answer ? "m-0" : "m-0 text-muted"}>
                  {row.answer ?? "Left blank"}
                </dd>
              </div>
              <Button
                variant="quiet"
                disabled={busy}
                aria-label={`Change ${row.label}`}
                onClick={() => {
                  setFromSummary(true);
                  setStep(row.step);
                }}
              >
                Change
              </Button>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => setStep(steps.length - 1)}>
            Back
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void finish(answers)}>
            {busy ? "Saving…" : "Finish check-in"}
          </Button>
        </div>
        <ErrorNote error={error} />
      </Page>
    );
  }
  if (!current) return null;

  const weekly = answers.weekly ?? {};

  return (
    <Page flow>
      <PageTitle>Weekly check-in</PageTitle>
      <p className="m-0 text-sm font-semibold text-muted" aria-live="polite">
        {step + 1} of {steps.length}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          advance();
        }}
        className="flex flex-col gap-5"
        aria-label="Weekly check-in"
      >
        {current.kind === "run" ? (
          <RunQuestions
            run={current.run}
            unit={unit}
            answers={answers}
            painScale={painScale}
            onChange={(next) => setAnswers(next)}
          />
        ) : current.key === "sleep" ? (
          <Question text="On average, how many hours a night did you sleep this week?">
            <Stepper
              label="Hours of sleep a night"
              value={weekly.sleep_avg_hrs}
              min={3}
              max={12}
              step={0.5}
              firstUp={7}
              firstDown={7}
              format={hours}
              lessLabel="Fewer hours"
              moreLabel="More hours"
              onChange={(n) => setAnswers(withWeeklyAnswer(answers, { sleep_avg_hrs: n }))}
            />
          </Question>
        ) : current.key === "stress" ? (
          <Question text="How stressed were you this week?">
            <WordChoice
              label="Stress this week"
              words={STRESS_WORDS}
              value={weekly.stress_level}
              onChange={(word) => setAnswers(withWeeklyAnswer(answers, { stress_level: word }))}
            />
          </Question>
        ) : current.key === "strength" ? (
          <Question text="Strength, rehab or cross-training sessions this week?">
            <p className="m-0 text-sm font-semibold text-muted">How many you did</p>
            <Stepper
              label="Sessions you did"
              value={weekly.strength_sessions?.completed}
              min={0}
              max={14}
              step={1}
              firstUp={1}
              firstDown={0}
              format={sessions}
              lessLabel="Fewer sessions"
              moreLabel="More sessions"
              onChange={(n) => setAnswers(withStrengthAnswer(answers, { completed: n }))}
            />
            <p className="m-0 text-sm font-semibold text-muted">How many you planned, if you had a plan</p>
            <Stepper
              label="Sessions you planned"
              value={weekly.strength_sessions?.planned}
              min={0}
              max={14}
              step={1}
              firstUp={1}
              firstDown={0}
              format={sessions}
              lessLabel="Fewer planned"
              moreLabel="More planned"
              onChange={(n) => setAnswers(withStrengthAnswer(answers, { planned: n }))}
            />
            <Field label="What you did, like swimming, cycling or physio exercises">
              <Textarea
                rows={2}
                value={weekly.strength_sessions?.notes ?? ""}
                onChange={(e) => setAnswers(withStrengthAnswer(answers, { notes: e.target.value }))}
              />
            </Field>
          </Question>
        ) : current.key === "body" ? (
          <Question text="How did your body feel? Mention any aches, niggles or tiredness.">
            <Textarea
              aria-label="How your body felt"
              rows={4}
              autoFocus
              value={weekly.body_check ?? ""}
              onChange={(e) => setAnswers(withWeeklyAnswer(answers, { body_check: e.target.value }))}
            />
          </Question>
        ) : current.key === "outlook" ? (
          <Question text="How are you feeling about next week?">
            <Textarea
              aria-label="How you feel about next week"
              rows={4}
              autoFocus
              value={weekly.feeling_into_next_week ?? ""}
              onChange={(e) =>
                setAnswers(withWeeklyAnswer(answers, { feeling_into_next_week: e.target.value }))
              }
            />
          </Question>
        ) : (
          <Question text="Anything else you want Coach Cade to know, or a question to ask?">
            <Textarea
              aria-label="Anything else for Coach Cade"
              rows={5}
              autoFocus
              value={weekly.questions_for_coach?.[0] ?? ""}
              onChange={(e) =>
                setAnswers(
                  withWeeklyAnswer(answers, {
                    questions_for_coach: e.target.value.trim() ? [e.target.value] : undefined,
                  }),
                )
              }
            />
          </Question>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || (step === 0 && !fromSummary)}
            onClick={() => {
              if (fromSummary) {
                setFromSummary(false);
                setStep(steps.length);
              } else setStep(step - 1);
            }}
          >
            Back
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Next
          </Button>
          <Button variant="quiet" disabled={busy} onClick={onSkipStep}>
            Skip
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => setConfirmSkipAll(true)}>
            Skip the whole check-in
          </Button>
        </div>
        {confirmSkipAll ? (
          <div
            role="alertdialog"
            aria-label="Skip the whole check-in?"
            className="flex flex-col gap-2 border-l-4 border-ink bg-raised px-3 py-2"
          >
            <p className="m-0 font-semibold">Skip the whole check-in?</p>
            <p className="m-0 text-muted">
              Coach Cade will read your week from your running log alone, without your answers.
            </p>
            <div className="flex gap-3">
              <Button disabled={busy} onClick={() => void skipEntireCheckIn()}>
                Skip it
              </Button>
              <Button variant="quiet" onClick={() => setConfirmSkipAll(false)}>
                Keep going
              </Button>
            </div>
          </div>
        ) : null}
      </form>
      <ErrorNote error={error} />
    </Page>
  );
}

function Question({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <p className="m-0 text-lg font-medium">{text}</p>
      {children}
      <Muted>You can leave this blank.</Muted>
    </section>
  );
}

function RunQuestions({
  run,
  unit,
  answers,
  painScale,
  onChange,
}: {
  run: NeedsSubjectiveRun & { date: string };
  unit: UnitPreference;
  answers: SubjectiveAnswers;
  painScale: boolean;
  onChange: (next: SubjectiveAnswers) => void;
}) {
  const row = answers.runs.find((r) => r.date === run.date);
  const title = runTitle(run, unit);
  return (
    <section className="flex flex-col gap-5 border-y border-border py-4" aria-label={title}>
      <h2 className="m-0 text-xl font-semibold leading-snug">{title}</h2>
      <ScaleSlider
        label="How hard did it feel?"
        low="Very easy"
        high="All-out"
        value={row?.rpe ?? run.apiRpe ?? undefined}
        hint={
          run.apiRpe != null && row?.rpe === undefined
            ? "Filled in from your watch. Change it if it’s off."
            : undefined
        }
        onChange={(n) => onChange(withRunAnswer(answers, run.date, { rpe: n }))}
      />
      <ScaleSlider
        label="How did it go?"
        low="Rough"
        high="Great"
        value={row?.felt}
        onChange={(n) => onChange(withRunAnswer(answers, run.date, { felt: n }))}
      />
      {painScale ? (
        <ScaleSlider
          label="How much did it hurt?"
          low="None"
          high="Worst"
          min={0}
          value={row?.pain_score}
          onChange={(n) => onChange(withRunAnswer(answers, run.date, { pain_score: n }))}
        />
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="font-medium">Any pain or niggles?</span>
        <Input
          value={row?.pain ?? ""}
          onChange={(e) => onChange(withRunAnswer(answers, run.date, { pain: e.target.value }))}
          placeholder="Leave blank if none"
        />
      </label>
    </section>
  );
}
