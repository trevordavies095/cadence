import { describe, expect, it } from "vitest";
import type { PrescribedDay } from "../../frontend/lib/api.js";
import {
  ADD_DETAILS_BUSY,
  ADD_DETAILS_FAILED,
  ADD_DETAILS_LABEL,
  isNotARun,
  isNotFiled,
  NO_PLAN_GIVEN,
  NOT_FILED_EXPLANATION,
  NOT_FILED_LABEL,
  notFiledSentence,
  planSentence,
  sessionQuote,
  weekdayLabel,
} from "../../frontend/lib/planDay.js";
import { NO_PLAN_GIVEN_NOTE } from "../src/prescribed/planLines.js";
import { bannedTermsIn } from "../src/llm/vocabulary.js";
import { PLAN_DAY_FIX_FAILED_MESSAGE } from "../src/routes/prescribed.js";

/**
 * The copy the Plan page, the plan change card and the Today card use for a
 * day Cadence could not read (plan-as-text 07). The card and the Plan page
 * render days with the same row, so one set of checks covers both.
 */

const UNREAD: PrescribedDay = {
  date: "2026-10-22",
  dayType: "other",
  run: null,
  notes: "Thursday: something steady, by feel",
  line: "Thursday: something steady, by feel",
  parsed: false,
};
const NO_LINE: PrescribedDay = {
  date: "2026-10-23",
  dayType: "other",
  run: null,
  notes: NO_PLAN_GIVEN_NOTE,
  line: null,
  parsed: false,
};
const OLD_OTHER: PrescribedDay = {
  date: "2026-10-23",
  dayType: "other",
  run: null,
  notes: "Strength circuit",
};
const OLD_EASY: PrescribedDay = {
  date: "2026-10-19",
  dayType: "easy",
  run: { type: "easy", distanceM: 4828 },
};

describe("a day Cadence could not read", () => {
  it("is its own state, checked before the not-a-run rule", () => {
    expect(isNotFiled(UNREAD)).toBe(true);
    expect(isNotFiled(NO_LINE)).toBe(true);
    expect(isNotARun(UNREAD)).toBe(false);
    expect(isNotARun(NO_LINE)).toBe(false);
  });

  it("shows Coach Cade's sentence without its weekday, never as a read sentence", () => {
    expect(notFiledSentence(UNREAD)).toBe("Something steady, by feel");
    expect(planSentence(UNREAD)).toBeNull();
    expect(notFiledSentence(NO_LINE)).toBeNull();
  });

  it("the copy matches the stored note and keeps to the writing rules", () => {
    expect(NO_PLAN_GIVEN).toBe(NO_PLAN_GIVEN_NOTE);
    expect(NOT_FILED_LABEL).toBe("Not yet filed");
    for (const text of [NOT_FILED_LABEL, NOT_FILED_EXPLANATION, NO_PLAN_GIVEN]) {
      expect(text).not.toMatch(/!/);
      expect(bannedTermsIn(text)).toEqual([]);
    }
  });

  it("Add the details reads as the ticket says, the same words the API returns", () => {
    expect(ADD_DETAILS_LABEL).toBe("Add the details");
    expect(ADD_DETAILS_BUSY).toBe("Asking Coach Cade");
    expect(ADD_DETAILS_FAILED.replace("’", "'")).toBe(PLAN_DAY_FIX_FAILED_MESSAGE);
    expect(PLAN_DAY_FIX_FAILED_MESSAGE).toBe(
      "Coach Cade couldn't fill in this day. The plan above still stands.",
    );
    for (const text of [ADD_DETAILS_LABEL, ADD_DETAILS_BUSY, ADD_DETAILS_FAILED]) {
      expect(text).not.toMatch(/!/);
      expect(bannedTermsIn(text)).toEqual([]);
    }
  });

  it("the Something came up prefill quotes the sentence, not a distance", () => {
    expect(sessionQuote(UNREAD, "imperial")).toBe(
      `About today's session (${weekdayLabel(UNREAD.date)}, “Something steady, by feel”): `,
    );
    expect(sessionQuote(NO_LINE, "metric")).toBe(
      `About today's session (${weekdayLabel(NO_LINE.date)}, no plan given): `,
    );
  });

  it("old stored plans without the field read as before", () => {
    expect(isNotFiled(OLD_OTHER)).toBe(false);
    expect(isNotARun(OLD_OTHER)).toBe(true);
    expect(sessionQuote(OLD_OTHER, "imperial")).toBe(
      `About today's session (${weekdayLabel(OLD_OTHER.date)}, Not a run): `,
    );
    expect(sessionQuote(OLD_EASY, "imperial")).toBe(
      `About today's session (${weekdayLabel(OLD_EASY.date)}, Easy run, 3.0 mi): `,
    );
  });
});
