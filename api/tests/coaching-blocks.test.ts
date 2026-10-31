import { describe, expect, it, vi } from "vitest";
import type { TrainingGoal } from "../src/goal/types.js";
import {
  MIDWEEK_SYSTEM_PROMPT,
  WEEKLY_SYSTEM_PROMPT,
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  createAnthropicLlmPort,
} from "../src/llm/index.js";
import { packetCoaching } from "../src/packet/assemble.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import { anthropicStreamResponse, anthropicToolMessage } from "./helpers.js";

const WEEK_START = "2026-10-19";
const PLAN_WEEK_START = "2026-10-26";

function packetFor(goal: TrainingGoal | null, coachingMonday = PLAN_WEEK_START): ModelPacket {
  return buildModelPacket({
    dossier: { versionId: 1, body: "You run five days a week." },
    recapMarkdown: "## Summary\nSteady week.",
    thread: [],
    attachments: [],
    week: {
      isoWeek: "2026-W43",
      start: `${WEEK_START}T00:00:00.000Z`,
      end: "2026-10-25T23:59:59.999Z",
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
    goal,
    coaching: packetCoaching(goal, coachingMonday),
  });
}

/** Sends packets to a fake model and keeps the system prompt of each request. */
function capture() {
  let reply: unknown = null;
  const systems: string[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      system: string;
      tools: Array<{ name: string }>;
    };
    systems.push(body.system);
    return anthropicStreamResponse(anthropicToolMessage(body.tools[0]!.name, reply));
  }) as unknown as typeof globalThis.fetch;
  const port = createAnthropicLlmPort({ fetchImpl, readApiKey: async () => "sk-ant-test" });
  return {
    async weekly(packet: ModelPacket): Promise<string> {
      reply = buildStubWeeklyReply(packet);
      await port.generateWeeklyReply(packet);
      return systems.at(-1)!;
    },
    async conversation(packet: ModelPacket): Promise<string> {
      reply = buildStubMidWeekChatReply(packet);
      await port.generateMidWeekChatReply(packet);
      return systems.at(-1)!;
    },
  };
}

const RACE = /Coaching method for a race goal:/;
const SPEED = /Coaching method for getting faster:/;
const FITNESS = /Coaching method for general fitness:/;
const RETURN = /Coaching method for a return to running:/;
const ANY_BLOCK = /Coaching method for/g;
const HALF_LONG_RUN = /toward 90 minutes to 2 hours/;
const MARATHON_LONG_RUN = /medium-long run/;

const GOALS: Array<[string, TrainingGoal, RegExp]> = [
  ["race", { kind: "race", distance: "10k", raceDate: "2027-03-21" }, RACE],
  ["speed", { kind: "speed", distance: "5k", target: "sub 20:00" }, SPEED],
  ["fitness", { kind: "fitness" }, FITNESS],
  ["return", { kind: "return", since: "2026-09-28" }, RETURN],
];

describe("Coach Cade's method by goal (coaching-bias 26)", () => {
  it.each(GOALS)("%s: the weekly read carries that block and no other", async (_kind, goal, block) => {
    const system = await capture().weekly(packetFor(goal));
    expect(system).toMatch(block);
    expect(system.match(ANY_BLOCK)).toHaveLength(1);
  });

  it.each(GOALS)("%s: the conversation carries the same block", async (_kind, goal, block) => {
    const system = await capture().conversation(packetFor(goal, WEEK_START));
    expect(system).toMatch(block);
    expect(system.match(ANY_BLOCK)).toHaveLength(1);
  });

  it("no goal: neither prompt carries a block, and both are the plain prompts", async () => {
    const cap = capture();
    const weekly = await cap.weekly(packetFor(null));
    const conversation = await cap.conversation(packetFor(null, WEEK_START));
    expect(weekly).not.toMatch(ANY_BLOCK);
    expect(conversation).not.toMatch(ANY_BLOCK);
    expect(weekly).toBe(WEEKLY_SYSTEM_PROMPT);
    expect(conversation).toBe(MIDWEEK_SYSTEM_PROMPT);
  });

  it("the block sits between the shape rules and the safety rules", async () => {
    const cap = capture();
    const weekly = await cap.weekly(packetFor({ kind: "fitness" }));
    expect(weekly.indexOf("The analysis holds your reasoning.")).toBeLessThan(weekly.search(FITNESS));
    expect(weekly.search(FITNESS)).toBeLessThan(weekly.indexOf("Safety callouts:"));
    const chat = await cap.conversation(packetFor({ kind: "fitness" }, WEEK_START));
    expect(chat.indexOf("No sign-off.")).toBeLessThan(chat.search(FITNESS));
    expect(chat.search(FITNESS)).toBeLessThan(chat.indexOf("Safety callouts:"));
  });

  it("race: the long-run sentence differs for the half and the marathon only", async () => {
    const cap = capture();
    const race = (distance: TrainingGoal["distance"]) =>
      cap.weekly(packetFor({ kind: "race", distance, raceDate: "2027-03-21" }));
    const half = await race("half");
    const marathon = await race("marathon");
    expect(half).toMatch(HALF_LONG_RUN);
    expect(half).not.toMatch(MARATHON_LONG_RUN);
    expect(marathon).toMatch(MARATHON_LONG_RUN);
    expect(marathon).not.toMatch(HALF_LONG_RUN);
    for (const distance of ["5k", "10k", "other"] as const) {
      const system = await race(distance);
      expect(system).toMatch(RACE);
      expect(system).not.toMatch(HALF_LONG_RUN);
      expect(system).not.toMatch(MARATHON_LONG_RUN);
    }
  });

  it("return: minutes first, every run easy, the pain rule, walk-run by minutes", async () => {
    const system = await capture().weekly(packetFor({ kind: "return" }));
    expect(system).toMatch(/minutes and how often .* before pace or distance/);
    expect(system).toMatch(/four pain-free weeks/);
    expect(system).toMatch(/above 3 of 10 during a run, or .*worse the next morning/);
    expect(system).toMatch(/walk-run sessions by minutes/);
  });

  it("no block names its sources", async () => {
    const cap = capture();
    for (const [, goal] of GOALS) {
      const system = await cap.weekly(packetFor(goal));
      expect(system).not.toMatch(/Seiler|Fitzgerald|Daniels|Pfitzinger|Warden|Silbernagel/);
    }
  });
});
