import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { pool } from "../src/db.js";
import { createStubLlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

/** Every on-screen timestamp column (#7). Operational tables stay on real time. */
const ON_SCREEN_COLUMNS: Array<[table: string, columns: string[]]> = [
  ["thread_messages", ["created_at"]],
  ["dossier_versions", ["created_at"]],
  ["dossier_proposals", ["created_at", "resolved_at"]],
  ["dossier_audit_meta", ["updated_at"]],
  ["week_sessions", ["created_at", "archived_at"]],
  ["onboarding_answers", ["created_at", "updated_at"]],
  ["week_subjective_answers", ["created_at", "updated_at"]],
  ["week_recaps", ["created_at", "updated_at"]],
  ["prescribed_weeks", ["created_at", "updated_at"]],
  ["weekly_reply_runs", ["started_at", "finished_at", "seen_at"]],
];

/** Distinct non-null values per table.column, as ISO strings. */
async function stampedValues(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, columns] of ON_SCREEN_COLUMNS) {
    for (const column of columns) {
      const { rows } = await pool.query<{ v: Date }>(
        `SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`,
      );
      out[`${table}.${column}`] = rows.map((r) => r.v.toISOString()).sort();
    }
  }
  return out;
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

describe("on-screen rows are stamped from the app clock (#7)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  function appAt(instant: string) {
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date(instant)),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
  }

  it("a week of coaching under a fixed clock carries only the fixed instant", async () => {
    const NOW = "2026-10-21T15:00:00.000Z";
    await acceptAndReady();
    const app = appAt(NOW);

    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const weekSessionId = week.id as string;

    // About you: onboarding's first draft, rejected, then a direct edit.
    const onboarded = await json(
      await app.request(
        "/onboarding/answers",
        post({
          answers: {
            goal: "Half marathon in April",
            schedule: "Tue/Thu/Sat",
            injuries_constraints: "Left calf tight after hills",
            preferences: "Trails",
          },
          weekSessionId,
        }),
      ),
    );
    const draftId = (onboarded.proposal as { id: number }).id;
    expect((await app.request(`/dossier/proposals/${draftId}/reject`, post())).status).toBe(200);
    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# About you\n\nFive runs a week." }),
    });

    // Chat: a note that applies straight away, then undone.
    const chat = await json(
      await app.request(
        `/weeks/${weekSessionId}/chat`,
        post({ body: "My Achilles flared on the long run, I need to skip Thursday." }),
      ),
    );
    const noteId = (chat.dossierProposal as { id: number }).id;
    expect((await app.request(`/dossier/proposals/${noteId}/undo`, post())).status).toBe(200);

    // Ask-in-chat tidy-up, accepted.
    const audit = await json(
      await app.request(`/weeks/${weekSessionId}/chat`, post({ body: "Please audit my settings." })),
    );
    const auditId = (audit.dossierProposal as { id: number }).id;
    expect((await app.request(`/dossier/proposals/${auditId}/accept`, post())).status).toBe(200);

    // Check-in, the weekly reply it starts, and the athlete seeing it.
    const checkIn = await app.request(
      `/weeks/${weekSessionId}/recap/subjective`,
      post({
        week: "2026-W43",
        runs: [{ date: "2026-10-20", rpe: 5, felt: 7 }],
        weekly: { stress_level: "ok" },
      }),
    );
    expect(checkIn.status).toBeLessThan(300);
    await waitForReplyRunsIdle();
    await app.request(`/weeks/${weekSessionId}/reply-run/seen`, post());

    // What the athlete reads: message times and About you versions.
    const thread = await json(await app.request(`/thread?weekSessionId=${weekSessionId}`));
    const messages = thread.messages as Array<{ createdAt: string }>;
    expect(messages.length).toBeGreaterThan(3);
    for (const m of messages) expect(m.createdAt).toBe(NOW);
    const versions = await json(await app.request("/dossier/versions"));
    for (const v of versions.versions as Array<{ createdAt: string }>) {
      expect(v.createdAt).toBe(NOW);
    }

    // And every on-screen column the flow wrote.
    const stamped = await stampedValues();
    const written = Object.entries(stamped).filter(([, values]) => values.length > 0);
    expect(written.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        "thread_messages.created_at",
        "dossier_versions.created_at",
        "dossier_proposals.resolved_at",
        "dossier_audit_meta.updated_at",
        "onboarding_answers.updated_at",
        "week_subjective_answers.updated_at",
        "week_recaps.updated_at",
        "prescribed_weeks.updated_at",
        "weekly_reply_runs.finished_at",
        "weekly_reply_runs.seen_at",
      ]),
    );
    for (const [key, values] of written) {
      expect({ [key]: values }).toEqual({ [key]: [NOW] });
    }
  });

  it("keeps the conversation in the order it happened when every row shares one instant", async () => {
    await acceptAndReady();
    const app = appAt("2026-10-21T15:00:00.000Z");
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    const notes = ["First run felt fine.", "Second one was hilly.", "Third was easy."];
    for (const body of notes) {
      await app.request(`/weeks/${week.id as string}/chat`, post({ body }));
    }
    const thread = await json(await app.request(`/thread?weekSessionId=${week.id as string}`));
    const messages = thread.messages as Array<{ role: string; body: string }>;
    expect(messages.map((m) => m.role)).toEqual([
      "athlete", "coach", "athlete", "coach", "athlete", "coach",
    ]);
    expect(messages.filter((m) => m.role === "athlete").map((m) => m.body)).toEqual(notes);
  });

  it("follows the clock it is given, not a fixed date", async () => {
    await acceptAndReady();
    const app = appAt("2027-03-03T09:30:00.000Z");
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await app.request(`/weeks/${week.id as string}/chat`, post({ body: "Easy run felt fine." }));
    const stamped = await stampedValues();
    expect(stamped["thread_messages.created_at"]).toEqual(["2027-03-03T09:30:00.000Z"]);
    expect(stamped["week_sessions.created_at"]).toEqual(["2027-03-03T09:30:00.000Z"]);
  });
});
