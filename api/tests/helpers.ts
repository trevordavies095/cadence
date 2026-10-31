import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import { acceptDisclaimer } from "../src/disclaimer/store.js";
import { assertTestDatabaseName } from "./guardTestDatabase.js";
import { pool } from "../src/db.js";
import { saveWeekRecap } from "../src/recap/recapStore.js";
import { saveSubjectiveAnswers } from "../src/recap/subjectiveStore.js";

/** Fixed wrapping key for integration tests (not a production secret). */
export const TEST_DATA_PROTECTION_KEY =
  "dGVzdC1kYXRhLXByb3RlY3Rpb24ta2V5LTMyYiEh"; // base64-ish test material

export async function resetAppTables(): Promise<void> {
  // A background weekly reply from the previous test must not write into this one.
  await waitForReplyRunsIdle();
  // Defense in depth: never delete from a database that is not a test database.
  const { rows } = await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  );
  assertTestDatabaseName(rows[0]?.name ?? "");
  await pool.query(`
    DELETE FROM disclaimer_acceptance;
    DELETE FROM tempo_connection;
    DELETE FROM anthropic_connection;
    DELETE FROM prescribed_weeks;
    DELETE FROM week_recaps;
    DELETE FROM week_subjective_answers;
    DELETE FROM thread_messages;
    DELETE FROM weekly_reply_runs;
    DELETE FROM athlete_preferences;
    DELETE FROM week_sessions;
    DELETE FROM dossier_versions;
    DELETE FROM dossier_proposals;
    DELETE FROM dossier_audit_meta;
    DELETE FROM onboarding_answers;
    DELETE FROM training_goals;
    DELETE FROM last_outbound_packet;
    DELETE FROM llm_call_log;
    DELETE FROM key_derivation_rotation;
  `);
}

export async function acceptAndReady(): Promise<void> {
  await acceptDisclaimer();
}

export async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Unlock POST /week/reply plan hard-gate (#52) for a week session.
 * Writes the same durable state as Skip / finish check-in (#49) so plan-path
 * tests do not need Tempo. Prefer HTTP skip/finish in dedicated gate tests.
 */
export async function unlockPlanCheckIn(
  _app: { request: (input: RequestInfo, init?: RequestInit) => Promise<Response> } | null,
  weekSessionId: string,
  mode: "skip" | "finish" = "skip",
): Promise<void> {
  if (mode === "finish") {
    await saveSubjectiveAnswers(new Date(), weekSessionId, {
      week: "2026-W43",
      runs: [{ date: "2026-10-20", rpe: 5, felt: 7 }],
      weekly: { stress_level: "ok" },
    });
    return;
  }
  await saveWeekRecap({
    at: new Date(),
    weekSessionId,
    markdown: "# Weekly Recap\n\nCheck-in skipped (test unlock).",
    subjective: "skipped",
  });
}

/** A Messages-API-shaped message (what a non-streaming call returns). */
export type FakeAnthropicMessage = {
  id?: string;
  model?: string;
  stop_reason?: string;
  stop_details?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  content: Array<Record<string, unknown>>;
};

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

/**
 * Turn a Messages-API-shaped message into the SSE frames Anthropic streams
 * (message_start, content_block_start/delta/stop per block, message_delta with
 * stop_reason + usage, message_stop). Thinking blocks stream as thinking_delta
 * then signature_delta; tool_use input streams as input_json_delta chunks.
 * When the message has no thinking block one is prepended, as the real API
 * does with adaptive thinking (pass `{ thinking: false }` to suppress).
 */
export function anthropicSseEvents(
  message: FakeAnthropicMessage,
  options: { thinking?: boolean } = {},
): string[] {
  const content = [...message.content];
  if (options.thinking !== false && !content.some((b) => b.type === "thinking")) {
    content.unshift({
      type: "thinking",
      thinking: "Weighing load, recent runs and the athlete's note.",
      signature: "sig_test_fixture",
    });
  }
  const usage = message.usage ?? { input_tokens: 1, output_tokens: 1 };
  const { output_tokens: finalOutput, output_tokens_details, ...usageRest } =
    usage;
  const frames: string[] = [
    sseFrame("message_start", {
      message: {
        id: message.id ?? "msg_test",
        type: "message",
        role: "assistant",
        model: message.model ?? "claude-opus-4-7",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usageRest, output_tokens: 1 },
      },
    }),
    sseFrame("ping", {}),
  ];
  content.forEach((block, index) => {
    if (block.type === "thinking") {
      frames.push(
        sseFrame("content_block_start", {
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
      const text = String(block.thinking ?? "");
      const mid = Math.ceil(text.length / 2);
      for (const part of [text.slice(0, mid), text.slice(mid)]) {
        if (!part) continue;
        frames.push(
          sseFrame("content_block_delta", {
            index,
            delta: { type: "thinking_delta", thinking: part },
          }),
        );
      }
      frames.push(
        sseFrame("content_block_delta", {
          index,
          delta: {
            type: "signature_delta",
            signature: String(block.signature ?? ""),
          },
        }),
      );
    } else if (block.type === "tool_use") {
      frames.push(
        sseFrame("content_block_start", {
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
      );
      const json = JSON.stringify(block.input ?? {});
      for (let i = 0; i < json.length; i += 40) {
        frames.push(
          sseFrame("content_block_delta", {
            index,
            delta: {
              type: "input_json_delta",
              partial_json: json.slice(i, i + 40),
            },
          }),
        );
      }
    } else if (block.type === "text") {
      frames.push(
        sseFrame("content_block_start", {
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      frames.push(
        sseFrame("content_block_delta", {
          index,
          delta: { type: "text_delta", text: String(block.text ?? "") },
        }),
      );
    } else {
      frames.push(
        sseFrame("content_block_start", { index, content_block: block }),
      );
    }
    frames.push(sseFrame("content_block_stop", { index }));
  });
  frames.push(
    sseFrame("message_delta", {
      delta: {
        stop_reason: message.stop_reason ?? "tool_use",
        stop_sequence: null,
        ...(message.stop_details ? { stop_details: message.stop_details } : {}),
      },
      usage: {
        output_tokens: finalOutput ?? 1,
        ...(output_tokens_details ? { output_tokens_details } : {}),
      },
    }),
    sseFrame("message_stop", {}),
  );
  return frames;
}

/**
 * The one fake-Anthropic response for tests: a 200 `text/event-stream` Response
 * streaming `message` (see anthropicSseEvents). HTTP-error fakes stay plain
 * JSON responses because the real API answers non-2xx before streaming.
 */
export function anthropicStreamResponse(
  message: FakeAnthropicMessage,
  options: { thinking?: boolean } = {},
): Response {
  return new Response(anthropicSseEvents(message, options).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Shorthand: a tool_use message calling `toolName` with `input`. */
export function anthropicToolMessage(
  toolName: string,
  input: unknown,
  extra: Partial<FakeAnthropicMessage> = {},
): FakeAnthropicMessage {
  return {
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
    content: [{ type: "tool_use", id: "toolu_test", name: toolName, input }],
  };
}

/** Let any background weekly reply finish, then return the week's latest run. */
export async function settleReplyRun(
  app: { request: (path: string) => Response | Promise<Response> },
  weekSessionId: string,
): Promise<Record<string, unknown> | null> {
  await waitForReplyRunsIdle();
  const res = await app.request(`/weeks/${weekSessionId}/reply-run`);
  const body = (await res.json()) as { run: Record<string, unknown> | null };
  return body.run;
}
