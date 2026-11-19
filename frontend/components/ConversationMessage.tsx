"use client";

import { CoachText } from "@/components/CoachText";
import { NoteCard } from "@/components/NoteCard";
import { PlanDayRow } from "@/components/PlanDayRow";
import { ButtonLink, Notice, cx } from "@/components/ui";
import type { PrescribedDay, ThreadMessage, UnitPreference, WorkoutAttachment } from "@/lib/api";
import { dayLabel, runTypeLabel } from "@/lib/checkIn";
import { messageWhen } from "@/lib/time";
import { distanceLabel, durationLabel, localYmd, paceLabel } from "@/lib/units";

const ROLE_LABEL: Record<string, string> = {
  athlete: "You",
  coach: "Coach Cade",
  system: "Note",
};

/** A run attached to a message: what the coach was shown, with no map. */
export function RunCard({
  attachment,
  unit,
  timeZone,
}: {
  attachment: WorkoutAttachment;
  unit: UnitPreference;
  timeZone?: string;
}) {
  const title = attachment.activityName?.trim() || runTypeLabel(attachment.runType ?? null);
  const date = timeZone
    ? dayLabel(localYmd(attachment.startedAt, timeZone))
    : new Date(attachment.startedAt).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
  const bits = [
    date,
    distanceLabel(attachment.distanceM, unit),
    durationLabel(attachment.durationS),
    paceLabel(attachment.avgPaceS, unit),
    attachment.avgHeartRateBpm != null ? `${attachment.avgHeartRateBpm} bpm avg` : null,
    attachment.maxHeartRateBpm != null ? `${attachment.maxHeartRateBpm} bpm max` : null,
  ].filter(Boolean);
  const splits = attachment.splits ?? [];
  return (
    <div
      className="mt-1 flex flex-col gap-0.5 border-l-4 border-ink bg-canvas px-3 py-2"
      aria-label="Attached run"
    >
      <p className="m-0 font-semibold">{title}</p>
      <p className="m-0 text-muted">{bits.join(" · ")}</p>
      {splits.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-sm font-semibold text-muted">Splits</summary>
          <SplitsTable splits={splits} unit={unit} />
        </details>
      ) : null}
    </div>
  );
}

const SPLIT_HEAD = "border-b border-line-strong px-3 py-1.5 text-right text-[0.8125rem] font-semibold uppercase tracking-[0.07em] text-muted first:pl-0 first:text-left";
const SPLIT_CELL = "whitespace-nowrap border-b border-border px-3 py-1.5 text-right first:pl-0 first:text-left";

/** The run's splits as the athlete's watch recorded them, in the athlete's units. */
function SplitsTable({
  splits,
  unit,
}: {
  splits: NonNullable<WorkoutAttachment["splits"]>;
  unit: UnitPreference;
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table aria-label="Splits" className="w-full border-collapse tabular-nums">
        <thead>
          <tr>
            {["Split", "Distance", "Pace", "Heart rate"].map((h) => (
              <th key={h} scope="col" className={SPLIT_HEAD}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {splits.map((s, i) => (
            <tr key={s.idx ?? i}>
              <td className={SPLIT_CELL}>{(s.idx ?? i) + 1}</td>
              <td className={SPLIT_CELL}>{s.distanceM != null ? distanceLabel(s.distanceM, unit) : "–"}</td>
              <td className={SPLIT_CELL}>{s.paceS != null ? paceLabel(s.paceS, unit) : "–"}</td>
              <td className={SPLIT_CELL}>{s.avgHeartRateBpm != null ? `${s.avgHeartRateBpm} bpm` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Thu", "Thu and Sun", "Tue, Thu and Sun". */
function dayNames(days: PrescribedDay[]): string {
  const names = days.map((d) =>
    new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" }),
  );
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The days Coach Cade changed in this reply, as they were changed then. */
export function PlanChangeCard({ days, unit }: { days: PrescribedDay[]; unit: UnitPreference }) {
  const heading = `Coach Cade changed ${dayNames(days)}`;
  return (
    <section
      aria-label={heading}
      className="mt-2 flex flex-col gap-2 rounded-tempo border border-border bg-raised px-4 py-3"
    >
      <p className="m-0 font-semibold">{heading}</p>
      <ol className="m-0 flex list-none flex-col gap-3 p-0 [&>li:last-child]:border-b-0 [&>li:last-child]:pb-0">
        {days.map((day) => (
          <PlanDayRow key={day.date} day={day} unit={unit} isToday={false} />
        ))}
      </ol>
    </section>
  );
}


/**
 * The conversation reads like texting: the athlete's words on the right in ink, Coach
 * Cade's on the left on its paper. The side says who is speaking, so no message carries
 * a name (ADR 0001, status note of 2026-11-04). The corner nearest the speaker is tighter.
 */
const BUBBLE = "min-w-0 rounded-[1.125rem] break-words";
export const ATHLETE_BUBBLE = cx(
  BUBBLE,
  "max-w-[80%] rounded-br-[0.25rem] bg-ink px-3.5 py-2 text-inverse",
);
/** Wider than the athlete's: Coach Cade writes paragraphs, and a table takes the whole bubble. */
export const COACH_BUBBLE = cx(
  BUBBLE,
  "max-w-[calc(100%-1.5rem)] rounded-bl-[0.25rem] border border-border bg-coach-bg px-4 py-2.5 has-[table]:w-full",
);

/** Longer than this between two messages, and the later one says when it was sent. */
const TIME_GAP_MS = 60 * 60 * 1000;

/** One message in the conversation, the same wherever the conversation is shown. */
function ConversationMessage({
  message,
  unit,
  timeZone,
  timed,
  joined,
  onNoteChange,
}: {
  message: ThreadMessage;
  unit: UnitPreference;
  timeZone?: string;
  /** Show when it was sent: the first message, and the first after a long gap. */
  timed: boolean;
  /** It follows a message from the same side, so it sits close under it. */
  joined: boolean;
  /** Called after a note card in this message changed something, so the page can look again. */
  onNoteChange?: () => void;
}) {
  const when = messageWhen(message.createdAt, timeZone);
  const name = ROLE_LABEL[message.role] ?? "Coach Cade";
  const spacing = joined ? "mt-1 first:mt-0" : "mt-3 first:mt-0";
  // The time is shown only where the conversation paused. Everywhere else it is still
  // there for a screen reader, with the name the bubble's side stands in for.
  const stamp = (
    <header className={timed ? "self-center py-1 text-[0.8125rem] text-muted" : "sr-only"}>
      <span className="sr-only">{name}, </span>
      <time dateTime={message.createdAt} data-shown={timed ? "" : undefined}>
        {when}
      </time>
    </header>
  );

  if (message.role === "system") {
    return (
      <article data-role="system" className={cx("flex flex-col items-center gap-1", spacing)}>
        {stamp}
        <p className="m-0 max-w-[85%] whitespace-pre-wrap text-center text-sm text-muted">
          {message.body}
        </p>
      </article>
    );
  }

  if (message.role === "athlete") {
    return (
      <article data-role="athlete" className={cx("flex flex-col items-end gap-1.5", spacing)}>
        {stamp}
        <div data-bubble className={ATHLETE_BUBBLE} title={when}>
          <p className="m-0 whitespace-pre-wrap">{message.body}</p>
        </div>
        {message.attachment ? (
          <div className="max-w-full">
            <RunCard attachment={message.attachment} unit={unit} timeZone={timeZone} />
          </div>
        ) : null}
      </article>
    );
  }

  // Coach Cade's words are the bubble. What came with them (a link to the plan, notices,
  // changed days, a note) sits under it at full width, each as its own block.
  return (
    <article data-role="coach" className={cx("flex flex-col items-start gap-1.5", spacing)}>
      {stamp}
      <div data-bubble className={COACH_BUBBLE} title={when}>
        <CoachText>{message.body}</CoachText>
      </div>
      {message.kind === "weekly_read" ? (
        <ButtonLink
          href={
            message.readLink === "week" && message.weekSessionId
              ? `/review?week=${message.weekSessionId}`
              : "/plan"
          }
          variant="quiet"
        >
          Open the plan
        </ButtonLink>
      ) : null}
      {(message.safetyCallouts ?? []).map((c) => (
        <Notice
          key={`${c.title}:${c.body}`}
          title={c.title}
          severity={c.severity ?? "info"}
          className="self-stretch"
        >
          {c.body}
        </Notice>
      ))}
      {/* The Sunday message carries the plan's own notices, so the card says what the plan says. */}
      {message.kind === "weekly_read"
        ? (message.planWarnings ?? []).map((w) => (
            <Notice
              key={`${w.title}:${w.body}`}
              title={w.title}
              severity="caution"
              className="self-stretch"
            >
              {w.body}
            </Notice>
          ))
        : null}
      {message.planChanges && message.planChanges.length > 0 ? (
        <div className="self-stretch">
          <PlanChangeCard days={message.planChanges} unit={unit} />
        </div>
      ) : null}
      {message.attachment ? (
        <div className="self-stretch">
          <RunCard attachment={message.attachment} unit={unit} timeZone={timeZone} />
        </div>
      ) : null}
      {message.dossierProposal ? (
        <div className="self-stretch">
          <NoteCard
            note={message.dossierProposal}
            weekSessionId={message.weekSessionId}
            onChange={onNoteChange}
          />
        </div>
      ) : null}
    </article>
  );
}

/** A conversation's messages in order, the same wherever the conversation is shown. */
export function ConversationMessages({
  messages,
  unit,
  timeZone,
  onNoteChange,
}: {
  messages: ThreadMessage[];
  unit: UnitPreference;
  timeZone?: string;
  onNoteChange?: () => void;
}) {
  return messages.map((m, i) => {
    const before = messages[i - 1];
    const timed =
      !before || Date.parse(m.createdAt) - Date.parse(before.createdAt) > TIME_GAP_MS;
    return (
      <ConversationMessage
        key={m.id}
        message={m}
        unit={unit}
        timeZone={timeZone}
        timed={timed}
        joined={!timed && before?.role === m.role}
        onNoteChange={onNoteChange}
      />
    );
  });
}
