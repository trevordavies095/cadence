#!/usr/bin/env node
/**
 * Replay Johnny's season through the API and write a snapshot.
 * Run through scripts/demo.sh (it backs up, wipes and starts the stack first):
 *
 *   scripts/demo.sh build [--through-week N]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpSnapshot } from "./lib/api.mjs";
import { playOnboarding, playWeek } from "./lib/season.mjs";

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.LLM_PROVIDER === "anthropic";
const OUT = path.join(DEMO_DIR, LIVE ? "snapshot.sql" : "snapshot.stub.sql");

function parseArgs(argv) {
  let through = 1;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--through-week") through = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(through) || through < 1 || through > 10) {
    throw new Error("--through-week must be 1 to 10 (week 11 is not scripted into the build yet)");
  }
  return { through };
}

async function main() {
  const { through } = parseArgs(process.argv.slice(2));
  const script = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, "athlete-script.json"), "utf8"));

  await playOnboarding(script);
  let clock = new Date(script.onboarding.at).toISOString();
  for (const entry of script.weeks.filter((w) => w.week <= through)) {
    clock = await playWeek(script, entry);
  }

  dumpSnapshot(OUT, clock);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
