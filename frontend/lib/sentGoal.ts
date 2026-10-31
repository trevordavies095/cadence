import type { SentCoaching, SentGoal } from "./api";
import { dayLabel } from "./checkIn";
import { paceLabel } from "./units";

const DISTANCE_WORDS: Record<NonNullable<SentGoal["distance"]>, string> = {
  "5k": "5K",
  "10k": "10K",
  half: "half marathon",
  marathon: "marathon",
  other: "race",
};

/** "Sun Mar 7 2027". */
function dateWithYear(ymd: string): string {
  return `${dayLabel(ymd)} ${ymd.slice(0, 4)}`;
}

function raceTiming(coaching: SentCoaching | null): string | null {
  if (!coaching) return null;
  if (coaching.racePassed) return "race day has passed";
  const weeks = coaching.weeksToRace;
  if (weeks === undefined) return null;
  if (weeks === 0) return "race week";
  return `${weeks} ${weeks === 1 ? "week" : "weeks"} out`;
}

/**
 * What the athlete is training for, in plain words:
 * "half marathon on Sun Mar 7 2027, 19 weeks out".
 */
export function trainingForLabel(goal: SentGoal, coaching: SentCoaching | null): string {
  const target = goal.target ? `, aiming for ${goal.target}` : "";
  switch (goal.kind) {
    case "fitness":
      return "general fitness";
    case "return":
      return `coming back to running${goal.since ? ` since ${dateWithYear(goal.since)}` : ""}`;
    case "race":
    case "speed": {
      const distance = goal.distance ? DISTANCE_WORDS[goal.distance] : "race";
      let what =
        goal.kind === "speed"
          ? goal.distance && goal.distance !== "other"
            ? `a faster ${distance}`
            : "getting faster"
          : distance;
      if (goal.raceName) what = `${goal.raceName} (${what})`;
      if (!goal.raceDate) {
        return goal.kind === "race" ? `${what}, date not set yet${target}` : `${what}${target}`;
      }
      const timing = raceTiming(coaching);
      return `${what} on ${dateWithYear(goal.raceDate)}${timing ? `, ${timing}` : ""}${target}`;
    }
  }
}

const STAGE_WORDS: Record<SentCoaching["phase"], string> = {
  base: "building a base",
  build: "building toward the goal",
  peak: "the hardest weeks before the race",
  taper: "easing off before the race",
  recovery: "recovering",
};

/** Where the athlete is in training that week, in plain words (never the word "phase"). */
export function trainingStageLabel(coaching: SentCoaching): string {
  return STAGE_WORDS[coaching.phase];
}

/**
 * The training numbers that went along, in plain words, or null when none did:
 * "threshold pace 7:15/mi, threshold heart rate 168 bpm, max heart rate 186 bpm".
 */
export function trainingNumbersLabel(coaching: SentCoaching): string | null {
  const unit = coaching.unitPreference ?? "metric";
  const parts: string[] = [];
  if (coaching.thresholdPaceS !== undefined) {
    parts.push(`threshold pace ${paceLabel(coaching.thresholdPaceS, unit)}`);
  } else if (coaching.suggestedThresholdPaceS !== undefined) {
    parts.push(`suggested threshold pace ${paceLabel(coaching.suggestedThresholdPaceS, unit)}`);
  }
  if (coaching.thresholdHeartRateBpm !== undefined) {
    parts.push(`threshold heart rate ${coaching.thresholdHeartRateBpm} bpm`);
  }
  if (coaching.maxHeartRateBpm !== undefined) {
    parts.push(`max heart rate ${coaching.maxHeartRateBpm} bpm`);
  }
  if (coaching.observedMaxHeartRateBpm !== undefined) {
    parts.push(`highest heart rate in the last year ${coaching.observedMaxHeartRateBpm} bpm`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
