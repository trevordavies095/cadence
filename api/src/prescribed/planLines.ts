/**
 * The plan-line parser: Coach Cade writes next week's plan as seven lines of
 * text, and Cadence derives the stored day shape from them, one day at a time
 * (.scratch/plan-as-text/spec.md, "The grammar").
 *
 * One day per line. A line is
 *   1. a day token at the start: a weekday name or abbreviation, a date
 *      YYYY-MM-DD, or both, resolved against the plan week's seven dates;
 *   2. a day-type word: the first word in the line that is a day type or is in
 *      PLAN_DAY_TYPE_SYNONYMS;
 *   3. optionally an amount: a distance (number + mi/km/k...) or a duration
 *      (number + min/h..., or 1h10, 1:10);
 *   4. free text, kept as the day's notes.
 *
 * Pure: no server, no database, no clock. A day that cannot be parsed is
 * returned as an unparsed day carrying its line, and its date and reason are
 * listed in `failures` so a retry can quote them.
 *
 * Judgement calls (argued in the ticket's test table, plan-lines.test.ts):
 * - The day token must open the line (after an optional list marker such as
 *   "-", "*", "1."). A line that does not open with one (a heading, a blank
 *   sentence) is not a day line; it is returned in `ignoredLines` and never
 *   lands on a date.
 * - Weekday and date both given but disagreeing: the date wins (it is the
 *   more specific token, and the prompt lists the seven dates).
 * - The type word is searched for anywhere after the day token, whole words
 *   only: "long" does not match "longer", "easy" matches "easy-ish". The
 *   earliest word in the line wins, synonym or canonical alike.
 * - The amount is the earliest distance or duration after the day token,
 *   wherever the type word is ("5 mi easy" parses). Notes are the text after
 *   that amount; text before it (other than the day token) is kept only in
 *   `line`. When there is no amount, notes are the text after the type word.
 * - A distance immediately followed by "pace" or "effort" ("at 5k pace") is
 *   an intensity, not the day's amount; likewise "race pace" is not a race.
 * - "No distance unit" is reported when a line that needs an amount has none
 *   and holds a number standing alone ("easy 5", "HR under 150"); numbers
 *   touching letters (4x800, 5k pace, Z2) are not bare.
 * - Colon times are h:mm (or h:mm:ss) with at most 5 hours; one that reads
 *   as a clock time or a pace ("at 6:00", "6:00 am", "7:30/mi", "8:00 pace")
 *   is not an amount.
 * - A distance followed directly by a duration ("5 mi, 45 min", "5 mi (45
 *   min)") sets both; a later amount after other words ("am 5 mi, pm 3 mi")
 *   is a double and only the first is stored.
 * - A rest line never gets a run, even if it states an amount.
 * - Two or more lines for one date fail that date; the unparsed day carries
 *   all of its lines, joined by a newline, so nothing the coach wrote is lost.
 *   Each date has at most one failure.
 * - Distances are stored to the whole metre, durations to the whole second.
 * - Unit spellings (mile/miles, kilometre/kilometer, min/mins/minute, hr/hrs/
 *   hour) are spelling, not vocabulary, and are all accepted; "m" alone is
 *   never minutes (it reads as metres) and metres are not a plan unit.
 * - The athlete's unit never resolves a bare number. It is taken so callers
 *   pass it, and returned for labelling only.
 */

import { expectedPlanDates } from "../llm/schema.js";
import type { DayType, PrescribedDay, PrescribedRun } from "../llm/types.js";
import type { TempoUnitPreference } from "../tempo/port.js";

/**
 * Cadence's coaching vocabulary: words a coach uses for a day type, mapped to
 * the type. This table is extended only by a recorded decision, noted here
 * with its date and reason, never by observing what a model writes. Field
 * names (dayType, run_type, ...) are never mapped.
 *
 * Decisions:
 * - 2026-11-02, plan-as-text spec: the initial table below. Hyphenated words
 *   also match with a space ("cross training", "strides session").
 * - 2026-11-02, maintainer: the singulars "interval" and "hill". Both file as
 *   quality because both are hard sessions; they are different workouts, and
 *   the coach's own word stays in the stored line, so the plan still shows which.
 * - 2026-11-02, maintainer: "walk-run" and "run-walk" are easy runs, not
 *   "other": a return-to-running walk-run is the week's running. Being longer,
 *   they win over "walk" at the same position.
 */
export const PLAN_DAY_TYPE_SYNONYMS: Readonly<Record<string, DayType>> = {
  tempo: "quality",
  intervals: "quality",
  interval: "quality",
  threshold: "quality",
  hills: "quality",
  hill: "quality",
  workout: "quality",
  fartlek: "quality",
  "strides-session": "quality",
  recovery: "easy",
  jog: "easy",
  shakeout: "easy",
  strength: "other",
  cross: "other",
  "cross-training": "other",
  bike: "other",
  swim: "other",
  walk: "other",
  "walk-run": "easy",
  "run-walk": "easy",
  yoga: "other",
  off: "rest",
};

/** The fixed failure reasons, quoted to the model on a retry. */
export type PlanLineFailureReason =
  | "no distance unit"
  | "no distance or duration"
  | "two lines for one day"
  | "outside the plan week"
  | "no line"
  | "no day type word";

export type PlanLineFailure = { date: string; reason: PlanLineFailureReason };

export type ParsePlanLinesInput = {
  /** The plan box as Coach Cade wrote it. */
  text: string;
  /** Monday of the plan week, YYYY-MM-DD. */
  weekStartMonday: string;
  /** The athlete's unit; labels display only, never resolves a bare number. */
  unit: TempoUnitPreference;
};

export type ParsePlanLinesResult = {
  /** Seven days, Monday to Sunday, in the stored shape. */
  days: PrescribedDay[];
  /** One entry per failed date, in date order. */
  failures: PlanLineFailure[];
  /** Non-blank lines that do not open with a day token. */
  ignoredLines: string[];
  unit: TempoUnitPreference;
};

export const NO_PLAN_GIVEN_NOTE = "Coach Cade gave no plan for this day";

const METRES_PER_MILE = 1609.344;
const METRES_PER_KM = 1000;
const MAX_COLON_HOURS = 5;

const CANONICAL_DAY_TYPES: readonly DayType[] = [
  "rest",
  "easy",
  "quality",
  "long",
  "race",
  "other",
];

const WEEKDAYS: ReadonlyArray<readonly string[]> = [
  ["monday", "mon"],
  ["tuesday", "tues", "tue"],
  ["wednesday", "weds", "wed"],
  ["thursday", "thurs", "thur", "thu"],
  ["friday", "fri"],
  ["saturday", "sat"],
  ["sunday", "sun"],
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word alternation; letters on either side break the match. */
function wordAlternation(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRegex(w).replace(/-/g, "[-\\s\u2010\u2011]"))
    .join("|");
}

const TYPE_WORDS: ReadonlyMap<string, DayType> = new Map<string, DayType>([
  ...CANONICAL_DAY_TYPES.map((t) => [t, t] as const),
  ...Object.entries(PLAN_DAY_TYPE_SYNONYMS),
]);

const TYPE_WORD_RE = new RegExp(
  `(?<![a-z])(${wordAlternation([...TYPE_WORDS.keys()])})(?![a-z])`,
  "gi",
);

/** The earliest day-type word; "race pace" / "race-pace" is an intensity, not a race. */
function firstTypeWord(body: string): { type: DayType; end: number } | null {
  TYPE_WORD_RE.lastIndex = 0;
  for (let m = TYPE_WORD_RE.exec(body); m; m = TYPE_WORD_RE.exec(body)) {
    const end = m.index + m[0].length;
    const word = m[1]!.toLowerCase().replace(/[\s‐‑]+/g, "-");
    if (word === "race" && /^[-\s]pace\b/i.test(body.slice(end))) continue;
    return { type: TYPE_WORDS.get(word)!, end };
  }
  return null;
}

const WEEKDAY_RE = new RegExp(
  `^(${wordAlternation(WEEKDAYS.flat())})(?![a-z])\\.?`,
  "i",
);
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?!\d)/;
const LIST_MARKER_RE = /^(?:[-*•]+|\d{1,2}[.)])\s+/;
const TOKEN_SEPARATOR_RE = /^[\s,:;()[\]\-–—.]+/;

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const DIST_UNIT = String.raw`(miles|mile|mi|kilometres|kilometre|kilometers|kilometer|kms|km|k)`;
const DUR_UNIT = String.raw`(minutes|minute|mins|min|hours|hour|hrs|hr|h)`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|to)\s*`;
const NOT_INTENSITY = String.raw`(?!\s*(?:pace|effort)\b)`;
const NOT_PACE = String.raw`(?!\s*(?:/|per\b|pace\b|min\s*/))`;

/** Sticky amount patterns, tried in order at each number in the line. */
const DISTANCE_RANGE_RE = new RegExp(
  `${NUM}${RANGE_SEP}\\d+(?:\\.\\d+)?\\s*${DIST_UNIT}(?![a-z])${NOT_INTENSITY}`,
  "iy",
);
const DISTANCE_RE = new RegExp(
  `${NUM}\\s*${DIST_UNIT}(?![a-z])${NOT_INTENSITY}`,
  "iy",
);
const DURATION_RANGE_RE = new RegExp(
  `${NUM}${RANGE_SEP}\\d+(?:\\.\\d+)?\\s*${DUR_UNIT}(?![a-z])${NOT_PACE}`,
  "iy",
);
/** 1h10, 1h10m, 1 hr 10 min. */
const HOURS_MINUTES_RE = new RegExp(
  String.raw`(\d+)\s*(?:hours|hour|hrs|hr|h)(?:(\d{1,2})(?:mins|min|m)?|\s*(\d{1,2})\s*(?:minutes|minute|mins|min))(?![a-z])`,
  "iy",
);
const DURATION_RE = new RegExp(
  `${NUM}\\s*${DUR_UNIT}(?![a-z])${NOT_PACE}`,
  "iy",
);
/** 1:10 or 1:10:00, not a clock time or a pace. */
const COLON_RE = new RegExp(
  String.raw`(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\d:])(?!\s*(?:am|pm)\b)${NOT_PACE}`,
  "iy",
);

/**
 * A number standing alone: not touching a letter (4x800, 5k, Z2), a colon,
 * a slash or a percent sign. Dates are removed before this is tested.
 */
const BARE_NUMBER_RE = /(?<![\w.:/×])\d+(?:\.\d+)?(?![\w.:/%×])/;
const ANY_DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/**
 * A race named with no number is its distance (2026-11-02, maintainer):
 * "race: half marathon" files 21.1 km. Only when the line has no number
 * amount, and never when the name is an intensity ("marathon pace",
 * "half-marathon effort"). Half marathon is matched before marathon.
 */
const RACE_NAME_DISTANCES_M: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bhalf[-\s]+marathon\b(?![-\s]+(?:pace|effort)\b)/i, 21098],
  [/\bmarathon\b(?![-\s]+(?:pace|effort)\b)/i, 42195],
];

function raceNameAmount(text: string): { distanceM: number; end: number } | null {
  for (const [re, distanceM] of RACE_NAME_DISTANCES_M) {
    const m = re.exec(text);
    if (m) return { distanceM, end: m.index + m[0].length };
  }
  return null;
}

type Amount = {
  distanceM: number | null;
  durationS: number | null;
  start: number;
  end: number;
};

function unitMetres(unit: string): number {
  return unit.toLowerCase().startsWith("mi") ? METRES_PER_MILE : METRES_PER_KM;
}

function unitSeconds(unit: string): number {
  return unit.toLowerCase().startsWith("h") ? 3600 : 60;
}

/** The amount that starts exactly at `at`, if any. */
function amountAt(text: string, at: number): Amount | null {
  const tryRe = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = at;
    return re.exec(text);
  };
  let m = tryRe(DISTANCE_RANGE_RE) ?? tryRe(DISTANCE_RE);
  if (m) {
    return {
      distanceM: Math.round(Number(m[1]) * unitMetres(m[2]!)),
      durationS: null,
      start: at,
      end: at + m[0].length,
    };
  }
  m = tryRe(HOURS_MINUTES_RE);
  if (m) {
    const minutes = Number(m[2] ?? m[3]);
    return {
      distanceM: null,
      durationS: Number(m[1]) * 3600 + minutes * 60,
      start: at,
      end: at + m[0].length,
    };
  }
  m = tryRe(DURATION_RANGE_RE) ?? tryRe(DURATION_RE);
  if (m) {
    return {
      distanceM: null,
      durationS: Math.round(Number(m[1]) * unitSeconds(m[2]!)),
      start: at,
      end: at + m[0].length,
    };
  }
  m = tryRe(COLON_RE);
  if (m && Number(m[1]) <= MAX_COLON_HOURS && !/\bat\s*$/i.test(text.slice(0, at))) {
    return {
      distanceM: null,
      durationS: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0),
      start: at,
      end: at + m[0].length,
    };
  }
  return null;
}

/**
 * A repeat pattern: two durations in a row, each naming what it is, joined
 * by a slash, a comma or "and" ("3 min run / 1 min walk", "2 min on, 1 min
 * off", "90 sec hard and 90 sec easy"). It describes how the session is run,
 * not how long it is, so it is masked before amounts are read and stays in the
 * sentence only (2026-11-02: a walk-run day stored "3 min" as its length). A
 * single duration ("40 min easy", "2 h on trails") is never a pattern.
 */
/** What each half of a repeat is; both halves must name one, so "24 min, 4 min run" is no pattern. */
const REP_WORD = String.raw`(?:run|running|walk|walking|jog|jogging|on|off|hard|easy|fast|steady|rest|recovery|float)(?![a-z])`;

const REP_PATTERN_RE = new RegExp(
  String.raw`\d+(?:\.\d+)?\s*(?:minutes|minute|mins|min|seconds|second|secs|sec|s)\.?\s+${REP_WORD}\s*(?:\/|,|\band\b)\s*\d+(?:\.\d+)?\s*(?:minutes|minute|mins|min|seconds|second|secs|sec|s)\.?\s+${REP_WORD}`,
  "gi",
);

/** `text` with every repeat pattern blanked out, so indices still line up. */
function maskRepPatterns(text: string): string {
  return text.replace(REP_PATTERN_RE, (m) => " ".repeat(m.length));
}

/** The first amount in `text`, scanning each number that starts a token. */
function firstAmount(text: string, from = 0): Amount | null {
  const numberStart = /(?<![\w.:])\d/g;
  numberStart.lastIndex = from;
  for (let m = numberStart.exec(text); m; m = numberStart.exec(text)) {
    const found = amountAt(text, m.index);
    if (found) return found;
  }
  return null;
}

/**
 * A distance directly followed by a duration (or the reverse) sets both:
 * "5 mi, 45 min", "5 mi (45 min)", "45 min / 5 mi". A range written with a
 * unit on both ends ("5 mi to 6 mi") swallows its second end.
 */
function extendAmount(text: string, first: Amount): Amount {
  const rest = text.slice(first.end);
  const rangeEnd = new RegExp(`^${RANGE_SEP}(?=\\d)`, "i").exec(rest);
  if (rangeEnd) {
    const second = amountAt(text, first.end + rangeEnd[0].length);
    if (second && (second.distanceM != null) === (first.distanceM != null)) {
      return { ...first, end: second.end };
    }
  }
  const joiner = /^[\s,/(~≈\-–—]*(?:(?:or|in|about|approx\.?)\s+)?[~≈]?/i.exec(rest)!;
  const second = amountAt(text, first.end + joiner[0].length);
  if (!second) return first;
  if (first.distanceM != null && first.durationS == null && second.durationS != null && second.distanceM == null) {
    return { ...first, durationS: second.durationS, end: second.end };
  }
  if (first.durationS != null && first.distanceM == null && second.distanceM != null && second.durationS == null) {
    return { ...first, distanceM: second.distanceM, end: second.end };
  }
  return first;
}

function cleanNotes(text: string): string | null {
  const trimmed = text.replace(/^[\s,;:.)\]\-–—/]+/, "").trim();
  return trimmed === "" ? null : trimmed;
}

type DayToken = { weekdayIndex: number | null; date: string | null; rest: string };

/** Reads the weekday and/or date that open a line, in either order. */
function readDayToken(body: string): DayToken | null {
  let rest = body;
  let weekdayIndex: number | null = null;
  let date: string | null = null;
  for (let i = 0; i < 2; i++) {
    rest = rest.replace(TOKEN_SEPARATOR_RE, "");
    const wd: RegExpExecArray | null = weekdayIndex == null ? WEEKDAY_RE.exec(rest) : null;
    if (wd) {
      const word = wd[1]!.toLowerCase();
      weekdayIndex = WEEKDAYS.findIndex((names) => names.includes(word));
      rest = rest.slice(wd[0].length);
      continue;
    }
    const dt: RegExpExecArray | null = date == null ? DATE_RE.exec(rest) : null;
    if (dt) {
      date = dt[1]!;
      rest = rest.slice(dt[0].length);
      continue;
    }
    break;
  }
  if (weekdayIndex == null && date == null) return null;
  return { weekdayIndex, date, rest };
}

type LineOutcome =
  | { ok: true; day: PrescribedDay }
  | { ok: false; reason: PlanLineFailureReason };

/** Parses the text after the day token into a stored day for `date`. */
function parseDayBody(date: string, line: string, body: string): LineOutcome {
  const typeWord = firstTypeWord(body);
  if (!typeWord) return { ok: false, reason: "no day type word" };
  const dayType = typeWord.type;
  const afterType = body.slice(typeWord.end);

  const parsedDay = (run: PrescribedRun | null, notes: string | null): LineOutcome => ({
    ok: true,
    day: { date, dayType, run, strength: null, notes, line, parsed: true },
  });

  if (dayType === "rest") return parsedDay(null, cleanNotes(afterType));

  const amounts = maskRepPatterns(body);
  const first = firstAmount(amounts);
  if (!first) {
    const race = raceNameAmount(body);
    if (race) {
      return parsedDay(
        { type: dayType, distanceM: race.distanceM, durationS: null, structure: null, paceOrHr: null, shoes: null },
        cleanNotes(body.slice(race.end)),
      );
    }
    if (BARE_NUMBER_RE.test(amounts.replace(ANY_DATE_RE, " "))) return { ok: false, reason: "no distance unit" };
    if (dayType === "other") return parsedDay(null, cleanNotes(afterType));
    return { ok: false, reason: "no distance or duration" };
  }
  const amount = extendAmount(amounts, first);
  const run: PrescribedRun = {
    type: dayType,
    distanceM: amount.distanceM ?? 0,
    durationS: amount.durationS,
    structure: null,
    paceOrHr: null,
    shoes: null,
  };
  return parsedDay(run, cleanNotes(body.slice(amount.end)));
}

function unparsedDay(date: string, line: string): PrescribedDay {
  return { date, dayType: "other", run: null, notes: line, line, parsed: false };
}

function noPlanDay(date: string): PrescribedDay {
  return { date, dayType: "other", run: null, notes: NO_PLAN_GIVEN_NOTE, line: null, parsed: false };
}

/**
 * A day starting mid-line: a weekday and a full date followed by a colon, or a
 * full date and a colon, right after the end of a sentence. Both parts are
 * required, so a mention of another day ("same as Tue") never splits a line.
 */
const MID_LINE_DAY_RE =
  /(?<=[.;!?|]\s+)(?=(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?\d{4}-\d{2}-\d{2}\s*:)/gi;

/**
 * The plan box's lines, one per day. Besides newlines, a line is also split
 * where a new day starts mid-line: gpt-oss-20b wrote whole weeks on one line
 * as sentences ("Mon 2026-09-28: easy, 6 km. Tue 2026-09-29: threshold, ...")
 * in 2 of 15 weekly reads on 2026-11-02, which otherwise file only Monday.
 * An escaped newline, the two characters backslash and n, is a line break
 * too: gpt-oss-20b separated a week's days that way in the gate run of
 * 2026-11-02, and a coach's sentence never means it literally.
 */
function splitDayLines(text: string): string[] {
  return text
    .split(/\r?\n|\\(?:r\\)?n/)
    .flatMap((line) => line.split(MID_LINE_DAY_RE));
}

/**
 * Parses the plan box into seven stored days for the plan week starting
 * `weekStartMonday`, plus the dates that failed and why.
 */
export function parsePlanLines(input: ParsePlanLinesInput): ParsePlanLinesResult {
  const dates = expectedPlanDates(input.weekStartMonday);
  const linesByDate = new Map<string, string[]>();
  const bodyByDate = new Map<string, string>();
  const failures = new Map<string, PlanLineFailureReason>();
  const ignoredLines: string[] = [];

  for (const raw of splitDayLines(input.text)) {
    const line = raw.trim().replace(LIST_MARKER_RE, "").trim();
    if (line === "") continue;
    const token = readDayToken(line);
    if (!token) {
      ignoredLines.push(line);
      continue;
    }
    const date = token.date ?? dates[token.weekdayIndex!]!;
    if (!dates.includes(date)) {
      failures.set(date, "outside the plan week");
      continue;
    }
    const seen = linesByDate.get(date);
    if (seen) seen.push(line);
    else linesByDate.set(date, [line]);
    bodyByDate.set(date, token.rest);
  }

  const days = dates.map((date): PrescribedDay => {
    const lines = linesByDate.get(date);
    if (!lines) {
      failures.set(date, "no line");
      return noPlanDay(date);
    }
    if (lines.length > 1) {
      failures.set(date, "two lines for one day");
      return unparsedDay(date, lines.join("\n"));
    }
    const outcome = parseDayBody(date, lines[0]!, bodyByDate.get(date)!);
    if (outcome.ok) return outcome.day;
    failures.set(date, outcome.reason);
    return unparsedDay(date, lines[0]!);
  });

  return {
    days,
    failures: [...failures]
      .map(([date, reason]) => ({ date, reason }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    ignoredLines,
    unit: input.unit,
  };
}
