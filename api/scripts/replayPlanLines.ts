/**
 * What a saved reply's plan lines came to (plan-as-text ticket 11): how many
 * days Cadence could file, which dates failed on the reply's first parse and
 * why, which of them the plan-lines retry fixed, bare numbers, and lines
 * dropped. The replay (scripts/replay-weekly-reads.ts) saves it in each reply
 * file as `plan`; the analysis (scripts/replay-analysis.ts) derives it the
 * same way for reply files saved before the field existed. Pure: read only
 * from what a reply file holds, so no reply is re-run.
 *
 * Sources, all written by the app's own code (src/llm/schema.ts):
 * - the stored reply's days, `parsed: false` on a day Cadence could not file
 *   (rows with no `parsed` read as parsed, as the app reads them);
 * - the reply's repair notes, "; "-joined: "plan <date> not filed: <reason>",
 *   "plan line for <date> dropped: <reason>" and "plan line with no day
 *   ignored: ..." on the weekly read, the same with "changes" on mid-week;
 * - the attempts' saved requests (live runs): a `fix_lines` second request
 *   names the dates it was asked to fix and the dates it fixed, and its repair
 *   notes say "<box> <date> filed by the retry".
 */
import type { MidWeekChatReply, PrescribedDay, WeeklyReply } from "../src/llm/types.js";
import type { PlanLineFailureReason } from "../src/prescribed/planLines.js";
import type { Operation } from "./replayInputs.js";

/** The parser's fixed failure reasons (src/prescribed/planLines.ts), in the order the tables list them. */
export const PLAN_LINE_FAILURE_REASONS = [
  "no distance unit",
  "no distance or duration",
  "no day type word",
  "two lines for one day",
  "no line",
  "outside the plan week",
] as const satisfies readonly PlanLineFailureReason[];

// Fails to compile when the parser gains a reason this list does not name.
type Unlisted = Exclude<PlanLineFailureReason, (typeof PLAN_LINE_FAILURE_REASONS)[number]>;
const everyReasonListed: Unlisted extends never ? true : never = true;
void everyReasonListed;

export type PlanLineFailureCount = { date: string; reason: PlanLineFailureReason };

export type PlanLineSummary = {
  /** The box the lines came in: the weekly read's plan, or a mid-week reply's changes. */
  box: "plan" | "changes";
  /** Days stored from the box: seven for a weekly read; the changed days for mid-week. */
  daysTotal: number;
  /** Of those, the days Cadence filed (parsed). */
  daysParsed: number;
  /** Dates that failed when the reply that counted was first parsed, before any plan-lines retry, with the reason. */
  failures: PlanLineFailureCount[];
  /** Whether a plan-lines retry (fix_lines) was sent. */
  retried: boolean;
  /** Dates the retry was asked to fix. */
  retryAskedFor: string[];
  /** Dates the retry fixed. */
  fixedByRetry: string[];
  /** Failures for a bare number ("no distance unit"). */
  bareNumbers: number;
  /** Lines for a date outside the plan week, dropped. */
  droppedLines: PlanLineFailureCount[];
  /** Lines that did not open with a day, ignored. */
  ignoredLines: number;
};

/** The parts of a saved reply file the summary reads. */
export type SavedForPlanLines = {
  repairs?: string | null;
  timing?: {
    attempts?: Array<{
      attempt: number;
      request?: { kind: string; fixDates?: string[]; fixed?: string[] };
      repairs?: string | null;
    }>;
  };
  new?: unknown;
};

const REASON = PLAN_LINE_FAILURE_REASONS.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const DATE = "\\d{4}-\\d{2}-\\d{2}";

function matches(text: string, re: RegExp): RegExpExecArray[] {
  return [...text.matchAll(re)];
}

function daysOf(operation: Operation, reply: unknown): PrescribedDay[] | null {
  if (!reply || typeof reply !== "object") return null;
  if (operation === "weekly_reply") {
    const days = (reply as Partial<WeeklyReply>).prescribedWeek?.days;
    return Array.isArray(days) ? days : null;
  }
  const patches = (reply as Partial<MidWeekChatReply>).prescribedDayPatches;
  return Array.isArray(patches) ? patches : [];
}

/**
 * A saved reply's plan-lines summary; null for an About you reply, a refused
 * reply (no stored reply) and a weekly reply with no stored week.
 */
export function planLineSummary(operation: Operation, saved: SavedForPlanLines): PlanLineSummary | null {
  if (operation !== "weekly_reply" && operation !== "mid_week_chat") return null;
  const days = daysOf(operation, saved.new);
  if (!days) return null;
  const box = operation === "weekly_reply" ? "plan" : "changes";
  const notes = saved.repairs ?? "";
  const failures = matches(notes, new RegExp(`(?:^|; )${box} (${DATE}) not filed: (${REASON})`, "g")).map((m) => ({
    date: m[1]!,
    reason: m[2]! as PlanLineFailureReason,
  }));
  const droppedLines = matches(notes, new RegExp(`(?:^|; )${box} line for (${DATE}) dropped: (${REASON})`, "g")).map((m) => ({
    date: m[1]!,
    reason: m[2]! as PlanLineFailureReason,
  }));
  const ignoredLines = matches(notes, new RegExp(`(?:^|; )${box} line with no day ignored: `, "g")).length;
  const fix = saved.timing?.attempts?.find((a) => a.request?.kind === "fix_lines");
  const fixNotes = fix?.repairs ?? "";
  const fixedByRetry =
    fix?.request?.fixed ?? matches(fixNotes, new RegExp(`(?:^|; )${box} (${DATE}) filed by the retry`, "g")).map((m) => m[1]!);
  return {
    box,
    daysTotal: days.length,
    daysParsed: days.filter((d) => d.parsed !== false).length,
    failures,
    retried: Boolean(fix),
    retryAskedFor: fix?.request?.fixDates ?? [],
    fixedByRetry,
    bareNumbers: failures.filter((f) => f.reason === "no distance unit").length,
    droppedLines,
    ignoredLines,
  };
}

/**
 * Whether a stored reply carries the plan-as-text form: a day with a `line` or
 * a `parsed` flag. Old runs (nested day objects) have neither.
 */
export function carriesPlanLines(operation: Operation, reply: unknown): boolean {
  const days = daysOf(operation, reply) ?? [];
  return days.some((d) => d && typeof d === "object" && ("parsed" in d || "line" in d));
}
