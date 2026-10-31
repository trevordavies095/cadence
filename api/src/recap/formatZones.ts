import type { ZoneWeekDistribution } from "./zones.js";

const ZONE_BAR_WIDTH = 35;

function formatZoneDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function zoneAsciiLine(
  zoneLabel: string,
  pct: number,
  seconds: number,
): string {
  const filled = Math.round((ZONE_BAR_WIDTH * pct) / 100);
  const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, ZONE_BAR_WIDTH - filled))}`;
  return `${zoneLabel} ${bar}  ${pct}%   (${formatZoneDuration(seconds)})`;
}

/**
 * Markdown `## HR zone distribution (week total)` section (tempo-cli shape).
 * Always returns a section; empty/missing HR yields a note under the heading.
 */
export function buildZonesMarkdown(dist: ZoneWeekDistribution): string {
  const lines: string[] = [
    "## HR zone distribution (week total)",
    "",
  ];

  if (dist.totalHrSeconds <= 0 || !dist.zonePct) {
    lines.push(dist.note ?? "Zone distribution unavailable.");
    lines.push("");
    return lines.join("\n");
  }

  const zs = dist.zoneSeconds;
  const pct = dist.zonePct;
  for (let i = 0; i < zs.length; i++) {
    const zi = i + 1;
    const p = pct[`z${zi}`];
    if (p === undefined) continue;
    lines.push(zoneAsciiLine(`Z${zi}`, p, zs[i] ?? 0));
  }
  lines.push("");
  if (dist.z1z2Pct !== undefined) {
    lines.push(
      `Easy-running share: ${dist.z1z2Pct}% (zones 1 and 2 of time with heart rate).`,
    );
    // Target and verdict only when the goal sets one; never a goal it is not.
    if (dist.easyShareTarget !== null) {
      const verdict =
        dist.z1z2TargetMet === true
          ? " This week meets the target."
          : dist.z1z2TargetMet === false
            ? " This week is below the target."
            : "";
      lines.push(
        `Target for this block: ${dist.easyShareTarget}% or more.${verdict}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
