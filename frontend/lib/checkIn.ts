import type {
  NeedsSubjectiveRun,
  SubjectiveAnswers,
  SubjectiveRunRow,
  UnitPreference,
} from "./api";
import { distanceLabel } from "./units";

type Weekly = NonNullable<SubjectiveAnswers["weekly"]>;

export const STRESS_WORDS = ["Very low", "Low", "Moderate", "High", "Very high"] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon Oct 19" from a calendar date. Pure calendar arithmetic, so no time zone can move it. */
export function dayLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "Easy Run" and "easy" both read as "Easy run"; no type at all reads as "Run". */
export function runTypeLabel(runType: string | null): string {
  const t = runType?.trim().toLowerCase();
  if (!t) return "Run";
  const withRun = /\brun\b/.test(t) ? t : `${t} run`;
  return withRun.charAt(0).toUpperCase() + withRun.slice(1);
}

/** "Mon Oct 19 · Easy run · 3.0 mi · 36 min". */
export function runTitle(run: NeedsSubjectiveRun, unit: UnitPreference): string {
  const parts = [
    run.date ? dayLabel(run.date) : null,
    runTypeLabel(run.runType),
    run.distanceM != null ? distanceLabel(run.distanceM, unit) : null,
    run.durationS != null ? `${Math.max(1, Math.round(run.durationS / 60))} min` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** A run typed Race in the running log (Tempo's label, case-sensitive). */
export function isRaceRun(run: { runType: string | null }): boolean {
  return run.runType?.trim() === "Race";
}

/** The second run question: a race is asked against its target, and answered in words. */
export const RACE_RESULT_QUESTION = "How did it go against your target?";

/** "Race result" for the check-in card, with the day when the week had more than one race. */
export function raceResultLines(answers: SubjectiveAnswers | null): Array<[string, string]> {
  const results = (answers?.runs ?? []).filter((r) => r.result?.trim());
  return results.map((r) => [
    results.length > 1 ? `Race result, ${dayLabel(r.date)}` : "Race result",
    r.result!.trim(),
  ]);
}

function emptyToUndefined<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Change one run's answers; a row with nothing in it is dropped. */
export function withRunAnswer(
  answers: SubjectiveAnswers,
  date: string,
  patch: Partial<Omit<SubjectiveRunRow, "date">>,
): SubjectiveAnswers {
  const existing = answers.runs.find((r) => r.date === date) ?? { date };
  const row: SubjectiveRunRow = { ...existing, ...patch };
  for (const key of ["rpe", "felt", "pain", "pain_score", "result"] as const) {
    if (row[key] === undefined || row[key] === "") delete row[key];
  }
  const others = answers.runs.filter((r) => r.date !== date);
  const runs = Object.keys(row).length > 1 ? [...others, row] : others;
  return { ...answers, runs: runs.sort((a, b) => a.date.localeCompare(b.date)) };
}

/** Change weekly answers; undefined removes an answer. */
export function withWeeklyAnswer(
  answers: SubjectiveAnswers,
  patch: { [K in keyof Weekly]?: Weekly[K] | undefined },
): SubjectiveAnswers {
  const weekly: Weekly = { ...(answers.weekly ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") delete (weekly as Record<string, unknown>)[key];
    else (weekly as Record<string, unknown>)[key] = value;
  }
  return { ...answers, weekly: emptyToUndefined(weekly) };
}

/**
 * What goes to the coach: the athlete's own answers, plus the effort the watch
 * recorded for any run they did not rate themselves.
 */
export function finalizeAnswers(
  answers: SubjectiveAnswers,
  runs: NeedsSubjectiveRun[],
): SubjectiveAnswers {
  let next = answers;
  for (const run of runs) {
    if (!run.date || run.apiRpe == null) continue;
    const mine = next.runs.find((r) => r.date === run.date);
    if (mine?.rpe === undefined) next = withRunAnswer(next, run.date, { rpe: run.apiRpe });
  }
  return next;
}

type Strength = NonNullable<Weekly["strength_sessions"]>;

/** The strength question covers rehab and cross-training too: Tempo only logs runs. */
export const STRENGTH_LABEL = "Strength, rehab or cross-training";

/** Change the strength answer; blank parts are dropped, and an empty answer is removed. */
export function withStrengthAnswer(
  answers: SubjectiveAnswers,
  patch: { [K in keyof Strength]?: Strength[K] | undefined },
): SubjectiveAnswers {
  const strength: Strength = { ...(answers.weekly?.strength_sessions ?? {}), ...patch };
  if (strength.completed === undefined) delete strength.completed;
  if (strength.planned === undefined) delete strength.planned;
  if (!strength.notes?.trim()) delete strength.notes;
  return withWeeklyAnswer(answers, { strength_sessions: emptyToUndefined(strength) });
}

/** "2 sessions", or "2 of 3 planned", with any notes after. Null when there is nothing. */
export function strengthText(s: Strength | undefined): string | null {
  if (!s) return null;
  const count =
    s.completed != null && s.planned != null
      ? `${s.completed} of ${s.planned} planned`
      : s.completed != null
        ? `${s.completed} ${s.completed === 1 ? "session" : "sessions"}`
        : s.planned != null
          ? `${s.planned} planned`
          : null;
  const text = [count, s.notes?.trim() || null].filter(Boolean).join(" · ");
  return text || null;
}

export type SummaryRow = {
  /** Index into the steps, so "Change" can go straight there. */
  step: number;
  label: string;
  /** What the athlete said, in words; null when they left it blank. */
  answer: string | null;
};

const outOf10 = (n: number) => `${n} of 10`;

/** One row per question for the screen before Finish. Blank answers stay visible as blank. */
export function summaryRows(
  answers: SubjectiveAnswers,
  runs: (NeedsSubjectiveRun & { date: string })[],
  unit: UnitPreference,
): SummaryRow[] {
  const rows: SummaryRow[] = runs.map((run, step) => {
    const row = answers.runs.find((r) => r.date === run.date);
    const parts: string[] = [];
    if (row?.rpe !== undefined) parts.push(`Effort ${outOf10(row.rpe)}`);
    else if (run.apiRpe != null) parts.push(`Effort ${outOf10(run.apiRpe)} from your watch`);
    if (row?.felt !== undefined) parts.push(`Went ${outOf10(row.felt)}`);
    if (row?.result) parts.push(`Result: ${row.result}`);
    if (row?.pain_score !== undefined) {
      parts.push(`Pain ${outOf10(row.pain_score)}${row.pain ? ` (${row.pain})` : ""}`);
    } else if (row?.pain) parts.push(`Pain: ${row.pain}`);
    const answered = row !== undefined;
    return {
      step,
      label: runTitle(run, unit),
      answer: parts.length > 0 && (answered || run.apiRpe != null) ? parts.join(" · ") : null,
    };
  });
  const w = answers.weekly ?? {};
  const weekly: [string, string | null][] = [
    ["Sleep", w.sleep_avg_hrs !== undefined ? `${w.sleep_avg_hrs.toFixed(1)} hours a night` : null],
    ["Stress", w.stress_level ?? null],
    [STRENGTH_LABEL, strengthText(w.strength_sessions)],
    ["Your body", w.body_check ?? null],
    ["Next week", w.feeling_into_next_week ?? null],
    ["For Coach Cade", w.questions_for_coach?.[0] ?? null],
  ];
  weekly.forEach(([label, answer], i) => rows.push({ step: runs.length + i, label, answer }));
  return rows;
}

/** One run's pain for Your week: "3/10 (Tight left calf)", the score or the words alone, or null. */
export function painText(row: SubjectiveRunRow | undefined): string | null {
  const words = row?.pain?.trim() || null;
  if (row?.pain_score === undefined) return words;
  return words ? `${row.pain_score}/10 (${words})` : `${row.pain_score}/10`;
}

/** "Highest 3/10 (Thu)": the week's highest pain score and each day that reached it. Null when none. */
export function painHighestText(runs: SubjectiveRunRow[]): string | null {
  const scored = runs.filter((r) => r.pain_score !== undefined);
  if (scored.length === 0) return null;
  const highest = Math.max(...scored.map((r) => r.pain_score as number));
  const days = scored
    .filter((r) => r.pain_score === highest)
    .map((r) => r.date)
    .sort()
    .map((date) => dayLabel(date).split(" ")[0]);
  return `Highest ${highest}/10 (${days.join(", ")})`;
}
