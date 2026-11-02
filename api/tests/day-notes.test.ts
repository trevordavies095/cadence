import { describe, expect, it } from "vitest";
import {
  buildStubWeeklyReply,
  expectedPlanDates,
  validateMidWeekChatReply,
  validateWeeklyReply,
  WEEKLY_SYSTEM_PROMPT,
} from "../src/llm/index.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import { buildModelPacket } from "../src/packet/index.js";
import { planLinesWith, weeklyForm } from "./weeklyForms.js";

const WEEK_START = "2026-10-26";

/** A weekly form whose Tuesday line is "easy, 5 mi, " followed by `reason`. */
function weekWithReason(reason: string) {
  return weeklyForm(WEEK_START, {
    plan: planLinesWith(WEEK_START, 1, `easy, 5 mi, ${reason}`).join("\n"),
  });
}

/** Sentences of about 50 characters each. */
const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i + 1} explains why this session matters.`).join(" ");

describe("day notes carry the reason for a session", () => {
  // The reason is written in the day's plan line now; notes hold the rest of
  // the line after the amount, which the line already shows. They are kept as
  // derived, never cut, so the line and its notes always agree.
  it("keeps the rest of a plan line as the day's notes", () => {
    const reason = "Shake-out after the 20. Flat canal, zone 2 only.";
    const checked = validateWeeklyReply(weekWithReason(reason), WEEK_START);
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.notes).toBe(reason);
    expect(checked.ok && checked.repairs).toBeUndefined();
  });

  it("keeps a long reason whole, with the line it came from", () => {
    const reason = sentences(12);
    expect(reason.length).toBeGreaterThan(400);
    const checked = validateWeeklyReply(weekWithReason(reason), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const day = checked.value.prescribedWeek.days[1]!;
    expect(day.notes).toBe(reason);
    expect(day.line).toContain(reason);
    expect(checked.repairs).toBeUndefined();
  });

  it("applies the same rule to days Coach Cade changes from chat, named as patches", () => {
    const notes = sentences(12);
    const [, tue] = expectedPlanDates(WEEK_START);
    const checked = validateMidWeekChatReply(
      {
        body: "Moved Tuesday.",
        prescribedDayPatches: [
          { date: tue, dayType: "easy", run: { type: "easy", distanceM: 6000 }, notes },
        ],
      },
      WEEK_START,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.prescribedDayPatches![0]!.notes!.length).toBeLessThanOrEqual(400);
    expect(checked.repairs?.[0]).toMatch(/^prescribedDayPatches\[0\]\.notes cut from/);
  });

  it("tells the model where the reasons go and to keep the days out of the read", () => {
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/one short sentence on why this session, this week/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/The athlete sees each line beside its day/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/do not restate the plan day by day or describe each session/i);
  });

  it("gives the stub's days short notes in plain words", () => {
    const packet = buildModelPacket({
      dossier: null,
      recapMarkdown: "## Summary\nSteady week.",
      thread: [],
      attachments: [],
      week: {
        isoWeek: "2026-W43",
        start: "2026-10-19T00:00:00.000Z",
        end: "2026-10-25T23:59:59.999Z",
        weekSessionId: "00000000-0000-4000-8000-000000000001",
      },
    });
    const notes = buildStubWeeklyReply(packet)
      .prescribedWeek.days.map((d) => d.notes)
      .filter((n): n is string => Boolean(n));
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.length).toBeLessThanOrEqual(200);
      expect(bannedTermsIn(n)).toEqual([]);
    }
  });
});
