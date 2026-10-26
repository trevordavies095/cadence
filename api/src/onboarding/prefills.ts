import {
  TempoNotConfiguredError,
  type TempoHeartRateZones,
  type TempoPort,
  type TempoShoe,
  type TempoUnitPreference,
  type TempoWorkoutSummary,
} from "../tempo/port.js";

/** Compact recent-run hint for the onboarding interview (no GPS). */
export type OnboardingRecentRunHint = {
  id: string;
  startedAt: string;
  name: string | null;
  distanceM: number;
  durationS: number;
  runType: string | null;
};

export type OnboardingShoeHint = {
  id: string;
  brand: string;
  model: string;
  isRetired: boolean;
};

/**
 * Tempo-derived hints shown beside interview prompts.
 * Prefills are hints only — the athlete still answers in conversation.
 */
export type OnboardingPrefills = {
  available: boolean;
  unitPreference?: TempoUnitPreference;
  heartRateZones?: TempoHeartRateZones;
  defaultShoeId?: string | null;
  shoes?: OnboardingShoeHint[];
  recentTraining?: OnboardingRecentRunHint[];
  /** Present when Tempo could not be read (not configured / transport). */
  reason?: string;
};

function toShoeHint(shoe: TempoShoe): OnboardingShoeHint {
  return {
    id: shoe.id,
    brand: shoe.brand,
    model: shoe.model,
    isRetired: shoe.isRetired,
  };
}

function toRunHint(w: TempoWorkoutSummary): OnboardingRecentRunHint {
  return {
    id: w.id,
    startedAt: w.startedAt,
    name: w.name ?? null,
    distanceM: w.distanceM,
    durationS: w.durationS,
    runType: w.runType ?? null,
  };
}

/**
 * Best-effort Tempo prefills for onboarding. Never throws — gate still works
 * when Tempo is unset or unreachable.
 */
export async function buildOnboardingPrefills(
  tempoPort: TempoPort,
  options?: { recentLimit?: number },
): Promise<OnboardingPrefills> {
  const recentLimit = options?.recentLimit ?? 5;
  try {
    const [settings, shoes, workouts] = await Promise.all([
      tempoPort.getSettings(),
      tempoPort.listShoes({ status: "active" }),
      tempoPort.listWorkouts({
        page: 1,
        pageSize: recentLimit,
        sortBy: "startedAt",
        sortOrder: "desc",
      }),
    ]);

    return {
      available: true,
      unitPreference: settings.unitPreference,
      heartRateZones: settings.heartRateZones,
      defaultShoeId: settings.defaultShoeId ?? null,
      shoes: shoes.map(toShoeHint),
      recentTraining: workouts.items.map(toRunHint),
    };
  } catch (err) {
    if (err instanceof TempoNotConfiguredError) {
      return { available: false, reason: "tempo_not_configured" };
    }
    const message = err instanceof Error ? err.message : "tempo_unavailable";
    return { available: false, reason: message };
  }
}
