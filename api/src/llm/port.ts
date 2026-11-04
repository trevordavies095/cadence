import type { ModelPacket } from "../packet/types.js";
import type { CoachTarget } from "./coachTarget.js";
import type { CoachingJudgeInput, CoachingJudgement } from "./judge.js";
import type {
  DossierAuditDraft,
  DossierAuditInput,
  DossierCorrectionDraft,
  DossierCorrectionInput,
  DossierV1Draft,
  DossierV1Input,
  MidWeekChatReply,
  PlanDayFix,
  PlanDayFixInput,
  WeeklyReply,
} from "./types.js";

/** Per-call context the route supplies so the call can be logged and linked. */
export type LlmCallOptions = {
  /** Id the LLM call log row is written under; the route links messages to it. */
  callId?: string;
  /** Validated week session (the packet's own id may be synthetic). */
  weekSessionId?: string | null;
  /**
   * Where and with what this call is sent: provider, URL, key, model, effort. A
   * run that may ask more than once passes the target it resolved at the start
   * (from resolveCoachTarget), so a retry never switches model, key or server.
   */
  coachTarget?: CoachTarget;
  /**
   * The call this one follows up, when known: "Add the details" names the
   * Sunday call that wrote the plan. The first attempt's row links to it; a
   * retry's row links to the attempt before it, as always.
   */
  parentCallId?: string | null;
  /**
   * Told after each attempt the live adapter sends (two at most, ADR 0002): the
   * attempt's number, the id its call log row was written under, and the error
   * it ended with (null for the reply returned). The replay harness and the
   * smoke script read the retry through it; the app's routes need not.
   */
  onAttempt?: (report: AttemptReport) => void;
};

/** One attempt of a coach call, as LlmCallOptions.onAttempt hears of it. */
export type AttemptReport = {
  attempt: number;
  /** Id of the attempt's call log row; null when the call was given no callId. */
  callId: string | null;
  /** What the attempt threw; null when its reply was returned. */
  error: unknown;
  /** How the attempt's request was built; set by the live adapter, absent elsewhere. */
  request?: AttemptRequest;
};

/**
 * How an attempt's request was built. The first is the request as built; the
 * second (ADR 0002, `.scratch/plan-as-text/spec.md` "Degradation ladder") is
 * one of:
 * - `fix_lines`: the first reply was accepted with plan lines that did not
 *   parse; the failed dates and reasons go back as an error tool result.
 * - `error_result`: the first reply's tool call was refused; the validator's
 *   message goes back as an error tool result.
 * - `no_tool_call`: the first reply called no tool; a plain "call the tool" turn.
 * - `resend`: the first reply was cut off (output cap, a model refusal, no
 *   message); the original request is sent again unchanged.
 */
export type AttemptRequestKind = "first" | "fix_lines" | "fix_rules" | "error_result" | "no_tool_call" | "resend";

export type AttemptRequest = {
  kind: AttemptRequestKind;
  /** Each message's role and block types, e.g. "assistant: thinking, tool_use", "user: tool_result (error)". */
  turns: string[];
  /** fix_lines: the dates the retry was asked to fix. */
  fixDates?: string[];
  /** fix_lines: the dates the retry fixed, once its reply is read. */
  fixed?: string[];
};

/**
 * Domain seam for coach LLM calls.
 * Route / week-loop code calls this port — never Anthropic HTTP directly.
 * Stub for CI (#28); live adapter is #29.
 */
export type LlmPort = {
  /**
   * The target the next call would be sent to, read from saved settings now.
   * Live adapters only; a port that sends nowhere (the stub) has none.
   */
  resolveCoachTarget?: () => Promise<CoachTarget>;

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
   * May change remaining plan days, written as plan lines and read into days (#38).
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

  /**
   * "Add the details" (plan-as-text ticket 09): one unread plan day sent back
   * with a short prompt (the plan week, the unit, the date, its line and the
   * reason; no packet) for one line for that date. Resolves with the day read
   * from the line; rejects with LlmSchemaError when the line still does not
   * read for that date after the retry.
   */
  generatePlanDayFix(
    input: PlanDayFixInput,
    options?: LlmCallOptions,
  ): Promise<PlanDayFix>;

  /**
   * The coaching judge (coaching-quality 09, src/llm/judge.ts): one draft
   * scored blind against the rubric, as the coach's form scores it. The replay
   * harness calls it and no route does, so a port built for the app may leave
   * it out; the live adapter and the stub have it.
   */
  judgeCoachingDraft?(
    input: CoachingJudgeInput,
    options?: LlmCallOptions,
  ): Promise<CoachingJudgement>;
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
