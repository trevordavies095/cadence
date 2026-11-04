/**
 * The public data bundle of the coaching report (coaching-quality ticket 13;
 * docs/reports/coaching-2026-11.md): which saved runs it holds, and the scrub
 * every text file goes through on the way in. The command is
 * scripts/export-coaching-data.ts.
 *
 * The runs live outside the repo, in the maintainer's working folder, with
 * absolute local paths and the self-hosted server's LAN address in their
 * config.json, reports and analyses. The bundle is published, so nothing in it
 * may name a local user, a home folder, a LAN host, a key or an email address:
 * scrubText rewrites them, and findLeaks reports any that are left, with any
 * extra words the caller denies (such as a user name, given on the command
 * line so it is never written into this file).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** One folder or file copied into the bundle: `from` under the working folder, `to` under the bundle. */
export type ExportSource = { from: string; to: string; what: string };

/**
 * What the report relies on, under the working folder (`.scratch` at the repo
 * root). The bundle keeps the working folder's names below benchmark-coaching,
 * so a path such as `.scratch/benchmark-coaching/judge-2/...` in a band file
 * or an analysis is `judge-2/...` in the bundle.
 *
 * Left out on purpose: everything from the review form (the reviewers'
 * answers stay private: the returned responses, the answer key, the form
 * itself and the comparison of the two reviewers; calibration files keep their
 * summary numbers and lose the case-by-case picks, see withoutAnswers), the
 * Opus 5.5 at max attempt (2.1 MB of mostly failed replies; the report quotes
 * its numbers), the analysis made before the judge (superseded by
 * analysis-coaching), the dry runs, and the working notes.
 */
export const EXPORT_SOURCES: ExportSource[] = [
  { from: "benchmark-coaching/baseline/seasons", to: "baseline/seasons", what: "baseline replies, 13 season weeks, 6 configurations, 3 repeats" },
  { from: "benchmark-coaching/baseline/snapshot", to: "baseline/snapshot", what: "baseline replies, the demo athlete's Achilles week" },
  { from: "benchmark-coaching/baseline/analysis-coaching", to: "baseline/analysis-coaching", what: "the analysis of the baseline with the judge's scores (section 9)" },
  { from: "benchmark-coaching/rules-retry/seasons", to: "rules-retry/seasons", what: "replies with the rules retry on" },
  { from: "benchmark-coaching/rules-retry/snapshot", to: "rules-retry/snapshot", what: "replies with the rules retry on" },
  { from: "benchmark-coaching/rules-retry/analysis", to: "rules-retry/analysis", what: "the analysis of the rules-retry run" },
  { from: "benchmark-coaching/judge", to: "judge", what: "the judge's first calibration, which failed" },
  { from: "benchmark-coaching/judge-2", to: "judge-2", what: "the second calibration and the judge's scores of the whole baseline" },
  { from: "benchmark-coaching/judge-retry", to: "judge-retry", what: "the judge's scores of the rules-retry run" },
  { from: "benchmark-after/gate-first-live/coaching", to: "gate-first-live/coaching", what: "the first live coaching gate" },
  { from: "benchmark-coaching/probe", to: "probe", what: "one reply each from Haiku, Sonnet and Opus 5.5 at xhigh, before the round" },
  { from: "benchmark-coaching/models.json", to: "models.json", what: "the Anthropic models and efforts listed on 2026-11-03" },
];

/** Never copied, wherever they turn up: the review form and its answers stay private. */
const NEVER = new Set(["responses.csv", "returned", "coach-packet", "comparison.md", "answer-key.json", "coaching-answer-key.json"]);

/**
 * A calibration file without the reviewer's answers: calibration.json loses
 * each judge's case-by-case picks, calibration.md everything after the summary
 * (the per-judge tables of the coach's pick beside the judge's). Other files
 * pass through.
 */
export function withoutAnswers(file: string, text: string): string {
  const name = path.basename(file);
  if (name === "calibration.json") {
    const report = JSON.parse(text) as { judges?: Array<Record<string, unknown>> };
    for (const j of report.judges ?? []) delete j.cases;
    return `${JSON.stringify(report, null, 2)}\n`;
  }
  if (name === "calibration.md") {
    const cut = text.indexOf("\n## ");
    return cut === -1 ? text : `${text.slice(0, cut + 1)}\nThe case-by-case comparison with the coach's picks is left out: the reviewers' answers are not published.\n`;
  }
  return text;
}

/** Files read as text and scrubbed; anything else is refused rather than copied blind. */
const TEXT = new Set([".json", ".md", ".csv", ".gs", ".txt"]);

/** IPv4 addresses in the private ranges: the only LAN server in these runs was the MacBook serving oMLX. */
const PRIVATE_IPV4 = /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g;
const HOME = /\/(?:Users|home)\/[^/\s"'`),;]+/g;
const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]+/g;
const OTHER_KEY = /\bsk-[A-Za-z0-9]{20,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const WORKTREE = /\.claude\/worktrees\/[^/\s"'`]+\//g;

/**
 * The text with the repo's absolute path made repo-relative, any other home
 * folder made `<local>`, private addresses `<macbook>`, and keys and email
 * addresses replaced. Only ASCII without quotes or backslashes goes in, so a
 * JSON file stays valid.
 */
export function scrubText(text: string, repoRoot: string): string {
  const root = repoRoot.replace(/\/+$/, "");
  return text
    .split(`${root}/`).join("")
    .split(root).join(".")
    .replace(WORKTREE, "")
    .replace(HOME, "<local>")
    .replace(PRIVATE_IPV4, "<macbook>")
    .replace(ANTHROPIC_KEY, "<key>")
    .replace(OTHER_KEY, "<key>")
    .replace(BEARER, "Bearer <key>")
    .replace(EMAIL, "<email>");
}

/** What must not be in a published file; `deny` adds words matched ignoring case. */
export function findLeaks(text: string, deny: string[] = []): string[] {
  const found: string[] = [];
  const checks: [string, RegExp][] = [
    ["a home folder", /\/(?:Users|home)\//],
    ["a private address", new RegExp(PRIVATE_IPV4.source)],
    ["an Anthropic key", /sk-ant-/],
    ["a key", new RegExp(OTHER_KEY.source)],
    ["an email address", new RegExp(EMAIL.source)],
    ...deny.filter((w) => w.trim()).map((w): [string, RegExp] => [`"${w}"`, new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]),
  ];
  for (const [what, re] of checks) if (re.test(text)) found.push(what);
  return found;
}

/** Every file under a path (the path itself when it is a file), skipping NEVER. */
function filesUnder(p: string): string[] {
  if (NEVER.has(path.basename(p))) return [];
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .sort()
    .flatMap((name) => filesUnder(path.join(p, name)));
}

export type ExportResult = { files: number; bytes: number; missing: string[]; leaks: { file: string; found: string[] }[] };

/** The bundle's own hand-written files, kept when the bundle is emptied before an export. */
export const KEEP = new Set(["README.md"]);

/**
 * Copies every source that exists from `scratch` into `out` (emptied first,
 * except KEEP),
 * scrubbing each text file, then checks every written file for leaks. A
 * source that is missing is reported, not fatal; a file that is not text
 * stops the export.
 */
export function exportBundle(opts: { scratch: string; out: string; repoRoot: string; deny?: string[]; sources?: ExportSource[] }): ExportResult {
  const sources = opts.sources ?? EXPORT_SOURCES;
  if (existsSync(opts.out)) for (const name of readdirSync(opts.out)) if (!KEEP.has(name)) rmSync(path.join(opts.out, name), { recursive: true, force: true });
  const result: ExportResult = { files: 0, bytes: 0, missing: [], leaks: [] };
  for (const s of sources) {
    const from = path.join(opts.scratch, s.from);
    let files: string[];
    try {
      files = filesUnder(from);
    } catch {
      result.missing.push(s.from);
      continue;
    }
    for (const file of files) {
      const rel = path.relative(from, file);
      const dest = rel ? path.join(opts.out, s.to, rel) : path.join(opts.out, s.to);
      if (!TEXT.has(path.extname(file))) throw new Error(`${path.join(s.from, rel)} is not a text file the export knows; add its extension to TEXT only after checking it can be scrubbed.`);
      mkdirSync(path.dirname(dest), { recursive: true });
      const text = scrubText(withoutAnswers(file, readFileSync(file, "utf8")), opts.repoRoot);
      writeFileSync(dest, text);
      result.files++;
      result.bytes += Buffer.byteLength(text);
    }
  }
  for (const file of filesUnder(opts.out)) {
    const found = findLeaks(readFileSync(file, "utf8"), opts.deny);
    if (found.length) result.leaks.push({ file: path.relative(opts.out, file), found });
  }
  return result;
}
