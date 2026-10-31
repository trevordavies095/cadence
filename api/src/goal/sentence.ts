import type { GoalKind, TrainingGoal } from "./types.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat Jan 16 2027" from YYYY-MM-DD. Pure calendar arithmetic, so no time zone can move it. */
export function goalDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[m - 1]} ${d} ${y}`;
}

/**
 * ", target under 45 minutes" from the athlete's own words, or nothing. A trailing full
 * stop is dropped so the sentence ends once.
 */
function targetClause(goal: TrainingGoal): string {
  const target = goal.target?.trim().replace(/[.\s]+$/, "");
  return target ? `, target ${target}` : "";
}

function raceSentence(goal: TrainingGoal): string {
  const name = goal.raceName ?? "";
  const when = goal.raceDate ? ` on ${goalDateLabel(goal.raceDate)}` : ", date not set yet";
  return `Race: ${name}${when}${targetClause(goal)}.`;
}

/** "Working on 10k speed, target under 45 minutes, next race on Sat Jan 16 2027." */
function speedSentence(goal: TrainingGoal): string {
  const what =
    goal.distance && goal.distance !== "other"
      ? `Working on ${goal.distance} speed`
      : "Working on speed";
  const nextRace = goal.raceDate ? `, next race on ${goalDateLabel(goal.raceDate)}` : "";
  return `${what}${targetClause(goal)}${nextRace}.`;
}

/**
 * One sentence per kind. Every kind needs an entry, so a new kind cannot be added
 * without deciding its words. Return is a placeholder until its onboarding step exists.
 */
const SENTENCES: Record<GoalKind, (goal: TrainingGoal) => string> = {
  race: raceSentence,
  fitness: () => "General fitness, no race planned.",
  speed: speedSentence,
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
