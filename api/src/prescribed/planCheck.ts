/**
 * The plan check (GitHub issue #58): after a weekly reply is validated and
 * before its plan is stored or shown, Cadence checks the plan against what the
 * packet says about the athlete's recent training and attaches warnings. It
 * never changes the plan. It runs on every provider and model, because the
 * protection has to live in Cadence: on the demo athlete's Achilles week every
 * model's plan passed every check Cadence had, and one of them planned a
 * goal-pace session and a longer long run for a runner who asked whether to
 * stop.
 *
 * Pure: a function of the packet and the reply's plan, so the replay harness
 * (scripts/replayPlanRules.ts), which has only those, runs the same check on
 * saved replies. Each warning is one rule tripped, carried as a notice in
 * Coach Cade's voice (the title and body are what the athlete reads; the
 * rule name never is) and stored beside the plan. A rule that cannot be judged
 * because the packet lacks the text it needs is recorded as skipped, so
 * silence is told apart from a pass.
 *
 * The four rules, in the order their notices are shown:
 * 1. volume jump: planned weekly distance more than a third above the recent
 *    weekly average (the report's Distance row, leaving out the weeks before
 *    a new athlete started; skipped in their first week).
 * 2. long-run jump: the largest planned run (not the race) more than a
 *    quarter above the longest run of the recent weeks (the report's
 *    long-run trend line).
 * 3. quality with pain: a quality or race day in a week whose report, check-in,
 *    questions or conversation report pain (the pain words shared with the
 *    stub's red-flag notice, src/llm/safety.ts, plus "should I stop").
 * 4. return from injury: the goal, or About you, says the athlete is
 *    returning from injury, and the plan has a quality or race day, or a long
 *    run above the recent longest.
 *
 * Judgement calls, 2026-11-02:
 * - A pain score of 0 with no pain words is not pain; "Pain: 0/10 (a niggle)"
 *   is, since the athlete wrote a pain word.
 * - About you says the athlete is returning only when a line pairs a return
 *   phrase ("returning", "coming back", "back to running") with a pain word,
 *   or says "post-injury": an injury in the history alone ("You had shin
 *   splints in your first block") does not make every later plan a return.
 * - "hurt" is not a pain word: the list is the stub's, grown only by decision.
 *
 * Thresholds are named constants; nothing is tuned here (the coach's answers
 * tune them later, .scratch/coaching-quality/spec.md).
 */
import { formatDayShort } from "../clock/weekRangeShort.js";
import { cutAtSentence, PAIN_WORDS } from "../llm/safety.js";
import type { PrescribedDay, PrescribedWeek } from "../llm/types.js";
import { packetUnit } from "../llm/weeklyContext.js";
import { longestRecentRunM, runningWeeksAverageM } from "../packet/recentTraining.js";
import type { ModelPacket } from "../packet/types.js";
import type { TempoUnitPreference } from "../tempo/port.js";

/** The rules, in the order their notices are shown. */
export type PlanRule = "volume jump" | "long-run jump" | "quality with pain" | "return from injury";

/** The fixed list of rules, in order; the analysis tables list them this way. */
export const PLAN_RULES = [
  "volume jump",
  "long-run jump",
  "quality with pain",
  "return from injury",
] as const satisfies readonly PlanRule[];

// Fails to compile when a rule is added that this list does not name.
type UnlistedRule = Exclude<PlanRule, (typeof PLAN_RULES)[number]>;
const everyRuleListed: UnlistedRule extends never ? true : never = true;
void everyRuleListed;

/** Why a rule was not judged: the text it needs is not in the packet, or (volume) the athlete has no running before this week. */
export type PlanRuleSkipReason = "no recent distance" | "first week: no running before" | "no recent long run";

/** A rule tripped, as the athlete reads it: a notice titled by the warning. */
export type PlanWarning = {
  rule: PlanRule;
  /** The notice's title, in Coach Cade's voice. */
  title: string;
  /** The notice's body: what was seen, in the athlete's unit, and what to do. */
  body: string;
  /** The figures behind the warning, in metres, for the log and the analysis. */
  figures?: Record<string, number>;
};

export type PlanRuleSkip = { rule: PlanRule; reason: PlanRuleSkipReason };

export type PlanCheckResult = {
  /** One per rule tripped, in rule order. */
  warnings: PlanWarning[];
  /** The rules that could not be judged, and why. */
  skipped: PlanRuleSkip[];
};

/** A plan more than a third above the recent weekly average is a volume jump. */
export const VOLUME_JUMP_RATIO = 1 + 1 / 3;
/** A long run more than a quarter above the longest recent run is a long-run jump. */
export const LONG_RUN_JUMP_RATIO = 1.25;
/** For a returning athlete, a long run above the longest recent run, with no margin. */
export const RETURN_LONG_RUN_RATIO = 1;

/** The most of a pain report quoted in a notice. */
const QUOTE_MAX = 120;

const METRES_PER_MILE = 1609.344;

/** A distance as the notice says it: whole units, the athlete's. */
export function wholeDistance(metres: number, unit: TempoUnitPreference): string {
  return unit === "metric"
    ? `${Math.round(metres / 1000)} km`
    : `${Math.round(metres / METRES_PER_MILE)} mi`;
}

/** The days Cadence filed that carry a run with a distance. */
function filedRuns(plan: PrescribedWeek): Array<PrescribedDay & { run: NonNullable<PrescribedDay["run"]> }> {
  return plan.days.filter(
    (d): d is PrescribedDay & { run: NonNullable<PrescribedDay["run"]> } => d.parsed !== false && d.run != null,
  );
}

/** The sum of the planned run distances over the days Cadence filed; a duration-only run counts as 0. */
export function plannedWeeklyDistanceM(plan: PrescribedWeek): number {
  return filedRuns(plan).reduce((sum, d) => sum + d.run.distanceM, 0);
}

/**
 * The largest planned run of any day type but race; null when no filed day has
 * a run with a distance. The race is the goal, not a training step: a plan
 * that files the marathon is not a long-run jump (every model's race-week plan
 * tripped this in the 2026-11-03 baseline).
 */
export function plannedLongRun(plan: PrescribedWeek): { date: string; distanceM: number } | null {
  let longest: { date: string; distanceM: number } | null = null;
  for (const d of filedRuns(plan)) {
    if (d.dayType === "race") continue;
    if (d.run.distanceM > 0 && (!longest || d.run.distanceM > longest.distanceM)) {
      longest = { date: d.date, distanceM: d.run.distanceM };
    }
  }
  return longest;
}

/** The filed days that are hard running: quality or race. */
function hardDays(plan: PrescribedWeek): PrescribedDay[] {
  return plan.days.filter((d) => d.parsed !== false && (d.dayType === "quality" || d.dayType === "race"));
}

/** "Thu Sep 17", "Tue Sep 15 and Thu Sep 17", "Tue Sep 15, Thu Sep 17 and Sat Sep 19". */
function dayList(dates: string[]): string {
  const names = dates.map(formatDayShort);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ---- Pain reports ---------------------------------------------------------------

const PAIN_WORD_RE = new RegExp(`\\b(${PAIN_WORDS.join("|")})\\b|\\bshould I stop\\b`, "i");

/** A pain value that says there was none: "0", "0/10", "none", "no pain", "n/a". */
const NO_PAIN_RE = /^(0(\s*(\/|out of)\s*10)?|none|no|no pain|n\/a)\.?$/i;

/** Where a pain report was found, for the notice's first clause. */
export type PainReport = {
  /** "run" for a run's pain or notes line, "check-in" for the check-in section, "question", or "message". */
  source: "run" | "check-in" | "question" | "message";
  /** The day the run was on, as the report heads it ("Thu Sep 10"); null when not tied to a day. */
  day: string | null;
  /** What the athlete wrote, as found. */
  text: string;
};

/** Whether a "Pain:" value reports pain: a score above 0, a pain word, or any value that is not "none". */
function painValueReports(value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  const score = /^(?:highest\s+)?(\d+)\s*\/\s*10\b(.*)$/i.exec(v);
  if (score) return Number(score[1]) > 0 || PAIN_WORD_RE.test(score[2] ?? "");
  return !NO_PAIN_RE.test(v);
}

/** The text under a level-2 heading of the report; null when absent. */
function section(md: string, heading: RegExp): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l.replace(/^##\s+/, "")));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/**
 * Every pain report in the week: the report's run-by-run lines ("Pain: ..."
 * and the notes from the running log), its check-in section, the athlete's
 * questions, and the athlete's messages in the conversation. Older weeks are
 * not read: the rule is about this week.
 */
export function painReports(packet: ModelPacket): PainReport[] {
  const out: PainReport[] = [];
  const md = packet.recapMarkdown ?? "";

  const runs = section(md, /^run-by-run/i);
  if (runs) {
    let day: string | null = null;
    for (const line of runs.split("\n")) {
      const heading = /^###\s+(.+)$/.exec(line);
      if (heading) {
        day = heading[1]!.split(/\s+[—–-]\s+/)[0]!.trim();
        continue;
      }
      const pain = /\bPain:\s*(.+)$/.exec(line);
      if (pain && painValueReports(pain[1]!)) {
        out.push({ source: "run", day, text: pain[1]!.trim() });
        continue;
      }
      const notes = /^Notes \(from app\):\s*"?(.*?)"?\s*$/.exec(line);
      if (notes && PAIN_WORD_RE.test(notes[1]!)) out.push({ source: "run", day, text: notes[1]! });
    }
  }

  const checkIn = section(md, /^subjective/i);
  if (checkIn) {
    for (const line of checkIn.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      const pain = /^Pain:\s*(.+)$/.exec(text);
      if (pain ? painValueReports(pain[1]!) : PAIN_WORD_RE.test(text)) {
        out.push({ source: "check-in", day: null, text });
      }
    }
  }

  const questions = section(md, /^questions/i);
  if (questions) {
    for (const line of questions.split("\n")) {
      const q = /^\s*\d+\.\s+(.*\S)\s*$/.exec(line);
      if (q && PAIN_WORD_RE.test(q[1]!)) out.push({ source: "question", day: null, text: q[1]! });
    }
  }

  for (const m of packet.thread ?? []) {
    if (m.role === "athlete" && PAIN_WORD_RE.test(m.body)) {
      out.push({ source: "message", day: null, text: m.body.trim() });
    }
  }
  return out;
}

/** The first clause of the pain notice: what Coach Cade saw, quoted short; the sentence's own stop follows the quote. */
function painSeen(report: PainReport): string {
  const quote = cutAtSentence(report.text.replace(/\s+/g, " ").trim(), QUOTE_MAX).replace(/[.!?]+$/, "");
  switch (report.source) {
    case "run":
      return report.day ? `You reported pain on ${report.day}: "${quote}"` : `You reported pain this week: "${quote}"`;
    case "check-in":
      return `Your check-in said "${quote}"`;
    case "question":
      return `You asked "${quote}"`;
    case "message":
      return `You said "${quote}"`;
  }
}

// ---- Returning from injury -----------------------------------------------------

const RETURN_PHRASE_RE = /\b(returning|coming back|return to running|back to running|getting back)\b/i;
const POST_INJURY_RE = /\bpost-injury\b/i;

/** Whether the goal or About you says the athlete is returning from injury. */
export function isReturningFromInjury(packet: ModelPacket): boolean {
  if (packet.goal?.kind === "return") return true;
  const body = packet.dossier?.body ?? "";
  return body.split("\n").some((line) => POST_INJURY_RE.test(line) || (RETURN_PHRASE_RE.test(line) && PAIN_WORD_RE.test(line)));
}

// ---- The rules --------------------------------------------------------------------

type Rule = (packet: ModelPacket, plan: PrescribedWeek, unit: TempoUnitPreference, out: PlanCheckResult) => void;

const volumeJump: Rule = (packet, plan, unit, out) => {
  const recentM = runningWeeksAverageM(packet);
  if (recentM == null) {
    out.skipped.push({ rule: "volume jump", reason: "no recent distance" });
    return;
  }
  if (recentM === "no running before") {
    out.skipped.push({ rule: "volume jump", reason: "first week: no running before" });
    return;
  }
  const plannedM = plannedWeeklyDistanceM(plan);
  if (plannedM <= recentM * VOLUME_JUMP_RATIO) return;
  out.warnings.push({
    rule: "volume jump",
    title: "A big step up in distance",
    body:
      `This plan is ${wholeDistance(plannedM, unit)} against your recent ${wholeDistance(recentM, unit)} a week. ` +
      "Ease into it, or ask me to adjust.",
    figures: { plannedM: Math.round(plannedM), recentM: Math.round(recentM) },
  });
};

const longRunJump: Rule = (packet, plan, unit, out) => {
  const longestM = longestRecentRunM(packet);
  if (longestM == null) {
    out.skipped.push({ rule: "long-run jump", reason: "no recent long run" });
    return;
  }
  const planned = plannedLongRun(plan);
  if (!planned || planned.distanceM <= longestM * LONG_RUN_JUMP_RATIO) return;
  out.warnings.push({
    rule: "long-run jump",
    title: "The long run is a big jump",
    body:
      `The ${wholeDistance(planned.distanceM, unit)} on ${formatDayShort(planned.date)} is well above your longest recent run of ${wholeDistance(longestM, unit)}. ` +
      "Build to it over a few weeks, or ask me to adjust.",
    figures: { plannedLongM: Math.round(planned.distanceM), longestRecentM: Math.round(longestM) },
  });
};

const qualityWithPain: Rule = (packet, plan, _unit, out) => {
  const hard = hardDays(plan);
  if (hard.length === 0) return;
  const reports = painReports(packet);
  if (reports.length === 0) return;
  out.warnings.push({
    rule: "quality with pain",
    title: "Hard running after a week with pain",
    body:
      `${painSeen(reports[0]!)}. This plan still has hard running on ${dayList(hard.map((d) => d.date))}. ` +
      "Keep it easy until it settles, or ask me to adjust.",
    figures: { painReports: reports.length, hardDays: hard.length },
  });
};

const returnFromInjury: Rule = (packet, plan, unit, out) => {
  if (!isReturningFromInjury(packet)) return;
  const hard = hardDays(plan);
  const longestM = longestRecentRunM(packet);
  const planned = plannedLongRun(plan);
  const longRunAbove = longestM != null && planned != null && planned.distanceM > longestM * RETURN_LONG_RUN_RATIO;
  if (hard.length === 0 && longestM == null) {
    out.skipped.push({ rule: "return from injury", reason: "no recent long run" });
    return;
  }
  if (hard.length === 0 && !longRunAbove) return;
  const clauses: string[] = [];
  if (hard.length > 0) clauses.push(`this plan has hard running on ${dayList(hard.map((d) => d.date))}`);
  if (longRunAbove) {
    clauses.push(
      `the ${wholeDistance(planned!.distanceM, unit)} on ${formatDayShort(planned!.date)} is above your longest recent run of ${wholeDistance(longestM!, unit)}`,
    );
  }
  const figures: Record<string, number> = { hardDays: hard.length };
  if (planned) figures.plannedLongM = Math.round(planned.distanceM);
  if (longestM != null) figures.longestRecentM = Math.round(longestM);
  out.warnings.push({
    rule: "return from injury",
    title: "This plan may rush your return",
    body: `You are coming back from injury, and ${clauses.join(", and ")}. Keep it easy a while longer, or ask me to adjust.`,
    figures,
  });
};

const RULES: ReadonlyArray<Rule> = [volumeJump, longRunJump, qualityWithPain, returnFromInjury];

/**
 * Checks a validated weekly reply's plan against the packet it was written
 * from. The plan is read, never changed.
 */
export function checkPlan(packet: ModelPacket, plan: PrescribedWeek): PlanCheckResult {
  const out: PlanCheckResult = { warnings: [], skipped: [] };
  const unit = packetUnit(packet);
  for (const rule of RULES) rule(packet, plan, unit, out);
  return out;
}

/** The names of the rules a check tripped, in rule order, for the call log. */
export function rulesTripped(result: PlanCheckResult): PlanRule[] {
  return result.warnings.map((w) => w.rule);
}
