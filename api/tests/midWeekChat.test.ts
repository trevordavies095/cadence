import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import {
  createStubLlmPort,
  type LlmPort,
  type MidWeekChatReply,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("mid-week free chat (#35)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("posts athlete message and persists stub coach reply on current week", async () => {
    await acceptAndReady();
    const clock = new FixedClock(new Date("2026-10-21T15:00:00.000Z"));
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock,
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Left Achilles flare — keep easy volume capped.",
      }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    expect(week.isoWeek).toBe("2026-W43");

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Felt heavy on today's easy run — should I cut Thursday?",
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);

    const athlete = body.athleteMessage as Record<string, unknown>;
    const coach = body.coachMessage as Record<string, unknown>;
    expect(athlete.role).toBe("athlete");
    expect(athlete.body).toContain("Felt heavy");
    expect(athlete.weekSessionId).toBe(week.id);
    expect(coach.role).toBe("coach");
    expect(String(coach.body)).toContain("Quick check-in for this week");
    expect(String(coach.body)).not.toContain("2026-W43");
    expect(String(coach.body)).toContain("Felt heavy");
    expect(coach.weekSessionId).toBe(week.id);

    const listed = await json(
      await app.request(`/thread?weekSessionId=${week.id as string}`),
    );
    const messages = listed.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.id).toBe(athlete.id);
    expect(messages[1]!.id).toBe(coach.id);
    expect(messages[1]!.role).toBe("coach");
  });

  it("rejects mid-week chat on a prior (archived) week", async () => {
    await acceptAndReady();

    const week43App = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
    });
    const prior = await json(
      await week43App.request("/weeks/current", { method: "POST" }),
    );
    expect(prior.isoWeek).toBe("2026-W43");

    const week44App = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-26T12:00:00.000Z")),
      llmPort: createStubLlmPort(),
    });
    const current = await json(
      await week44App.request("/weeks/current", { method: "POST" }),
    );
    expect(current.isoWeek).toBe("2026-W44");
    expect(current.id).not.toBe(prior.id);

    const listed = await json(await week44App.request("/weeks"));
    const weeks = listed.weeks as Array<Record<string, unknown>>;
    expect(weeks.find((w) => w.id === prior.id)).toMatchObject({
      archived: true,
    });
    expect(weeks.find((w) => w.id === current.id)).toMatchObject({
      archived: false,
    });

    const blocked = await week44App.request(
      `/weeks/${prior.id as string}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Can I still chat on last week?" }),
      },
    );
    expect(blocked.status).toBe(409);
    const err = await json(blocked);
    expect(err.error).toBe("week_archived");

    const priorThread = await json(
      await week44App.request(
        `/thread?weekSessionId=${prior.id as string}`,
      ),
    );
    expect(priorThread.messages).toEqual([]);

    const allowed = await week44App.request(
      `/weeks/${current.id as string}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Checking in on the new week." }),
      },
    );
    expect(allowed.status).toBe(201);
  });

  it("uses injected LlmPort for mid-week chat", async () => {
    await acceptAndReady();
    let calls = 0;
    const fake: LlmPort = {
      async generateWeeklyReply(packet) {
        return createStubLlmPort().generateWeeklyReply(packet);
      },
      async generateMidWeekChatReply(packet) {
        calls += 1;
        const reply: MidWeekChatReply = {
          body: `Stub heard week ${packet.week?.isoWeek ?? "?"}.`,
        };
        return reply;
      },
      async generateDossierV1(input) {
        return createStubLlmPort().generateDossierV1(input);
      },
      async generateDossierCorrection(input) {
        return createStubLlmPort().generateDossierCorrection(input);
      },
      async generateDossierAudit(input) {
        return createStubLlmPort().generateDossierAudit(input);
      },
    };
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      llmPort: fake,
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );

    const res = await app.request(`/weeks/${week.id as string}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hello coach" }),
    });
    expect(res.status).toBe(201);
    expect(calls).toBe(1);
    const body = await json(res);
    const coach = body.coachMessage as Record<string, unknown>;
    expect(coach.body).toBe("Stub heard week 2026-W43.");
  });

  it("disclaimer gates mid-week chat", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect(
      (
        await app.request(
          "/weeks/00000000-0000-4000-8000-000000000001/chat",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: "nope" }),
          },
        )
      ).status,
    ).toBe(403);
  });
});
