"use client";

import { useCallback, useEffect, useState } from "react";
import { HomeBanner } from "@/components/HomeBanner";
import { TodayCard } from "@/components/TodayCard";
import { WeekStrip } from "@/components/WeekStrip";
import {
  ErrorNote,
  Muted,
  Page,
  PageHead,
  PageTitle,
  SectionHeader,
  WaitingState,
} from "@/components/ui";
import { fetchHome, type HomeRead, type UnitPreference } from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";
import { distanceLabel, durationLabel } from "@/lib/units";
import { isoWeekRangeLabel } from "@/lib/weekLabel";

/**
 * The week so far against the plan. Minutes appear beside the distance when
 * some days are planned by time alone.
 */
function weekTotalsLine(t: {
  actualDistanceM: number;
  plannedDistanceM: number;
  plannedDurationS: number;
  unit: UnitPreference;
}): string {
  const actual = distanceLabel(t.actualDistanceM, t.unit);
  const minutes = t.plannedDurationS > 0 ? durationLabel(t.plannedDurationS) : null;
  if (t.plannedDistanceM > 0) {
    const planned = distanceLabel(t.plannedDistanceM, t.unit);
    return minutes
      ? `${actual} of ${planned} and ${minutes} planned`
      : `${actual} of ${planned} planned`;
  }
  return minutes ? `${actual} run so far, ${minutes} planned` : `${actual} run so far`;
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [home, setHome] = useState<HomeRead | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const read = await fetchHome();
        if (cancelled) return;
        setHome(read);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(
            describeError(err, "Couldn’t load this week. Try again in a minute."),
          );
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // While the coach is reading, look again so the banner follows along.
  const reading = home?.banner?.kind === "reply_pending";
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [reading]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  if (!ready) {
    return (
      <WaitingState>
        <p className="m-0">Loading your week…</p>
      </WaitingState>
    );
  }

  if (!home) {
    return (
      <Page flow>
        <PageTitle>Home</PageTitle>
        <ErrorNote error={error} />
        <Muted>Open Settings to connect your accounts, then refresh.</Muted>
      </Page>
    );
  }

  const hasWeek = home.week.length > 0;
  const hasPlan = home.week.some((d) => d.dayType !== null);
  const { actualDistanceM, plannedDistanceM } = home.totals;
  const plannedDurationS = home.totals.plannedDurationS ?? 0;

  return (
    <Page>
      <PageHead>
        {home.banner ? (
          <HomeBanner
            banner={home.banner}
            weekSessionId={home.weekSessionId}
            onChanged={refresh}
          />
        ) : null}

        <PageTitle>Home</PageTitle>
        <ErrorNote error={error} />
      </PageHead>

      {hasWeek ? (
        <>
          <TodayCard today={home.today} hasPlan={hasPlan} unit={home.units} />

          <section className="flex flex-col gap-3" aria-label="Your week so far">
            <SectionHeader
              title="This week"
              aside={home.isoWeek ? isoWeekRangeLabel(home.isoWeek) : null}
            />
            <WeekStrip week={home.week} unit={home.units} />
            {!home.tempoUnavailable ? (
              <p className="m-0 tabular-nums">
                {weekTotalsLine({
                  actualDistanceM,
                  plannedDistanceM,
                  plannedDurationS,
                  unit: home.units,
                })}
              </p>
            ) : (
              <Muted>
                Your running log can’t be reached right now, so only the plan is
                shown.
              </Muted>
            )}
          </section>
        </>
      ) : (
        <Muted>
          Once your accounts are connected and Coach Cade has your first
          answers, today’s run will show up here.
        </Muted>
      )}
    </Page>
  );
}
