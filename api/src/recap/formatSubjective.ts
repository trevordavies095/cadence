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
  if (fields.pain !== undefined && fields.pain.trim()) {
    parts.push(`Pain: ${fields.pain.trim()}`);
  }
  return parts.length > 0 ? parts.join("  ·  ") : undefined;
}

export function buildSubjectiveRecapMarkdown(
  weekly: SubjectiveWeeklyMeta | undefined,
): string {
  if (!weekly) return "";
  const lines: string[] = [];
  lines.push("## Subjective recap");
  lines.push("");

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

  const ss = weekly.strength_sessions;
  if (ss !== undefined) {
    const c = ss.completed;
    const p = ss.planned;
    if (c !== undefined && p !== undefined) {
      let s = `Strength sessions completed: ${c} of ${p}`;
      const notes = ss.notes?.trim();
      if (notes) {
        // Notes already wrapped in parentheses ("(None planned.)") are not wrapped again.
        s += /^\(.*\)$/s.test(notes) ? ` ${notes}` : ` (${notes})`;
      }
      lines.push(s);
      lines.push("");
    }
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
