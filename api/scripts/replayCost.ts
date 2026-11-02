/**
 * The replay gate's cost estimate (plan-as-text ticket 02): what a gate run
 * would bill, from what earlier runs of the same configuration billed, read
 * before any model is called. Pure but for reading saved run folders.
 *
 * For each configuration the estimate is
 *
 *   inputs selected  x  median cost per reply  x  attempts per reply (2)
 *
 * The median per-reply cost is `cost.medianUsd` in measures.json of the most
 * recent saved run of that configuration: the newest `<configuration>/`
 * folder, by the last of config.json's `startedAt` and `resumedAt`, found
 * anywhere under the saved-run folders (by default .scratch/benchmark and
 * .scratch/benchmark-after). Dry runs and folders with no priced reply are
 * skipped. With no saved run, an Anthropic configuration is estimated at the
 * regression set's Opus figure, about $0.15 a reply, and the estimate says so.
 * A self-hosted configuration is estimated at $0: it bills nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { WEEKLY_REPLY_ATTEMPTS } from "../src/llm/askOnceMore.js";

/** Above this estimate, in US dollars, the gate refuses to start without --allow-cost. */
export const GATE_COST_CAP_USD = 5;
/** Per reply, with no saved run: the regression set's Opus 4.7 figure (about $3 over 20 replies). */
export const FALLBACK_ANTHROPIC_USD_PER_REPLY = 0.15;
/** A reply is asked for at most this often: a refused first attempt is asked once more. */
export const MAX_ATTEMPTS = WEEKLY_REPLY_ATTEMPTS;
/** How deep under a saved-run folder configuration folders are looked for (lever/root/configuration). */
const SEARCH_DEPTH = 3;

export type CostConfiguration = { short: string; folder: string; provider: string; inputs: number };

export type ConfigurationEstimate = {
  short: string;
  provider: string;
  inputs: number;
  usdPerReply: number;
  /** The saved run the per-reply figure came from; null for the fallback or a self-hosted configuration. */
  source: string | null;
  usd: number;
};

export type GateEstimate = { configurations: ConfigurationEstimate[]; totalUsd: number; capUsd: number; refused: boolean };

type SavedRun = { dir: string; at: number; medianUsd: number };

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
  const config = readJson(path.join(dir, "config.json")) as { dryRun?: boolean; startedAt?: string; resumedAt?: string[] } | null;
  const measures = readJson(path.join(dir, "measures.json")) as { cost?: { medianUsd?: number | null } | null } | null;
  if (!config || config.dryRun) return null;
  const medianUsd = measures?.cost?.medianUsd;
  if (typeof medianUsd !== "number" || !Number.isFinite(medianUsd)) return null;
  const times = [config.startedAt, ...(config.resumedAt ?? [])].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t));
  return { dir, at: times.length ? Math.max(...times) : 0, medianUsd };
}

/** The gate's estimate for `configurations`, read from the saved runs under `savedRunParents`. */
export function estimateGateCost(configurations: CostConfiguration[], savedRunParents: string[]): GateEstimate {
  const estimates = configurations.map((c): ConfigurationEstimate => {
    if (c.provider !== "anthropic") return { short: c.short, provider: c.provider, inputs: c.inputs, usdPerReply: 0, source: null, usd: 0 };
    const latest = savedRuns(c.folder, savedRunParents).sort((a, b) => b.at - a.at)[0];
    const usdPerReply = latest?.medianUsd ?? FALLBACK_ANTHROPIC_USD_PER_REPLY;
    return { short: c.short, provider: c.provider, inputs: c.inputs, usdPerReply, source: latest?.dir ?? null, usd: c.inputs * usdPerReply * MAX_ATTEMPTS };
  });
  const totalUsd = estimates.reduce((n, e) => n + e.usd, 0);
  return { configurations: estimates, totalUsd, capUsd: GATE_COST_CAP_USD, refused: totalUsd > GATE_COST_CAP_USD };
}

/** The estimate as the gate prints it, one line per configuration, then the total against the cap. */
export function describeEstimate(estimate: GateEstimate): string[] {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const lines = estimate.configurations.map((e) => {
    if (e.provider !== "anthropic") return `  ${e.short}: $0 (self-hosted, bills nothing)`;
    const from = e.source
      ? `the median per reply of the most recent saved run, ${e.source}`
      : `no saved run for this configuration, so the regression set's Opus figure of about ${usd(FALLBACK_ANTHROPIC_USD_PER_REPLY)} a reply`;
    return `  ${e.short}: ${e.inputs} inputs x $${e.usdPerReply.toFixed(4)} a reply x ${MAX_ATTEMPTS} attempts = ${usd(e.usd)} (${from})`;
  });
  return [...lines, `  total ${usd(estimate.totalUsd)}, cap ${usd(estimate.capUsd)}`];
}
