/**
 * Where the running API gets its runs and its coach (#6). An export zip and the stub
 * model need no saved connection, so they count as connected on Home and Settings.
 */
export type RuntimeSources = {
  /** `export`: TEMPO_EXPORT_PATH is loaded; `connection`: the saved Tempo connection. */
  tempo: "export" | "connection";
  /** `stub`: the offline coach; `anthropic`: the live model, which needs a saved key. */
  model: "stub" | "anthropic";
  /** CADENCE_DEMO=1: the sample season. */
  demo: boolean;
};

/** LLM_PROVIDER: `anthropic` or `live` select the live model; anything else is the stub. */
export function resolveLlmProvider(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSources["model"] {
  const provider = (env.LLM_PROVIDER ?? "stub").trim().toLowerCase();
  return provider === "anthropic" || provider === "live" ? "anthropic" : "stub";
}
