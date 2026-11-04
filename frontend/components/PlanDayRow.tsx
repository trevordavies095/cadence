import type { PrescribedDay, UnitPreference } from "@/lib/api";
import {
  DAY_TYPE_LABEL,
  isNotARun,
  isNotFiled,
  meaningful,
  NO_PLAN_GIVEN,
  NOT_FILED_EXPLANATION,
  NOT_FILED_LABEL,
  notFiledSentence,
  planSentence,
  weekdayLabel,
} from "@/lib/planDay";
import { plannedRunLabel } from "@/lib/units";
import { AddDetails } from "./AddDetails";
import { LabelValueList } from "./ui";

/** The small mark on a day Cadence could not read yet, with what it means beneath. */
export function NotFiledMark() {
  return (
    <span className="flex flex-col gap-0.5" data-part="not-filed">
      <span
        className="self-start rounded-md border border-border px-2 py-0.5 text-sm font-semibold text-muted"
        title={NOT_FILED_EXPLANATION}
      >
        {NOT_FILED_LABEL}
      </span>
      <span className="text-sm text-muted">{NOT_FILED_EXPLANATION}</span>
    </span>
  );
}

/**
 * A day Cadence has no structure for: Coach Cade's sentence with the mark, or,
 * when the plan left the date out, a line saying so. No distance or time.
 */
function NotFiledBody({ day }: { day: PrescribedDay }) {
  const sentence = notFiledSentence(day);
  if (!sentence) {
    return (
      <p className="m-0 text-muted" data-part="no-plan-given">
        {NO_PLAN_GIVEN}
      </p>
    );
  }
  return (
    <>
      <p className="m-0" data-part="plan-line">
        {sentence}
      </p>
      <NotFiledMark />
    </>
  );
}

export function PlanDayRow({
  day,
  unit,
  isToday,
  onAddDetails,
}: {
  day: PrescribedDay;
  unit: UnitPreference;
  isToday: boolean;
  /**
   * The Plan page's "Add the details" for an unread day: resolves true once
   * the day is filled in (the page re-renders the row from the new plan),
   * false when Coach Cade could not. Absent elsewhere (the change card).
   */
  onAddDetails?: (date: string) => Promise<boolean>;
}) {
  const run = day.run;
  const strength = meaningful(day.strength);
  const notes = meaningful(day.notes);
  const shoes = meaningful(run?.shoes);
  const target = meaningful(run?.paceOrHr);
  // Checked first: an unread day is also an other day with no run.
  const notFiled = isNotFiled(day);
  // Strength, cross-training or a walk: the notes say what it is, in place of figures.
  const notRun = isNotARun(day);
  // A day read from Coach Cade's line: the amount Cadence read from it, then the
  // sentence. Its notes are the rest of that sentence, so they are not shown
  // again, and the Effort, Shoes and Strength rows are not filled for it.
  const sentence = planSentence(day);
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
        {/* An unread day has no day type worth naming; the body says what it is. */}
        {notFiled ? null : (
          <span className="text-muted">
            {DAY_TYPE_LABEL[day.dayType] ?? day.dayType}
          </span>
        )}
      </div>
      {notFiled ? (
        <>
          <NotFiledBody day={day} />
          {onAddDetails ? <AddDetails onAdd={() => onAddDetails(day.date)} /> : null}
        </>
      ) : sentence ? (
        <>
          {run ? (
            <p className="m-0" data-part="planned-amount">
              {plannedRunLabel(run, unit)}
            </p>
          ) : null}
          <p className="m-0" data-part="plan-line">
            {sentence}
          </p>
        </>
      ) : (
        <>
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
        </>
      )}
    </li>
  );
}
