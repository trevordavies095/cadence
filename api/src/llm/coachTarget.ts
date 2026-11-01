import { SecretProtector } from "../crypto/secretProtector.js";
import { readAnthropicApiKey } from "../settings/anthropicStore.js";
import { resolveCoachModel, type CoachModel } from "./coachModel.js";
import type { AnthropicEffort } from "./effort.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Who serves a coach call. Only Anthropic for now. */
export type CoachProvider = "anthropic";

/** What a coach call authenticates with. A null key means none is saved. */
export type CoachCredentials = { apiKey: string | null };

/**
 * Everything one coach call is sent to and with: where, as whom, and which
 * model at which effort. Resolved once per call, or once per run for a run
 * that may ask more than once (ADR 0002, ADR 0004).
 */
export type CoachTarget = {
  provider: CoachProvider;
  messagesUrl: string;
  credentials: CoachCredentials;
  model: string;
  effort: AnthropicEffort;
};

/** Resolves the target the next coach call is sent to. */
export type CoachTargetResolver = () => Promise<CoachTarget>;

/**
 * An Anthropic target for a model, effort and key. Tools outside the app (the
 * weekly-read replay) build theirs from flags with this and never read the
 * saved setting.
 */
export function anthropicCoachTarget(
  coachModel: CoachModel,
  apiKey: string | null,
  messagesUrl: string = ANTHROPIC_MESSAGES_URL,
): CoachTarget {
  return {
    provider: "anthropic",
    messagesUrl,
    credentials: { apiKey },
    model: coachModel.model,
    effort: coachModel.effort,
  };
}

export type CoachTargetResolverOptions = {
  /** Wrapping key for the saved Anthropic key. Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
  /** Override the saved-key loader (tests). */
  readApiKey?: () => Promise<string | null>;
  /** Override the saved model and effort reader (tests). Defaults to resolveCoachModel. */
  readCoachModel?: () => Promise<CoachModel>;
  /** Override the Messages API URL (tests). */
  messagesUrl?: string;
};

/**
 * The target from saved settings: the saved Anthropic key and the saved coach
 * model, else the tested default. Read each time it is called, so a change in
 * Settings applies without a restart.
 */
export function createCoachTargetResolver(
  options?: CoachTargetResolverOptions,
): CoachTargetResolver {
  const readApiKey =
    options?.readApiKey ??
    (() => readAnthropicApiKey(new SecretProtector(options?.dataProtectionKey)));
  const readCoachModel = options?.readCoachModel ?? resolveCoachModel;
  const messagesUrl = options?.messagesUrl?.trim() || ANTHROPIC_MESSAGES_URL;
  return async () => {
    const apiKey = await readApiKey();
    return anthropicCoachTarget(await readCoachModel(), apiKey, messagesUrl);
  };
}
