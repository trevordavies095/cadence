/**
 * Scripted steps. Each one pins the fictional clock, runs, and records the real database
 * time it took. Rows are stamped with the real time (Postgres NOW()), so finalize.mjs uses
 * these windows to move them into the fiction afterwards, keeping order and duration.
 */
import fs from "node:fs";
import path from "node:path";
import { dumpSnapshot, realNow, setClock } from "./api.mjs";

let state = null;

/** Live mode only: how hard the model thinks per step. Weeks 9 and 10 are the ones on screen. */
export function effortFor(week) {
  return week >= 9 ? "xhigh" : "medium";
}

/** checkpointDir holds steps.json and week-NN.sql. `keepWeeksBefore` drops steps being replayed. */
export function initSteps(checkpointDir, keepWeeksBefore) {
  fs.mkdirSync(checkpointDir, { recursive: true });
  const file = path.join(checkpointDir, "steps.json");
  let steps = [];
  if (keepWeeksBefore > 0 && fs.existsSync(file)) {
    steps = JSON.parse(fs.readFileSync(file, "utf8")).filter((s) => s.week < keepWeeksBefore);
  }
  state = { checkpointDir, file, steps };
}

export const recordedSteps = () => state.steps;

/** Run `fn` with the clock pinned to `at`. Returns the clock's ISO instant. */
export async function runStep({ week, label, at }, fn) {
  const clock = setClock(at, effortFor(week));
  const realStart = realNow();
  await fn();
  const realEnd = realNow();
  state.steps.push({ week, label, fictionAt: clock, realStart, realEnd });
  fs.writeFileSync(state.file, `${JSON.stringify(state.steps, null, 2)}\n`);
  return clock;
}

/** Raw dump after a week (week-00 is after onboarding). Used by `--from-week`. */
export function checkpoint(week, clock) {
  dumpSnapshot(path.join(state.checkpointDir, `week-${String(week).padStart(2, "0")}.sql`), clock);
}
