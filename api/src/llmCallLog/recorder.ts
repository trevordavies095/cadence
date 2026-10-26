import { pool } from "../db.js";
import type {
  LlmCallOperation,
  LlmCallOutcome,
  LlmCallListFilter,
  LlmCallRecord,
  LlmCallRecorder,
  LlmCallRow,
  LlmCallSummary,
} from "./types.js";

type Row = {
  id: string;
  created_at: Date;
  operation: string;
  provider: string;
  model: string | null;
  app_version: string;
  week_session_id: string | null;
  parent_call_id: string | null;
  request: unknown | null;
  response_raw: string | null;
  http_status: number | null;
  latency_ms: number | null;
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  outcome: string;
  error_message: string | null;
};

function toRow(row: Row): LlmCallRow {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    operation: row.operation as LlmCallOperation,
    provider: row.provider as LlmCallRow["provider"],
    model: row.model,
    appVersion: row.app_version,
    weekSessionId: row.week_session_id,
    parentCallId: row.parent_call_id,
    request: row.request,
    responseRaw: row.response_raw,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    stopReason: row.stop_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    thinkingTokens: row.thinking_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    outcome: row.outcome as LlmCallOutcome,
    errorMessage: row.error_message,
  };
}

const FULL_COLUMNS = `id::text, created_at, operation, provider, model, app_version,
  week_session_id::text, parent_call_id::text, request,
  response_raw, http_status, latency_ms, stop_reason,
  input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
  cache_creation_tokens, outcome, error_message`;

const SUMMARY_COLUMNS = `id::text, created_at, operation, provider, model, app_version,
  week_session_id::text, parent_call_id::text,
  http_status, latency_ms, stop_reason,
  input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
  cache_creation_tokens, outcome, error_message`;

const EXPORT_BATCH_SIZE = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres-backed LLM call log. Writes never throw: a dropped row is reported on stderr. */
export function createPostgresLlmCallRecorder(): LlmCallRecorder {
  return {
    async record(row: LlmCallRecord): Promise<void> {
      try {
        await pool.query(
          `
          INSERT INTO llm_call_log (
            id, operation, provider, model, app_version, week_session_id,
            parent_call_id, request, response_raw, http_status, latency_ms,
            stop_reason, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, outcome, error_message, thinking_tokens
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19
          )
          `,
          [
            row.id,
            row.operation,
            row.provider,
            row.model,
            row.appVersion,
            row.weekSessionId,
            row.parentCallId,
            row.request === null ? null : JSON.stringify(row.request),
            row.responseRaw,
            row.httpStatus,
            row.latencyMs,
            row.stopReason,
            row.inputTokens,
            row.outputTokens,
            row.cacheReadTokens,
            row.cacheCreationTokens,
            row.outcome,
            row.errorMessage,
            row.thinkingTokens,
          ],
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[llm-call-log] row dropped (id=${row.id} operation=${row.operation} outcome=${row.outcome}): ${reason}`,
        );
      }
    },

    async get(id: string): Promise<LlmCallRow | null> {
      if (!UUID_RE.test(id)) return null;
      const result = await pool.query<Row>(
        `SELECT id::text, created_at, operation, provider, model, app_version,
                week_session_id::text, parent_call_id::text, request,
                response_raw, http_status, latency_ms, stop_reason,
                input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
                cache_creation_tokens, outcome, error_message
         FROM llm_call_log WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toRow(row) : null;
    },

    async list(filter: LlmCallListFilter): Promise<LlmCallSummary[]> {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.weekSessionId !== undefined) {
        if (!UUID_RE.test(filter.weekSessionId)) return [];
        params.push(filter.weekSessionId);
        where.push(`week_session_id = $${params.length}`);
      }
      if (filter.operation !== undefined) {
        params.push(filter.operation);
        where.push(`operation = $${params.length}`);
      }
      if (filter.outcome !== undefined) {
        params.push(filter.outcome);
        where.push(`outcome = $${params.length}`);
      }
      const result = await pool.query<Row>(
        `SELECT ${SUMMARY_COLUMNS} FROM llm_call_log
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC`,
        params,
      );
      return result.rows.map((r) => {
        const { request: _req, responseRaw: _raw, ...summary } = toRow(r);
        return summary;
      });
    },

    async *exportAll(): AsyncGenerator<LlmCallRow> {
      // Keyset pagination on (created_at, id). The cursor is carried as text so
      // Postgres' microsecond precision survives (a JS Date would truncate it).
      let cursor: { createdAt: string; id: string } | null = null;
      for (;;) {
        const result: { rows: Array<Row & { cursor_ts: string }> } =
          await pool.query(
            `SELECT ${FULL_COLUMNS}, created_at::text AS cursor_ts
             FROM llm_call_log
             ${cursor ? "WHERE (created_at, id) > ($1::timestamptz, $2::uuid)" : ""}
             ORDER BY created_at ASC, id ASC
             LIMIT ${EXPORT_BATCH_SIZE}`,
            cursor ? [cursor.createdAt, cursor.id] : [],
          );
        for (const row of result.rows) yield toRow(row);
        if (result.rows.length < EXPORT_BATCH_SIZE) return;
        const last = result.rows[result.rows.length - 1]!;
        cursor = { createdAt: last.cursor_ts, id: last.id };
      }
    },
  };
}
