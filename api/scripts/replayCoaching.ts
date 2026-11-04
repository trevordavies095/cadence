/**
 * The coaching section of the replay analysis (scripts/replay-analysis.ts,
 * section 9, coaching-quality ticket 10): the judge's scores of the replies
 * (ticket 09) per configuration, beside the coach's own ratings from the
 * answer key (ticket 08) where he rated the same draft. Pure apart from the
 * two readers; makes no calls.
 *
 * The judge's scores sit one file per scored reply under the judge
 * configuration's folder, `<judge dir>/<root>/<configuration>/<NN>.<R>.json`,
 * each one overall rating 1 to 5 and an unsafe flag. A `calibration.json`
 * in the folder above may hold each judge's agreement with the coach; the
 * chosen judge's line heads the section.
 *
 * The pick: per input and repeat, among the configurations' replies the
 * judge scored, the one rated highest among those not unsafe; ties share the
 * pick, and none is picked when every reply is unsafe. A configuration's pick
 * rate is its share of the picks over the input-and-repeat pairs it was
 * scored on, counting only pairs with at least two configurations scored.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spread, type Spread } from "./replayAnalysisStats.js";

// ---- Inputs ---------------------------------------------------------------------------

/** One saved judge score, as ticket 09 writes it; only the fields read here. */
export type JudgeScore = {
  /** `<root>/<NN>`, the analysis's input key. */
  input: string;
  configuration: string;
  repeat: number;
  outcome: "ok" | "failed";
  rating: number | null;
  unsafe: boolean | null;
  judge?: { provider?: string; model?: string; effort?: string } | null;
};

/** One judge's agreement with the coach, as calibration.json records it. */
export type CalibrationLine = {
  judge: unknown;
  casesCompared: number | null;
  pickAgreement: number | null;
  unsafeRecall: number | null;
  unsafePrecision: number | null;
  ratingMad: number | null;
  ratingWithinOne: number | null;
  meetsBar: boolean | null;
  bar: unknown;
};

export type JudgeRead = {
  /** The judge configuration's folder name, e.g. anthropic--claude-opus-5-5--high. */
  configuration: string;
  scores: JudgeScore[];
  calibration: CalibrationLine | null;
  warnings: string[];
};

type KeyDraft = { draft: string; configuration: string; repeat: number; rating: number | null; unsafe: boolean | null };
export type AnswerKey = {
  generatedAt?: string;
  formSeed?: number;
  reviewers: Array<{
    reviewer: "coach" | "user";
    submittedAt?: string;
    cases: Array<{ case: number; input: string; answered: boolean; pick: string | null; comment?: string | null; drafts: KeyDraft[] }>;
  }>;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function judgeName(j: unknown): string | null {
  if (typeof j === "string") return j;
  if (j && typeof j === "object") {
    const o = j as { configuration?: string; provider?: string; model?: string; effort?: string };
    if (o.configuration) return o.configuration;
    if (o.provider && o.model && o.effort) return `${o.provider}--${o.model}--${o.effort}`;
  }
  return null;
}

/** The named judge's line from calibration.json: an array, `{judges: [...]}`, or an object keyed by judge. */
function calibrationFor(file: string, configuration: string): CalibrationLine | null {
  if (!existsSync(file)) return null;
  const raw = readJson(file);
  if (!raw || typeof raw !== "object") return null;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { judges?: unknown }).judges)
      ? (raw as { judges: unknown[] }).judges
      : Object.entries(raw as Record<string, unknown>).map(([k, v]) => (v && typeof v === "object" ? { judge: k, ...(v as object) } : null));
  const line = list.find((x) => x && typeof x === "object" && judgeName((x as { judge?: unknown }).judge) === configuration) as Partial<CalibrationLine> | undefined;
  if (!line) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    judge: line.judge,
    casesCompared: num(line.casesCompared),
    pickAgreement: num(line.pickAgreement),
    unsafeRecall: num(line.unsafeRecall),
    unsafePrecision: num(line.unsafePrecision),
    ratingMad: num(line.ratingMad),
    ratingWithinOne: num(line.ratingWithinOne),
    meetsBar: typeof line.meetsBar === "boolean" ? line.meetsBar : null,
    bar: line.bar ?? null,
  };
}

/**
 * Every score file under one judge configuration's folder. The input,
 * configuration and repeat come from the file's place; a file that does not
 * read, or holds a rating outside 1 to 5, is listed and left out.
 */
export function readJudgeDir(judgeDir: string): JudgeRead {
  const dir = path.resolve(judgeDir);
  const configuration = path.basename(dir);
  const warnings: string[] = [];
  const scores: JudgeScore[] = [];
  if (!existsSync(dir)) throw new Error(`--judge ${dir} does not exist.`);
  const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const root of dirs(dir)) {
    for (const config of dirs(path.join(dir, root))) {
      const files = readdirSync(path.join(dir, root, config)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const f of files) {
        const m = /^(\d+)\.(\d+)\.json$/.exec(f);
        if (!m) continue;
        const file = path.join(root, config, f);
        const s = readJson(path.join(dir, file)) as Partial<JudgeScore> | null;
        if (!s || typeof s !== "object") {
          warnings.push(`judge ${file}: does not read; skipped`);
          continue;
        }
        const ok = s.outcome === "ok";
        const rating = typeof s.rating === "number" ? s.rating : null;
        if (ok && (rating === null || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
          warnings.push(`judge ${file}: outcome ok with rating ${JSON.stringify(s.rating)}; skipped`);
          continue;
        }
        scores.push({
          input: `${root}/${m[1]}`,
          configuration: config,
          repeat: Number(m[2]),
          outcome: ok ? "ok" : "failed",
          rating: ok ? rating : null,
          unsafe: ok && typeof s.unsafe === "boolean" ? s.unsafe : null,
          judge: s.judge ?? null,
        });
      }
    }
  }
  // replay:judge writes calibration.json beside baseline-scores/, one folder above the judge's own.
  const beside = path.join(path.dirname(dir), "calibration.json");
  const above = path.join(path.dirname(path.dirname(dir)), "calibration.json");
  const calibrationFile = !existsSync(beside) && path.basename(path.dirname(dir)) === "baseline-scores" ? above : beside;
  return { configuration, scores, calibration: calibrationFor(calibrationFile, configuration), warnings };
}

/** The answer key, or null when the file is not there (no coach columns). */
export function readAnswerKey(file: string): AnswerKey | null {
  if (!existsSync(file)) return null;
  const key = readJson(file) as AnswerKey | null;
  if (!key || !Array.isArray(key.reviewers)) throw new Error(`${file} is not an answer key (no reviewers).`);
  return key;
}

// ---- The pick ----------------------------------------------------------------------------

const pairKey = (s: { input: string; repeat: number }) => `${s.input}|${s.repeat}`;

/**
 * Per input and repeat (`<input>|<repeat>`), each scored configuration's share
 * of the pick: the highest rating among the replies not unsafe, ties
 * sharing, none when every reply is unsafe. Failed scores are left out, and
 * a pair needs two scored configurations to be a comparison.
 */
export function picksOf(scores: JudgeScore[]): Map<string, Map<string, number>> {
  const pairs = new Map<string, JudgeScore[]>();
  for (const s of scores) {
    if (s.outcome !== "ok" || s.rating === null) continue;
    const k = pairKey(s);
    pairs.set(k, [...(pairs.get(k) ?? []), s]);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [k, ss] of pairs) {
    if (new Set(ss.map((s) => s.configuration)).size < 2) continue;
    const eligible = ss.filter((s) => s.unsafe !== true);
    const best = eligible.length ? Math.max(...eligible.map((s) => s.rating!)) : null;
    const winners = eligible.filter((s) => s.rating === best);
    out.set(k, new Map(ss.map((s) => [s.configuration, winners.includes(s) ? 1 / winners.length : 0])));
  }
  return out;
}

// ---- The section ---------------------------------------------------------------------------

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export type CoachBeside = {
  /** Drafts the coach rated that the judge also scored. */
  drafts: number;
  coachMean: number | null;
  judgeMean: number | null;
  /** Judge minus coach, on those drafts. */
  difference: number | null;
  /** Drafts both flagged yes or no on. */
  unsafeDrafts: number;
  coachUnsafe: number;
  judgeUnsafe: number;
};

export function coachingSection(p: {
  judge: JudgeRead;
  key: AnswerKey | null;
  /** The analysis's configurations, in its order; configurations only the judge scored follow. */
  configurations: string[];
  /** The control configuration (the analysis's baseline). */
  control: string;
  /** The root folder names the analysis read; scores for other roots are left out. */
  roots: string[];
  /** The answer key's file name, for the section's words. */
  keyFile?: string;
}) {
  const warnings = [...p.judge.warnings];
  const scores = p.judge.scores.filter((s) => p.roots.includes(s.input.split("/")[0]!));
  const outside = p.judge.scores.length - scores.length;
  if (outside) warnings.push(`${outside} judge scores for roots not analysed (${p.roots.join(", ")}); left out`);
  const configurations = [...p.configurations, ...[...new Set(scores.map((s) => s.configuration))].filter((c) => !p.configurations.includes(c)).sort()];
  const okOf = (c: string) => scores.filter((s) => s.configuration === c && s.outcome === "ok");
  const picks = picksOf(scores);
  const judged = new Map(scores.filter((s) => s.outcome === "ok").map((s) => [`${s.input}|${s.configuration}|${s.repeat}`, s]));
  const coachDrafts = (p.key?.reviewers ?? [])
    .filter((r) => r.reviewer === "coach")
    .flatMap((r) => r.cases.flatMap((k) => k.drafts.map((d) => ({ ...d, input: k.input }))));

  const rows = configurations.map((c) => {
    const ok = okOf(c);
    const ratings = ok.map((s) => s.rating!);
    const repeats = [...new Set(ok.map((s) => s.repeat))].sort((a, b) => a - b);
    const inputs = [...new Set(ok.map((s) => s.input))];
    const ranges = inputs.flatMap((i) => {
      const r = ok.filter((s) => s.input === i).map((s) => s.rating!);
      return r.length >= 2 ? [Math.max(...r) - Math.min(...r)] : [];
    });
    const mine = [...picks.values()].filter((m) => m.has(c));
    const picked = mine.reduce((n, m) => n + m.get(c)!, 0);
    let coach: CoachBeside | null = null;
    if (p.key) {
      const rated = coachDrafts.filter((d) => d.configuration === c && d.rating !== null && judged.has(`${d.input}|${c}|${d.repeat}`));
      const flagged = coachDrafts.filter((d) => d.configuration === c && d.unsafe !== null && judged.get(`${d.input}|${c}|${d.repeat}`)?.unsafe != null);
      const coachMean = mean(rated.map((d) => d.rating!));
      const judgeMean = mean(rated.map((d) => judged.get(`${d.input}|${c}|${d.repeat}`)!.rating!));
      coach = {
        drafts: rated.length,
        coachMean,
        judgeMean,
        difference: coachMean === null || judgeMean === null ? null : judgeMean - coachMean,
        unsafeDrafts: flagged.length,
        coachUnsafe: flagged.filter((d) => d.unsafe).length,
        judgeUnsafe: flagged.filter((d) => judged.get(`${d.input}|${c}|${d.repeat}`)!.unsafe).length,
      };
    }
    const unsafe = ok.filter((s) => s.unsafe === true).length;
    return {
      configuration: c,
      scored: ok.length,
      failed: scores.filter((s) => s.configuration === c && s.outcome === "failed").length,
      meanRating: mean(ratings),
      /** The mean rating and the unsafe replies of each repeat: how far a configuration's level moves between runs (the coaching gate's band). */
      repeatMeans: repeats.map((r) => {
        const x = ok.filter((s) => s.repeat === r);
        return { repeat: r, n: x.length, mean: mean(x.map((s) => s.rating!))!, unsafe: x.filter((s) => s.unsafe === true).length };
      }),
      /** Per input with two or more rated repeats, the highest rating minus the lowest. */
      repeatRange: spread(ranges) as Spread,
      unsafe,
      unsafeShare: ok.length ? unsafe / ok.length : null,
      picks: { groups: mine.length, picked, rate: mine.length ? picked / mine.length : null },
      coach,
    };
  });

  const inputKeys = [...new Set(scores.map((s) => s.input))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const perInput = inputKeys.map((input) => ({
    input,
    byConfiguration: Object.fromEntries(
      configurations.flatMap((c) => {
        const ok = okOf(c).filter((s) => s.input === input);
        return ok.length ? [[c, { scored: ok.length, meanRating: mean(ok.map((s) => s.rating!)), unsafe: ok.filter((s) => s.unsafe === true).length }]] : [];
      }),
    ) as Record<string, { scored: number; meanRating: number | null; unsafe: number }>,
  }));

  const controlMean = rows.find((r) => r.configuration === p.control)?.meanRating ?? null;
  const gaps =
    controlMean === null
      ? []
      : rows.filter((r) => r.configuration !== p.control && r.meanRating !== null).map((r) => ({ configuration: r.configuration, gap: controlMean - r.meanRating! }));
  const largestGap = gaps.length ? gaps.reduce((a, b) => (b.gap > a.gap ? b : a)) : null;
  const bestCheaper = gaps.length ? gaps.reduce((a, b) => (b.gap < a.gap ? b : a)) : null;
  const unsafeByInput = perInput.map((x) => ({
    input: x.input,
    unsafe: Object.values(x.byConfiguration).reduce((n, v) => n + v.unsafe, 0),
    replies: Object.values(x.byConfiguration).reduce((n, v) => n + v.scored, 0),
  }));
  const mostUnsafe = unsafeByInput.reduce<(typeof unsafeByInput)[number] | null>((a, b) => (b.unsafe > (a?.unsafe ?? 0) ? b : a), null);

  const first = scores.find((s) => s.judge)?.judge ?? null;
  return {
    judge: { configuration: p.judge.configuration, provider: first?.provider ?? null, model: first?.model ?? null, effort: first?.effort ?? null },
    calibration: p.judge.calibration,
    /** The answer key's file name, and the drafts the coach rated or flagged; answerKey null when there is no key. */
    answerKeyFile: p.keyFile ?? null,
    answerKey: p.key ? { coachDrafts: coachDrafts.filter((d) => d.rating !== null || d.unsafe !== null).length } : null,
    configurations: rows,
    perInput,
    headline: { control: p.control, controlMean, largestGap, bestCheaper, mostUnsafeInput: mostUnsafe },
    warnings,
  };
}

export type CoachingSection = ReturnType<typeof coachingSection>;

// ---- Writing -----------------------------------------------------------------------------

/** The analysis's table helpers (scripts/replay-analysis.ts), passed in so this module does not import the script. */
export type Writers = {
  table: (header: string[], rows: Array<Array<unknown>>) => string[];
  short: (c: string) => string;
  fmt: (n: number | null | undefined, digits?: number) => string;
};

const share = (x: number | null) => (x === null ? "–" : `${Math.round(100 * x)}%`);
const signed = (x: number | null) => (x === null ? "–" : `${x > 0 ? "+" : ""}${x.toFixed(2)}`);
const rating = (x: number | null) => (x === null ? "–" : x.toFixed(2));

function barText(bar: unknown): string {
  if (!bar || typeof bar !== "object") return bar ? String(bar) : "";
  const b = bar as Record<string, unknown>;
  const parts = [
    typeof b.pickAgreement === "number" ? `pick agreement at least ${share(b.pickAgreement)}` : null,
    typeof b.unsafeRecall === "number" ? `unsafe recall at least ${share(b.unsafeRecall)}` : null,
    typeof b.ratingMad === "number" ? `rating MAD at most ${b.ratingMad.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : JSON.stringify(bar);
}

/** The line under the heading: who the judge is and how much it is trusted. */
export function judgeLine(c: CoachingSection): string {
  const who = `Judge \`${c.judge.configuration}\`${c.judge.model ? ` (${c.judge.model}, effort ${c.judge.effort ?? "–"})` : ""}.`;
  const k = c.calibration;
  if (!k) return `${who} No calibration line for this judge: judge not calibrated, so read these numbers as unchecked against the coach.`;
  const bar = barText(k.bar);
  return `${who} Calibration against the coach over ${k.casesCompared ?? "–"} cases: pick agreement ${share(k.pickAgreement)}, unsafe recall ${share(k.unsafeRecall)}, unsafe precision ${share(k.unsafePrecision)}, rating mean absolute difference ${k.ratingMad === null ? "–" : k.ratingMad.toFixed(2)} (within one point ${share(k.ratingWithinOne)}); ${k.meetsBar === null ? "bar not recorded" : k.meetsBar ? "meets the bar" : "does not meet the bar"}${bar ? ` (${bar})` : ""}.`;
}

/** False when the judge's calibration bar leaves picks out (pickAgreement null): its ratings are too flat to rank replies, so no pick rate is shown. */
export function judgePicksUsed(c: CoachingSection): boolean {
  const bar = c.calibration?.bar;
  return !(bar && typeof bar === "object" && (bar as Record<string, unknown>).pickAgreement === null);
}

/** The section's body without its heading: the judge's line and the two tables. The publisher's `coaching` block is this. */
export function coachingBody(c: CoachingSection, w: Writers): string[] {
  const L: string[] = [judgeLine(c), ""];
  const withCoach = c.answerKey !== null;
  const picks = judgePicksUsed(c);
  L.push(
    `Per configuration, over every reply the judge scored: the mean rating (1 to 5) over all repeats, each repeat's mean, and per input the highest rating minus the lowest over its repeats (median / p90 / worst). Unsafe: replies the judge flagged. ${
      picks
        ? "Pick rate: per input and repeat, the reply rated highest among those not unsafe (ties share the pick), over the pairs this configuration was scored on with at least one other."
        : "No pick rate: the judge's calibration leaves picks out, as its ratings are too flat to rank replies; picks come from the coach's form answers only."
    }${
      withCoach ? " Coach: the drafts he rated on the form, the judge's rating of the same drafts, and the judge minus the coach." : ""
    }`,
    "",
  );
  if (!withCoach) L.push(`No answer key at ${c.answerKeyFile ?? "the answer key's place"}: no coach columns.`, "");
  L.push(
    ...w.table(
      [
        "Configuration",
        "Replies scored",
        "Judge failed",
        "Mean rating",
        "Repeat means",
        "Range over repeats, per input",
        "Unsafe",
        "Unsafe share",
        ...(picks ? ["Pick rate"] : []),
        ...(withCoach ? ["Coach-rated drafts", "Coach mean", "Judge mean, same drafts", "Judge - coach", "Unsafe, coach / judge"] : []),
      ],
      c.configurations.map((r) => [
        w.short(r.configuration),
        r.scored,
        r.failed,
        rating(r.meanRating),
        r.repeatMeans.map((x) => `r${x.repeat} ${x.mean.toFixed(2)}`).join(", ") || "–",
        `${w.fmt(r.repeatRange.median)} / ${w.fmt(r.repeatRange.p90)} / ${w.fmt(r.repeatRange.worst)}`,
        r.unsafe,
        share(r.unsafeShare),
        ...(picks ? [r.picks.groups ? `${share(r.picks.rate)} (${w.fmt(r.picks.picked, 1)} of ${r.picks.groups})` : "–"] : []),
        ...(withCoach && r.coach
          ? [r.coach.drafts, rating(r.coach.coachMean), rating(r.coach.judgeMean), signed(r.coach.difference), `${r.coach.coachUnsafe} / ${r.coach.judgeUnsafe} of ${r.coach.unsafeDrafts}`]
          : []),
      ]),
    ),
    "",
  );
  L.push("### Coaching per input", "", "Each configuration's mean rating over its repeats on the input, and its unsafe replies.", "");
  L.push(
    ...w.table(
      ["Input", ...c.configurations.map((r) => w.short(r.configuration))],
      c.perInput.map((x) => [
        x.input,
        ...c.configurations.map((r) => {
          const v = x.byConfiguration[r.configuration];
          return v ? `${rating(v.meanRating)}${v.unsafe ? `, ${v.unsafe} unsafe` : ""}` : "–";
        }),
      ]),
    ),
  );
  return L;
}

/** Section 9 of analysis.md. */
export function coachingMarkdown(c: CoachingSection, w: Writers): string[] {
  return ["## 9. Coaching", "", ...coachingBody(c, w), ""];
}

/**
 * The section's line for "What to change in the harness": the largest gap
 * between the control and a cheaper configuration, and the input with the
 * most unsafe replies, which the harness tweaks (ticket 11) aim at. Ranked by
 * the gap in tenths of a point and the unsafe replies on that input.
 */
export function coachingHarnessItem(c: CoachingSection, short: (c: string) => string): { score: number; text: string } | null {
  const h = c.headline;
  if (!h.largestGap && !h.mostUnsafeInput) return null;
  const gap = h.largestGap
    ? `against the control ${short(h.control)} (mean ${rating(h.controlMean)}), ${short(h.largestGap.configuration)} is ${h.largestGap.gap.toFixed(2)} below, the largest gap${
        h.bestCheaper && h.bestCheaper.configuration !== h.largestGap.configuration ? `; the closest cheaper is ${short(h.bestCheaper.configuration)} at ${h.bestCheaper.gap.toFixed(2)}` : ""
      }.`
    : "the control has no scored replies, so there is no gap to name.";
  const unsafe = h.mostUnsafeInput ? ` Most unsafe replies on one input: ${h.mostUnsafeInput.input}, ${h.mostUnsafeInput.unsafe} of ${h.mostUnsafeInput.replies}.` : " No reply was flagged unsafe.";
  return {
    score: Math.round(Math.max(0, h.largestGap?.gap ?? 0) * 10) * 10 + (h.mostUnsafeInput?.unsafe ?? 0) * 50,
    text: `**Coaching (judge \`${c.judge.configuration}\`):** ${gap}${unsafe}\n   Read that input's unsafe replies and the cheaper configuration's lowest-rated ones first; they are what the harness tweaks (coaching-quality ticket 11) aim at. See section 9.`,
  };
}
