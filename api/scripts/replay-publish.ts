/**
 * Rewrites the generated blocks of the published benchmark report from the
 * replay analysis (scripts/replay-analysis.ts) and the blind-review packs
 * (scripts/replayReview.ts). Makes no calls, and changes nothing outside the
 * marked blocks, so the hand-written prose survives a rerun.
 *
 *   cd api
 *   npm run replay:analyse
 *   npm run replay:publish -- --analysis ../.scratch/benchmark-analysis \
 *     --doc ../docs/reports/local-models-2026-11.md
 *
 * --analysis: the folder holding analysis.json; default ../.scratch/benchmark-analysis.
 * --doc: the report; default ../docs/reports/local-models-2026-11.md.
 * --review: the folder of review packs (one folder per candidate with a
 * key.json, and a scores.json once filled); default ../.scratch/benchmark/review.
 * --dry-run: print the rewritten report to stdout and write nothing.
 *
 * A block is the text between `<!-- generated:<name>:start -->` and
 * `<!-- generated:<name>:end -->`. Known names: setup, results, failures,
 * retry, rescue, plans, hardest, review, after, coaching. An unknown or unpaired marker
 * stops the script before anything is written; a known block missing from the
 * report is reported and skipped.
 *
 * `after` (`<!-- generated:after:start -->` ... `<!-- generated:after:end -->`)
 * is the "after the changes" block of plan-as-text ticket 13, built from the
 * final run's analysis. Its text is not written yet: until a renderer is
 * supplied, the publisher recognises the marker and leaves the block's body
 * exactly as it stands (empty when the report holds the markers alone).
 *
 * `coaching` is section 9 of the analysis (scripts/replayCoaching.ts, made
 * with `replay:analyse -- --judge`): the judge's line and the coaching tables,
 * for the coaching report (coaching-quality ticket 13). The publisher rewrites
 * every block it knows from the analysis it is given, so an analysis that
 * carries coaching scores is refused for a report without a coaching block:
 * it is never published over the November report. An analysis without the
 * section leaves a coaching block as it stands.
 *
 * Nothing published may carry a key, a host address or a local path: notes
 * and input names are scrubbed of IPv4 addresses and absolute paths.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fmt, secs, short, spreadCells, table, type AnalysisFile } from "./replay-analysis.js";
import { coachingBody } from "./replayCoaching.js";
import { candidateResults } from "./replayReview.js";

// ---- Flags ----------------------------------------------------------------------------

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

const ANALYSIS = path.resolve(flagValue("--analysis") ?? "../.scratch/benchmark-analysis");
const DOC = path.resolve(flagValue("--doc") ?? "../docs/reports/local-models-2026-11.md");
const REVIEW = path.resolve(flagValue("--review") ?? "../.scratch/benchmark/review");
const DRY_RUN = process.argv.includes("--dry-run");

// ---- Scrubbing ---------------------------------------------------------------------------

/** No host address and no absolute path in anything published. */
function scrub(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "(host)")
    .replace(/(?:[A-Za-z]:)?(?:\/[\w.@~+-]+){2,}\/?/g, (p) => path.basename(p));
}

// ---- Blocks ------------------------------------------------------------------------------

type Ctx = { a: AnalysisFile; reviewDir: string };

const OPERATION_LABEL: Record<string, string> = {
  weekly_reply: "weekly read",
  mid_week_chat: "mid-week reply",
  dossier_v1: "About you draft",
  dossier_correction: "About you fix",
  dossier_audit: "About you tidy-up",
};

function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : `$${n.toFixed(2)}`;
}

function setupBlock({ a }: Ctx): string[] {
  const rows = a.setup.flatMap((s) =>
    s.roots.map((r) => [
      short(s.configuration),
      r.root,
      r.model ?? "–",
      r.effort ?? "–",
      scrub(r.note ?? "–"),
      r.repeats ?? "–",
      r.harnessCommit ? r.harnessCommit.slice(0, 7) : "–",
      r.startedAt ? r.startedAt.slice(0, 16).replace("T", " ") + " UTC" : "–",
    ]),
  );
  const costs = a.speed
    .filter((s) => s.all.costUsd !== null)
    .map((s) => {
      const parts = s.measuresJson.filter((m) => m.totalUsd !== null).map((m) => `${usd(m.totalUsd)} ${m.root}`);
      return `${short(s.configuration)}: ${usd(s.all.costUsd)} over ${s.all.replies} replies (${parts.join(", ")}), refused attempts included.`;
    });
  return [
    ...table(["Configuration", "Inputs", "Model id", "Effort", "Note (hardware, server, context)", "Repeats", "Harness commit", "Started"], rows),
    "",
    `Cost from saved usage, Anthropic rows only: ${costs.length ? costs.join(" ") : "none recorded."}`,
  ];
}

function resultsBlock({ a }: Ctx): string[] {
  const rows = a.configurations.map((c) => {
    const o = a.outcomes.find((x) => x.configuration === c)!.all;
    const s = a.speed.find((x) => x.configuration === c)!.all;
    const rescue = a.rescue.perModel[c as keyof typeof a.rescue.perModel] as { population: number; all: number } | undefined;
    return [
      short(c),
      o.replies,
      `${o.firstTry + o.afterRetry} (${o.firstTry} / ${o.afterRetry})`,
      o.failed,
      rescue?.population ? `${rescue.all} of ${rescue.population}` : o.failed ? "0" : "–",
      `${secs(s.totalMs.median)} / ${secs(s.totalMs.p90)}`,
      secs(s.firstTokenMs.median),
      fmt(s.inputTokens.median, 0),
      fmt(s.outputTokens.median, 0),
      fmt(s.thinkingChars.median, 0),
    ];
  });
  const ops = [...new Set(a.outcomes.flatMap((o) => Object.keys(o.byOperation)))];
  const byOp = a.configurations.map((c) => {
    const o = a.outcomes.find((x) => x.configuration === c)!;
    return [
      short(c),
      ...ops.map((op) => {
        const r = (o.byOperation as Record<string, { replies: number; firstTry: number; afterRetry: number } | undefined>)[op];
        return r ? `${r.firstTry + r.afterRetry} of ${r.replies}` : "–";
      }),
    ];
  });
  return [
    ...table(
      [
        "Configuration",
        "Replies",
        "Valid as sent (first try / after retry)",
        "Failed",
        "Rescued by the candidate repairs",
        "Time per reply, median / p90",
        "First token, median",
        "Input tokens, median",
        "Output tokens, median",
        "Thinking characters, median",
      ],
      rows,
    ),
    "",
    "Valid as sent, by kind of reply:",
    "",
    ...table(["Configuration", ...ops.map((op) => OPERATION_LABEL[op] ?? op)], byOp),
  ];
}

function failuresBlock({ a }: Ctx): string[] {
  const causes = Object.keys(a.outcomes[0]?.all.failedBy ?? {});
  const causeRows = a.configurations.map((c) => {
    const o = a.outcomes.find((x) => x.configuration === c)!.all;
    return [short(c), o.failed, ...causes.map((k) => (o.failedBy as Record<string, number>)[k] ?? 0)];
  });
  const topErrors = a.configurations.map((c) => {
    const rows = (a.failureTaxonomy.byConfiguration as Record<string, Array<{ path: string; rule: string; first: number; retry: number }>>)[c] ?? [];
    const top = rows.slice(0, 3).map((r) => `\`${r.path}\` ${r.rule} (${r.first + r.retry})`);
    return [short(c), top.length ? top.join("; ") : "none"];
  });
  const candidates = a.candidates.filter((c) => Object.values(a.rescue.shapeIssues).some((m) => (m as Record<string, number>)[c]));
  const shapeRows = Object.entries(a.rescue.shapeIssues).map(([problem, m]) => [problem, ...candidates.map((c) => (m as Record<string, number>)[c] ?? 0)]);
  return [
    "Why each failed reply failed:",
    "",
    ...table(["Configuration", "Failed", ...causes], causeRows),
    "",
    "Every validator error of every refused attempt, across the self-hosted models (attempt 1, then the retry):",
    "",
    ...table(
      ["Field", "Rule", "First attempt", "Retry"],
      a.failureTaxonomy.overall.map((r) => [`\`${r.path}\``, r.rule, r.first, r.retry]),
    ),
    "",
    "Top validator errors per configuration (refused attempts):",
    "",
    ...table(["Configuration", "Top errors"], topErrors),
    "",
    "Every shape problem in the refused attempts (the validator stops at the first; these count all of them, in attempts):",
    "",
    ...table(["Problem", ...candidates.map(short)], shapeRows),
  ];
}

function retryBlock({ a }: Ctx): string[] {
  return table(
    ["Configuration", "Retried", "Fixed by the retry", "Same field and rule again", "A new error"],
    a.retry.map((r) => [short(r.configuration), r.retried, r.fixed, r.samePathAndRule, r.newError]),
  );
}

function rescueBlock({ a }: Ctx): string[] {
  const label = new Map(a.repairs.map((r) => [r.id, r]));
  const o = a.rescue.overall;
  const rows = o.cumulative
    .filter((step) => step.gain > 0 || (o.alone as Record<string, number>)[step.id]! > 0)
    .map((step, i) => {
      const r = label.get(step.id);
      return [
        i + 1,
        `\`${step.id}\``,
        r ? `${r.label}${r.lossy ? " (lossy)" : ""}` : "",
        (o.alone as Record<string, number>)[step.id] ?? 0,
        step.gain,
        step.total,
        (o.neededBy as Record<string, number>)[step.id] ?? 0,
      ];
    });
  const perModel = Object.entries(a.rescue.perModel as Record<string, { population: number; all: number }>)
    .filter(([, m]) => m.population > 0)
    .map(([c, m]) => `${short(c)} ${m.all} of ${m.population}`);
  const notWorkable = a.rescue.notWorkable.map((n) => `${short(n.configuration)} ${n.key}: ${n.cause} (${n.error})`);
  return [
    `${o.population} failed self-hosted replies had a refused attempt to work on; with every candidate repair, ${o.all} pass the real validators. Per configuration: ${perModel.join("; ")}.`,
    "",
    "Ranked in the greedy order (each repair added where it rescues the most replies not yet rescued):",
    "",
    ...table(["Rank", "Repair", "What it does", "Rescues alone", "Adds in this order", "Running total", "Needed by (rescued replies that fail without it)"], rows),
    "",
    `Still failing after every repair: ${a.rescue.stillFailing.length} replies.`,
    "",
    ...table(
      ["Configuration", "Input", "Attempt", "Remaining error"],
      a.rescue.stillFailing.map((s) => [short(s.configuration), s.key, s.attempt, `\`${s.error}\``]),
    ),
    "",
    `Failed with nothing to repair (no tool input to read): ${notWorkable.length ? notWorkable.join("; ") : "none"}.`,
  ];
}

function plansBlock({ a }: Ctx): string[] {
  const rows = a.plans.flatMap((p) =>
    (["valid", "rescued"] as const).flatMap((source) => {
      const s = p[source];
      if (!s.pairs) return [];
      return [
        [
          short(p.configuration),
          source === "valid" ? "valid as sent" : "rescued",
          s.pairs,
          spreadCells(s.distanceRatio),
          spreadCells(s.longRunRatio),
          s.dayTypeMatch.median === null ? "–" : `${Math.round(s.dayTypeMatch.median * 100)}%`,
          `${s.sameRestDays} of ${s.pairs}`,
          `${s.qualityBoth} both, ${s.qualityOnlyCandidate} only this model, ${s.qualityOnlyBaseline} only the baseline`,
          `${fmt(s.flags.candidate.median, 0)} vs ${fmt(s.flags.baseline.median, 0)}`,
          s.answersFewer,
          `${fmt(s.analysisChars.candidate.median, 0)} vs ${fmt(s.analysisChars.baseline.median, 0)}`,
        ],
      ];
    }),
  );
  return [
    "Weekly plans for the same input, this model against the baseline. Ratios are this model's figure over the baseline's; cells with three figures are median / p90 / highest.",
    "",
    ...table(
      [
        "Configuration",
        "Plans",
        "Pairs",
        "Weekly distance ratio",
        "Long-run ratio",
        "Day types that match (median)",
        "Same rest days",
        "Quality session",
        "Watching items, median (model vs baseline)",
        "Fewer answers than the baseline",
        "Full read, median characters (model vs baseline)",
      ],
      rows,
    ),
    "",
    `Big divergences: weekly distance or long run off by more than 25 %, day types matching on fewer than half the days, a quality session on one side only, or fewer answers (${a.divergences.length}, largest distance gap first):`,
    "",
    ...table(
      ["Configuration", "Input", "Plan", "Divergence"],
      a.divergences.map((d) => [short(d.configuration), d.key, d.source === "valid" ? "valid as sent" : "rescued", d.issues.join("; ")]),
    ),
  ];
}

function hardestBlock({ a }: Ctx): string[] {
  const cols = a.configurations;
  return [
    `${a.hardest.length} inputs failed in at least half the self-hosted models that ran them:`,
    "",
    ...table(
      ["Input", "Kind", "Source", ...cols.map(short)],
      a.hardest.map((d) => [d.key, OPERATION_LABEL[d.operation] ?? d.operation, scrub(String(d.source ?? "–")), ...cols.map((c) => (d.status as Record<string, string>)[c] ?? "–")]),
    ),
  ];
}

/**
 * The "after the changes" block (plan-as-text ticket 13). Null: no block is
 * supplied yet, so the body is left as it stands.
 */
function afterBlock(_ctx: Ctx): string[] | null {
  return null;
}

function packsIn(reviewDir: string): string[] {
  if (!existsSync(reviewDir)) return [];
  return readdirSync(reviewDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(reviewDir, e.name, "key.json")))
    .map((e) => path.join(reviewDir, e.name))
    .sort();
}

const JOIN_COMMAND = "npm run replay:publish -- --analysis ../.scratch/benchmark-analysis --doc ../docs/reports/local-models-2026-11.md";

function reviewBlock({ reviewDir }: Ctx): string[] {
  const packs = packsIn(reviewDir);
  const scored = packs.filter((p) => existsSync(path.join(p, "scores.json")));
  if (scored.length === 0) {
    return [
      `**Pending.** The blind scores are not in yet: ${packs.length} review pack${packs.length === 1 ? "" : "s"} written, none scored. Once each pack's \`scores.template.json\` has been copied to \`scores.json\` and filled in, run from \`api/\`:`,
      "",
      "```bash",
      JOIN_COMMAND,
      "```",
      "",
      "That joins the scores to each pack's key and replaces this block with mean scores and preference rates per model.",
    ];
  }
  return [
    `Scored ${scored.length} of ${packs.length} packs. Each rubric item is scored 1 to 5 per reply; the margin is the model's total minus the baseline's.`,
    "",
    ...packs.flatMap((p) => candidateResults(p).map((line) => scrub(line.replace(/\b(anthropic|self_hosted)--/g, "")))),
  ];
}

/** Section 9 of the analysis, without its heading; null (left as it stands) when the analysis was made without --judge. */
function coachingBlock({ a }: Ctx): string[] | null {
  return a.coaching ? coachingBody(a.coaching, { table, short, fmt }).map(scrub) : null;
}

/** Each block's renderer; one that returns null leaves the block's body as it stands. */
const BLOCKS: Record<string, (ctx: Ctx) => string[] | null> = {
  setup: setupBlock,
  results: resultsBlock,
  failures: failuresBlock,
  retry: retryBlock,
  rescue: rescueBlock,
  plans: plansBlock,
  hardest: hardestBlock,
  review: reviewBlock,
  after: afterBlock,
  coaching: coachingBlock,
};

// ---- Rewriting ---------------------------------------------------------------------------

const MARKER = /<!-- generated:([\w-]+):(start|end) -->/g;

/** The report with each known block's body replaced; everything else as it was. */
function rewrite(doc: string, ctx: Ctx): { doc: string; replaced: string[]; kept: string[]; missing: string[] } {
  const markers = [...doc.matchAll(MARKER)].map((m) => ({ name: m[1]!, kind: m[2]!, index: m.index!, length: m[0].length }));
  const replaced: string[] = [];
  const kept: string[] = [];
  let out = "";
  let at = 0;
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!;
    const end = markers[i + 1];
    if (start.kind !== "start") throw new Error(`generated:${start.name}:end has no start before it`);
    if (!end || end.kind !== "end" || end.name !== start.name) throw new Error(`generated:${start.name}:start is not followed by its own end marker`);
    const render = BLOCKS[start.name];
    if (!render) throw new Error(`generated:${start.name} is not a known block (known: ${Object.keys(BLOCKS).join(", ")})`);
    if (replaced.includes(start.name) || kept.includes(start.name)) throw new Error(`generated:${start.name} appears twice`);
    const body = render(ctx);
    if (body === null) {
      out += doc.slice(at, end.index);
      kept.push(start.name);
    } else {
      out += doc.slice(at, start.index + start.length) + "\n" + body.join("\n") + "\n";
      replaced.push(start.name);
    }
    at = end.index;
    i++;
  }
  out += doc.slice(at);
  return { doc: out, replaced, kept, missing: Object.keys(BLOCKS).filter((b) => !replaced.includes(b) && !kept.includes(b)) };
}

function main(): void {
  const file = path.join(ANALYSIS, "analysis.json");
  if (!existsSync(file)) throw new Error(`No analysis.json in ${ANALYSIS}; run npm run replay:analyse first.`);
  const a = JSON.parse(readFileSync(file, "utf8")) as AnalysisFile;
  if (!a.setup) throw new Error(`${file} has no setup; rerun npm run replay:analyse with this version.`);
  if (!existsSync(DOC)) throw new Error(`No report at ${DOC}.`);
  const text = readFileSync(DOC, "utf8");
  if (a.coaching && !text.includes("<!-- generated:coaching:start -->")) {
    throw new Error(`${file} carries coaching scores (made with --judge) and ${path.basename(DOC)} has no coaching block; publish it only to the coaching report, never over another report's blocks.`);
  }
  const { doc, replaced, kept, missing } = rewrite(text, { a, reviewDir: REVIEW });
  if (DRY_RUN) process.stdout.write(doc);
  else writeFileSync(DOC, doc);
  console.error(`${DRY_RUN ? "Would rewrite" : "Rewrote"} ${replaced.length} block${replaced.length === 1 ? "" : "s"} in ${path.basename(DOC)}: ${replaced.join(", ") || "none"}.`);
  if (kept.length) console.error(`Left as they stand (no block supplied yet): ${kept.join(", ")}.`);
  if (missing.length) console.error(`Not in the report, skipped: ${missing.join(", ")}.`);
}

main();
