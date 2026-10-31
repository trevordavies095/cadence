/**
 * A weekly reply refused for its shape is asked for once more before the
 * athlete sees a failed read (ADR 0002, "Ask once more for a reply refused for
 * its shape"). Shared by the weekly reply run and the weekly-read replay.
 */
import { LlmSchemaError } from "./port.js";

export const WEEKLY_REPLY_ATTEMPTS = 2;

export type AskResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Calls `ask` up to WEEKLY_REPLY_ATTEMPTS times. An attempt is refused for its
 * shape when it throws LlmSchemaError or returns `{ ok: false }`; a refused
 * attempt is asked once more while attempts remain. Any other error is thrown
 * at once. The last attempt's LlmSchemaError is thrown, and its `{ ok: false }`
 * returned, as they came.
 */
export async function askOnceMore<T>(
  ask: (attempt: number) => Promise<AskResult<T>>,
): Promise<AskResult<T>> {
  let result: AskResult<T> = { ok: false, error: "weekly reply refused" };
  for (let attempt = 1; attempt <= WEEKLY_REPLY_ATTEMPTS; attempt++) {
    try {
      result = await ask(attempt);
    } catch (err) {
      if (err instanceof LlmSchemaError && attempt < WEEKLY_REPLY_ATTEMPTS) continue;
      throw err;
    }
    if (result.ok) break;
  }
  return result;
}
