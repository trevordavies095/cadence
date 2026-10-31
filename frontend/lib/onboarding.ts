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
 * The goal as the athlete has entered it so far, as fields rather than sentences. Each kind
 * keeps its own fields, so switching between them never carries a race's answers into speed.
 * Onboarding and Settings both edit one of these.
 */
export type GoalDraft = {
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
  /** Getting back to running: where the athlete is now, in their words. */
  startingPoint: string;
  /** YYYY-MM-DD from a date picker, or empty. */
  since: string;
};

/** What the athlete has entered so far in onboarding: the goal and the rest of the answers. */
export type OnboardingDraft = GoalDraft & {
  runDays: Weekday[];
  longRunDay: Weekday | null;
  hoursPerWeek: number | undefined;
  injuries: string;
  preferences: string;
};

export const EMPTY_GOAL_DRAFT: GoalDraft = {
  goalKind: null,
  raceDistance: null,
  raceName: "",
  raceDate: "",
  raceTarget: "",
  speedDistance: null,
  speedTarget: "",
  nextRaceDate: "",
  startingPoint: "",
  since: "",
};

export const EMPTY_DRAFT: OnboardingDraft = {
  ...EMPTY_GOAL_DRAFT,
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
export function draftGoal(d: GoalDraft): TrainingGoal | null {
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
  if (d.goalKind === "return") {
    // Both are optional: the choice alone is enough to go on.
    const startingPoint = d.startingPoint.trim();
    return {
      kind: "return",
      ...(startingPoint ? { startingPoint } : {}),
      ...(d.since ? { since: d.since } : {}),
    };
  }
  return null;
}

/** Plain words when the goal is not complete yet; null when it is fine to go on. */
export function goalProblem(d: GoalDraft): string | null {
  if (d.goalKind === null) return "Choose one to continue.";
  if (d.goalKind === "race" && !d.raceDistance) return "Choose the race distance.";
  if (d.goalKind === "race" && !d.raceName.trim()) return "Tell Coach Cade which race it is.";
  if (d.goalKind === "speed" && !d.speedDistance) return "Choose 5k or 10k.";
  return null;
}

/**
 * What the week's biggest run is called for this goal: "long run" when training for a half,
 * a marathon or a race of another distance, "longer run" for 5k, 10k, speed and staying fit.
 * Null for getting back to running, which is not asked about one.
 */
export function longRunName(d: GoalDraft): "long run" | "longer run" | null {
  if (d.goalKind === "return" || d.goalKind === null) return null;
  if (d.goalKind === "race" && d.raceDistance !== "5k" && d.raceDistance !== "10k") {
    return "long run";
  }
  return "longer run";
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
  const longRun = longRunName(d);
  if (longRun && d.longRunDay && d.runDays.includes(d.longRunDay)) {
    parts.push(`Prefers the ${longRun} on ${d.longRunDay}.`);
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
  if (step === "goal") return goalProblem(d);
  if (step === "days" && d.runDays.length === 0) return "Choose at least one day to continue.";
  return null;
}
