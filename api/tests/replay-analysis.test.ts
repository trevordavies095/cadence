/**
 * The replay analysis (scripts/replay-analysis.ts): reading a refused
 * attempt's tool input back from its saved stream, the candidate repairs in
 * scripts/replayRepairs.ts, the plan figures in scripts/replayAnalysisStats.ts,
 * and the script over a small root. The real attempts in
 * tests/fixtures/replay-analysis/ were copied from the benchmark's refused
 * replies, with what their packet's plan week was. Never calls a model and
 * needs no database.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readMessageStream } from "../src/llm/anthropicStream.js";
import { resolveWeeklyPlanWeek } from "../src/llm/stub.js";
import type { PrescribedWeek } from "../src/llm/types.js";
import type { ModelPacket } from "../src/packet/types.js";
import { comparePlans, pearson, planSummary, spread } from "../scripts/replayAnalysisStats.js";
import { planLineSummary } from "../scripts/replayPlanLines.js";
import {
  athleteUnit,
  CANDIDATE_REPAIRS,
  coerceStringArrays,
  dropEmptyEntries,
  dropNullOptionals,
  errorKind,
  extractAttempt,
  fillDayTypeFromRun,
  fillRunTypeFromDayType,
  firstJsonObject,
  isoWeekOf,
  mapDayFieldAliases,
  mapEnumNearMisses,
  mapEnumValue,
  mapRunFieldAliases,
  messageFromSse,
  metersFrom,
  normaliseError,
  normaliseWeekId,
  parseStringifiedFields,
  PIPELINE_ORDER,
  realignPlanDates,
  secondsFrom,
  splitFlagStrings,
  splitIntoItems,
  trimOverCaps,
  tryRepairs,
  useStrayToolInput,
  validateFor,
  type RepairContext,
} from "../scripts/replayRepairs.js";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(api, "tests/fixtures/replay-analysis");
const SSE = path.join(api, "tests/fixtures/self-hosted/omlx-gpt-oss-weekly.sse");
const SSE_PACKET = path.join(api, "tests/fixtures/self-hosted/omlx-gpt-oss-weekly.packet.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const weeklyCtx = (over: Partial<RepairContext> = {}): RepairContext => ({
  operation: "weekly_reply",
  weekStartMonday: "2026-10-19",
  isoWeek: "2026-W43",
  unit: "metric",
  ...over,
});

/** Seven days from 2026-10-19, a valid plan the tests then break. */
function validWeek(): Any {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const types = ["rest", "easy", "quality", "easy", "rest", "easy", "long"];
  return {
    week: "2026-W43",
    days: dates.map((date, i) =>
      types[i] === "rest"
        ? { date, dayType: "rest", notes: "Rest." }
        : { date, dayType: types[i], run: { type: types[i], distanceM: types[i] === "long" ? 16000 : 8000 }, notes: "Why." },
    ),
  };
}

function validWeekly(): Any {
  return { headline: "A steady week.", analysis: "The read.", flags: [{ title: "Shin", detail: "Watch it." }], answers: [], prescribedWeek: validWeek() };
}

/** A hand-made event stream, one data line per event. */
function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function fixture(name: string): { operation: "weekly_reply"; error: string; weekStartMonday: string; isoWeek: string | null; unit: RepairContext["unit"]; responseRaw: string } {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

describe("reading a saved attempt", () => {
  it("rebuilds the tool input from the recorded oMLX stream as the app's stream reader does", async () => {
    const raw = readFileSync(SSE, "utf8");
    const read = await readMessageStream(new Response(raw), { signal: new AbortController().signal, onActivity: () => {} });
    const appInput = (read.message!.content as Any[]).find((b) => b.type === "tool_use").input;
    const ex = extractAttempt(raw, "weekly_reply");
    expect(ex.format).toBe("sse");
    expect(ex.toolInput).toEqual(appInput);
    expect(ex.toolNames).toEqual(["submit_weekly_reply"]);
    expect(ex.stopReason).toBe("tool_use");
    expect(ex.thinkingChars).toBeGreaterThan(1000);
    const packet = JSON.parse(readFileSync(SSE_PACKET, "utf8")) as ModelPacket;
    const result = validateFor("weekly_reply", ex.toolInput, { weekStartMonday: resolveWeeklyPlanWeek(packet).weekStartMonday });
    expect(result.ok).toBe(true);
  });

  it("joins input_json_delta parts across deltas and reads thinking and text", () => {
    const raw = sse([
      { type: "message_start", message: { id: "m", content: [], usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "abc" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "submit_mid_week_chat_reply", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"bo' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'dy":"hi"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
    const ex = extractAttempt(raw, "mid_week_chat");
    expect(ex).toMatchObject({ format: "sse", toolInput: { body: "hi" }, stopReason: "tool_use", thinkingChars: 3 });
    expect(messageFromSse(raw)!.partialJson.get(1)).toBe('{"body":"hi"}');
  });

  it("keeps tool JSON that does not parse, as sent", () => {
    const raw = sse([
      { type: "message_start", message: { content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "submit_weekly_reply" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"headline": "cut' } },
    ]);
    const ex = extractAttempt(raw, "weekly_reply");
    expect(ex.toolInput).toBeNull();
    expect(ex.unparsedToolJson).toBe('{"headline": "cut');
    // The reassembled message form the replay saves marks it the same way.
    const saved = JSON.stringify({ content: [{ type: "tool_use", name: "submit_weekly_reply", input: { _unparsed_partial_json: '{"a' } }] });
    expect(extractAttempt(saved, "weekly_reply")).toMatchObject({ format: "message", toolInput: null, unparsedToolJson: '{"a' });
  });

  it("reads the reassembled message the replay saves, as a string or an object", () => {
    const message = { content: [{ type: "text", text: "x" }, { type: "tool_use", name: "submit_about_you", input: { proposedBody: "b" } }], stop_reason: "tool_use" };
    expect(extractAttempt(JSON.stringify(message), "dossier_audit")).toMatchObject({ format: "message", toolInput: { proposedBody: "b" }, textChars: 1 });
    expect(extractAttempt(message, "dossier_v1").toolInput).toEqual({ proposedBody: "b" });
    expect(extractAttempt("not a stream", "weekly_reply").format).toBe("none");
    expect(extractAttempt(null, "weekly_reply").format).toBe("none");
  });

  it("finds a reply sent outside the asked-for tool call", () => {
    const other = { content: [{ type: "tool_use", name: "submit_reply", input: { headline: "h", analysis: "a" } }] };
    expect(extractAttempt(other, "weekly_reply").strayInput).toEqual({ from: "other tool", value: { headline: "h", analysis: "a" } });
    const text = { content: [{ type: "text", text: 'Here it is: {"body": "hi {there}"} done' }] };
    expect(extractAttempt(text, "mid_week_chat").strayInput).toEqual({ from: "text", value: { body: "hi {there}" } });
    const unrelated = { content: [{ type: "text", text: '{"foo": 1}' }] };
    expect(extractAttempt(unrelated, "mid_week_chat").strayInput).toBeNull();
    expect(firstJsonObject('x {bad} {"a": {"b": "}"}} y')).toEqual({ a: { b: "}" } });
  });

  it("a real attempt with no tool call: thinking only, nothing to rescue", () => {
    const f = fixture("gpt-oss-20b-no-tool-call.json");
    const ex = extractAttempt(f.responseRaw, f.operation);
    expect(ex).toMatchObject({ format: "message", toolInput: null, strayInput: null, toolNames: [], stopReason: "tool_use" });
    expect(ex.thinkingChars).toBeGreaterThan(1000);
    expect(errorKind(f.error)).toBe("no tool call");
  });
});

describe("validator errors", () => {
  it("splits the field path from the rule and normalises indices and dates", () => {
    expect(normaliseError("prescribedWeek.days[3].run.type must be easy|quality|long|race|other")).toEqual({
      path: "prescribedWeek.days[n].run.type",
      rule: "must be easy|quality|long|race|other",
      ruleLabel: "not in enum",
      kind: "schema",
    });
    expect(normaliseError("prescribedWeek.days[1] (easy) requires a run object")).toMatchObject({ path: "prescribedWeek.days[n]", ruleLabel: "missing run" });
    expect(normaliseError("prescribedWeek.days[0].date must be 2026-10-19 (got 2026-10-12)")).toMatchObject({ rule: "must be <date> (got <date>)", ruleLabel: "wrong date" });
    expect(normaliseError("flags[0] needs a non-empty title and detail")).toMatchObject({ path: "flags[n]", ruleLabel: "missing or empty" });
    expect(normaliseError("prescribedWeek.week must be an ISO week id (YYYY-Www)").ruleLabel).toBe("not an ISO week id");
    expect(normaliseError("settingsProposalBullets must be an array of strings").ruleLabel).toBe("wrong type");
    expect(normaliseError("analysis must be at most 4000 characters").ruleLabel).toBe("over length cap");
    expect(normaliseError("Anthropic response missing submit_weekly_reply tool_use block")).toMatchObject({ path: "(response)", rule: "Anthropic response missing <tool> tool_use block", kind: "no tool call" });
  });

  it("classifies failures outside the validator", () => {
    expect(errorKind("Anthropic stopped at max_tokens before completing the reply tool call (stop_reason=max_tokens)")).toBe("max_tokens");
    expect(errorKind("The model server call exceeded 900000ms overall; aborted")).toBe("transport");
    expect(errorKind("The model server sent a stream error: terminated")).toBe("transport");
    expect(errorKind("Anthropic refused the request (stop_reason=refusal)")).toBe("model refusal");
    expect(errorKind("headline is required and must be non-empty")).toBe("schema");
  });
});

describe("the candidate repairs, one by one", () => {
  it("every candidate is in the pipeline once, and none changes a valid reply", () => {
    expect([...PIPELINE_ORDER].sort()).toEqual(CANDIDATE_REPAIRS.map((r) => r.id).sort());
    const input = validWeekly();
    const before = JSON.stringify(input);
    for (const r of CANDIDATE_REPAIRS) expect(r.apply(input, weeklyCtx()).changes).toEqual([]);
    const all = tryRepairs(input, weeklyCtx(), PIPELINE_ORDER);
    expect(all.result.ok).toBe(true);
    expect(all.changes).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("(a) fills a missing run.type from the dayType, and leaves rest days and typed runs alone", () => {
    const input = validWeekly();
    delete input.prescribedWeek.days[1].run.type;
    input.prescribedWeek.days[0].run = { distanceM: 0 };
    expect(validateFor("weekly_reply", input, weeklyCtx()).ok).toBe(false);
    const out = fillRunTypeFromDayType(input);
    expect(out.changes).toEqual(["prescribedWeek.days[1].run.type filled from dayType easy"]);
    expect((out.value as Any).prescribedWeek.days[0].run).toEqual({ distanceM: 0 });
    expect(input.prescribedWeek.days[1].run.type).toBeUndefined(); // not mutated
    const patches = fillRunTypeFromDayType({ body: "b", prescribedDayPatches: [{ date: "2026-10-20", dayType: "long", run: { distanceM: 1 } }] });
    expect((patches.value as Any).prescribedDayPatches[0].run.type).toBe("long");
  });

  it("(b) normalises the week id: the plan week, else the first date's week", () => {
    const input = validWeekly();
    input.prescribedWeek.week = "Oct 19 – 25";
    const out = normaliseWeekId(input, weeklyCtx());
    expect((out.value as Any).prescribedWeek.week).toBe("2026-W43");
    expect(out.changes).toEqual(['prescribedWeek.week "Oct 19 – 25" -> 2026-W43']);
    expect((normaliseWeekId(input, weeklyCtx({ isoWeek: null })).value as Any).prescribedWeek.week).toBe("2026-W43");
    expect(normaliseWeekId(validWeekly(), weeklyCtx()).changes).toEqual([]);
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
  });

  it("(c) maps near-miss enum values; unknown words stay", () => {
    expect(["Tempo", " EASY ", "Recovery run", "Long Run", "intervals", "Rest.", "Rest/Active Recovery", "off", "Cross-training", "walk‑run", "Easy 5 mi (5:00/mi)", "Hill repeats 6 mi"].map((v) => mapEnumValue(v, true))).toEqual([
      "quality",
      "easy",
      "easy",
      "long",
      "quality",
      "rest",
      "rest",
      "rest",
      "other",
      "easy",
      "easy",
      "quality",
    ]);
    expect(mapEnumValue("Moderate Session", true)).toBeNull();
    expect(mapEnumValue("rest", false)).toBeNull();
    const input = validWeekly();
    input.prescribedWeek.days[2].dayType = "Tempo";
    input.prescribedWeek.days[2].run.type = "interval";
    input.prescribedWeek.days[3].dayType = "Moderate Session";
    const out = mapEnumNearMisses(input);
    expect(out.changes).toEqual(['prescribedWeek.days[2].dayType "Tempo" -> quality', 'prescribedWeek.days[2].run.type "interval" -> quality']);
    expect((out.value as Any).prescribedWeek.days[3].dayType).toBe("Moderate Session");
  });

  it("(d) coerces a string to an array of strings, split on lines and bullets", () => {
    expect(splitIntoItems("- one\n- two\n\n3. three")).toEqual(["one", "two", "three"]);
    expect(splitIntoItems("• a • b")).toEqual(["a", "b"]);
    const out = coerceStringArrays({ body: "b", settingsProposalBullets: "Runs before work" });
    expect((out.value as Any).settingsProposalBullets).toEqual(["Runs before work"]);
    expect(validateFor("mid_week_chat", out.value, { weekStartMonday: "2026-10-19" }).ok).toBe(true);
    expect((coerceStringArrays({ summaryBullets: '["a","b"]' }).value as Any).summaryBullets).toEqual(["a", "b"]);
    expect((coerceStringArrays({ summaryBullets: "  " }).value as Any).summaryBullets).toEqual([]);
  });

  it("(e) drops flags and answers with an empty field, and plain-string answers", () => {
    const input = validWeekly();
    input.flags.push({ title: "", detail: "x" }, "a string");
    input.answers = ["an answer with no question", { question: "Q?", answer: "A." }];
    const out = dropEmptyEntries(input);
    expect(out.changes).toEqual(["flags: dropped 2 of 3 entries", "answers: dropped 1 of 2 entries"]);
    expect(validateFor("weekly_reply", out.value, weeklyCtx()).ok).toBe(true);
  });

  it("(f) trims fields and lists past a hard cap, leaving room for the About you stance", () => {
    const input = validWeekly();
    input.analysis = "A sentence. ".repeat(400);
    input.flags = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, detail: "d" }));
    expect(validateFor("weekly_reply", input, weeklyCtx()).ok).toBe(false);
    const out = trimOverCaps(input);
    expect(validateFor("weekly_reply", out.value, weeklyCtx()).ok).toBe(true);
    expect((out.value as Any).flags).toHaveLength(5);
    const dossier = trimOverCaps({ summaryBullets: ["x".repeat(300)], proposedBody: "# About you\n\n## Running\n" + "Fact. ".repeat(2500) });
    expect(validateFor("dossier_audit", dossier.value, { weekStartMonday: null }).ok).toBe(true);
  });

  it("(g) maps run field aliases, in the athlete's unit when bare", () => {
    expect(metersFrom(5, null, "imperial")).toBe(8047);
    expect(metersFrom(5, null, "metric")).toBe(5000);
    expect(metersFrom(5, null, null)).toBe(5000);
    expect(metersFrom(8047, null, "imperial")).toBe(8047);
    expect(metersFrom("5 mi", null, "metric")).toBe(8047);
    expect(metersFrom("8 km", null, "imperial")).toBe(8000);
    expect(metersFrom("1,200 m", null, null)).toBe(1200);
    expect(metersFrom(5, "km", "imperial")).toBe(5000);
    expect(metersFrom("easy", null, null)).toBeNull();
    expect([secondsFrom("49m", null), secondsFrom("2h22m", null), secondsFrom("45 min", null), secondsFrom("1:05:00", null), secondsFrom(30, "min"), secondsFrom(90, "s")]).toEqual([
      2940, 8520, 2700, 3900, 1800, 90,
    ]);
    const input = validWeekly();
    input.prescribedWeek.days[1].run = { type: "easy", distance: 5, pace: "9:45/mi", description: "Easy run" };
    input.prescribedWeek.days[2].run = { type: "quality", distanceKm: 8, durationMin: 48, pacePerKm: "5:50" };
    input.prescribedWeek.days[3].run = { type: "easy", distanceM: "8047" };
    const out = mapRunFieldAliases(input, weeklyCtx({ unit: "imperial" }));
    const days = (out.value as Any).prescribedWeek.days;
    expect(days[1].run).toEqual({ type: "easy", distanceM: 8047, paceOrHr: "9:45/mi", structure: "Easy run" });
    expect(days[2].run).toEqual({ type: "quality", distanceM: 8000, durationS: 2880, paceOrHr: "5:50" });
    expect(days[3].run.distanceM).toBe(8047);
    expect(validateFor("weekly_reply", out.value, weeklyCtx()).ok).toBe(true);
  });

  it("(g) maps day field aliases and builds a run from a distance on the day", () => {
    const input = validWeekly();
    input.prescribedWeek.days[1] = { date: "2026-10-20", session: "Easy", distance: "5 mi", reason: "Base." };
    const out = mapDayFieldAliases(input, weeklyCtx());
    expect((out.value as Any).prescribedWeek.days[1]).toEqual({ date: "2026-10-20", dayType: "Easy", notes: "Base.", run: { distanceM: 8047 } });
    // Combined with the enum map and (a), the day is valid.
    const all = tryRepairs(input, weeklyCtx(), ["mapDayFieldAliases", "mapEnumNearMisses", "fillRunTypeFromDayType"]);
    expect(all.result.ok).toBe(true);
    // A rest day sent as a session with no distance gets no run.
    const rest = mapDayFieldAliases({ prescribedWeek: { days: [{ date: "2026-10-19", session: "Rest", distance: 0 }] } }, weeklyCtx());
    expect((rest.value as Any).prescribedWeek.days[0]).toEqual({ date: "2026-10-19", dayType: "Rest", distance: 0 });
  });

  it("(g) fills a missing dayType from run.type, and never invents a rest day", () => {
    const input = validWeekly();
    delete input.prescribedWeek.days[2].dayType;
    input.prescribedWeek.days[2].run.type = "tempo";
    delete input.prescribedWeek.days[0].dayType;
    const out = fillDayTypeFromRun(input);
    expect(out.changes).toEqual(["prescribedWeek.days[2].dayType filled from run.type tempo"]);
    expect((out.value as Any).prescribedWeek.days[2].dayType).toBe("quality");
    expect((out.value as Any).prescribedWeek.days[0].dayType).toBeUndefined();
  });

  it("(g) removes optional fields sent as null", () => {
    const input = { ...validWeekly(), settingsProposalBullets: null, safetyCallouts: null };
    expect(validateFor("weekly_reply", input, weeklyCtx()).ok).toBe(false);
    const out = dropNullOptionals(input);
    expect(out.changes).toEqual(["settingsProposalBullets null removed", "safetyCallouts null removed"]);
    expect(validateFor("weekly_reply", out.value, weeklyCtx()).ok).toBe(true);
  });

  it("(g) parses fields sent as a string of JSON", () => {
    const input = { ...validWeekly(), flags: JSON.stringify([{ title: "a", detail: "b" }]) };
    input.prescribedWeek.days[1].run = JSON.stringify(input.prescribedWeek.days[1].run);
    const out = parseStringifiedFields(input);
    expect(out.changes).toEqual(["flags parsed from a string of JSON", "prescribedWeek.days[1].run parsed from a string of JSON"]);
    expect(validateFor("weekly_reply", out.value, weeklyCtx()).ok).toBe(true);
  });

  it("(g) splits flags sent as strings at a separator", () => {
    const out = splitFlagStrings({ flags: ["Shin rest – keep volume low.", "Easy HR: under 150.", "no separator here"] });
    expect((out.value as Any).flags).toEqual([{ title: "Shin rest", detail: "keep volume low." }, { title: "Easy HR", detail: "under 150." }, "no separator here"]);
  });

  it("(g) takes a reply sent outside the tool call only when no tool input came", () => {
    const stray = { body: "hi" };
    expect(useStrayToolInput(null, { ...weeklyCtx(), operation: "mid_week_chat", strayInput: stray }).value).toEqual(stray);
    expect(useStrayToolInput({ body: "x" }, { ...weeklyCtx(), strayInput: stray }).changes).toEqual([]);
    expect(useStrayToolInput(null, weeklyCtx()).changes).toEqual([]);
  });

  it("(g) realigns seven consecutive dates to the plan week, not a muddle", () => {
    const input = validWeekly();
    input.prescribedWeek.days.forEach((d: Any, i: number) => (d.date = `2026-10-${12 + i}`));
    expect(validateFor("weekly_reply", input, weeklyCtx()).ok).toBe(false);
    const out = realignPlanDates(input, weeklyCtx());
    expect(validateFor("weekly_reply", out.value, weeklyCtx()).ok).toBe(true);
    input.prescribedWeek.days[3].date = "2026-10-30";
    expect(realignPlanDates(input, weeklyCtx()).changes).toEqual([]);
  });

  it("reads the athlete's unit from the packet, else from the recap's distances", () => {
    expect(athleteUnit({ coaching: { phase: "base", unitPreference: "imperial" } as Any, recapMarkdown: "8 km" })).toBe("imperial");
    expect(athleteUnit({ coaching: null, recapMarkdown: "Ran 5 mi, then 6 mi and 3 km" })).toBe("imperial");
    expect(athleteUnit({ coaching: null, recapMarkdown: "no distances" })).toBeNull();
  });
});

describe("real refused attempts", () => {
  const cases: Array<[string, string[]]> = [
    ["gemma-run-without-type.json", ["fillRunTypeFromDayType", "mapRunFieldAliases"]],
    ["gpt-oss-120b-run-aliases.json", ["fillRunTypeFromDayType", "mapRunFieldAliases"]],
    ["gpt-oss-20b-day-aliases.json", ["mapDayFieldAliases", "mapEnumNearMisses", "fillRunTypeFromDayType"]],
  ];
  for (const [name, needs] of cases) {
    it(`${name}: the validator gives the recorded error, and ${needs.join(" + ")} rescue it (no one of them alone)`, () => {
      const f = fixture(name);
      const unit = f.unit ?? "imperial"; // the demo snapshot's athlete runs in miles; its packets predate the unit field
      const ctx: RepairContext = { operation: f.operation, weekStartMonday: f.weekStartMonday, isoWeek: f.isoWeek, unit };
      const ex = extractAttempt(f.responseRaw, f.operation);
      expect(ex.toolInput).not.toBeNull();
      const plain = validateFor(f.operation, ex.toolInput, ctx);
      expect(plain).toEqual({ ok: false, error: f.error });
      expect(tryRepairs(ex.toolInput, ctx, needs).result.ok).toBe(true);
      for (const id of needs) expect(tryRepairs(ex.toolInput, ctx, [id]).result.ok).toBe(false);
      for (const id of needs) expect(tryRepairs(ex.toolInput, ctx, needs.filter((x) => x !== id)).result.ok).toBe(false);
    });
  }

  it("a rescued gemma plan reads its bare distances in the athlete's miles", () => {
    const f = fixture("gemma-run-without-type.json");
    const ctx: RepairContext = { operation: f.operation, weekStartMonday: f.weekStartMonday, isoWeek: f.isoWeek, unit: "imperial" };
    const out = tryRepairs(extractAttempt(f.responseRaw, f.operation).toolInput, ctx, ["fillRunTypeFromDayType", "mapRunFieldAliases"]);
    const week = (out.result as { ok: true; value: { prescribedWeek: PrescribedWeek } }).value.prescribedWeek;
    // 5.5 + 6 + 7.5 + 5 + 11.5 miles.
    expect(planSummary(week).totalM / 1609.344).toBeCloseTo(35.5, 1);
  });
});

describe("plan figures", () => {
  it("spread, correlation and the plan comparison", () => {
    expect(spread([3, 1, 2, null, 10])).toMatchObject({ n: 4, median: 2.5, p90: 10, worst: 10 });
    expect(spread([])).toMatchObject({ n: 0, median: null });
    expect(pearson([1, 2, 3, 4], [0, 0, 1, 1])).toBeCloseTo(0.894, 3);
    expect(pearson([1, 1, 1], [0, 1, 0])).toBeNull();
    const base = validWeek() as PrescribedWeek;
    const cand = validWeek() as PrescribedWeek;
    cand.days[6]!.run!.distanceM = 24000;
    cand.days[4] = { date: cand.days[4]!.date, dayType: "easy", run: { type: "easy", distanceM: 8000 } };
    const c = comparePlans(cand, base);
    expect(c.distanceRatio).toBeCloseTo(64000 / 48000);
    expect(c.longRunRatio).toBe(1.5);
    expect(c.runDays).toEqual({ candidate: 6, baseline: 5 });
    expect(c.dayTypeMatch).toBeCloseTo(6 / 7);
    expect(c.sameRestDays).toBe(false);
    expect(c.quality).toEqual({ candidate: true, baseline: true });
    expect(c.unparsed).toEqual({ candidate: 0, baseline: 0 });
  });

  it("an unparsed day is no plan: counted, left out of the ratios, matching no day type", () => {
    const base = validWeek() as PrescribedWeek;
    const cand = validWeek() as PrescribedWeek;
    // The long run (16 km) and a quality day (8 km) could not be filed.
    for (const i of [2, 6]) cand.days[i] = { date: cand.days[i]!.date, dayType: "other", run: null, notes: "Sun: long 10", line: "Sun: long 10", parsed: false };
    const c = comparePlans(cand, base);
    expect(c.unparsed).toEqual({ candidate: 2, baseline: 0 });
    // Over the five days both filed: 8 + 8 + 8 = 24 km each side.
    expect(c.distanceRatio).toBe(1);
    expect(c.longRunRatio).toBeNull();
    expect(c.dayTypeMatch).toBeCloseTo(5 / 7);
    expect(c.quality).toEqual({ candidate: false, baseline: true });
    // Every day unparsed: nothing to compare, and nothing throws.
    const none = { ...cand, days: cand.days.map((d) => ({ date: d.date, dayType: "other" as const, run: null, line: null, parsed: false })) };
    const n = comparePlans(none, base);
    expect(n).toMatchObject({ distanceRatio: null, longRunRatio: null, dayTypeMatch: 0, unparsed: { candidate: 7, baseline: 0 } });
  });
});

describe("the plan-lines summary of a saved reply", () => {
  const week = (parsed: boolean[]): Any => ({
    headline: "A week.",
    analysis: "The read.",
    prescribedWeek: { week: "2026-W43", days: validWeek().days.map((d: Any, i: number) => ({ ...d, line: `line ${i}`, parsed: parsed[i] })) },
  });

  it("reads failures, the retry's fixes, bare numbers and dropped lines from what the reply file saved", () => {
    const summary = planLineSummary("weekly_reply", {
      repairs:
        'plan 2026-10-22 not filed: no distance unit; plan 2026-10-24 not filed: no day type word; plan 2026-10-25 not filed: no line; plan line for 2026-10-26 dropped: outside the plan week; plan line with no day ignored: "Note; keep it easy"; headline cut from 200 to 160 chars',
      timing: {
        attempts: [
          { attempt: 1, request: { kind: "first" }, repairs: "plan 2026-10-22 not filed: no distance unit" },
          { attempt: 2, request: { kind: "fix_lines", fixDates: ["2026-10-22", "2026-10-24", "2026-10-25"], fixed: ["2026-10-22", "2026-10-25"] } },
        ],
      },
      new: week([true, true, true, true, true, false, true]),
    });
    expect(summary).toEqual({
      box: "plan",
      daysTotal: 7,
      daysParsed: 6,
      failures: [
        { date: "2026-10-22", reason: "no distance unit" },
        { date: "2026-10-24", reason: "no day type word" },
        { date: "2026-10-25", reason: "no line" },
      ],
      retried: true,
      retryAskedFor: ["2026-10-22", "2026-10-24", "2026-10-25"],
      fixedByRetry: ["2026-10-22", "2026-10-25"],
      bareNumbers: 1,
      droppedLines: [{ date: "2026-10-26", reason: "outside the plan week" }],
      ignoredLines: 1,
    });
  });

  it("falls back on the retry row's repair notes when its request names no fixed dates", () => {
    const summary = planLineSummary("weekly_reply", {
      repairs: "plan 2026-10-22 not filed: no distance unit",
      timing: { attempts: [{ attempt: 1 }, { attempt: 2, request: { kind: "fix_lines" }, repairs: "plan 2026-10-22 filed by the retry" }] },
      new: week([true, true, true, true, true, true, true]),
    });
    expect(summary).toMatchObject({ retried: true, fixedByRetry: ["2026-10-22"], daysParsed: 7 });
  });

  it("summarises a mid-week reply's changes lines, files an old nested reply whole, and has none for About you", () => {
    const mid = planLineSummary("mid_week_chat", {
      repairs: "changes 2026-10-22 not filed: no distance or duration; changes line for 2026-10-27 dropped: outside the plan week",
      new: {
        body: "Moved Thursday.",
        prescribedDayPatches: [
          { date: "2026-10-21", dayType: "easy", run: { type: "easy", distanceM: 5000 }, line: "Wed: easy 5 km", parsed: true },
          { date: "2026-10-22", dayType: "other", run: null, notes: "Thu: easy", line: "Thu: easy", parsed: false },
        ],
      },
    });
    expect(mid).toMatchObject({
      box: "changes",
      daysTotal: 2,
      daysParsed: 1,
      failures: [{ date: "2026-10-22", reason: "no distance or duration" }],
      bareNumbers: 0,
      droppedLines: [{ date: "2026-10-27", reason: "outside the plan week" }],
    });
    expect(planLineSummary("mid_week_chat", { repairs: null, new: { body: "No change." } })).toMatchObject({ daysTotal: 0, daysParsed: 0 });
    // The 2026-11-01 runs: nested day objects with no parsed flag read as filed.
    expect(planLineSummary("weekly_reply", { repairs: null, new: validWeekly() })).toMatchObject({ daysTotal: 7, daysParsed: 7, failures: [], retried: false });
    expect(planLineSummary("dossier_v1", { repairs: null, new: { summaryBullets: [], proposedBody: "x" } })).toBeNull();
  });
});

describe("the script", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "replay-analysis-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function run(args: string[]) {
    return spawnSync(path.join(api, "node_modules/.bin/tsx"), ["scripts/replay-analysis.ts", ...args], { cwd: api, encoding: "utf8" });
  }

  /** A root with one self-hosted configuration over the season packets: input 01 refused twice, input 03 still running. */
  function buildRoot(): string {
    const root = path.join(tmp, "seasons");
    const dir = path.join(root, "self_hosted--test-model--high");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ configuration: path.basename(dir), provider: "self_hosted", model: "test-model", effort: "high", inputs: path.join(api, "tests/fixtures/seasons/season-packets") }));
    const f = fixture("gpt-oss-120b-run-aliases.json");
    const attempt = (n: number) => ({ attempt: n, error: f.error, stopReason: "tool_use", outputTokens: 100, inputTokens: 1000, responseRaw: f.responseRaw });
    writeFileSync(
      path.join(dir, "01.1.failed.json"),
      JSON.stringify({ operation: "weekly_reply", error: f.error, stopReason: "tool_use", timing: { ttftMs: 100, totalMs: 2000, attempts: [{ attempt: 1, ttftMs: 100, totalMs: 1000 }, { attempt: 2, ttftMs: 90, totalMs: 1000 }] }, refusedAttempts: [attempt(1), attempt(2)] }),
    );
    writeFileSync(path.join(dir, "03.1.json"), "{ half written");
    return root;
  }

  it("writes the three files outside the root, rescues the refused reply, and leaves the root as it was", () => {
    const root = buildRoot();
    const before = readdirSync(path.join(root, "self_hosted--test-model--high")).sort();
    const out = path.join(tmp, "analysis");
    const res = run(["--roots", root, "--out", out]);
    expect(res.status, res.stderr).toBe(0);
    expect(readdirSync(path.join(root, "self_hosted--test-model--high")).sort()).toEqual(before);
    for (const f of ["analysis.md", "analysis.json", "replies.csv"]) expect(existsSync(path.join(out, f))).toBe(true);
    const json = JSON.parse(readFileSync(path.join(out, "analysis.json"), "utf8"));
    expect(json.rescue.failedPopulation).toBe(1);
    expect(json.rescue.overall.all).toBe(1);
    expect(json.rescue.extraction.reproduced).toBe(2);
    expect(json.warnings.some((w: string) => w.includes("03.1.json"))).toBe(true);
    const csv = readFileSync(path.join(out, "replies.csv"), "utf8").trim().split("\n");
    expect(csv).toHaveLength(3); // header and two attempts
    // Rescued by the combined repairs, by none alone: rescued_by_all true, remaining_error empty.
    expect(csv[1]!.endsWith(",,true,")).toBe(true);
    const md = readFileSync(path.join(out, "analysis.md"), "utf8");
    expect(md.indexOf("## What to change in the harness")).toBeLessThan(md.indexOf("## 1. Outcomes"));
    expect(md).toContain("fill a missing run.type from the day's dayType");
  });

  /**
   * A root holding a baseline run on the old nested form and a candidate run
   * on the plan-as-text form: two valid weekly reads (one with two unparsed
   * days, one fixed by the retry) and a refusal whose tool input is old-shaped.
   */
  function buildNewFormRoot(): string {
    const root = path.join(tmp, "newform", "seasons");
    const inputs = path.join(api, "tests/fixtures/seasons/season-packets");
    const base = path.join(root, "anthropic--claude-opus-4-7--xhigh");
    const cand = path.join(root, "self_hosted--new-model--high");
    for (const [dir, provider, model] of [[base, "anthropic", "claude-opus-4-7"], [cand, "self_hosted", "new-model"]] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "config.json"), JSON.stringify({ configuration: path.basename(dir), provider, model, effort: "high", inputs }));
    }
    const reply = (extra: Any) => ({ operation: "weekly_reply", outcome: "ok", repairs: null, inputTokens: 1000, outputTokens: 100, refusedAttempts: [], ...extra });
    for (const id of ["01", "02"]) writeFileSync(path.join(base, `${id}.1.json`), JSON.stringify(reply({ new: validWeekly() })));
    const filed = (unparsed: number[]): Any => ({
      ...validWeekly(),
      prescribedWeek: {
        week: "2026-W43",
        days: validWeek().days.map((d: Any, i: number) =>
          unparsed.includes(i) ? { date: d.date, dayType: "other", run: null, notes: `line ${i}`, line: `line ${i}`, parsed: false } : { ...d, line: `line ${i}`, parsed: true },
        ),
      },
    });
    writeFileSync(
      path.join(cand, "01.1.json"),
      JSON.stringify(
        reply({
          outcome: "repaired",
          repairs: "plan 2026-10-21 not filed: no distance unit; plan 2026-10-25 not filed: no line",
          timing: {
            ttftMs: 100,
            totalMs: 3000,
            attempts: [
              { attempt: 1, ttftMs: 100, totalMs: 2000, request: { kind: "first", turns: ["user: text"] }, outcome: "repaired", repairs: "plan 2026-10-21 not filed: no distance unit; plan 2026-10-25 not filed: no line", inputTokens: 1000, outputTokens: 100 },
              { attempt: 2, ttftMs: 90, totalMs: 1000, request: { kind: "fix_lines", turns: ["user: text", "assistant: tool_use", "user: tool_result (error)"], fixDates: ["2026-10-21", "2026-10-25"], fixed: [] }, outcome: "repaired", repairs: "plan 2026-10-21 still not filed: no distance unit; plan 2026-10-25 still not filed: no line", inputTokens: 1200, outputTokens: 50 },
            ],
          },
          new: filed([2, 6]),
        }),
      ),
    );
    writeFileSync(
      path.join(cand, "02.1.json"),
      JSON.stringify(
        reply({
          outcome: "repaired",
          repairs: "plan 2026-10-22 not filed: no distance unit",
          timing: {
            ttftMs: 100,
            totalMs: 3000,
            attempts: [
              { attempt: 1, ttftMs: 100, totalMs: 2000, request: { kind: "first", turns: ["user: text"] } },
              { attempt: 2, ttftMs: 90, totalMs: 1000, request: { kind: "fix_lines", turns: [], fixDates: ["2026-10-22"], fixed: ["2026-10-22"] }, outcome: "repaired", inputTokens: 1200, outputTokens: 50 },
            ],
          },
          new: filed([]),
        }),
      ),
    );
    // A refusal with an old-shaped tool input: on a plan-as-text run it is not rescued, nor re-validated by the old checkers.
    const f = fixture("gpt-oss-120b-run-aliases.json");
    const attempt = (n: number) => ({ attempt: n, error: f.error, stopReason: "tool_use", outputTokens: 100, inputTokens: 1000, responseRaw: f.responseRaw });
    writeFileSync(
      path.join(cand, "03.1.failed.json"),
      JSON.stringify({ operation: "weekly_reply", error: f.error, stopReason: "tool_use", timing: { ttftMs: 100, totalMs: 2000, attempts: [{ attempt: 1, ttftMs: 100, totalMs: 1000 }, { attempt: 2, ttftMs: 90, totalMs: 1000 }] }, refusedAttempts: [attempt(1), attempt(2)] }),
    );
    return root;
  }

  it("measures the plan lines of a plan-as-text run, skips its rescue, and still rescues an old run beside it", () => {
    const oldRoot = path.join(tmp, "seasons");
    if (!existsSync(oldRoot)) buildRoot();
    const root = buildNewFormRoot();
    const out = path.join(tmp, "analysis-newform");
    // The two roots share the name "seasons": read them as one would two runs, each its own root.
    const oldCopy = path.join(tmp, "old", "snapshot");
    mkdirSync(path.dirname(oldCopy), { recursive: true });
    if (!existsSync(oldCopy)) {
      mkdirSync(oldCopy, { recursive: true });
      const dir = path.join(oldCopy, "self_hosted--test-model--high");
      mkdirSync(dir);
      for (const f of ["config.json", "01.1.failed.json"]) writeFileSync(path.join(dir, f), readFileSync(path.join(oldRoot, "self_hosted--test-model--high", f)));
    }
    const res = run(["--roots", `${root},${oldCopy}`, "--out", out]);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(readFileSync(path.join(out, "analysis.json"), "utf8"));

    const cand = json.planLines.find((p: Any) => p.configuration === "self_hosted--new-model--high");
    expect(cand.form).toBe("plan lines");
    expect(cand.weekly).toMatchObject({ replies: 2, daysTotal: 14, daysParsed: 12, unparsed: 2, failedFirst: 3, retried: 2, retryAskedFor: 3, fixedByRetry: 1, bareNumbers: 2, droppedLines: 0 });
    expect(cand.weekly.structuredShare).toBeCloseTo(12 / 14);
    const base = json.planLines.find((p: Any) => p.configuration === "anthropic--claude-opus-4-7--xhigh");
    expect(base).toMatchObject({ form: "nested days", weekly: { daysTotal: 14, daysParsed: 14 } });
    expect(json.failuresByReason).toEqual([
      { configuration: "self_hosted--new-model--high", operation: "weekly_reply", reason: "no distance unit", firstParse: 2, fixedByRetry: 1, stillUnparsed: 1, droppedLines: 0 },
      { configuration: "self_hosted--new-model--high", operation: "weekly_reply", reason: "no line", firstParse: 1, fixedByRetry: 0, stillUnparsed: 1, droppedLines: 0 },
    ]);

    // The rescue skips the plan-as-text run and still works on the old one.
    expect(json.rescue.skippedRuns).toEqual(["seasons/self_hosted--new-model--high"]);
    expect(json.rescue.failedPopulation).toBe(1);
    expect(json.rescue.overall.all).toBe(1);
    expect(json.rescue.details.map((d: Any) => d.key)).toEqual(["snapshot/01"]);
    expect(json.rescue.extraction.checked).toBe(2);

    // The plan comparison counts unparsed days and leaves them out of the ratio.
    const plans = json.plans.find((p: Any) => p.configuration === "self_hosted--new-model--high");
    expect(plans.valid).toMatchObject({ pairs: 2, unparsed: { candidate: 2, baseline: 0 }, pairsWithUnparsed: 1 });
    expect(plans.valid.distanceRatio.worst).toBe(1);

    // The second requests by kind, and the fix's tokens on its own attempt.
    expect(json.retry.find((r: Any) => r.configuration === "self_hosted--new-model--high").secondRequests).toMatchObject({ fix_lines: 2, "not recorded": 1 });
    const csv = readFileSync(path.join(out, "replies.csv"), "utf8").trim().split("\n");
    const header = csv[0]!.split(",");
    const rows = csv.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
    const fix = rows.find((r) => r.configuration === "self_hosted--new-model--high" && r.input_id === "01" && r.attempt === "2")!;
    expect(fix).toMatchObject({ request_kind: "fix_lines", input_tokens: "1200", output_tokens: "50", attempt_outcome: "accepted" });
    const first = rows.find((r) => r.configuration === "self_hosted--new-model--high" && r.input_id === "01" && r.attempt === "1")!;
    expect(first).toMatchObject({ request_kind: "first", input_tokens: "1000" });

    const md = readFileSync(path.join(out, "analysis.md"), "utf8");
    expect(md).toContain("| Configuration | Operation | Replies | First try | After retry | Failed | Structured days (of seven) |");
    expect(md).toContain("| new-model--high | all | 3 | 2 | 0 | 1 | 6.0 (86%) |");
    expect(md).toContain("### Plan-line failures by reason");
    expect(md).toContain("| new-model--high | plan | no distance unit | 2 | 1 | 1 | 0 |");
    expect(md).toContain("Skipped for runs on the plan-as-text form, where the parser is the repair: `seasons/self_hosted--new-model--high`");
    expect(md).not.toContain("re-sends the identical request");
  });

  it("refuses an --out inside a root", () => {
    const root = path.join(tmp, "seasons");
    const res = run(["--roots", root, "--out", path.join(root, "analysis")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("never writes into a root");
    expect(existsSync(path.join(root, "analysis"))).toBe(false);
  });
});
