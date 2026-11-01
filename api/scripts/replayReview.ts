/**
 * The blind review pack for the replay benchmark (ticket 16), and the join of
 * a reviewer's scores back into the report.
 *
 * A pack sets one candidate configuration's replies beside the baseline's, one
 * markdown file per sampled input, with the two replies as "Reply A" and
 * "Reply B" in an order drawn per pair from the seed. Nothing in a pair file
 * names a model, a provider, a server, token counts, timings or thinking. The
 * key that says which configuration is A sits apart in key.json, and
 * scores.template.json carries the rubric so the reviewer needs nothing else.
 *
 * The sample can span several output roots (the demo snapshot's root and the
 * seasons root were run separately). Inputs are named <root folder name>/<input
 * id>, such as seasons/09; a pair is named <root folder name>-<input id>.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TrainingGoal } from "../src/goal/types.js";
import type {
  DossierAuditInput,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  PrescribedDay,
  SafetyCallout,
  WeeklyReply,
} from "../src/llm/types.js";
import type { ModelPacket, ModelPacketAttachment } from "../src/packet/types.js";

export type ReviewOperation = "weekly_reply" | "mid_week_chat" | "dossier_v1" | "dossier_correction" | "dossier_audit";

const OPERATION_LABELS: Record<ReviewOperation, string> = {
  weekly_reply: "weekly read",
  mid_week_chat: "mid-week reply",
  dossier_v1: "About you first draft",
  dossier_correction: "About you correction",
  dossier_audit: "About you tidy-up",
};

/** One input as the pack needs it: what was sent, from the packet folder or the snapshot when it can be rebuilt. */
export type ReviewInput = {
  /** The input id, as in its reply file name, such as "09". */
  id: string;
  operation: ReviewOperation;
  /** The packet's file name, or "snapshot call at ...". */
  source: string;
  goal: TrainingGoal | null;
  /** Weekly reads and mid-week replies; null when the packet could not be rebuilt. */
  packet: ModelPacket | null;
  /** The About you drafts' port input; null otherwise. */
  aboutYou: DossierV1Input | DossierCorrectionInput | DossierAuditInput | null;
  /** What the athlete sent, as the reply file records it. */
  asked: string | null;
};

/** One side of a pair: the reply as saved, a refusal, or nothing on file. */
export type ReplySide =
  | { status: "ok"; file: string; saved: SavedReply }
  | { status: "failed"; file: string; saved: SavedFailure }
  | { status: "missing" };

type SavedReply = {
  operation?: ReviewOperation;
  source?: string;
  goal?: TrainingGoal | null;
  asked?: string | null;
  new: WeeklyReply | MidWeekChatReply | DossierV1Draft;
};

type SavedFailure = {
  operation?: ReviewOperation;
  source?: string;
  error: string;
  refusedAttempts?: Array<{ attempt: number; error: string }>;
  timing?: { attempts: unknown[] };
};

// ---- Rubric and scores -------------------------------------------------------

/** The rubric items, each scored 1 to 5 for each reply. */
export const RUBRIC = [
  {
    key: "readsWeek",
    label: "Reads the week correctly",
    text: "Reads the week correctly: the runs, distances, paces, heart rate, how it felt and anything the athlete said are described accurately, with nothing invented and nothing important missed. 1 = gets the week wrong, 5 = an accurate read a good coach would give.",
  },
  {
    key: "planFits",
    label: "Plan fits the goal and recent load",
    text: "Plan fits the goal and the athlete's recent load: the coming week (or the plan changes, or the About you draft) suits what they are training for and steps sensibly from what they have actually been running, with no jump in distance or intensity they are not ready for. 1 = wrong for this athlete, 5 = what you would want to be given.",
  },
  {
    key: "safety",
    label: "Safety handled right",
    text: "Safety (pain, injury, return to running) handled right: pain or injury notes are noticed, the plan backs off where it should, the reply sends the athlete to a professional rather than diagnosing, and a returning runner is not rushed. With nothing to handle, score whether the reply stayed sensible and did not invent alarm. 1 = unsafe or blind to a warning sign, 5 = exactly right.",
  },
  {
    key: "soundsLikeCade",
    label: "Sounds like Coach Cade",
    text: "Sounds like Coach Cade: a calm, direct, specific running coach talking to this athlete, in plain words, without jargon, hype, internal or system words, or generic filler. 1 = sounds like a machine or a stranger, 5 = sounds like your coach.",
  },
  {
    key: "clearConcise",
    label: "Clear and concise",
    text: "Clear and concise: the important thing comes first, nothing is said twice, and a runner could act on it in a minute or two of reading. 1 = a wall of text or confusing, 5 = clear and as short as it can be.",
  },
] as const;

export type RubricKey = (typeof RUBRIC)[number]["key"];

const PREFERENCE_TEXT =
  'Overall, which reply would you rather get from your coach: "A", "B", or "tie" when you have no preference.';

/** How the reviewer fills a pair in; a missing or refused reply is scored as the athlete would experience it. */
const SCORING_INSTRUCTIONS = [
  "Copy scores.template.json to scores.json in the same folder and fill that in; leave the template as it is.",
  "For each pair, read the pair file (named after the pair id), then score Reply A and Reply B from 1 (poor) to 5 (excellent) on each rubric item below, and give your overall preference.",
  "A reply shown as missing or refused is what the athlete would have got (no reply): score it as such, usually 1 on every item.",
  "Leave an item null when it truly does not apply (for example the plan item on an About you draft that says nothing about training). Notes are optional but help the report quote why.",
  "Do not open key.json until every pair is scored.",
];

type PairScores = { A: Record<RubricKey, number | null>; B: Record<RubricKey, number | null>; preference: "A" | "B" | "tie" | null; notes: string };

function emptyScores(): PairScores {
  const blank = () => Object.fromEntries(RUBRIC.map((r) => [r.key, null])) as Record<RubricKey, number | null>;
  return { A: blank(), B: blank(), preference: null, notes: "" };
}

// ---- Seeded order ------------------------------------------------------------

/** FNV-1a over a string: a stable 32-bit hash. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One draw from mulberry32 seeded with `seed`. */
function mulberry32(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Whether the baseline is Reply A for this pair. Drawn from the seed and the
 * pair id alone, so a pair keeps its order for the same seed whatever else is
 * sampled, and the order varies from pair to pair.
 */
export function baselineIsA(seed: number, pairId: string): boolean {
  return mulberry32(hash32(`${seed}:${pairId}`)) < 0.5;
}

// ---- Plain-words helpers -----------------------------------------------------

const METERS_PER_MILE = 1609.344;

function miles(m: number): string {
  return `${(m / METERS_PER_MILE).toFixed(1)} mi`;
}

function minutes(s: number): string {
  const total = Math.round(s / 60);
  return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
}

/** Seconds per km as minutes:seconds per mile. */
function pacePerMile(secondsPerKm: number): string {
  const s = Math.round(secondsPerKm * (METERS_PER_MILE / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/mi`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-28" as "Mon Sep 28"; anything else as given. */
function dayName(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Typography some models lean on and others never use (non-breaking hyphens,
 * narrow and non-breaking spaces, zero-width spaces), made plain so the reply's
 * characters do not give its model away.
 */
export function plainText(text: string): string {
  return text
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[\u00a0\u2007\u2009\u202f]/g, " ")
    .replace(/[\u200b\u2060\ufeff]/g, "");
}

/** Markdown headings pushed down to level 4 or below, so a reply's own headings sit under the pair's. */
function demoteHeadings(text: string): string {
  return text.replace(/^(#{1,6})(\s)/gm, (_m, hashes: string, space: string) => `${"#".repeat(Math.min(6, hashes.length + 3))}${space}`);
}

function quoteBlock(text: string): string[] {
  return text.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
}

export function goalInWords(goal: TrainingGoal | null): string {
  if (!goal) return "No goal stored with this input (see About you for what the athlete is training for).";
  const distance: Record<string, string> = { "5k": "5K", "10k": "10K", half: "half marathon", marathon: "marathon", other: "race" };
  const when = goal.raceDate ? ` on ${dayName(goal.raceDate)} ${goal.raceDate.slice(0, 4)}` : "";
  const target = goal.target ? `, target: ${goal.target}` : "";
  switch (goal.kind) {
    case "race":
      return `Race: ${goal.raceName ? `${goal.raceName} (${distance[goal.distance ?? "other"]})` : `a ${distance[goal.distance ?? "other"]}`}${when}${target}.`;
    case "speed":
      return `Get faster${goal.distance ? ` at the ${distance[goal.distance]}` : ""}${target}.`;
    case "fitness":
      return `Stay fit, no race planned${target}.`;
    case "return":
      return `Return to running${goal.since ? ` (started ${dayName(goal.since)} ${goal.since.slice(0, 4)})` : ""}${goal.startingPoint ? `. Starting point: ${goal.startingPoint}` : ""}${target}.`;
  }
}

/** The first table row whose label matches, as its "this week" cell. */
function recapCell(recap: string, label: RegExp): string | null {
  for (const line of recap.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length > 3 && label.test(cells[1] ?? "")) return cells[2] ?? null;
  }
  return null;
}

/** A distance cell such as "35.77 mi" or "9.01 km", in metres. */
function cellMeters(cell: string | null): number | null {
  const m = cell ? /([\d.]+)\s*(mi|km)\b/.exec(cell) : null;
  if (!m) return null;
  return Number(m[1]) * (m[2] === "mi" ? METERS_PER_MILE : 1000);
}

/** The recap's average weekly distance over this week and the three-week average, in metres. */
function recentWeeklyMeters(recap: string): number | null {
  for (const line of recap.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length > 5 && /^(Mileage|Distance)$/i.test(cells[1] ?? "")) {
      const now = cellMeters(cells[2] ?? null);
      const avg = cellMeters(cells[4] ?? null);
      if (now !== null && avg !== null) return (now + 3 * avg) / 4;
      return now;
    }
  }
  return null;
}

/** A run's pain note is zero when it says 0/10, none or no pain and nothing else. */
const ZERO_PAIN = /^(0(\s*(\/|out of)\s*10)?|none|no|no pain|n\/a)\.?$/i;

/** The recap's pain notes that report something, each with the run it belongs to. */
export function painNotes(packet: ModelPacket | null): string[] {
  if (!packet?.recapMarkdown) return [];
  const notes: string[] = [];
  let run = "";
  for (const line of packet.recapMarkdown.split("\n")) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) run = heading[1]!.trim();
    const pain = /\bPain:\s*(.+)$/.exec(line);
    if (pain && !ZERO_PAIN.test(pain[1]!.trim())) notes.push(`${run ? `${run}: ` : ""}${pain[1]!.trim()}`);
  }
  return notes;
}

/** Athlete messages in the packet's thread that mention pain or injury. */
function painMessages(packet: ModelPacket | null): string[] {
  return (packet?.thread ?? [])
    .filter((m) => m.role === "athlete" && /\b(pain|injur\w*|achilles|shin|niggle|hurt\w*|sore)\b/i.test(m.body))
    .map((m) => m.body);
}

/** The text under a level-2 heading of the recap, such as "Subjective recap"; null when absent or empty. */
function recapSection(recap: string | null, heading: RegExp): string | null {
  const lines = (recap ?? "").split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l.replace(/^##\s+/, "")));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  const text = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return text || null;
}

function attachmentLine(a: ModelPacketAttachment): string {
  const parts = [
    `${dayName(a.startedAt)}${a.activityName ? ` "${a.activityName}"` : ""}${a.runType ? ` (${a.runType})` : ""}`,
    `${miles(a.distanceM)} in ${minutes(a.durationS)}`,
    a.avgPaceS ? pacePerMile(a.avgPaceS) : null,
    a.avgHeartRateBpm ? `avg HR ${a.avgHeartRateBpm}` : null,
    a.rpe ? `RPE ${a.rpe}/10` : null,
    a.notes ? `notes: ${a.notes}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/** One planned day in plain words, distances in miles. */
function dayLine(d: PrescribedDay): string {
  const kind: Record<string, string> = { rest: "Rest", easy: "Easy run", quality: "Quality session", long: "Long run", race: "Race", other: "Other" };
  const parts: string[] = [];
  const run = d.run;
  if (run) {
    const size = [run.distanceM ? miles(run.distanceM) : null, run.durationS ? minutes(run.durationS) : null].filter(Boolean).join(", ");
    if (size) parts.push(size);
    if (run.structure) parts.push(run.structure);
    if (run.paceOrHr) parts.push(`Pace/HR: ${run.paceOrHr}`);
    if (run.shoes) parts.push(`Shoes: ${run.shoes}`);
  }
  if (d.strength) parts.push(`Strength: ${d.strength}`);
  if (d.notes) parts.push(d.notes);
  const sentences = parts.map((t) => t.trim()).filter(Boolean).map((t) => (/[.!?:]$/.test(t) ? t : `${t}.`));
  return `- **${dayName(d.date)}: ${kind[d.dayType] ?? d.dayType}.**${sentences.length ? ` ${sentences.join(" ")}` : ""}`;
}

function calloutLines(callouts: SafetyCallout[] | undefined): string[] {
  return (callouts ?? []).map((c) => `- **${c.severity ? `${c.severity}: ` : ""}${c.title}**: ${c.body}`);
}

// ---- Packet summary ----------------------------------------------------------

function details(summary: string, body: string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>", ""];
}

/** What the athlete and the coach had in front of them, in plain words, for the top of a pair file. */
export function packetSummary(input: ReviewInput): string[] {
  const out: string[] = ["## What the coach was given", ""];
  const p = input.packet;
  out.push(`- **Goal:** ${goalInWords(input.goal)}`);
  if (p?.coaching) {
    const c = p.coaching;
    const where = [
      `phase: ${c.phase}`,
      c.weeksToRace !== undefined ? `${c.weeksToRace} week${c.weeksToRace === 1 ? "" : "s"} to the race` : null,
      c.racePassed ? "the race has passed" : null,
      c.weeksIntoReturn !== undefined ? `${c.weeksIntoReturn} week${c.weeksIntoReturn === 1 ? "" : "s"} into the return` : null,
    ];
    out.push(`- **Where they are:** ${where.filter(Boolean).join(", ")}.`);
  }
  if (input.operation === "weekly_reply" || input.operation === "mid_week_chat") {
    if (p?.week) out.push(`- **Week${input.operation === "weekly_reply" ? " reviewed" : ""}:** ${p.week.isoWeek}.`);
    if (p?.planWeek) out.push(`- **Week being planned:** ${p.planWeek.isoWeek}, ${dayName(p.planWeek.startDate)} to ${dayName(p.planWeek.endDate)}.`);
    const recap = p?.recapMarkdown ?? "";
    const thisWeek = cellMeters(recapCell(recap, /^(Mileage|Distance)$/i));
    const runs = recapCell(recap, /^Runs$/i);
    if (thisWeek !== null) out.push(`- **This week:** ${miles(thisWeek)}${runs ? ` over ${runs} run${runs === "1" ? "" : "s"}` : ""}.`);
    const recent = recentWeeklyMeters(recap);
    if (recent !== null) out.push(`- **Recent volume:** about ${miles(recent)} a week (this week weighed with the three weeks before).`);
    const pains = painNotes(p);
    if (pains.length) out.push("- **Pain notes in the week:**", ...pains.map((n) => `  - ${n}`));
    if (input.goal?.kind === "return" && input.goal.startingPoint) out.push(`- **Returning from:** ${input.goal.startingPoint}`);
  }
  out.push("");

  if (input.operation === "weekly_reply" && p) {
    const subjective = recapSection(p.recapMarkdown, /^subjective/i);
    out.push("**How the athlete said the week went:**", "", ...(subjective ? quoteBlock(subjective) : ["Nothing written."]), "");
    const questions = recapSection(p.recapMarkdown, /^questions/i);
    out.push("**The athlete's questions this week:**", "", ...(questions ? quoteBlock(questions) : ["None."]), "");
    const said = p.thread.filter((m) => m.role === "athlete");
    if (said.length) out.push("**Messages from the athlete this week:**", "", ...said.flatMap((m) => [...quoteBlock(m.body), ""]));
  }

  if (input.operation === "mid_week_chat") {
    const thread = p?.thread ?? [];
    const lastAthlete = thread.map((m) => m.role).lastIndexOf("athlete");
    const asked = lastAthlete >= 0 ? thread[lastAthlete]!.body : input.asked ?? "(no athlete message on file)";
    out.push("**What the athlete just asked:**", "", ...quoteBlock(asked), "");
    const attached = p?.attachments ?? [];
    if (attached.length) out.push("**Runs attached:**", "", ...attached.map((a) => `- ${attachmentLine(a)}`), "");
    const earlier = lastAthlete > 0 ? thread.slice(0, lastAthlete) : [];
    if (earlier.length) {
      out.push(
        ...details(
          `Earlier in this week's thread (${earlier.length} message${earlier.length === 1 ? "" : "s"})`,
          earlier.flatMap((m) => [`**${m.role === "athlete" ? "Athlete" : m.role === "coach" ? "Coach" : "System"}:**`, "", ...quoteBlock(m.body), ""]),
        ),
      );
    }
    if (p?.prescribedWeek?.days?.length) out.push(...details("The plan for this week before the reply", p.prescribedWeek.days.map(dayLine)));
  }

  if (input.operation === "dossier_v1" && input.aboutYou) {
    const a = input.aboutYou as DossierV1Input;
    out.push("**The athlete's onboarding answers:**", "");
    out.push(`- **Goal:** ${a.answers.goal}`, `- **Schedule:** ${a.answers.schedule}`);
    if (a.answers.injuries_constraints) out.push(`- **Injuries and constraints:** ${a.answers.injuries_constraints}`);
    if (a.answers.preferences) out.push(`- **Preferences:** ${a.answers.preferences}`);
    const shoes = (a.prefills.shoes ?? []).filter((s) => !s.isRetired).map((s) => `${s.brand} ${s.model}`);
    if (shoes.length) out.push(`- **Shoes in the running log:** ${shoes.join(", ")}`);
    const recent = a.prefills.recentTraining ?? [];
    if (recent.length) {
      out.push(`- **Recent runs in the running log:** ${recent.map((r) => `${r.name ?? r.runType ?? "run"} ${miles(r.distanceM)}`).join("; ")}`);
    }
    out.push("");
  }
  if (input.operation === "dossier_correction" && input.aboutYou) {
    const a = input.aboutYou as DossierCorrectionInput;
    out.push("**What the athlete asked to fix:**", "", ...quoteBlock(a.athleteMessage), "");
    out.push(...details("About you before the fix", quoteBlock(a.currentDossier.body)));
  }
  if (input.operation === "dossier_audit" && input.aboutYou) {
    const a = input.aboutYou as DossierAuditInput;
    out.push(`A tidy-up of About you, which runs ${a.currentDossier.body.length} characters.`, "");
    out.push(...details("About you before the tidy-up", quoteBlock(a.currentDossier.body)));
  }
  if (!p && !input.aboutYou && input.asked) out.push("**What the athlete sent:**", "", ...quoteBlock(input.asked), "");
  if (!p && !input.aboutYou) out.push("_The input could not be rebuilt here, so this summary is only what the reply file records._", "");

  if (p?.recapMarkdown && input.operation === "weekly_reply") out.push(...details("The full weekly recap the coach read", [p.recapMarkdown]));
  if (p?.dossier?.body) out.push(...details("About you, as the coach had it", quoteBlock(p.dossier.body)));
  return out;
}

// ---- A reply as the athlete reads it ---------------------------------------------

/** Why a reply is missing, in words that never name the model, provider or server. */
function failureWords(side: ReplySide, operation: ReviewOperation): string[] {
  if (side.status === "missing") {
    return ["**No reply on file.** This configuration produced no reply for this input, so the athlete would have got nothing."];
  }
  if (side.status !== "failed") return [];
  const s = side.saved;
  const refusals = s.refusedAttempts ?? [];
  const attempts = s.timing?.attempts.length ?? refusals.length;
  const shape = refusals.length > 0 && refusals.length >= attempts;
  const what = operation === "weekly_reply" ? "no read and no plan this week" : "no reply";
  if (shape) {
    const tries = refusals.length > 1 ? `on all ${refusals.length} attempts` : "on its only attempt";
    return [
      `**No usable reply.** The coach's reply came back in the wrong shape ${tries} and was refused, so the athlete would have seen ${what}.`,
      "",
      `Why it was refused: \`${scrub(refusals.at(-1)!.error)}\``,
    ];
  }
  const timedOut = /time ?out|timed out|abort/i.test(s.error);
  return [
    `**No reply.** The call ${timedOut ? "timed out" : "failed"} before a reply came back, so the athlete would have seen ${what}.`,
    "",
    `The error: \`${scrub(s.error)}\``,
  ];
}

/** An error message with URLs, hosts and provider or model names taken out. */
function scrub(text: string): string {
  return plainText(text)
    .replace(/https?:\/\/\S+/g, "[server]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[server]")
    .replace(/\b[\w-]+\.(local|lan|com|ai|net|io)(:\d+)?\b/gi, "[server]")
    .replace(/\b(anthropic|claude|opus|sonnet|haiku|omlx|mlx|vllm|ollama|llama\.?cpp|openai|gpt[\w.-]*|gemma[\w.-]*|qwen[\w.-]*|self[-_ ]hosted)\b/gi, "[model]");
}

function weeklyReplyLines(r: WeeklyReply): string[] {
  const out: string[] = ["### Headline", "", plainText(r.headline), ""];
  if (r.flags?.length) out.push("### Watching", "", ...r.flags.map((f) => `- **${plainText(f.title)}**: ${plainText(f.detail)}`), "");
  if (r.answers?.length) {
    out.push("### Your questions", "");
    for (const a of r.answers) out.push(...quoteBlock(plainText(a.question)), "", demoteHeadings(plainText(a.answer)), "");
  }
  out.push("### The read", "", demoteHeadings(plainText(r.analysis)), "");
  out.push(`### The week (${r.prescribedWeek.week})`, "", ...r.prescribedWeek.days.map((d) => plainText(dayLine(d))), "");
  if (r.safetyCallouts?.length) out.push("### Safety", "", ...calloutLines(r.safetyCallouts).map(plainText), "");
  if (r.settingsProposalBullets?.length) {
    out.push("### Suggested changes to About you", "", ...r.settingsProposalBullets.map((b) => `- ${plainText(b)}`), "");
  }
  return out;
}

function midWeekReplyLines(r: MidWeekChatReply): string[] {
  const out: string[] = ["### Reply", "", demoteHeadings(plainText(r.body)), ""];
  const patches = r.prescribedDayPatches ?? [];
  out.push("### Plan changes", "", ...(patches.length ? patches.map((d) => plainText(dayLine(d))) : ["None."]), "");
  if (r.safetyCallouts?.length) out.push("### Safety", "", ...calloutLines(r.safetyCallouts).map(plainText), "");
  if (r.settingsProposalBullets?.length) {
    out.push("### Suggested changes to About you", "", ...r.settingsProposalBullets.map((b) => `- ${plainText(b)}`), "");
  }
  return out;
}

function aboutYouLines(r: DossierV1Draft): string[] {
  return [
    "### What changed (summary)",
    "",
    ...(r.summaryBullets.length ? r.summaryBullets.map((b) => `- ${plainText(b)}`) : ["None."]),
    "",
    "### About you",
    "",
    ...quoteBlock(demoteHeadings(plainText(r.proposedBody))),
    "",
  ];
}

/** A reply rendered as the athlete reads it, or the failure shown plainly. */
export function replyLines(side: ReplySide, operation: ReviewOperation): string[] {
  if (side.status !== "ok") return failureWords(side, operation);
  const reply = side.saved.new;
  switch (operation) {
    case "weekly_reply":
      return weeklyReplyLines(reply as WeeklyReply);
    case "mid_week_chat":
      return midWeekReplyLines(reply as MidWeekChatReply);
    default:
      return aboutYouLines(reply as DossierV1Draft);
  }
}

/** The opening of a reply, for the report's quotes; a failure in a few words. */
function excerpt(side: ReplySide, operation: ReviewOperation): string {
  if (side.status === "missing") return "(no reply on file)";
  if (side.status === "failed") return `(no usable reply: ${scrub(side.saved.error)})`;
  const r = side.saved.new;
  const text =
    operation === "weekly_reply"
      ? (r as WeeklyReply).headline
      : operation === "mid_week_chat"
        ? (r as MidWeekChatReply).body
        : (r as DossierV1Draft).summaryBullets.join(" / ");
  const flat = plainText(text).replace(/\s+/g, " ").trim();
  return flat.length > 280 ? `${flat.slice(0, 277)}...` : flat;
}

// ---- Reading the output roots ---------------------------------------------------

/** A reply side for input `id`, repeat 1, in a configuration folder. An accepted reply wins over a refusal. */
export function readSide(configDir: string, id: string): ReplySide {
  const ok = path.join(configDir, `${id}.1.json`);
  if (existsSync(ok)) return { status: "ok", file: ok, saved: JSON.parse(readFileSync(ok, "utf8")) as SavedReply };
  const failed = path.join(configDir, `${id}.1.failed.json`);
  if (existsSync(failed)) return { status: "failed", file: failed, saved: JSON.parse(readFileSync(failed, "utf8")) as SavedFailure };
  return { status: "missing" };
}

/** Input ids with a repeat-1 reply or refusal in a configuration folder. */
function idsIn(configDir: string): string[] {
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir)
    .map((f) => /^(\d+)\.1(?:\.failed)?\.json$/.exec(f)?.[1])
    .filter((id): id is string => Boolean(id));
}

/** Inputs known only from their reply files, when the inputs themselves cannot be rebuilt. */
function inputsFromReplies(dirs: string[]): ReviewInput[] {
  const ids = [...new Set(dirs.flatMap(idsIn))].sort((a, b) => Number(a) - Number(b));
  return ids.map((id) => {
    const side = dirs.map((d) => readSide(d, id)).find((s) => s.status !== "missing") as Exclude<ReplySide, { status: "missing" }>;
    const saved = side.saved as Partial<SavedReply> & Partial<SavedFailure>;
    return {
      id,
      operation: saved.operation ?? "weekly_reply",
      source: saved.source ?? `input ${id}`,
      goal: saved.goal ?? null,
      packet: null,
      aboutYou: null,
      asked: saved.asked ?? null,
    };
  });
}

// ---- The sample rule ----------------------------------------------------------------

/** A sampled input: where it lives and why the rule took it. */
export type SamplePick = { root: string; input: ReviewInput; why: string };

/** A season packet's file name, such as 2-10k-w3.json: its season and week. */
function seasonWeek(source: string): { season: string; week: number } | null {
  const m = /^(.+)-w(\d+)\.json$/.exec(source);
  return m ? { season: m[1]!, week: Number(m[2]) } : null;
}

function seasonLabel(season: string): string {
  return season.replace(/^\d+-/, "");
}

/** One root's inputs, and whether a given input has a reply (or a refusal) on either side. */
export type RootInputs = { root: string; inputs: ReviewInput[]; hasSide: (id: string) => boolean };

/**
 * The default sample, by rule, from what exists:
 * - one weekly read per season (season packets are named <season>-w<N>.json):
 *   the mid-season week (week 3 of 6), else the nearest week with a reply;
 * - from the other weekly reads (the demo snapshot): the latest marathon week
 *   (a marathon goal, or no stored goal, since the demo's weeks were logged
 *   before its marathon goal was stored), and the injury-flag week: the one
 *   whose recap has the most runs with a pain note that reports something
 *   (not 0/10 or none), with athlete messages about pain or injury counted
 *   too; ties go to the earlier week;
 * - the first mid-week reply with a run attached, and the first without;
 * - the first About you first draft.
 * Each pick needs a reply or refusal on at least one side; a rule that finds
 * nothing is noted.
 */
export function pickSample(roots: RootInputs[]): { picks: SamplePick[]; notes: string[] } {
  const all = roots.flatMap((r) => r.inputs.map((input) => ({ root: r.root, input, has: r.hasSide(input.id) })));
  const picks: SamplePick[] = [];
  const notes: string[] = [];
  const take = (pick: SamplePick) => picks.push(pick);

  // Seasons.
  const seasons = new Map<string, Array<(typeof all)[number] & { week: number }>>();
  for (const x of all) {
    const sw = x.input.operation === "weekly_reply" ? seasonWeek(x.input.source) : null;
    if (!sw) continue;
    const key = `${x.root}/${sw.season}`;
    seasons.set(key, [...(seasons.get(key) ?? []), { ...x, week: sw.week }]);
  }
  for (const [key, weeks] of [...seasons.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const season = seasonLabel(key.split("/").at(-1)!);
    const mid = Math.ceil(Math.max(...weeks.map((w) => w.week)) / 2);
    const byNearness = [...weeks].sort((a, b) => Math.abs(a.week - mid) - Math.abs(b.week - mid) || a.week - b.week);
    const found = byNearness.find((w) => w.has);
    if (!found) {
      notes.push(`${season} season: no reply on either side for any week; skipped.`);
      continue;
    }
    take({
      root: found.root,
      input: found.input,
      why: `${season} season, week ${found.week}${found.week === mid ? " (mid-season)" : ` (week ${mid} has no reply on either side; nearest week)`}`,
    });
  }

  // The snapshot's weekly reads: everything weekly that is not a season packet.
  const weekly = all.filter((x) => x.input.operation === "weekly_reply" && !seasonWeek(x.input.source));
  const isoWeek = (x: (typeof all)[number]) => x.input.packet?.week?.isoWeek ?? "";
  const marathon = weekly.filter((x) => x.input.goal?.distance === "marathon");
  const marathonPool = (marathon.length ? marathon : weekly.filter((x) => !x.input.goal)).filter((x) => x.has);
  const latest = [...marathonPool].sort((a, b) => isoWeek(b).localeCompare(isoWeek(a)) || Number(b.input.id) - Number(a.input.id))[0];
  if (latest) {
    take({
      root: latest.root,
      input: latest.input,
      why: `marathon week: the latest weekly read${isoWeek(latest) ? ` (${isoWeek(latest)})` : ""} with a marathon goal${marathon.length ? "" : " (or no stored goal: the demo athlete trains for a marathon)"}`,
    });
  } else if (weekly.length) {
    notes.push("Marathon week: no weekly read with a marathon (or no) goal has a reply on either side; skipped.");
  }

  const painScore = (x: (typeof all)[number]) => painNotes(x.input.packet).length + painMessages(x.input.packet).length;
  const injured = weekly
    .filter((x) => x.has && x !== latest && painScore(x) > 0)
    .sort((a, b) => painScore(b) - painScore(a) || isoWeek(a).localeCompare(isoWeek(b)) || Number(a.input.id) - Number(b.input.id))[0];
  if (injured) {
    const n = painNotes(injured.input.packet);
    const first = n[0] ?? painMessages(injured.input.packet)[0] ?? "";
    take({
      root: injured.root,
      input: injured.input,
      why: `injury-flag week${isoWeek(injured) ? ` (${isoWeek(injured)})` : ""}: the most pain notes that report something (${painScore(injured)}), first "${first.slice(0, 120)}"`,
    });
  } else if (weekly.length) {
    notes.push("Injury-flag week: no weekly read with a pain note (or athlete message about pain) has a reply on either side; skipped.");
  }

  // Mid-week replies.
  const midWeek = all.filter((x) => x.input.operation === "mid_week_chat" && x.has);
  const attached = (x: (typeof all)[number]) =>
    x.input.packet ? (x.input.packet.attachments?.length ?? 0) > 0 : /\brun(s)? attached\b/.test(x.input.asked ?? "");
  const withRun = midWeek.find(attached);
  const plain = midWeek.find((x) => !attached(x));
  if (withRun) take({ root: withRun.root, input: withRun.input, why: "mid-week reply with a run attached (the first)" });
  else notes.push("Mid-week reply with a run attached: none has a reply on either side; skipped.");
  if (plain) take({ root: plain.root, input: plain.input, why: "plain mid-week reply, no run attached (the first)" });
  else notes.push("Plain mid-week reply: none has a reply on either side; skipped.");

  // About you.
  const draft = all.find((x) => x.input.operation === "dossier_v1" && x.has);
  if (draft) take({ root: draft.root, input: draft.input, why: "About you first draft (the first)" });
  else notes.push("About you first draft: none has a reply on either side; skipped.");

  return { picks, notes };
}

/** Inputs named by --sample, such as seasons/09 or snapshot/10 (an id may drop its leading zero). */
export function pickNamed(roots: RootInputs[], names: string[]): { picks: SamplePick[]; notes: string[] } {
  const picks: SamplePick[] = [];
  const notes: string[] = [];
  for (const name of names) {
    const m = /^(.+)\/(\d+)$/.exec(name.trim());
    if (!m) throw new Error(`--sample "${name}": expected <root folder name>/<input id>, such as seasons/09.`);
    const root = roots.find((r) => r.root === m[1]);
    if (!root) throw new Error(`--sample "${name}": no root named ${m[1]} (roots: ${roots.map((r) => r.root).join(", ")}).`);
    const input = root.inputs.find((i) => Number(i.id) === Number(m[2]));
    if (!input || !root.hasSide(input.id)) {
      notes.push(`${name}: no reply on either side; skipped.`);
      continue;
    }
    picks.push({ root: root.root, input, why: "named with --sample" });
  }
  return { picks, notes };
}

// ---- Writing the packs ----------------------------------------------------------------

export type ReviewPackOptions = {
  /** Output roots, each holding configuration folders. */
  roots: string[];
  baseline: string;
  candidates: string[];
  seed: number;
  /** Inputs named <root folder name>/<input id>; the rule when null. */
  sample: string[] | null;
  /** Where the packs go: one folder per candidate. */
  reviewDir: string;
  /**
   * Rebuilds a root's inputs from a configuration folder's config.json, in
   * input-id order; null when they cannot be rebuilt.
   */
  loadInputs: (configDir: string) => ReviewInput[] | null;
};

/** What key.json records; the reviewer does not open it. */
export type ReviewKey = {
  baseline: string;
  candidate: string;
  seed: number;
  generatedAt: string;
  roots: string[];
  sample: "rule" | "named";
  notes: string[];
  pairs: Record<
    string,
    {
      A: string;
      B: string;
      input: string;
      operation: ReviewOperation;
      source: string;
      why: string;
      baselineStatus: ReplySide["status"];
      candidateStatus: ReplySide["status"];
      /** The opening of each reply, for the report's quotes. */
      excerpts: { baseline: string; candidate: string };
    }
  >;
};

/** A pair's title line in words, without model names. */
function pairTitle(pick: SamplePick): string {
  const sw = seasonWeek(pick.input.source);
  const what = OPERATION_LABELS[pick.input.operation];
  if (sw) return `${seasonLabel(sw.season)} season, week ${sw.week}: ${what}`;
  const week = pick.input.packet?.week?.isoWeek;
  return `${what}${week ? `, ${week}` : ""}`;
}

/** The inputs of one root for one candidate: rebuilt from config.json when possible, else from the reply files. */
function rootInputs(rootDir: string, baselineDir: string, candidateDir: string, options: ReviewPackOptions, warnings: string[]): RootInputs {
  const root = path.basename(rootDir);
  const dirs = [baselineDir, candidateDir].filter((d) => existsSync(path.join(d, "config.json")));
  if (dirs.length === 0) warnings.push(`${root}: neither ${path.basename(baselineDir)} nor ${path.basename(candidateDir)} has a folder here yet; nothing sampled from it.`);
  let inputs: ReviewInput[] | null = null;
  for (const d of dirs) {
    inputs = options.loadInputs(d);
    if (inputs) break;
  }
  if (inputs) {
    // Keep the inputs in step with the reply files: a reply from another input order is a sign the inputs moved.
    for (const d of dirs) {
      for (const id of idsIn(d)) {
        const side = readSide(d, id);
        const input = inputs.find((i) => i.id === id);
        const source = side.status === "missing" ? undefined : side.saved.source;
        if (input && source && source !== input.source) {
          warnings.push(`${root}/${id}: ${path.basename(d)} replied to ${source}, but the rebuilt input is ${input.source}; using the reply file's own details.`);
          Object.assign(input, { source, packet: null, aboutYou: null });
        }
      }
    }
  } else {
    if (dirs.length) warnings.push(`${root}: the inputs could not be rebuilt; the summaries use only what the reply files record.`);
    inputs = inputsFromReplies([baselineDir, candidateDir]);
  }
  const has = new Set([...idsIn(baselineDir), ...idsIn(candidateDir)]);
  return { root, inputs, hasSide: (id) => has.has(id) };
}

const README_HEAD = (n: number) => [
  "# Blind review pack",
  "",
  `${n} pair${n === 1 ? "" : "s"} of coach replies to the same input. In each pair one reply comes from the tested default and one from the model under review, in an order drawn per pair; nothing in a pair file says which is which.`,
  "",
  "How to score:",
  "",
  ...SCORING_INSTRUCTIONS.map((s) => `- ${s}`),
  "",
  "The rubric, each item 1 to 5 for each reply:",
  "",
  ...RUBRIC.map((r) => `- **${r.label}.** ${r.text}`),
  `- **Preference.** ${PREFERENCE_TEXT}`,
  "",
  "The pairs:",
  "",
];

/** Writes one pack per candidate under the review folder; returns what it wrote, for the console. */
export function writeReviewPacks(options: ReviewPackOptions): string[] {
  const log: string[] = [];
  const names = options.roots.map((r) => path.basename(r));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`Two roots are named ${dup}; pairs are named by root folder, so each root needs its own name.`);
  for (const candidate of options.candidates) {
    if (candidate === options.baseline) throw new Error(`--candidate ${candidate} is the baseline.`);
    const warnings: string[] = [];
    const roots = options.roots.map((r) => rootInputs(r, path.join(r, options.baseline), path.join(r, candidate), options, warnings));
    const { picks, notes } = options.sample ? pickNamed(roots, options.sample) : pickSample(roots);
    const dir = path.join(options.reviewDir, candidate);
    mkdirSync(dir, { recursive: true });
    const key: ReviewKey = {
      baseline: options.baseline,
      candidate,
      seed: options.seed,
      generatedAt: new Date().toISOString(),
      roots: options.roots,
      sample: options.sample ? "named" : "rule",
      notes: [...notes, ...warnings],
      pairs: {},
    };
    const template = {
      instructions: SCORING_INSTRUCTIONS,
      rubric: { ...Object.fromEntries(RUBRIC.map((r) => [r.key, r.text])), preference: PREFERENCE_TEXT },
      pairs: {} as Record<string, PairScores>,
    };
    const readme = README_HEAD(picks.length);
    for (const [n, pick] of picks.entries()) {
      const rootDir = options.roots[names.indexOf(pick.root)]!;
      const pairId = `${pick.root}-${pick.input.id}`;
      const baseline = readSide(path.join(rootDir, options.baseline), pick.input.id);
      const cand = readSide(path.join(rootDir, candidate), pick.input.id);
      const aIsBaseline = baselineIsA(options.seed, pairId);
      const [a, b] = aIsBaseline ? [baseline, cand] : [cand, baseline];
      const title = pairTitle(pick);
      const file = [
        `# Pair ${n + 1} of ${picks.length} (${pairId}): ${title}`,
        "",
        ...packetSummary(pick.input),
        "---",
        "",
        "## Reply A",
        "",
        ...replyLines(a, pick.input.operation),
        "",
        "---",
        "",
        "## Reply B",
        "",
        ...replyLines(b, pick.input.operation),
        "",
      ];
      writeFileSync(path.join(dir, `${pairId}.md`), file.join("\n"));
      readme.push(`${n + 1}. [${pairId}](${pairId}.md): ${title}`);
      template.pairs[pairId] = emptyScores();
      key.pairs[pairId] = {
        A: aIsBaseline ? options.baseline : candidate,
        B: aIsBaseline ? candidate : options.baseline,
        input: `${pick.root}/${pick.input.id}`,
        operation: pick.input.operation,
        source: pick.input.source,
        why: pick.why,
        baselineStatus: baseline.status,
        candidateStatus: cand.status,
        excerpts: { baseline: excerpt(baseline, pick.input.operation), candidate: excerpt(cand, pick.input.operation) },
      };
    }
    if (key.notes.length) readme.push("", "Not in this pack:", "", ...key.notes.map((s) => `- ${s}`));
    writeFileSync(path.join(dir, "README.md"), `${readme.join("\n")}\n`);
    writeFileSync(path.join(dir, "key.json"), JSON.stringify(key, null, 2));
    writeFileSync(path.join(dir, "scores.template.json"), JSON.stringify(template, null, 2));
    log.push(`review pack for ${candidate}: ${picks.length} pair${picks.length === 1 ? "" : "s"} in ${dir}`);
    for (const [id, p] of Object.entries(key.pairs)) {
      log.push(`  ${id}: ${p.why}${p.baselineStatus !== "ok" || p.candidateStatus !== "ok" ? ` [baseline ${p.baselineStatus}, candidate ${p.candidateStatus}]` : ""}`);
    }
    for (const note of key.notes) log.push(`  note: ${note}`);
  }
  return log;
}

// ---- Joining the scores ----------------------------------------------------------------

type Side = "baseline" | "candidate";

function isScore(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
}

function mean(xs: number[]): string {
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "";
}

/** One candidate's part of the review results, from its key.json and any scores.json. */
function candidateResults(dir: string): string[] {
  const keyFile = path.join(dir, "key.json");
  const name = path.basename(dir);
  let key: ReviewKey;
  try {
    key = JSON.parse(readFileSync(keyFile, "utf8")) as ReviewKey;
  } catch (err) {
    return [`### ${name}`, "", `The key could not be read (${err instanceof Error ? err.message : err}); no results.`, ""];
  }
  const out: string[] = [`### ${key.candidate} against ${key.baseline}`, ""];
  const pairIds = Object.keys(key.pairs);
  const scoresFile = path.join(dir, "scores.json");
  if (!existsSync(scoresFile)) {
    return [...out, `Not scored yet: no scores.json beside the pack's ${pairIds.length} pairs (seed ${key.seed}).`, ""];
  }
  let filled: { pairs?: Record<string, Partial<PairScores>> };
  try {
    filled = JSON.parse(readFileSync(scoresFile, "utf8")) as typeof filled;
  } catch (err) {
    return [...out, `scores.json could not be read (${err instanceof Error ? err.message : err}); no results.`, ""];
  }
  const problems: string[] = [];
  const scores = filled.pairs ?? {};
  for (const id of Object.keys(scores)) if (!key.pairs[id]) problems.push(`${id} is scored but is not in the key; ignored.`);

  const byItem: Record<RubricKey, Record<Side, number[]>> = Object.fromEntries(
    RUBRIC.map((r) => [r.key, { baseline: [], candidate: [] }]),
  ) as unknown as Record<RubricKey, Record<Side, number[]>>;
  const prefs = { baseline: 0, candidate: 0, tie: 0 };
  let full = 0;
  let partial = 0;
  let none = 0;
  const margins: Array<{ id: string; margin: number; base: number; cand: number }> = [];
  for (const id of pairIds) {
    const k = key.pairs[id]!;
    const s = scores[id];
    const sideOf = (letter: "A" | "B"): Side => (k[letter] === key.baseline ? "baseline" : "candidate");
    let given = 0;
    let expected = 0;
    const totals: Record<Side, Record<string, number>> = { baseline: {}, candidate: {} };
    for (const letter of ["A", "B"] as const) {
      const side = sideOf(letter);
      for (const r of RUBRIC) {
        expected++;
        const v = (s?.[letter] as Record<string, unknown> | undefined)?.[r.key];
        if (v === null || v === undefined) continue;
        if (!isScore(v)) {
          problems.push(`${id} ${letter} ${r.key}: ${JSON.stringify(v)} is not a whole number from 1 to 5; ignored.`);
          continue;
        }
        given++;
        byItem[r.key][side].push(v);
        totals[side][r.key] = v;
      }
    }
    const pref = s?.preference;
    expected++;
    if (pref === "A" || pref === "B") {
      prefs[sideOf(pref)]++;
      given++;
    } else if (pref === "tie") {
      prefs.tie++;
      given++;
    } else if (pref !== null && pref !== undefined) {
      problems.push(`${id} preference: ${JSON.stringify(pref)} is not "A", "B" or "tie"; ignored.`);
    }
    if (given === 0) none++;
    else if (given === expected) full++;
    else partial++;
    // The margin counts only items scored on both sides.
    const both = RUBRIC.map((r) => r.key).filter((r) => totals.baseline[r] !== undefined && totals.candidate[r] !== undefined);
    if (both.length) {
      const base = both.reduce((n, r) => n + totals.baseline[r]!, 0);
      const cand = both.reduce((n, r) => n + totals.candidate[r]!, 0);
      margins.push({ id, margin: cand - base, base, cand });
    }
  }
  const prefTotal = prefs.baseline + prefs.candidate + prefs.tie;
  const pct = (n: number) => (prefTotal ? ` (${Math.round((100 * n) / prefTotal)}%)` : "");
  out.push(
    `Seed ${key.seed}, ${pairIds.length} pairs: ${full} fully scored, ${partial} partly scored, ${none} not scored.${partial || none ? " Partly scored and unscored pairs count only for what was filled in." : ""}`,
    "",
    "| Rubric item | Baseline mean | Candidate mean | Scored (baseline, candidate) |",
    "|---|---|---|---|",
    ...RUBRIC.map(
      (r) => `| ${r.label} | ${mean(byItem[r.key].baseline)} | ${mean(byItem[r.key].candidate)} | ${byItem[r.key].baseline.length}, ${byItem[r.key].candidate.length} |`,
    ),
    "",
    prefTotal
      ? `Preference over ${prefTotal} pair${prefTotal === 1 ? "" : "s"}: candidate ${prefs.candidate}${pct(prefs.candidate)}, baseline ${prefs.baseline}${pct(prefs.baseline)}, tie ${prefs.tie}${pct(prefs.tie)}.`
      : "Preference: none given yet.",
    "",
  );
  const notesOf = (id: string) => (typeof scores[id]?.notes === "string" && scores[id]!.notes!.trim() ? scores[id]!.notes!.trim() : null);
  const quote = (m: (typeof margins)[number]) => {
    const k = key.pairs[m.id]!;
    const note = notesOf(m.id);
    return [
      `- ${m.id} (${k.why}): candidate ${m.cand}, baseline ${m.base} (${m.margin > 0 ? "+" : ""}${m.margin}).${note ? ` Reviewer: "${note}"` : ""}`,
      `  - Baseline: "${k.excerpts.baseline}"`,
      `  - Candidate: "${k.excerpts.candidate}"`,
    ];
  };
  const ahead = margins.filter((m) => m.margin > 0).sort((a, b) => b.margin - a.margin).slice(0, 2);
  const behind = margins.filter((m) => m.margin < 0).sort((a, b) => a.margin - b.margin).slice(0, 2);
  out.push(
    "Largest margins with the candidate ahead (rubric totals over the items scored on both sides):",
    "",
    ...(ahead.length ? ahead.flatMap(quote) : ["- none"]),
    "",
    "Largest margins with the baseline ahead:",
    "",
    ...(behind.length ? behind.flatMap(quote) : ["- none"]),
    "",
  );
  const failed = pairIds.filter((id) => key.pairs[id]!.candidateStatus !== "ok" || key.pairs[id]!.baselineStatus !== "ok");
  if (failed.length) {
    out.push(
      "Pairs with a side that gave no usable reply:",
      "",
      ...failed.map((id) => `- ${id}: baseline ${key.pairs[id]!.baselineStatus}, candidate ${key.pairs[id]!.candidateStatus}`),
      "",
    );
  }
  if (problems.length) out.push("Problems in scores.json:", "", ...problems.map((p) => `- ${p}`), "");
  return out;
}

/**
 * The report's review section: one part per pack (a folder with a key.json)
 * under the review folder. Empty when the folder does not exist.
 */
export function reviewResults(reviewDir: string): string[] {
  if (!existsSync(reviewDir)) return [];
  const packs = readdirSync(reviewDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(reviewDir, e.name, "key.json")))
    .map((e) => path.join(reviewDir, e.name))
    .sort();
  if (packs.length === 0) return ["## Review results", "", `No review packs (folders with a key.json) in ${reviewDir}.`, ""];
  return [
    "## Review results",
    "",
    `Blind scores from the review packs in ${reviewDir}, joined to each pack's key. Each rubric item is scored 1 to 5 per reply; the margin is the candidate's total minus the baseline's.`,
    "",
    ...packs.flatMap(candidateResults),
  ];
}
