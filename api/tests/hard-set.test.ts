/**
 * The hard set (coaching-quality 05): tests/fixtures/hard-set.json names every
 * coaching input of the phase, the weeks written to test coaching judgement,
 * as the replay's --only file. Checks each id resolves to the input its
 * scenario says (a season packet whose week carries that scenario's note, or
 * the demo snapshot's Achilles week), that every hard week of every season is
 * listed, and that the replay dry-runs over the list from both roots. Never
 * calls a model.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { storedDemoCalls } from "../scripts/replayInputs.js";
import { PLAN_RULES } from "../src/prescribed/planCheck.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARD_SET = path.join(api, "tests/fixtures/hard-set.json");
const SEASONS = path.join(api, "tests/fixtures/seasons");
const PACKETS = path.join(SEASONS, "season-packets");
const DEFAULT_CONFIG = "anthropic--claude-opus-4-7--xhigh";

type Entry = { input: string; why: string; scenario: string; expectedRules: string[] };
type SeasonWeek = { _note?: string };

const set = JSON.parse(readFileSync(HARD_SET, "utf8")) as Entry[];
/** The seasons root's inputs in replay order: the packet files, sorted. */
const packets = readdirSync(PACKETS).filter((f) => f.endsWith(".json")).sort();
const seasonWeeks = (stem: string) =>
  (JSON.parse(readFileSync(path.join(SEASONS, `${stem}.json`), "utf8")) as { weeks: SeasonWeek[] }).weeks;
/** The season and week a season id points at, from its packet's file name. */
function seasonInput(input: string): { file: string; stem: string; week: number } {
  const file = packets[Number(input.split("/")[1]) - 1];
  expect(file, input).toBeDefined();
  const m = /^(.+)-w(\d+)\.json$/.exec(file!)!;
  return { file: file!, stem: m[1]!, week: Number(m[2]) };
}
/** The scenario a hard week's note names: "Hard week (niggle): ..." gives "niggle". */
const scenarioOf = (note: string) => /^Hard week \(([^)]+)\): /.exec(note)?.[1] ?? null;

describe("the hard set", () => {
  it("lists fourteen inputs: eight marathon weeks, four beginner weeks, the return season's first week and the Achilles week", () => {
    expect(set).toHaveLength(14);
    expect(new Set(set.map((e) => e.input)).size).toBe(14);
    for (const e of set) {
      expect(e.input).toMatch(/^(seasons|snapshot)\/\d{2}$/);
      expect(e.why.trim().length, e.input).toBeGreaterThan(0);
      expect(e.scenario.trim().length, e.input).toBeGreaterThan(0);
      for (const rule of e.expectedRules) expect(PLAN_RULES as readonly string[], e.input).toContain(rule);
    }
    const stems = set.filter((e) => e.input.startsWith("seasons/")).map((e) => seasonInput(e.input).stem);
    expect(stems.filter((s) => s === "4-marathon")).toHaveLength(8);
    expect(stems.filter((s) => s === "5-beginner")).toHaveLength(4);
    expect(set.map((e) => e.input)).toContain("seasons/13");
    expect(set.map((e) => e.input)).toContain("snapshot/06");
  });

  it.each(set.filter((e) => e.input.startsWith("seasons/")).map((e) => [e.input, e] as const))(
    "%s is a season packet whose week's note names its scenario and the rules a careless plan would trip",
    (_input, e) => {
      const { file, stem, week } = seasonInput(e.input);
      expect(readdirSync(PACKETS)).toContain(file);
      const note = seasonWeeks(stem)[week - 1]?._note;
      expect(note, `${file} has no _note`).toBeDefined();
      expect(scenarioOf(note!)).toBe(e.scenario);
      for (const rule of e.expectedRules) expect(note).toContain(rule);
    },
  );

  it("lists every hard week of every season", () => {
    const listed = new Set(set.map((e) => e.input));
    packets.forEach((file, i) => {
      const m = /^(.+)-w(\d+)\.json$/.exec(file)!;
      const note = seasonWeeks(m[1]!)[Number(m[2]) - 1]?._note;
      if (note) expect(listed, `${file} (seasons/${String(i + 1).padStart(2, "0")})`).toContain(`seasons/${String(i + 1).padStart(2, "0")}`);
    });
  });

  it("snapshot/06 is the demo athlete's Achilles week, 2026-W37", () => {
    const call = storedDemoCalls()[5]!;
    expect(call.operation).toBe("weekly_reply");
    if (call.operation !== "weekly_reply") return;
    expect(call.packet.week?.isoWeek).toBe("2026-W37");
    expect(call.packet.recapMarkdown).toMatch(/Achilles/);
    expect(set.find((e) => e.input === "snapshot/06")!.scenario).toBe("Achilles week");
  });

  it("the replay dry-runs over the list from both roots", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const replay = (args: string[]) =>
      spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-weekly-reads.ts", "--dry-run", ...args, "--only", `@${HARD_SET}`], {
        cwd: api,
        env,
        encoding: "utf8",
      });
    const bench = mkdtempSync(path.join(tmpdir(), "hard-set-"));
    const replies = (root: string) => readdirSync(path.join(root, DEFAULT_CONFIG)).filter((f) => /^\d+\.\d+\.json$/.test(f)).sort();
    const expected = (root: string) =>
      set.filter((e) => e.input.startsWith(`${root}/`)).map((e) => `${e.input.split("/")[1]}.1.json`).sort();

    const seasons = path.join(bench, "seasons");
    const s = replay(["--packets", PACKETS, "--out", seasons]);
    expect(s.stderr).toBe("");
    expect(s.status).toBe(0);
    expect(replies(seasons)).toEqual(expected("seasons"));

    const snapshot = path.join(bench, "snapshot");
    const d = replay(["--out", snapshot]);
    // The demo's weeks were logged before its goal was stored, so the goal-line
    // check fails on them and the run exits non-zero; nothing else may go wrong.
    expect(d.stderr).not.toMatch(/Error/);
    expect(d.stderr).toMatch(/^\d+ goal checks? failed:\n(- .+: no goal line: the packet has no goal\n)+$/);
    expect(replies(snapshot)).toEqual(expected("snapshot"));
  }, 120_000);
});
