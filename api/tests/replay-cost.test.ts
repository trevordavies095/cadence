/**
 * The replay gate's cost estimate (scripts/replayCost.ts), over saved-run
 * folders built here as fixtures. Reads no real .scratch data and calls no model.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attemptCostUsd, PRICE_TABLE } from "../scripts/replayMeasures.js";
import { describeEstimate, estimateGateCost, FALLBACK_ANTHROPIC_USD_PER_REPLY, GATE_COST_CAP_USD } from "../scripts/replayCost.js";

const OPUS = { short: "opus", folder: "anthropic--claude-opus-4-7--xhigh", provider: "anthropic", inputs: 20 };
const GPT_OSS = { short: "gpt-oss-20b", folder: "self_hosted--gpt-oss-20b-MXFP4-Q8--high", provider: "self_hosted", inputs: 20 };

/** Writes one saved run folder: config.json and a measures.json with the given median cost. */
function savedRun(dir: string, opts: { startedAt: string; resumedAt?: string[]; medianUsd: number | null; dryRun?: boolean }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ startedAt: opts.startedAt, resumedAt: opts.resumedAt ?? [], dryRun: opts.dryRun ?? false }));
  writeFileSync(path.join(dir, "measures.json"), JSON.stringify({ cost: opts.medianUsd === null ? null : { medianUsd: opts.medianUsd } }));
}

describe("the gate's cost estimate", () => {
  it("is inputs x the median per reply across saved live runs, with no attempts multiplier", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "replay-cost-"));
    const before = path.join(tmp, "benchmark");
    const after = path.join(tmp, "benchmark-after");
    savedRun(path.join(before, "snapshot", OPUS.folder), { startedAt: "2026-11-01T10:00:00Z", medianUsd: 0.1 });
    savedRun(path.join(after, "baseline", "seasons", OPUS.folder), { startedAt: "2026-10-31T10:00:00Z", resumedAt: ["2026-11-02T09:00:00Z"], medianUsd: 0.12 });
    // A runaway run is outvoted by the median across runs.
    savedRun(path.join(after, "strict", "snapshot", OPUS.folder), { startedAt: "2026-11-02T12:00:00Z", medianUsd: 1.72 });
    // A dry run, and one with no priced reply: both skipped.
    savedRun(path.join(after, "strict-dry-run", "snapshot", OPUS.folder), { startedAt: "2026-11-03T10:00:00Z", medianUsd: 9, dryRun: true });
    savedRun(path.join(after, "unpriced", "snapshot", OPUS.folder), { startedAt: "2026-11-03T10:00:00Z", medianUsd: null });

    const estimate = estimateGateCost([GPT_OSS, OPUS], [before, after]);
    expect(estimate.configurations[0]).toMatchObject({ short: "gpt-oss-20b", usd: 0, runs: 0 });
    expect(estimate.configurations[1]).toMatchObject({ usdPerReply: 0.12, runs: 3 });
    expect(estimate.totalUsd).toBeCloseTo(20 * 0.12);
    expect(estimate.refused).toBe(false);
    expect(describeEstimate(estimate).join("\n")).toContain("the median per reply across 3 saved runs, retries included");
  });

  it("falls back to the regression set's Opus figure with no saved run, and says so", () => {
    const estimate = estimateGateCost([OPUS], [path.join(tmpdir(), "replay-cost-missing-folder")]);
    expect(FALLBACK_ANTHROPIC_USD_PER_REPLY).toBe(0.15);
    expect(estimate.configurations[0]).toMatchObject({ usdPerReply: 0.15, runs: 0 });
    expect(estimate.totalUsd).toBeCloseTo(3);
    expect(estimate.refused).toBe(false);
    expect(describeEstimate(estimate).join("\n")).toMatch(/no saved run for this configuration, so the regression set's Opus figure of about \$0\.15 a reply/);
  });

  it("refuses only above the $5 cap, and never for a self-hosted configuration", () => {
    expect(GATE_COST_CAP_USD).toBe(5);
    const tmp = mkdtempSync(path.join(tmpdir(), "replay-cost-cap-"));
    savedRun(path.join(tmp, "a", OPUS.folder), { startedAt: "2026-11-01T10:00:00Z", medianUsd: 0.25 });
    expect(estimateGateCost([OPUS], [tmp])).toMatchObject({ totalUsd: 5, refused: false });
    expect(estimateGateCost([{ ...OPUS, inputs: 21 }], [tmp])).toMatchObject({ refused: true });
    savedRun(path.join(tmp, "b", GPT_OSS.folder), { startedAt: "2026-11-01T10:00:00Z", medianUsd: 100 });
    expect(estimateGateCost([{ ...GPT_OSS, inputs: 1000 }], [tmp])).toMatchObject({ totalUsd: 0, refused: false });
  });

  it("prices the 5.5 models from the table, with Opus 5.5 and Sonnet 5.5 reading the cache at 0.05x", () => {
    const usage = { inputTokens: 10_000, outputTokens: 2_000, thinkingTokens: null, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 };
    // Opus 5.5: $4 in, $20 out; a million cache reads at 0.05x of $4 is $0.20.
    expect(attemptCostUsd("claude-opus-5-5", usage)).toBeCloseTo(0.04 + 0.04 + 0.2);
    // Haiku 5.5 keeps the standard 0.1x: a million cache reads at $0.10 input is $0.01.
    expect(attemptCostUsd("claude-haiku-5-5", usage)).toBeCloseTo(0.001 + 0.001 + 0.01);
    expect(PRICE_TABLE.models["claude-sonnet-5-5"]).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(attemptCostUsd("claude-opus-4-7", usage)).toBeCloseTo(0.05 + 0.05 + 0.5);
    expect(attemptCostUsd("some-unpriced-model", usage)).toBeNull();
  });
});
