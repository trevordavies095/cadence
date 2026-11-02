import type { PrescribedDay, UnitPreference } from "./api";
import { plannedRunLabel } from "./units";

/**
 * How a planned day reads on screen, shared by the Plan page, the plan change
 * card, the Today card and the Home strip. Pure, with no React, so the API
 * tests can check the copy.
 */

export const DAY_TYPE_LABEL: Record<string, string> = {
  easy: "Easy run",
  quality: "Quality session",
  long: "Long run",
  race: "Race",
  rest: "Rest day",
  other: "Other",
};

/** The mark on a day Coach Cade wrote that Cadence could not read yet. */
export const NOT_FILED_LABEL = "Not yet filed";
export const NOT_FILED_EXPLANATION =
  "Coach Cade wrote this day; Cadence couldn’t read the details yet.";
/** A date Coach Cade's plan left out. */
export const NO_PLAN_GIVEN = "Coach Cade gave no plan for this day";
/** The action on an unread day of the Plan page, while it runs, and when it fails. */
export const ADD_DETAILS_LABEL = "Add the details";
export const ADD_DETAILS_BUSY = "Asking Coach Cade";
export const ADD_DETAILS_FAILED =
  "Coach Cade couldn’t fill in this day. The plan above still stands.";

export function weekdayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "None", "Rest" and "n/a" mean there is nothing to show. */
export function meaningful(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  return /^(none|rest|n\/a)\.?$/i.test(t) ? null : t;
}

const LIST_MARKER = /^(?:[-*•]+|\d{1,2}[.)])\s+/;
/** A weekday name or abbreviation, or a YYYY-MM-DD date, opening the text. */
const DAY_TOKEN =
  /^(?:monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)(?![a-z])\.?|^\d{4}-\d{2}-\d{2}(?!\d)/i;

/** Coach Cade's line with the day and date it opens with left off. Null when there is no line. */
function lineSentence(line: string | null | undefined): string | null {
  const trimmed = line?.trim();
  if (!trimmed) return null;
  const sentence = trimmed
    .replace(LIST_MARKER, "")
    .replace(DAY_TOKEN, "")
    .replace(/^[\s,]+/, "")
    .replace(DAY_TOKEN, "")
    .replace(/^[\s,:;()\-–—.]+/, "")
    .trim();
  const text = sentence || trimmed;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A day Coach Cade wrote that Cadence has no structure for, or a date the plan
 * left out. Old stored plans without the field are read.
 */
export function isNotFiled(day: Pick<PrescribedDay, "parsed">): boolean {
  return day.parsed === false;
}

/**
 * The sentence Coach Cade wrote for a day Cadence read from its plan line, with
 * the day and date it opens with left off (the row already shows them). Null
 * for a day stored before plans were text, and for a day Cadence could not
 * read (see {@link notFiledSentence}).
 */
export function planSentence(day: Pick<PrescribedDay, "line" | "parsed">): string | null {
  if (isNotFiled(day)) return null;
  return lineSentence(day.line);
}

/**
 * The sentence of a day Cadence could not read, as Coach Cade wrote it. Null
 * when the plan gave no line for the date (then {@link NO_PLAN_GIVEN} applies)
 * and for every day Cadence did read.
 */
export function notFiledSentence(day: Pick<PrescribedDay, "line" | "parsed">): string | null {
  if (!isNotFiled(day)) return null;
  return lineSentence(day.line);
}

/** A planned day that is not a run: an other day with no run, such as strength or a walk. */
export function isNotARun(day: Pick<PrescribedDay, "dayType" | "run" | "parsed">): boolean {
  return !isNotFiled(day) && day.dayType === "other" && day.run == null;
}

/** What the athlete says to the coach when today's plan has to change. */
export function sessionQuote(day: PrescribedDay, unit: UnitPreference): string {
  if (isNotFiled(day)) {
    // Nothing was read from the day, so it is described by what Coach Cade wrote.
    const sentence = notFiledSentence(day);
    const what = sentence ? `“${sentence}”` : "no plan given";
    return `About today's session (${weekdayLabel(day.date)}, ${what}): `;
  }
  const parts = [
    weekdayLabel(day.date),
    isNotARun(day) ? "Not a run" : (DAY_TYPE_LABEL[day.dayType] ?? day.dayType),
    day.run ? plannedRunLabel(day.run, unit) : null,
  ].filter(Boolean);
  return `About today's session (${parts.join(", ")}): `;
}
