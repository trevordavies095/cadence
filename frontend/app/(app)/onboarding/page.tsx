"use client";

import { describeError, type UiError } from "@/lib/errors";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DayChips, DayChoice } from "@/components/OnboardingControls";
import { Stepper } from "@/components/CheckInControls";
import {
  Button,
  ErrorNote,
  Field,
  Input,
  Muted,
  Page,
  PageTitle,
  Textarea,
  WaitingState,
  cx,
} from "@/components/ui";
import {
  ensureCurrentWeek,
  fetchOnboarding,
  saveOnboardingAnswers,
  type OnboardingAnswers,
  type OnboardingGate,
  type WeekSession,
} from "@/lib/api";
import {
  EMPTY_DRAFT,
  ONBOARDING_STEPS,
  serializeAnswers,
  stepProblem,
  type GoalKind,
  type OnboardingDraft,
} from "@/lib/onboarding";

type GateState = "loading" | "open";

function Redirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return (
    <WaitingState>
      <p className="m-0">One moment…</p>
    </WaitingState>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [gate, setGate] = useState<GateState>("loading");
  const [week, setWeek] = useState<WeekSession | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingGate | null>(null);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const current = await ensureCurrentWeek();
        if (cancelled) return;
        setWeek(current);
        const onboard = await fetchOnboarding();
        if (cancelled) return;
        setOnboarding(onboard);
        setGate("open");
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your questions. Try again in a minute."));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const interviewActive = onboarding?.status === "needs_onboarding";
  // One quiet line, only when your running log is connected: no need to retype what it knows.
  const logConnected = interviewActive && onboarding.prefills.available;

  function change(patch: Partial<OnboardingDraft>) {
    setProblem(null);
    setDraft((d) => ({ ...d, ...patch }));
  }

  async function finishInterview(answers: OnboardingAnswers) {
    if (!week) return;
    setBusy(true);
    setError(null);
    try {
      await saveOnboardingAnswers(answers, week.id);
      // The coach has written down what it understood; the next stop is the card that asks
      // whether that looks right.
      router.replace("/dossier");
    } catch (err) {
      setError(describeError(err, "Couldn’t save that. Try again."));
      setBusy(false);
    }
  }

  function onNext(e: FormEvent) {
    e.preventDefault();
    const name = ONBOARDING_STEPS[step]!;
    const blocked = stepProblem(name, draft);
    if (blocked) {
      setProblem(blocked);
      return;
    }
    if (step + 1 < ONBOARDING_STEPS.length) {
      setStep(step + 1);
      return;
    }
    const answers = serializeAnswers(draft);
    if (!answers) {
      setProblem("Your goal and run days are needed before Coach Cade can start.");
      return;
    }
    void finishInterview(answers);
  }

  if (gate !== "open") {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your questions…</p>}
      </WaitingState>
    );
  }

  // Already answered: there is nothing to ask, so go where the athlete would go next.
  if (onboarding?.status === "ready" || onboarding?.status === "complete") {
    return <Redirect to={onboarding.status === "ready" ? "/dossier" : "/"} />;
  }

  if (!interviewActive) {
    return (
      <WaitingState>
        <p className="m-0">Loading your questions…</p>
      </WaitingState>
    );
  }

  if (!started) {
    return (
      <Page flow>
        <PageTitle>Let Coach Cade get to know you</PageTitle>
        <p className="m-0 text-lg">
          Five short questions, about two minutes. Coach Cade uses your answers to build the
          first weeks of your plan.
        </p>
        <ul className="m-0 flex flex-col gap-1.5 pl-5">
          <li>What you’re training for</li>
          <li>Which days you’re free to run</li>
          <li>How much time you have</li>
          <li>Any injuries or limits</li>
          <li>Anything else you’d like Coach Cade to know</li>
        </ul>
        {logConnected ? (
          <Muted>
            Coach Cade can already see your recent runs and shoes from your running log, so
            there’s no need to type those in.
          </Muted>
        ) : null}
        <Muted>You can change any of this later by telling Coach Cade.</Muted>
        <div>
          <Button variant="primary" onClick={() => setStarted(true)}>
            Start
          </Button>
        </div>
      </Page>
    );
  }

  const name = ONBOARDING_STEPS[step]!;
  const isLast = step + 1 >= ONBOARDING_STEPS.length;
  const required = name === "goal" || name === "days";

  return (
    <Page flow>
      <PageTitle>A few questions</PageTitle>
      <p className="m-0 text-sm font-semibold text-muted" aria-live="polite">
        {step + 1} of {ONBOARDING_STEPS.length}
      </p>

      <form onSubmit={onNext} className="flex flex-col gap-5" aria-label="A few questions for Coach Cade">
        {name === "goal" ? (
          <section className="flex flex-col gap-3">
            <p className="m-0 text-lg font-medium">What are you training for?</p>
            <div role="radiogroup" aria-label="Your goal" className="flex flex-wrap gap-2">
              {(
                [
                  ["race", "A race"],
                  ["fitness", "General fitness"],
                ] as [GoalKind, string][]
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={draft.goalKind === kind}
                  onClick={() => change({ goalKind: kind })}
                  className={cx(
                    "rounded-tempo border px-4 py-2.5 text-base font-semibold",
                    draft.goalKind === kind
                      ? "border-ink bg-raised text-ink"
                      : "border-border text-muted hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {draft.goalKind === "race" ? (
              <div className="flex flex-col gap-3">
                <Field label="Which race?">
                  <Input
                    value={draft.raceName}
                    onChange={(e) => change({ raceName: e.target.value })}
                    placeholder="For example, a half marathon"
                    autoFocus
                  />
                </Field>
                <Field label="Race date" hint="Leave blank if you haven’t picked one yet.">
                  <Input
                    type="date"
                    value={draft.raceDate}
                    onChange={(e) => change({ raceDate: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
          </section>
        ) : name === "days" ? (
          <section className="flex flex-col gap-4">
            <p className="m-0 text-lg font-medium">Which days are you free to run?</p>
            <Muted>
              Pick every day that works. Your coach decides how many of them to use, so picking all
              seven doesn’t mean running every day.
            </Muted>
            <DayChips
              label="Days you’re free to run"
              value={draft.runDays}
              onChange={(days) =>
                change({
                  runDays: days,
                  longRunDay: draft.longRunDay && days.includes(draft.longRunDay) ? draft.longRunDay : null,
                })
              }
            />
            <div className="flex flex-col gap-2">
              <p className="m-0 font-medium">Which day suits a long run best?</p>
              {draft.runDays.length > 0 ? (
                <DayChoice
                  label="Long run day"
                  options={draft.runDays}
                  value={draft.longRunDay}
                  onChange={(day) => change({ longRunDay: day })}
                />
              ) : (
                <Muted>Pick your free days first.</Muted>
              )}
            </div>
          </section>
        ) : name === "hours" ? (
          <section className="flex flex-col gap-3">
            <p className="m-0 text-lg font-medium">At most, about how many hours a week can you give to training?</p>
            <Stepper
              label="Hours a week"
              value={draft.hoursPerWeek}
              min={1}
              max={20}
              step={1}
              firstUp={4}
              firstDown={4}
              format={(n) => `${n} ${n === 1 ? "hour" : "hours"}`}
              lessLabel="Fewer hours"
              moreLabel="More hours"
              onChange={(n) => change({ hoursPerWeek: n })}
            />
          </section>
        ) : name === "injuries" ? (
          <section className="flex flex-col gap-3">
            <p className="m-0 text-lg font-medium">Any injuries or limits Coach Cade should know about?</p>
            <Textarea
              aria-label="Injuries and limits"
              rows={4}
              autoFocus
              value={draft.injuries}
              onChange={(e) => change({ injuries: e.target.value })}
            />
          </section>
        ) : (
          <section className="flex flex-col gap-3">
            <p className="m-0 text-lg font-medium">Anything else you’d like Coach Cade to know?</p>
            <Textarea
              aria-label="Anything else for Coach Cade"
              rows={4}
              autoFocus
              value={draft.preferences}
              onChange={(e) => change({ preferences: e.target.value })}
            />
          </section>
        )}

        <Muted>{required ? "Required." : "Optional. You can leave this blank."}</Muted>
        {problem ? (
          <p role="alert" className="m-0 text-danger">
            {problem}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || step === 0}
            onClick={() => {
              setProblem(null);
              setStep(step - 1);
            }}
          >
            Back
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : isLast ? "Finish" : "Next"}
          </Button>
        </div>
      </form>
      <ErrorNote error={error} />
    </Page>
  );
}
