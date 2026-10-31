import { DEFAULT_RECENT_HISTORY_LIMIT } from "./lean.js";
import {
  assertPacketHasNoPiiOrGps,
  redactValue,
  scrubString,
} from "./redact.js";
import type {
  BuildModelPacketInput,
  ModelPacket,
  ModelPacketAttachment,
  ModelPacketRecentWeek,
  ModelPacketRole,
  ModelPacketThreadMessage,
} from "./types.js";

const ROLES = new Set<ModelPacketRole>(["athlete", "coach", "system"]);

function asNumber(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") return v;
  return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function mapRole(role: string): ModelPacketRole {
  return ROLES.has(role as ModelPacketRole)
    ? (role as ModelPacketRole)
    : "athlete";
}

function mapSplit(
  raw: unknown,
): NonNullable<ModelPacketAttachment["splits"]>[number] | null {
  if (!isPlainObject(raw)) return null;
  const split: NonNullable<ModelPacketAttachment["splits"]>[number] = {};
  const idx = asNumber(raw.idx);
  if (idx !== undefined && idx !== null) split.idx = idx;
  const kind = asString(raw.kind);
  if (kind !== undefined) split.kind = kind;
  const distanceM = asNumber(raw.distanceM);
  if (distanceM !== undefined) split.distanceM = distanceM;
  const durationS = asNumber(raw.durationS);
  if (durationS !== undefined) split.durationS = durationS;
  const paceS = asNumber(raw.paceS);
  if (paceS !== undefined) split.paceS = paceS;
  const avgHeartRateBpm = asNumber(raw.avgHeartRateBpm);
  if (avgHeartRateBpm !== undefined) split.avgHeartRateBpm = avgHeartRateBpm;
  const intensity = asString(raw.intensity);
  if (intensity !== undefined) split.intensity = intensity;
  const trigger = asString(raw.trigger);
  if (trigger !== undefined) split.trigger = trigger;
  const stepIndex = asNumber(raw.stepIndex);
  if (stepIndex !== undefined) split.stepIndex = stepIndex;
  return split;
}

/**
 * Project a raw workout-like object into a coaching attachment.
 * Drops GPS/identity; keeps metrics and athlete workout notes.
 */
export function toAttachment(
  raw: unknown,
  hints?: BuildModelPacketInput["identityHints"],
): ModelPacketAttachment | null {
  if (!isPlainObject(raw)) return null;

  const workoutId =
    asString(raw.workoutId) ?? asString(raw.id) ?? asString(raw.workout_id);
  const startedAt = asString(raw.startedAt) ?? asString(raw.started_at);
  const durationS = asNumber(raw.durationS) ?? asNumber(raw.duration_s);
  const distanceM = asNumber(raw.distanceM) ?? asNumber(raw.distance_m);
  const avgPaceS = asNumber(raw.avgPaceS) ?? asNumber(raw.avg_pace_s);

  if (
    !workoutId ||
    !startedAt ||
    durationS === undefined ||
    durationS === null ||
    distanceM === undefined ||
    distanceM === null ||
    avgPaceS === undefined ||
    avgPaceS === null
  ) {
    return null;
  }

  const attachment: ModelPacketAttachment = {
    workoutId,
    startedAt,
    durationS,
    distanceM,
    avgPaceS,
  };

  const elevGainM = asNumber(raw.elevGainM);
  if (elevGainM !== undefined) attachment.elevGainM = elevGainM;
  const avgHeartRateBpm = asNumber(raw.avgHeartRateBpm);
  if (avgHeartRateBpm !== undefined) {
    attachment.avgHeartRateBpm = avgHeartRateBpm;
  }
  const maxHeartRateBpm = asNumber(raw.maxHeartRateBpm);
  if (maxHeartRateBpm !== undefined) {
    attachment.maxHeartRateBpm = maxHeartRateBpm;
  }
  const relativeEffort = asNumber(raw.relativeEffort);
  if (relativeEffort !== undefined) attachment.relativeEffort = relativeEffort;
  const rpe = asNumber(raw.rpe);
  if (rpe !== undefined) attachment.rpe = rpe;
  const runType = asString(raw.runType);
  if (runType !== undefined) {
    attachment.runType =
      runType === null ? null : scrubString(runType, hints);
  }
  // Tempo "name" is activity title — remap so identity key "name" never appears.
  const activityName = asString(raw.activityName) ?? asString(raw.name);
  if (activityName !== undefined) {
    attachment.activityName =
      activityName === null ? null : scrubString(activityName, hints);
  }
  const notes = asString(raw.notes);
  if (notes !== undefined) {
    attachment.notes = notes === null ? null : scrubString(notes, hints);
  }
  const hasRoute = asBoolean(raw.hasRoute);
  if (hasRoute !== undefined) attachment.hasRoute = hasRoute;
  else if ("route" in raw) attachment.hasRoute = raw.route != null;

  if (Array.isArray(raw.splits)) {
    const splits = raw.splits
      .map(mapSplit)
      .filter((s): s is NonNullable<typeof s> => s != null);
    if (splits.length > 0) attachment.splits = splits;
    attachment.splitsCount = splits.length;
  } else {
    const splitsCount = asNumber(raw.splitsCount);
    if (splitsCount !== undefined && splitsCount !== null) {
      attachment.splitsCount = splitsCount;
    }
  }

  // Defense: drop any residual identity/GPS keys if callers spread extras later.
  return redactValue(attachment, hints) as ModelPacketAttachment;
}

function mapRecentWeek(
  raw: ModelPacketRecentWeek,
  hints: BuildModelPacketInput["identityHints"],
): ModelPacketRecentWeek {
  const entry: ModelPacketRecentWeek = {
    isoWeek: raw.isoWeek,
    weekSessionId: raw.weekSessionId,
  };
  if (raw.recapMarkdown !== undefined) {
    entry.recapMarkdown =
      raw.recapMarkdown == null
        ? null
        : scrubString(raw.recapMarkdown, hints);
  }
  if (raw.analysis !== undefined) {
    entry.analysis =
      raw.analysis == null ? null : scrubString(raw.analysis, hints);
  }
  if (raw.prescribedWeek !== undefined) {
    entry.prescribedWeek = raw.prescribedWeek;
  }
  return entry;
}

/**
 * Build the redacted model context packet from dossier + recap + thread +
 * attachments + lean recent history (#34).
 * Athlete-volunteered coaching notes in the dossier remain; identity PII and GPS do not.
 *
 * Callers that assemble live packets should use `assembleLeanLiveContext` so
 * archived mid-week chatter is never included beyond the N-week summary window.
 */
export function buildModelPacket(input: BuildModelPacketInput): ModelPacket {
  const hints = input.identityHints;

  let dossier: ModelPacket["dossier"] = null;
  if (input.dossier && typeof input.dossier.body === "string") {
    dossier = {
      versionId: input.dossier.versionId ?? null,
      body: scrubString(input.dossier.body, hints),
    };
  }

  const recapMarkdown =
    input.recapMarkdown == null
      ? null
      : scrubString(input.recapMarkdown, hints);

  const thread: ModelPacketThreadMessage[] = (input.thread ?? []).map(
    (msg) => {
      const mapped: ModelPacketThreadMessage = {
        role: mapRole(msg.role),
        body: scrubString(msg.body, hints),
      };
      if (msg.createdAt) mapped.createdAt = msg.createdAt;
      return mapped;
    },
  );

  const attachments: ModelPacketAttachment[] = [];
  for (const raw of input.attachments ?? []) {
    const attachment = toAttachment(raw, hints);
    if (attachment) attachments.push(attachment);
  }

  const recentHistoryLimit =
    typeof input.recentHistoryLimit === "number" &&
    Number.isFinite(input.recentHistoryLimit) &&
    input.recentHistoryLimit >= 0
      ? Math.floor(input.recentHistoryLimit)
      : DEFAULT_RECENT_HISTORY_LIMIT;

  const recentHistory = (input.recentHistory ?? [])
    .slice(0, recentHistoryLimit)
    .map((w) => mapRecentWeek(w, hints));

  const packet: ModelPacket = {
    dossier,
    recapMarkdown,
    thread,
    attachments,
    week: input.week ?? null,
    recentHistory,
    recentHistoryLimit,
    // The goal and its coaching context are structured athlete data, not
    // identity: copied through without scrubbing.
    goal: input.goal ? { ...input.goal } : null,
    coaching: input.coaching ? { ...input.coaching } : null,
  };
  if (input.planWeek !== undefined) {
    packet.planWeek = input.planWeek;
  }
  if (input.prescribedWeek !== undefined) {
    packet.prescribedWeek = input.prescribedWeek;
  }

  assertPacketHasNoPiiOrGps(packet, {
    identityHints: hints,
    forbiddenSubstrings: [
      ...(hints?.emails ?? []),
      ...(hints?.names ?? []),
    ],
  });

  return packet;
}
