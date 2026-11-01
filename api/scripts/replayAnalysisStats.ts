/**
 * Pure figures for the replay analysis (scripts/replay-analysis.ts): spread
 * of a set of numbers, a correlation, and what a weekly plan looks like next
 * to the baseline's plan for the same input.
 */
import type { DossierV1Draft, MidWeekChatReply, PrescribedDay, PrescribedWeek, WeeklyReply } from "../src/llm/types.js";
import type { Operation } from "./replayInputs.js";

export type Spread = { n: number; median: number | null; p90: number | null; worst: number | null; mean: number | null };

/** Median, 90th percentile (nearest rank), worst (the largest) and mean of the numbers given; nulls skipped. */
export function spread(values: Array<number | null | undefined>): Spread {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, median: null, p90: null, worst: null, mean: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  const p90 = v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)]!;
  return { n: v.length, median, p90, worst: v.at(-1)!, mean: v.reduce((a, b) => a + b, 0) / v.length };
}

/** Pearson's r over paired numbers; null with fewer than three pairs or no spread. With a 0/1 side it is the point-biserial r. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// ---- Plans -----------------------------------------------------------------------

export type PlanSummary = {
  /** Planned distance in meters, the sum of the runs. */
  totalM: number;
  /** The long run's distance: the longest run on a long day, else null when no day is long. */
  longM: number | null;
  /** Days with a run of some distance or duration. */
  runDays: number;
  dayTypes: string[];
  restDates: string[];
  hasQuality: boolean;
};

function isRunDay(d: PrescribedDay): boolean {
  return !!d.run && (d.run.distanceM > 0 || (d.run.durationS ?? 0) > 0);
}

export function planSummary(week: PrescribedWeek): PlanSummary {
  const days = week.days ?? [];
  const longDays = days.filter((d) => d.dayType === "long" || d.run?.type === "long");
  return {
    totalM: days.reduce((n, d) => n + (d.run?.distanceM ?? 0), 0),
    longM: longDays.length ? Math.max(...longDays.map((d) => d.run?.distanceM ?? 0)) : null,
    runDays: days.filter(isRunDay).length,
    dayTypes: days.map((d) => d.dayType),
    restDates: days.filter((d) => d.dayType === "rest").map((d) => d.date),
    hasQuality: days.some((d) => d.dayType === "quality" || d.run?.type === "quality"),
  };
}

export type PlanComparison = {
  /** Candidate over baseline planned distance; null when the baseline plans none. */
  distanceRatio: number | null;
  longRunRatio: number | null;
  runDays: { candidate: number; baseline: number };
  /** Share of the seven days (by position) with the same dayType. */
  dayTypeMatch: number;
  /** Whether the rest days fall on exactly the same dates. */
  sameRestDays: boolean;
  /** Share of days agreeing on rest or not rest. */
  restAgreement: number;
  quality: { candidate: boolean; baseline: boolean };
};

export function comparePlans(candidate: PrescribedWeek, baseline: PrescribedWeek): PlanComparison {
  const c = planSummary(candidate);
  const b = planSummary(baseline);
  const n = Math.max(c.dayTypes.length, b.dayTypes.length, 1);
  let same = 0;
  let restSame = 0;
  for (let i = 0; i < n; i++) {
    if (c.dayTypes[i] !== undefined && c.dayTypes[i] === b.dayTypes[i]) same++;
    if ((c.dayTypes[i] === "rest") === (b.dayTypes[i] === "rest")) restSame++;
  }
  const restKey = (s: PlanSummary) => [...s.restDates].sort().join(",");
  return {
    distanceRatio: b.totalM > 0 ? c.totalM / b.totalM : null,
    longRunRatio: b.longM && c.longM !== null ? c.longM / b.longM : null,
    runDays: { candidate: c.runDays, baseline: b.runDays },
    dayTypeMatch: same / n,
    sameRestDays: restKey(c) === restKey(b),
    restAgreement: restSame / n,
    quality: { candidate: c.hasQuality, baseline: b.hasQuality },
  };
}

/** The shape figures of a weekly read compared beside the plan. */
export function weeklyShape(reply: WeeklyReply): { flags: number; answers: number; headlineChars: number; analysisChars: number } {
  return {
    flags: reply.flags?.length ?? 0,
    answers: reply.answers?.length ?? 0,
    headlineChars: reply.headline.length,
    analysisChars: reply.analysis.length,
  };
}

// ---- Athlete-facing words -------------------------------------------------------------

function dayText(days: PrescribedDay[]): string {
  return days
    .map((d) => [d.notes, d.strength, d.run?.structure, d.run?.paceOrHr, d.run?.shoes].filter(Boolean).join(" "))
    .join("\n");
}

/**
 * Every athlete-facing word of a reply, as the replay report's checks read it
 * (weeklySection, midWeekSection and aboutYouSection in replay-weekly-reads.ts).
 */
export function readTextOf(operation: Operation, reply: unknown): string {
  if (operation === "weekly_reply") {
    const n = reply as WeeklyReply;
    return [
      n.headline,
      ...(n.flags ?? []).flatMap((f) => [f.title, f.detail]),
      ...(n.answers ?? []).flatMap((a) => [a.question, a.answer]),
      n.analysis,
      dayText(n.prescribedWeek.days),
      ...(n.safetyCallouts ?? []).map((c) => JSON.stringify(c)),
      ...(n.settingsProposalBullets ?? []),
    ].join("\n");
  }
  if (operation === "mid_week_chat") {
    const n = reply as MidWeekChatReply;
    return [n.body, ...(n.settingsProposalBullets ?? []), dayText(n.prescribedDayPatches ?? []), ...(n.safetyCallouts ?? []).map((c) => JSON.stringify(c))].join("\n");
  }
  const n = reply as DossierV1Draft;
  return [...n.summaryBullets, n.proposedBody].join("\n");
}
