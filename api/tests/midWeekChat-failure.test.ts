import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  createStubLlmPort,
  LlmHttpError,
  LlmSchemaError,
  LlmTransportError,
  type LlmPort,
  type MidWeekChatReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import type { ModelPacket } from "../src/packet/index.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

/** What the next model call does: answer, return junk, or throw. */
type Next = (() => Promise<MidWeekChatReply>) | null;

describe("a failed chat reply takes the athlete's message with it (#5)", () => {
  let next: Next = null;

  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    next = null;
  });

  async function setup() {
    await acceptAndReady();
    const stub = createStubLlmPort();
    const llmPort: LlmPort = {
      ...stub,
      generateMidWeekChatReply: (packet: ModelPacket, options) =>
        next ? next() : stub.generateMidWeekChatReply(packet, options),
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, weekSessionId: week.id as string };
  }

  function send(app: ReturnType<typeof createApp>, weekSessionId: string, body: string) {
    return app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  async function roles(app: ReturnType<typeof createApp>, weekSessionId: string) {
    const listed = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    return (listed.messages as Array<{ role: string }>).map((m) => m.role);
  }

  it.each([
    ["the adapter rejects the reply", () => Promise.reject(new LlmSchemaError("bad")), 502],
    ["the model returns HTTP 529", () => Promise.reject(new LlmHttpError(529, "overloaded")), 502],
    ["the connection to the model fails", () => Promise.reject(new LlmTransportError("timeout")), 502],
    ["the route rejects an empty body", async () => ({ body: "   " }), 502],
    ["something unexpected throws", () => Promise.reject(new Error("boom")), 500],
  ] as const)("leaves no message when %s", async (_label, fail, status) => {
    const { app, weekSessionId } = await setup();
    next = fail;
    const res = await send(app, weekSessionId, "My Achilles twinged today.");
    expect(res.status).toBe(status);
    expect(await roles(app, weekSessionId)).toEqual([]);
  });

  it("a resend after a failure leaves one message and one answer", async () => {
    const { app, weekSessionId } = await setup();
    next = () => Promise.reject(new LlmSchemaError("bad"));
    expect((await send(app, weekSessionId, "Should I skip Thursday?")).status).toBe(502);

    next = null;
    expect((await send(app, weekSessionId, "Should I skip Thursday?")).status).toBe(201);
    expect(await roles(app, weekSessionId)).toEqual(["athlete", "coach"]);
  });

  it("keeps earlier answered messages when a later reply fails", async () => {
    const { app, weekSessionId } = await setup();
    expect((await send(app, weekSessionId, "Easy run felt fine.")).status).toBe(201);
    next = () => Promise.reject(new LlmSchemaError("bad"));
    expect((await send(app, weekSessionId, "And tomorrow?")).status).toBe(502);
    expect(await roles(app, weekSessionId)).toEqual(["athlete", "coach"]);
  });

  it("leaves no message when an audit is asked for before a dossier exists", async () => {
    const { app, weekSessionId } = await setup();
    const res = await send(app, weekSessionId, "Please audit my settings.");
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe("dossier_required");
    expect(body).not.toHaveProperty("athleteMessage");
    expect(await roles(app, weekSessionId)).toEqual([]);
  });
});
