/**
 * Code version stamped on every LLM call row: APP_VERSION (git SHA from the
 * dev script), then the Docker build's git commit, then `dev`.
 */
export function resolveAppVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.APP_VERSION?.trim() || env.CADENCE_GIT_COMMIT?.trim() || "dev"
  );
}
