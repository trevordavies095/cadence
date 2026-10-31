import type { OnboardingSubmission, TrainingGoal } from "./api";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type GoalKind = TrainingGoal["kind"];
export type RaceDistance = NonNullable<TrainingGoal["distance"]>;
export type SpeedDistance = "5k" | "10k";

/** The four answers to "What are you training for?", in the order they are offered. */
export const GOAL_CHOICES: [GoalKind, string][] = [
  ["race", "A race"],
  ["speed", "Faster at 5k or 10k"],
  ["fitness", "Stay fit"],
  ["return", "Getting back to running"],
];

export const RACE_DISTANCE_CHOICES: [RaceDistance, string][] = [
  ["5k", "5k"],
  ["10k", "10k"],
  ["half", "Half"],
  ["marathon", "Marathon"],
  ["other", "Other"],
];

export const SPEED_DISTANCE_CHOICES: [SpeedDistance, string][] = [
  ["5k", "5k"],
  ["10k", "10k"],
];

/**
 * What the athlete has entered so far, as fields rather than sentences. Each kind keeps its
 * own fields, so switching between them never carries a race's answers into speed.
 */
export type OnboardingDraft = {
  goalKind: GoalKind | null;
  raceDistance: RaceDistance | null;
  raceName: string;
  /** YYYY-MM-DD from a date picker, or empty. */
  raceDate: string;
  raceTarget: string;
  speedDistance: SpeedDistance | null;
  speedTarget: string;
  /** YYYY-MM-DD from a date picker, or empty. */
  nextRaceDate: string;
  runDays: Weekday[];
  longRunDay: Weekday | null;
  hoursPerWeek: number | undefined;
  injuries: string;
  preferences: string;
};

export const EMPTY_DRAFT: OnboardingDraft = {
  goalKind: null,
  raceDistance: null,
  raceName: "",
  raceDate: "",
  raceTarget: "",
  speedDistance: null,
  speedTarget: "",
  nextRaceDate: "",
  runDays: [],
  longRunDay: null,
  hoursPerWeek: undefined,
  injuries: "",
  preferences: "",
};

function joinDays(days: readonly Weekday[]): string {
  return WEEKDAYS.filter((d) => days.includes(d)).join(", ");
}

/** The goal as the record the API stores; it writes the sentence the coach reads. */
export function draftGoal(d: OnboardingDraft): TrainingGoal | null {
  if (d.goalKind === "race") {
    const raceName = d.raceName.trim();
    if (!raceName || !d.raceDistance) return null;
    const target = d.raceTarget.trim();
    return {
      kind: "race",
      distance: d.raceDistance,
      raceName,
      ...(d.raceDate ? { raceDate: d.raceDate } : {}),
      ...(target ? { target } : {}),
    };
  }
  if (d.goalKind === "speed") {
    if (!d.speedDistance) return null;
    const target = d.speedTarget.trim();
    return {
      kind: "speed",
      distance: d.speedDistance,
      ...(target ? { target } : {}),
      ...(d.nextRaceDate ? { raceDate: d.nextRaceDate } : {}),
    };
  }
  if (d.goalKind === "fitness") return { kind: "fitness" };
  // Getting back to running asks for nothing more yet.
  if (d.goalKind === "return") return { kind: "return" };
  return null;
}

/**
 * The days are when the athlete is free, not a request to run on each of them: the plan
 * decides how many to use. The sentence says so outright, because it is copied into what the
 * coach reads before every plan.
 */
export function serializeSchedule(d: OnboardingDraft): string {
  if (d.runDays.length === 0) return "";
  const days =
    d.runDays.length === WEEKDAYS.length ? "any day of the week" : `on ${joinDays(d.runDays)}`;
  const parts = [
    `Free to run ${days}. These are the days that work, not a target: the plan decides how many runs to schedule and which of these days to use.`,
  ];
  if (d.longRunDay && d.runDays.includes(d.longRunDay)) {
    parts.push(`Prefers the long run on ${d.longRunDay}.`);
  }
  if (d.hoursPerWeek !== undefined) {
    parts.push(
      `Up to about ${d.hoursPerWeek} ${d.hoursPerWeek === 1 ? "hour" : "hours"} a week for training.`,
    );
  }
  return parts.join(" ");
}

/** The goal record and the other answers the coach reads. Null while a required one is missing. */
export function serializeAnswers(d: OnboardingDraft): OnboardingSubmission | null {
  const goal = draftGoal(d);
  const schedule = serializeSchedule(d);
  if (!goal || !schedule) return null;
  return {
    answers: {
      schedule,
      injuries_constraints: d.injuries.trim() || undefined,
      preferences: d.preferences.trim() || undefined,
    },
    goal,
  };
}

export type OnboardingStep = "goal" | "days" | "hours" | "injuries" | "preferences";
export const ONBOARDING_STEPS: OnboardingStep[] = ["goal", "days", "hours", "injuries", "preferences"];

/** Plain words when a required step is not done yet; null when it is fine to go on. */
export function stepProblem(step: OnboardingStep, d: OnboardingDraft): string | null {
  if (step === "goal") {
    if (d.goalKind === null) return "Choose one to continue.";
    if (d.goalKind === "race" && !d.raceDistance) return "Choose the race distance.";
    if (d.goalKind === "race" && !d.raceName.trim()) return "Tell Coach Cade which race it is.";
    if (d.goalKind === "speed" && !d.speedDistance) return "Choose 5k or 10k.";
  }
  if (step === "days" && d.runDays.length === 0) return "Choose at least one day to continue.";
  return null;
}
