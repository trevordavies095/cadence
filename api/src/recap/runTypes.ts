/**
 * Run-type families: the one definition of what a Tempo run type means.
 *
 * Tempo accepts exactly ten run types, case-sensitive. Labels are trusted as
 * the athlete set them: there is no heart-rate or pace gate on a label.
 * Untyped runs (missing, blank, or Tempo's `Unspecified` count key) belong to
 * the easy family. Walk-Run stands alone, as in Tempo's own easy-run heart
 * rate: walk breaks distort easy pace, easy heart rate and drift. Unknown
 * labels belong to no family.
 */

export const RUN_TYPES = [
  "Easy Run",
  "Recovery",
  "Walk-Run",
  "Long Run",
  "Workout",
  "Threshold",
  "Intervals",
  "Hills",
  "Fartlek",
  "Race",
] as const;

export type RunType = (typeof RUN_TYPES)[number];

/** Typed members of the easy family; untyped runs are easy too. */
export const EASY_FAMILY = ["Easy Run", "Recovery"] as const;

export const QUALITY_FAMILY = [
  "Workout",
  "Threshold",
  "Intervals",
  "Hills",
  "Fartlek",
] as const;

/** Tempo's key for untyped runs in its weekly run counts. */
export const UNSPECIFIED_RUN_TYPE = "Unspecified";

export type RunTypeFamily =
  | "easy"
  | "quality"
  | "long"
  | "race"
  | "walk"
  | "other";

/** Trimmed label, or null when the run is untyped. */
function label(runType: unknown): string | null {
  if (runType === undefined || runType === null) return null;
  if (typeof runType !== "string") return "";
  const s = runType.trim();
  return s === "" || s === UNSPECIFIED_RUN_TYPE ? null : s;
}

function isOneOf(runType: unknown, list: readonly string[]): boolean {
  const s = label(runType);
  return s !== null && list.includes(s);
}

/** Easy Run, Recovery, or untyped. Walk-Run is not easy-family. */
export function isEasyFamily(runType: unknown): boolean {
  return label(runType) === null || isOneOf(runType, EASY_FAMILY);
}

/** Workout, Threshold, Intervals, Hills, Fartlek. */
export function isQualityFamily(runType: unknown): boolean {
  return isOneOf(runType, QUALITY_FAMILY);
}

export function isLongRun(runType: unknown): boolean {
  return label(runType) === "Long Run";
}

export function isRace(runType: unknown): boolean {
  return label(runType) === "Race";
}

export function isWalkRun(runType: unknown): boolean {
  return label(runType) === "Walk-Run";
}

/** Which family a run lands in; unknown labels are "other". */
export function runTypeFamily(runType: unknown): RunTypeFamily {
  if (isEasyFamily(runType)) return "easy";
  if (isQualityFamily(runType)) return "quality";
  if (isLongRun(runType)) return "long";
  if (isRace(runType)) return "race";
  if (isWalkRun(runType)) return "walk";
  return "other";
}
