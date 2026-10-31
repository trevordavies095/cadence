/**
 * Subjective markdown sections (§ Subjective recap / Questions for coach).
 * Shape aligned to tempo-cli weekly-recap builders — not a vendored copy.
 */

import type {
  SubjectiveAnswers,
  SubjectiveRunRow,
  SubjectiveWeeklyMeta,
} from "./subjectiveQuestionnaire.js";
import type { NeedsSubjectiveRun } from "./subjectiveRuns.js";

export type SubjectiveRunFields = {
  rpe?: number;
  felt?: number;
  pain?: string;
  pain_score?: number;
};

/** Last row wins when duplicate dates appear. */
export function subjectiveRunsToDateMap(
  runs: readonly SubjectiveRunRow[],
): Map<string, SubjectiveRunFields> {
  const m = new Map<string, SubjectiveRunFields>();
  for (const r of runs) {
    const bits: SubjectiveRunFields = {};
    if (r.rpe !== undefined) bits.rpe = r.rpe;
    if (r.felt !== undefined) bits.felt = r.felt;
    if (r.pain !== undefined) bits.pain = r.pain;
    if (r.pain_score !== undefined) bits.pain_score = r.pain_score;
    m.set(r.date, bits);
  }
  return m;
}

export function formatSubjectiveRunLine(
  fields: SubjectiveRunFields,
): string | undefined {
  const parts: string[] = [];
  if (fields.rpe !== undefined) parts.push(`RPE: ${fields.rpe}/10`);
  if (fields.felt !== undefined) parts.push(`Felt: ${fields.felt}/10`);
  const painText = fields.pain?.trim();
  if (fields.pain_score !== undefined) {
    parts.push(
      `Pain: ${fields.pain_score}/10${painText ? ` (${painText})` : ""}`,
    );
  } else if (painText) {
    parts.push(`Pain: ${painText}`);
  }
  return parts.length > 0 ? parts.join("  ·  ") : undefined;
}

/**
 * "Strength, rehab or cross-training: 2 sessions", or "2 of 3 planned" when a
 * planned count was given, with any notes. Any one part is enough for a line.
 */
function formatStrengthLine(
  ss: SubjectiveWeeklyMeta["strength_sessions"],
): string | undefined {
  if (!ss) return undefined;
  const c = ss.completed;
  const p = ss.planned;
  const notes = ss.notes?.trim();
  const count =
    c !== undefined && p !== undefined
      ? `${c} of ${p} planned`
      : c !== undefined
        ? `${c} ${c === 1 ? "session" : "sessions"}`
        : p !== undefined
          ? `${p} planned`
          : undefined;
  let body: string;
  if (count && notes) {
    // Notes already wrapped in parentheses ("(None planned.)") are not wrapped again.
    body = /^\(.*\)$/s.test(notes) ? `${count} ${notes}` : `${count} (${notes})`;
  } else if (count) {
    body = count;
  } else if (notes) {
    body = notes;
  } else {
    return undefined;
  }
  return `Strength, rehab or cross-training: ${body}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Thu" from YYYY-MM-DD; calendar arithmetic only, so no time zone moves it. */
function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/**
 * "Pain: highest 3/10 (Thu)": the week's highest pain score and every day that
 * reached it. Undefined when no run has a score.
 */
export function formatPainHighLine(
  runs: readonly SubjectiveRunRow[],
): string | undefined {
  const scored = runs.filter(
    (r): r is SubjectiveRunRow & { pain_score: number } =>
      r.pain_score !== undefined,
  );
  if (scored.length === 0) return undefined;
  const highest = Math.max(...scored.map((r) => r.pain_score));
  const days = scored
    .filter((r) => r.pain_score === highest)
    .map((r) => r.date)
    .sort()
    .map(weekdayOf);
  return `Pain: highest ${highest}/10 (${days.join(", ")})`;
}

export function buildSubjectiveRecapMarkdown(
  weekly: SubjectiveWeeklyMeta | undefined,
  runs: readonly SubjectiveRunRow[] = [],
): string {
  const painHigh = formatPainHighLine(runs);
  if (!weekly && !painHigh) return "";
  weekly ??= {};
  const lines: string[] = [];
  lines.push("## Subjective recap");
  lines.push("");

  if (painHigh) {
    lines.push(painHigh);
    lines.push("");
  }

  const range =
    weekly.sleep_range_hrs !== undefined && weekly.sleep_range_hrs.length >= 2
      ? weekly.sleep_range_hrs
      : undefined;
  if (weekly.sleep_avg_hrs !== undefined) {
    let sleepLine = `Sleep avg this week: ${weekly.sleep_avg_hrs} hrs`;
    if (range) sleepLine += ` (range ${range[0]}–${range[1]})`;
    lines.push(sleepLine);
    lines.push("");
  } else if (range) {
    // tempo-cli drops the range without an average; keep it, same style.
    lines.push(`Sleep range this week: ${range[0]}–${range[1]} hrs`);
    lines.push("");
  }

  const strength = formatStrengthLine(weekly.strength_sessions);
  if (strength) {
    lines.push(strength);
    lines.push("");
  }

  if (weekly.stress_level?.trim()) {
    lines.push(`Stress level: ${weekly.stress_level.trim()}`);
    lines.push("");
  }

  if (weekly.body_check?.trim()) {
    lines.push(`Body check: ${weekly.body_check.trim()}`);
    lines.push("");
  }

  if (weekly.feeling_into_next_week?.trim()) {
    lines.push(
      `Going into next week feeling: ${weekly.feeling_into_next_week.trim()}`,
    );
    lines.push("");
  }

  const body = lines.join("\n").trimEnd();
  if (body.length <= "## Subjective recap".length + 5) return "";
  return `${body}\n`;
}

export function buildCoachQuestionsMarkdown(
  questions: string[] | undefined,
): string {
  const qs = questions?.filter((q) => q.trim()) ?? [];
  if (qs.length === 0) return "";
  const lines: string[] = ["## Questions for coach", ""];
  qs.forEach((q, i) => lines.push(`${i + 1}. ${q.trim()}`));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * When a run row omits RPE but Tempo provided apiRpe for that calendar date,
 * fill it in (athlete correction still wins when they set rpe explicitly).
 */
export function applyApiRpeDefaults(
  answers: SubjectiveAnswers,
  gateRuns: readonly NeedsSubjectiveRun[],
): SubjectiveAnswers {
  const apiByDate = new Map<string, number>();
  for (const r of gateRuns) {
    if (r.date && typeof r.apiRpe === "number" && Number.isFinite(r.apiRpe)) {
      apiByDate.set(r.date, Math.round(r.apiRpe));
    }
  }
  if (apiByDate.size === 0) return answers;

  let changed = false;
  const runs = answers.runs.map((row) => {
    if (row.rpe !== undefined) return row;
    const api = apiByDate.get(row.date);
    if (api === undefined) return row;
    changed = true;
    return { ...row, rpe: api };
  });

  if (!changed) return answers;
  return { ...answers, runs };
}
