import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock/clock.js";
import { createApp } from "../src/app.js";
import { DISCLAIMER_TEXT } from "../src/disclaimer/text.js";
import {
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  COACH_SYSTEM_STANCE,
  createStubLlmPort,
  fitSafetyCalloutBody,
  MAX_SAFETY_CALLOUT_BODY,
  MAX_SAFETY_CALLOUT_BODY_HARD,
  MAX_SAFETY_CALLOUT_TITLE,
  MIDWEEK_SYSTEM_PROMPT,
  SAFETY_CALLOUT_PROMPT,
  SAFETY_ESCALATION_LINE,
  validateMidWeekChatReply,
  validateSafetyCallouts,
  validateWeeklyReply,
  WEEKLY_SYSTEM_PROMPT,
  type SafetyCallout,
  type WeeklyReply,
} from "../src/llm/index.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { PRIVACY_COPY } from "../src/privacy/copy.js";
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

const WEEK_START = "2026-10-19";
const ISO_WEEK = "2026-W43";
// The weekly reply plans the week AFTER the reviewed week (N+1).
const PLAN_WEEK_START = "2026-10-26";
const PLAN_ISO_WEEK = "2026-W44";
const RED_FLAG_NOTE =
  "Chronic left Achilles flare after long downhill — keep easy volume capped.";

function samplePacket(overrides?: Partial<ModelPacket>): ModelPacket {
  return buildModelPacket({
    dossier: {
      versionId: 1,
      body: RED_FLAG_NOTE,
    },
    recapMarkdown:
      "## Summary\n42 mi, solid aerobic week. Long run felt controlled.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: ISO_WEEK,
      start: `${WEEK_START}T00:00:00.000Z`,
      end: "2026-10-25T23:59:59.999Z",
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
    ...overrides,
  });
}

describe("safety callouts + non-diagnose prompt (#32)", () => {
  it("system prompts include non-diagnose + escalate language", () => {
    for (const text of [
      COACH_SYSTEM_STANCE,
      SAFETY_CALLOUT_PROMPT,
      WEEKLY_SYSTEM_PROMPT,
      MIDWEEK_SYSTEM_PROMPT,
    ]) {
      expect(text.toLowerCase()).toMatch(
        /do not diagnose|not diagnose|never diagnose/,
      );
      expect(text.toLowerCase()).toMatch(
        /qualified professional|seek a qualified|escalate/,
      );
    }
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/safetyCallouts/);
    expect(MIDWEEK_SYSTEM_PROMPT).toMatch(/safetyCallouts/);
  });

  it("disclaimer and privacy copy stay consistent with non-diagnose stance", () => {
    expect(DISCLAIMER_TEXT.toLowerCase()).toMatch(/not medical advice/);
    expect(DISCLAIMER_TEXT.toLowerCase()).toMatch(/not to diagnose/);
    expect(DISCLAIMER_TEXT.toLowerCase()).toMatch(/escalate|qualified professional/);
    expect(PRIVACY_COPY.disclosure.toLowerCase()).toMatch(/not to diagnose/);
    expect(PRIVACY_COPY.disclosure.toLowerCase()).toMatch(
      /escalate|qualified professional/,
    );
  });

  it("schema accepts optional safety callouts and rejects bad shapes", () => {
    const ok = validateSafetyCallouts([
      {
        title: "See a professional",
        body: "This coach does not diagnose — seek a clinician if pain worsens.",
        severity: "caution",
      },
    ]);
    expect(ok.ok).toBe(true);

    const missing = validateSafetyCallouts([{ title: "x" }]);
    expect(missing.ok).toBe(false);

    const badSeverity = validateSafetyCallouts([
      { title: "x", body: "y", severity: "critical" },
    ]);
    expect(badSeverity.ok).toBe(false);
  });

  it("keeps a body over the target but under the ceiling, with a note (#4)", () => {
    const body = `${"Ease off and walk if it twinges. ".repeat(25)}See a physio.`;
    expect(body.length).toBeGreaterThan(MAX_SAFETY_CALLOUT_BODY);
    expect(body.length).toBeLessThanOrEqual(MAX_SAFETY_CALLOUT_BODY_HARD);
    const checked = validateSafetyCallouts([{ title: "Achilles", body }]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value![0]!.body).toBe(body);
    expect(checked.repairs).toEqual([
      `safetyCallouts[0].body over target: ${body.length} chars kept`,
    ]);
  });

  it("cuts a body over the ceiling at a sentence and keeps an escalation line (#4)", () => {
    const body =
      "See a physio before your next run. " +
      "Keep the next few days easy and flat. ".repeat(60);
    expect(body.length).toBeGreaterThan(MAX_SAFETY_CALLOUT_BODY_HARD);
    const checked = validateSafetyCallouts([{ title: "Achilles", body }]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const kept = checked.value![0]!.body;
    expect(kept.length).toBeLessThanOrEqual(MAX_SAFETY_CALLOUT_BODY_HARD);
    expect(kept.startsWith("See a physio before your next run.")).toBe(true);
    expect(kept.endsWith("flat.")).toBe(true);
    expect(kept).not.toContain(SAFETY_ESCALATION_LINE);
    expect(checked.repairs).toEqual([
      `safetyCallouts[0].body cut from ${body.trim().length} to ${kept.length} chars`,
    ]);
  });

  it("adds the escalation line when the cut drops it (#4)", () => {
    const body =
      "Keep the next few days easy and flat. ".repeat(60) +
      "If it gets sharper, see a clinician.";
    const checked = validateSafetyCallouts([{ title: "Achilles", body }]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const kept = checked.value![0]!.body;
    expect(kept.length).toBeLessThanOrEqual(MAX_SAFETY_CALLOUT_BODY_HARD);
    expect(kept.endsWith(`flat. ${SAFETY_ESCALATION_LINE}`)).toBe(true);
    expect(checked.repairs![0]).toMatch(/, escalation line added$/);
  });

  it("cuts a body with no sentence end at a word (#4)", () => {
    const kept = fitSafetyCalloutBody("easy ".repeat(400).trim(), 100);
    expect(kept.length).toBeLessThanOrEqual(100);
    expect(kept).toMatch(/easy… If it gets worse/);
    expect(kept.endsWith(SAFETY_ESCALATION_LINE)).toBe(true);
  });

  it("cuts a long title at a word with a note (#4)", () => {
    const title = "Achilles ".repeat(30).trim();
    const checked = validateSafetyCallouts([{ title, body: "See a physio." }]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const kept = checked.value![0]!.title;
    expect(kept.length).toBeLessThanOrEqual(MAX_SAFETY_CALLOUT_TITLE);
    expect(kept.endsWith("Achilles…")).toBe(true);
    expect(checked.repairs).toEqual([
      `safetyCallouts[0].title cut from ${title.length} to ${kept.length} chars`,
    ]);
  });

  it("weekly and mid-week replies carry the callout repairs up (#4)", () => {
    const long = "Keep it easy. ".repeat(100);
    const weekly = validateWeeklyReply(
      {
        ...buildStubWeeklyReply(samplePacket()),
        safetyCallouts: [{ title: "Achilles", body: long }],
      },
      PLAN_WEEK_START,
    );
    expect(weekly.ok).toBe(true);
    if (weekly.ok) expect(weekly.repairs).toHaveLength(1);

    const mid = validateMidWeekChatReply({
      body: "Easy week.",
      safetyCallouts: [{ title: "Achilles", body: long }],
    });
    expect(mid.ok).toBe(true);
    if (mid.ok) expect(mid.repairs).toHaveLength(1);

    const clean = validateMidWeekChatReply({ body: "Easy week." });
    expect(clean.ok && clean.repairs).toBeUndefined();
  });

  it("stub emits a callout when dossier notes a soft-tissue concern", async () => {
    const port = createStubLlmPort();
    const reply = await port.generateWeeklyReply(samplePacket());
    expect(reply.safetyCallouts?.length).toBeGreaterThan(0);
    expect(reply.safetyCallouts![0]!.title).toMatch(/professional/i);
    expect(reply.safetyCallouts![0]!.body.toLowerCase()).toMatch(
      /does not diagnose/,
    );

    const checked = validateWeeklyReply(reply, PLAN_WEEK_START);
    expect(checked.ok).toBe(true);

    const mid = buildStubMidWeekChatReply(samplePacket());
    expect(mid.safetyCallouts?.length).toBeGreaterThan(0);
    expect(validateMidWeekChatReply(mid).ok).toBe(true);
  });

  it("stub omits callouts when no red-flag language is present", () => {
    const reply = buildStubWeeklyReply(
      samplePacket({
        dossier: { versionId: 1, body: "Healthy base block; no niggles." },
        thread: [],
        recapMarkdown: "## Summary\nEasy aerobic week.",
      }),
    );
    expect(reply.safetyCallouts).toBeUndefined();
  });
});

describe("POST /week/reply surfaces safety callouts (#32)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("stub callout appears on API reply, prescribed record, thread artifact, and coach message", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: RED_FLAG_NOTE }),
    });

    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;
    await unlockPlanCheckIn(app, weekSessionId);

    const res = await app.request("/week/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        weekSessionId,
        recapMarkdown: "## Summary\nSteady aerobic volume.",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const reply = body.reply as WeeklyReply;
    expect(reply.safetyCallouts?.length).toBeGreaterThan(0);

    const prescribed = body.prescribed as {
      safetyCallouts: SafetyCallout[] | null;
    };
    expect(prescribed.safetyCallouts?.length).toBeGreaterThan(0);

    const artifact = body.threadArtifact as {
      kind: string;
      safetyCallouts: SafetyCallout[];
    };
    expect(artifact.kind).toBe("prescribed_week");
    expect(artifact.safetyCallouts.length).toBeGreaterThan(0);

    // Callouts travel as structured data; the message text is never prefixed.
    const coachMessage = body.coachMessage as {
      body: string;
      safetyCallouts: SafetyCallout[];
    };
    expect(coachMessage.body).not.toContain("⚠");
    expect(coachMessage.body).not.toMatch(/Safety \(/);
    expect(coachMessage.safetyCallouts.length).toBeGreaterThan(0);
    expect(coachMessage.safetyCallouts[0]!.body.toLowerCase()).toMatch(
      /does not diagnose/,
    );

    const planSessionId = (body.prescribed as { weekSessionId: string })
      .weekSessionId;
    const threadRes = await app.request(
      `/thread?weekSessionId=${encodeURIComponent(planSessionId)}`,
    );
    expect(threadRes.status).toBe(200);
    const threadBody = await json(threadRes);
    const artifacts = threadBody.artifacts as Array<{
      kind: string;
      safetyCallouts: SafetyCallout[];
    }>;
    const prescribedArtifact = artifacts.find((a) => a.kind === "prescribed_week");
    expect(prescribedArtifact!.safetyCallouts.length).toBeGreaterThan(0);
  });
});

describe("mid-week chat surfaces safety callouts as structured data (#95)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    delete process.env.TEMPO_EXPORT_PATH;
  });

  it("returns callouts structured, stores them on the message, and never prefixes the text", async () => {
    await acceptAndReady();
    const app = createApp({
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      clock: new FixedClock(new Date("2026-10-21T15:00:00.000Z")),
      tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
      llmPort: createStubLlmPort(),
    });
    const week = await json(
      await app.request("/weeks/current", { method: "POST" }),
    );
    const weekSessionId = week.id as string;

    // "doctor" is a red flag for the stub but not a memory-update trigger.
    const res = await app.request(`/weeks/${weekSessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Saw my doctor today about a sprain." }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);

    const coach = body.coachMessage as {
      body: string;
      safetyCallouts: SafetyCallout[];
    };
    expect(coach.body).not.toContain("⚠");
    expect(coach.body).not.toMatch(/Safety \(/);
    expect(coach.safetyCallouts.length).toBe(1);
    expect(coach.safetyCallouts[0]!.title).toBe("See a professional");
    expect((body.safetyCallouts as SafetyCallout[]).length).toBe(1);

    // A later read of the thread still carries them.
    const thread = await json(
      await app.request(`/thread?weekSessionId=${weekSessionId}`),
    );
    const messages = thread.messages as Array<{
      role: string;
      safetyCallouts: SafetyCallout[];
    }>;
    const stored = messages.find((m) => m.role === "coach")!;
    expect(stored.safetyCallouts.length).toBe(1);
    const athlete = messages.find((m) => m.role === "athlete")!;
    expect(athlete.safetyCallouts).toEqual([]);
  });
});
