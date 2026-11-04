/**
 * What the plan check (src/prescribed/planCheck.ts, issue #58) makes of a
 * saved weekly reply: the rules its plan tripped and the rules that could not
 * be judged from its packet. The replay (scripts/replay-weekly-reads.ts) saves
 * it in each reply file as `rules`; the analysis (scripts/replay-analysis.ts)
 * derives it the same way for reply files saved before the field existed,
 * from the input's packet, and counts the rules per configuration. Pure: the
 * same function the app runs on Sunday, over the saved packet and reply, so
 * no reply is re-run.
 */
import type { WeeklyReply } from "../src/llm/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import { checkPlan, PLAN_RULES, type PlanRule, type PlanRuleSkip } from "../src/prescribed/planCheck.js";
import type { Operation } from "./replayInputs.js";

export { PLAN_RULES, type PlanRule };

export type PlanRuleSummary = {
  /** The rules the plan tripped, in rule order. */
  tripped: PlanRule[];
  /** The rules that could not be judged, and why. */
  skipped: PlanRuleSkip[];
};

/**
 * A saved reply's rules summary; null for any operation but the weekly read,
 * a refused reply (no stored reply) and a weekly reply with no stored week.
 */
export function planRuleSummary(operation: Operation, packet: ModelPacket, reply: unknown): PlanRuleSummary | null {
  if (operation !== "weekly_reply" || !reply || typeof reply !== "object") return null;
  const week = (reply as Partial<WeeklyReply>).prescribedWeek;
  if (!week || !Array.isArray(week.days)) return null;
  const result = checkPlan(packet, week);
  return { tripped: result.warnings.map((w) => w.rule), skipped: result.skipped };
}
