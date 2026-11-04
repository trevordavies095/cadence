/**
 * The coach's form (scripts/replayCoachPacket.ts, through --coach-packet on
 * scripts/replay-weekly-reads.ts). Two output roots are built with dry runs
 * on the offline stub over the hard set, as the coaching run has them (the
 * season packets in one, the demo snapshot in the other), with six
 * configurations, one of which fails every input. Never calls a model, and
 * never runs the Apps Script: it is parsed, not run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  answerGists,
  capWords,
  clip,
  DESCRIPTION_CAP,
  drawReplies,
  IF_YOU_HAVE_TIME,
  planLine,
  type CoachAthlete,
  type FormItem,
  type FormPayload,
  type HardSetEntry,
} from "../scripts/replayCoachPacket.js";
import { PLAN_RULES } from "../src/prescribed/planCheck.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEASON_PACKETS = path.join(api, "tests/fixtures/seasons/season-packets");
const HARD_SET = path.join(api, "tests/fixtures/hard-set.json");
const hardSet = JSON.parse(readFileSync(HARD_SET, "utf8")) as HardSetEntry[];
const athletes = JSON.parse(readFileSync(path.join(api, "tests/fixtures/coach-packet-athletes.json"), "utf8")) as Record<string, CoachAthlete | string>;
const DEFAULT = "anthropic--claude-opus-4-7--xhigh";
/** Five self-hosted stand-ins beside the default: six configurations, as the baseline has. */
const MODELS = ["gpt-oss-test:20b", "cand-alpha:9b", "cand-beta:9b", "cand-gamma:9b", "cand-delta:9b"];
const configOf = (model: string) => `self_hosted--${model.replace(/[^A-Za-z0-9._-]/g, "_")}--high`;
const CONFIGURATIONS = [DEFAULT, ...MODELS.map(configOf)];
/** The configuration whose every reply failed. */
const FAILING = configOf("cand-delta:9b");
/** The hard set's safety-critical weeks: pain or a return expected, illness, the return week, Achilles, doubling, overrun. */
const SAFETY = ["seasons/22", "seasons/26", "seasons/27", "seasons/31", "seasons/35", "seasons/13", "snapshot/06"];
/** Which athlete each hard week belongs to. */
const ATHLETE_OF = (input: string) =>
  input === "snapshot/06" ? "snapshot" : input === "seasons/13" ? "3-return" : Number(input.split("/")[1]) >= 33 ? "5-beginner" : "4-marathon";

function replay(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-weekly-reads.ts", ...args], { cwd: api, env, encoding: "utf8" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

let bench: string;
let seasons: string;
let snapshot: string;

beforeAll(() => {
  bench = mkdtempSync(path.join(tmpdir(), "coach-form-"));
  seasons = path.join(bench, "baseline", "seasons");
  snapshot = path.join(bench, "baseline", "snapshot");
  for (const [root, inputs] of [
    [seasons, ["--packets", SEASON_PACKETS]],
    [snapshot, []],
  ] as const) {
    for (const model of [null, ...MODELS]) {
      const extra = model ? ["--provider", "self_hosted", "--base-url", "http://127.0.0.1:9", "--model", model, "--effort", "high"] : [];
      const run = replay([...inputs, "--dry-run", "--out", root, "--only", `@${HARD_SET}`, ...extra]);
      // The snapshot's weeks predate the demo goal, so their goal checks fail; the replies are written all the same.
      expect(run.stderr).not.toMatch(/Error:|at .*\.ts:\d+/);
    }
  }
  // Every reply of one configuration was refused, with an error that names its model.
  for (const root of [seasons, snapshot]) {
    const dir = path.join(root, FAILING);
    for (const f of readdirSync(dir).filter((f) => /^\d+\.1\.json$/.test(f))) {
      rmSync(path.join(dir, f));
      writeFileSync(
        path.join(dir, f.replace(".json", ".failed.json")),
        JSON.stringify({ operation: "weekly_reply", model: "cand-delta:9b", error: "gpt-oss style markup from cand-delta on oMLX", outcome: "schema_invalid" }),
      );
    }
  }
}, 300_000);

function build(seed: number, dir: string) {
  return replay(["--coach-packet", "--roots", `${seasons},${snapshot}`, "--seed", String(seed), "--packet-dir", dir]);
}

/** The payload form.gs carries, read back by running the script's top level with a stand-in for nothing else. */
function payloadOf(script: string): FormPayload {
  return new Function(`${script}\nreturn PAYLOAD;`)() as FormPayload;
}

type Page = Extract<FormItem, { kind: "page" }>;

describe("the coach's form", () => {
  let script: string;
  let preview: string;
  let payload: FormPayload;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let key: Record<string, any>;
  let out: string;
  let casePages: Page[];

  beforeAll(() => {
    out = path.join(bench, "coach-packet");
    const run = build(7, out);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    script = readFileSync(path.join(out, "form.gs"), "utf8");
    preview = readFileSync(path.join(out, "preview.md"), "utf8");
    key = readJson(path.join(out, "key.json"));
    payload = payloadOf(script);
    casePages = payload.items.filter((it): it is Page => it.kind === "page" && /^Case \d+ of 14 · /.test(it.title));
  }, 120_000);

  it("writes the script, its preview and the key, apart, and nothing into the roots", () => {
    expect(readdirSync(out).sort()).toEqual(["form.gs", "key.json", "preview.md"]);
    expect(existsSync(path.join(seasons, "coach-packet"))).toBe(false);
    expect(key).toMatchObject({ seed: 7, roots: ["seasons", "snapshot"], configurations: [...CONFIGURATIONS].sort() });
    expect(key.cases).toHaveLength(14);
    // The key carries no absolute paths: it is committed.
    expect(JSON.stringify(key)).not.toContain(bench);
  });

  it("generates a script that parses, defines the function to run, and carries the whole form as data", () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).toMatch(/^function createCoachingReviewForm\(\) \{$/m);
    expect(payload.title).toBe("Coaching review");
    expect(payload.description.split(/\s+/).length).toBeLessThanOrEqual(120);
    expect(payload.items[0]).toEqual({ kind: "text", title: "Who is filling this in?", required: true });
    expect(casePages).toHaveLength(14);
    expect(payload.items.at(-2)).toMatchObject({ kind: "checkbox", other: true, atMost: 3, required: false });
    expect(payload.items.at(-1)).toMatchObject({ kind: "paragraph", title: "Anything else we should know?", required: false });
  });

  it("names no model, provider, server, effort or plan rule in the script, the preview or the payload", () => {
    for (const text of [script, preview, JSON.stringify(payload)]) {
      const lower = text.toLowerCase();
      for (const term of [...CONFIGURATIONS, ...MODELS, "cand-delta", "anthropic", "omlx", "gpt", "opus", "sonnet", "haiku", "claude", "xhigh", "self_hosted", "127.0.0.1", ...PLAN_RULES]) {
        expect(lower, term).not.toContain(term.toLowerCase());
      }
      expect(text).not.toMatch(/\btokens?\b|effort level/i);
    }
  });

  it("draws three drafts a case from three configurations, each configuration in seven cases", () => {
    const counts = new Map<string, number>();
    for (const c of key.cases) {
      const configs = c.drafts.map((d: { configuration: string }) => d.configuration);
      expect(new Set(configs).size, c.input).toBe(3);
      expect(c.drafts.map((d: { draft: string }) => d.draft)).toEqual(["A", "B", "C"]);
      for (const d of c.drafts) {
        expect(d).toMatchObject({ input: c.input, repeat: 1 });
        counts.set(d.configuration, (counts.get(d.configuration) ?? 0) + 1);
      }
    }
    expect([...counts.keys()].sort()).toEqual([...CONFIGURATIONS].sort());
    expect([...counts.values()]).toEqual([7, 7, 7, 7, 7, 7]);
    expect(key.appearances).toEqual(Object.fromEntries(counts));
  });

  it("the key resolves every draft letter on every page to a reply file", () => {
    for (const c of key.cases) {
      const page = casePages[c.case - 1]!;
      expect(page.title).toMatch(new RegExp(`^Case ${c.case} of 14 · `));
      for (const d of c.drafts) {
        expect(page.help).toContain(`── DRAFT ${d.draft} ──`);
        const [root, id] = (d.input as string).split("/");
        const file = path.join(root === "seasons" ? seasons : snapshot, d.configuration, `${id}.1${d.status === "failed" ? ".failed" : ""}.json`);
        expect(existsSync(file), `case ${c.case} draft ${d.draft}`).toBe(true);
        expect(d.status).toBe(d.configuration === FAILING ? "failed" : "ok");
      }
    }
  });

  it("puts every safety-critical week before the 'If you have time' page, required, and the rest after it, optional", () => {
    const at = (title: string) => payload.items.findIndex((it) => it.kind === "page" && it.title === title);
    const later = at(IF_YOU_HAVE_TIME);
    expect(later).toBeGreaterThan(0);
    const first = key.cases.filter((c: { safetyCritical: boolean }) => c.safetyCritical).map((c: { input: string }) => c.input);
    expect([...first].sort()).toEqual([...SAFETY].sort());
    for (const c of key.cases) {
      const i = at(casePages[c.case - 1]!.title);
      const questions = payload.items.slice(i + 1, i + 5);
      expect(questions.map((q) => q.kind)).toEqual(["choice", "checkbox", "grid", "paragraph"]);
      const safety = SAFETY.includes(c.input);
      expect(safety ? i < later : i > later, c.input).toBe(true);
      for (const q of questions.slice(0, 3)) expect("required" in q && q.required, `${c.input} ${q.title}`).toBe(safety);
    }
  });

  it("opens every page with its athlete, by first name, and keeps each page under the description cap", () => {
    for (const c of key.cases) {
      const athlete = athletes[ATHLETE_OF(c.input)] as CoachAthlete;
      const page = casePages[c.case - 1]!;
      expect(page.title).toContain(` · ${athlete.name} · `);
      expect(page.help.startsWith(`── ${athlete.name.toUpperCase()}'S WEEK ──\n${athlete.introduction}\n`), c.input).toBe(true);
      expect(page.help.length, c.input).toBeLessThanOrEqual(DESCRIPTION_CAP);
      expect(payload.items).toContainEqual(expect.objectContaining({ title: `Is any draft unsafe for ${athlete.name} this week?` }));
    }
    // Each introduction is two sentences at most, in the third person by name, with no gendered pronouns.
    for (const a of Object.values(athletes).filter((a): a is CoachAthlete => typeof a === "object")) {
      expect(a.introduction.split(/(?<=[.!?])\s+/).length, a.name).toBeLessThanOrEqual(2);
      expect(a.introduction).not.toMatch(/\b(he|she|him|her|his|hers|you|your)\b/i);
    }
  });

  it("writes the athlete card from the packet in the athlete's unit, never from the hard set's notes", () => {
    const pageOf = (input: string) => casePages[key.cases.find((c: { input: string }) => c.input === input).case - 1]!;
    expect(pageOf("seasons/22").title).toBe("Case 1 of 14 · Marisol · marathon in 11 weeks");
    expect(pageOf("seasons/22").help).toContain("Recent weeks: 30, 32, 35 mi\nThis week: 32 mi over 5 runs.");
    expect(pageOf("seasons/22").help).toMatch(/Pain noted: Thu 2\/10 .*; Sun 4\/10 \(Outside of right knee/);
    expect(pageOf("seasons/22").help).toContain('Asks: "Is this an IT band thing? Should I still do Wednesday\'s tempo?"');
    expect(pageOf("seasons/26").help).toMatch(/Planned 38 mi, ran 53 mi\./);
    // Race week: the race is named on the card, and the title counts from the Sunday read.
    expect(pageOf("seasons/31").title).toMatch(/race week, marathon on Sunday$/);
    expect(pageOf("seasons/31").help).toContain("Raced: Sun Oct 18, 26.22 mi in 3h 50m");
    expect(pageOf("seasons/35").help).toMatch(/This week: 2\.8 km over 1 run\. Missed 2 of 3 planned runs\./);
    expect(pageOf("seasons/35").help).toContain("Came down with a cold on Tuesday");
    expect(pageOf("seasons/13").title).toBe(`Case ${key.cases.find((c: { input: string }) => c.input === "seasons/13").case} of 14 · Ines · return to running, week 1`);
    expect(pageOf("snapshot/06").help).toContain("Achilles");
    for (const e of hardSet) for (const p of casePages) expect(p.help, e.input).not.toContain(e.why);
  });

  it("shows each draft as what it tells the athlete and seven day lines without dates, and a failed reply as no reply", () => {
    for (const c of key.cases) {
      const page = casePages[c.case - 1]!;
      const name = (athletes[ATHLETE_OF(c.input)] as CoachAthlete).name;
      for (const d of c.drafts) {
        const block = page.help.split(`── DRAFT ${d.draft} ──\n`)[1]!.split("\n\n")[0]!;
        if (d.status === "failed") {
          expect(block).toBe(`No reply arrived. This is what ${name} would have got.`);
          continue;
        }
        expect(block.startsWith(`Tells ${name}: `)).toBe(true);
        const days = block.split("Next week:\n")[1]!.split("\n");
        expect(days.map((l) => l.slice(0, 5))).toEqual(["Mon: ", "Tue: ", "Wed: ", "Thu: ", "Fri: ", "Sat: ", "Sun: "]);
        for (const l of days) expect(l).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }
  });

  it("draws the same drafts for the same seed, and others for another seed", () => {
    const again = path.join(bench, "again");
    const other = path.join(bench, "other");
    expect(build(7, again).status).toBe(0);
    expect(build(8, other).status).toBe(0);
    const draw = (dir: string) => readJson(path.join(dir, "key.json")).cases.map((c: { drafts: Array<{ configuration: string }> }) => c.drafts.map((d) => d.configuration));
    expect(draw(again)).toEqual(draw(out));
    expect(readFileSync(path.join(again, "form.gs"), "utf8")).toBe(script);
    expect(draw(other)).not.toEqual(draw(out));
  }, 120_000);
});

describe("the cuts", () => {
  it("cuts the reply at a sentence end, and a plan line at a word, with an ellipsis", () => {
    expect(capWords("One two three. Four five six. Seven eight nine.", 6)).toBe("One two three. Four five six. …");
    expect(capWords("One two three four five six seven.", 4)).toBe("One two three four…");
    expect(capWords("Short.", 10)).toBe("Short.");
  });

  it("gives each answer its opening sentences, dropping echoed questions and numbering", () => {
    // A bold heading per question, as most replies write them.
    expect(answerGists("**1. Should I stop?**\n\nNo. Keep it easy. Book a physio.\n\n- Stop if it hurts.\n\n**2. Is it serious?**\n\nI cannot say. See someone this week.")).toEqual([
      "No. Keep it easy.",
      "I cannot say. See someone this week.",
    ]);
    // Numbered paragraphs with no headings.
    expect(answerGists("1. I would not stop yet. Strip out quality. Rest if worse.\n\n2. Ask a physio. Watch for swelling.")).toEqual([
      "I would not stop yet. Strip out quality.",
      "Ask a physio. Watch for swelling.",
    ]);
    // Neither: each paragraph is an answer.
    expect(answerGists("Keep running easy. Rest if sharper.\n\nWatch how it behaves.")).toEqual(["Keep running easy. Rest if sharper.", "Watch how it behaves."]);
    expect(clip("easy, 4 mi, flat route, heart rate under 145", 20)).toBe("easy, 4 mi, flat…");
  });

  it("takes the date off a plan line in any shape a reply writes it, and leaves the rest as written", () => {
    const day = (line: string) => planLine({ date: "2026-08-17", dayType: "rest", line }, 200);
    expect(day("Mon 2026-08-17: rest. Full rest or easy walk.")).toBe("Mon: rest. Full rest or easy walk.");
    expect(day("Mon Aug 17: rest. Full rest.")).toBe("Mon: rest. Full rest.");
    expect(day("Monday, 17 Aug: rest")).toBe("Mon: rest");
    expect(day("rest - full day off")).toBe("Mon: rest - full day off");
  });
});

describe("the draw", () => {
  const cases = Array.from({ length: 14 }, (_, i) => ({ input: `r/${i}`, available: ["a", "b", "c", "d", "e", "f"] }));

  it("balances six configurations over fourteen cases at seven each, never one twice in a case", () => {
    for (const seed of [1, 2, 3, 42]) {
      const drawn = drawReplies(cases, seed);
      const counts = new Map<string, number>();
      for (const d of drawn) {
        expect(new Set(d).size).toBe(3);
        for (const c of d) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      expect([...counts.values()]).toEqual([7, 7, 7, 7, 7, 7]);
    }
  });

  it("stays within one with five configurations, and refuses a case with fewer than three", () => {
    const five = cases.map((c) => ({ ...c, available: ["a", "b", "c", "d", "e"] }));
    const counts = new Map<string, number>();
    for (const d of drawReplies(five, 1)) for (const c of d) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
    expect(() => drawReplies([{ input: "r/1", available: ["a", "b"] }], 1)).toThrow(/a case needs 3/);
  });
});
