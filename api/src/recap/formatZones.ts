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
    const flag =
      dist.z1z2TargetMet === false
        ? " **Below** typical marathon base target (≥80% Z1+Z2)."
        : dist.z1z2TargetMet === true
          ? " On target for ≥80% Z1+Z2."
          : "";
    lines.push(
      `Target for marathon base phase: **≥80% in Z1+Z2**. This week: **${dist.z1z2Pct}%**.${flag}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
