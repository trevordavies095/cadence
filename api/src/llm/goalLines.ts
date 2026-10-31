/**
 * The lines every weekly read and conversation prompt opens with: the athlete's
 * goal, then the training phase, then (after a race) how long ago it was.
 * Built from the packet's `goal` and `coaching`, so the model never has to dig
 * the goal out of About you's prose. Pure.
 */
import { goalDateLabel } from "../goal/sentence.js";
import type { GoalDistance, GoalKind, TrainingGoal } from "../goal/types.js";
import { thresholdPhrase } from "../packet/thresholdPhrase.js";
import type { ModelPacketCoaching } from "../packet/types.js";

const DAY_MS = 86_400_000;

const RACE_DISTANCE: Record<GoalDistance, string> = {
  "5k": "5K",
  "10k": "10K",
  half: "half marathon",
  marathon: "marathon",
  other: "a race",
};

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function weeksOut(weeks: number): string {
  if (weeks === 0) return "race week";
  return `${weeks} week${weeks === 1 ? "" : "s"} out`;
}

/** "(Lakeshore Half) on Sun Mar 14 2027, 20 weeks out" — the parts that exist. */
function raceParts(goal: TrainingGoal, coaching: ModelPacketCoaching | null): string[] {
  const parts: string[] = [];
  let race = goal.raceName ? `(${goal.raceName})` : "";
  if (goal.raceDate) {
    race = [race, `on ${goalDateLabel(goal.raceDate)}`].filter(Boolean).join(" ");
  }
  if (race) parts.push(race);
  if (coaching?.weeksToRace !== undefined) parts.push(weeksOut(coaching.weeksToRace));
  return parts;
}

function withTarget(head: string, goal: TrainingGoal): string {
  return goal.target ? `${head}, target ${goal.target}` : head;
}

const GOAL_TEXT: Record<
  GoalKind,
  (goal: TrainingGoal, coaching: ModelPacketCoaching | null) => string
> = {
  race: (goal, coaching) => {
    const distance = RACE_DISTANCE[goal.distance ?? "other"];
    const [race, ...rest] = raceParts(goal, coaching);
    const head = race ? `${distance} ${race}` : distance;
    const dated = goal.raceDate ? head : `${head}, date not set yet`;
    return withTarget([dated, ...rest].join(", "), goal);
  },
  speed: (goal, coaching) => {
    const distance =
      goal.distance && goal.distance !== "other" ? RACE_DISTANCE[goal.distance] : null;
    const head = distance ? `get faster at the ${distance}` : "get faster";
    const race = goal.raceDate ? raceParts(goal, coaching) : [];
    const [first, ...rest] = race;
    const withRace = first ? [`${head}, test race ${first}`, ...rest] : [head];
    return withTarget(withRace.join(", "), goal);
  },
  fitness: (goal) => withTarget("general fitness, no race planned", goal),
  return: (goal) => {
    const head = goal.since
      ? `return to running since ${goalDateLabel(goal.since)}`
      : "return to running";
    return goal.startingPoint ? `${head}; the athlete says: ${goal.startingPoint}` : head;
  },
};

/** "Athlete goal: …." from the stored goal; "Athlete goal: not set." with none. */
export function athleteGoalLine(
  goal: TrainingGoal | null,
  coaching: ModelPacketCoaching | null,
): string {
  if (!goal) return "Athlete goal: not set.";
  const text = GOAL_TEXT[goal.kind](goal, coaching).replace(/[.\s]+$/, "");
  return `Athlete goal: ${text}.`;
}

/**
 * "Training phase: build." from the coaching block alone, with the threshold
 * pace when the running log has one, in the athlete's unit:
 * "Training phase: build. Threshold pace 4:10/km (set in your running log)."
 */
export function trainingPhaseLine(coaching: ModelPacketCoaching | null): string {
  if (!coaching) return "Training phase: not set.";
  const phase = `Training phase: ${coaching.phase}.`;
  const threshold = thresholdPhrase(coaching, coaching.unitPreference ?? "metric");
  return threshold ? `${phase} ${threshold}.` : phase;
}

/**
 * After the race date: how many calendar weeks ago it was, counted from the
 * week the coaching block was resolved for. Null before the race or with no date.
 */
export function racePassedLine(
  goal: TrainingGoal | null,
  coaching: ModelPacketCoaching | null,
  weekMonday: string,
): string | null {
  if (!coaching?.racePassed || !goal?.raceDate) return null;
  const raceDay = dayNumber(goal.raceDate);
  // Monday of the race's week (UTC day 0 was a Thursday).
  const raceMonday = raceDay - ((raceDay + 3) % 7);
  const weeks = Math.max(1, Math.round((dayNumber(weekMonday) - raceMonday) / 7));
  const ago = `The race was ${weeks} week${weeks === 1 ? "" : "s"} ago.`;
  if (coaching.phase !== "recovery") return `${ago} Ask the athlete what comes next.`;
  const ease = weeks === 1 ? "Ease the next two weeks" : "Keep this week easy";
  return `${ago} ${ease} and ask the athlete what comes next.`;
}

/** The opening lines of a weekly read or conversation prompt. */
export function goalPromptLines(
  packet: { goal?: TrainingGoal | null; coaching?: ModelPacketCoaching | null },
  weekMonday: string,
): string[] {
  const goal = packet.goal ?? null;
  const coaching = packet.coaching ?? null;
  const passed = racePassedLine(goal, coaching, weekMonday);
  return [
    athleteGoalLine(goal, coaching),
    trainingPhaseLine(coaching),
    ...(passed ? [passed] : []),
  ];
}
