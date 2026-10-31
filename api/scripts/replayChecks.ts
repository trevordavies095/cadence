/**
 * The replay report's goal checks (coaching-bias ticket 24). Each one points at
 * a replayed weekly read that a person should look at first; the replay script
 * exits non-zero when any of them fails. Pure.
 */
import type { TrainingGoal } from "../src/goal/types.js";

export type ReplayCheckInput = {
  /** What the report calls this read, such as "02 (10k-week-3.json)". */
  label: string;
  /** The goal in the packet that was replayed. */
  goal: TrainingGoal | null;
  /** The weekly user prompt rebuilt from that packet. */
  prompt: string;
  /** Every athlete-facing word of the new reply. */
  readText: string;
};

export type ReplayCheckFailure = { label: string; check: string; detail: string };

export const GOAL_LINE_PREFIX = "Athlete goal:";

/** "marathon" as its own word; "half marathon" does not count. */
export function mentionsMarathon(text: string): boolean {
  return /\bmarathons?\b/i.test(text.replace(/\bhalf[\s-]+marathons?\b/gi, ""));
}

const VERDICT_WORDS =
  /\b(?:improving|improved|declining|declined|progressing|progressed|progression|on track|behind schedule|ahead of schedule|growing|grew|shrinking|shrank)\b/i;

/**
 * A verdict on the long run: the fast-finish line, or a sentence that calls a
 * long run (or its distance) improving, declining, on track and the like.
 * Returns the matching words, or null.
 */
export function longRunVerdictIn(text: string): string | null {
  const fast = /\bfast[\s-]finish\b/i.exec(text);
  if (fast) return fast[0];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\blong(?:est)?[\s-]runs?\b/i.test(sentence) && VERDICT_WORDS.test(sentence)) {
      return sentence.trim();
    }
  }
  return null;
}

/** The three goal checks for one replayed read. */
export function replayCheckFailures(input: ReplayCheckInput): ReplayCheckFailure[] {
  const { label, goal, prompt, readText } = input;
  const failures: ReplayCheckFailure[] = [];
  if (!goal || !prompt.startsWith(GOAL_LINE_PREFIX)) {
    failures.push({
      label,
      check: "no goal line",
      detail: goal
        ? `the prompt opens with "${prompt.split("\n", 1)[0]}"`
        : "the packet has no goal",
    });
  }
  if (goal && goal.distance !== "marathon" && mentionsMarathon(readText)) {
    failures.push({
      label,
      check: "marathon in a non-marathon read",
      detail: `the goal is ${goal.kind}${goal.distance ? ` (${goal.distance})` : ""}`,
    });
  }
  if (goal?.kind === "fitness") {
    const verdict = longRunVerdictIn(readText);
    if (verdict) {
      failures.push({ label, check: "long-run verdict for stay fit", detail: `"${verdict}"` });
    }
  }
  return failures;
}
