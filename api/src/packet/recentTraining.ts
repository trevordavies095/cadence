/**
 * What the packet says about the athlete's recent training, read from the
 * text it carries: the packet has no numeric fields for recent weekly
 * distance or the longest recent run, only the weekly report's markdown (the
 * Summary table's Distance row, the Trends section's long-run line) and the
 * same in each recent-history week's report. The offline stub sizes its plan
 * from these, and the plan check (src/prescribed/planCheck.ts) judges a plan
 * against them. Pure: text in, metres out, null when the text does not say.
 */
import type { ModelPacket } from "./types.js";

const METERS_PER_MILE = 1609.344;

/** Meters from a report cell such as "42.00 km" or "26.10 mi"; null otherwise. */
export function parseDistanceCell(cell: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(km|mi)\s*$/.exec(cell ?? "");
  if (!m) return null;
  const value = Number(m[1]);
  return m[2] === "mi" ? value * METERS_PER_MILE : value * 1000;
}

/**
 * The Distance row of a report's Summary table: this week and the 3-week
 * average. Reports stored before the row was renamed call it "Mileage".
 */
export function parseDistanceRow(
  md: string | null | undefined,
): { thisWeekM: number | null; threeWkAvgM: number | null } | null {
  const row = /^\|\s*(?:Distance|Mileage)\s*\|([^\n]*)$/m.exec(md ?? "");
  if (!row) return null;
  const cells = row[1]!.split("|").map((c) => c.trim());
  return {
    thisWeekM: parseDistanceCell(cells[0]),
    threeWkAvgM: parseDistanceCell(cells[2]),
  };
}

/**
 * The long-run line of a report's Trends section, over the last four weeks:
 * "- **Long-run distance** (...): 15.17 mi → 10.86 mi → 16.10 mi → 10.00 mi",
 * or "- **Longest run**: ..." when the week's longest run stands in. The
 * distances it lists, in metres; a week with no run ("—") is left out. Null
 * when the report has no such line.
 */
export function parseLongRunTrend(md: string | null | undefined): number[] | null {
  const line = /^\s*-\s*\*\*(?:Long-run distance|Longest run)\*\*[^:\n]*:\s*([^\n]*)$/m.exec(md ?? "");
  if (!line) return null;
  const distances: number[] = [];
  for (const m of line[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(km|mi)\b/g)) {
    const d = parseDistanceCell(`${m[1]} ${m[2]}`);
    if (d != null) distances.push(d);
  }
  return distances;
}

/**
 * The longest run (meters) of the recent weeks, from the report's long-run
 * trend line (the largest of the weeks it lists), else from the recent weeks'
 * reports' lines. Null when nothing says.
 */
export function longestRecentRunM(packet: ModelPacket): number | null {
  const own = parseLongRunTrend(packet.recapMarkdown);
  if (own && own.length > 0) return Math.max(...own);
  let longest: number | null = null;
  for (const w of packet.recentHistory ?? []) {
    const found = parseLongRunTrend(w.recapMarkdown);
    if (!found || found.length === 0) continue;
    const m = Math.max(...found);
    longest = longest == null ? m : Math.max(longest, m);
  }
  return longest;
}

/**
 * Average weekly distance (meters) over the last four weeks, from the report's
 * Distance row (this week plus the 3-week average of the weeks before), else
 * from this week and the recent weeks' reports. Null when nothing says.
 */
export function recentWeeklyDistanceM(packet: ModelPacket): number | null {
  const current = parseDistanceRow(packet.recapMarkdown);
  if (current?.thisWeekM != null && current.threeWkAvgM != null) {
    const avg = (current.thisWeekM + 3 * current.threeWkAvgM) / 4;
    return avg > 0 ? avg : null;
  }
  const weeks: number[] = [];
  if (current?.thisWeekM != null) weeks.push(current.thisWeekM);
  for (const w of packet.recentHistory ?? []) {
    if (weeks.length >= 4) break;
    const m = parseDistanceRow(w.recapMarkdown)?.thisWeekM;
    if (m != null) weeks.push(m);
  }
  if (weeks.length === 0) return null;
  const avg = weeks.reduce((a, b) => a + b, 0) / weeks.length;
  return avg > 0 ? avg : null;
}

/** Below this a week's distance counts as nothing run (report cells are rounded to 0.01). */
const NOTHING_RUN_M = 100;

/**
 * The plan check's recent weekly distance (meters): the average over this week
 * and the three before, leaving out weeks from before the athlete started.
 * The report's 3-week average counts a week with no runs as 0, and for a new
 * athlete the weeks before their first run are such weeks, so a careful first
 * plan would read as a big step up. The weeks before are rebuilt one by one:
 * the report's previous week, then the recent-history weeks' own reports (the
 * weeks the athlete has been on Cadence), the rest from the 3-week average. A
 * week older than Cadence's history with nothing run is taken as before the
 * start and left out; inside the history a week of nothing run is real and
 * counts. Null when the report has no Distance row; "no running before" when
 * no earlier week is left, the athlete's first week.
 */
export function runningWeeksAverageM(packet: ModelPacket): number | "no running before" | null {
  const row = parseDistanceRow(packet.recapMarkdown);
  if (row?.thisWeekM == null || row.threeWkAvgM == null) return recentWeeklyDistanceM(packet);
  const cells = /^\|\s*(?:Distance|Mileage)\s*\|([^\n]*)$/m.exec(packet.recapMarkdown ?? "")![1]!.split("|").map((c) => c.trim());
  const prevM = parseDistanceCell(cells[1]);
  const history = (packet.recentHistory ?? []).map((w) => parseDistanceRow(w.recapMarkdown)?.thisWeekM ?? null);
  // The three weeks before this one, newest first; null when only their sum is known.
  const before: Array<number | null> = [prevM ?? history[0] ?? null, history[1] ?? null, history[2] ?? null];
  const known = before.filter((m): m is number => m !== null);
  const unknown = before.length - known.length;
  const rest = Math.max(0, 3 * row.threeWkAvgM - known.reduce((a, b) => a + b, 0));
  for (let i = 0; i < before.length; i++) if (before[i] === null) before[i] = unknown ? rest / unknown : 0;
  // A week is on Cadence when the recent history reaches it (index 0 is the week before this).
  const kept = before.filter((m, i) => i < history.length || (m as number) >= NOTHING_RUN_M) as number[];
  if (kept.length === 0) return "no running before";
  const weeks = [row.thisWeekM, ...kept];
  return weeks.reduce((a, b) => a + b, 0) / weeks.length;
}
