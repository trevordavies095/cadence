import type { PrescribedDay, UnitPreference } from "@/lib/api";
import { formatDistance, meaningful, weekdayLabel } from "./PlanDayRow";
import { ButtonLink, Card, LabelValueList, Muted } from "./ui";

const DAY_TYPE_LABEL: Record<string, string> = {
  easy: "Easy run",
  quality: "Quality session",
  long: "Long run",
  race: "Race",
  rest: "Rest day",
  other: "Other",
};

/** What the athlete says to the coach when today's plan has to change. */
export function sessionQuote(day: PrescribedDay, unit: UnitPreference): string {
  const parts = [
    weekdayLabel(day.date),
    DAY_TYPE_LABEL[day.dayType] ?? day.dayType,
    day.run ? formatDistance(day.run.distanceM, unit) : null,
  ].filter(Boolean);
  return `About today's session (${parts.join(", ")}): `;
}

/** Today's session, or what happens next when there is none. */
export function TodayCard({
  today,
  hasPlan,
  unit,
}: {
  today: PrescribedDay | null;
  hasPlan: boolean;
  unit: UnitPreference;
}) {
  if (!today) {
    return (
      <Card className="flex flex-col gap-1">
        <h2 className="m-0 text-xl font-semibold">Today</h2>
        <Muted>
          {hasPlan
            ? "Nothing is planned for today."
            : "There is no plan for this week yet. Coach Cade plans each week for you on Sunday, after your weekly check-in."}
        </Muted>
      </Card>
    );
  }

  const run = today.run;
  const shoes = meaningful(run?.shoes);
  const target = meaningful(run?.paceOrHr);
  const structure = meaningful(run?.structure);
  const strength = meaningful(today.strength);
  const note = meaningful(today.notes);

  return (
    <Card className="flex flex-col gap-3" aria-label="Today">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-semibold text-muted">
          Today · {weekdayLabel(today.date)}
        </p>
        <h2 className="m-0 text-2xl font-semibold">
          {run
            ? `${DAY_TYPE_LABEL[today.dayType] ?? today.dayType} · ${formatDistance(run.distanceM, unit)}`
            : (DAY_TYPE_LABEL[today.dayType] ?? "Rest day")}
        </h2>
      </div>

      {structure ? <p className="m-0">{structure}</p> : null}
      <LabelValueList
        items={[
          ["Effort", target],
          ["Shoes", shoes],
          ["Strength", strength],
        ]}
      />
      {note ? <p className="m-0 text-muted">{note}</p> : null}

      <div>
        <ButtonLink
          href={`/chat?about=${encodeURIComponent(sessionQuote(today, unit))}`}
          variant="secondary"
        >
          Something came up
        </ButtonLink>
      </div>
    </Card>
  );
}
