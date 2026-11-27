/**
 * The weekly tidy of About you (src/dossier/weeklyTidy.ts, issue #86): the
 * guard and the switch as pure functions, then the tidy as the weekly reply
 * runs it, against the database with the offline coach.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import {
  hasCoachUpdates,
  tidyHoldReason,
  WEEKLY_TIDY_APPLIED_MESSAGE,
  WEEKLY_TIDY_HELD_MESSAGE,
  weeklyTidyFromEnv,
} from "../src/dossier/weeklyTidy.js";
import { createStubLlmPort, type LlmPort } from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");

const ABOUT = [
  "# About you",
  "",
  "## Goal",
  "Lakeshore Half in March, under two hours.",
  "",
  "## Schedule",
  "You run four days a week, with the long run on Sunday.",
  "",
  "## Current Status",
  "Building back after a week off.",
].join("\n");

const WITH_UPDATES = [
  ABOUT,
  "",
  "## Coach update (Oct 5 – 11)",
  "",
  "- Easy pace is settling near 6:10/km.",
  "",
  "## Coach update (Oct 12 – 18)",
  "",
  "- The calf niggle has cleared.",
  "",
].join("\n");

describe("the weekly tidy's guard and switch", () => {
  it("sees a dated coach update, and nothing to tidy without one", () => {
    expect(hasCoachUpdates(WITH_UPDATES)).toBe(true);
    expect(hasCoachUpdates(ABOUT)).toBe(false);
    expect(hasCoachUpdates("# About you\n\nCoach update in a sentence is not a section.")).toBe(false);
  });

  it("lets a tidy through that keeps every section about the athlete", () => {
    const tidied = `${ABOUT}\nEasy pace near 6:10/km; the calf niggle has cleared.\n\n## Tidy-ups\n- Last tidy-up: Sun Oct 18\n`;
    expect(tidyHoldReason(WITH_UPDATES, tidied)).toBeNull();
    // A heading in another case is the same section.
    expect(tidyHoldReason(WITH_UPDATES, tidied.replace("## Current Status", "## Current status"))).toBeNull();
  });

  it("holds a tidy that drops a section about the athlete, naming it", () => {
    const tidied = ABOUT.replace("## Schedule\nYou run four days a week, with the long run on Sunday.\n\n", "");
    expect(tidyHoldReason(WITH_UPDATES, tidied)).toBe('the tidied text drops "Schedule"');
  });

  it("holds a tidy that cuts the text sharply, or comes back empty", () => {
    const gutted = "# About you\n\n## Goal\nHalf.\n\n## Schedule\nFour days.\n\n## Current Status\nOk.\n";
    expect(tidyHoldReason(WITH_UPDATES, gutted)).toBe(
      "the tidied text is much shorter than the sections about the athlete",
    );
    expect(tidyHoldReason(WITH_UPDATES, "  \n")).toBe("the tidied text is empty");
  });

  it("is on unless ABOUT_YOU_WEEKLY_TIDY turns it off", () => {
    expect(weeklyTidyFromEnv({})).toBe(true);
    expect(weeklyTidyFromEnv({ ABOUT_YOU_WEEKLY_TIDY: "on" })).toBe(true);
    for (const off of ["off", "0", "false", "No"]) {
      expect(weeklyTidyFromEnv({ ABOUT_YOU_WEEKLY_TIDY: off })).toBe(false);
    }
  });
});

type Proposal = { id: number; kind: string; status: string; previousVersionId: number | null };
type Message = { body: string; dossierProposal?: { id: number; kind: string; status: string } | null };

describe("the weekly reply tidies About you before the read (#86)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
    delete process.env.ABOUT_YOU_WEEKLY_TIDY;
  });

  async function weeklyReply(aboutYou: string, llmPort: LlmPort = createStubLlmPort()) {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort,
    });
    const before = (await json(
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: aboutYou }),
      }),
    )) as { id: number };
    const week = await json(await app.request("/weeks/current", { method: "POST" }));
    await unlockPlanCheckIn(app, week.id as string);
    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekSessionId: week.id, recapMarkdown: "## Summary\nSteady aerobic week." }),
    });
    const changes = ((await json(await app.request("/dossier/changes"))).changes ?? []) as Proposal[];
    const waiting = ((await json(await app.request("/dossier/proposals"))).proposals ?? []) as Proposal[];
    const current = (await json(await app.request("/dossier"))).current as { body: string };
    const thread = ((await json(await app.request(`/thread?weekSessionId=${week.id}`))).messages ?? []) as Message[];
    return { status: res.status, before, changes, waiting, body: current.body, thread };
  }

  const updateSections = (body: string) => body.match(/^## Coach update/gm) ?? [];

  it("folds the earlier coach updates in, applies it at once, and leaves only this week's note", async () => {
    const { status, before, changes, waiting, body, thread } = await weeklyReply(WITH_UPDATES);
    expect(status).toBe(200);

    const tidy = changes.find((c) => c.kind === "audit");
    expect(tidy).toMatchObject({ status: "accepted", previousVersionId: before.id });
    expect(waiting).toEqual([]);

    // The two earlier updates are folded in; the read's own note is the one left.
    expect(updateSections(body)).toHaveLength(1);
    expect(body).toContain("Easy pace is settling near 6:10/km.");
    expect(body).toContain("## Goal");

    // The conversation says so, with the tidy's card, before the Sunday message.
    const said = thread.findIndex((m) => m.body === WEEKLY_TIDY_APPLIED_MESSAGE);
    expect(said).toBeGreaterThanOrEqual(0);
    expect(thread[said]!.dossierProposal).toMatchObject({ id: tidy!.id, kind: "audit", status: "accepted" });
    expect(said).toBeLessThan(thread.length - 1);
  });

  it("does nothing when there is no coach update to fold in", async () => {
    const { status, changes, body, thread } = await weeklyReply(ABOUT);
    expect(status).toBe(200);
    expect(changes.filter((c) => c.kind === "audit")).toEqual([]);
    expect(thread.map((m) => m.body)).not.toContain(WEEKLY_TIDY_APPLIED_MESSAGE);
    expect(updateSections(body)).toHaveLength(1);
  });

  it("is switched off by ABOUT_YOU_WEEKLY_TIDY=off", async () => {
    process.env.ABOUT_YOU_WEEKLY_TIDY = "off";
    const { status, changes, body } = await weeklyReply(WITH_UPDATES);
    expect(status).toBe(200);
    expect(changes.filter((c) => c.kind === "audit")).toEqual([]);
    expect(updateSections(body)).toHaveLength(3);
  });

  it("holds a tidy that drops a section for Looks right, and the read goes ahead on the old text", async () => {
    const llmPort: LlmPort = {
      ...createStubLlmPort(),
      generateDossierAudit: async () => ({
        summaryBullets: ["Folded the updates in."],
        proposedBody: "# About you\n\n## Goal\nLakeshore Half in March, under two hours.\n",
      }),
    };
    const { status, changes, waiting, body, thread } = await weeklyReply(WITH_UPDATES, llmPort);
    expect(status).toBe(200);
    expect(changes.filter((c) => c.kind === "audit")).toEqual([]);
    expect(waiting).toMatchObject([{ kind: "audit", status: "pending" }]);
    expect(thread.map((m) => m.body)).toContain(WEEKLY_TIDY_HELD_MESSAGE);
    // Nothing was folded: the two earlier updates and the read's note are all there.
    expect(updateSections(body)).toHaveLength(3);
    expect(body).toContain("## Schedule");
  });

  it("a tidy that fails never stops the read", async () => {
    const llmPort: LlmPort = {
      ...createStubLlmPort(),
      generateDossierAudit: async () => {
        throw new Error("the model did not answer");
      },
    };
    const { status, changes, waiting, body } = await weeklyReply(WITH_UPDATES, llmPort);
    expect(status).toBe(200);
    expect(changes.filter((c) => c.kind === "audit")).toEqual([]);
    expect(waiting).toEqual([]);
    expect(updateSections(body)).toHaveLength(3);
  });
});
