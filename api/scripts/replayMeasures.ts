/**
 * The replay report's measures per configuration (self-hosted ticket 15): what
 * says where a person should look first. Pure: the harness gathers one record
 * per saved reply file and this module turns them into measures.json and the
 * report's tables, so `--report-only` recomputes everything from the files.
 */
import type { PrescribedWeek } from "../src/llm/types.js";
import { PROBE_CUT_RATIO } from "../src/settings/selfHostedConnectionTest.js";

// ---- Price table -----------------------------------------------------------------

/**
 * Anthropic list prices, in US dollars per million tokens, from
 * platform.claude.com/docs/en/about-claude/pricing (Opus 4.7 taken 2026-11-01,
 * the 5.5 models and Fable 5.1, the candidate coaching judge, 2026-11-03).
 * Cache reads and writes are priced from the input price: a cache write at
 * 1.25x (the 5-minute cache; the call log does not say which cache a write went
 * to), a cache read at 0.1x unless the model sets its own (Opus 5.5 and Sonnet
 * 5.5 read at 0.05x, Fable 5.1 at 0.025x). Haiku 5.5 is the up-to-100,000-
 * token tier; a coach prompt is well under it. Thinking tokens are billed as
 * output and are already inside output_tokens.
 */
export const PRICE_TABLE = {
  takenOn: "2026-11-03",
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  models: {
    "claude-opus-4-7": { label: "Opus 4.7", inputPerMTok: 5, outputPerMTok: 25 },
    "claude-opus-5-5": { label: "Opus 5.5", inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 },
    "claude-sonnet-5-5": { label: "Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.05 },
    "claude-haiku-5-5": { label: "Haiku 5.5", inputPerMTok: 0.1, outputPerMTok: 0.5 },
    "claude-fable-5-1": { label: "Fable 5.1", inputPerMTok: 10, outputPerMTok: 50, cacheReadMultiplier: 0.025 },
  } as Record<string, { label: string; inputPerMTok: number; outputPerMTok: number; cacheReadMultiplier?: number }>,
};

/** A model's cache-read multiplier: its own, else the standard one. */
export function cacheReadMultiplierFor(price: { cacheReadMultiplier?: number }): number {
  return price.cacheReadMultiplier ?? PRICE_TABLE.cacheReadMultiplier;
}

// ---- Plan sanity -----------------------------------------------------------------

/**
 * The plausible band for a weekly plan's distance, as a share of the packet's
 * recent weekly distance (the last four weeks' average from its reports).
 * Outside it the plan is flagged for a person to read, not failed.
 */
export const PLAN_VOLUME_BAND = { low: 0.5, high: 1.6 } as const;

/** What the harness saved beside a weekly reply to check its plan against. */
export type PlanExpectation = {
  /** The plan week's Monday, YYYY-MM-DD. */
  weekStartMonday: string;
  /** The plan week's ISO id, such as 2026-W42; null when the packet does not say. */
  isoWeek: string | null;
  /** The packet's recent weekly distance in meters; null when its reports do not say. */
  recentWeeklyM: number | null;
};

export type PlanSanityCheck = "seven days" | "dates" | "run days" | "volume";
export type PlanSanityFlag = { check: PlanSanityCheck; detail: string };
export type PlanSanity = {
  flags: PlanSanityFlag[];
  /** Checks that could not run: no expectation saved, no recent distance, a plan by time only. */
  skipped: PlanSanityCheck[];
  /** Planned distance in meters, the sum of the runs. */
  plannedM: number | null;
  /** Planned over recent weekly distance; null when the volume check was skipped. */
  ratio: number | null;
};

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/**
 * Plan sanity for one weekly reply: seven days; the dates (and week id) match
 * the expected plan week; every day that is not rest or other carries a run;
 * the planned distance sits within PLAN_VOLUME_BAND of recent volume.
 */
export function planSanity(week: PrescribedWeek | undefined, expect: PlanExpectation | null | undefined): PlanSanity {
  const flags: PlanSanityFlag[] = [];
  const skipped: PlanSanityCheck[] = [];
  const days = week?.days ?? [];
  if (days.length !== 7) flags.push({ check: "seven days", detail: `${days.length} days` });
  if (!expect) {
    skipped.push("dates");
  } else {
    const wrong = days
      .map((d, i) => ({ d, want: addDaysYmd(expect.weekStartMonday, i) }))
      .filter(({ d, want }) => d.date !== want)
      .map(({ d, want }) => `${d.date} for ${want}`);
    if (expect.isoWeek && week?.week !== expect.isoWeek) wrong.unshift(`week ${week?.week ?? "missing"} for ${expect.isoWeek}`);
    if (wrong.length) flags.push({ check: "dates", detail: wrong.join(", ") });
  }
  const runless = days.filter((d) => d.dayType !== "rest" && d.dayType !== "other" && !d.run);
  if (runless.length) {
    flags.push({ check: "run days", detail: runless.map((d) => `${d.date} (${d.dayType}) has no run`).join(", ") });
  }
  const plannedM = days.reduce((n, d) => n + (d.run?.distanceM ?? 0), 0);
  let ratio: number | null = null;
  if (!expect?.recentWeeklyM || plannedM <= 0) {
    skipped.push("volume");
  } else {
    ratio = plannedM / expect.recentWeeklyM;
    if (ratio < PLAN_VOLUME_BAND.low || ratio > PLAN_VOLUME_BAND.high) {
      flags.push({
        check: "volume",
        detail: `${(plannedM / 1000).toFixed(1)} km planned is ${ratio.toFixed(2)}x the recent ${(expect.recentWeeklyM / 1000).toFixed(1)} km`,
      });
    }
  }
  return { flags, skipped, plannedM: days.length ? plannedM : null, ratio };
}

// ---- Repairs and length caps -----------------------------------------------------

/** A repair's or refusal's field path with list indices dropped: flags[2].title -> flags[].title. */
function fieldOf(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/** The fields the length caps are reported by. */
const CAP_FIELDS: Array<[RegExp, string]> = [
  [/^headline$/, "headline"],
  [/^flags\[\]\.title$/, "flag title"],
  [/^flags\[\]\.detail$/, "flag detail"],
  [/^analysis$/, "analysis"],
  [/^body$/, "mid-week body"],
  [/\.notes$/, "day notes"],
  [/^proposedBody$/, "dossier body"],
  [/^summaryBullets(\[\])?$/, "summary bullets"],
  [/^settingsProposalBullets(\[\])?$/, "About you suggestions"],
  [/^safetyCallouts\[\]\.title$/, "safety callout title"],
  [/^safetyCallouts\[\]\.body$/, "safety callout body"],
];

function capField(path: string): string {
  const field = fieldOf(path);
  return CAP_FIELDS.find(([re]) => re.test(field))?.[1] ?? field;
}

/** The soft repairs in a reply's call-log note ("; "-joined), each with its field. */
export function repairsOf(note: string | null | undefined): Array<{ field: string; text: string }> {
  if (!note) return [];
  return note
    .split("; ")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ field: fieldOf(text.split(/\s/, 1)[0]!), text }));
}

/**
 * Length caps a reply hit, by field: a soft field the validator cut ("... cut
 * from N to M chars"), and an attempt refused for a field past its hard cap
 * ("... must be at most N characters"). Over-target notes are soft repairs, not caps.
 */
export function capHitsOf(note: string | null | undefined, refusalErrors: string[]): string[] {
  const fromRepairs = repairsOf(note)
    .filter((r) => / cut from \d+ to \d+ chars/.test(r.text))
    .map((r) => capField(r.text.split(/\s/, 1)[0]!));
  const fromRefusals = refusalErrors.flatMap((e) =>
    [...e.matchAll(/(\S+) must be at most \d+ characters/g)].map((m) => capField(m[1]!)),
  );
  return [...fromRepairs, ...fromRefusals];
}

// ---- Usage, prompt cut and cost --------------------------------------------------

/** One attempt's usage as the call log records it; any part may be missing. */
export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

/**
 * The harness's own count of a Messages request's prompt, by the probe's rule:
 * the characters of the system prompt and the messages, divided by 4 and
 * rounded. Null for a request that is not a Messages body (the dry run's stub).
 */
export function estimatePromptTokens(request: unknown): number | null {
  if (!request || typeof request !== "object" || !Array.isArray((request as { messages?: unknown }).messages)) return null;
  const text = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce((n: number, b) => n + text((b as { text?: unknown } | null)?.text ?? ""), 0);
    return 0;
  };
  const body = request as { system?: unknown; messages: Array<{ content?: unknown }> };
  const chars = text(body.system) + body.messages.reduce((n, m) => n + text(m?.content), 0);
  return chars > 0 ? Math.round(chars / 4) : null;
}

/**
 * Whether the server read less than the prompt it was sent: reported input
 * (cache reads and writes included) under PROBE_CUT_RATIO of the estimate.
 * Null when either number is missing.
 */
export function promptCut(usage: Usage, estimate: number | null): { cut: boolean; ratio: number } | null {
  if (estimate === null || usage.inputTokens === null) return null;
  const reported = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const ratio = reported / estimate;
  return { cut: ratio < PROBE_CUT_RATIO, ratio };
}

/** One attempt's cost in dollars from the price table; null for a model it lacks, or no usage. */
export function attemptCostUsd(model: string | null, usage: Usage): number | null {
  const price = model ? PRICE_TABLE.models[model] : undefined;
  if (!price || (usage.inputTokens === null && usage.outputTokens === null)) return null;
  const inPrice = price.inputPerMTok / 1e6;
  return (
    (usage.inputTokens ?? 0) * inPrice +
    (usage.cacheReadTokens ?? 0) * inPrice * cacheReadMultiplierFor(price) +
    (usage.cacheCreationTokens ?? 0) * inPrice * PRICE_TABLE.cacheWriteMultiplier +
    (usage.outputTokens ?? 0) * (price.outputPerMTok / 1e6)
  );
}

// ---- One configuration's measures ------------------------------------------------

/** What the harness gathers from one reply file (accepted or refused). */
export type ReplyRecord = {
  /** The file stem, such as 01.2. */
  id: string;
  operation: string;
  accepted: boolean;
  /** Accepted only after asking once more. */
  retried: boolean;
  model: string | null;
  /** The call log's repair note for the accepted attempt. */
  repairs: string | null;
  /** The error of every attempt refused for its shape. */
  refusalErrors: string[];
  /** The last attempt's usage. */
  usage: Usage;
  /** The usage of every attempt, the refused ones included, for the cost. */
  attemptUsages: Usage[];
  thinkingChars: number | null;
  estimatedInputTokens: number | null;
  /** The first attempt's time to first token; null on a dry run or when none came. */
  ttftMs: number | null;
  /** Wall-clock of the whole call, any retry included. */
  totalMs: number | null;
  goalCheckFailures: string[];
  bannedTerms: string[];
  /** Weekly replies that came back only; null otherwise. */
  plan: PlanSanity | null;
};

type Stat = { median: number | null; worst: number | null; n: number };

function present(values: Array<number | null>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function median(values: Array<number | null>): number | null {
  const v = present(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function stat(values: Array<number | null>): Stat {
  const v = present(values);
  return { median: median(v), worst: v.length ? Math.max(...v) : null, n: v.length };
}

function medianOf(values: Array<number | null>): { median: number | null; n: number } {
  return { median: median(values), n: present(values).length };
}

function tally(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

function sum(values: Array<number | null>): number | null {
  const v = present(values);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

export type Measures = ReturnType<typeof configurationMeasures>;

/** Every measure for one configuration: what measures.json holds. */
export function configurationMeasures(configuration: string, provider: string, records: ReplyRecord[]) {
  const accepted = records.filter((r) => r.accepted);
  const repairs = accepted.flatMap((r) => repairsOf(r.repairs));
  const caps = records.flatMap((r) => capHitsOf(r.accepted ? r.repairs : null, r.refusalErrors));
  const weekly = records.filter((r): r is ReplyRecord & { plan: PlanSanity } => r.plan !== null);
  const planFlags = weekly.flatMap((r) => r.plan.flags.map((f) => ({ reply: r.id, ...f })));
  const cuts = records.flatMap((r) => {
    const c = promptCut(r.usage, r.estimatedInputTokens);
    return c ? [{ id: r.id, ...c }] : [];
  });
  const costs =
    provider === "anthropic"
      ? records.map((r) => {
          const parts = r.attemptUsages.map((u) => attemptCostUsd(r.model, u));
          return { id: r.id, usd: parts.some((p) => p !== null) ? sum(parts) : null };
        })
      : [];
  const priced = costs.filter((c): c is { id: string; usd: number } => c.usd !== null);
  const models = [...new Set(records.map((r) => r.model).filter((m): m is string => !!m))];
  return {
    configuration,
    provider,
    replies: records.length,
    byOperation: tally(records.map((r) => r.operation)),
    schema: {
      firstTry: accepted.filter((r) => !r.retried).length,
      afterRetry: accepted.filter((r) => r.retried).length,
      failed: records.length - accepted.length,
    },
    softRepairs: {
      count: repairs.length,
      replies: accepted.filter((r) => repairsOf(r.repairs).length > 0).length,
      byField: tally(repairs.map((r) => r.field)),
    },
    goalCheckFailures: {
      count: records.reduce((n, r) => n + r.goalCheckFailures.length, 0),
      byCheck: tally(records.flatMap((r) => r.goalCheckFailures)),
    },
    bannedVocabulary: {
      hits: records.reduce((n, r) => n + r.bannedTerms.length, 0),
      replies: records.filter((r) => r.bannedTerms.length > 0).length,
      byTerm: tally(records.flatMap((r) => r.bannedTerms)),
    },
    planSanity: {
      band: PLAN_VOLUME_BAND,
      weeklyReplies: weekly.length,
      flaggedReplies: weekly.filter((r) => r.plan.flags.length > 0).length,
      byCheck: tally(planFlags.map((f) => f.check)),
      skipped: tally(weekly.flatMap((r) => r.plan.skipped)),
      volumeRatio: stat(weekly.map((r) => r.plan.ratio)),
      flags: planFlags,
    },
    lengthCaps: { hits: caps.length, byField: tally(caps) },
    latency: {
      firstTokenMs: stat(records.map((r) => r.ttftMs)),
      totalMs: stat(records.map((r) => r.totalMs)),
      /** The sum of every call's wall-clock, any retry included. */
      wallClockMs: sum(records.map((r) => r.totalMs)),
    },
    tokens: {
      input: medianOf(records.map((r) => r.usage.inputTokens)),
      output: medianOf(records.map((r) => r.usage.outputTokens)),
      /** Null on servers that never report it (oMLX); thinkingChars stands in. */
      thinking: medianOf(records.map((r) => r.usage.thinkingTokens)),
      thinkingChars: medianOf(records.map((r) => r.thinkingChars)),
      cacheRead: medianOf(records.map((r) => r.usage.cacheReadTokens)),
      cacheCreation: medianOf(records.map((r) => r.usage.cacheCreationTokens)),
    },
    promptCut: {
      ratio: PROBE_CUT_RATIO,
      checked: cuts.length,
      cut: cuts.filter((c) => c.cut).map((c) => c.id),
      lowestRatio: cuts.length ? Math.min(...cuts.map((c) => c.ratio)) : null,
    },
    cost:
      provider === "anthropic"
        ? {
            priceTakenOn: PRICE_TABLE.takenOn,
            prices: Object.fromEntries(models.filter((m) => PRICE_TABLE.models[m]).map((m) => [m, PRICE_TABLE.models[m]!])),
            cacheReadMultiplier: PRICE_TABLE.cacheReadMultiplier,
            cacheWriteMultiplier: PRICE_TABLE.cacheWriteMultiplier,
            unpricedModels: models.filter((m) => !PRICE_TABLE.models[m]),
            pricedReplies: priced.length,
            totalUsd: sum(priced.map((c) => c.usd)),
            medianUsd: median(priced.map((c) => c.usd)),
            worstUsd: priced.length ? Math.max(...priced.map((c) => c.usd)) : null,
            perReplyUsd: Object.fromEntries(priced.map((c) => [c.id, c.usd])),
          }
        : null,
  };
}

// ---- Formatting ------------------------------------------------------------------

export function secs(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`;
}

function num(n: number | null): string {
  return n === null ? "–" : String(Math.round(n));
}

function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : `$${n.toFixed(4)}`;
}

/** "headline 2, day notes 1", or "none". */
function byField(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

function medianWorst(s: Stat): string {
  return s.n ? `${secs(s.median)} / ${secs(s.worst)}` : "–";
}

/** The summary table's measure columns, after the setup and schema columns. */
export const SUMMARY_MEASURE_HEADERS = [
  "Wall clock",
  "First token (median / worst)",
  "Total (median / worst)",
  "Input tok (median)",
  "Output tok (median)",
  "Thinking tok (median)",
  "Thinking chars (median)",
  "Prompt cut",
  "Soft repairs",
  "Caps hit",
  "Goal-check failures",
  "Banned words",
  "Plan sanity flags",
  "Cost total",
  "Cost per reply (median)",
];

/** One configuration's measure cells, in SUMMARY_MEASURE_HEADERS order. */
export function summaryMeasureCells(m: Measures): string[] {
  return [
    secs(m.latency.wallClockMs),
    medianWorst(m.latency.firstTokenMs),
    medianWorst(m.latency.totalMs),
    num(m.tokens.input.median),
    num(m.tokens.output.median),
    num(m.tokens.thinking.median),
    num(m.tokens.thinkingChars.median),
    m.promptCut.checked ? `${m.promptCut.cut.length} of ${m.promptCut.checked}` : "–",
    String(m.softRepairs.count),
    String(m.lengthCaps.hits),
    String(m.goalCheckFailures.count),
    String(m.bannedVocabulary.hits),
    m.planSanity.weeklyReplies ? `${m.planSanity.flaggedReplies} of ${m.planSanity.weeklyReplies}` : "–",
    usd(m.cost?.totalUsd),
    usd(m.cost?.medianUsd),
  ];
}

/** The configuration section's measures table: every measure with its breakdown. */
export function measuresTable(m: Measures): string[] {
  const t = m.tokens;
  const plan = m.planSanity;
  const skipped = Object.keys(plan.skipped).length ? `; not checked: ${byField(plan.skipped)}` : "";
  const ratio = (n: number | null) => (n === null ? "–" : n.toFixed(2));
  const rows: Array<[string, string]> = [
    ["Schema", `${m.schema.firstTry} first try, ${m.schema.afterRetry} after retry, ${m.schema.failed} failed`],
    ["Soft repairs", `${m.softRepairs.count} in ${m.softRepairs.replies} replies (${byField(m.softRepairs.byField)})`],
    ["Length caps hit", `${m.lengthCaps.hits} (${byField(m.lengthCaps.byField)})`],
    ["Goal-check failures", `${m.goalCheckFailures.count} (${byField(m.goalCheckFailures.byCheck)})`],
    ["Banned words", `${m.bannedVocabulary.hits} in ${m.bannedVocabulary.replies} replies (${byField(m.bannedVocabulary.byTerm)})`],
    [
      "Plan sanity",
      plan.weeklyReplies
        ? `${plan.flaggedReplies} of ${plan.weeklyReplies} weekly plans flagged (${byField(plan.byCheck)}); volume ratio median ${ratio(plan.volumeRatio.median)}, highest ${ratio(plan.volumeRatio.worst)}${skipped}`
        : "no weekly plans",
    ],
    ["First token (median / worst)", medianWorst(m.latency.firstTokenMs)],
    ["Total time (median / worst)", medianWorst(m.latency.totalMs)],
    ["Wall clock (all calls)", secs(m.latency.wallClockMs)],
    ["Input tokens (median)", num(t.input.median)],
    ["Output tokens (median)", num(t.output.median)],
    ["Thinking tokens (median)", t.thinking.n ? num(t.thinking.median) : "not reported"],
    ["Thinking characters (median)", t.thinkingChars.n ? num(t.thinkingChars.median) : "no thinking block"],
    ["Cache read / write tokens (median)", `${num(t.cacheRead.median)} / ${num(t.cacheCreation.median)}`],
    [
      "Prompt cut",
      m.promptCut.checked
        ? `${m.promptCut.cut.length} of ${m.promptCut.checked}${m.promptCut.cut.length ? ` (${m.promptCut.cut.join(", ")})` : ""}; lowest ratio ${((m.promptCut.lowestRatio ?? 0) * 100).toFixed(1)} %`
        : "not checked (no usage or no prompt count)",
    ],
    [
      "Cost",
      m.cost
        ? m.cost.pricedReplies
          ? `${usd(m.cost.totalUsd)} over ${m.cost.pricedReplies} replies; median ${usd(m.cost.medianUsd)}, worst ${usd(m.cost.worstUsd)} (prices taken ${m.cost.priceTakenOn})`
          : `no priced replies${m.cost.unpricedModels.length ? ` (no price for ${m.cost.unpricedModels.join(", ")})` : " (no usage recorded)"}`
        : "self-hosted: not priced",
    ],
  ];
  return [
    "| Measure | Value |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`),
    "",
    ...(plan.flags.length ? ["Plan sanity flags:", "", ...plan.flags.map((f) => `- ${f.reply}: ${f.check}: ${f.detail}`), ""] : []),
  ];
}

/** The report's note on how the measures are taken: the band, the cut rule and the price table. */
export function measuresNote(): string[] {
  const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(Number.isInteger(n * 100) ? 2 : 3)}`;
  const prices = Object.entries(PRICE_TABLE.models).map(
    ([id, p]) =>
      `| ${p.label} (${id}) | ${dollars(p.inputPerMTok)} | ${dollars(p.outputPerMTok)} | ${dollars(p.inputPerMTok * cacheReadMultiplierFor(p))} | ${dollars(p.inputPerMTok * PRICE_TABLE.cacheWriteMultiplier)} |`,
  );
  return [
    "How the measures are taken (each configuration's measures.json holds them all):",
    "",
    `- Plan sanity, weekly reads only, flagged and not failed: seven days; the dates and week id match the expected plan week; every day that is not rest or other carries a run; the week's planned distance within ${PLAN_VOLUME_BAND.low}x to ${PLAN_VOLUME_BAND.high}x of the packet's recent weekly distance (the last four weeks' average from its reports). A plan given by time only, or a packet with no distance in its reports, skips the volume check.`,
    `- Prompt cut: the server's reported input tokens (cache reads and writes included) under ${PROBE_CUT_RATIO * 100} % of the harness's own count of the prompt (system and messages, characters / 4), the probe's rule.`,
    "- Latency: first token is the first attempt's first content_block_delta; total is the whole call's wall-clock, a retry included; wall clock is the sum over every call. A dry run has no first token.",
    "- Tokens are the last attempt's usage, as medians. Thinking tokens are blank where the server never reports them (oMLX); thinking characters stand in.",
    `- Cost, Anthropic rows only (self-hosted is blank): every attempt's usage, refused attempts included, at the prices below, in US dollars per million tokens, taken ${PRICE_TABLE.takenOn}. Cache reads at ${PRICE_TABLE.cacheReadMultiplier}x the input price (0.05x on Opus 5.5 and Sonnet 5.5) and cache writes at ${PRICE_TABLE.cacheWriteMultiplier}x the input price (Anthropic's standard multipliers; writes priced as the 5-minute cache). Thinking is billed as output and is inside the output count.`,
    "",
    "| Model | Input | Output | Cache read | Cache write |",
    "|---|---|---|---|---|",
    ...prices,
    "",
  ];
}
