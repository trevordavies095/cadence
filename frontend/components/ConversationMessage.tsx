"use client";

import { CoachText } from "@/components/CoachText";
import { NoteCard } from "@/components/NoteCard";
import { ButtonLink, CoachSurface, Notice, cx } from "@/components/ui";
import type { ThreadMessage, UnitPreference, WorkoutAttachment } from "@/lib/api";
import { dayLabel, runTypeLabel } from "@/lib/checkIn";
import { relativeWhen } from "@/lib/time";
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

/** One message in the conversation, the same wherever the conversation is shown. */
export function ConversationMessage({
  message,
  unit,
  timeZone,
  onNoteChange,
}: {
  message: ThreadMessage;
  unit: UnitPreference;
  timeZone?: string;
  /** Called after a note card in this message changed something, so the page can look again. */
  onNoteChange?: () => void;
}) {
  const isCoach = message.role === "coach";
  const content = (
    <>
      <header className="flex items-baseline gap-3">
        <span className={cx("font-semibold", isCoach && "text-accent")}>
          {ROLE_LABEL[message.role] ?? "Coach Cade"}
        </span>
        <time className="text-sm text-muted" dateTime={message.createdAt}>
          {relativeWhen(message.createdAt)}
        </time>
      </header>
      {isCoach ? (
        <CoachText>{message.body}</CoachText>
      ) : (
        <p className="m-0 whitespace-pre-wrap">{message.body}</p>
      )}
      {message.kind === "weekly_read" ? (
        <div>
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
        </div>
      ) : null}
      {(message.safetyCallouts ?? []).map((c) => (
        <Notice key={`${c.title}:${c.body}`} title={c.title} severity={c.severity ?? "info"}>
          {c.body}
        </Notice>
      ))}
      {message.attachment ? (
        <RunCard attachment={message.attachment} unit={unit} timeZone={timeZone} />
      ) : null}
      {message.dossierProposal ? (
        <NoteCard
          note={message.dossierProposal}
          weekSessionId={message.weekSessionId}
          onChange={onNoteChange}
        />
      ) : null}
    </>
  );
  // Coach Cade speaks on its own surface; the athlete's words and system notes stay on canvas.
  return isCoach ? (
    <CoachSurface as="article" data-role="coach" className="flex flex-col gap-1">
      {content}
    </CoachSurface>
  ) : (
    <article data-role={message.role} className="flex flex-col gap-1">
      {content}
    </article>
  );
}
