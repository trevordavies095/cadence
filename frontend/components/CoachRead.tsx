import { CoachText } from "@/components/CoachText";
import { CoachSurface, Muted, Notice } from "@/components/ui";
import type { PrescribedWeekRecord } from "@/lib/api";

/** A label inside Coach Cade's read: small, uppercase and quiet, one register below the app's. */
const EYEBROW = "m-0 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-muted";
const MEASURE = "max-w-[50ch]";

/** A flag title runs into its detail, so it ends with a full stop unless it has its own. */
function withStop(title: string): string {
  return /[.?!:]$/.test(title.trim()) ? title.trim() : `${title.trim()}.`;
}

/**
 * Coach Cade's read of a week, the same on Plan and on Your week: safety notices
 * first, never folded away, then on Coach Cade's surface the headline, what
 * Coach Cade is watching, the answers to the athlete's questions, and the rest
 * of the read under "The full read". Plans made before these parts show the
 * read as it was, with nothing folded.
 */
export function CoachRead({
  record,
  emptyText,
  fullReadOpen,
}: {
  record: Pick<PrescribedWeekRecord, "analysis" | "safetyCallouts" | "readSections">;
  /** Shown when there is no read; nothing is shown when left out. */
  emptyText?: string;
  /** Whether "The full read" starts open: yes while the read is fresh, no once the week is under way. */
  fullReadOpen: boolean;
}) {
  const sections = record.readSections;
  const headline = sections?.headline?.trim();
  const flags = sections?.flags ?? [];
  const answers = sections?.answers ?? [];
  const analysis = record.analysis?.trim();
  return (
    <>
      {(record.safetyCallouts ?? []).map((c) => (
        <Notice key={`${c.title}:${c.body}`} title={c.title} severity={c.severity ?? "info"}>
          {c.body}
        </Notice>
      ))}
      {headline || analysis ? (
        <CoachSurface className={sections ? "flex flex-col gap-4" : undefined}>
          {headline ? (
            <p className={`m-0 font-semibold ${MEASURE}`} data-part="headline">
              {headline}
            </p>
          ) : null}
          {flags.length > 0 ? (
            <section aria-label="Watching" className="flex flex-col gap-2">
              <h3 className={EYEBROW}>Watching</h3>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                {flags.map((f, i) => (
                  <li key={`${f.title}-${i}`} className={MEASURE}>
                    <strong className="font-semibold">{withStop(f.title)}</strong> {f.detail}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {answers.length > 0 ? (
            <section aria-label="Your questions" className="flex flex-col gap-3">
              <h3 className={EYEBROW}>Your questions</h3>
              {answers.map((a, i) => (
                <div key={`${a.question}-${i}`} className="flex flex-col gap-1">
                  <p className={`m-0 text-sm font-semibold text-muted ${MEASURE}`} data-part="question">
                    {a.question}
                  </p>
                  <CoachText>{a.answer}</CoachText>
                </div>
              ))}
            </section>
          ) : null}
          {analysis && sections ? (
            // Keyed on the default so switching weeks resets it rather than keeping the last toggle.
            <details key={String(fullReadOpen)} open={fullReadOpen} data-part="full-read">
              <summary className="cursor-pointer text-sm font-semibold text-muted">
                The full read
              </summary>
              <CoachText className="mt-3">{analysis}</CoachText>
            </details>
          ) : analysis ? (
            <CoachText>{analysis}</CoachText>
          ) : null}
        </CoachSurface>
      ) : emptyText ? (
        <Muted>{emptyText}</Muted>
      ) : null}
    </>
  );
}
