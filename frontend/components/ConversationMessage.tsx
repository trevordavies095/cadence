"use client";

import { CoachText } from "@/components/CoachText";
import { NoteCard } from "@/components/NoteCard";
import { CoachSurface, Notice, cx } from "@/components/ui";
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
  ].filter(Boolean);
  return (
    <div
      className="mt-1 flex flex-col gap-0.5 border-l-4 border-ink bg-canvas px-3 py-2"
      aria-label="Attached run"
    >
      <p className="m-0 font-semibold">{title}</p>
      <p className="m-0 text-muted">{bits.join(" · ")}</p>
    </div>
  );
}

/** One message in the conversation, the same wherever the conversation is shown. */
export function ConversationMessage({
  message,
  unit,
  timeZone,
}: {
  message: ThreadMessage;
  unit: UnitPreference;
  timeZone?: string;
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
      {(message.safetyCallouts ?? []).map((c) => (
        <Notice key={`${c.title}:${c.body}`} title={c.title} severity={c.severity ?? "info"}>
          {c.body}
        </Notice>
      ))}
      {message.attachment ? (
        <RunCard attachment={message.attachment} unit={unit} timeZone={timeZone} />
      ) : null}
      {message.dossierProposal ? (
        <NoteCard note={message.dossierProposal} weekSessionId={message.weekSessionId} />
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
