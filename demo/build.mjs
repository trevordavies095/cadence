#!/usr/bin/env node
/**
 * Replay Johnny's season through the API and write a snapshot.
 * Run through scripts/demo.sh (it backs up, wipes and starts the stack first):
 *
 *   scripts/demo.sh build [--live] [--through-week N] [--from-week N]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpSnapshot } from "./lib/api.mjs";
import { assertNoLeaks, assertProvider, fixTimestamps, scrubSecrets } from "./lib/finalize.mjs";
import { playOnboarding, playWeek, playWeek11 } from "./lib/season.mjs";
import { checkpoint, initSteps, recordedSteps } from "./lib/steps.mjs";

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.LLM_PROVIDER === "anthropic";
const OUT = path.join(DEMO_DIR, LIVE ? "snapshot.sql" : "snapshot.stub.sql");
const DEMO_NOW = "2026-10-14T19:30:00-04:00";
const PROVIDER = LIVE ? "anthropic" : "stub";

function parseArgs(argv) {
  const opts = { through: 11, from: 0, checkpoints: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--through-week") opts.through = Number(argv[++i]);
    else if (argv[i] === "--from-week") opts.from = Number(argv[++i]);
    else if (argv[i] === "--checkpoints") opts.checkpoints = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(opts.through) || opts.through < 1 || opts.through > 11) {
    throw new Error("--through-week must be 1 to 11");
  }
  if (!Number.isInteger(opts.from) || opts.from < 0 || opts.from > opts.through) {
    throw new Error("--from-week must be between 1 and --through-week");
  }
  if (!opts.checkpoints) throw new Error("run this through scripts/demo.sh build");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const script = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, "athlete-script.json"), "utf8"));

  // Rows are stamped with the real time and mapped into the fiction afterwards, which only
  // works while the fiction lies entirely in the past.
  if (Date.now() < Date.parse(DEMO_NOW) + 86_400_000) {
    throw new Error("the demo season has not finished yet in real time; refusing to build");
  }

  initSteps(path.resolve(opts.checkpoints), opts.from);
  let clock = null;

  if (opts.from === 0) {
    clock = await playOnboarding(script);
    checkpoint(0, clock);
  }
  for (const entry of script.weeks) {
    if (entry.week < Math.max(opts.from, 1) || entry.week > opts.through) continue;
    clock = await playWeek(script, entry);
    // Fail on the first weekly reply, not after the whole season.
    assertProvider(PROVIDER);
    checkpoint(entry.week, clock);
  }
  if (opts.through === 11 && opts.from <= 11) {
    clock = await playWeek11(script);
    checkpoint(11, clock);
  }

  // Publishing: move stamps into the fiction, remove secrets, dump, check for leaks.
  if (assertProvider(PROVIDER) === 0) throw new Error("no weekly replies or chat were logged");
  const moved = fixTimestamps(recordedSteps());
  console.log(`timestamps: ${moved} value(s) moved into the fiction`);
  scrubSecrets();
  dumpSnapshot(OUT, new Date(opts.through === 11 ? DEMO_NOW : clock).toISOString());
  assertNoLeaks(OUT);
  console.log("leak check passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
