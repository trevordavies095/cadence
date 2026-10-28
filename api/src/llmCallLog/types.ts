export type LlmCallOperation =
  | "weekly_reply"
  | "mid_week_chat"
  | "dossier_v1"
  | "dossier_correction"
  | "dossier_audit";

export type LlmCallOutcome =
  | "ok"
  | "http_error"
  | "transport_error"
  | "schema_invalid"
  | "rejected_by_route"
  /** Accepted after the validator fixed a soft field; errorMessage says what. */
  | "repaired";

/** One row to append to the LLM call log. */
export type LlmCallRecord = {
  /** Caller-chosen call id (routes generate it before calling the port). */
  id: string;
  operation: LlmCallOperation;
  provider: "anthropic" | "stub";
  model: string | null;
  appVersion: string;
  weekSessionId: string | null;
  parentCallId: string | null;
  /** Messages request body (never headers or the API key). */
  request: unknown | null;
  responseRaw: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** usage.output_tokens_details.thinking_tokens; null when not reported. */
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  outcome: LlmCallOutcome;
  errorMessage: string | null;
};

export type LlmCallRow = LlmCallRecord & { createdAt: string };

/** A list row: everything except the request and raw response bodies. */
export type LlmCallSummary = Omit<LlmCallRow, "request" | "responseRaw">;

export type LlmCallListFilter = {
  weekSessionId?: string;
  operation?: string;
  outcome?: string;
};

export type LlmCallRecorder = {
  /** Append one row. Best-effort: implementations must not throw. */
  record(row: LlmCallRecord): Promise<void>;
  get(id: string): Promise<LlmCallRow | null>;
  /** Summary rows (no bodies), newest first. Filters combine with AND. */
  list(filter: LlmCallListFilter): Promise<LlmCallSummary[]>;
  /** Every full row, oldest first, fetched in batches so the log need not fit in memory. */
  exportAll(): AsyncIterable<LlmCallRow>;
};
