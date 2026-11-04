/**
 * Boxes a model writes inside another box, in its own call syntax, moved back
 * to their own fields (moveLeakedBoxes in src/llm/schema.ts). The fixtures are
 * the four refused attempts of this kind in the 2026-11-03 coaching baseline
 * (fictional athletes): each leaked exactly the boxes it had left out, and each
 * was refused twice before. Pure: the validator only.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { moveLeakedBoxes, validateMidWeekChatReply, validateWeeklyReply } from "../src/llm/schema.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "markup-leak");
const MARKUP = /<\/?(?:parameter|invoke|function_calls)\b|<\/(?:answers|flags|analysis|plan)>/;

describe("boxes leaked into another box", () => {
  for (const file of readdirSync(DIR)) {
    it(`are moved back and the reply accepted: ${file}`, () => {
      const fx = JSON.parse(readFileSync(path.join(DIR, file), "utf8"));
      const result = validateWeeklyReply(fx.input, fx.weekStartMonday, { unit: "imperial" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repairs?.some((r) => / moved out of /.test(r))).toBe(true);
      expect(JSON.stringify(result.value)).not.toMatch(MARKUP);
      expect(result.value.prescribedWeek.days).toHaveLength(7);
    });
  }

  it("keeps the text before the leak in its own box and strips the closing tags", () => {
    const moved = moveLeakedBoxes(
      { headline: "Easy week.", answers: 'Yes, rest.</answers>\n<parameter name="analysis">A calm week.</parameter>' },
      ["headline", "answers", "analysis"],
    );
    expect(moved).toEqual({
      raw: { headline: "Easy week.", answers: "Yes, rest.", analysis: "A calm week." },
      repairs: ["analysis moved out of answers"],
    });
  });

  it("refuses as before when the leaked name is not a box, or its box is already written", () => {
    expect(moveLeakedBoxes({ flags: 'One.\n<parameter name="0">Workload spike' }, ["flags", "answers"])).toBeNull();
    expect(moveLeakedBoxes({ flags: 'One.\n<parameter name="answers">Two.', answers: "Already here." }, ["flags", "answers"])).toBeNull();
    // Markup that is not a whole box is still refused.
    expect(moveLeakedBoxes({ flags: "One. </invoke> Two." }, ["flags"])).toBeNull();
    const refused = validateWeeklyReply({ headline: "Hi.", analysis: "x", plan: "x", flags: '<parameter name="0">Workload spike' }, "2026-10-19");
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/flags contains tool-call markup/) });
  });

  it("moves a leaked box in a mid-week reply too, but refuses an empty one", () => {
    const moved = validateMidWeekChatReply({ changes: "", body: 'Sounds good.</body>\n<parameter name="allowPastDayPatches">x' }, "2026-10-19");
    expect(moved.ok).toBe(false); // not one of the mid-week text boxes
    const leaked = moveLeakedBoxes({ body: 'Sounds good.</body>\n<parameter name="changes">Tue 2026-10-20: rest.' }, ["body", "changes"]);
    expect(leaked?.raw).toEqual({ body: "Sounds good.", changes: "Tue 2026-10-20: rest." });
    // Opened and left empty: possibly cut off, so refused.
    expect(validateMidWeekChatReply({ body: 'Sure.\n<parameter name="changes"></parameter>' }, "2026-10-19").ok).toBe(false);
  });
});
