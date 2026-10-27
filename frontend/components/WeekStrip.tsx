import type { HomeWeekDay, UnitPreference } from "@/lib/api";
import { distanceLabel } from "@/lib/units";
import { cx } from "./ui";

const STATE_LABEL: Record<HomeWeekDay["state"], string> = {
  done: "Done",
  today: "Today",
  upcoming: "Planned",
  rest: "Rest",
  missed: "Missed",
  unknown: "",
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
  return (
    <ol
      aria-label="This week"
      className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-3 p-0 sm:grid-cols-7"
    >
      {week.map((d) => {
        const { name, date } = dayName(d.date);
        const distance =
          d.state === "done"
            ? d.actualDistanceM
            : d.state === "rest"
              ? null
              : d.plannedDistanceM;
        return (
          <li
            key={d.date}
            aria-current={d.isToday ? "date" : undefined}
            className={cx(
              "flex flex-col gap-0.5 border-t-2 pt-2",
              d.isToday ? "border-accent" : "border-border",
            )}
          >
            <span className="font-semibold">{name}</span>
            <span className="text-sm text-muted">{date}</span>
            <span className="tabular-nums">
              {distance != null && distance > 0 ? distanceLabel(distance, unit) : "–"}
            </span>
            <span
              className={cx(
                "text-sm font-semibold",
                d.state === "done" && "text-ok",
                d.state === "missed" && "text-danger",
                (d.state === "upcoming" || d.state === "rest") && "text-muted",
              )}
            >
              {STATE_LABEL[d.state]}
              {d.state === "done" && d.isToday ? " · today" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
