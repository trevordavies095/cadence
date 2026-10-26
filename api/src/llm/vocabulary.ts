/**
 * Terms the athlete must never read on screen (see CONTEXT.md, "Never on screen").
 * Matched as whole words, case-insensitive. Shared by tests that guard
 * system-written coach text.
 */
export const ATHLETE_BANNED_TERMS = [
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
  "AI Coach",
] as const;

/** The coach is only ever "Coach Cade"; a bare "Cade" is banned. */
const BARE_CADE = /(?<!Coach )\bCade\b/;

/** Week ids, full (2026-W43) or short (W43, W43's, W42–W43): weeks are shown as dates. */
const WEEK_LABEL = /(?<![\w-])(?:\d{4}-)?W\d{1,2}(?![\d])/;

export function bannedTermsIn(text: string): string[] {
  const found: string[] = ATHLETE_BANNED_TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`, "i").test(text);
  });
  if (BARE_CADE.test(text)) found.push("Cade");
  if (WEEK_LABEL.test(text)) found.push("week label");
  return found;
}
