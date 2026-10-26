import { resolveAppVersion } from "../llmCallLog/appVersion.js";
import type {
  LlmCallOperation,
  LlmCallRecorder,
} from "../llmCallLog/types.js";
import { nextIsoWeekBounds } from "../clock/isoWeek.js";
import {
  formatIsoWeekRangeShort,
  formatWeekRangeShort,
} from "../clock/weekRangeShort.js";
import type { ModelPacket } from "../packet/types.js";
import { LlmSchemaError, type LlmCallOptions, type LlmPort } from "./port.js";
import {
  buildStubSafetyCallouts,
} from "./safety.js";
import {
  expectedPlanDates,
  MAX_BULLET_LENGTH,
  validateDossierAuditDraft,
  validateDossierCorrectionDraft,
  validateDossierV1Draft,
  validateMidWeekChatReply,
  validateWeeklyReply,
} from "./schema.js";
import { COACH_STANCE_SUMMARY } from "./stance.js";
import type {
  DayType,
  DossierAuditDraft,
  DossierAuditInput,
  DossierCorrectionDraft,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  PrescribedDay,
  PrescribedWeek,
  WeeklyReply,
} from "./types.js";

/**
 * Resolve the plan week's Monday (YYYY-MM-DD) from a model packet.
 * Prefer `week.start` (week session Monday); fall back to a fixed test Monday.
 */
export function resolvePlanWeekStartMonday(packet: ModelPacket): string {
  const start = packet.week?.start?.trim();
  if (start && /^\d{4}-\d{2}-\d{2}/.test(start)) {
    return start.slice(0, 10);
  }
  return "2026-10-19";
}

/**
 * Resolve the week the WEEKLY reply plans (N+1): Monday date + ISO label.
 * Prefers `packet.planWeek`; otherwise derives the week after `packet.week`.
 * Without either, falls back to {@link resolvePlanWeekStartMonday}.
 * Mid-week chat keeps using {@link resolvePlanWeekStartMonday} (current week).
 */
export function resolveWeeklyPlanWeek(packet: ModelPacket): {
  weekStartMonday: string;
  isoWeek: string | null;
} {
  const pw = packet.planWeek;
  if (
    pw &&
    /^\d{4}-\d{2}-\d{2}$/.test(pw.startDate ?? "") &&
    /^\d{4}-W\d{2}$/.test(pw.isoWeek ?? "")
  ) {
    return { weekStartMonday: pw.startDate, isoWeek: pw.isoWeek };
  }
  const label = packet.week?.isoWeek?.trim();
  if (label && /^\d{4}-W\d{2}$/.test(label)) {
    try {
      const next = nextIsoWeekBounds(label, "UTC");
      return { weekStartMonday: next.startDate, isoWeek: next.isoWeek };
    } catch {
      // fall through
    }
  }
  return {
    weekStartMonday: resolvePlanWeekStartMonday(packet),
    isoWeek: null,
  };
}

function resolveIsoWeekLabel(packet: ModelPacket, weekStartMonday: string): string {
  const label = packet.week?.isoWeek?.trim();
  if (label && /^\d{4}-W\d{2}$/.test(label)) return label;

  // Derive ISO week from the Monday calendar date (UTC noon).
  const [y, m, d] = weekStartMonday.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const isoYear = date.getUTCFullYear();
  const week1 = new Date(Date.UTC(isoYear, 0, 4));
  const isoWeek =
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

/**
 * Deterministic 7-day template (Mon–Sun):
 * easy / rest / easy / quality / rest / easy / long
 */
function buildStubDays(weekStartMonday: string): PrescribedDay[] {
  const dates = expectedPlanDates(weekStartMonday);
  const pattern: Array<{
    dayType: DayType;
    distanceM?: number;
    structure?: string | null;
    paceOrHr?: string | null;
    shoes?: string | null;
    strength?: string | null;
    notes?: string | null;
  }> = [
    {
      dayType: "easy",
      distanceM: 8000,
      paceOrHr: "easy pace / conversational",
      shoes: "daily trainer",
      notes: "Keep HR relaxed.",
    },
    { dayType: "rest", notes: "Full rest or easy walk." },
    {
      dayType: "easy",
      distanceM: 10000,
      paceOrHr: "easy pace",
      shoes: "daily trainer",
      strength: "20–30 min core + hip stability",
    },
    {
      dayType: "quality",
      distanceM: 12000,
      structure: "2 mi warm-up + 4×3 min threshold w/ 2 min jog + cool-down",
      paceOrHr: "threshold effort / controlled breathing",
      shoes: "lighter trainer or race flat",
      notes: "Stop if form falls apart.",
    },
    { dayType: "rest", strength: "Optional mobility only." },
    {
      dayType: "easy",
      distanceM: 8000,
      paceOrHr: "easy pace",
      shoes: "daily trainer",
    },
    {
      dayType: "long",
      distanceM: 18000,
      paceOrHr: "easy–steady; finish feeling you could do 2 more easy miles",
      shoes: "cushioned long-run shoe",
      notes: "Fuel early; no heroics.",
    },
  ];

  return dates.map((date, i) => {
    const p = pattern[i]!;
    const day: PrescribedDay = { date, dayType: p.dayType };
    if (p.dayType !== "rest" && p.distanceM != null) {
      day.run = {
        type: p.dayType === "quality" || p.dayType === "long" ? p.dayType : "easy",
        distanceM: p.distanceM,
        structure: p.structure ?? null,
        paceOrHr: p.paceOrHr ?? null,
        shoes: p.shoes ?? null,
      };
    } else {
      day.run = null;
    }
    if (p.strength !== undefined) day.strength = p.strength;
    if (p.notes !== undefined) day.notes = p.notes;
    return day;
  });
}

function buildStubAnalysis(packet: ModelPacket): string {
  const hasRecap = Boolean(packet.recapMarkdown?.trim());
  const hasDossier = Boolean(packet.dossier?.body?.trim());
  const attachmentCount = packet.attachments?.length ?? 0;
  const planRange = packet.planWeek
    ? formatWeekRangeShort(packet.planWeek.startDate, packet.planWeek.endDate)
    : null;
  const weekLabel = planRange ? `Next week (${planRange})` : "Next week";

  const headline = hasRecap
    ? `Headline: ${weekLabel} looks workable. Protect easy days and land the long run.`
    : `Headline: I don't have much to go on for ${weekLabel.toLowerCase()}, so this is a conservative base week.`;

  const concerns: string[] = [];
  if (hasDossier && /achilles|niggle|pain|sore/i.test(packet.dossier!.body)) {
    concerns.push(
      "Flag: your profile mentions a soft-tissue concern. Cap quality and keep volume honest.",
    );
  }
  if (!hasRecap) {
    concerns.push("Flag: there is no weekly report for this week, so the plan follows a standard template.");
  }
  if (attachmentCount === 0) {
    concerns.push("Flag: no runs were attached, so I am working from your profile and weekly report only.");
  }
  if (concerns.length === 0) {
    concerns.push("Flag: nothing major to flag. Watch heart rate drift on easy days.");
  }

  const answers =
    "Answers: Keep quality to one session, shoes as listed, and treat rest days as real rest.";

  return ["## Headline", headline, "", "## Concerns", ...concerns, "", "## Answers", answers].join(
    "\n",
  );
}

function buildStubSettingsBullets(packet: ModelPacket): string[] | undefined {
  const body = packet.dossier?.body?.trim();
  if (!body) return undefined;
  return [
    "Add how this week felt and any lingering niggles to what Coach Cade knows about you.",
  ];
}

/** Pure builder used by the stub port (and tests). */
export function buildStubWeeklyReply(packet: ModelPacket): WeeklyReply {
  const planWeek = resolveWeeklyPlanWeek(packet);
  const weekStartMonday = planWeek.weekStartMonday;
  const week =
    planWeek.isoWeek ?? resolveIsoWeekLabel(packet, weekStartMonday);
  const prescribedWeek: PrescribedWeek = {
    week,
    days: buildStubDays(weekStartMonday),
  };
  const reply: WeeklyReply = {
    analysis: buildStubAnalysis(packet),
    prescribedWeek,
  };
  const bullets = buildStubSettingsBullets(packet);
  if (bullets) reply.settingsProposalBullets = bullets;
  const callouts = buildStubSafetyCallouts(packet);
  if (callouts.length > 0) reply.safetyCallouts = callouts;
  return reply;
}

function truncateForReply(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatPaceMinPerKm(avgPaceS: number): string {
  const total = Math.max(0, Math.round(avgPaceS));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}/km`;
}

function formatDurationClock(durationS: number): string {
  const total = Math.max(0, Math.round(durationS));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Deterministic attach feedback for stub/CI (issue #37).
 * Uses the latest attachment's coaching metrics only.
 */
export function buildStubAttachedRunFeedback(
  packet: ModelPacket,
): string | null {
  const attachments = packet.attachments ?? [];
  if (attachments.length === 0) return null;
  const run = attachments[attachments.length - 1]!;
  const km = (run.distanceM / 1000).toFixed(1);
  const parts = [
    `${km} km in ${formatDurationClock(run.durationS)}`,
    `avg pace ${formatPaceMinPerKm(run.avgPaceS)}`,
  ];
  if (run.avgHeartRateBpm != null) {
    parts.push(`avg HR ${run.avgHeartRateBpm} bpm`);
  }
  if (run.splitsCount != null && run.splitsCount > 0) {
    parts.push(`${run.splitsCount} splits`);
  }
  const label =
    run.activityName?.trim() ||
    run.runType?.trim() ||
    "Attached run";
  const countNote =
    attachments.length > 1
      ? ` (${attachments.length} attachments in thread; feedback on latest)`
      : "";
  return (
    `Attached run feedback${countNote}: ${label} — ${parts.join(", ")}. ` +
    "Looks usable for coaching from metrics/splits only; keep the rest of the week honest. " +
    "Reminder: do not diagnose — see a clinician if something feels off."
  );
}

/**
 * Significant mid-week memory signals in the athlete's latest note (#39).
 * Kept narrower than packet-wide safety callouts so casual check-ins stay clean.
 */
const STUB_MIDWEEK_MEMORY_RE =
  /\b(achilles|niggle|pain|sore|injury|injured|swelling|flare|skip|skipping|travel|traveling|travelling|sick|illness|constraint|can't run|cannot run)\b/i;

/** Soft-gate bullets when the athlete's mid-week note is memory-worthy (#39). */
function buildStubMidWeekSettingsBullets(
  packet: ModelPacket,
): string[] | undefined {
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  const note = lastAthlete?.body?.trim();
  if (!note || !STUB_MIDWEEK_MEMORY_RE.test(note)) return undefined;
  return [
    `This week you reported "${truncateForReply(note, 80)}". Add it to what Coach Cade knows about you.`,
  ];
}

const PLAN_CHANGE_RE =
  /\b(cut|skip|shorten|move|swap|patch|change)\b/i;

/**
 * Deterministic remaining-day plan patch for stub/CI (issue #38).
 * When the athlete asks to change the plan and a prescribed week is present,
 * rest the first quality day (else first easy) from Wednesday onward.
 */
export function buildStubPrescribedDayPatches(
  packet: ModelPacket,
): PrescribedDay[] | undefined {
  const plan = packet.prescribedWeek;
  if (!plan?.days?.length) return undefined;
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  if (!lastAthlete?.body || !PLAN_CHANGE_RE.test(lastAthlete.body)) {
    return undefined;
  }
  const weekStartMonday = resolvePlanWeekStartMonday(packet);
  const fromWed = expectedPlanDates(weekStartMonday)[2]!;
  const remaining = plan.days.filter((d) => d.date >= fromWed);
  const target =
    remaining.find((d) => d.dayType === "quality") ??
    remaining.find((d) => d.dayType === "easy") ??
    remaining[0];
  if (!target) return undefined;
  return [
    {
      date: target.date,
      dayType: "rest",
      run: null,
      notes: "Changed this week: rest and recover. The quality session is moved out.",
    },
  ];
}

/** Pure builder for mid-week free chat + attach/plan patch (issues #35–#39). */
export function buildStubMidWeekChatReply(packet: ModelPacket): MidWeekChatReply {
  const lastAthlete = [...packet.thread]
    .reverse()
    .find((m) => m.role === "athlete");
  const heard = lastAthlete?.body?.trim()
    ? `Heard: "${truncateForReply(lastAthlete.body)}".`
    : "Got your note.";
  const dossierNote = packet.dossier?.body?.trim()
    ? "I'll keep what I know about you in mind."
    : "I don't have much on file about you yet, so keep easy days honest.";
  const attachFeedback = buildStubAttachedRunFeedback(packet);
  const attachNote =
    attachFeedback ??
    "No run attached. Say more if something needs to change.";
  const patches = buildStubPrescribedDayPatches(packet);
  const patchNote = patches?.length
    ? `Updated the plan for ${patches.map((p) => p.date).join(", ")}. Only the days still to come change.`
    : null;
  const reply: MidWeekChatReply = {
    body: [
      "Quick check-in for this week.",
      heard,
      dossierNote,
      attachNote,
      ...(patchNote ? [patchNote] : []),
    ].join(" "),
  };
  if (patches?.length) reply.prescribedDayPatches = patches;
  const bullets = buildStubMidWeekSettingsBullets(packet);
  if (bullets) reply.settingsProposalBullets = bullets;
  const callouts = buildStubSafetyCallouts(packet);
  if (callouts.length > 0) reply.safetyCallouts = callouts;
  return reply;
}
function formatDistanceHint(
  meters: number,
  unit?: "metric" | "imperial",
): string {
  if (unit === "imperial") {
    return `${(meters / 1609.344).toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Soft-gate summary line — keep ≤ MAX_BULLET_LENGTH; full text lives in proposedBody. */
function dossierSummaryBullet(label: string, value: string): string {
  const prefix = `${label}: `;
  const maxValue = Math.max(24, MAX_BULLET_LENGTH - prefix.length);
  return `${prefix}${truncateForReply(value, maxValue)}`;
}

/** Pure builder for onboarding → dossier v1 (issue #17). */
export function buildStubDossierV1(input: DossierV1Input): DossierV1Draft {
  const { answers, prefills } = input;
  const summaryBullets: string[] = [
    dossierSummaryBullet("Goal", answers.goal),
    dossierSummaryBullet("Schedule", answers.schedule),
  ];
  if (answers.injuries_constraints) {
    summaryBullets.push(
      dossierSummaryBullet("Constraints", answers.injuries_constraints),
    );
  }
  if (answers.preferences) {
    summaryBullets.push(
      dossierSummaryBullet("Preferences", answers.preferences),
    );
  }
  if (prefills.available) {
    const z2 = prefills.heartRateZones?.zones.find((z) => z.zoneNumber === 2);
    if (z2) {
      summaryBullets.push(
        truncateForReply(
          `Easy heart rate zone about ${z2.minBpm}–${z2.maxBpm} bpm (from your running log)`,
          MAX_BULLET_LENGTH,
        ),
      );
    }
    const shoe = prefills.shoes?.[0];
    if (shoe) {
      summaryBullets.push(
        truncateForReply(
          `Main shoe: ${shoe.brand} ${shoe.model}`,
          MAX_BULLET_LENGTH,
        ),
      );
    }
  } else {
    summaryBullets.push("Your running log was not available, so this comes from your answers only");
  }

  const tempoLines: string[] = [];
  if (prefills.available) {
    if (prefills.unitPreference) {
      tempoLines.push(`- Units: ${prefills.unitPreference}`);
    }
    const zones = prefills.heartRateZones?.zones ?? [];
    if (zones.length > 0) {
      const zoneText = zones
        .map((z) => `Z${z.zoneNumber} ${z.minBpm}–${z.maxBpm}`)
        .join("; ");
      tempoLines.push(`- HR zones: ${zoneText}`);
    }
    if (prefills.shoes && prefills.shoes.length > 0) {
      const shoeText = prefills.shoes
        .slice(0, 5)
        .map((s) => `${s.brand} ${s.model}`)
        .join(", ");
      tempoLines.push(`- Shoes: ${shoeText}`);
    }
    if (prefills.recentTraining && prefills.recentTraining.length > 0) {
      const recent = prefills.recentTraining
        .slice(0, 5)
        .map(
          (r) =>
            `${r.name ?? r.runType ?? "run"} (${formatDistanceHint(r.distanceM, prefills.unitPreference)})`,
        )
        .join("; ");
      tempoLines.push(`- Recent training: ${recent}`);
    }
  } else {
    tempoLines.push("- Your running log was not available when this was written.");
  }

  const proposedBody = [
    "# About you (v1)",
    "",
    "## Stance",
    COACH_STANCE_SUMMARY,
    "",
    "## Goal",
    answers.goal,
    "",
    "## Schedule",
    answers.schedule,
    "",
    "## Constraints",
    answers.injuries_constraints?.trim() ||
      "_None volunteered — ask again if niggles appear._",
    "",
    "## Preferences",
    answers.preferences?.trim() || "_None volunteered._",
    "",
    "## From your running log",
    ...tempoLines,
    "",
    "## Coaching notes",
    "Protect easy days. Cap quality when constraints are present. Revisit this brief after week one.",
  ].join("\n");

  return { summaryBullets, proposedBody };
}

/** Athlete-facing coach thread summary for a pending dossier soft-gate. */
export function formatDossierProposalThreadBody(draft: {
  summaryBullets: string[];
}): string {
  const bullets = draft.summaryBullets.map((b) => `• ${b}`).join("\n");
  return [
    "Here is what I understood from your answers, and from your running log where I could see it.",
    "",
    "Summary:",
    bullets,
    "",
    "Accept to save it, or Reject to start over. The full text is under About you.",
  ].join("\n");
}

/** Athlete-facing coach thread summary for a pending correction rewrite (#18). */
export function formatDossierCorrectionThreadBody(draft: {
  summaryBullets: string[];
}): string {
  const bullets = draft.summaryBullets.map((b) => `• ${b}`).join("\n");
  return [
    "I've updated what I know about you, based on your correction.",
    "",
    "Summary:",
    bullets,
    "",
    "If that isn't right, you can undo it. The full text is under About you.",
  ].join("\n");
}

/**
 * Deterministic athlete correction → dossier rewrite (issue #18).
 * Keeps prior body and appends an Athlete correction section.
 */
export function buildStubDossierCorrection(
  input: DossierCorrectionInput,
): DossierCorrectionDraft {
  const note = input.athleteMessage.trim().replace(/\s+/g, " ");
  const weekLabel = input.week?.isoWeek?.trim()
    ? formatIsoWeekRangeShort(input.week.isoWeek)
    : "this week";
  const base = input.currentDossier.body.trimEnd();
  const summaryBullets = [
    `Your correction (${weekLabel}): ${truncateForReply(note, 160)}`,
    "Saved to what I know about you.",
  ];
  const proposedBody = [
    base || "# About you",
    "",
    `## Athlete correction (${weekLabel})`,
    note,
    "",
    "_Added from your correction._",
    "",
  ].join("\n");
  return { summaryBullets, proposedBody };
}

type MdSection = { title: string; body: string };

/** Split markdown on `## ` headings (keeps preface before the first heading). */
function splitMarkdownSections(markdown: string): {
  preface: string;
  sections: MdSection[];
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: MdSection[] = [];
  let prefaceLines: string[] = [];
  let current: MdSection | null = null;

  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1]!.trim(), body: "" };
      continue;
    }
    if (!current) {
      prefaceLines.push(line);
    } else {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  if (current) sections.push(current);

  return {
    preface: prefaceLines.join("\n").trimEnd(),
    sections: sections.map((s) => ({
      title: s.title,
      body: s.body.replace(/^\n+/, "").replace(/\n+$/, ""),
    })),
  };
}

function ymdFromIso(iso: string | null | undefined): string {
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  return "2026-10-20";
}

function addWeeksYmd(ymd: string, weeks: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic dossier audit/trim (issue #40).
 * Collapses Coach update sections into Current Status; rewrites status; stamps cadence.
 */
export function buildStubDossierAudit(
  input: DossierAuditInput,
): DossierAuditDraft {
  const weekLabel = input.week?.isoWeek?.trim()
    ? formatIsoWeekRangeShort(input.week.isoWeek)
    : "this week";
  const updatedYmd = ymdFromIso(input.nowIso);
  const intervalWeeks = input.intervalWeeks ?? 5;
  const nextDueYmd = addWeeksYmd(updatedYmd, intervalWeeks);

  const { preface, sections } = splitMarkdownSections(
    input.currentDossier.body,
  );
  const coachUpdates = sections.filter((s) =>
    /^coach update\b/i.test(s.title),
  );
  const kept = sections.filter((s) => !/^coach update\b/i.test(s.title));

  const consolidatedBullets: string[] = [];
  for (const u of coachUpdates) {
    for (const line of u.body.split("\n")) {
      const bullet = line.replace(/^\s*[-*]\s+/, "").trim();
      if (bullet) consolidatedBullets.push(bullet);
    }
  }

  const statusIdx = kept.findIndex((s) => /^current status\b/i.test(s.title));
  const statusLines = [
    `**Tidied ${updatedYmd} (${weekLabel}).** Older update lines are folded into this status.`,
    "",
  ];
  if (consolidatedBullets.length > 0) {
    statusLines.push("Active notes from recent coach updates:");
    for (const b of consolidatedBullets) {
      statusLines.push(`- ${b}`);
    }
    statusLines.push("");
  }
  if (statusIdx >= 0) {
    const prior = kept[statusIdx]!.body.trim();
    if (prior) {
      statusLines.push("_Prior status (kept for continuity):_");
      statusLines.push(prior);
    }
    kept[statusIdx] = {
      title: `Current Status (updated ${updatedYmd})`,
      body: statusLines.join("\n").trimEnd(),
    };
  } else {
    kept.unshift({
      title: `Current Status (updated ${updatedYmd})`,
      body: statusLines.join("\n").trimEnd(),
    });
  }

  // Drop a prior Settings audit meta section; we rewrite it below.
  const withoutAuditMeta = kept.filter(
    (s) => !/^settings audit\b/i.test(s.title),
  );
  withoutAuditMeta.push({
    title: "Settings audit",
    body: [
      `- Last audit: ${updatedYmd}`,
      `- Next due: ${nextDueYmd} (~${intervalWeeks} weeks)`,
      "- Focus: trim/consolidate Current Status; remove superseded coach-update sludge.",
    ].join("\n"),
  });

  const parts: string[] = [];
  if (preface.trim()) parts.push(preface.trimEnd());
  for (const s of withoutAuditMeta) {
    parts.push(`## ${s.title}\n\n${s.body}`.trimEnd());
  }
  const proposedBody = `${parts.join("\n\n")}\n`;

  const removed = coachUpdates.length;
  const summaryBullets = [
    `Tidy-up (${weekLabel}): rewrite Current Status (updated ${updatedYmd}).`,
    removed > 0
      ? `Fold ${removed} older update section(s) into Current Status and remove superseded log entries.`
      : "No older update sections to fold in. Current Status is rewritten.",
    `Next tidy-up around ${nextDueYmd} (every ${intervalWeeks} weeks). Accept to apply.`,
  ];

  return { summaryBullets, proposedBody };
}

/** Athlete-facing coach thread summary for a pending dossier audit (#40). */
export function formatDossierAuditThreadBody(draft: {
  summaryBullets: string[];
}): string {
  const bullets = draft.summaryBullets.map((b) => `• ${b}`).join("\n");
  return [
    "I've drafted a tidy-up of what I know about you. Nothing changes until you Accept.",
    "",
    "Summary:",
    bullets,
    "",
    "Accept to save the tidy-up, or Reject to discard it. The full text is under About you.",
  ].join("\n");
}

/**
 * Deterministic LlmPort — no network. Validates schema before returning.
 */
export type StubLlmPortOptions = {
  /** LLM call log sink; rows are only written when a call supplies a callId. */
  recorder?: LlmCallRecorder;
  appVersion?: string;
};

export function createStubLlmPort(options?: StubLlmPortOptions): LlmPort {
  const recorder = options?.recorder;
  const appVersion = options?.appVersion ?? resolveAppVersion();

  /** Append the `ok` row for a stub call. Best-effort: never fails the call. */
  async function recordOk(
    operation: LlmCallOperation,
    callOptions: LlmCallOptions | undefined,
    request: unknown,
    output: unknown,
  ): Promise<void> {
    if (!recorder || !callOptions?.callId) return;
    try {
      await recorder.record({
        id: callOptions.callId,
        operation,
        provider: "stub",
        model: null,
        appVersion,
        weekSessionId: callOptions.weekSessionId ?? null,
        parentCallId: null,
        request,
        responseRaw: JSON.stringify(output),
        httpStatus: null,
        latencyMs: null,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        outcome: "ok",
        errorMessage: null,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[llm-call-log] row dropped (id=${callOptions.callId} operation=${operation}): ${reason}`,
      );
    }
  }

  return {
    async generateWeeklyReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<WeeklyReply> {
      const draft = buildStubWeeklyReply(packet);
      const weekStartMonday = resolveWeeklyPlanWeek(packet).weekStartMonday;
      const validated = validateWeeklyReply(draft, weekStartMonday);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("weekly_reply", callOptions, packet, validated.value);
      return validated.value;
    },
    async generateMidWeekChatReply(
      packet: ModelPacket,
      callOptions?: LlmCallOptions,
    ): Promise<MidWeekChatReply> {
      const draft = buildStubMidWeekChatReply(packet);
      const weekStartMonday = resolvePlanWeekStartMonday(packet);
      const validated = validateMidWeekChatReply(draft, weekStartMonday);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("mid_week_chat", callOptions, packet, validated.value);
      return validated.value;
    },
    async generateDossierV1(
      input: DossierV1Input,
      callOptions?: LlmCallOptions,
    ): Promise<DossierV1Draft> {
      const draft = buildStubDossierV1(input);
      const validated = validateDossierV1Draft(draft);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("dossier_v1", callOptions, input, validated.value);
      return validated.value;
    },
    async generateDossierCorrection(
      input: DossierCorrectionInput,
      callOptions?: LlmCallOptions,
    ): Promise<DossierCorrectionDraft> {
      const draft = buildStubDossierCorrection(input);
      const validated = validateDossierCorrectionDraft(draft);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("dossier_correction", callOptions, input, validated.value);
      return validated.value;
    },
    async generateDossierAudit(
      input: DossierAuditInput,
      callOptions?: LlmCallOptions,
    ): Promise<DossierAuditDraft> {
      const draft = buildStubDossierAudit(input);
      const validated = validateDossierAuditDraft(draft);
      if (!validated.ok) {
        throw new LlmSchemaError(validated.error);
      }
      await recordOk("dossier_audit", callOptions, input, validated.value);
      return validated.value;
    },
  };
}
