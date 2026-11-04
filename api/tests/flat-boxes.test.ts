/**
 * No lists on Coach Cade's weekly and mid-week forms (gate flat-form,
 * 2026-11-02): Opus 4.7 broke only in the lists of strings, so flags,
 * notices, About you suggestions and answers are each one string, one item
 * per line. Through the app with a fake model server: the tools sent, how
 * each box's lines are stored, and the transition leniency for a model that
 * still sends the old lists.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FixedClock } from "../src/clock/clock.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import {
  buildStubMidWeekChatReply,
  buildStubMidWeekForm,
  buildStubWeeklyForm,
  buildStubWeeklyReply,
  createAnthropicLlmPort,
} from "../src/llm/index.js";
import { migrate } from "../src/migrate.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { putAnthropicConnection } from "../src/settings/anthropicStore.js";
import { createExportTempoPort } from "../src/tempo/exportZip.js";
import {
  acceptAndReady,
  fakeCoachServer,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
  unlockPlanCheckIn,
} from "./helpers.js";
import { weeklyForm } from "./weeklyForms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ZIP = path.join(__dirname, "fixtures", "tempo-export-mini.zip");
const NOW = new Date("2026-10-21T15:00:00.000Z");
const PLAN_MONDAY = "2026-10-26";
const WEEKLY = "submit_weekly_reply";
const MIDWEEK = "submit_mid_week_chat_reply";
const ONE_QUESTION = "## Questions for coach\n\n1. Is 3:30 still sensible?\n";

function packet(recapMarkdown = "## Summary\nSteady aerobic week."): ModelPacket {
  return buildModelPacket({
    dossier: null,
    recapMarkdown,
    thread: [],
    attachments: [],
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-10-25T23:59:59.999Z",
    },
    coaching: { phase: "base", unitPreference: "imperial" },
  });
}

type Stored = {
  readSections: { flags: unknown[]; answers: unknown[] };
  safetyCallouts: unknown[] | null;
  settingsProposalBullets: string[] | null;
};

async function app(toolName: string, answers: unknown[]) {
  await acceptAndReady();
  await putAnthropicConnection("sk-ant-test", new SecretProtector(TEST_DATA_PROTECTION_KEY));
  const server = fakeCoachServer(toolName, answers);
  const instance = createApp({
    dataProtectionKey: TEST_DATA_PROTECTION_KEY,
    clock: new FixedClock(NOW),
    tempoPort: createExportTempoPort({ exportPath: FIXTURE_ZIP }),
    llmPort: createAnthropicLlmPort({
      fetchImpl: server.fetchImpl,
      recorder: server.recorder,
      dataProtectionKey: TEST_DATA_PROTECTION_KEY,
      apiUrl: "http://fake-anthropic.test/v1/messages",
    }),
  });
  const week = await json(await instance.request("/weeks/current", { method: "POST" }));
  return { ...server, app: instance, weekSessionId: week.id as string };
}

/** One weekly read through the route, against a server answering request n with `answers[n - 1]`. */
async function weekly(answers: unknown[], recapMarkdown?: string) {
  const live = await app(WEEKLY, answers);
  await unlockPlanCheckIn(live.app, live.weekSessionId);
  const res = await live.app.request("/week/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ weekSessionId: live.weekSessionId, packet: packet(recapMarkdown) }),
  });
  const body = await json(res);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const stored = body.prescribed as Stored;
  return { ...live, stored, note: live.rows.at(-1)?.errorMessage ?? null };
}

/** One mid-week reply through the route; About you is on file so suggestions become a note. */
async function midWeek(answer: unknown) {
  const live = await app(MIDWEEK, [answer]);
  await live.app.request("/dossier", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "# About you\n\n## Goal\nA spring marathon." }),
  });
  const res = await live.app.request(`/weeks/${live.weekSessionId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "My calf is sore and I travel Friday." }),
  });
  const body = await json(res);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(201);
  return {
    ...live,
    callouts: (body.coachMessage as { safetyCallouts: unknown[] | null }).safetyCallouts,
    bullets: (body.dossierProposal as { summaryBullets: string[] } | null)?.summaryBullets ?? null,
    note: live.rows.at(-1)?.errorMessage ?? null,
  };
}

/** Every "type" in a JSON schema, at any depth. */
function typesIn(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const own = (schema as { type?: unknown }).type;
  return [
    ...(typeof own === "string" ? [own] : []),
    ...Object.values(schema as Record<string, unknown>).flatMap(typesIn),
  ];
}

const CALLOUT_LINES = [
  "Urgent: Stop and get checked. Chest pain on a run needs a doctor today.",
  "Calf tightness is worth a physio visit. If it gets worse, stop running on it.",
  "Info: Ease the hills.",
];
const STORED_CALLOUTS = [
  { title: "Stop and get checked.", body: "Chest pain on a run needs a doctor today.", severity: "urgent" },
  { title: "Calf tightness is worth a physio visit.", body: "If it gets worse, stop running on it.", severity: "caution" },
  { title: "Ease the hills.", body: "", severity: "info" },
];

beforeAll(async () => {
  process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
  await migrate();
});

beforeEach(async () => {
  await resetAppTables();
  delete process.env.TEMPO_EXPORT_PATH;
});

describe("the tools sent have no lists", () => {
  it("no property of either tool, at any depth, is an array or has maxItems; each says one per line", async () => {
    const w = await weekly([weeklyForm(PLAN_MONDAY)]);
    const m = await midWeek({ body: "Fine." });
    const tools = [
      ...(JSON.parse(w.bodies[0]!) as { tools: Array<{ name: string; input_schema: Record<string, unknown> }> }).tools,
      ...(JSON.parse(m.bodies[0]!) as { tools: Array<{ name: string; input_schema: Record<string, unknown> }> }).tools,
    ];
    expect(tools.map((t) => t.name)).toEqual([WEEKLY, MIDWEEK]);
    for (const tool of tools) {
      expect(typesIn(tool.input_schema), tool.name).not.toContain("array");
      expect(JSON.stringify(tool.input_schema), tool.name).not.toContain("maxItems");
      expect(JSON.stringify(tool.input_schema), tool.name).not.toContain("items");
      const props = tool.input_schema.properties as Record<string, { type: string; description: string }>;
      for (const name of ["flags", "safetyCallouts", "settingsProposalBullets"]) {
        if (!props[name]) continue;
        expect(props[name]!.type, `${tool.name}.${name}`).toBe("string");
        expect(props[name]!.description, `${tool.name}.${name}`).toMatch(/One per line/);
      }
    }
    const weeklyProps = tools[0]!.input_schema.properties as Record<string, { type: string }>;
    expect(weeklyProps.answers!.type).toBe("string");
  });

  it("the prompts ask for these boxes one per line, never as a list", async () => {
    const w = await weekly([weeklyForm(PLAN_MONDAY)]);
    const m = await midWeek({ body: "Fine." });
    for (const raw of [w.bodies[0]!, m.bodies[0]!]) {
      const sent = JSON.parse(raw) as { system: string; messages: Array<{ content: string }> };
      const prompt = `${sent.system}\n${sent.messages[0]!.content}`;
      expect(prompt).toMatch(/Every box is plain text: write [\w, ]*safetyCallouts[\w, ]* one per line, never as a list/);
      expect(prompt).toMatch(/write safetyCallouts, one notice per line/);
      expect(prompt).not.toMatch(/populate (safetyCallouts|settingsProposalBullets)/);
    }
  });
});

describe("each box's lines are stored as today", () => {
  it("weekly: flags split on the first colon, notices by severity word, suggestions without a bullet marker, the answer whole", async () => {
    const answer = "**Yes.** Keep the long run easy.\n\nAnd sleep more.";
    const { stored, note } = await weekly(
      [
        weeklyForm(PLAN_MONDAY, {
          flags: "Sleep: Down to 6.8 hours. Protect it.\nWatch the calf after Sunday\nPace: 8:30/mi: quicker than planned.",
          answers: answer,
          safetyCallouts: CALLOUT_LINES.join("\n"),
          settingsProposalBullets: "- Long runs on Saturdays now.\n* Calf tightness since October.\nPrefers mornings.",
        }),
      ],
      `## Summary\nSteady week.\n\n${ONE_QUESTION}`,
    );
    expect(stored.readSections.flags).toEqual([
      { title: "Sleep", detail: "Down to 6.8 hours. Protect it." },
      { title: "Watch the calf after Sunday", detail: "" },
      { title: "Pace", detail: "8:30/mi: quicker than planned." },
    ]);
    expect(stored.readSections.answers).toEqual([{ question: "Is 3:30 still sensible?", answer }]);
    expect(stored.safetyCallouts).toEqual(STORED_CALLOUTS);
    expect(stored.settingsProposalBullets).toEqual([
      "Long runs on Saturdays now.",
      "Calf tightness since October.",
      "Prefers mornings.",
    ]);
    expect(note).toBeNull();
  });

  it("mid-week: notices and suggestions, one per line", async () => {
    const { callouts, bullets, note } = await midWeek({
      body: "Ease off this week.",
      safetyCallouts: CALLOUT_LINES.join("\n"),
      settingsProposalBullets: "- Travels Fri to Sun this week.\nCalf sore since Tuesday.",
    });
    expect(callouts).toEqual(STORED_CALLOUTS);
    expect(bullets).toEqual(["Travels Fri to Sun this week.", "Calf sore since Tuesday."]);
    expect(note).toBeNull();
  });

  it("splits on an escaped newline (backslash and n) as the plan box does, and drops blank lines", async () => {
    const { stored } = await weekly([
      weeklyForm(PLAN_MONDAY, {
        flags: "Sleep: Protect it.\\nCalf: Watch it.\\n\\n",
        safetyCallouts: `${CALLOUT_LINES[0]}\\n${CALLOUT_LINES[2]}`,
        settingsProposalBullets: "- Long runs on Saturdays.\\r\\n- Prefers mornings.",
      }),
    ]);
    expect(stored.readSections.flags).toEqual([
      { title: "Sleep", detail: "Protect it." },
      { title: "Calf", detail: "Watch it." },
    ]);
    expect(stored.safetyCallouts).toEqual([STORED_CALLOUTS[0], STORED_CALLOUTS[2]]);
    expect(stored.settingsProposalBullets).toEqual(["Long runs on Saturdays.", "Prefers mornings."]);
  });

  it("keeps five flags, drops the rest, and the call log names it", async () => {
    const flags = [1, 2, 3, 4, 5, 6, 7].map((n) => `Flag ${n}: detail ${n}.`).join("\n");
    const { stored, note, rows } = await weekly([weeklyForm(PLAN_MONDAY, { flags })]);
    expect(stored.readSections.flags).toHaveLength(5);
    expect((stored.readSections.flags as Array<{ title: string }>).at(-1)!.title).toBe("Flag 5");
    expect(rows.map((r) => r.outcome)).toEqual(["repaired"]);
    expect(note).toBe("flags had 7 lines: the first 5 kept, 2 dropped");
  });
});

describe("a model that still sends the old shape is not refused", () => {
  it("weekly: lists are joined into lines and noted as repairs", async () => {
    const { stored, note, rows } = await weekly(
      [
        weeklyForm(PLAN_MONDAY, {
          flags: ["Sleep: Down to 6.8 hours.", "Watch the calf"],
          answers: ["Yes.", "Heavy legs are normal."],
          safetyCallouts: CALLOUT_LINES,
          settingsProposalBullets: ["Long runs on Saturdays now."],
        }),
      ],
      `## Summary\nSteady week.\n\n${ONE_QUESTION}`,
    );
    expect(rows.map((r) => r.outcome)).toEqual(["repaired"]);
    expect(stored.readSections.flags).toEqual([
      { title: "Sleep", detail: "Down to 6.8 hours." },
      { title: "Watch the calf", detail: "" },
    ]);
    expect(stored.readSections.answers).toEqual([
      { question: "Is 3:30 still sensible?", answer: "Yes.\n\nHeavy legs are normal." },
    ]);
    expect(stored.safetyCallouts).toEqual(STORED_CALLOUTS);
    expect(stored.settingsProposalBullets).toEqual(["Long runs on Saturdays now."]);
    expect(note!.split("; ").sort()).toEqual(
      [
        "flags sent as a list of 2, read as lines",
        "answers sent as a list of 2, read as lines",
        "safetyCallouts sent as a list of 3, read as lines",
        "settingsProposalBullets sent as a list of 1, read as lines",
      ].sort(),
    );
  });

  it("mid-week: lists are joined into lines and noted as repairs", async () => {
    const { callouts, bullets, note, rows } = await midWeek({
      body: "Ease off.",
      safetyCallouts: CALLOUT_LINES,
      settingsProposalBullets: ["Travels Fri to Sun this week."],
    });
    expect(rows.map((r) => r.outcome)).toEqual(["repaired"]);
    expect(callouts).toEqual(STORED_CALLOUTS);
    expect(bullets).toEqual(["Travels Fri to Sun this week."]);
    expect(note!.split("; ").sort()).toEqual([
      "safetyCallouts sent as a list of 3, read as lines",
      "settingsProposalBullets sent as a list of 1, read as lines",
    ]);
  });

  it("reads null as absent, with no note, on both forms", async () => {
    const nulls = { flags: null, answers: null, safetyCallouts: null, settingsProposalBullets: null };
    const w = await weekly([weeklyForm(PLAN_MONDAY, nulls)]);
    expect(w.rows.map((r) => r.outcome)).toEqual(["ok"]);
    expect(w.stored.readSections).toMatchObject({ flags: [], answers: [] });
    expect(w.stored.safetyCallouts).toBeNull();
    expect(w.stored.settingsProposalBullets).toBeNull();

    await resetAppTables();
    const m = await midWeek({ body: "Fine.", safetyCallouts: null, settingsProposalBullets: null });
    expect(m.rows.map((r) => r.outcome)).toEqual(["ok"]);
    expect(m.callouts ?? []).toEqual([]);
    expect(m.bullets).toBeNull();
  });
});

describe("the gate's markup failure is still refused, and the retry handles it", () => {
  it("tool-call markup in flags, items spilled into top-level keys and no plan: refused once, the retry's reply stored", async () => {
    const good = weeklyForm(PLAN_MONDAY);
    const broken = {
      headline: good.headline,
      flags: '\n<parameter name="0">Workload spike: three runs in two days.',
      "1": "Sleep: down to 6.8 hours.",
      "2": "Calf: watch it.",
      analysis: good.analysis,
    };
    const { stored, rows, bodies } = await weekly([broken, good]);
    expect(bodies).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(["schema_invalid", "ok"]);
    expect(rows[0]!.errorMessage).toMatch(/^flags contains tool-call markup/);
    expect(stored.readSections.flags).toEqual([
      { title: "Heart rate drift", detail: "Watch it on the easy days." },
    ]);
  });
});

describe("the offline coach writes the new forms", () => {
  /** A packet with About you on file, a sore Achilles in the latest note, a check-in question and a plan to change. */
  function stubPacket(): ModelPacket {
    return buildModelPacket({
      dossier: { versionId: 1, body: "# About you\n\nRight Achilles niggle in September." },
      recapMarkdown: `## Summary\nSteady week.\n\n${ONE_QUESTION}`,
      thread: [{ role: "athlete", body: "My Achilles is sore, can we cut Thursday?" }],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
      },
      coaching: { phase: "base", unitPreference: "imperial" },
    });
  }

  it("sends every box as a string, never a list", () => {
    const weeklyForm = buildStubWeeklyForm(stubPacket());
    const midWeekForm = buildStubMidWeekForm(stubPacket());
    for (const form of [weeklyForm, midWeekForm] as Array<Record<string, unknown>>) {
      for (const [name, value] of Object.entries(form)) {
        expect(Array.isArray(value), name).toBe(false);
      }
    }
    expect(typeof weeklyForm.flags).toBe("string");
    expect(typeof weeklyForm.answers).toBe("string");
    expect(typeof weeklyForm.safetyCallouts).toBe("string");
    expect(typeof weeklyForm.settingsProposalBullets).toBe("string");
    expect(typeof midWeekForm.safetyCallouts).toBe("string");
    expect(typeof midWeekForm.settingsProposalBullets).toBe("string");
  });

  it("its lines are stored as the list form stored them", () => {
    const weekly = buildStubWeeklyReply(stubPacket());
    expect(weekly.flags).toEqual(STUB_STORED.weekly.flags);
    expect(weekly.safetyCallouts).toEqual(STUB_STORED.weekly.safetyCallouts);
    expect(weekly.settingsProposalBullets).toEqual(STUB_STORED.weekly.settingsProposalBullets);
    expect(weekly.answers).toEqual([
      {
        question: "Is 3:30 still sensible?",
        answer:
          "Keep the week as planned and treat rest days as real rest. Ask me again during the week if it still feels off.",
      },
    ]);
    const mid = buildStubMidWeekChatReply(stubPacket());
    expect(mid.safetyCallouts).toEqual(STUB_STORED.midWeek.safetyCallouts);
    expect(mid.settingsProposalBullets).toEqual(STUB_STORED.midWeek.settingsProposalBullets);
  });
});

/** What the stub's list form stored for stubPacket() at 20989f2, before the boxes became text. */
const STUB_CALLOUT = {
  title: "See a professional.",
  body: "Your notes mention a concern that may be outside running coaching. This coach does not diagnose. If pain persists, worsens, or limits daily life, check in with a qualified clinician or physical therapist. Training stays conservative until then.",
  severity: "caution",
};
const STUB_STORED = {
  weekly: {
    flags: [
      { title: "Soft-tissue concern", detail: "Your profile mentions one. Cap quality and keep volume honest." },
      { title: "No runs attached", detail: "I am working from your profile and weekly report only." },
    ],
    safetyCallouts: [STUB_CALLOUT],
    settingsProposalBullets: ["Add how this week felt and any lingering niggles to what Coach Cade knows about you."],
  },
  midWeek: {
    safetyCallouts: [STUB_CALLOUT],
    settingsProposalBullets: ["You told me: My Achilles is sore, can we cut Thursday?"],
  },
};
