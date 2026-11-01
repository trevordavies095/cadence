import { pool } from "../db.js";
import type { CoachModel } from "../llm/coachModel.js";
import { parseAnthropicEffort } from "../llm/effort.js";

/** Who serves Coach Cade: Anthropic, or the athlete's own model server. */
export const COACH_PROVIDERS = ["anthropic", "self_hosted"] as const;

export type SavedCoachProvider = (typeof COACH_PROVIDERS)[number];

/** A provider value as sent by Settings, or null when it is not one of the two. */
export function parseCoachProvider(raw: unknown): SavedCoachProvider | null {
  return typeof raw === "string" && (COACH_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as SavedCoachProvider)
    : null;
}

/**
 * The saved coach setting: one provider, model and effort. Nothing is
 * remembered per provider; switching provider replaces the whole row.
 */
export type SavedCoachSetting = CoachModel & { provider: SavedCoachProvider };

/** The provider, model and effort the athlete saved, or null when they never chose (or reset). */
export async function getSavedCoachModel(): Promise<SavedCoachSetting | null> {
  const result = await pool.query<{ provider: string; model: string; effort: string }>(
    "SELECT provider, model, effort FROM coach_model_settings WHERE id = 1",
  );
  const row = result.rows[0];
  if (!row) return null;
  const effort = parseAnthropicEffort(row.effort);
  const provider = parseCoachProvider(row.provider);
  return effort && provider ? { provider, model: row.model, effort } : null;
}

export async function saveCoachModel(choice: SavedCoachSetting): Promise<void> {
  await pool.query(
    `
    INSERT INTO coach_model_settings (id, provider, model, effort, updated_at)
    VALUES (1, $1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE
      SET provider = EXCLUDED.provider, model = EXCLUDED.model,
          effort = EXCLUDED.effort, updated_at = NOW()
    `,
    [choice.provider, choice.model, choice.effort],
  );
}

/** Back to Anthropic at the tested default. */
export async function clearCoachModel(): Promise<void> {
  await pool.query("DELETE FROM coach_model_settings WHERE id = 1");
}
