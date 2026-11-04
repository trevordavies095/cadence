/**
 * The replay gate's cost estimate (plan-as-text ticket 02): what a gate run
 * would bill, from what earlier runs of the same configuration billed, read
 * before any model is called. Pure but for reading saved run folders.
 *
 * For each configuration the estimate is
 *
 *   inputs selected  x  cost per reply
 *
 * The cost per reply is the median, across every saved live run of that
 * configuration, of each run's `cost.medianUsd` in measures.json. Saved runs
 * are `<configuration>/` folders found anywhere under the saved-run folders
 * (by default .scratch/benchmark and .scratch/benchmark-after); dry runs and
 * folders with no priced reply are skipped.
 *
 * Two choices keep the estimate honest. A run's per-reply cost already prices
 * every attempt, refused ones included, so it is not multiplied by the attempt
 * count again. And it is the median across runs, not the newest run, so one
 * run that went wrong (the 2026-11-02 strict run, whose replies ran to the old
 * 64,000-token limit at about $1.70 each) cannot set the figure for every gate
 * after it. With no saved run, an Anthropic configuration is estimated at the
 * regression set's Opus figure, about $0.15 a reply, and the estimate says so.
 * A self-hosted configuration is estimated at $0: it bills nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Above this estimate, in US dollars, the gate refuses to start without --allow-cost. */
export const GATE_COST_CAP_USD = 5;
/** Per reply, with no saved run: the regression set's Opus 4.7 figure (about $3 over 20 replies). */
export const FALLBACK_ANTHROPIC_USD_PER_REPLY = 0.15;
/** How deep under a saved-run folder configuration folders are looked for (lever/root/configuration). */
const SEARCH_DEPTH = 3;

export type CostConfiguration = { short: string; folder: string; provider: string; inputs: number };

export type ConfigurationEstimate = {
  short: string;
  provider: string;
  inputs: number;
  usdPerReply: number;
  /** How many saved runs the per-reply figure is the median of; 0 for the fallback or a self-hosted configuration. */
  runs: number;
  usd: number;
};

export type GateEstimate = { configurations: ConfigurationEstimate[]; totalUsd: number; capUsd: number; refused: boolean };

type SavedRun = { dir: string; medianUsd: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every saved, live, priced run of `folder` under `parents`. */
function savedRuns(folder: string, parents: string[]): SavedRun[] {
  const found: SavedRun[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = path.join(dir, name);
      if (!statSync(child, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (name === folder) {
        const run = savedRun(child);
        if (run) found.push(run);
      } else if (depth < SEARCH_DEPTH) {
        visit(child, depth + 1);
      }
    }
  };
  for (const parent of parents) if (existsSync(parent)) visit(parent, 1);
  return found;
}

function savedRun(dir: string): SavedRun | null {
  const config = readJson(path.join(dir, "config.json")) as { dryRun?: boolean } | null;
  const measures = readJson(path.join(dir, "measures.json")) as { cost?: { medianUsd?: number | null } | null } | null;
  if (!config || config.dryRun) return null;
  const medianUsd = measures?.cost?.medianUsd;
  if (typeof medianUsd !== "number" || !Number.isFinite(medianUsd)) return null;
  return { dir, medianUsd };
}

/** The gate's estimate for `configurations`, read from the saved runs under `savedRunParents`. */
export function estimateGateCost(configurations: CostConfiguration[], savedRunParents: string[]): GateEstimate {
  const estimates = configurations.map((c): ConfigurationEstimate => {
    if (c.provider !== "anthropic") return { short: c.short, provider: c.provider, inputs: c.inputs, usdPerReply: 0, runs: 0, usd: 0 };
    const runs = savedRuns(c.folder, savedRunParents);
    const usdPerReply = runs.length ? median(runs.map((r) => r.medianUsd)) : FALLBACK_ANTHROPIC_USD_PER_REPLY;
    return { short: c.short, provider: c.provider, inputs: c.inputs, usdPerReply, runs: runs.length, usd: c.inputs * usdPerReply };
  });
  const totalUsd = estimates.reduce((n, e) => n + e.usd, 0);
  return { configurations: estimates, totalUsd, capUsd: GATE_COST_CAP_USD, refused: totalUsd > GATE_COST_CAP_USD };
}

/** The estimate as the gate prints it, one line per configuration, then the total against the cap. */
export function describeEstimate(estimate: GateEstimate): string[] {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const lines = estimate.configurations.map((e) => {
    if (e.provider !== "anthropic") return `  ${e.short}: $0 (self-hosted, bills nothing)`;
    const from = e.runs
      ? `the median per reply across ${e.runs} saved run${e.runs === 1 ? "" : "s"}, retries included`
      : `no saved run for this configuration, so the regression set's Opus figure of about ${usd(FALLBACK_ANTHROPIC_USD_PER_REPLY)} a reply`;
    return `  ${e.short}: ${e.inputs} inputs x $${e.usdPerReply.toFixed(4)} a reply = ${usd(e.usd)} (${from})`;
  });
  return [...lines, `  total ${usd(estimate.totalUsd)}, cap ${usd(estimate.capUsd)}`];
}
