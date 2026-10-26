/**
 * Terms the athlete must never read on screen. Source of truth: the
 * "Never on screen" list in CONTEXT.md. Matching is on whole words, case-insensitive.
 */
export const BANNED_TERMS = [
  "dossier",
  "proposal",
  "soft-gate",
  "dirty",
  "artifact",
  "packet",
  "prescribed",
  "recap",
  "subjective",
  "ISO",
  "week session",
  "archived",
  "stub",
  "installed",
  "phase",
  "stepper",
  "mid-week",
  "interview",
  "prompt",
  "RPE",
  "data-only",
  "regenerate",
  "409",
];

export function bannedTermsIn(text: string): string[] {
  return BANNED_TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`, "i").test(text);
  });
}
