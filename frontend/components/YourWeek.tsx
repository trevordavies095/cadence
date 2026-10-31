"use client";

import { useEffect, useState } from "react";
import {
  fetchRecapSection,
  fetchWeekRecap,
  type SubjectiveAnswers,
  type UnitPreference,
} from "@/lib/api";
import { STRENGTH_LABEL, strengthText } from "@/lib/checkIn";
import { describeError, type UiError } from "@/lib/errors";
import { distanceLabel, durationLabel, localYmd, paceLabel } from "@/lib/units";
import { isoWeekRangeLabel } from "@/lib/weekLabel";
import { Card, ErrorNote, LabelValueList, Muted, Notice, cx } from "./ui";

type SummaryRow = {
  metric: string;
  thisWeek: string;
  prevWeek: string;
  threeWkAvg: string;
  delta: string;
};
type Summary = { unit: UnitPreference; rows: SummaryRow[] };
type Zones = {
  distribution: {
    zonePct: { z1: number; z2: number; z3: number; z4: number; z5: number };
    z1z2Pct: number;
    z1z2TargetMet: boolean | null;
    noHrTimeSeriesInWeek: boolean;
  };
};
type RunRow = {
  workoutId: string;
  startedAt: string;
  titleDate: string;
  runType: string | null;
  distanceM: number;
  durationS: number;
  avgPaceS: number;
  avgHeartRateBpm: number | null;
  drift: { driftBpm: number } | null;
  weather: string | null;
  shoe: { label: string } | null;
};
type Runs = { unit: UnitPreference; runs: RunRow[] };
type Trends = {
  trends: {
    included: boolean;
    weekLabels: string[];
    easyPaceSecPerKm: Array<number | null>;
    avgEasyHr: Array<number | null>;
    longRunDistanceM: Array<number | null>;
  };
};
type Notable = { notable: { bullets: string[] } };

const ZONES = ["z1", "z2", "z3", "z4", "z5"] as const;
const ZONE_BG: Record<(typeof ZONES)[number], string> = {
  z1: "bg-hr-zone-1",
  z2: "bg-hr-zone-2",
  z3: "bg-hr-zone-3",
  z4: "bg-hr-zone-4",
  z5: "bg-hr-zone-5",
};

function Table({
  head,
  children,
  label,
}: {
  head: string[];
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        aria-label={label}
        className="w-full border-collapse text-left tabular-nums"
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={cx(
                  "border-b border-line-strong px-3 py-2 text-[0.8125rem] font-semibold uppercase tracking-[0.07em] text-muted first:pl-0",
                  i > 0 && "text-right whitespace-nowrap",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** The row-label column: left-aligned, free to wrap. */
const cell = "border-b border-border px-3 py-2 first:pl-0";
/** Numeric cells: right-aligned, tabular, kept on one line. */
const num = cx(cell, "text-right tabular-nums whitespace-nowrap");

function ZoneBar({ zones }: { zones: Zones["distribution"] }) {
  if (zones.noHrTimeSeriesInWeek) {
    return <Muted>No heart rate data came in for this week.</Muted>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-tempo border border-border bg-raised p-4">
      <div
        className="relative flex h-5 w-full overflow-hidden rounded-md border border-border"
        role="img"
        aria-label={`Time in heart rate zones: ${ZONES.map(
          (z, i) => `zone ${i + 1} ${zones.zonePct[z]}%`,
        ).join(", ")}`}
      >
        {ZONES.map((z) =>
          zones.zonePct[z] > 0 ? (
            <div
              key={z}
              className={ZONE_BG[z]}
              style={{ width: `${zones.zonePct[z]}%` }}
            />
          ) : null,
        )}
        {/* The 80% easy-zone target. */}
        <div
          className="absolute inset-y-0 w-0.5 bg-ink"
          style={{ left: "80%" }}
          aria-hidden
        />
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm tabular-nums">
        {ZONES.map((z, i) => (
          <li key={z} className="flex items-center gap-1.5">
            <span className={cx("size-2 rounded-sm", ZONE_BG[z])} aria-hidden />
            Zone {i + 1} {zones.zonePct[z]}%
          </li>
        ))}
      </ul>
      <p className="m-0 text-muted">
        {zones.z1z2Pct}% of your time was in the two easiest zones.{" "}
        {zones.z1z2TargetMet === true
          ? "That meets the 80% target."
          : zones.z1z2TargetMet === false
            ? "The target is 80% or more."
            : null}
      </p>
    </div>
  );
}

function answerLines(a: SubjectiveAnswers["weekly"]): Array<[string, string]> {
  if (!a) return [];
  const rows: Array<[string, string]> = [];
  if (a.sleep_avg_hrs != null) {
    const range = a.sleep_range_hrs
      ? ` (from ${a.sleep_range_hrs[0]} to ${a.sleep_range_hrs[1]})`
      : "";
    rows.push(["Sleep", `About ${a.sleep_avg_hrs} hours a night${range}`]);
  }
  if (a.stress_level) rows.push(["Stress", a.stress_level]);
  const strength = strengthText(a.strength_sessions);
  if (strength) rows.push([STRENGTH_LABEL, strength]);
  if (a.body_check) rows.push(["How your body feels", a.body_check]);
  if (a.feeling_into_next_week) rows.push(["Going into next week", a.feeling_into_next_week]);
  if (a.questions_for_coach?.length) {
    rows.push(["Your questions", a.questions_for_coach.join(" · ")]);
  }
  return rows;
}

/** The week's report: numbers, zones, runs, trends, and the athlete's own check-in. */
export function YourWeek({
  weekSessionId,
  timezone,
}: {
  weekSessionId: string;
  timezone: string;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [zones, setZones] = useState<Zones | null>(null);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [notable, setNotable] = useState<Notable | null>(null);
  const [answers, setAnswers] = useState<SubjectiveAnswers | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [sum, zon, run, tre, not, gate] = await Promise.allSettled([
        fetchRecapSection<Summary>(weekSessionId, "summary"),
        fetchRecapSection<Zones>(weekSessionId, "zones"),
        fetchRecapSection<Runs>(weekSessionId, "run-by-run"),
        fetchRecapSection<Trends>(weekSessionId, "trends"),
        fetchRecapSection<Notable>(weekSessionId, "notable"),
        fetchWeekRecap(weekSessionId),
      ]);
      if (cancelled) return;
      if (sum.status === "fulfilled") setSummary(sum.value);
      if (zon.status === "fulfilled") setZones(zon.value);
      if (run.status === "fulfilled") setRuns(run.value);
      if (tre.status === "fulfilled") setTrends(tre.value);
      if (not.status === "fulfilled") setNotable(not.value);
      if (gate.status === "fulfilled" && gate.value.status === "report") {
        setAnswers(gate.value.subjectiveAnswers);
        setSkipped(gate.value.subjective === "skipped");
      } else if (gate.status === "rejected") {
        setError(describeError(gate.reason, "Couldn’t load your check-in answers."));
      }
      if (
        sum.status === "rejected" &&
        zon.status === "rejected" &&
        run.status === "rejected"
      ) {
        setError(
          describeError(sum.reason, "Couldn’t load your week. Try again in a minute."),
        );
      }
      setLoaded(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [weekSessionId]);

  const unit = summary?.unit ?? runs?.unit ?? "imperial";
  const answerByDate = new Map(answers?.runs.map((r) => [r.date, r]) ?? []);
  const checkIn = answerLines(answers?.weekly);

  if (!loaded) return <Muted>Loading your week…</Muted>;

  return (
    <div className="flex flex-col gap-6">
      <ErrorNote error={error} />

      {skipped ? (
        <Notice title="You skipped this week’s check-in">
          Coach Cade worked from your runs alone, without how the week felt to you.
        </Notice>
      ) : null}

      {summary ? (
        <Table
          label="This week in numbers"
          head={["", "This week", "Last week", "3-week average", "Change"]}
        >
          {summary.rows.map((r) => (
            <tr key={r.metric}>
              <th scope="row" className={cx(cell, "font-semibold")}>
                {r.metric}
              </th>
              <td className={num}>{r.thisWeek}</td>
              <td className={num}>{r.prevWeek}</td>
              <td className={num}>{r.threeWkAvg}</td>
              <td className={num}>{r.delta}</td>
            </tr>
          ))}
        </Table>
      ) : null}

      {zones ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 border-t-2 border-line-strong pt-3 text-lg font-semibold">Heart rate zones</h3>
          <ZoneBar zones={zones.distribution} />
        </div>
      ) : null}

      {runs && runs.runs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 border-t-2 border-line-strong pt-3 text-lg font-semibold">Your runs</h3>
          <Table
            label="Your runs"
            head={["Run", "Distance", "Time", "Pace", "Heart rate", "Heart rate drift"]}
          >
            {runs.runs.map((r) => {
              const mine = answerByDate.get(localYmd(r.startedAt, timezone));
              return (
                <tr key={r.workoutId} className="align-top">
                  <th scope="row" className={cx(cell, "font-semibold")}>
                    {r.titleDate}
                    <span className="block font-normal text-muted">
                      {r.runType ?? "Run"}
                      {r.shoe ? ` · ${r.shoe.label}` : ""}
                    </span>
                    <LabelValueList
                      size="compact"
                      className="mt-1 font-normal"
                      items={[
                        ["Effort", mine?.rpe != null ? `${mine.rpe}/10` : null],
                        ["Went", mine?.felt != null ? `${mine.felt}/10` : null],
                        ["Pain", mine?.pain],
                      ]}
                    />
                  </th>
                  <td className={num}>{distanceLabel(r.distanceM, unit)}</td>
                  <td className={num}>{durationLabel(r.durationS)}</td>
                  <td className={num}>{paceLabel(r.avgPaceS, unit)}</td>
                  <td className={num}>
                    {r.avgHeartRateBpm != null ? `${r.avgHeartRateBpm} bpm` : "–"}
                  </td>
                  <td className={num}>
                    {r.drift
                      ? `${r.drift.driftBpm > 0 ? "+" : ""}${r.drift.driftBpm} bpm${
                          r.drift.driftBpm > 10 ? " (high)" : ""
                        }`
                      : "–"}
                  </td>
                </tr>
              );
            })}
          </Table>
        </div>
      ) : null}

      {trends?.trends.included ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 border-t-2 border-line-strong pt-3 text-lg font-semibold">The last four weeks</h3>
          <Table
            label="The last four weeks"
            head={["", ...trends.trends.weekLabels.map((w) => isoWeekRangeLabel(w))]}
          >
            {(
              [
                [
                  "Easy-run pace",
                  trends.trends.easyPaceSecPerKm.map((v) =>
                    v == null ? "–" : paceLabel(v, unit),
                  ),
                ],
                [
                  "Easy-run heart rate",
                  trends.trends.avgEasyHr.map((v) => (v == null ? "–" : `${v} bpm`)),
                ],
                [
                  "Longest run",
                  trends.trends.longRunDistanceM.map((v) =>
                    v == null ? "–" : distanceLabel(v, unit),
                  ),
                ],
              ] as Array<[string, string[]]>
            ).map(([label, values]) => (
              <tr key={label}>
                <th scope="row" className={cx(cell, "font-semibold")}>
                  {label}
                </th>
                {values.map((v, i) => (
                  <td key={i} className={num}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </Table>
        </div>
      ) : null}

      {notable && notable.notable.bullets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 border-t-2 border-line-strong pt-3 text-lg font-semibold">Worth noting</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {notable.notable.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {checkIn.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 border-t-2 border-line-strong pt-3 text-lg font-semibold">Your check-in</h3>
          <Card>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
              {checkIn.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="font-semibold text-muted">{label}</dt>
                  <dd className="m-0">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

