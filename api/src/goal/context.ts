/**
 * Turn the training goal and a week's Monday into the recap's coaching context:
 * recap goal, phase, weeks to race, race passed, and the report knobs. Pure.
 */
import {
  resolveRecapDepthKnobs,
  type RecapDepthKnobs,
  type RecapGoal,
  type RecapPhase,
} from "../recap/phase.js";
import { isGoalDate, type TrainingGoal } from "./types.js";

export type GoalContext = {
  recapGoal: RecapGoal;
  phase: RecapPhase;
  /** Whole weeks from the week's Monday to the race; null with no date or after the race. */
  weeksToRace: number | null;
  /** The race date is before this week's Monday. The goal row is never changed. */
  racePassed: boolean;
  knobs: RecapDepthKnobs;
};

/** Days after the race during which the phase is recovery (two weeks). */
export const POST_RACE_RECOVERY_DAYS = 14;

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** Race phase by whole weeks to race: 13+ base, 4–12 build, 2–3 peak, 0–1 taper. */
export function phaseForWeeksToRace(weeks: number): RecapPhase {
  if (weeks >= 13) return "base";
  if (weeks >= 4) return "build";
  if (weeks >= 2) return "peak";
  return "taper";
}

/** Phase with no race date: race base, speed build, fitness base, return recovery. */
function undatedPhase(kind: TrainingGoal["kind"]): RecapPhase {
  switch (kind) {
    case "race":
    case "fitness":
      return "base";
    case "speed":
      return "build";
    case "return":
      return "recovery";
  }
}

function recapGoalFor(goal: TrainingGoal): RecapGoal {
  if (goal.kind !== "race" && goal.kind !== "speed") return "general";
  switch (goal.distance) {
    case "5k":
    case "10k":
    case "half":
    case "marathon":
      return goal.distance;
    default:
      return "general";
  }
}

/**
 * Resolve the coaching context for the week starting `weekMonday` (YYYY-MM-DD, athlete timezone).
 * With no goal (a legacy athlete) the context is general fitness in base.
 */
export function resolveGoalContext(
  goal: TrainingGoal | null,
  weekMonday: string,
): GoalContext {
  if (!isGoalDate(weekMonday)) {
    throw new Error(`weekMonday must be YYYY-MM-DD, got "${weekMonday}"`);
  }
  if (!goal) {
    return {
      recapGoal: "general",
      phase: "base",
      weeksToRace: null,
      racePassed: false,
      knobs: resolveRecapDepthKnobs({ phase: "base", goal: "general" }),
    };
  }

  const recapGoal = recapGoalFor(goal);
  let phase = undatedPhase(goal.kind);
  let weeksToRace: number | null = null;
  let racePassed = false;

  // Speed takes the race rule when it has a date; fitness and return ignore any date.
  const raceDate =
    (goal.kind === "race" || goal.kind === "speed") && goal.raceDate
      ? goal.raceDate
      : null;

  if (raceDate) {
    const days = dayNumber(raceDate) - dayNumber(weekMonday);
    if (days < 0) {
      // After the race: recovery for two weeks, then the phase as if undated.
      racePassed = true;
      if (-days <= POST_RACE_RECOVERY_DAYS) phase = "recovery";
    } else {
      weeksToRace = Math.floor(days / 7);
      phase = phaseForWeeksToRace(weeksToRace);
    }
  }

  return {
    recapGoal,
    phase,
    weeksToRace,
    racePassed,
    knobs: resolveRecapDepthKnobs({ phase, goal: recapGoal, kind: goal.kind }),
  };
}
