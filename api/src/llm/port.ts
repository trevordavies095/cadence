import type { ModelPacket } from "../packet/types.js";
import type {
  DossierAuditDraft,
  DossierAuditInput,
  DossierCorrectionDraft,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  WeeklyReply,
} from "./types.js";

/** Per-call context the route supplies so the call can be logged and linked. */
export type LlmCallOptions = {
  /** Id the LLM call log row is written under; the route links messages to it. */
  callId?: string;
  /** Validated week session (the packet's own id may be synthetic). */
  weekSessionId?: string | null;
};

/**
 * Domain seam for coach LLM calls.
 * Route / week-loop code calls this port — never Anthropic HTTP directly.
 * Stub for CI (#28); live adapter is #29.
 */
export type LlmPort = {
  /**
   * Produce weekly analysis prose + structured prescribed week (+ optional
   * settings proposal bullets) from a redacted ModelPacket.
   */
  generateWeeklyReply(
    packet: ModelPacket,
    options?: LlmCallOptions,
  ): Promise<WeeklyReply>;

  /**
   * Free-form mid-week chat reply from a redacted lean ModelPacket.
   * When packet.attachments are present, include coaching feedback on those runs (#37).
   * May include prescribedDayPatches for remaining plan days (#38).
   */
  generateMidWeekChatReply(
    packet: ModelPacket,
    options?: LlmCallOptions,
  ): Promise<MidWeekChatReply>;

  /**
   * Onboarding → dossier v1 draft (summary bullets + proposed body).
   * Soft-gated via dossier proposals; Accept installs version 1.
   */
  generateDossierV1(
    input: DossierV1Input,
    options?: LlmCallOptions,
  ): Promise<DossierV1Draft>;

  /**
   * Athlete fix/add request → rewritten dossier soft-gate draft (#18).
   * Soft-gated via dossier proposals; Accept installs a new version.
   */
  generateDossierCorrection(
    input: DossierCorrectionInput,
    options?: LlmCallOptions,
  ): Promise<DossierCorrectionDraft>;

  /**
   * Scheduled or ask-in-chat dossier audit/trim soft-gate draft (#40).
   * Focus: trim/consolidate/rewrite Current Status; never silent-apply.
   */
  generateDossierAudit(
    input: DossierAuditInput,
    options?: LlmCallOptions,
  ): Promise<DossierAuditDraft>;
};

export class LlmSchemaError extends Error {
  readonly code = "llm_schema_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "LlmSchemaError";
  }
}

export class LlmNotConfiguredError extends Error {
  readonly code = "llm_not_configured" as const;

  constructor(message = "Anthropic API key is not configured") {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}

export class LlmHttpError extends Error {
  readonly code = "llm_http_error" as const;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

export class LlmTransportError extends Error {
  readonly code = "llm_transport_error" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmTransportError";
  }
}
