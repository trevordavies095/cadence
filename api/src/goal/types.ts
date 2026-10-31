/**
 * The training goal: what the athlete is training for, as data.
 * Stored append-only (see store.ts); the latest row is current.
 */

export const GOAL_KINDS = ["race", "speed", "fitness", "return"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const GOAL_DISTANCES = ["5k", "10k", "half", "marathon", "other"] as const;
export type GoalDistance = (typeof GOAL_DISTANCES)[number];

export type GoalSource = "onboarding" | "settings";

/** Calendar date YYYY-MM-DD in the athlete's timezone. */
export type GoalDate = string;

export type TrainingGoal = {
  kind: GoalKind;
  /** Required when kind is race. */
  distance?: GoalDistance;
  raceName?: string;
  raceDate?: GoalDate;
  /** Free text, never parsed. */
  target?: string;
  /** Return only: free text, never parsed. */
  startingPoint?: string;
  /** Return only: when the return started. */
  since?: GoalDate;
};

export type GoalParseResult =
  | { ok: true; goal: TrainingGoal }
  | { ok: false; error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isGoalDate(raw: string): boolean {
  const m = DATE_RE.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

function optionalText(
  raw: unknown,
  error: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, error };
  const value = raw.trim();
  return value ? { ok: true, value } : { ok: true };
}

function optionalDate(
  raw: unknown,
  error: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, error };
  const value = raw.trim();
  if (!value) return { ok: true };
  return isGoalDate(value) ? { ok: true, value } : { ok: false, error };
}

/**
 * Validate an untrusted goal object. Blank optional strings are dropped;
 * unknown fields are ignored.
 */
export function parseTrainingGoal(raw: unknown): GoalParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "goal_object_required" };
  }
  const o = raw as Record<string, unknown>;

  const kind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  if (!(GOAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "invalid_goal_kind" };
  }

  const goal: TrainingGoal = { kind: kind as GoalKind };

  if (o.distance !== undefined && o.distance !== null && o.distance !== "") {
    const distance =
      typeof o.distance === "string" ? o.distance.trim().toLowerCase() : "";
    if (!(GOAL_DISTANCES as readonly string[]).includes(distance)) {
      return { ok: false, error: "invalid_goal_distance" };
    }
    goal.distance = distance as GoalDistance;
  }
  if (goal.kind === "race" && !goal.distance) {
    return { ok: false, error: "goal_distance_required" };
  }

  const fields: Array<
    [keyof TrainingGoal, "text" | "date", string]
  > = [
    ["raceName", "text", "invalid_race_name"],
    ["raceDate", "date", "invalid_race_date"],
    ["target", "text", "invalid_target"],
    ["startingPoint", "text", "invalid_starting_point"],
    ["since", "date", "invalid_since_date"],
  ];
  for (const [key, type, error] of fields) {
    const parsed =
      type === "date" ? optionalDate(o[key], error) : optionalText(o[key], error);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) {
      (goal as Record<string, unknown>)[key] = parsed.value;
    }
  }

  return { ok: true, goal };
}
