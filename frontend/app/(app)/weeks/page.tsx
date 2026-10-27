"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
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

export default function HistoryPage() {
  const [loaded, setLoaded] = useState(false);
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
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

  return (
    <Page>
      <PageHead>
        <PageTitle>History</PageTitle>
        <Muted>Your weeks, newest first.</Muted>
        {runsUnknown ? (
          <Muted>Your running log isn’t responding, so miles and runs are blank for now.</Muted>
        ) : null}
      </PageHead>

      {weeks.length === 0 ? (
        <Muted>No weeks yet.</Muted>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border text-sm text-muted">
              <th scope="col" className="py-2 pr-4 font-semibold">Week</th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                {unit === "metric" ? "Km" : "Miles"}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">Runs</th>
              <th scope="col" className="py-2 font-semibold">From Coach Cade</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.id} className="border-b border-border align-top">
                <th scope="row" className="py-3 pr-4 font-semibold whitespace-nowrap">
                  <Link href={`/review?week=${w.id}`} className="text-ink underline-offset-4 hover:underline">
                    {w.localRange}
                  </Link>
                  {w.id === currentId ? (
                    <span className="ml-2 rounded-md border border-border px-2 py-0.5 text-sm font-semibold">
                      This week
                    </span>
                  ) : null}
                </th>
                <td className="py-3 pr-4 text-right tabular-nums">
                  {w.actualDistanceM == null
                    ? "–"
                    : distanceLabel(w.actualDistanceM, unit).replace(/ (mi|km)$/, "")}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums">{w.runCount ?? "–"}</td>
                <td className="py-3 text-muted">{w.coachHeadline ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
