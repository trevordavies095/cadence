/**
 * The rules retry (coaching-quality ticket 11), through the live adapter with
 * a fake model server: with the retry on, a weekly plan that trips a plan rule
 * is sent back once with the warnings as an error tool result (`fix_rules`),
 * and the second plan is kept only when it trips strictly fewer rules. Off by
 * default: one request. Pure: the port alone, no database.
 */
import { describe, expect, it, vi } from "vitest";
import {
  anthropicCoachTarget,
  createAnthropicLlmPort,
  RETRY_FIX_RULES_INSTRUCTION,
  rulesRetryFromEnv,
  type AttemptReport,
} from "../src/llm/index.js";
import type { LlmCallRecord, LlmCallRecorder } from "../src/llmCallLog/index.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { checkPlan, rulesTripped } from "../src/prescribed/planCheck.js";
import { anthropicStreamResponse, anthropicToolMessage } from "./helpers.js";
import { planLines, planLinesWith, weeklyForm } from "./weeklyForms.js";

const PLAN_MONDAY = "2026-10-26";
const URL_ = "http://fake-anthropic.test/v1/messages";

/** A reviewed week of 25 mi a week; with `pain`, an Achilles note on a run. */
function packet(pain = false): ModelPacket {
  return buildModelPacket({
    dossier: null,
    recapMarkdown: [
      "## Summary",
      "",
      "| Metric | This week | Prev week | 3-wk avg | Δ |",
      "| --- | --- | --- | --- | --- |",
      "| Distance | 25.00 mi | 25.00 mi | 25.00 mi | +0.0 |",
      "",
      "## Run-by-run",
      "",
      "### Thu Oct 22 — Easy Run — 5.00 mi / 50m 0s",
      "",
      `RPE: 3/10  ·  Felt: 6/10  ·  Pain: ${pain ? "3/10 (Achilles tight)" : "0/10"}`,
    ].join("\n"),
    thread: [],
    attachments: [],
    week: { isoWeek: "2026-W43", start: "2026-10-19T00:00:00.000Z", end: "2026-10-25T23:59:59.999Z" },
    coaching: { phase: "base", unitPreference: "imperial" },
  });
}

/** About 24.5 mi with a quality Wednesday. */
const STEADY = planLines(PLAN_MONDAY);
/** The same with a 25 mi Sunday: about 40 mi, a volume jump. */
const BIG = planLinesWith(PLAN_MONDAY, 6, "long, 25 mi, steady.");
/** The steady week with Wednesday easy: no quality day. */
const EASY = planLinesWith(PLAN_MONDAY, 2, "easy, 6 mi, relaxed.");

/** The port against a fake server answering request n with plans[n - 1]. */
function port(plans: string[][], rulesRetry: boolean | undefined) {
  const sent: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const rows: LlmCallRecord[] = [];
  const recorder = { record: async (r: LlmCallRecord) => void rows.push(r) } as unknown as LlmCallRecorder;
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    const plan = plans[Math.min(sent.length, plans.length) - 1]!;
    return anthropicStreamResponse(anthropicToolMessage("submit_weekly_reply", weeklyForm(PLAN_MONDAY, { plan: plan.join("\n") })));
  }) as unknown as typeof globalThis.fetch;
  const llm = createAnthropicLlmPort({
    fetchImpl,
    recorder,
    resolveCoachTarget: async () => anthropicCoachTarget({ model: "claude-opus-4-7", effort: "xhigh" }, "sk-test", URL_),
    ...(rulesRetry === undefined ? {} : { rulesRetry }),
  });
  return { llm, sent, rows };
}

/** `rulesRetry` "unset" leaves the option out, so the port reads the environment. */
async function reply(plans: string[][], p: ModelPacket, rulesRetry: boolean | "unset" = true) {
  const { llm, sent } = port(plans, rulesRetry === "unset" ? undefined : rulesRetry);
  const attempts: AttemptReport[] = [];
  const value = await llm.generateWeeklyReply(p, { callId: "00000000-0000-4000-8000-000000000011", onAttempt: (a) => void attempts.push(a) });
  return { value, sent, kinds: attempts.map((a) => a.request?.kind), tripped: rulesTripped(checkPlan(p, value.prescribedWeek)) };
}

describe("the rules retry", () => {
  it("sends a plan that trips a rule back once with the warning, and keeps a second plan that trips none", async () => {
    const got = await reply([BIG, STEADY], packet());
    expect(got.kinds).toEqual(["first", "fix_rules"]);
    expect(got.tripped).toEqual([]);
    const last = got.sent[1]!.messages.at(-1)!;
    const text = JSON.stringify(last.content);
    expect(text).toContain("A big step up in distance");
    expect(text).toContain(RETRY_FIX_RULES_INSTRUCTION);
    expect(got.sent[1]!.messages.at(-2)!.role).toBe("assistant");
  });

  it("keeps a second plan that trips fewer rules, with the rule it still trips", async () => {
    const first = await reply([BIG, STEADY], packet(true));
    // BIG trips volume and quality-with-pain; STEADY only quality-with-pain.
    expect(first.kinds).toEqual(["first", "fix_rules"]);
    expect(first.tripped).toEqual(["quality with pain"]);
  });

  it("keeps the first plan when the second trips as many rules", async () => {
    const got = await reply([BIG, BIG], packet());
    expect(got.kinds).toEqual(["first", "fix_rules"]);
    expect(got.tripped).toEqual(["volume jump"]);
    expect(got.value.prescribedWeek.days[6]!.run?.distanceM).toBeGreaterThan(40_000);
  });

  it("asks nothing more when the first plan trips nothing", async () => {
    const got = await reply([EASY], packet(true));
    expect(got.kinds).toEqual(["first"]);
    expect(got.sent).toHaveLength(1);
  });

  it("is on unless set off; off, one request and the plan kept with its rule", async () => {
    const unset = await reply([BIG, STEADY], packet(), "unset");
    expect(unset.kinds).toEqual(["first", "fix_rules"]);
    expect(unset.tripped).toEqual([]);
    const off = await reply([BIG, STEADY], packet(), false);
    expect(off.kinds).toEqual(["first"]);
    expect(off.tripped).toEqual(["volume jump"]);
    expect(rulesRetryFromEnv({})).toBe(true);
    expect(rulesRetryFromEnv({ COACH_RULES_RETRY: "on" })).toBe(true);
    expect(rulesRetryFromEnv({ COACH_RULES_RETRY: "off" })).toBe(false);
    expect(rulesRetryFromEnv({ COACH_RULES_RETRY: "0" })).toBe(false);
  });
});
