// Mirror of frontend/lib/sleepParse.ts: tolerant parsing of free-text sleep answers.

const NUM = String.raw`\d+(?:\.\d+)?`;
const MAX_HOURS = 24;

/** "8.38 hrs" -> 8.38. Undefined when no number (or out of 0-24 range). */
export function parseSleepAvgHrs(text: string): number | undefined {
  const m = text.match(new RegExp(NUM));
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) && n <= MAX_HOURS ? n : undefined;
}

/** "7.65–9.08 h", "7.65-9.08", "7.65 to 9.08" -> [7.65, 9.08]. Needs two numbers. */
export function parseSleepRangeHrs(text: string): [number, number] | undefined {
  const m = text.match(new RegExp(`(${NUM})\\D+?(${NUM})`));
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  if (a > MAX_HOURS || b > MAX_HOURS) return undefined;
  return a <= b ? [a, b] : [b, a];
}
