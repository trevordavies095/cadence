import { pool } from "../db.js";
import type { TempoPort, TempoUnitPreference } from "../tempo/port.js";

/** Used until Tempo has been read at least once. */
export const DEFAULT_UNIT_PREFERENCE: TempoUnitPreference = "imperial";

function isUnit(value: unknown): value is TempoUnitPreference {
  return value === "metric" || value === "imperial";
}

/** Last unit preference read from Tempo, or null if it was never read. */
export async function getCachedUnitPreference(): Promise<TempoUnitPreference | null> {
  const result = await pool.query<{ unit_preference: string }>(
    "SELECT unit_preference FROM athlete_preferences WHERE id = 1",
  );
  const value = result.rows[0]?.unit_preference;
  return isUnit(value) ? value : null;
}

async function cacheUnitPreference(unit: TempoUnitPreference): Promise<void> {
  await pool.query(
    `
    INSERT INTO athlete_preferences (id, unit_preference, read_at)
    VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE
      SET unit_preference = EXCLUDED.unit_preference, read_at = NOW()
    `,
    [unit],
  );
}

/**
 * The athlete's units: read from Tempo and cached as the last known value.
 * When Tempo cannot be read, falls back to the cached value, then to miles.
 */
export async function resolveUnitPreference(
  tempoPort: TempoPort,
): Promise<TempoUnitPreference> {
  try {
    const settings = await tempoPort.getSettings();
    if (isUnit(settings.unitPreference)) {
      await cacheUnitPreference(settings.unitPreference);
      return settings.unitPreference;
    }
  } catch {
    // Fall through to the cache: a Tempo outage must not break the Plan page.
  }
  return (await getCachedUnitPreference()) ?? DEFAULT_UNIT_PREFERENCE;
}
