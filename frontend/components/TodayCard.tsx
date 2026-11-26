import type { HomeWeekDay, PrescribedDay, UnitPreference } from "@/lib/api";
import {
  DAY_TYPE_LABEL,
  isNotARun,
  isNotFiled,
  meaningful,
  nextRunLabel,
  NO_PLAN_GIVEN,
  notFiledSentence,
  planSentence,
  sessionLines,
  sessionQuote,
  weekdayLabel,
} from "@/lib/planDay";
import { distanceLabel, plannedRunLabel } from "@/lib/units";
import { NotFiledMark } from "./PlanDayRow";
import { ButtonLink, Card, LabelValueList, Muted } from "./ui";

/** The next run still to come this week, under a card that has nothing left to do today. */
function NextRun({ next, unit }: { next: HomeWeekDay | null; unit: UnitPreference }) {
  if (!next) return null;
  return (
    <p className="m-0 text-muted" data-part="next-run">
      Next: {nextRunLabel(next, unit)}
    </p>
  );
}

/**
 * Today's session, or what happens next when there is none. Once the running
 * log shows a run today the card says so, offers to tell Coach Cade how it
 * went, and keeps the session folded on the card: "done" is any run on the
 * date, so a warm-up saved on its own must not take the instructions away.
 */
export function TodayCard({
  today,
  hasPlan,
  unit,
  outcome,
  next,
}: {
  today: PrescribedDay | null;
  hasPlan: boolean;
  unit: UnitPreference;
  /** Today in Home's week: whether a run is in, and how far it went. */
  outcome?: HomeWeekDay | null;
  /** The next run still to come this week; shown when today has nothing left to run. */
  next?: HomeWeekDay | null;
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
        <NextRun next={next ?? null} unit={unit} />
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
  const done = outcome?.state === "done";
  // A rest day, a walk or strength, or a day Cadence could not read: nothing to run today.
  // An other day may still carry an amount ("Other, 20 min"); the running log never shows it done.
  const nothingToRun = notFiled || !run || today.dayType === "other" || today.dayType === "rest";

  const session = notFiled ? (
    unreadSentence ? (
      <NotFiledMark />
    ) : (
      <Muted>{NO_PLAN_GIVEN}.</Muted>
    )
  ) : sentence ? (
    // A day read from Coach Cade's line: the sentence says how to run it, a sentence to a line.
    <div className="flex flex-col gap-1.5" data-part="session">
      {sessionLines(sentence).map((line, i) => (
        <p key={i} className="m-0">
          {line}
        </p>
      ))}
    </div>
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
  );

  if (done) {
    const ran =
      outcome?.actualDistanceM != null && outcome.actualDistanceM > 0
        ? `${distanceLabel(outcome.actualDistanceM, unit)} run`
        : null;
    const planned = run && !nothingToRun ? `${plannedRunLabel(run, unit)} planned` : null;
    return (
      <Card className="flex flex-col gap-3" aria-label="Today">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm font-semibold text-muted">
            Today · {weekdayLabel(today.date)}
          </p>
          <h2 className="m-0 text-2xl font-semibold">
            {notFiled ? "Today’s run" : (DAY_TYPE_LABEL[today.dayType] ?? today.dayType)}
            <span className="text-ok"> · Done</span>
          </h2>
          {planned || ran ? (
            <p className="m-0 tabular-nums" data-part="planned-and-run">
              {[planned, ran].filter(Boolean).join(", ")}
            </p>
          ) : null}
        </div>

        <div>
          <ButtonLink
            href={`/chat?about=${encodeURIComponent(sessionQuote(today, unit))}`}
            variant="primary"
          >
            Tell Coach Cade how it went
          </ButtonLink>
        </div>

        <details data-part="todays-session">
          <summary className="cursor-pointer text-sm font-semibold text-muted">
            Today’s session
          </summary>
          <div className="mt-2 flex flex-col gap-3">{session}</div>
        </details>

        <NextRun next={next ?? null} unit={unit} />
      </Card>
    );
  }

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

      {session}

      <div>
        <ButtonLink
          href={`/chat?about=${encodeURIComponent(sessionQuote(today, unit))}`}
          variant="secondary"
        >
          Something came up
        </ButtonLink>
      </div>

      {nothingToRun ? <NextRun next={next ?? null} unit={unit} /> : null}
    </Card>
  );
}
