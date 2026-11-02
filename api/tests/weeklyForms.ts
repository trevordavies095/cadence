/**
 * Fake weekly replies as Coach Cade sends them: the flat form, every box text
 * (lists as one item per line), with the plan as seven lines (plan-as-text
 * ticket 06).
 * Pure: no database, so unit tests and route tests share it.
 */
import { expectedPlanDates, type WeeklyReplyForm } from "../src/llm/index.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Seven well-formed plan lines for the week starting `monday`: a rest day, an
 * easy run by distance, a quality session, a time-only run, an other day with
 * no run, a range and a long run. Distances in miles, or kilometres for metric.
 */
export function planLines(monday: string, unit: "imperial" | "metric" = "imperial"): string[] {
  const d = expectedPlanDates(monday);
  const u = unit === "metric" ? "km" : "mi";
  return [
    `Mon ${d[0]}: rest. Sleep in.`,
    `Tue ${d[1]}: easy, 5 ${u}, HR under 150, flat route.`,
    `Wed ${d[2]}: quality, 6 ${u}. Warm up, 4 x 1 mile at threshold, cool down.`,
    `Thu ${d[3]}: easy, 40 min, very relaxed.`,
    `Fri ${d[4]}: other, strength: squats, lunges and core.`,
    `Sat ${d[5]}: easy, 3-4 ${u}, shakeout.`,
    `Sun ${d[6]}: long, 10 ${u}, steady, fuel early.`,
  ];
}

/** The same seven lines with the line for weekday index `i` (0 = Monday) replaced. */
export function planLinesWith(monday: string, i: number, line: string): string[] {
  const lines = planLines(monday);
  lines[i] = `${WEEKDAYS[i]} ${expectedPlanDates(monday)[i]}: ${line}`;
  return lines;
}

type RecordedDay = {
  date: string;
  dayType: string;
  notes?: string | null;
  run?: { distanceM: number; structure?: string | null; paceOrHr?: string | null } | null;
};

/**
 * A recorded weekly reply's stream (tests/fixtures/self-hosted), its tool
 * input translated into the weekly form: the recording predates the plan box
 * (plan-as-text ticket 06). Everything else in the stream (thinking, timing,
 * usage) stays as recorded; only the one input_json_delta line is rewritten,
 * each recorded day becoming a plan line in miles.
 */
export function recordedWeeklyReplyAsForm(sse: string): string {
  return sse.replace(/^data: (\{.*"input_json_delta".*\})$/m, (_line, json: string) => {
    const event = JSON.parse(json) as { delta: { partial_json: string } };
    const old = JSON.parse(event.delta.partial_json) as {
      headline: string;
      analysis: string;
      flags?: Array<{ title: string; detail: string }>;
      answers?: Array<{ answer: string }>;
      prescribedWeek: { days: RecordedDay[] };
    };
    const line = (d: RecordedDay) => {
      const run = d.run
        ? `, ${(d.run.distanceM / 1609.344).toFixed(1)} mi, ${[d.run.structure, d.run.paceOrHr].filter(Boolean).join(", ")}`
        : "";
      return `${d.date}: ${d.dayType}${run}. ${d.notes ?? ""}`.trim();
    };
    const form: WeeklyReplyForm = {
      headline: old.headline,
      analysis: old.analysis,
      flags: (old.flags ?? []).map((f) => `${f.title}: ${f.detail}`).join("\n"),
      answers: (old.answers ?? []).map((a) => a.answer).join("\n\n"),
      plan: old.prescribedWeek.days.map(line).join("\n"),
    };
    event.delta.partial_json = JSON.stringify(form);
    return `data: ${JSON.stringify(event)}`;
  });
}

/** A weekly form that reads cleanly for the week starting `monday`, with `overrides` on top. */
export function weeklyForm(
  monday: string,
  overrides: Partial<Record<keyof WeeklyReplyForm, unknown>> = {},
): WeeklyReplyForm & Record<string, unknown> {
  return {
    headline: "A steady week. Keep the easy days easy.",
    flags: "Heart rate drift: Watch it on the easy days.",
    answers: "",
    analysis: "## Why this plan\nOne quality session carries the week.",
    plan: planLines(monday).join("\n"),
    ...overrides,
  } as WeeklyReplyForm & Record<string, unknown>;
}
