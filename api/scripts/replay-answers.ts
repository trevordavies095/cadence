/**
 * Reads the coaching review form's responses back into the answer key
 * (scripts/replayAnswers.ts). Makes no calls.
 *
 *   cd api
 *   npm run replay:answers -- \
 *     --csv ../.scratch/benchmark-coaching/coach-packet/returned/responses.csv \
 *     --coach "<name as he typed it>" --user "<name as you typed it>"
 *
 * --csv: the responses, downloaded from the form's linked sheet (File,
 * Download, Comma-separated values). Required.
 * --coach, --user: the answers to "Who is filling this in?", as typed. Both
 * required; matched ignoring case and spacing, and never written anywhere.
 * --form: the form.gs the form was made from; default
 * ../.scratch/benchmark-coaching/coach-packet/form.gs.
 * --key: the form's key; default tests/fixtures/coach-packet-key.json.
 * --out: the answer key; default .scratch/benchmark-coaching/coach-packet/returned/answer-key.json (private: never committed).
 * --rubric: default ../docs/coaching-rubric.md.
 * --comparison: default comparison.md beside form.gs.
 *
 * A header that does not match the form stops the script before anything is
 * written. Problems in the answers (a response from neither name, a second
 * response, a contradictory unsafe answer, a case answered in part) are
 * printed and the rest is written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparisonDoc, readAnswerFiles, rubricDoc } from "./replayAnswers.js";
import type { CoachPacketKey } from "./replayCoachPacket.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function required(flag: string, what: string): string {
  const v = flagValue(flag);
  if (!v) throw new Error(`${flag} is required: ${what}.`);
  return v;
}

const CSV = path.resolve(required("--csv", "the responses CSV downloaded from the form's sheet"));
const names = {
  coach: required("--coach", "the coach's answer to \"Who is filling this in?\""),
  user: required("--user", "your answer to \"Who is filling this in?\""),
};
const FORM = path.resolve(flagValue("--form") ?? path.resolve(here, "../../.scratch/benchmark-coaching/coach-packet/form.gs"));
const KEY = path.resolve(flagValue("--key") ?? path.resolve(here, "../tests/fixtures/coach-packet-key.json"));
const OUT = path.resolve(flagValue("--out") ?? path.resolve(here, "../../.scratch/benchmark-coaching/coach-packet/returned/answer-key.json"));
const RUBRIC = path.resolve(flagValue("--rubric") ?? path.resolve(here, "../../docs/coaching-rubric.md"));
const COMPARISON = path.resolve(flagValue("--comparison") ?? path.join(path.dirname(FORM), "comparison.md"));

const { answerKey, problems } = readAnswerFiles({ csv: CSV, form: FORM, key: KEY }, names);
const key = JSON.parse(readFileSync(KEY, "utf8")) as CoachPacketKey;
for (const [file, text] of [
  [OUT, `${JSON.stringify(answerKey, null, 2)}\n`],
  [RUBRIC, rubricDoc(answerKey)],
  [COMPARISON, comparisonDoc(answerKey, key)],
] as const) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

console.log(`answers: ${answerKey.reviewers.map((r) => `${r.reviewer} ${r.cases.filter((c) => c.answered).length} of ${r.cases.length} cases`).join(", ") || "no reviewer matched"}`);
console.log(`  wrote ${OUT}`);
console.log(`  wrote ${RUBRIC}`);
console.log(`  wrote ${COMPARISON}`);
const comments = answerKey.reviewers.flatMap((r) => r.cases).filter((c) => c.comment).length + answerKey.reviewers.filter((r) => r.anythingElse || r.otherPriority).length;
if (comments) console.log(`  ${comments} written comment${comments === 1 ? "" : "s"} are in the answer key: read them before committing it.`);
for (const p of problems) console.log(`  problem: ${p}`);
