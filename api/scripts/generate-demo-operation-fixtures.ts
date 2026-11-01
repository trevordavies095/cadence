/**
 * Writes the three replay inputs the demo snapshot's call log does not cover
 * (self-hosted ticket 14): a mid-week question with a run attached, an About
 * you correction and an About you tidy-up (audit). They go to
 * tests/fixtures/demo-operations/, and the weekly-read replay replays them
 * beside the snapshot's own calls.
 *
 * Each input is what the app itself sends: the script drives the app's routes
 * against a database holding the demo snapshot, on the demo's Tempo export and
 * the offline stub, and keeps what reached the model port. Rebuild them when a
 * packet or About you input changes:
 *
 *   docker exec ai-coach-postgres psql -U postgres -c "CREATE DATABASE ai_coach_test_demo_ops"
 *   docker exec -i ai-coach-postgres psql -U postgres -q -d ai_coach_test_demo_ops < ../demo/snapshot.sql
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ai_coach_test_demo_ops \
 *     npx tsx scripts/generate-demo-operation-fixtures.ts
 *   docker exec ai-coach-postgres psql -U postgres -c "DROP DATABASE ai_coach_test_demo_ops"
 *
 * The routes write to the database (a thread message, a goal, About you
 * versions), so it refuses a database whose name lacks "_test": load the
 * snapshot into a throwaway one, never the demo's own. The clock is the
 * snapshot's (its "cadence-demo-clock" header line). The snapshot predates the
 * stored goal, so when none is stored the demo athlete's goal from
 * demo/athlete-script.json is added first, as onboarding would have. A
 * rebuild from a fresh load of the same snapshot writes the same bytes.
 *
 * Never calls the live model.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { pool } from "../src/db.js";
import { appendGoal, getCurrentGoal } from "../src/goal/store.js";
import type { TrainingGoal } from "../src/goal/types.js";
import type { LlmPort } from "../src/llm/port.js";
import { createStubLlmPort } from "../src/llm/stub.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import { assertTestDatabaseName, databaseNameFromUrl } from "../tests/guardTestDatabase.js";
import { TEST_DATA_PROTECTION_KEY } from "../tests/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(here, "../../demo");
const OUT = path.resolve(here, "../tests/fixtures/demo-operations");
const ATHLETE_TIMEZONE = "America/New_York";

/** The run attached to the question: Tuesday's easy 6 of the snapshot's current week. */
const ATTACHED_RUN_DATE = "2026-10-13";
const ATTACHED_QUESTION =
  "Attaching Tuesday's easy 6. Was that pace properly easy, and did my heart rate drift in the second half?";
const CORRECTION =
  "One fix: the Thursday hill loop is closed for roadworks until December, so Thursday runs are on the canal path for now.";

function snapshotClock(): Date {
  const head = readFileSync(path.join(DEMO, "snapshot.sql"), "utf8").slice(0, 200);
  const m = /^-- cadence-demo-clock: (\S+)$/m.exec(head);
  if (!m) throw new Error("demo/snapshot.sql has no cadence-demo-clock header");
  return new Date(m[1]!);
}

function demoGoal(): TrainingGoal {
  const script = JSON.parse(readFileSync(path.join(DEMO, "athlete-script.json"), "utf8")) as {
    onboarding: { goal: TrainingGoal };
  };
  return script.onboarding.goal;
}

type Captured = { operation: string; value: unknown };

/** The stub, keeping the input of every call that reaches it. */
function capturingPort(captured: Captured[]): LlmPort {
  const stub = createStubLlmPort();
  return {
    generateWeeklyReply: (packet, options) => {
      captured.push({ operation: "weekly_reply", value: packet });
      return stub.generateWeeklyReply(packet, options);
    },
    generateMidWeekChatReply: (packet, options) => {
      captured.push({ operation: "mid_week_chat", value: packet });
      return stub.generateMidWeekChatReply(packet, options);
    },
    generateDossierV1: (input, options) => {
      captured.push({ operation: "dossier_v1", value: input });
      return stub.generateDossierV1(input, options);
    },
    generateDossierCorrection: (input, options) => {
      captured.push({ operation: "dossier_correction", value: input });
      return stub.generateDossierCorrection(input, options);
    },
    generateDossierAudit: (input, options) => {
      captured.push({ operation: "dossier_audit", value: input });
      return stub.generateDossierAudit(input, options);
    },
  };
}

async function call(app: ReturnType<typeof createApp>, method: string, route: string, body?: unknown) {
  const res = await app.request(route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 400) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(json)}`);
  return json ?? {};
}

/** The one input the step sent to the port, with the operation it was sent as. */
function only(captured: Captured[], from: number, operation: string): unknown {
  const sent = captured.slice(from);
  if (sent.length !== 1 || sent[0]!.operation !== operation) {
    throw new Error(`expected one ${operation} call, got ${sent.map((c) => c.operation).join(", ") || "none"}`);
  }
  return sent[0]!.value;
}

function write(file: string, fixture: Record<string, unknown>): void {
  writeFileSync(path.join(OUT, file), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.join(OUT, file)}`);
}

async function main() {
  assertTestDatabaseName(databaseNameFromUrl(process.env.DATABASE_URL ?? ""));
  await migrate();
  const now = snapshotClock();
  const clock = new FixedClock(now);
  const tempoPort = createExportTempoPort({ exportPath: path.join(DEMO, "tempo-export.zip"), asOf: () => clock.now() });
  const captured: Captured[] = [];
  const app = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock,
    athleteTimezone: ATHLETE_TIMEZONE,
    tempoPort,
    llmPort: capturingPort(captured),
  });

  if (!(await getCurrentGoal())) await appendGoal(now, demoGoal(), "onboarding");
  const goal = (await getCurrentGoal())!.goal;

  const week = await call(app, "POST", "/weeks/current");
  const weekId = week.id as string;

  // 1. A mid-week question with Tuesday's run attached.
  const runs = await tempoPort.listWorkouts({ startDate: ATTACHED_RUN_DATE, endDate: `${ATTACHED_RUN_DATE}T23:59:59Z`, pageSize: 10 });
  const run = runs.items.find((w) => w.startedAt.startsWith(ATTACHED_RUN_DATE));
  if (!run) throw new Error(`no run on ${ATTACHED_RUN_DATE} in the demo export`);
  let from = captured.length;
  await call(app, "POST", `/weeks/${weekId}/chat`, { body: ATTACHED_QUESTION, attachmentWorkoutId: run.id });
  write("01-mid-week-attached-run.json", {
    operation: "mid_week_chat",
    source: `demo snapshot at ${now.toISOString()}: a question with the ${ATTACHED_RUN_DATE} run attached`,
    packet: only(captured, from, "mid_week_chat"),
  });

  // 2. A tidy-up of About you as the snapshot holds it, asked for from the About you page.
  from = captured.length;
  await call(app, "POST", "/dossier/audits", { force: true, weekSessionId: weekId });
  write("02-about-you-audit.json", {
    operation: "dossier_audit",
    source: `demo snapshot at ${now.toISOString()}: a tidy-up of About you`,
    goal,
    input: only(captured, from, "dossier_audit"),
  });

  // 3. A Fix something correction.
  from = captured.length;
  await call(app, "POST", "/dossier/corrections", { body: CORRECTION, weekSessionId: weekId });
  write("03-about-you-correction.json", {
    operation: "dossier_correction",
    source: `demo snapshot at ${now.toISOString()}: a Fix something correction`,
    goal,
    input: only(captured, from, "dossier_correction"),
  });
}

mkdirSync(OUT, { recursive: true });
try {
  await main();
} finally {
  await pool.end();
}
