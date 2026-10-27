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
import { fetchHome, type HomeRead } from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";
import { distanceLabel } from "@/lib/units";
import { isoWeekRangeLabel } from "@/lib/weekLabel";

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
                {distanceLabel(actualDistanceM, home.units)}
                {plannedDistanceM > 0
                  ? ` of ${distanceLabel(plannedDistanceM, home.units)} planned`
                  : " run so far"}
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
