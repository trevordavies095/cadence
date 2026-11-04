/**
 * The coaching round's cost estimate (coaching-quality ticket 06), printed
 * before any model is called. One round is every configuration over the hard
 * set (tests/fixtures/hard-set.json: its seasons ids over the season packets,
 * its snapshot id over the demo snapshot) with N repeats.
 *
 *   npx tsx scripts/replay-coaching-estimate.ts --repeats 3 \
 *     --config anthropic:claude-opus-4-7:xhigh --config anthropic:claude-opus-5-5:max ...
 *
 * Per Anthropic configuration, the cost per reply is the gate's (replayCost.ts):
 * the median across saved live runs of the same configuration folder. A
 * configuration with no saved run is estimated from the control's own token
 * counts in the final run (Opus 4.7 at xhigh, 2026-11-02, per root) at this
 * model's prices, with the output doubled for a different model, since a new
 * model at its highest effort may think more than the control did. The
 * regression set's flat Opus figure is not used: it would price Haiku 5.5 as Opus.
 *
 * With --saved <dir> (the round's output root, holding seasons/ and snapshot/),
 * replies already saved there for a configuration are not counted again, so a
 * resumed round is estimated for what is left. --ceiling sets the ceiling
 * (default $40; pass what is left of it when part of the round is spent).
 *
 * Prints one line per configuration and the round total against the ceiling,
 * then a last line `REPEATS=<n>`: the repeats asked for when the round is at or
 * under the ceiling, else 2 when two repeats fit, else 0 (do not run).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateGateCost } from "./replayCost.js";
import { PRICE_TABLE } from "./replayMeasures.js";

/** The round's ceiling across the Anthropic configurations, in US dollars (spec: $40). */
export const ROUND_CEILING_USD = 40;
/** Output tokens are multiplied by this for a model with no saved run that is not the control's. */
export const NEW_MODEL_OUTPUT_HEADROOM = 2;
const CONTROL_MODEL = "claude-opus-4-7";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const SAVED_RUN_PARENTS = [".scratch/benchmark", ".scratch/benchmark-after", ".scratch/benchmark-coaching"].map((p) => path.join(repo, p));
const CONTROL_RUN = path.join(repo, ".scratch/benchmark-after/final");
const HARD_SET = path.join(here, "../tests/fixtures/hard-set.json");

type Config = { provider: string; model: string; effort: string };

function args(): { repeats: number; configs: Config[]; saved: string | null; ceiling: number } {
  const argv = process.argv.slice(2);
  let repeats = 3;
  let saved: string | null = null;
  let ceiling = ROUND_CEILING_USD;
  const configs: Config[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repeats") repeats = Number(argv[++i]);
    else if (argv[i] === "--saved") saved = argv[++i] ?? null;
    else if (argv[i] === "--ceiling") ceiling = Number(argv[++i]);
    else if (argv[i] === "--config") {
      const [provider, model, effort] = (argv[++i] ?? "").split(":");
      if (!provider || !model || !effort) throw new Error(`--config wants provider:model:effort, got "${argv[i]}"`);
      configs.push({ provider, model, effort });
    } else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats wants a whole number from 1");
  if (!Number.isFinite(ceiling) || ceiling < 0) throw new Error("--ceiling wants a dollar figure");
  return { repeats, configs, saved, ceiling };
}

/** Repeats of each input already saved (accepted or failed) under `<saved>/<root>/<folder>`, by input id. */
function savedRepeats(saved: string | null, root: string, folder: string): Map<string, Set<number>> {
  const found = new Map<string, Set<number>>();
  if (!saved) return found;
  let names: string[] = [];
  try {
    names = readdirSync(path.join(saved, root, folder));
  } catch {
    return found;
  }
  for (const name of names) {
    const m = /^(\d+)\.(\d+)(?:\.failed)?\.json$/.exec(name);
    if (!m) continue;
    const set = found.get(m[1]!) ?? new Set<number>();
    set.add(Number(m[2]));
    found.set(m[1]!, set);
  }
  return found;
}

/** Input ids per root in the hard set. */
function hardSetInputs(): Record<string, string[]> {
  const list = JSON.parse(readFileSync(HARD_SET, "utf8")) as Array<{ input: string }>;
  const ids: Record<string, string[]> = {};
  for (const { input } of list) {
    const [root, id] = input.split("/") as [string, string];
    (ids[root] ??= []).push(id);
  }
  return ids;
}

/** The control's median input and output tokens per reply, per root, from the final run. */
function controlTokens(root: string): { input: number; output: number } {
  const file = path.join(CONTROL_RUN, root, "anthropic--claude-opus-4-7--xhigh", "measures.json");
  const m = JSON.parse(readFileSync(file, "utf8")) as { tokens: { input: { median: number }; output: { median: number } } };
  return { input: m.tokens.input.median, output: m.tokens.output.median };
}

function folderFor(c: Config): string {
  return `${c.provider}--${c.model.replace(/[^A-Za-z0-9._-]/g, "_")}--${c.effort}`;
}

function main() {
  const { repeats, configs, saved, ceiling } = args();
  const inputs = hardSetInputs();
  const usd = (n: number) => `$${n.toFixed(2)}`;

  /** Replies still to run for a configuration at `r` repeats, per root. */
  const toRun = (c: Config, r: number): Record<string, number> => {
    const left: Record<string, number> = {};
    for (const [root, ids] of Object.entries(inputs)) {
      const done = savedRepeats(saved, root, folderFor(c));
      left[root] = ids.reduce((n, id) => {
        const have = done.get(id) ?? new Set<number>();
        let missing = 0;
        for (let k = 1; k <= r; k++) if (!have.has(k)) missing++;
        return n + missing;
      }, 0);
    }
    return left;
  };

  /** One configuration's cost per reply, per root, and how it was reached. */
  const perReply = configs.map((c) => {
    const label = `${c.model} at ${c.effort}`;
    if (c.provider !== "anthropic") return { c, label, usd: (_root: string) => 0, from: "self-hosted, bills nothing" };
    const saved = estimateGateCost([{ short: label, folder: folderFor(c), provider: "anthropic", inputs: 1 }], SAVED_RUN_PARENTS).configurations[0]!;
    if (saved.runs > 0) return { c, label, usd: (_root: string) => saved.usdPerReply, from: `median of ${saved.runs} saved runs, $${saved.usdPerReply.toFixed(4)} a reply` };
    const price = PRICE_TABLE.models[c.model];
    if (!price) throw new Error(`${c.model} has no price in PRICE_TABLE (replayMeasures.ts); add it before estimating.`);
    const headroom = c.model === CONTROL_MODEL ? 1 : NEW_MODEL_OUTPUT_HEADROOM;
    return {
      c,
      label,
      usd: (root: string) => {
        const t = controlTokens(root);
        return (t.input * price.inputPerMTok + t.output * headroom * price.outputPerMTok) / 1e6;
      },
      from: `no saved run: the control's tokens at ${price.label} prices${headroom > 1 ? `, output x${headroom}` : ""}`,
    };
  });

  const costAt = (r: number) =>
    perReply.map((p) => {
      const left = toRun(p.c, r);
      const replies = Object.values(left).reduce((a, b) => a + b, 0);
      return { ...p, replies, total: Object.entries(left).reduce((n, [root, k]) => n + k * p.usd(root), 0) };
    });
  for (const r of repeats > 2 ? [repeats, 2] : [repeats]) {
    const rows = costAt(r);
    const total = rows.reduce((n, x) => n + x.total, 0);
    console.log(`Round at ${r} repeats (${Object.entries(inputs).map(([root, ids]) => `${ids.length} ${root}`).join(" + ")} inputs each${saved ? "; replies already saved are not counted" : ""}):`);
    for (const x of rows) console.log(`  ${x.label}: ${x.replies} replies to run, ${usd(x.total)} (${x.from})`);
    console.log(`  total ${usd(total)}, ceiling ${usd(ceiling)}`);
    if (total <= ceiling) {
      console.log(`REPEATS=${r}`);
      return;
    }
  }
  console.log("Over the ceiling even at two repeats: not running.");
  console.log("REPEATS=0");
}

main();
