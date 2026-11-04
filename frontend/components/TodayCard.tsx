import type { PrescribedDay, UnitPreference } from "@/lib/api";
import {
  DAY_TYPE_LABEL,
  isNotARun,
  isNotFiled,
  meaningful,
  NO_PLAN_GIVEN,
  notFiledSentence,
  planSentence,
  sessionQuote,
  weekdayLabel,
} from "@/lib/planDay";
import { plannedRunLabel } from "@/lib/units";
import { NotFiledMark } from "./PlanDayRow";
import { ButtonLink, Card, LabelValueList, Muted } from "./ui";

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
  // Checked first: a day Cadence could not read has nothing planned, only Coach Cade's sentence.
  const notFiled = isNotFiled(today);
  const unreadSentence = notFiledSentence(today);
  // Strength, cross-training or a walk: the notes say what the day is.
  const notRun = isNotARun(today);
  const sentence = planSentence(today);

  return (
    <Card className="flex flex-col gap-3" aria-label="Today">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-semibold text-muted">
          Today · {weekdayLabel(today.date)}
        </p>
        <h2 className="m-0 text-2xl font-semibold">
          {notFiled
            ? (unreadSentence ?? "No plan for today")
            : run
              ? `${DAY_TYPE_LABEL[today.dayType] ?? today.dayType} · ${plannedRunLabel(run, unit)}`
              : notRun
                ? "Not a run"
                : (DAY_TYPE_LABEL[today.dayType] ?? "Rest day")}
        </h2>
      </div>

      {notFiled ? (
        unreadSentence ? (
          <NotFiledMark />
        ) : (
          <Muted>{NO_PLAN_GIVEN}.</Muted>
        )
      ) : sentence ? (
        // A day read from Coach Cade's line: the sentence says how to run it.
        <p className="m-0">{sentence}</p>
      ) : (
        <>
          {notRun && note ? <p className="m-0">{note}</p> : null}

          {structure ? <p className="m-0">{structure}</p> : null}
          <LabelValueList
            items={[
              ["Effort", target],
              ["Shoes", shoes],
              ["Strength", strength],
            ]}
          />
          {note && !notRun ? <p className="m-0 text-muted">{note}</p> : null}
        </>
      )}

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
