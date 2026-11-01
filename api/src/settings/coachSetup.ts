import { getAnthropicConnection } from "./anthropicStore.js";
import { getSavedCoachModel, type SavedCoachProvider } from "./coachModelStore.js";
import { getSelfHostedConnection } from "./selfHostedStore.js";
import type { RuntimeSources } from "./sources.js";

/** Whether Coach Cade can answer, and which provider the athlete chose. */
export type CoachSetup = {
  provider: SavedCoachProvider;
  configured: boolean;
};

async function savedProvider(): Promise<SavedCoachProvider> {
  return (await getSavedCoachModel())?.provider ?? "anthropic";
}

/**
 * The one rule for "the coach is set up", shared by onboarding, Home and the
 * loop status. The stub (and so the demo) needs nothing saved. The live model
 * needs the saved provider's connection: an Anthropic key for Anthropic, a
 * saved server for self-hosted. No saved choice means Anthropic.
 */
export async function resolveCoachSetup(
  sources: Pick<RuntimeSources, "model">,
): Promise<CoachSetup> {
  const provider = await savedProvider();
  if (sources.model === "stub") return { provider, configured: true };
  const connection =
    provider === "self_hosted"
      ? await getSelfHostedConnection()
      : await getAnthropicConnection();
  return { provider, configured: connection.configured };
}

/**
 * What the athlete reads when the coach is not set up: where to go, naming the
 * provider only where it tells them what to do.
 */
export function coachSetupNudge(provider: SavedCoachProvider): string {
  return provider === "self_hosted"
    ? "Coach Cade isn’t connected yet. Set up your model server in Settings."
    : "Coach Cade isn’t connected yet. Add your Anthropic key in Settings.";
}

/**
 * The body a coach route answers with when the adapter says the coach is not
 * set up. The adapter's own message is technical; this one is for the athlete.
 */
export async function coachNotConfiguredBody(): Promise<{
  error: "llm_not_configured";
  message: string;
}> {
  return { error: "llm_not_configured", message: coachSetupNudge(await savedProvider()) };
}
