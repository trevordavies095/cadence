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

const WEEK_START = "2026-10-26";

function weekWithNotes(notes: string | null) {
  return {
    headline: "A steady week.",
    analysis: "## Why this plan\nKeep it easy.",
    prescribedWeek: {
      week: "2026-W44",
      days: expectedPlanDates(WEEK_START).map((date, i) =>
        i === 1
          ? { date, dayType: "easy", run: { type: "easy", distanceM: 8000 }, notes }
          : { date, dayType: "rest", run: null },
      ),
    },
  };
}

/** Sentences of about 50 characters each. */
const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i + 1} explains why this session matters.`).join(" ");

describe("day notes carry the reason for a session", () => {
  it("keeps notes within the target as written", () => {
    const notes = "Shake-out after the 20. Flat canal, zone 2 only.";
    const checked = validateWeeklyReply(weekWithNotes(notes), WEEK_START);
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.notes).toBe(notes);
    expect(checked.ok && checked.repairs).toBeUndefined();
  });

  it("keeps notes past the target but notes that they ran long", () => {
    const notes = sentences(5);
    expect(notes.length).toBeGreaterThan(200);
    expect(notes.length).toBeLessThanOrEqual(400);
    const checked = validateWeeklyReply(weekWithNotes(notes), WEEK_START);
    expect(checked.ok && checked.value.prescribedWeek.days[1]!.notes).toBe(notes);
    expect(checked.ok && checked.repairs).toEqual([
      `prescribedWeek.days[1].notes over target: ${notes.length} chars kept`,
    ]);
  });

  it("cuts notes past the ceiling at the last whole sentence", () => {
    const notes = sentences(12);
    const checked = validateWeeklyReply(weekWithNotes(notes), WEEK_START);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const kept = checked.value.prescribedWeek.days[1]!.notes!;
    expect(kept.length).toBeLessThanOrEqual(400);
    expect(kept).toMatch(/matters\.$/);
    expect(notes.startsWith(kept)).toBe(true);
    expect(checked.repairs).toEqual([
      `prescribedWeek.days[1].notes cut from ${notes.length} to ${kept.length} chars`,
    ]);
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
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/reason for each session in that day's notes/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/under 200 characters/);
    expect(WEEKLY_SYSTEM_PROMPT).toMatch(/do not list the days or describe each session/i);
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
