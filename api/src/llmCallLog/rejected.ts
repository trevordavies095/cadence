import { randomUUID } from "node:crypto";
import { resolveLlmProvider } from "../settings/sources.js";
import { resolveAppVersion } from "./appVersion.js";
import type { LlmCallOperation, LlmCallRecorder } from "./types.js";

/**
 * Append a `rejected_by_route` child row when a route's own validation refuses
 * a reply the adapter accepted. The parent row is never touched. Best-effort:
 * never throws.
 */
export async function recordRouteRejection(
  recorder: LlmCallRecorder | undefined,
  input: {
    parentCallId: string;
    operation: LlmCallOperation;
    weekSessionId: string | null;
    errorMessage: string;
  },
): Promise<void> {
  if (!recorder) return;
  try {
    const parent = await recorder.get(input.parentCallId).catch(() => null);
    await recorder.record({
      id: randomUUID(),
      operation: input.operation,
      provider: parent?.provider ?? resolveLlmProvider(),
      model: parent?.model ?? null,
      appVersion: parent?.appVersion ?? resolveAppVersion(),
      weekSessionId: parent?.weekSessionId ?? input.weekSessionId,
      parentCallId: input.parentCallId,
      request: null,
      responseRaw: null,
      httpStatus: null,
      latencyMs: null,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      outcome: "rejected_by_route",
      errorMessage: input.errorMessage,
    });
  } catch {
    console.error("[llm-call-log] row dropped");
  }
}
