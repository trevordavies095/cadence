import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  createStubLlmPort,
  LlmTransportError,
  type LlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import {
  createPendingRun,
  failInterruptedRuns,
  getLatestRun,
} from "../src/replyRun/store.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  settleReplyRun,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const ANSWERS = {
  runs: [{ date: "2026-10-20", rpe: 5, felt: 7 }],
  weekly: { stress_level: "ok" },
};

type App = ReturnType<typeof createApp>;

describe("weekly reply runs (#97)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  async function open(llmPort: LlmPort = createStubLlmPort()) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort,
    });
    // Loop status only reports a run once Tempo and the coach key are set up.
    for (const [route, body] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_reply_run_test_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-reply-run-test-key" }],
    ] as const) {
      const res = await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    return { app, id: week.id as string };
  }

  const finish = (app: App, id: string) =>
    app.request(`/weeks/${id}/recap/subjective`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ANSWERS),
    });

  const skip = (app: App, id: string) =>
    app.request(`/weeks/${id}/recap?skip_subjective=true`);

  /** A stub whose weekly reply waits until released. */
  function gatedLlm() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = createStubLlmPort();
    const port: LlmPort = {
      ...base,
      generateWeeklyReply: async (packet, options) => {
        await gate;
        return base.generateWeeklyReply(packet, options);
      },
    };
    return { port, release };
  }

  /** A stub whose first weekly reply fails at the transport. */
  function flakyLlm() {
    const base = createStubLlmPort();
    let calls = 0;
    const port: LlmPort = {
      ...base,
      generateWeeklyReply: async (packet, options) => {
        calls += 1;
        if (calls === 1) throw new LlmTransportError("upstream went away");
        return base.generateWeeklyReply(packet, options);
      },
    };
    return port;
  }

  it("has no run until the check-in is finished or skipped", async () => {
    const { app, id } = await open();

    expect((await json(await app.request(`/weeks/${id}/reply-run`))).run).toBeNull();

    // Opening the check-in is not finishing it.
    await app.request(`/weeks/${id}/recap`);
    await waitForReplyRunsIdle();
    expect((await json(await app.request(`/weeks/${id}/reply-run`))).run).toBeNull();

    const status = await json(await app.request("/loop-status"));
    expect(status.replyRun).toBeNull();
  });

  it("finishing the check-in starts a run that stores next week's plan and the analysis", async () => {
    const { app, id } = await open();

    const res = await finish(app, id);
    expect(res.status).toBe(201);

    const run = await settleReplyRun(app, id);
    expect(run).toMatchObject({ weekSessionId: id, status: "ok", errorMessage: null });
    expect(typeof run!.llmCallId).toBe("string");
    expect(typeof run!.finishedAt).toBe("string");

    // The plan lands on week N+1; the analysis stays in N's thread.
    const next = await json(await app.request(`/weeks/${id}/prescribed/next`));
    const prescribed = next.prescribed as { plan: { week: string } };
    expect(prescribed.plan.week).toBe("2026-W44");
    const thread = await json(await app.request(`/thread?weekSessionId=${id}`));
    const coach = (thread.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role === "coach",
    );
    expect(coach).toHaveLength(1);
    expect(coach[0]!.llmCallId).toBe(run!.llmCallId);

    const status = await json(await app.request("/loop-status"));
    expect(status.replyRun).toMatchObject({ status: "ok" });
  });

  it("skipping the check-in starts a run, and reading it again does not start another", async () => {
    const { app, id } = await open();

    expect((await skip(app, id)).status).toBe(200);
    const first = await settleReplyRun(app, id);
    expect(first).toMatchObject({ status: "ok" });

    // A refresh of the already-skipped check-in is not a new decision.
    expect((await skip(app, id)).status).toBe(200);
    expect((await app.request(`/weeks/${id}/recap`)).status).toBe(200);
    const second = await settleReplyRun(app, id);
    expect(second!.id).toBe(first!.id);
  });

  it("refuses a second run while one is pending", async () => {
    const { port, release } = gatedLlm();
    const { app, id } = await open(port);

    expect((await finish(app, id)).status).toBe(201);
    const pending = (await json(await app.request(`/weeks/${id}/reply-run`))).run as {
      status: string;
    };
    expect(pending.status).toBe("pending");
    expect(
      (await json(await app.request("/loop-status"))).replyRun,
    ).toMatchObject({ status: "pending" });

    // Another check-in, an explicit plan request and a retry are all refused.
    const again = await finish(app, id);
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe("reply_run_pending");

    const plan = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: id }),
    });
    expect(plan.status).toBe(409);
    expect((await json(plan)).error).toBe("reply_run_pending");

    const retry = await app.request(`/weeks/${id}/reply-run/retry`, {
      method: "POST",
    });
    expect(retry.status).toBe(409);
    expect((await json(retry)).error).toBe("reply_run_pending");

    release();
    expect(await settleReplyRun(app, id)).toMatchObject({ status: "ok" });

    // Once settled, asking again is allowed.
    expect((await finish(app, id)).status).toBe(201);
    await waitForReplyRunsIdle();
  });

  it("captures a failed run in its row, shows it in loop status, and retries it", async () => {
    const { app, id } = await open(flakyLlm());

    expect((await finish(app, id)).status).toBe(201);
    const failed = await settleReplyRun(app, id);
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed!.errorMessage).toContain("upstream went away");
    expect(
      (await json(await app.request("/loop-status"))).replyRun,
    ).toMatchObject({ status: "failed" });

    const retry = await app.request(`/weeks/${id}/reply-run/retry`, {
      method: "POST",
    });
    expect(retry.status).toBe(202);
    const started = (await json(retry)).run as { id: string; status: string };
    expect(started.status).toBe("pending");
    expect(started.id).not.toBe(failed!.id);

    expect(await settleReplyRun(app, id)).toMatchObject({
      id: started.id,
      status: "ok",
    });
  });

  it("only retries a failed run", async () => {
    const { app, id } = await open();

    const none = await app.request(`/weeks/${id}/reply-run/retry`, { method: "POST" });
    expect(none.status).toBe(409);
    expect((await json(none)).error).toBe("reply_run_not_failed");

    expect((await finish(app, id)).status).toBe(201);
    await settleReplyRun(app, id);
    const ok = await app.request(`/weeks/${id}/reply-run/retry`, { method: "POST" });
    expect(ok.status).toBe(409);
    expect((await json(ok)).error).toBe("reply_run_not_failed");
  });

  it("an explicit plan request is recorded as a run too", async () => {
    const { app, id } = await open();
    expect((await skip(app, id)).status).toBe(200);
    const auto = await settleReplyRun(app, id);

    const redo = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: id }),
    });
    expect(redo.status).toBe(200);
    const latest = await settleReplyRun(app, id);
    expect(latest!.id).not.toBe(auto!.id);
    expect(latest).toMatchObject({ status: "ok" });
  });

  it("answers 404 for an unknown week and 403 before the disclaimer", async () => {
    const { app } = await open();
    const unknown = "00000000-0000-4000-8000-000000000999";
    expect((await app.request(`/weeks/${unknown}/reply-run`)).status).toBe(404);
    expect(
      (await app.request(`/weeks/${unknown}/reply-run/retry`, { method: "POST" })).status,
    ).toBe(404);
  });

  it("marks runs orphaned by a restart as failed so they never block the week", async () => {
    const { id } = await open();
    const run = await createPendingRun(new Date(), id);
    expect(run).not.toBeNull();
    expect(await createPendingRun(new Date(), id)).toBeNull();

    expect(await failInterruptedRuns(new Date())).toBe(1);
    expect(await getLatestRun(id)).toMatchObject({
      status: "failed",
      errorMessage: "Interrupted by a restart",
    });
    expect(await createPendingRun(new Date(), id)).not.toBeNull();
  });
});
