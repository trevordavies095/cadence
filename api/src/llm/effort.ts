export const ANTHROPIC_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];

export const DEFAULT_ANTHROPIC_EFFORT: AnthropicEffort = "xhigh";

/**
 * Resolve the thinking effort from `ANTHROPIC_EFFORT`. Unset/blank returns the
 * default; an invalid value throws so the API fails at startup.
 */
export function resolveAnthropicEffort(
  env: Record<string, string | undefined> = process.env,
): AnthropicEffort {
  const raw = env.ANTHROPIC_EFFORT?.trim().toLowerCase();
  if (!raw) return DEFAULT_ANTHROPIC_EFFORT;
  if ((ANTHROPIC_EFFORT_LEVELS as readonly string[]).includes(raw)) {
    return raw as AnthropicEffort;
  }
  throw new Error(
    `Invalid ANTHROPIC_EFFORT "${env.ANTHROPIC_EFFORT?.trim()}": expected one of ${ANTHROPIC_EFFORT_LEVELS.join(", ")}.`,
  );
}
