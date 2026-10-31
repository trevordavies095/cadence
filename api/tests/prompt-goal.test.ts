import { describe, expect, it, vi } from "vitest";
import type { TrainingGoal } from "../src/goal/types.js";
import {
  DOSSIER_AUDIT_SYSTEM_PROMPT,
  MIDWEEK_SYSTEM_PROMPT,
  WEEKLY_SYSTEM_PROMPT,
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  createAnthropicLlmPort,
} from "../src/llm/index.js";
import { bannedTermsIn, bannerBannedTermsIn } from "../src/llm/vocabulary.js";
import { trainingPhaseLine } from "../src/llm/goalLines.js";
import { packetCoaching } from "../src/packet/assemble.js";
import { buildModelPacket, type ModelPacket } from "../src/packet/index.js";
import type {
  TempoAthleteSettings,
  TempoThresholds,
  TempoUnitPreference,
} from "../src/tempo/port.js";
import { anthropicStreamResponse, anthropicToolMessage } from "./helpers.js";

// Reviewed week Mon Oct 19 – Sun Oct 25; the weekly read plans Mon Oct 26.
const WEEK_START = "2026-10-19";
const PLAN_WEEK_START = "2026-10-26";

function packetFor(goal: TrainingGoal | null, coachingMonday: string): ModelPacket {
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

/** Sends packets to a fake model and keeps the user prompt of each request. */
function capture() {
  let reply: unknown = null;
  const prompts: string[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      tools: Array<{ name: string }>;
      messages: Array<{ content: string }>;
    };
    prompts.push(body.messages[0]!.content);
    return anthropicStreamResponse(anthropicToolMessage(body.tools[0]!.name, reply));
  }) as unknown as typeof globalThis.fetch;
  const port = createAnthropicLlmPort({ fetchImpl, readApiKey: async () => "sk-ant-test" });
  return {
    async weekly(packet: ModelPacket): Promise<string> {
      reply = buildStubWeeklyReply(packet);
      await port.generateWeeklyReply(packet);
      return prompts.at(-1)!;
    },
    async conversation(packet: ModelPacket): Promise<string> {
      reply = buildStubMidWeekChatReply(packet);
      await port.generateMidWeekChatReply(packet);
      return prompts.at(-1)!;
    },
  };
}

function firstLines(prompt: string, n: number): string[] {
  return prompt.split("\n").slice(0, n);
}

describe("Coach Cade's prompts open with the goal (#11)", () => {
  it("race: the weekly read names the race, date, weeks out and target, then the phase", async () => {
    const goal: TrainingGoal = {
      kind: "race",
      distance: "half",
      raceName: "Lakeshore Half",
      raceDate: "2027-03-21",
      target: "sub 1:45",
    };
    const prompt = await capture().weekly(packetFor(goal, PLAN_WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: half marathon (Lakeshore Half) on Sun Mar 21 2027, 20 weeks out, target sub 1:45.",
      "Training phase: base.",
    ]);
  });

  it("race: the conversation opens the same way, counted from this week", async () => {
    const goal: TrainingGoal = {
      kind: "race",
      distance: "marathon",
      raceName: "Lakeshore Marathon",
      raceDate: "2026-12-06",
    };
    const prompt = await capture().conversation(packetFor(goal, WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: marathon (Lakeshore Marathon) on Sun Dec 6 2026, 6 weeks out.",
      "Training phase: build.",
    ]);
  });

  it("race with no date or name yet", async () => {
    const goal: TrainingGoal = { kind: "race", distance: "other" };
    const prompt = await capture().weekly(packetFor(goal, PLAN_WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: a race, date not set yet.",
      "Training phase: base.",
    ]);
  });

  it("speed: names the distance and the target", async () => {
    const goal: TrainingGoal = { kind: "speed", distance: "5k", target: "sub 20:00" };
    const prompt = await capture().weekly(packetFor(goal, PLAN_WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: get faster at the 5K, target sub 20:00.",
      "Training phase: build.",
    ]);
  });

  it("fitness: general fitness with no race", async () => {
    const goal: TrainingGoal = { kind: "fitness" };
    const prompt = await capture().conversation(packetFor(goal, WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: general fitness, no race planned.",
      "Training phase: base.",
    ]);
  });

  it("return: since when, and the athlete's own words", async () => {
    const goal: TrainingGoal = {
      kind: "return",
      since: "2026-09-28",
      startingPoint: "off for six weeks, cleared by my physio",
    };
    const prompt = await capture().weekly(packetFor(goal, PLAN_WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: return to running since Mon Sep 28 2026; the athlete says: off for six weeks, cleared by my physio.",
      "Training phase: recovery.",
    ]);
  });

  it("race passed: says how long ago and asks what comes next", async () => {
    const goal: TrainingGoal = {
      kind: "race",
      distance: "10k",
      raceName: "Harbour 10K",
      raceDate: "2026-10-25",
    };
    const prompt = await capture().weekly(packetFor(goal, PLAN_WEEK_START));
    expect(firstLines(prompt, 3)).toEqual([
      "Athlete goal: 10K (Harbour 10K) on Sun Oct 25 2026.",
      "Training phase: recovery.",
      "The race was 1 week ago. Ease the next two weeks and ask the athlete what comes next.",
    ]);
  });

  it("race passed weeks ago: no easing, still asks what comes next", async () => {
    const goal: TrainingGoal = {
      kind: "race",
      distance: "10k",
      raceName: "Harbour 10K",
      raceDate: "2026-09-27",
    };
    const prompt = await capture().conversation(packetFor(goal, WEEK_START));
    expect(firstLines(prompt, 3)).toEqual([
      "Athlete goal: 10K (Harbour 10K) on Sun Sep 27 2026.",
      "Training phase: base.",
      "The race was 4 weeks ago. Ask the athlete what comes next.",
    ]);
  });

  it("before the race: no race-passed sentence", async () => {
    const goal: TrainingGoal = {
      kind: "race",
      distance: "10k",
      raceName: "Harbour 10K",
      raceDate: "2026-11-01",
    };
    const prompt = await capture().weekly(packetFor(goal, PLAN_WEEK_START));
    expect(firstLines(prompt, 2)).toEqual([
      "Athlete goal: 10K (Harbour 10K) on Sun Nov 1 2026, race week.",
      "Training phase: taper.",
    ]);
    expect(prompt).not.toMatch(/The race was/);
  });

  it("no goal: both prompts say the goal is not set", async () => {
    const cap = capture();
    for (const prompt of [
      await cap.weekly(packetFor(null, PLAN_WEEK_START)),
      await cap.conversation(packetFor(null, WEEK_START)),
    ]) {
      expect(firstLines(prompt, 2)).toEqual([
        "Athlete goal: not set.",
        "Training phase: not set.",
      ]);
    }
  });

  it("the phase line is built from the coaching block alone", () => {
    expect(trainingPhaseLine({ phase: "taper", weeksToRace: 1 })).toBe("Training phase: taper.");
    expect(trainingPhaseLine(null)).toBe("Training phase: not set.");
  });
});

describe("wording that rides along with the goal lines (#11)", () => {
  it("the tidy-up asks for the goal, not the race plan", () => {
    expect(DOSSIER_AUDIT_SYSTEM_PROMPT).not.toMatch(/race plan/);
    expect(DOSSIER_AUDIT_SYSTEM_PROMPT).toMatch(/how they are going, and the goal\./);
  });

  it("the week-naming rule has examples without a race", () => {
    for (const prompt of [WEEKLY_SYSTEM_PROMPT, MIDWEEK_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/"the week of Oct 19"/);
      expect(prompt).toMatch(/only when the athlete has a race, "4 weeks out from the race"/);
    }
  });

  it("Coach Cade may write phase; the home banner may not", () => {
    expect(bannedTermsIn("This is the end of your base phase.")).toEqual([]);
    expect(bannerBannedTermsIn("Your base phase is done")).toEqual(["phase"]);
    expect(bannerBannedTermsIn("Time for your weekly check-in")).toEqual([]);
  });
});

describe("the phase line names the threshold (coaching-bias 15)", () => {
  const goal: TrainingGoal = { kind: "speed", distance: "5k" };
  const zones = { calculationMethod: "Custom", zones: [] };
  const suggestion = {
    suggestedThresholdPaceS: 254,
    suggestedFrom: { distance: "5K", timeS: 1185, workoutDate: "2026-03-02", workoutId: "w1" },
  };

  function packetWith(
    thresholds: TempoThresholds | undefined,
    unitPreference: TempoUnitPreference = "metric",
  ): ModelPacket {
    const settings: TempoAthleteSettings = {
      unitPreference,
      heartRateZones: zones,
      ...(thresholds ? { thresholds } : {}),
    };
    return buildModelPacket({
      dossier: { versionId: 1, body: "You run five days a week." },
      goal,
      coaching: packetCoaching(goal, PLAN_WEEK_START, settings),
    });
  }

  it("names the athlete-set threshold in both prompts", async () => {
    const packet = packetWith({
      thresholdPaceS: 250,
      thresholdHeartRateBpm: 171,
      ...suggestion,
    });
    const cap = capture();
    for (const prompt of [await cap.weekly(packet), await cap.conversation(packet)]) {
      expect(firstLines(prompt, 2)[1]).toBe(
        "Training phase: build. Threshold pace 4:10/km (set in your running log).",
      );
    }
  });

  it("else the suggested threshold with its source", async () => {
    const packet = packetWith({
      thresholdPaceS: null,
      thresholdHeartRateBpm: null,
      ...suggestion,
    });
    const prompt = await capture().weekly(packet);
    expect(firstLines(prompt, 2)[1]).toBe(
      "Training phase: build. Threshold pace 4:14/km (suggested by your running log from your 5K on Mar 2).",
    );
  });

  it("else nothing, with no thresholds or an older running log", async () => {
    const cap = capture();
    const none = packetWith({
      thresholdPaceS: null,
      thresholdHeartRateBpm: null,
      suggestedThresholdPaceS: null,
      suggestedFrom: null,
    });
    expect(firstLines(await cap.weekly(none), 2)[1]).toBe("Training phase: build.");
    expect(firstLines(await cap.conversation(packetWith(undefined)), 2)[1]).toBe(
      "Training phase: build.",
    );
  });

  it("prints the pace in the athlete's unit", async () => {
    const packet = packetWith(
      { thresholdPaceS: 250, thresholdHeartRateBpm: null, ...suggestion },
      "imperial",
    );
    const prompt = await capture().conversation(packet);
    expect(firstLines(prompt, 2)[1]).toBe(
      "Training phase: build. Threshold pace 6:42/mi (set in your running log).",
    );
  });
});
