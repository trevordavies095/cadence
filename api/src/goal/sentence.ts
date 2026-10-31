import type { GoalKind, TrainingGoal } from "./types.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat Jan 16 2027" from YYYY-MM-DD. Pure calendar arithmetic, so no time zone can move it. */
export function goalDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[m - 1]} ${d} ${y}`;
}

function raceSentence(goal: TrainingGoal): string {
  const name = goal.raceName ?? "";
  return goal.raceDate
    ? `Race: ${name} on ${goalDateLabel(goal.raceDate)}.`
    : `Race: ${name}, date not set yet.`;
}

/**
 * One sentence per kind. Every kind needs an entry, so a new kind cannot be added
 * without deciding its words. Speed and return are placeholders until their
 * onboarding steps exist.
 */
const SENTENCES: Record<GoalKind, (goal: TrainingGoal) => string> = {
  race: raceSentence,
  fitness: () => "General fitness, no race planned.",
  speed: (goal) =>
    goal.distance && goal.distance !== "other"
      ? `Working on ${goal.distance} speed.`
      : "Working on speed.",
  return: () => "Getting back to running.",
};

/** An error code when the goal is a valid record but cannot be put in a sentence; null when fine. */
export function goalSentenceProblem(goal: TrainingGoal): string | null {
  if (goal.kind === "race" && !goal.raceName) return "race_name_required";
  return null;
}

/**
 * The sentence About you reads for a goal, as stored in the onboarding answers.
 * `goal` must already be parsed and pass `goalSentenceProblem`.
 */
export function goalSentence(goal: TrainingGoal): string {
  return SENTENCES[goal.kind](goal);
}
