import type { PrescribedDay, UnitPreference } from "@/lib/api";
import { plannedRunLabel } from "@/lib/units";
import { LabelValueList } from "./ui";

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

/** A planned day that is not a run: an other day with no run, such as strength or a walk. */
export function isNotARun(day: Pick<PrescribedDay, "dayType" | "run">): boolean {
  return day.dayType === "other" && day.run == null;
}

const DAY_TYPE_LABEL: Record<string, string> = {
  easy: "Easy run",
  quality: "Quality session",
  long: "Long run",
  race: "Race",
  rest: "Rest day",
  other: "Other",
};

export function PlanDayRow({
  day,
  unit,
  isToday,
}: {
  day: PrescribedDay;
  unit: UnitPreference;
  isToday: boolean;
}) {
  const run = day.run;
  const strength = meaningful(day.strength);
  const notes = meaningful(day.notes);
  const shoes = meaningful(run?.shoes);
  const target = meaningful(run?.paceOrHr);
  // Strength, cross-training or a walk: the notes say what it is, in place of figures.
  const notRun = isNotARun(day);
  return (
    <li
      aria-current={isToday ? "date" : undefined}
      className={
        isToday
          ? "flex flex-col gap-1 border-b border-border border-l-4 border-l-accent bg-raised py-3 pl-4 pr-3"
          : "flex flex-col gap-1 border-b border-border pb-3"
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <strong>
          {weekdayLabel(day.date)}
          {isToday ? (
            <span className="ml-2 rounded-md border border-accent px-2 py-0.5 text-sm font-semibold text-accent">
              Today
            </span>
          ) : null}
        </strong>
        <span className="text-muted">
          {DAY_TYPE_LABEL[day.dayType] ?? day.dayType}
        </span>
      </div>
      {run ? (
        <p className="m-0">
          {plannedRunLabel(run, unit)}
          {meaningful(run.structure) ? ` · ${run.structure}` : ""}
        </p>
      ) : notRun ? (
        <p className="m-0">
          <span className="text-muted">{notes ? "Not a run · " : "Not a run"}</span>
          {notes}
        </p>
      ) : (
        <p className="m-0 text-muted">No run</p>
      )}
      <LabelValueList
        items={[
          ["Effort", target],
          ["Shoes", shoes],
          ["Strength", strength],
        ]}
      />
      {notes && !notRun ? <p className="m-0 text-muted">{notes}</p> : null}
    </li>
  );
}

