import { pool } from "../db.js";
import type { ModelPacket } from "./types.js";

/** Compact transparency summary (issue #42) — counts + week, not secrets. */
export type LastOutboundPacketSummary = {
  isoWeek: string | null;
  weekSessionId: string | null;
  dossierVersionId: number | null;
  threadMessageCount: number;
  attachmentCount: number;
  hasRecap: boolean;
  attachmentWorkoutIds: string[];
  /** Prior weeks included via lean recent-history window (#34). */
  recentHistoryCount: number;
  recentHistoryLimit: number;
};

/** Persisted last outbound redacted packet for athlete inspection. */
export type LastOutboundPacketView = {
  savedAt: string;
  summary: LastOutboundPacketSummary;
  /** Full redacted packet as assembled for LlmPort (no identity PII / GPS). */
  packet: ModelPacket;
};

type Row = {
  saved_at: Date;
  summary: LastOutboundPacketSummary | string;
  packet: ModelPacket | string;
};

function parseJsonField<T>(value: T | string): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value;
}

export function summarizePacket(packet: ModelPacket): LastOutboundPacketSummary {
  return {
    isoWeek: packet.week?.isoWeek ?? null,
    weekSessionId: packet.week?.weekSessionId ?? null,
    dossierVersionId: packet.dossier?.versionId ?? null,
    threadMessageCount: packet.thread.length,
    attachmentCount: packet.attachments.length,
    hasRecap: Boolean(packet.recapMarkdown?.trim()),
    attachmentWorkoutIds: packet.attachments.map((a) => a.workoutId),
    recentHistoryCount: packet.recentHistory?.length ?? 0,
    recentHistoryLimit: packet.recentHistoryLimit ?? 0,
  };
}

/**
 * Persist the redacted packet that would be / was sent to the model.
 * Call after assembly (POST /packet) and from LlmPort once wired.
 */
export async function saveLastOutboundPacket(
  packet: ModelPacket,
): Promise<LastOutboundPacketView> {
  const summary = summarizePacket(packet);
  const result = await pool.query<Row>(
    `
    INSERT INTO last_outbound_packet (id, saved_at, summary, packet)
    VALUES (1, NOW(), $1::jsonb, $2::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      saved_at = NOW(),
      summary = EXCLUDED.summary,
      packet = EXCLUDED.packet
    RETURNING saved_at, summary, packet
    `,
    [JSON.stringify(summary), JSON.stringify(packet)],
  );
  const row = result.rows[0]!;
  return {
    savedAt: row.saved_at.toISOString(),
    summary: parseJsonField(row.summary),
    packet: parseJsonField(row.packet),
  };
}

/**
 * Remember what is about to go to the model, so Privacy can show it. Best effort:
 * a failure here must never stop the coach from replying.
 */
export async function rememberLastOutboundPacket(packet: ModelPacket): Promise<void> {
  try {
    await saveLastOutboundPacket(packet);
  } catch (err) {
    console.warn("Could not store the last message sent to the coach:", err);
  }
}

export async function getLastOutboundPacket(): Promise<LastOutboundPacketView | null> {
  const result = await pool.query<Row>(
    `SELECT saved_at, summary, packet FROM last_outbound_packet WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    savedAt: row.saved_at.toISOString(),
    summary: parseJsonField(row.summary),
    packet: parseJsonField(row.packet),
  };
}
