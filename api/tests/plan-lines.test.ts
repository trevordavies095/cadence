import { describe, expect, it } from "vitest";
import type { DayType, PrescribedDay, PrescribedRun } from "../src/llm/types.js";
import {
  NO_PLAN_GIVEN_NOTE,
  PLAN_DAY_TYPE_SYNONYMS,
  parsePlanLines,
  type PlanLineFailureReason,
} from "../src/prescribed/planLines.js";

/** The plan week: Mon 2026-11-09 .. Sun 2026-11-15. */
const MONDAY = "2026-11-09";
const TUE = "2026-11-10";

const mi = (n: number) => Math.round(n * 1609.344);
const km = (n: number) => Math.round(n * 1000);

function run(
  type: PrescribedRun["type"],
  distanceM: number,
  durationS: number | null = null,
): PrescribedRun {
  return { type, distanceM, durationS, structure: null, paceOrHr: null, shoes: null };
}

function parsed(
  date: string,
  line: string,
  dayType: DayType,
  r: PrescribedRun | null,
  notes: string | null,
): PrescribedDay {
  return { date, dayType, run: r, strength: null, notes, line, parsed: true };
}

function unparsed(date: string, line: string): PrescribedDay {
  return { date, dayType: "other", run: null, notes: line, line, parsed: false };
}

/** Parses one line inside an otherwise empty week; returns that date's day and failure. */
function parseOne(line: string, date = TUE) {
  const result = parsePlanLines({ text: line, weekStartMonday: MONDAY, unit: "imperial" });
  const day = result.days.find((d) => d.date === date)!;
  const failure = result.failures.find((f) => f.date === date && f.reason !== "no line");
  return { day, failure, result };
}

type ParsedCase = {
  name: string;
  line: string;
  date?: string;
  dayType: DayType;
  run: PrescribedRun | null;
  notes: string | null;
};

const parsedCases: ParsedCase[] = [
  // each of the six day types
  { name: "rest", line: "Mon: rest", date: "2026-11-09", dayType: "rest", run: null, notes: null },
  {
    name: "easy",
    line: "Tue 2026-11-10: easy, 5 mi, HR under 150, flat",
    dayType: "easy",
    run: run("easy", mi(5)),
    notes: "HR under 150, flat",
  },
  {
    name: "quality",
    line: "Tue: quality, 6 mi with 4 x 1 mi at threshold",
    dayType: "quality",
    run: run("quality", mi(6)),
    notes: "with 4 x 1 mi at threshold",
  },
  {
    name: "long",
    line: "Tue: long 14 mi, last 3 at marathon pace",
    dayType: "long",
    run: run("long", mi(14)),
    notes: "last 3 at marathon pace",
  },
  {
    name: "race",
    line: "Tue: race, 10 km, go out controlled",
    dayType: "race",
    run: run("race", km(10)),
    notes: "go out controlled",
  },
  {
    name: "other with an amount",
    line: "Tue: other, 30 min strength: squats, lunges, core",
    dayType: "other",
    run: run("other", 0, 1800),
    notes: "strength: squats, lunges, core",
  },
  {
    name: "other with no amount is a non-running day",
    line: "Tue: other, mobility and foam rolling",
    dayType: "other",
    run: null,
    notes: "mobility and foam rolling",
  },
  // day tokens
  { name: "weekday only", line: "Tuesday - easy 5 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "weekday abbreviation with a dot", line: "Tue. easy 5 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "date only", line: "2026-11-10: easy 5 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "date then weekday", line: "2026-11-10 (Tue): easy 5 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  {
    name: "weekday and date disagree: the date wins",
    line: "Wed 2026-11-10: easy 5 mi",
    dayType: "easy",
    run: run("easy", mi(5)),
    notes: null,
  },
  { name: "list marker before the day", line: "- Tue: easy 5 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  // units
  { name: "miles spelt out", line: "Tue: easy 5 miles", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "decimal miles", line: "Tue: easy 4.5 mi", dayType: "easy", run: run("easy", mi(4.5)), notes: null },
  { name: "kilometres", line: "Tue: easy 8 km easy loop", dayType: "easy", run: run("easy", km(8)), notes: "easy loop" },
  { name: "k glued to the number", line: "Tue: easy 8k", dayType: "easy", run: run("easy", km(8)), notes: null },
  { name: "kilometres spelt out", line: "Tue: easy 12 kilometres", dayType: "easy", run: run("easy", km(12)), notes: null },
  // durations and time-only runs
  { name: "minutes", line: "Tue: easy 40 min, conversational", dayType: "easy", run: run("easy", 0, 2400), notes: "conversational" },
  { name: "minutes spelt out", line: "Tue: easy 90 minutes", dayType: "easy", run: run("easy", 0, 5400), notes: null },
  { name: "hours", line: "Tue: long 2 h on trails", dayType: "long", run: run("long", 0, 7200), notes: "on trails" },
  { name: "1 hr", line: "Tue: easy 1 hr", dayType: "easy", run: run("easy", 0, 3600), notes: null },
  { name: "1h10", line: "Tue: long 1h10 easy", dayType: "long", run: run("long", 0, 4200), notes: "easy" },
  { name: "1:10", line: "Tue: long 1:10, flat", dayType: "long", run: run("long", 0, 4200), notes: "flat" },
  { name: "time before type word", line: "Tue: 40 min easy", dayType: "easy", run: run("easy", 0, 2400), notes: "easy" },
  // ranges, doubles, both amounts
  { name: "range with to", line: "Tue: easy 5 to 6 mi, flat", dayType: "easy", run: run("easy", mi(5)), notes: "flat" },
  { name: "range with hyphen", line: "Tue: easy 5-6 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "range with en dash", line: "Tue: easy 5–6 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "duration range", line: "Tue: easy 40-50 min", dayType: "easy", run: run("easy", 0, 2400), notes: null },
  { name: "range with a unit on both ends", line: "Tue: easy 5 mi to 6 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  {
    name: "double stores the first run",
    line: "Tue: easy, am 5 mi, pm 3 mi",
    dayType: "easy",
    run: run("easy", mi(5)),
    notes: "pm 3 mi",
  },
  {
    name: "distance and duration both set",
    line: "Tue: easy 5 mi, 45 min, HR cap 150",
    dayType: "easy",
    run: run("easy", mi(5), 2700),
    notes: "HR cap 150",
  },
  { name: "duration in brackets after distance", line: "Tue: easy 5 mi (45 min)", dayType: "easy", run: run("easy", mi(5), 2700), notes: null },
  // word boundaries and first type word
  { name: "easy-ish matches easy", line: "Tue: easy-ish 5 mi", dayType: "easy", run: run("easy", mi(5)), notes: null },
  {
    name: "longer is not long",
    line: "Tue: a bit longer than usual, easy 7 mi",
    dayType: "easy",
    run: run("easy", mi(7)),
    notes: null,
  },
  {
    name: "a synonym before a canonical word wins",
    line: "Tue: tempo 6 mi, easy warm-up",
    dayType: "quality",
    run: run("quality", mi(6)),
    notes: "easy warm-up",
  },
  {
    name: "5k pace is an intensity, not the amount",
    line: "Tue: intervals 6 mi, 6x800 at 5k pace",
    dayType: "quality",
    run: run("quality", mi(6)),
    notes: "6x800 at 5k pace",
  },
  {
    name: "race pace is not a race",
    line: "Tue: 8 mi with 3 at race pace, long-ish",
    dayType: "long",
    run: run("long", mi(8)),
    notes: "with 3 at race pace, long-ish",
  },
  {
    name: "k inside a word is not a unit",
    line: "Tue: easy 5 kinda slow, 40 min",
    dayType: "easy",
    run: run("easy", 0, 2400),
    notes: null,
  },
  {
    name: "a pace is not a duration",
    line: "Tue: easy 5 mi at 9:30/mi",
    dayType: "easy",
    run: run("easy", mi(5)),
    notes: "at 9:30/mi",
  },
  // rest needs no amount
  { name: "rest with notes", line: "Tue: rest, legs up", dayType: "rest", run: null, notes: "legs up" },
  { name: "rest with an amount gets no run", line: "Tue: rest or 20 min walk", dayType: "rest", run: null, notes: "or 20 min walk" },
  // whitespace
  { name: "surrounding whitespace", line: "   \tTue:   easy 5 mi  ", dayType: "easy", run: run("easy", mi(5)), notes: null },
  { name: "upper case", line: "TUE: EASY 5 MI", dayType: "easy", run: run("easy", mi(5)), notes: null },
];

const synonymCases: Array<[string, DayType]> = Object.entries(PLAN_DAY_TYPE_SYNONYMS);

describe("parsePlanLines: a line becomes a stored day", () => {
  it.each(parsedCases)("$name", ({ line, date = TUE, dayType, run: r, notes }) => {
    const { day, failure } = parseOne(line, date);
    expect(failure).toBeUndefined();
    expect(day).toEqual(parsed(date, line.trim().replace(/^- /, ""), dayType, r, notes));
  });

  it("covers every synonym in the table", () => {
    expect(synonymCases.map(([w]) => w).sort()).toEqual(
      [
        "tempo", "intervals", "threshold", "hills", "workout", "fartlek", "strides-session",
        "recovery", "jog", "shakeout",
        "strength", "cross", "cross-training", "bike", "swim", "walk", "yoga",
        "off",
      ].sort(),
    );
  });

  it.each(synonymCases)("synonym %s files as %s", (word, dayType) => {
    const line = `Tue: ${word}, 40 min`;
    const { day, failure } = parseOne(line);
    expect(failure).toBeUndefined();
    const expectedRun = dayType === "rest" ? null : run(dayType as PrescribedRun["type"], 0, 2400);
    const expectedNotes = dayType === "rest" ? "40 min" : null;
    expect(day).toEqual(parsed(TUE, line, dayType, expectedRun, expectedNotes));
  });

  it("matches a hyphenated synonym written with a space", () => {
    expect(parseOne("Tue: cross training 45 min").day.dayType).toBe("other");
    expect(parseOne("Tue: strides session 30 min").day.dayType).toBe("quality");
  });
});

type FailureCase = { name: string; line: string; reason: PlanLineFailureReason };

const failureCases: FailureCase[] = [
  { name: "a bare number", line: "Tue: easy 5, flat", reason: "no distance unit" },
  { name: "a bare range", line: "Tue: easy 5 to 6", reason: "no distance unit" },
  { name: "a bare number on an other day", line: "Tue: strength 30", reason: "no distance unit" },
  { name: "a run day with no amount", line: "Tue: easy, keep it relaxed", reason: "no distance or duration" },
  { name: "a race with no amount", line: "Tue: race, half marathon", reason: "no distance or duration" },
  { name: "intensity only, no amount", line: "Tue: quality, 6x800 at 5k pace", reason: "no distance or duration" },
  { name: "a line with no type word", line: "Tue: 5 mi with friends", reason: "no day type word" },
  { name: "longer is not a type word", line: "Tue: longer, 7 mi", reason: "no day type word" },
];

describe("parsePlanLines: a line that cannot be filed", () => {
  it.each(failureCases)("$name fails with \"$reason\"", ({ line, reason }) => {
    const { day, failure } = parseOne(line);
    expect(failure).toEqual({ date: TUE, reason });
    expect(day).toEqual(unparsed(TUE, line));
  });
});

const WELL_FORMED = [
  "Mon 2026-11-09: rest",
  "Tue 2026-11-10: easy, 5 mi, HR under 150, flat",
  "Wed 2026-11-11: quality, 7 mi with 3 x 2 mi at threshold",
  "Thu 2026-11-12: recovery 40 min",
  "Fri 2026-11-13: strength, 30 min: squats, lunges, core",
  "Sat 2026-11-14: easy 4 mi with 6 strides",
  "Sun 2026-11-15: long 1h10, flat",
];

describe("parsePlanLines: a whole plan box", () => {
  it("returns seven parsed days and no failures for a well-formed week", () => {
    const result = parsePlanLines({ text: WELL_FORMED.join("\n"), weekStartMonday: MONDAY, unit: "imperial" });
    expect(result.failures).toEqual([]);
    expect(result.days.map((d) => d.date)).toEqual([
      "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
    ]);
    expect(result.days.every((d) => d.parsed === true)).toBe(true);
    expect(result.days.map((d) => [d.dayType, d.run?.distanceM ?? null, d.run?.durationS ?? null])).toEqual([
      ["rest", null, null],
      ["easy", mi(5), null],
      ["quality", mi(7), null],
      ["easy", 0, 2400],
      ["other", 0, 1800],
      ["easy", mi(4), null],
      ["long", 0, 4200],
    ]);
  });

  it("is the same for a metric athlete: the unit never changes the numbers", () => {
    const imperial = parsePlanLines({ text: WELL_FORMED.join("\n"), weekStartMonday: MONDAY, unit: "imperial" });
    const metric = parsePlanLines({ text: WELL_FORMED.join("\n"), weekStartMonday: MONDAY, unit: "metric" });
    expect(metric.days).toEqual(imperial.days);
    expect(metric.unit).toBe("metric");
  });

  it("a plan missing Thursday gives six parsed days, one no-plan day and one failure", () => {
    const text = WELL_FORMED.filter((l) => !l.startsWith("Thu")).join("\n");
    const result = parsePlanLines({ text, weekStartMonday: MONDAY, unit: "imperial" });
    expect(result.days.filter((d) => d.parsed === true)).toHaveLength(6);
    expect(result.days[3]).toEqual({
      date: "2026-11-12",
      dayType: "other",
      run: null,
      notes: NO_PLAN_GIVEN_NOTE,
      line: null,
      parsed: false,
    });
    expect(result.failures).toEqual([{ date: "2026-11-12", reason: "no line" }]);
  });

  it("a second line for a date fails that date and keeps both lines", () => {
    const text = [...WELL_FORMED, "Tue: easy 3 mi"].join("\n");
    const result = parsePlanLines({ text, weekStartMonday: MONDAY, unit: "imperial" });
    expect(result.failures).toEqual([{ date: TUE, reason: "two lines for one day" }]);
    expect(result.days[1]).toEqual(unparsed(TUE, `${WELL_FORMED[1]}\nTue: easy 3 mi`));
    expect(result.days.filter((d) => d.parsed === true)).toHaveLength(6);
  });

  it("a line dated outside the week is dropped and reported", () => {
    const text = [...WELL_FORMED, "Mon 2026-11-16: rest"].join("\n");
    const result = parsePlanLines({ text, weekStartMonday: MONDAY, unit: "imperial" });
    expect(result.failures).toEqual([{ date: "2026-11-16", reason: "outside the plan week" }]);
    expect(result.days).toHaveLength(7);
    expect(result.days[0]!.line).toBe("Mon 2026-11-09: rest");
  });

  it("ignores blank lines, whitespace-only lines and lines that open with no day", () => {
    const text = ["Week of 2026-11-09:", "", ...WELL_FORMED.map((l) => `  ${l}  `), "   ", "\r"].join("\r\n");
    const result = parsePlanLines({ text, weekStartMonday: MONDAY, unit: "imperial" });
    expect(result.failures).toEqual([]);
    expect(result.days[1]!.line).toBe(WELL_FORMED[1]);
    expect(result.ignoredLines).toEqual(["Week of 2026-11-09:"]);
  });

  it("an empty box reports every date as no line", () => {
    const result = parsePlanLines({ text: "  \n\n", weekStartMonday: MONDAY, unit: "imperial" });
    expect(result.failures.map((f) => f.reason)).toEqual(Array(7).fill("no line"));
    expect(result.days.every((d) => d.parsed === false && d.line === null)).toBe(true);
  });

  it("reports mixed failures by date in date order", () => {
    const text = [
      "Mon: rest",
      "Tue: easy 5",
      "Wed: 6 mi steady",
      "Fri: easy 4 mi",
      "Sat: easy 4 mi",
      "Sun: long 12 mi",
      "2026-11-20: easy 3 mi",
    ].join("\n");
    const result = parsePlanLines({ text, weekStartMonday: MONDAY, unit: "metric" });
    expect(result.failures).toEqual([
      { date: "2026-11-10", reason: "no distance unit" },
      { date: "2026-11-11", reason: "no day type word" },
      { date: "2026-11-12", reason: "no line" },
      { date: "2026-11-20", reason: "outside the plan week" },
    ]);
    expect(result.days.filter((d) => d.parsed === true)).toHaveLength(4);
  });
});
