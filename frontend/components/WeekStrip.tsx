"use client";

import { useEffect, useRef } from "react";
import type { HomeWeekDay, UnitPreference } from "@/lib/api";
import { NOT_FILED_EXPLANATION, NOT_FILED_LABEL } from "@/lib/planDay";
import { distanceLabel, durationLabel } from "@/lib/units";
import { cx } from "./ui";

const STATE_LABEL: Record<HomeWeekDay["state"], string> = {
  done: "Done",
  today: "Today",
  upcoming: "Planned",
  rest: "Rest",
  missed: "Missed",
  unknown: "",
  not_filed: NOT_FILED_LABEL,
};

function dayName(ymd: string): { name: string; date: string } {
  const d = new Date(`${ymd}T12:00:00`);
  return {
    name: d.toLocaleDateString(undefined, { weekday: "short" }),
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  };
}

/** The seven days of the week with what was planned and what was run. */
export function WeekStrip({
  week,
  unit,
}: {
  week: HomeWeekDay[];
  unit: UnitPreference;
}) {
  // Phones can't hover, so the reason a day couldn't be read is written out, not left in a tooltip.
  const unread = week.some((d) => d.state === "not_filed" && d.line);
  // On a phone the week is one row that scrolls sideways; it opens on today.
  const todayRef = useRef<HTMLLIElement>(null);
  const todayYmd = week.find((d) => d.isToday)?.date;
  useEffect(() => {
    const el = todayRef.current;
    const row = el?.parentElement;
    if (!el || !row || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = el.offsetLeft - row.offsetLeft - (row.clientWidth - el.clientWidth) / 2;
  }, [todayYmd]);
  return (
    <div className="flex flex-col gap-3">
      <ol
        aria-label="This week"
        className="m-0 flex list-none gap-x-4 overflow-x-auto p-0 pb-1 sm:grid sm:grid-cols-7 sm:overflow-visible sm:pb-0"
      >
        {week.map((d) => {
          const { name, date } = dayName(d.date);
          // A rest day and a day Cadence could not read have nothing planned to show.
          const nothingPlanned = d.state === "rest" || d.state === "not_filed";
          const distance =
            d.state === "done"
              ? d.actualDistanceM
              : nothingPlanned
                ? null
                : d.plannedDistanceM;
          // A day planned by time alone shows its minutes until it is run.
          const minutes =
            d.state !== "done" && !nothingPlanned && !(distance != null && distance > 0)
              ? (d.plannedDurationS ?? null)
              : null;
          // An other day with nothing planned to run: strength, cross-training or a walk.
          const notARun =
            d.parsed !== false &&
            d.dayType === "other" &&
            d.plannedDistanceM == null &&
            d.plannedDurationS == null;
          return (
            <li
              key={d.date}
              ref={d.isToday ? todayRef : undefined}
              aria-current={d.isToday ? "date" : undefined}
              className={cx(
                "flex w-[5.25rem] shrink-0 flex-col gap-0.5 border-t-2 pt-2 sm:w-auto",
                d.isToday ? "border-accent" : "border-border",
              )}
            >
              <span className="font-semibold">{name}</span>
              <span className="text-sm text-muted">{date}</span>
              <span className="tabular-nums">
                {distance != null && distance > 0
                  ? distanceLabel(distance, unit)
                  : minutes != null && minutes > 0
                    ? durationLabel(minutes)
                    : "–"}
              </span>
              <span
                className={cx(
                  "text-sm font-semibold",
                  d.state === "done" && "text-ok",
                  d.state === "missed" && "text-danger",
                  (d.state === "upcoming" || nothingPlanned) && "text-muted",
                )}
                title={d.state === "not_filed" && d.line ? NOT_FILED_EXPLANATION : undefined}
              >
                {d.state === "not_filed"
                  ? d.line
                    ? NOT_FILED_LABEL
                    : "No plan"
                  : d.state === "rest" && notARun
                    ? "Not a run"
                    : STATE_LABEL[d.state]}
                {d.state === "done" && d.isToday ? " · today" : ""}
              </span>
            </li>
          );
        })}
      </ol>
      {unread ? <p className="m-0 text-sm text-muted">{NOT_FILED_EXPLANATION}</p> : null}
    </div>
  );
}
