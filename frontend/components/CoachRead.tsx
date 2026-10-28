import { CoachText } from "@/components/CoachText";
import { CoachSurface, Muted, Notice } from "@/components/ui";
import type { PrescribedWeekRecord } from "@/lib/api";

/**
 * Coach Cade's read of a week, the same on Plan and on Your week: safety notices
 * first, never folded away, then the read on Coach Cade's surface.
 */
export function CoachRead({
  record,
  emptyText,
}: {
  record: Pick<PrescribedWeekRecord, "analysis" | "safetyCallouts">;
  /** Shown when there is no read; nothing is shown when left out. */
  emptyText?: string;
}) {
  return (
    <>
      {(record.safetyCallouts ?? []).map((c) => (
        <Notice key={`${c.title}:${c.body}`} title={c.title} severity={c.severity ?? "info"}>
          {c.body}
        </Notice>
      ))}
      {record.analysis?.trim() ? (
        <CoachSurface>
          <CoachText>{record.analysis}</CoachText>
        </CoachSurface>
      ) : emptyText ? (
        <Muted>{emptyText}</Muted>
      ) : null}
    </>
  );
}
