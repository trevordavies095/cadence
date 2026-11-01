import { SecretProtector } from "../crypto/secretProtector.js";
import { readAnthropicApiKey } from "../settings/anthropicStore.js";
import {
  getSavedCoachModel,
  type SavedCoachSetting,
} from "../settings/coachModelStore.js";
import {
  getSelfHostedConnection,
  readSelfHostedApiKey,
  selfHostedEndpoint,
} from "../settings/selfHostedStore.js";
import { TESTED_COACH_MODEL, type CoachModel } from "./coachModel.js";
import type { AnthropicEffort } from "./effort.js";
import { LlmNotConfiguredError } from "./port.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Who serves a coach call: Anthropic, or the athlete's own model server. */
export type CoachProvider = "anthropic" | "self_hosted";

/** The not-configured message when the provider is self-hosted and no server is saved. */
export const SELF_HOSTED_NOT_CONFIGURED_MESSAGE = "Set up the model server in Settings";

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
  /** Wrapping key for the saved Anthropic and self-hosted keys. Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
  /** Override the saved Anthropic key loader (tests). */
  readApiKey?: () => Promise<string | null>;
  /**
   * Override the model and effort reader (tests). When given, the target is
   * always Anthropic with this pair; the saved provider is not read.
   */
  readCoachModel?: () => Promise<CoachModel>;
  /** Override the Anthropic Messages API URL (tests). */
  messagesUrl?: string;
};

/**
 * A self-hosted target: the saved server's Messages path, its key (or none),
 * and the saved model and effort. No saved server is not configured.
 */
async function selfHostedCoachTarget(
  setting: SavedCoachSetting,
  protector: SecretProtector,
): Promise<CoachTarget> {
  const connection = await getSelfHostedConnection();
  if (!connection.configured || !connection.baseUrl) {
    throw new LlmNotConfiguredError(SELF_HOSTED_NOT_CONFIGURED_MESSAGE);
  }
  return {
    provider: "self_hosted",
    messagesUrl: selfHostedEndpoint(connection.baseUrl, "messages"),
    credentials: {
      apiKey: connection.keyConfigured ? await readSelfHostedApiKey(protector) : null,
    },
    model: setting.model,
    effort: setting.effort,
  };
}

/**
 * The target from saved settings. Provider self-hosted: the saved server and
 * key with the saved model and effort. Otherwise Anthropic: the saved
 * Anthropic key and the saved coach model, else the tested default. Read each
 * time it is called, so a change in Settings applies without a restart.
 */
export function createCoachTargetResolver(
  options?: CoachTargetResolverOptions,
): CoachTargetResolver {
  const protector = () => new SecretProtector(options?.dataProtectionKey);
  const readApiKey = options?.readApiKey ?? (() => readAnthropicApiKey(protector()));
  const readCoachModel = options?.readCoachModel;
  const messagesUrl = options?.messagesUrl?.trim() || ANTHROPIC_MESSAGES_URL;
  return async () => {
    if (readCoachModel) {
      const apiKey = await readApiKey();
      return anthropicCoachTarget(await readCoachModel(), apiKey, messagesUrl);
    }
    const saved = await getSavedCoachModel();
    if (saved?.provider === "self_hosted") {
      return selfHostedCoachTarget(saved, protector());
    }
    const apiKey = await readApiKey();
    return anthropicCoachTarget(saved ?? TESTED_COACH_MODEL, apiKey, messagesUrl);
  };
}
