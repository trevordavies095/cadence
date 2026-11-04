/**
 * Tool-call markup never reaches the athlete. Opus 4.7 sometimes writes its
 * own call syntax into a text box (gate flat-form, 2026-11-02). With the
 * plan present the reply would otherwise be accepted and the markup shown as
 * a Watching title, so any box holding markup refuses the reply and the
 * retry names the field.
 */
import { describe, expect, it } from "vitest";
import { validateMidWeekChatReply, validateWeeklyReply } from "../src/llm/index.js";
import { weeklyForm } from "./weeklyForms.js";

const MONDAY = "2026-10-26";

describe("tool-call markup in a box", () => {
  it.each([
    ["flags", '\n<parameter name="0">Workload spike: hold volume this week.'],
    ["answers", '<parameter name="value">["Yes, 3:30 is in reach."]'],
    ["analysis", "Good week.</parameter>"],
    ["safetyCallouts", '<invoke name="submit_weekly_reply">'],
  ])("refuses a weekly reply with markup in %s, even with a valid plan", (field, value) => {
    const checked = validateWeeklyReply(weeklyForm(MONDAY, { [field]: value }), MONDAY);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toBe(
      `${field} contains tool-call markup (<parameter ...>); write every box as plain text, one item per line`,
    );
  });

  it("refuses markup in a list sent the old way", () => {
    const checked = validateWeeklyReply(weeklyForm(MONDAY, { flags: ["Fine: ok", '<parameter name="1">x'] }), MONDAY);
    expect(checked.ok).toBe(false);
  });

  it("refuses a mid-week reply with markup in its body", () => {
    expect(validateMidWeekChatReply({ body: 'Sure.\n<parameter name="changes">' }, MONDAY).ok).toBe(false);
  });

  it("accepts the same reply without markup, and ordinary angle brackets", () => {
    expect(validateWeeklyReply(weeklyForm(MONDAY), MONDAY).ok).toBe(true);
    expect(validateWeeklyReply(weeklyForm(MONDAY, { flags: "Heart rate: keep it <150 on easy days." }), MONDAY).ok).toBe(true);
  });
});
