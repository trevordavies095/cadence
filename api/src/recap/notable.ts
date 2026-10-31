/**
 * Notable section: new bests of the week, shoe mileage warn, RE overload.
 * Empty sets degrade to a stable placeholder (section always present).
 */

import type {
  TempoBestEffort,
  TempoShoe,
  TempoUnitPreference,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import type { SectionDepth } from "./phase.js";
import {
  formatShoeDistance,
  SHOE_WARN_DISTANCE_M,
  shoeDistanceM,
} from "./shoeDistance.js";

export const NOTABLE_RE_OVERLOAD_FACTOR = 1.3;

/** A best set during the week at one standard distance. */
export type NewBest = {
  distance: string;
  distanceM: number;
  timeS: number;
  /** The best before this week; null for a first effort at the distance. */
  previousTimeS: number | null;
  workoutId: string;
  workoutDate: string;
};

export type RecapNotableSnapshot = {
  bullets: string[];
  bestEfforts: {
    fetchOk: boolean;
    newBests: NewBest[];
  };
  /** Shoes on this week's runs past the warning distance. */
  shoesOverThreshold: ShoeOverThreshold[];
  overload: {
    flagged: boolean;
    weekRelativeEffort?: number;
    threeWeekAverage?: number;
  };
};

function shoeLabel(shoe: TempoShoe): string {
  const label = `${shoe.brand} ${shoe.model}`.trim();
  return label || shoe.id.slice(0, 8);
}

/** A shoe past the warning distance; `distanceM` in metres. */
export type ShoeOverThreshold = {
  shoeId: string;
  label: string;
  distanceM: number;
};

export function collectShoesOverMileageThreshold(args: {
  shoes: readonly TempoShoe[];
  weekWorkouts: readonly TempoWorkoutSummary[];
  /** Warning distance in metres; defaults to {@link SHOE_WARN_DISTANCE_M}. */
  thresholdM?: number;
}): ShoeOverThreshold[] {
  const threshold = args.thresholdM ?? SHOE_WARN_DISTANCE_M;
  const byId = new Map(
    args.shoes.map((s) => [s.id.toLowerCase(), s] as const),
  );
  const seen = new Set<string>();
  const out: ShoeOverThreshold[] = [];

  for (const w of args.weekWorkouts) {
    const sid =
      typeof w.shoeId === "string" && w.shoeId.trim() ? w.shoeId.trim() : "";
    if (!sid) continue;
    const key = sid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const shoe = byId.get(key);
    if (!shoe) continue;
    const distanceM = shoeDistanceM(shoe);
    if (distanceM === undefined || distanceM <= threshold) continue;
    out.push({ shoeId: sid, label: shoeLabel(shoe), distanceM });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function evaluateRelativeEffortOverload(args: {
  weekRelativeEffort: number;
  threeWeekAverage?: number;
}): {
  flagged: boolean;
  weekRelativeEffort?: number;
  threeWeekAverage?: number;
} {
  const avg = args.threeWeekAverage;
  if (
    avg === undefined ||
    !Number.isFinite(avg) ||
    avg <= 0 ||
    !Number.isFinite(args.weekRelativeEffort)
  ) {
    return { flagged: false };
  }
  const flagged = args.weekRelativeEffort >= NOTABLE_RE_OVERLOAD_FACTOR * avg;
  return {
    flagged,
    weekRelativeEffort: Math.round(args.weekRelativeEffort),
    threeWeekAverage: avg,
  };
}

function formatSecondsAsClock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
  }
  return `${m}:${String(rs).padStart(2, "0")}`;
}

/** "New best: 5K 21:40 (was 22:05)" or "(first time at this distance)". */
function formatNewBest(best: NewBest): string {
  const was =
    best.previousTimeS === null
      ? "first time at this distance"
      : `was ${formatSecondsAsClock(best.previousTimeS)}`;
  return `New best: ${best.distance} ${formatSecondsAsClock(best.timeS)} (${was})`;
}

export function buildRecapNotableSnapshot(args: {
  bestEffortsFetchOk: boolean;
  /** Tempo's bests set since the week's Monday (`since` call). */
  newBestEfforts: readonly TempoBestEffort[];
  shoes: readonly TempoShoe[];
  weekWorkouts: readonly TempoWorkoutSummary[];
  weekRelativeEffort: number;
  threeWeekAvgRelativeEffort?: number;
  /** The athlete's Tempo unit, for the shoe warning. */
  unit: TempoUnitPreference;
}): RecapNotableSnapshot {
  const newBests: NewBest[] = args.bestEffortsFetchOk
    ? args.newBestEfforts
        .map((e) => ({
          distance: e.distance,
          distanceM: e.distanceM,
          timeS: e.timeS,
          previousTimeS: e.previousTimeS ?? null,
          workoutId: e.workoutId,
          workoutDate: e.workoutDate,
        }))
        .sort((x, y) => x.distanceM - y.distanceM)
    : [];

  const shoesOverThreshold = collectShoesOverMileageThreshold({
    shoes: args.shoes,
    weekWorkouts: args.weekWorkouts,
  });

  const overload = evaluateRelativeEffortOverload({
    weekRelativeEffort: args.weekRelativeEffort,
    threeWeekAverage: args.threeWeekAvgRelativeEffort,
  });

  const bullets: string[] = [];

  for (const best of newBests) bullets.push(formatNewBest(best));

  for (const s of shoesOverThreshold) {
    bullets.push(
      `Shoe **${s.label}** at ${formatShoeDistance(s.distanceM, args.unit)} (>${formatShoeDistance(SHOE_WARN_DISTANCE_M, args.unit)})`,
    );
  }

  if (overload.flagged) {
    bullets.push(
      `Relative effort (${overload.weekRelativeEffort}) ≥ ${NOTABLE_RE_OVERLOAD_FACTOR}× 3-wk avg (${Math.round(overload.threeWeekAverage!)}) — possible overload`,
    );
  }

  return {
    bullets,
    bestEfforts: {
      fetchOk: args.bestEffortsFetchOk,
      newBests,
    },
    shoesOverThreshold,
    overload,
  };
}

/** Markdown `## Notable` — always present; empty → graceful placeholder. */
export function buildNotableMarkdown(
  snapshot: RecapNotableSnapshot,
  depth: SectionDepth,
  opts?: { tempoParity?: boolean },
): string {
  const parity = opts?.tempoParity === true;
  const lines: string[] = ["## Notable", ""];
  let bullets = snapshot.bullets;

  // tempo-cli omits Notable entirely when there are no bullets.
  if (parity && bullets.length === 0) return "";

  if (bullets.length === 0) {
    lines.push("- No notable items this week.");
    lines.push("");
    return lines.join("\n");
  }

  if (!parity && depth === "brief") {
    bullets = bullets.slice(0, 1);
  }

  for (const b of bullets) {
    lines.push(`- ${b}`);
  }
  lines.push("");
  return lines.join("\n").trimEnd() + "\n";
}
