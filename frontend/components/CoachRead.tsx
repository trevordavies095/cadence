import { CoachText } from "@/components/CoachText";
import { CoachSurface, Muted, Notice } from "@/components/ui";
import type { PrescribedWeekRecord } from "@/lib/api";

/**
 * Coach Cade's read of a week, the same on Plan and on Your week: safety notices
 * first, never folded away, then the read on Coach Cade's surface, opening with
 * its headline. Plans made before the headline show the read as it was.
 */
export function CoachRead({
  record,
  emptyText,
}: {
  record: Pick<PrescribedWeekRecord, "analysis" | "safetyCallouts" | "readSections">;
  /** Shown when there is no read; nothing is shown when left out. */
  emptyText?: string;
}) {
  const headline = record.readSections?.headline?.trim();
  const analysis = record.analysis?.trim();
  return (
    <>
      {(record.safetyCallouts ?? []).map((c) => (
        <Notice key={`${c.title}:${c.body}`} title={c.title} severity={c.severity ?? "info"}>
          {c.body}
        </Notice>
      ))}
      {headline || analysis ? (
        <CoachSurface className={headline ? "flex flex-col gap-3" : undefined}>
          {headline ? (
            <p className="m-0 max-w-[50ch] font-semibold" data-part="headline">
              {headline}
            </p>
          ) : null}
          {analysis ? <CoachText>{analysis}</CoachText> : null}
        </CoachSurface>
      ) : emptyText ? (
        <Muted>{emptyText}</Muted>
      ) : null}
    </>
  );
}
