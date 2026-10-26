import { pool } from "../db.js";
import type { PrescribedWeek } from "../llm/types.js";
import type { ModelPacketRecentWeek } from "./types.js";

type Row = {
  week_session_id: string;
  iso_week: string;
  start_at: Date;
  recap_markdown: string | null;
  analysis: string | null;
  plan: PrescribedWeek | string | null;
};

function parsePlan(value: PrescribedWeek | string | null): PrescribedWeek | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as PrescribedWeek;
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Load last N prior weeks' durable summaries/plans for lean live context.
 * Excludes the focus week. Does not load thread messages (mid-week chatter).
 * Newest prior week first.
 */
export async function loadRecentWeekSummaries(opts: {
  focusWeekSessionId: string;
  limit: number;
}): Promise<ModelPacketRecentWeek[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];

  const result = await pool.query<Row>(
    `
    SELECT
      ws.id::text AS week_session_id,
      ws.iso_week,
      ws.start_at,
      wr.markdown AS recap_markdown,
      pw.analysis,
      pw.plan
    FROM week_sessions ws
    LEFT JOIN week_recaps wr ON wr.week_session_id = ws.id
    LEFT JOIN prescribed_weeks pw ON pw.week_session_id = ws.id
    WHERE ws.id <> $1::uuid
      AND ws.start_at < (
        SELECT start_at FROM week_sessions WHERE id = $1::uuid
      )
    ORDER BY ws.start_at DESC, ws.iso_week DESC, ws.id DESC
    LIMIT $2
    `,
    [opts.focusWeekSessionId, limit],
  );

  return result.rows.map((row) => {
    const entry: ModelPacketRecentWeek = {
      isoWeek: row.iso_week,
      weekSessionId: row.week_session_id,
    };
    if (row.recap_markdown != null) {
      entry.recapMarkdown = row.recap_markdown;
    }
    if (row.analysis != null) {
      entry.analysis = row.analysis;
    }
    const plan = parsePlan(row.plan);
    if (plan != null) {
      entry.prescribedWeek = plan;
    }
    return entry;
  });
}
