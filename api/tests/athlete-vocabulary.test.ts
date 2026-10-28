import { describe, expect, it } from "vitest";
import { DISCLAIMER_TEXT } from "../src/disclaimer/text.js";
import {
  buildStubDossierAudit,
  buildStubDossierCorrection,
  buildStubDossierV1,
  buildStubMidWeekChatReply,
  buildStubWeeklyReply,
  formatDossierAuditThreadBody,
  formatDossierCorrectionThreadBody,
  formatDossierProposalThreadBody,
} from "../src/llm/stub.js";
import { buildProposedBodyFromSettingsBullets } from "../src/dossier/fromWeeklyReply.js";
import { formatDayShort } from "../src/clock/weekRangeShort.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import { buildModelPacket } from "../src/packet/index.js";
import { PRIVACY_COPY } from "../src/privacy/copy.js";
import type { PrescribedWeek } from "../src/llm/types.js";

const SKIP_NOTE = "Please skip Thursday, sore calf niggle after the long run.";
const LONG_GOAL =
  "Run a half marathon in January under 1:45, then build toward a spring marathon. " +
  "I would like to keep two easy runs, one workout and a long run each week, and I care " +
  "more about arriving healthy than about the exact time, because last year I got hurt " +
  "in the final block and had to pull out three weeks before the race.";

const DOSSIER_BODY = [
  "# About you",
  "",
  "## Current Status",
  "Left Achilles niggle, easy volume capped.",
  "",
  "## Coach update",
  "- Retired the old trainers.",
].join("\n");

function packet(note?: string, prescribedWeek?: PrescribedWeek) {
  return buildModelPacket({
    prescribedWeek: prescribedWeek ?? null,
    dossier: { versionId: 1, body: DOSSIER_BODY },
    recapMarkdown: "## Summary\n20 mi, steady week.",
    thread: note
      ? [
          {
            id: "1",
            role: "athlete",
            body: note,
            createdAt: "2026-10-22T12:00:00.000Z",
            weekSessionId: "00000000-0000-4000-8000-000000000001",
            attachment: null,
          },
        ]
      : [],
    attachments: [],
    week: {
      isoWeek: "2026-W43",
      start: "2026-10-19T04:00:00.000Z",
      end: "2026-10-26T03:59:59.999Z",
      weekSessionId: "00000000-0000-4000-8000-000000000001",
    },
    planWeek: {
      isoWeek: "2026-W44",
      startDate: "2026-10-26",
      endDate: "2026-11-01",
    },
  });
}

function texts(): Record<string, string> {
  const weekly = buildStubWeeklyReply(packet());
  const midWeek = buildStubMidWeekChatReply(
    packet(SKIP_NOTE, weekly.prescribedWeek),
  );
  const v1 = buildStubDossierV1({
    answers: {
      goal: LONG_GOAL,
      schedule: "Tue Thu Sat",
      injuries_constraints: "Left calf",
      preferences: "Trails",
    },
    prefills: { available: false },
  });
  const correction = buildStubDossierCorrection({
    athleteMessage: "I now run on Mondays too.",
    currentDossier: { versionId: 1, body: DOSSIER_BODY },
    week: { isoWeek: "2026-W43" },
  });
  const audit = buildStubDossierAudit({
    currentDossier: { versionId: 1, body: DOSSIER_BODY },
    week: { isoWeek: "2026-W43" },
    nowIso: "2026-10-25T12:00:00.000Z",
    intervalWeeks: 5,
  });
  return {
    "weekly analysis": weekly.analysis,
    "weekly settings bullets": (weekly.settingsProposalBullets ?? []).join("\n"),
    "mid-week reply": midWeek.body,
    "mid-week settings bullets": (midWeek.settingsProposalBullets ?? []).join("\n"),
    "plan day notes": (midWeek.prescribedDayPatches ?? [])
      .map((d) => d.notes ?? "")
      .join("\n"),
    "onboarding summary": v1.summaryBullets.join("\n"),
    "onboarding document": v1.proposedBody,
    "onboarding thread message": formatDossierProposalThreadBody(v1),
    "correction summary": correction.summaryBullets.join("\n"),
    "correction document": correction.proposedBody,
    "correction thread message": formatDossierCorrectionThreadBody(correction),
    "audit summary": audit.summaryBullets.join("\n"),
    "audit thread message": formatDossierAuditThreadBody(audit),
    disclaimer: DISCLAIMER_TEXT,
    "privacy copy": JSON.stringify(PRIVACY_COPY),
  };
}

describe("athlete vocabulary in system-written text", () => {
  for (const [name, text] of Object.entries(texts())) {
    it(`${name} uses none of the banned terms`, () => {
      expect(text.length).toBeGreaterThan(0);
      expect(bannedTermsIn(text)).toEqual([]);
    });
  }

  for (const [name, text] of Object.entries(texts())) {
    it(`${name} is not cut off with an ellipsis (#9)`, () => {
      expect(text).not.toContain("…");
    });
  }

  it("thread messages for a note card name its real actions and leave the bullets to the card (#19)", () => {
    const t = texts();
    for (const name of [
      "onboarding thread message",
      "correction thread message",
      "audit thread message",
    ]) {
      expect(t[name], name).not.toMatch(/Accept|Reject|Summary:|•/);
    }
  });

  it("the chat reply never quotes the athlete back (#9)", () => {
    const t = texts();
    expect(t["mid-week reply"]).not.toContain("sore calf niggle");
    expect(t["mid-week reply"]).not.toContain("Heard:");
  });

  it("the chat note card keeps the athlete's words whole, for About you (#9)", () => {
    expect(texts()["mid-week settings bullets"]).toBe(`You told me: ${SKIP_NOTE}`);
  });

  it("a long onboarding answer keeps whole sentences on the card (#9)", () => {
    const goal = texts()["onboarding summary"].split("\n")[0]!;
    expect(goal.length).toBeLessThanOrEqual(280);
    expect(goal).toMatch(/^Goal: Run a half marathon in January under 1:45, .*\.$/);
    expect(goal).not.toContain("had to pull out");
  });

  it("names plan and tidy-up dates the way the athlete reads them (#9)", () => {
    const t = texts();
    expect(t["mid-week reply"]).toMatch(
      /Updated the plan for (Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2}\./,
    );
    expect(t["audit summary"]).toContain("Next tidy-up around Sun Nov 29 (every 5 weeks).");
  });

  it("flags raw dates, but not other dashed numbers (#9)", () => {
    expect(bannedTermsIn("Updated the plan for 2026-10-15.")).toEqual(["raw date"]);
    expect(bannedTermsIn("(updated 2026-10-14)")).toEqual(["raw date"]);
    expect(bannedTermsIn("Run 10-15 min easy, call 555-1234")).toEqual([]);
  });

  it("formats a calendar day as Mon Oct 19 (#9)", () => {
    expect(formatDayShort("2026-10-19")).toBe("Mon Oct 19");
    expect(formatDayShort("2026-11-01")).toBe("Sun Nov 1");
    expect(formatDayShort("2027-01-03")).toBe("Sun Jan 3");
    expect(formatDayShort("not a date")).toBe("");
  });

  it("matches the multi-word banned term AI Coach as whole words", () => {
    expect(bannedTermsIn("Welcome to AI Coach")).toEqual(["AI Coach"]);
    expect(bannedTermsIn("welcome to ai coach.")).toEqual(["AI Coach"]);
    expect(bannedTermsIn("Cadence AI Coaching")).toEqual([]);
  });

  it("names the product Cadence in the disclaimer and privacy copy", () => {
    expect(DISCLAIMER_TEXT).toContain("Cadence");
    expect(JSON.stringify(PRIVACY_COPY)).toContain("Cadence");
  });

  it("keeps model-only prompt lines out of the athlete's About you text", () => {
    for (const name of ["onboarding document", "onboarding thread message"]) {
      const text = texts()[name];
      expect(text).not.toMatch(/you are coach cade/i);
      expect(text).not.toMatch(/do not sign off/i);
    }
  });

  it("flags short and full week labels as banned, but not words that start with W", () => {
    expect(bannedTermsIn("W43's long run")).toEqual(["week label"]);
    expect(bannedTermsIn("build to peak over W42–W43")).toEqual(["week label"]);
    expect(bannedTermsIn("the W38 note")).toEqual(["week label"]);
    expect(bannedTermsIn("plan for 2026-W44")).toEqual(["week label"]);
    expect(bannedTermsIn("Wednesday at 6 W, Week 4, wW3")).toEqual([]);
  });

  it("tells the live model never to write week labels", async () => {
    const { MIDWEEK_SYSTEM_PROMPT, WEEKLY_SYSTEM_PROMPT } = await import("../src/llm/safety.js");
    for (const prompt of [WEEKLY_SYSTEM_PROMPT, MIDWEEK_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/never write them or a short form such as W43/);
      expect(prompt).toMatch(/Oct 19 – 25/);
    }
  });

  it("dates Coach Cade's About you updates as a range, not a week id", () => {
    const body = buildProposedBodyFromSettingsBullets({
      currentBody: "# About you\n\n## Goal\nSub-3:30",
      summaryBullets: ["Shoe preference: Endorphin Speed 4 for long runs with a marathon pace block."],
      isoWeek: "2026-W42",
    });
    expect(body).toContain("## Coach update (Oct 12 – 18)");
    expect(bannedTermsIn(body)).toEqual([]);
    const fresh = buildProposedBodyFromSettingsBullets({ currentBody: "", summaryBullets: ["x"], isoWeek: null });
    expect(fresh).toBe("# About you\n\n## Coach update (this week)\n\n- x\n");
  });

  it("never shows an ISO week label", () => {
    for (const text of Object.values(texts())) {
      expect(text).not.toMatch(/\b\d{4}-W\d{2}\b/);
    }
  });

  it("names the plan week as a date range", () => {
    const { headline } = buildStubWeeklyReply(packet());
    expect(headline).toContain("Oct 26 – Nov 1");
  });
});

describe("the coach is only ever Coach Cade", () => {
  it("allows Coach Cade in full", () => {
    expect(bannedTermsIn("Coach Cade is reading your week.")).toEqual([]);
    expect(bannedTermsIn("Noted by Coach Cade")).toEqual([]);
  });

  it("bans a bare Cade", () => {
    expect(bannedTermsIn("Cade is reading your week.")).toEqual(["Cade"]);
    expect(bannedTermsIn("Ask Cade about it")).toEqual(["Cade"]);
    expect(bannedTermsIn("Coach Cade and Cade")).toEqual(["Cade"]);
  });
});
