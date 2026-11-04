export const ANTHROPIC_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];

/**
 * Read a thinking effort level, ignoring case and surrounding space. Anything
 * that is not one of the five levels returns null.
 */
export function parseAnthropicEffort(raw: string): AnthropicEffort | null {
  const value = raw.trim().toLowerCase();
  return (ANTHROPIC_EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as AnthropicEffort)
    : null;
}

/**
 * The highest effort at which a model finishes a weekly read inside the coach
 * call's output cap (MAX_OUTPUT_TOKENS in anthropic.ts), from the coaching
 * baseline of 2026-11-03: above it the model thinks until the cap and never
 * writes the reply, so the athlete gets an error every Sunday. Opus 5.5 failed
 * every season week at max; Haiku 5.5 failed at xhigh; Sonnet 5.5 reached the
 * cap once at xhigh, so max is not offered. A model not listed has no ceiling.
 */
export const EFFORT_CEILING: Readonly<Record<string, AnthropicEffort>> = {
  "claude-opus-5-5": "xhigh",
  "claude-sonnet-5-5": "xhigh",
  "claude-haiku-5-5": "high",
};

/** The effort a model is sent with: the one asked for, lowered to the model's ceiling. */
export function effortWithinCeiling(model: string, effort: AnthropicEffort): AnthropicEffort {
  const ceiling = EFFORT_CEILING[model];
  if (!ceiling) return effort;
  return ANTHROPIC_EFFORT_LEVELS.indexOf(effort) > ANTHROPIC_EFFORT_LEVELS.indexOf(ceiling) ? ceiling : effort;
}
