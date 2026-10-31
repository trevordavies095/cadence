/**
 * Regenerates the replay seasons (coaching-bias ticket 25): three six-week
 * fictional seasons that are not marathon blocks, under
 * tests/fixtures/seasons/.
 *
 *   cd api
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ai_coach_test \
 *     npx tsx scripts/regenerate-replay-seasons.ts
 *
 * For each season script (tests/fixtures/seasons/<n>-<id>.json) it:
 *
 * 1. writes the season's Tempo export (<n>-<id>.zip) with the demo's export
 *    generator (demo/generate-season-export.mjs);
 * 2. plays the season through the app, on the export and the offline stub:
 *    About you and the goal first, then for each week a Sunday-evening check-in
 *    (the season's answers, including any pain score) that starts the weekly
 *    read;
 * 3. keeps the packet each weekly read sent to the model, as
 *    season-packets/<n>-<id>-w<week>.json, for the replay script's --packets.
 *
 * Two stand-ins keep the packets honest without a live model or Tempo. The
 * stub's plan for the next week is replaced with that week's scripted runs, so
 * each recap grades the athlete against a plan they followed, and its About you
 * updates are dropped. And the export,
 * which holds only all-time bests, answers a best-efforts query with `since`
 * the way live Tempo does: the bests set on or after that date, so a new best
 * reaches the recap's Notable section.
 *
 * Needs a database whose name contains "_test": every app table is cleared
 * before each season. Never calls the live model.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { pool } from "../src/db.js";
import type { TrainingGoal } from "../src/goal/types.js";
import { createStubLlmPort } from "../src/llm/stub.js";
import type { LlmPort } from "../src/llm/port.js";
import type { PrescribedDay, PrescribedWeek, RunType } from "../src/llm/types.js";
import { migrate } from "../src/migrate.js";
import type { ModelPacket } from "../src/packet/types.js";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import type { TempoPort } from "../src/tempo/port.js";
import { acceptAndReady, resetAppTables, TEST_DATA_PROTECTION_KEY } from "../tests/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEASONS = path.resolve(here, "../tests/fixtures/seasons");
const PACKETS = path.join(SEASONS, "season-packets");
const GENERATOR = path.resolve(here, "../../demo/generate-season-export.mjs");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = (typeof DAYS)[number];

type Part = { km?: number; m?: number; min?: number; pace: string; repeat?: number; parts?: Part[] };
type SeasonRun = { day: Day; name: string; type: string; parts: Part[] };
type SeasonWeek = {
  runs: SeasonRun[];
  checkIn: { runs: Partial<Record<Day, Record<string, unknown>>>; weekly?: Record<string, unknown> };
};
type Season = {
  id: string;
  athlete: { timezone: string; utcOffsetHours: number };
  weekOneMonday: string;
  goal: TrainingGoal;
  aboutYou: string;
  weeks: SeasonWeek[];
};

const DAY_MS = 86_400_000;

function seasonDate(season: Season, week: number, day: Day): string {
  const ms = Date.parse(`${season.weekOneMonday}T00:00:00Z`) + ((week - 1) * 7 + DAYS.indexOf(day)) * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A local time on a season day, as a UTC instant. */
function localInstant(season: Season, week: number, day: Day, hh: number): Date {
  const local = Date.parse(`${seasonDate(season, week, day)}T00:00:00Z`) + hh * 3_600_000;
  return new Date(local - season.athlete.utcOffsetHours * 3_600_000);
}

const paceS = (pace: string) => {
  const [m, s] = pace.split(":").map(Number);
  return m! * 60 + s!;
};

function flatten(parts: Part[]): Part[] {
  return parts.flatMap((p) => (p.repeat ? Array.from({ length: p.repeat }, () => flatten(p.parts!)).flat() : [p]));
}

const DAY_TYPES: Record<string, RunType> = {
  "Easy Run": "easy",
  Recovery: "easy",
  "Walk-Run": "easy",
  "Long Run": "long",
  Threshold: "quality",
  Intervals: "quality",
  Workout: "quality",
  Hills: "quality",
  Fartlek: "quality",
  Race: "race",
};

/** The plan a week of scripted runs follows: one day per run, rest otherwise. */
function scriptedPlan(season: Season, week: number, isoWeek: string): PrescribedWeek {
  const runs = season.weeks[week - 1]!.runs;
  const days: PrescribedDay[] = DAYS.map((day) => {
    const date = seasonDate(season, week, day);
    const run = runs.find((r) => r.day === day);
    if (!run) return { date, dayType: "rest", run: null };
    const parts = flatten(run.parts);
    const metres = parts.reduce((a, p) => a + (p.km ? p.km * 1000 : p.m ?? ((p.min ?? 0) * 60 * 1000) / paceS(p.pace)), 0);
    const byTime = parts.every((p) => p.min !== undefined);
    const dayType = DAY_TYPES[run.type] ?? "other";
    return {
      date,
      dayType,
      run: {
        type: dayType,
        distanceM: byTime ? 0 : Math.round(metres / 100) * 100,
        ...(byTime ? { durationS: parts.reduce((a, p) => a + p.min! * 60, 0) } : {}),
        structure: dayType === "easy" || dayType === "long" ? null : run.name,
      },
    };
  });
  return { week: isoWeek, days };
}

/** The stub, with its plan swapped for the season's next week, recording each weekly packet. */
function seasonLlmPort(season: Season, sent: ModelPacket[]): LlmPort {
  const stub = createStubLlmPort();
  return {
    ...stub,
    async generateWeeklyReply(packet, options) {
      sent.push(structuredClone(packet));
      // No About you updates: the stub's would pile up in every later packet.
      const { settingsProposalBullets: _bullets, ...reply } = await stub.generateWeeklyReply(packet, options);
      const start = packet.planWeek?.startDate;
      const week = start ? Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${season.weekOneMonday}T00:00:00Z`)) / (7 * DAY_MS)) + 1 : 0;
      if (week >= 1 && week <= season.weeks.length) {
        return { ...reply, prescribedWeek: scriptedPlan(season, week, reply.prescribedWeek.week) };
      }
      return reply;
    },
  };
}

/** The export as of the clock, answering best efforts `since` a date as live Tempo does. */
function seasonTempoPort(zip: string, clock: FixedClock): TempoPort {
  const port = createExportTempoPort({ exportPath: zip, asOf: () => clock.now() });
  return {
    ...port,
    async getBestEfforts(query = {}) {
      const all = await port.getBestEfforts({});
      if (!query.since) return all;
      const since = query.since;
      const now = clock.now().getTime();
      return {
        distances: all.distances.filter(
          (e) => e.workoutDate.slice(0, 10) >= since && Date.parse(e.workoutDate) <= now,
        ),
      };
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

async function playSeason(file: string): Promise<string[]> {
  const season = JSON.parse(readFileSync(path.join(SEASONS, file), "utf8")) as Season;
  const stem = file.replace(/\.json$/, "");
  const zip = path.join(SEASONS, `${stem}.zip`);
  const gen = spawnSync("node", [GENERATOR, "--season", path.join(SEASONS, file), "--out", zip], { stdio: "inherit" });
  if (gen.status !== 0) throw new Error(`export generator failed for ${file}`);

  await resetAppTables();
  await acceptAndReady();
  const sent: ModelPacket[] = [];
  const llmPort = seasonLlmPort(season, sent);
  const appAt = (at: Date) => {
    const clock = new FixedClock(at);
    return createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock,
      athleteTimezone: season.athlete.timezone,
      tempoPort: seasonTempoPort(zip, clock),
      llmPort,
    });
  };

  // Setup, the Monday morning of week 1: the goal, then About you, which
  // already says it (a goal set after About you adds a correction to it).
  const setup = appAt(localInstant(season, 1, "Mon", 6));
  await call(setup, "PUT", "/goal", season.goal);
  await call(setup, "PUT", "/dossier", { body: season.aboutYou });

  const written: string[] = [];
  for (const [i, week] of season.weeks.entries()) {
    const n = i + 1;
    const app = appAt(localInstant(season, n, "Sun", 19));
    const session = await call(app, "POST", "/weeks/current");
    const id = session.id as string;
    await call(app, "GET", `/weeks/${id}/recap`);
    const runs = Object.entries(week.checkIn.runs).map(([day, answers]) => ({
      date: seasonDate(season, n, day as Day),
      ...answers,
    }));
    const before = sent.length;
    await call(app, "POST", `/weeks/${id}/recap/subjective`, { runs, ...(week.checkIn.weekly ? { weekly: week.checkIn.weekly } : {}) });
    await waitForReplyRunsIdle();
    const run = (await call(app, "GET", `/weeks/${id}/reply-run`)).run as { status?: string; errorMessage?: string } | null;
    if (run?.status !== "ok" || sent.length !== before + 1) {
      throw new Error(`${stem} week ${n}: weekly read did not finish (${run?.status}: ${run?.errorMessage ?? ""})`);
    }
    const out = path.join(PACKETS, `${stem}-w${n}.json`);
    writeFileSync(out, `${JSON.stringify(sent.at(-1), null, 2)}\n`);
    written.push(out);
  }
  return written;
}

async function main() {
  await migrate();
  rmSync(PACKETS, { recursive: true, force: true });
  mkdirSync(PACKETS, { recursive: true });
  const files = readdirSync(SEASONS)
    .filter((f) => /^\d+-.+\.json$/.test(f))
    .sort();
  for (const file of files) {
    const written = await playSeason(file);
    console.log(`${file}: ${written.length} packets`);
  }
  await resetAppTables();
}

try {
  await main();
} finally {
  await pool.end();
}
