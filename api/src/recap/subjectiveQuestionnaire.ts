import { parseSleepAvgHrs, parseSleepRangeHrs } from "./sleepParse.js";
/**
 * Weekly subjective interview questionnaire (tempo-cli MCP needs_subjective shape).
 * Conversational prompts for the coach thread — all fields optional.
 */

export type SubjectiveQuestionnaire = {
  order: string[];
  per_run: {
    rpe: string;
    felt: string;
    pain: string;
    pain_score: string;
    result: string;
  };
  weekly: {
    sleep_avg_hrs: string;
    sleep_range_hrs: string;
    strength_sessions: string;
    stress_level: string;
    body_check: string;
    feeling_into_next_week: string;
    questions_for_coach: string;
  };
  all_fields_optional: true;
};

export const SUBJECTIVE_QUESTIONNAIRE: SubjectiveQuestionnaire = {
  order: [
    "per_run (RPE, Felt, Pain for each calendar date)",
    "weekly (sleep, strength, stress, body, feeling)",
    "questions_for_coach",
  ],
  per_run: {
    rpe: "Optional integer 1–10. If apiRpe is set on the run, prefer that value and do not re-ask unless the athlete corrects it.",
    felt: "Optional integer 1–10 (how the run felt).",
    pain: "Optional free-text niggles / pain (or omit).",
    pain_score:
      "Optional integer 0–10 (0 is no pain). Asked when the goal is a return to running, beside the free text.",
    result:
      "Optional free text, only for a run typed Race: how it went against the athlete's target (asked instead of felt).",
  },
  weekly: {
    sleep_avg_hrs: "Optional average sleep hours this week.",
    sleep_range_hrs: "Optional [low, high] sleep hours.",
    strength_sessions:
      "Optional { completed, planned, notes } for strength, rehab or cross-training sessions (swimming, cycling, physio exercises).",
    stress_level: "Optional free-text stress level.",
    body_check: "Optional free-text body check.",
    feeling_into_next_week: "Optional free-text outlook.",
    questions_for_coach: "Optional string array of questions for the coach.",
  },
  all_fields_optional: true,
};

export type SubjectiveRunRow = {
  date: string;
  rpe?: number;
  felt?: number;
  pain?: string;
  /** 0 to 10; 0 means no pain. Asked when the goal is a return to running. */
  pain_score?: number;
  /** A Race run's answer to "How did it go against your target?". */
  result?: string;
};

export type SubjectiveStrengthSessions = {
  completed?: number;
  planned?: number;
  notes?: string;
};

export type SubjectiveWeeklyMeta = {
  sleep_avg_hrs?: number;
  sleep_range_hrs?: [number, number];
  strength_sessions?: SubjectiveStrengthSessions;
  stress_level?: string;
  body_check?: string;
  feeling_into_next_week?: string;
  questions_for_coach?: string[];
};

/** Persisted subjective answers for one week session (tempo-cli week doc shape). */
export type SubjectiveAnswers = {
  week: string;
  runs: SubjectiveRunRow[];
  weekly?: SubjectiveWeeklyMeta;
};

function clampRating(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  if (r < 1 || r > 10) return undefined;
  return r;
}

function parseRunRow(
  raw: unknown,
): { ok: true; row: SubjectiveRunRow } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_run_row" };
  }
  const o = raw as Record<string, unknown>;
  const date = typeof o.date === "string" ? o.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "invalid_run_date" };
  }

  const row: SubjectiveRunRow = { date };

  if (o.rpe !== undefined && o.rpe !== null) {
    if (typeof o.rpe !== "number") return { ok: false, error: "invalid_rpe" };
    const rpe = clampRating(o.rpe);
    if (rpe === undefined) return { ok: false, error: "invalid_rpe" };
    row.rpe = rpe;
  }

  if (o.felt !== undefined && o.felt !== null) {
    if (typeof o.felt !== "number") return { ok: false, error: "invalid_felt" };
    const felt = clampRating(o.felt);
    if (felt === undefined) return { ok: false, error: "invalid_felt" };
    row.felt = felt;
  }

  if (o.pain !== undefined && o.pain !== null) {
    if (typeof o.pain !== "string") return { ok: false, error: "invalid_pain" };
    const pain = o.pain.trim();
    if (pain) row.pain = pain;
  }

  if (o.pain_score !== undefined && o.pain_score !== null) {
    if (typeof o.pain_score !== "number" || !Number.isFinite(o.pain_score)) {
      return { ok: false, error: "invalid_pain_score" };
    }
    const score = Math.round(o.pain_score);
    if (score < 0 || score > 10) return { ok: false, error: "invalid_pain_score" };
    row.pain_score = score;
  }

  if (o.result !== undefined && o.result !== null) {
    if (typeof o.result !== "string") {
      return { ok: false, error: "invalid_result" };
    }
    const result = o.result.trim();
    if (result) row.result = result;
  }

  return { ok: true, row };
}

function parseWeekly(
  raw: unknown,
):
  | { ok: true; weekly: SubjectiveWeeklyMeta | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, weekly: undefined };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_weekly" };
  }
  const o = raw as Record<string, unknown>;
  const weekly: SubjectiveWeeklyMeta = {};

  if (o.sleep_avg_hrs !== undefined && o.sleep_avg_hrs !== null) {
    let avg: number | undefined;
    if (typeof o.sleep_avg_hrs === "number") {
      avg = Number.isFinite(o.sleep_avg_hrs) ? o.sleep_avg_hrs : undefined;
    } else if (typeof o.sleep_avg_hrs === "string") {
      // Free text like "8.38 hrs"; blank string means unanswered.
      if (o.sleep_avg_hrs.trim()) avg = parseSleepAvgHrs(o.sleep_avg_hrs);
      else avg = NaN;
    }
    if (avg === undefined) return { ok: false, error: "invalid_sleep_avg_hrs" };
    if (!Number.isNaN(avg)) weekly.sleep_avg_hrs = avg;
  }

  if (o.sleep_range_hrs !== undefined && o.sleep_range_hrs !== null) {
    const r = o.sleep_range_hrs;
    let range: [number, number] | undefined;
    let blank = false;
    if (typeof r === "string") {
      if (r.trim()) range = parseSleepRangeHrs(r);
      else blank = true;
    } else if (Array.isArray(r) && r.length >= 2) {
      const [a, b] = r;
      if (typeof a === "number" && typeof b === "number") {
        if (Number.isFinite(a) && Number.isFinite(b)) range = [a, b];
      } else if (typeof a === "string" && typeof b === "string") {
        range = parseSleepRangeHrs(`${a} ${b}`);
      }
    }
    if (!blank) {
      if (!range) return { ok: false, error: "invalid_sleep_range_hrs" };
      weekly.sleep_range_hrs = range;
    }
  }

  if (o.strength_sessions !== undefined && o.strength_sessions !== null) {
    if (
      typeof o.strength_sessions !== "object" ||
      Array.isArray(o.strength_sessions)
    ) {
      return { ok: false, error: "invalid_strength_sessions" };
    }
    const ss = o.strength_sessions as Record<string, unknown>;
    const strength: SubjectiveStrengthSessions = {};
    if (ss.completed !== undefined && ss.completed !== null) {
      if (typeof ss.completed !== "number" || !Number.isFinite(ss.completed)) {
        return { ok: false, error: "invalid_strength_sessions" };
      }
      strength.completed = Math.round(ss.completed);
    }
    if (ss.planned !== undefined && ss.planned !== null) {
      if (typeof ss.planned !== "number" || !Number.isFinite(ss.planned)) {
        return { ok: false, error: "invalid_strength_sessions" };
      }
      strength.planned = Math.round(ss.planned);
    }
    if (ss.notes !== undefined && ss.notes !== null) {
      if (typeof ss.notes !== "string") {
        return { ok: false, error: "invalid_strength_sessions" };
      }
      const notes = ss.notes.trim();
      if (notes) strength.notes = notes;
    }
    if (Object.keys(strength).length > 0) {
      weekly.strength_sessions = strength;
    }
  }

  if (o.stress_level !== undefined && o.stress_level !== null) {
    if (typeof o.stress_level !== "string") {
      return { ok: false, error: "invalid_stress_level" };
    }
    const v = o.stress_level.trim();
    if (v) weekly.stress_level = v;
  }

  if (o.body_check !== undefined && o.body_check !== null) {
    if (typeof o.body_check !== "string") {
      return { ok: false, error: "invalid_body_check" };
    }
    const v = o.body_check.trim();
    if (v) weekly.body_check = v;
  }

  if (
    o.feeling_into_next_week !== undefined &&
    o.feeling_into_next_week !== null
  ) {
    if (typeof o.feeling_into_next_week !== "string") {
      return { ok: false, error: "invalid_feeling_into_next_week" };
    }
    const v = o.feeling_into_next_week.trim();
    if (v) weekly.feeling_into_next_week = v;
  }

  if (
    o.questions_for_coach !== undefined &&
    o.questions_for_coach !== null
  ) {
    if (!Array.isArray(o.questions_for_coach)) {
      return { ok: false, error: "invalid_questions_for_coach" };
    }
    const qs: string[] = [];
    for (const q of o.questions_for_coach) {
      if (typeof q !== "string") {
        return { ok: false, error: "invalid_questions_for_coach" };
      }
      const t = q.trim();
      if (t) qs.push(t);
    }
    if (qs.length > 0) weekly.questions_for_coach = qs;
  }

  return {
    ok: true,
    weekly: Object.keys(weekly).length > 0 ? weekly : undefined,
  };
}

/**
 * Parse POST body for subjective answers.
 * Accepts `{ week?, runs, weekly? }` or nested `{ answers: { … } }`.
 * `week` defaults to the week session's ISO week when omitted.
 */
export function parseSubjectiveAnswers(
  raw: unknown,
  defaultWeek: string,
):
  | { ok: true; answers: SubjectiveAnswers }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "answers_object_required" };
  }

  let body = raw as Record<string, unknown>;
  if (
    "answers" in body &&
    body.answers !== null &&
    typeof body.answers === "object" &&
    !Array.isArray(body.answers)
  ) {
    body = body.answers as Record<string, unknown>;
  }

  const weekRaw = typeof body.week === "string" ? body.week.trim() : "";
  const week = weekRaw || defaultWeek;
  if (!/^\d{4}-W\d{2}$/.test(week)) {
    return { ok: false, error: "invalid_week" };
  }

  if (!Array.isArray(body.runs)) {
    return { ok: false, error: "runs_array_required" };
  }

  const runs: SubjectiveRunRow[] = [];
  for (const item of body.runs) {
    const parsed = parseRunRow(item);
    if (!parsed.ok) return parsed;
    runs.push(parsed.row);
  }

  // Date-keyed: last write wins for same-day doubles.
  const byDate = new Map<string, SubjectiveRunRow>();
  for (const row of runs) {
    byDate.set(row.date, row);
  }
  const deduped = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const weeklyParsed = parseWeekly(body.weekly);
  if (!weeklyParsed.ok) return weeklyParsed;

  const answers: SubjectiveAnswers = { week, runs: deduped };
  if (weeklyParsed.weekly) answers.weekly = weeklyParsed.weekly;
  return { ok: true, answers };
}
