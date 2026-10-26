/**
 * Notable section: PR-ish best-effort deltas, shoe mileage warn, RE overload.
 * Empty sets degrade to a stable placeholder (section always present).
 */

import type {
  TempoBestEffort,
  TempoShoe,
  TempoWorkoutSummary,
} from "../tempo/port.js";
import type { SectionDepth } from "./phase.js";

const METERS_PER_MILE = 1609.344;
export const NOTABLE_SHOE_MILEAGE_WARN_MI = 400;
export const NOTABLE_RE_OVERLOAD_FACTOR = 1.3;

export type BestEffortPr = {
  key: string;
  label: string;
  previousSeconds: number;
  currentSeconds: number;
};

export type RecapNotableSnapshot = {
  bullets: string[];
  bestEfforts: {
    fetchOk: boolean;
    /** Prior snapshot not persisted yet in MVP — PRs require a prior map. */
    hadPriorCache: boolean;
    prs: BestEffortPr[];
  };
  shoesOverThreshold: { shoeId: string; label: string; mileageMi: number }[];
  overload: {
    flagged: boolean;
    weekRelativeEffort?: number;
    threeWeekAverage?: number;
  };
};

function shoeMileageMi(shoe: TempoShoe): number | undefined {
  if (
    typeof shoe.totalMileage === "number" &&
    Number.isFinite(shoe.totalMileage) &&
    shoe.totalMileage >= 0
  ) {
    if (shoe.totalMileage > 500) return shoe.totalMileage / METERS_PER_MILE;
    return shoe.totalMileage;
  }
  if (
    typeof shoe.initialMileageM === "number" &&
    Number.isFinite(shoe.initialMileageM) &&
    shoe.initialMileageM > 0
  ) {
    return shoe.initialMileageM / METERS_PER_MILE;
  }
  return undefined;
}

function shoeLabel(shoe: TempoShoe): string {
  const label = `${shoe.brand} ${shoe.model}`.trim();
  return label || shoe.id.slice(0, 8);
}

export function collectShoesOverMileageThreshold(args: {
  shoes: readonly TempoShoe[];
  weekWorkouts: readonly TempoWorkoutSummary[];
  thresholdMi?: number;
}): { shoeId: string; label: string; mileageMi: number }[] {
  const threshold = args.thresholdMi ?? NOTABLE_SHOE_MILEAGE_WARN_MI;
  const byId = new Map(
    args.shoes.map((s) => [s.id.toLowerCase(), s] as const),
  );
  const seen = new Set<string>();
  const out: { shoeId: string; label: string; mileageMi: number }[] = [];

  for (const w of args.weekWorkouts) {
    const sid =
      typeof w.shoeId === "string" && w.shoeId.trim() ? w.shoeId.trim() : "";
    if (!sid) continue;
    const key = sid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const shoe = byId.get(key);
    if (!shoe) continue;
    const mileageMi = shoeMileageMi(shoe);
    if (mileageMi === undefined || mileageMi <= threshold) continue;
    out.push({ shoeId: sid, label: shoeLabel(shoe), mileageMi });
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

/**
 * Diff current best efforts against an optional prior map (seconds by distance key).
 * Without prior cache, returns no PRs (MVP has no week-over-week store yet).
 */
export function diffBestEffortPrs(args: {
  current: readonly TempoBestEffort[];
  priorByKey?: ReadonlyMap<string, number>;
}): BestEffortPr[] {
  const prior = args.priorByKey;
  if (!prior || prior.size === 0) return [];
  const prs: BestEffortPr[] = [];
  for (const row of args.current) {
    const key = row.distance.trim().toLowerCase().replace(/\s+/g, " ");
    if (!key) continue;
    const prev = prior.get(key);
    if (prev === undefined) continue;
    if (row.timeS < prev) {
      prs.push({
        key,
        label: row.distance,
        previousSeconds: prev,
        currentSeconds: row.timeS,
      });
    }
  }
  return prs.sort((a, b) => a.label.localeCompare(b.label));
}

export function buildRecapNotableSnapshot(args: {
  bestEffortsFetchOk: boolean;
  currentBestEfforts: readonly TempoBestEffort[];
  priorBestEffortSecondsByKey?: ReadonlyMap<string, number>;
  shoes: readonly TempoShoe[];
  weekWorkouts: readonly TempoWorkoutSummary[];
  weekRelativeEffort: number;
  threeWeekAvgRelativeEffort?: number;
}): RecapNotableSnapshot {
  const hadPriorCache =
    !!args.priorBestEffortSecondsByKey &&
    args.priorBestEffortSecondsByKey.size > 0;
  const prs =
    args.bestEffortsFetchOk && hadPriorCache
      ? diffBestEffortPrs({
          current: args.currentBestEfforts,
          priorByKey: args.priorBestEffortSecondsByKey,
        })
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

  if (args.bestEffortsFetchOk) {
    if (!hadPriorCache) {
      if (args.currentBestEfforts.length > 0) {
        bullets.push(
          "Best-effort PRs: no prior-week snapshot yet (next recap will compare against this run).",
        );
      }
    } else if (prs.length === 0) {
      bullets.push("No PRs");
    } else {
      for (const p of prs) {
        bullets.push(
          `PR'd **${p.label}** (was ${formatSecondsAsClock(p.previousSeconds)} → ${formatSecondsAsClock(p.currentSeconds)})`,
        );
      }
    }
  }

  for (const s of shoesOverThreshold) {
    bullets.push(
      `Shoe **${s.label}** at ${Math.round(s.mileageMi)} mi (>${NOTABLE_SHOE_MILEAGE_WARN_MI} mi)`,
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
      hadPriorCache,
      prs,
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
