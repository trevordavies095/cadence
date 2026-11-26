"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  cx,
  ErrorNote,
  Muted,
  Page,
  PageHead,
  PageTitle,
  WaitingState,
} from "@/components/ui";
import {
  ensureCurrentWeek,
  fetchHome,
  fetchWeeks,
  type UnitPreference,
  type WeekSummary,
} from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";
import { distanceLabel } from "@/lib/units";

const figure = "tabular-nums whitespace-nowrap sm:py-3 sm:pr-4 sm:text-right";
/** The unit after a figure, from its data-unit, on a phone only. */
const phoneUnit =
  "after:ml-1 after:text-muted after:content-[attr(data-unit)] sm:after:content-none";

export default function HistoryPage() {
  const [loaded, setLoaded] = useState(false);
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentStart, setCurrentStart] = useState<string | null>(null);
  const [unit, setUnit] = useState<UnitPreference>("imperial");
  const [runsUnknown, setRunsUnknown] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const current = await ensureCurrentWeek();
        if (cancelled) return;
        setCurrentId(current.id);
        setCurrentStart(current.start);
        const data = await fetchWeeks();
        if (cancelled) return;
        setWeeks(data.weeks);
        setRunsUnknown(data.tempoUnavailable);
        setLoaded(true);
        // Distances follow the running log's units; imperial until they are known.
        try {
          const home = await fetchHome();
          if (!cancelled) setUnit(home.units);
        } catch {
          /* keep the default */
        }
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err, "Couldn’t load your weeks. Try again in a minute."));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return (
      <WaitingState>
        {error ? <ErrorNote error={error} /> : <p className="m-0">Loading your weeks…</p>}
      </WaitingState>
    );
  }

  // Next week's row exists as soon as its plan slot does. Until Coach Cade has
  // planned it, it has nothing to show, so it stays off the list.
  const shown = weeks.filter(
    (w) => currentStart == null || w.start <= currentStart || w.coachHeadline,
  );
  const unitShort = unit === "metric" ? "km" : "mi";

  return (
    <Page>
      <PageHead>
        <PageTitle>History</PageTitle>
        <Muted>Your weeks, newest first.</Muted>
        {runsUnknown ? (
          <Muted>Your running log isn’t responding, so miles and runs are blank for now.</Muted>
        ) : null}
      </PageHead>

      {shown.length === 0 ? (
        <Muted>No weeks yet.</Muted>
      ) : (
        // A table from the sm breakpoint up. On a phone each row stacks: the week,
        // its miles and runs on one line, then Coach Cade's line at full width.
        <table className="w-full border-collapse text-left">
          <thead className="hidden sm:table-header-group">
            <tr className="border-b border-line-strong text-[0.8125rem] font-semibold uppercase tracking-[0.07em] text-muted">
              <th scope="col" className="py-2 pr-4 font-semibold">Week</th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold whitespace-nowrap">
                {unit === "metric" ? "Km" : "Miles"}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold whitespace-nowrap">
                Runs
              </th>
              <th scope="col" className="py-2 font-semibold">From Coach Cade</th>
            </tr>
          </thead>
          <tbody className="block border-t border-line-strong sm:table-row-group sm:border-t-0">
            {shown.map((w) => (
              <tr
                key={w.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-3 align-top sm:table-row sm:py-0"
              >
                <th scope="row" className="w-full font-semibold whitespace-nowrap sm:w-auto sm:py-3 sm:pr-4">
                  <Link href={`/review?week=${w.id}`} className="text-ink underline-offset-4 hover:underline">
                    {w.localRange}
                  </Link>
                  {w.id === currentId ? (
                    <span className="ml-2 rounded-md border border-border px-2 py-0.5 text-sm font-semibold">
                      This week
                    </span>
                  ) : null}
                </th>
                {/* The column headings are hidden on a phone, so the figures carry their own units there. */}
                <td data-unit={unitShort} className={cx(figure, phoneUnit)}>
                  {w.actualDistanceM == null
                    ? "–"
                    : distanceLabel(w.actualDistanceM, unit).replace(/ (mi|km)$/, "")}
                </td>
                <td data-unit={w.runCount === 1 ? "run" : "runs"} className={cx(figure, phoneUnit)}>
                  {w.runCount ?? "–"}
                </td>
                <td className={w.coachHeadline ? "w-full text-muted sm:w-auto sm:py-3" : "hidden sm:table-cell sm:py-3"}>
                  {w.coachHeadline ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
