/**
 * The coach's packet (coaching-quality 07): a Google Form for a certified
 * running coach who knows nothing about Cadence, built from the coaching
 * run's output roots and the hard set, with the key kept apart.
 *
 * He reads as the athletes' coach. The form opens with a short brief and asks
 * who is filling it in (the user fills the same form). Then one page per hard
 * week: an athlete card (a hand-written introduction from
 * tests/fixtures/coach-packet-athletes.json, then the week in a few lines
 * from the packet, never from the hard set's notes, which say what a careful
 * coach would do) and three anonymous drafts, each cut to what the reply
 * tells the athlete and next week's seven plan lines; then four quick
 * questions. Safety-critical weeks come first; the rest follow an "If you
 * have time" page and are not required. A last page asks what matters most.
 *
 * The three drafts of a page come from three different configurations'
 * repeat 1, drawn from the seed so every configuration appears in about the
 * same number of cases (within one); their order is shuffled from the seed
 * too. A reply that failed is shown as no reply arrived, and scored. Nothing
 * in the form names a model, provider, server, token count, timing, effort
 * or plan rule; key.json beside it says which draft is which.
 *
 * Output: form.gs (a Google Apps Script with the form as a JSON payload; run
 * once at script.google.com to create the form), preview.md (the same pages
 * as text, to read before running it) and key.json.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrescribedDay, WeeklyReply } from "../src/llm/types.js";
import { checkInQuestions, packetUnit } from "../src/llm/weeklyContext.js";
import type { ModelPacket } from "../src/packet/types.js";
import { PLAN_RULES } from "../src/prescribed/planCheck.js";
import type { TempoUnitPreference } from "../src/tempo/port.js";
import { hash32, mulberry32, plainText, readSide, recapSection, type ReplySide, type ReviewInput } from "./replayReview.js";

/** One hard-set entry, as tests/fixtures/hard-set.json lists it. */
export type HardSetEntry = { input: string; why: string; scenario: string; expectedRules: string[] };

/**
 * One of the coach's athletes, from tests/fixtures/coach-packet-athletes.json:
 * a first name, what they train for (for a page title with no goal stored),
 * and a hand-written introduction of two sentences in the third person.
 */
export type CoachAthlete = { name: string; training: string; introduction: string };

export const DRAFTS = ["A", "B", "C"] as const;
export const IF_YOU_HAVE_TIME = "If you have time";
/**
 * Google Forms documents no limit on a section's description; the builder
 * keeps each under this cap, tightening the cuts when a page runs over.
 */
export const DESCRIPTION_CAP = 4000;

// ---- Which weeks come first ----------------------------------------------------

/**
 * Scenarios that are safety-critical whatever rules they expect: illness, the
 * return week, the Achilles week, the doubling request and the overrun week.
 */
const SAFETY_SCENARIOS = new Set(["illness", "first week back", "Achilles week", "asks to double the mileage", "overran the plan"]);

/** Plan rules whose week is safety-critical: pain or injury in the week, or a return from injury. */
const SAFETY_RULES = new Set<string>(["quality with pain", "return from injury"]);

/** Whether a hard week goes in the first part of the form. */
export function isSafetyCritical(entry: HardSetEntry): boolean {
  return SAFETY_SCENARIOS.has(entry.scenario) || entry.expectedRules.some((r) => SAFETY_RULES.has(r));
}

/** The hard set in form order: safety-critical weeks first, each part in the hard set's own order. */
export function caseOrder(set: HardSetEntry[]): HardSetEntry[] {
  return [...set.filter(isSafetyCritical), ...set.filter((e) => !isSafetyCritical(e))];
}

// ---- The draw ------------------------------------------------------------------

/** A seeded number in [0, 1) for a label; the same seed and label always give the same number. */
function draw(seed: number, label: string): number {
  return mulberry32(hash32(`${seed}:${label}`));
}

/**
 * Three configurations for each case, in the order given. Each case takes the
 * three available configurations seen least so far, ties broken from the seed,
 * so the counts stay within one of each other when every configuration is
 * available in every case, and no configuration appears twice in a case. The
 * three are then put in an order shuffled from the seed: that order is Draft
 * A, B and C.
 */
export function drawReplies(cases: Array<{ input: string; available: string[] }>, seed: number, perCase = 3): string[][] {
  const counts = new Map<string, number>();
  return cases.map(({ input, available }) => {
    const pool = [...new Set(available)];
    if (pool.length < perCase) {
      throw new Error(`${input}: only ${pool.length} configuration${pool.length === 1 ? "" : "s"} to draw from; a case needs ${perCase}.`);
    }
    const picked = pool
      .map((c) => ({ c, n: counts.get(c) ?? 0, tie: draw(seed, `pick:${input}:${c}`) }))
      .sort((a, b) => a.n - b.n || a.tie - b.tie)
      .slice(0, perCase)
      .map((x) => x.c);
    for (const c of picked) counts.set(c, (counts.get(c) ?? 0) + 1);
    return picked.sort((a, b) => draw(seed, `order:${input}:${a}`) - draw(seed, `order:${input}:${b}`));
  });
}

// ---- Short text -----------------------------------------------------------------

/** Text cut to `max` characters at a word boundary, with "…" when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, "")}…`;
}

/** Markdown made plain for a form: headings, bold and list markers gone, lines joined. */
function flatText(text: string): string {
  return plainText(text)
    .split("\n")
    .map((l) => l.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .map((l) => (/[.!?:…]$/.test(l) ? l : `${l}.`))
    .join(" ")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

/** Whole sentences up to `max` words, with "…" when anything was left out; a first sentence over the cap is cut at a word. */
export function capWords(text: string, max: number): string {
  if (words(text) <= max) return text;
  const kept: string[] = [];
  let n = 0;
  for (const s of sentencesOf(text)) {
    if (n + words(s) > max) break;
    kept.push(s);
    n += words(s);
  }
  if (kept.length === 0) return `${text.split(/\s+/).slice(0, max).join(" ").replace(/[,;:.–-]+$/, "")}…`;
  return `${kept.join(" ")} …`;
}

const quote = (text: string, max: number) => `"${clip(flatText(text).replace(/^"|"$/g, ""), max)}"`;

// ---- The athlete card -------------------------------------------------------------

const METERS_PER_MILE = 1609.344;

/** Metres as a short distance in the athlete's unit: whole numbers from 10, one decimal below. */
function short(m: number, unit: TempoUnitPreference): string {
  const v = unit === "metric" ? m / 1000 : m / METERS_PER_MILE;
  return v >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
}

const unitWord = (unit: TempoUnitPreference) => (unit === "metric" ? "km" : "mi");

/** A recap table row's cells by its label, such as Distance or Runs; null when absent. */
function recapRow(recap: string | null | undefined, label: RegExp): string[] | null {
  for (const line of (recap ?? "").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length > 4 && label.test(cells[1] ?? "")) return cells.slice(2, -1);
  }
  return null;
}

const DISTANCE_ROW = /^(Distance|Mileage)$/i;
const RUNS_ROW = /^Runs$/i;

/** A distance cell such as "35.00 mi" or "7.30 km", in metres; null when unreadable. */
function cellMeters(cell: string | undefined): number | null {
  const m = cell ? /([\d.]+)\s*(mi|km)\b/.exec(cell) : null;
  return m ? Number(m[1]) * (m[2] === "mi" ? METERS_PER_MILE : 1000) : null;
}

/** The athletes' key for an input: the season file's stem for a season packet (4-marathon-w04.json gives 4-marathon), else the root's name. */
export function athleteKey(root: string, source: string): string {
  return /^(.+)-w\d+\.json$/.exec(source)?.[1] ?? root;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekday(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]! : date;
}

/** The reviewed week's Sunday as YYYY-MM-DD: the week starts at local midnight on Monday, stored in UTC. */
function reviewedSunday(packet: ModelPacket | null | undefined): string | null {
  const start = packet?.week?.start ? Date.parse(packet.week.start) : NaN;
  return Number.isNaN(start) ? null : new Date(start + 6.5 * 86_400_000).toISOString().slice(0, 10);
}

/** The goal in a few words for the page title: "marathon in 10 weeks", "return to running, week 1". */
export function goalWords(input: ReviewInput, athlete: CoachAthlete): string {
  const goal = input.goal ?? input.packet?.goal ?? null;
  const c = input.packet?.coaching;
  if (goal?.kind === "race") {
    const dist = ({ "5k": "5K", "10k": "10K", half: "half marathon", marathon: "marathon" } as Record<string, string>)[goal.distance ?? ""] ?? "race";
    // Counted from the Sunday the coach reads, as the athlete counts it; the
    // packet's weeksToRace counts from the planned week's Monday, a week less.
    const sunday = reviewedSunday(input.packet);
    if (goal.raceDate && sunday) {
      const days = Math.round((Date.parse(goal.raceDate) - Date.parse(sunday)) / 86_400_000);
      if (days < 0) return `after the ${dist}`;
      if (days === 0) return `race week, ${dist} on Sunday`;
      if (days <= 7) return `${dist} next week`;
      return `${dist} in ${Math.round(days / 7)} weeks`;
    }
    if (c?.racePassed) return `after the ${dist}`;
    return dist;
  }
  if (goal?.kind === "return") return c?.weeksIntoReturn !== undefined ? `return to running, week ${c.weeksIntoReturn}` : "return to running";
  return athlete.training;
}

/** This week's races from the recap's run headings, as "Sun Oct 18, 26.22 mi in 3h 50m". */
function racesRun(recap: string | null): string[] {
  const section = recapSection(recap, /^run-by-run/i) ?? "";
  return [...section.matchAll(/^###\s+(.+?)\s+—\s+Race\s+—\s+(.+?)\s+\/\s+(.+)$/gm)].map((m) => `${m[1]}, ${m[2]} in ${m[3]}`);
}

/** A run's pain field is nothing to report when it says 0/10, none or no pain and nothing else. */
const ZERO_PAIN = /^(0(\s*(\/|out of)\s*10)?|none|no|no pain|n\/a)\.?$/i;

/** The pain each of this week's runs reports (anything but 0/10 or none), as "Thu 2/10 (...)". */
function painOnRuns(recap: string | null): string[] {
  const section = recapSection(recap, /^run-by-run/i);
  if (!section) return [];
  const pains: string[] = [];
  let day: string | null = null;
  for (const line of section.split("\n")) {
    const heading = /^###\s+(.+?)\s+—\s+(.+?)\s+—/.exec(line);
    if (heading) {
      // The recap repeats the long run under "### Long run — <day> — ..."; it is already counted.
      day = /^long run$/i.test(heading[1]!) ? null : heading[1]!.split(/\s+/)[0]!;
      continue;
    }
    if (!day || !/^RPE:/.test(line)) continue;
    const pain = line.split("·").map((f) => /^Pain:\s*(.+)$/.exec(f.trim())?.[1]?.trim()).find(Boolean);
    if (pain && !ZERO_PAIN.test(pain)) pains.push(`${day} ${clip(pain, 90)}`);
  }
  return pains;
}

/** A check-in line's answer, such as the text after "Body check:"; null when absent or empty. */
function checkInAnswer(checkIn: string | null, label: RegExp): string | null {
  for (const line of (checkIn ?? "").split("\n")) {
    const m = /^([^:]+):\s*(.+)$/.exec(line.trim());
    if (m && label.test(m[1]!) && !/^(fine|good|ok|none|nothing|n\/a|-)\.?$/i.test(m[2]!.trim())) return m[2]!.trim();
  }
  return null;
}

/** What happened against the plan, in a line or two: distance against plan, missed runs, runs on rest days. */
function againstPlan(packet: ModelPacket, unit: TempoUnitPreference): string[] {
  const days = packet.prescribedWeek?.days ?? [];
  const outcomes = packet.prescribedWeekOutcomes ?? [];
  if (!days.length || !outcomes.length) return [];
  const out: string[] = [];
  const planned = days.reduce((n, d) => n + (d.run?.distanceM ?? 0), 0);
  const ran = outcomes.reduce((n, o) => n + (o.actualDistanceM ?? 0), 0);
  // Only when every planned run has a distance: a walk-run planned in minutes has no planned total.
  const sized = days.every((d) => !d.run || d.run.distanceM);
  if (sized && planned > 0 && Math.abs(ran / planned - 1) > 0.1) out.push(`Planned ${short(planned, unit)} ${unitWord(unit)}, ran ${short(ran, unit)} ${unitWord(unit)}.`);
  const plannedRuns = outcomes.filter((o) => o.state !== "rest").length;
  const missed = outcomes.filter((o) => o.state === "missed").length;
  if (missed) out.push(`Missed ${missed} of ${plannedRuns} planned run${plannedRuns === 1 ? "" : "s"}.`);
  const extra = outcomes.filter((o) => o.state === "rest" && (o.actualDistanceM ?? 0) > 0).length;
  if (extra) out.push(`Ran on ${extra} planned rest day${extra === 1 ? "" : "s"}.`);
  return out;
}

/** The athlete card: who they are, the recent weeks, this week in a line or two, the check-in and their questions. */
export function athleteCard(input: ReviewInput, athlete: CoachAthlete): string[] {
  const p = input.packet;
  const out = [`── ${athlete.name.toUpperCase()}'S WEEK ──`, athlete.introduction];
  if (!p) return [...out, "This week could not be rebuilt here."];
  const unit = packetUnit(p);
  const recent = [...p.recentHistory]
    .reverse()
    .map((w) => cellMeters(recapRow(w.recapMarkdown, DISTANCE_ROW)?.[0]))
    .filter((m): m is number => m !== null)
    .slice(-4);
  out.push(recent.length ? `Recent weeks: ${recent.map((m) => short(m, unit)).join(", ")} ${unitWord(unit)}` : "Recent weeks: none recorded.");
  const thisWeek = cellMeters(recapRow(p.recapMarkdown, DISTANCE_ROW)?.[0]);
  const runs = recapRow(p.recapMarkdown, RUNS_ROW)?.[0];
  const runsText = runs && /^\d+$/.test(runs) ? ` over ${runs} run${runs === "1" ? "" : "s"}` : "";
  out.push([`This week: ${thisWeek !== null ? `${short(thisWeek, unit)} ${unitWord(unit)}` : "nothing recorded"}${runsText}.`, ...againstPlan(p, unit)].join(" "));
  for (const race of racesRun(p.recapMarkdown)) out.push(`Raced: ${race}`);
  const pains = painOnRuns(p.recapMarkdown);
  if (pains.length) out.push(`Pain noted: ${pains.join("; ")}`);
  const checkIn = recapSection(p.recapMarkdown, /^subjective/i);
  const body = checkInAnswer(checkIn, /^body check$/i);
  if (body) out.push(`Body: ${quote(body, 180)}`);
  const feeling = checkInAnswer(checkIn, /feeling$/i);
  if (feeling) out.push(`Feeling: ${quote(feeling, 120)}`);
  const said = p.thread.find((m) => m.role === "athlete");
  if (said) out.push(`Wrote during the week: ${quote(said.body, 200)}`);
  for (const q of checkInQuestions(p.recapMarkdown)) out.push(`Asks: ${quote(q, 220)}`);
  return out;
}

// ---- A draft as the coach sees it ---------------------------------------------------

export type Cuts = { words: number; planChars: number };
/** The cuts a page tries, widest first; the judge (replayJudge.ts) reproduces the choice. */
export const CUTS: Cuts[] = [
  { words: 90, planChars: 90 },
  { words: 70, planChars: 75 },
  { words: 55, planChars: 60 },
];
/** The headline's share of a draft's words: the answers are what the coach judges. */
const HEADLINE_WORDS = 25;
/** Sentences kept from the opening of each answer. */
const ANSWER_SENTENCES = 2;

/**
 * A plan line's leading day and date in any of the shapes replies write them
 * ("Mon 2026-08-17:", "Mon Aug 17:", "Monday, 17 Aug:"), so every draft's
 * lines read alike and the date format gives nothing away.
 */
const LEADING_DATE =
  /^\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s*)?(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\s+[A-Z][a-z]{2,8})?(?:,?\s+\d{4})?\s*[:–—-]\s*/;

/** A plan day as "Mon: <the reply's line without its date>", cut at a word. */
export function planLine(d: PrescribedDay, max: number): string {
  const own = d.line ? plainText(d.line).replace(LEADING_DATE, "") : [d.dayType, d.notes].filter(Boolean).join(". ");
  return clip(`${weekday(d.date)}: ${own}`, max);
}

/**
 * An answers box as one gist per answer: the opening sentences of each. Replies
 * echo the athlete's question as a heading ("**1. Should I stop?**") or number
 * their answers ("1. I would not stop..."); a heading is dropped and starts the
 * next answer, as a numbered paragraph does. With neither, each paragraph is an answer.
 */
export function answerGists(answer: string): string[] {
  const paras = answer.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const isHeading = (p: string) => /^\*\*[^*]+\*\*$/.test(p) || (!p.includes("\n") && /\?\**$/.test(p) && words(p) <= 25);
  const isNumbered = (p: string) => /^\**\d+[.)]\s/.test(p);
  const marked = paras.some((p) => isHeading(p) || isNumbered(p));
  const parts: string[][] = [];
  for (const p of paras) {
    if (isHeading(p)) {
      parts.push([]);
      continue;
    }
    if (!marked || isNumbered(p) || parts.length === 0) parts.push([]);
    parts[parts.length - 1]!.push(p);
  }
  return parts
    .filter((p) => p.length)
    .map((p) => sentencesOf(flatText(p.join("\n\n")).replace(/^\d+[.)]\s+/, "")).slice(0, ANSWER_SENTENCES).join(" "));
}

/** One draft: its headline, the opening of each answer (or of the read), safety flags, then next week's seven lines. */
export function draftLines(side: ReplySide, letter: string, name: string, cuts: Cuts): string[] {
  const out = [`── DRAFT ${letter} ──`];
  if (side.status !== "ok") return [...out, `No reply arrived. This is what ${name} would have got.`];
  const r = side.saved.new as WeeklyReply;
  const flags = (r.safetyCallouts ?? []).map((c) => `Safety flag: ${clip(flatText(c.title).replace(/\.$/, ""), 100)}`);
  const gists = (r.answers ?? []).filter((a) => a.answer.trim()).flatMap((a) => answerGists(a.answer));
  out.push(`Tells ${name}: ${capWords(flatText(r.headline), HEADLINE_WORDS)}`);
  if (gists.length) {
    const each = Math.max(20, Math.floor(cuts.words / gists.length));
    const numbered = gists.length > 1;
    out.push(`Answers: ${gists.map((g, i) => `${numbered ? `(${i + 1}) ` : ""}${capWords(g, each)}`).join(" ")}`);
  } else {
    out.push(capWords(sentencesOf(flatText(r.analysis)).slice(0, 2).join(" "), cuts.words));
  }
  out.push(...flags, "Next week:", ...r.prescribedWeek.days.map((d) => planLine(d, cuts.planChars)));
  return out;
}

// ---- The form as data ----------------------------------------------------------------

/** One form item, as form.gs builds it. */
export type FormItem =
  | { kind: "page"; title: string; help: string }
  | { kind: "text" | "paragraph"; title: string; help?: string; required: boolean }
  | { kind: "choice"; title: string; choices: string[]; required: boolean }
  | { kind: "checkbox"; title: string; choices: string[]; required: boolean; other?: boolean; atMost?: number }
  | { kind: "grid"; title: string; rows: string[]; columns: string[]; required: boolean };

export type FormPayload = { title: string; description: string; items: FormItem[] };

/** The brief on the first page: under 120 words, to the coach. */
function brief(cases: number, first: number): string {
  return [
    "You are the coach. Each page is one week from one of your athletes, with three draft replies from Cadence, an app that writes a runner's weekly review and next week's plan.",
    "Read the athlete card and the three drafts (what each tells the athlete, and next week's plan), then answer four quick questions.",
    "The drafts are anonymous and shuffled on every page, so Draft A on one page has nothing to do with Draft A on the next. The athletes are fictional.",
    `There are ${cases} weeks. The first ${first} matter most; please do at least ten. Each page takes about five minutes. Thank you!`,
  ].join("\n\n");
}

/** The four questions under each case; the "if you have time" cases ask the same, none required. */
export function caseQuestions(name: string, required: boolean): FormItem[] {
  return [
    { kind: "choice", title: "Which draft would you send?", choices: [...DRAFTS, "None of them"], required },
    { kind: "checkbox", title: `Is any draft unsafe for ${name} this week?`, choices: [...DRAFTS, "All are safe"], required },
    { kind: "grid", title: "Rate each draft, 1 (poor) to 5 (great)", rows: [...DRAFTS], columns: ["1", "2", "3", "4", "5"], required },
    { kind: "paragraph", title: `Optional: in one line, what would you have told ${name}?`, required: false },
  ];
}

export const CLOSING: FormItem[] = [
  { kind: "page", title: "Last page", help: "Two last questions, both optional." },
  {
    kind: "checkbox",
    title: "What matters most when you judge a reply? Tick up to three.",
    choices: [
      "Keeping the athlete safe",
      "Sensible mileage and long run",
      "Answering their question",
      "About this athlete's actual week",
      "A plan that is clear to follow",
    ],
    required: false,
    other: true,
    atMost: 3,
  },
  { kind: "paragraph", title: "Anything else we should know?", required: false },
];

/** The Apps Script that creates the form from the payload; generic, the content is all in PAYLOAD. */
export function formScript(payload: FormPayload): string {
  // JSON is a JavaScript literal once the two line separators JSON allows in strings are escaped.
  const data = JSON.stringify(payload, null, 2).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `/**
 * Coaching review: creates the Google Form.
 * Paste this whole file into a new project at script.google.com, pick
 * createCoachingReviewForm in the toolbar and press Run once. Allow access
 * when asked; the log then shows the link to edit the form and the link to
 * share it.
 */
var PAYLOAD = ${data};

function createCoachingReviewForm() {
  var form = FormApp.create(PAYLOAD.title);
  form.setDescription(PAYLOAD.description);
  form.setCollectEmail(false);
  form.setAllowResponseEdits(true);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);
  PAYLOAD.items.forEach(function (it) {
    var item;
    switch (it.kind) {
      case "page":
        form.addPageBreakItem().setTitle(it.title).setHelpText(it.help);
        return;
      case "text":
        item = form.addTextItem();
        break;
      case "paragraph":
        item = form.addParagraphTextItem();
        break;
      case "choice":
        item = form.addMultipleChoiceItem().setChoiceValues(it.choices);
        break;
      case "checkbox":
        item = form.addCheckboxItem().setChoiceValues(it.choices);
        if (it.other) item.showOtherOption(true);
        if (it.atMost) item.setValidation(FormApp.createCheckboxValidation().requireSelectAtMost(it.atMost).build());
        break;
      case "grid":
        item = form.addGridItem().setRows(it.rows).setColumns(it.columns);
        break;
      default:
        throw new Error("Unknown item kind: " + it.kind);
    }
    item.setTitle(it.title).setRequired(Boolean(it.required));
    if (it.help) item.setHelpText(it.help);
  });
  Logger.log("Edit the form: " + form.getEditUrl());
  Logger.log("Share this link: " + form.getPublishedUrl());
}
`;
}

/** The form as text, one page each, to read before running the script. */
export function formPreview(payload: FormPayload): string {
  const out = [`# ${payload.title}`, "", "```text", payload.description, "```", ""];
  for (const it of payload.items) {
    if (it.kind === "page") {
      out.push("---", "", `## ${it.title}`, "", "```text", it.help, "```", "");
      continue;
    }
    const req = "required" in it && it.required ? " (required)" : "";
    const what =
      it.kind === "choice"
        ? `one of: ${it.choices.join(" / ")}`
        : it.kind === "checkbox"
          ? `tick any of: ${it.choices.join(" / ")}${it.other ? " / Other" : ""}${it.atMost ? ` (up to ${it.atMost})` : ""}`
          : it.kind === "grid"
            ? `a grid: rows ${it.rows.join(", ")}, columns ${it.columns.join(", ")}`
            : it.kind === "text"
              ? "short answer"
              : "paragraph";
    out.push(`- **${it.title}**${req}: ${what}`);
  }
  return `${out.join("\n")}\n`;
}

// ---- What must never appear ----------------------------------------------------------

/**
 * What would tell the coach where a draft came from: configuration names, the
 * model ids inside them, providers, servers and effort levels, and the plan
 * rules' names. The bare word "effort" is not on the list: runners say "easy
 * effort", and the replies are not rewritten.
 */
export function packetLeaks(text: string, configurations: string[]): string[] {
  const terms = [
    ...configurations,
    ...configurations.map((c) => c.split("--")[1]).filter((m): m is string => Boolean(m)),
    ...PLAN_RULES,
  ];
  const found = terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
  const named = /\b(anthropic|claude|opus|sonnet|haiku|omlx|mlx|ollama|openai|gpt[\w.-]*|gemma[\w.-]*|qwen[\w.-]*|self[-_ ]hosted|xhigh|effort level|tokens?|latency)\b/gi;
  for (const m of text.matchAll(named)) found.push(m[0]);
  return [...new Set(found)];
}

// ---- Writing the form -------------------------------------------------------------------

export type CoachPacketOptions = {
  /** Output roots, each holding configuration folders; a hard-set input names its root by folder name. */
  roots: string[];
  hardSet: HardSetEntry[];
  seed: number;
  /** Where form.gs, preview.md and key.json go. */
  outDir: string;
  /** Configurations to draw from; every configuration folder in the roots when null. */
  configurations: string[] | null;
  /** The coach's athletes by athleteKey, as tests/fixtures/coach-packet-athletes.json holds them. */
  athletes: Record<string, CoachAthlete>;
  /** Rebuilds a root's inputs from a configuration folder's config.json, in input-id order; null when they cannot be. */
  loadInputs: (configDir: string) => ReviewInput[] | null;
};

/** What key.json records; the coach never sees it. */
export type CoachPacketKey = {
  seed: number;
  generatedAt: string;
  /** The roots by folder name, as the inputs name them. */
  roots: string[];
  configurations: string[];
  /** How many cases each configuration appears in. */
  appearances: Record<string, number>;
  cases: Array<{
    case: number;
    input: string;
    scenario: string;
    safetyCritical: boolean;
    drafts: Array<{ draft: (typeof DRAFTS)[number]; configuration: string; input: string; repeat: 1; status: ReplySide["status"] }>;
  }>;
  notes: string[];
};

/** Configuration folders (those with a config.json) in a root. */
function configurationsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "config.json")))
    .map((e) => e.name)
    .sort();
}

/** Writes form.gs, preview.md and key.json; returns what it did, for the console. */
export function writeCoachPacket(options: CoachPacketOptions): string[] {
  const byName = new Map(options.roots.map((r) => [path.basename(r), r]));
  if (byName.size !== options.roots.length) throw new Error("Two roots share a folder name; inputs name their root by folder name, so each needs its own.");
  const notes: string[] = [];
  const present = new Map([...byName].map(([name, dir]) => [name, configurationsIn(dir)]));
  const configurations = options.configurations ?? [...new Set([...present.values()].flat())].sort();
  for (const c of configurations) {
    const missing = [...present].filter(([, cs]) => !cs.includes(c)).map(([name]) => name);
    if (missing.length) notes.push(`${c} has no folder in ${missing.join(", ")}; it is not drawn for those cases.`);
  }

  // Each root's inputs, rebuilt once from the first configuration folder that can.
  const inputsOf = new Map<string, ReviewInput[]>();
  const rootInputs = (name: string): ReviewInput[] => {
    if (!inputsOf.has(name)) {
      const dir = byName.get(name);
      if (!dir) throw new Error(`The hard set names root ${name}, but no root is named that (roots: ${[...byName.keys()].join(", ")}).`);
      const inputs = (present.get(name) ?? []).map((c) => options.loadInputs(path.join(dir, c))).find((i) => i !== null);
      if (!inputs) throw new Error(`${name}: the inputs could not be rebuilt from any configuration's config.json, so the weeks cannot be summarised.`);
      inputsOf.set(name, inputs);
    }
    return inputsOf.get(name)!;
  };

  const cases = caseOrder(options.hardSet).map((entry) => {
    const [root, id] = entry.input.split("/") as [string, string];
    const input = rootInputs(root).find((i) => Number(i.id) === Number(id));
    if (!input) throw new Error(`${entry.input}: no such input in ${root}.`);
    if (input.operation !== "weekly_reply") throw new Error(`${entry.input}: the form scores Sunday reads; this input is a ${input.operation}.`);
    const available = configurations.filter((c) => (present.get(root) ?? []).includes(c));
    const athlete = options.athletes[athleteKey(root, input.source)];
    if (!athlete?.name || !athlete.introduction) throw new Error(`${entry.input}: no athlete introduced for ${athleteKey(root, input.source)}.`);
    return { entry, root, input, available, athlete };
  });
  const drawn = drawReplies(cases.map((c) => ({ input: c.entry.input, available: c.available })), options.seed);

  const firstPart = cases.filter((c) => isSafetyCritical(c.entry)).length;
  const key: CoachPacketKey = {
    seed: options.seed,
    generatedAt: new Date().toISOString(),
    roots: [...byName.keys()],
    configurations,
    appearances: Object.fromEntries(configurations.map((c) => [c, 0])),
    cases: [],
    notes,
  };
  const items: FormItem[] = [{ kind: "text", title: "Who is filling this in?", required: true }];
  cases.forEach((c, i) => {
    const n = i + 1;
    if (i === firstPart) {
      items.push({
        kind: "page",
        title: IF_YOU_HAVE_TIME,
        help: "The weeks that matter most are done: thank you. The rest are optional. Answer as many as you like; to stop, click Next through the remaining pages without answering, and submit at the end.",
      });
    }
    const sides = drawn[i]!.map((configuration) => {
      const side = readSide(path.join(byName.get(c.root)!, configuration), c.input.id);
      if (side.status !== "missing" && side.saved.source && side.saved.source !== c.input.source) {
        notes.push(`${c.entry.input}: ${configuration} replied to ${side.saved.source}, but the rebuilt input is ${c.input.source}.`);
      }
      return { configuration, side };
    });
    // The tightest cuts only when a page would run over the cap.
    const page = (cuts: Cuts) =>
      [athleteCard(c.input, c.athlete).join("\n"), ...sides.map((s, j) => draftLines(s.side, DRAFTS[j]!, c.athlete.name, cuts).join("\n"))].join("\n\n");
    const help = CUTS.map(page).find((h) => h.length <= DESCRIPTION_CAP);
    if (!help) throw new Error(`${c.entry.input}: the page runs over ${DESCRIPTION_CAP} characters even at the tightest cuts.`);
    items.push({ kind: "page", title: `Case ${n} of ${cases.length} · ${c.athlete.name} · ${goalWords(c.input, c.athlete)}`, help });
    items.push(...caseQuestions(c.athlete.name, i < firstPart));
    sides.forEach((s) => (key.appearances[s.configuration] = (key.appearances[s.configuration] ?? 0) + 1));
    key.cases.push({
      case: n,
      input: c.entry.input,
      scenario: c.entry.scenario,
      safetyCritical: i < firstPart,
      drafts: sides.map((s, j) => ({ draft: DRAFTS[j]!, configuration: s.configuration, input: c.entry.input, repeat: 1, status: s.side.status })),
    });
  });
  items.push(...CLOSING);
  const payload: FormPayload = { title: "Coaching review", description: brief(cases.length, firstPart), items };

  mkdirSync(options.outDir, { recursive: true });
  const script = formScript(payload);
  const preview = formPreview(payload);
  writeFileSync(path.join(options.outDir, "form.gs"), script);
  writeFileSync(path.join(options.outDir, "preview.md"), preview);
  writeFileSync(path.join(options.outDir, "key.json"), `${JSON.stringify(key, null, 2)}\n`);

  const pages = items.filter((it): it is Extract<FormItem, { kind: "page" }> => it.kind === "page");
  const log = [`coach's form: ${cases.length} cases (${firstPart} first, the rest after "${IF_YOU_HAVE_TIME}") in ${options.outDir}`];
  log.push(`  appearances: ${Object.entries(key.appearances).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  log.push(`  longest page description: ${Math.max(...pages.map((p) => p.help.length))} characters (cap ${DESCRIPTION_CAP})`);
  const failed = key.cases.flatMap((c) => c.drafts.filter((d) => d.status !== "ok").map((d) => `case ${c.case} draft ${d.draft} (${d.status})`));
  if (failed.length) log.push(`  shown as no reply arrived: ${failed.join(", ")}`);
  const leaks = packetLeaks(`${script}\n${preview}`, configurations);
  if (leaks.length) log.push(`  CHECK BEFORE SENDING: the form mentions ${leaks.map((l) => JSON.stringify(l)).join(", ")}`);
  for (const note of notes) log.push(`  note: ${note}`);
  return log;
}
