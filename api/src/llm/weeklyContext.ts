import type { ModelPacket } from "../packet/types.js";
import type { TempoUnitPreference } from "../tempo/port.js";
import type { WeeklyReplyContext } from "./schema.js";

/**
 * The athlete's distance unit as the packet carries it (the coaching block,
 * from the running log's settings); miles when the packet has none, as on
 * the Plan page before the running log was read (DEFAULT_UNIT_PREFERENCE).
 */
export function packetUnit(packet: ModelPacket): TempoUnitPreference {
  return packet.coaching?.unitPreference ?? "imperial";
}

/** The athlete's check-in questions, as they wrote them, from the weekly report. */
export function checkInQuestions(recapMarkdown: string | null | undefined): string[] {
  const md = recapMarkdown ?? "";
  const section = /^## Questions for coach\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(md);
  if (!section) return [];
  return section[1]!
    .split("\n")
    .map((line) => /^\s*\d+\.\s+(.*\S)\s*$/.exec(line)?.[1] ?? null)
    .filter((q): q is string => q !== null);
}

/** What Cadence reads the weekly form against, from the packet it sent. */
export function weeklyReplyContext(packet: ModelPacket): WeeklyReplyContext {
  return { unit: packetUnit(packet), questions: checkInQuestions(packet.recapMarkdown) };
}
