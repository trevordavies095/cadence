import { TESTED_COACH_MODEL, type CoachModel } from "../llm/coachModel.js";
import { ANTHROPIC_EFFORT_LEVELS, type AnthropicEffort } from "../llm/effort.js";

export const TESTED_COACH_MODEL_DISPLAY_NAME = "Claude Opus 4.7";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";
const ANTHROPIC_VERSION = "2023-06-01";
const LIST_TIMEOUT_MS = 10_000;
/** How long a listing is reused before Anthropic is asked again. */
export const CATALOGUE_TTL_MS = 60 * 60_000;

/** One model the athlete can choose, with the efforts it accepts. */
export type CatalogueModel = {
  id: string;
  displayName: string;
  tested: boolean;
  efforts: AnthropicEffort[];
};

export type Catalogue = {
  models: CatalogueModel[];
  /**
   * Why only the fallback set is offered, or null when the list came from the
   * provider. `no_key` is Anthropic's; `no_connection` is the self-hosted one's.
   */
  fallback: "no_key" | "no_connection" | "unavailable" | null;
};

/** A model Anthropic lists, before the saved choice is merged in. */
type ListedModel = CatalogueModel & { createdAt: string };

type ModelsResponse = {
  data?: Array<{
    id?: unknown;
    display_name?: unknown;
    created_at?: unknown;
    capabilities?: {
      thinking?: { types?: { adaptive?: { supported?: unknown } } };
      effort?: Partial<Record<AnthropicEffort, { supported?: unknown }>>;
    };
  }>;
};

/**
 * Models that can take Cadence's request: adaptive thinking and at least one
 * effort level. Others (Haiku 4.5 and older use budget_tokens) are left out.
 */
function readListing(body: ModelsResponse): ListedModel[] {
  const listed: ListedModel[] = [];
  for (const m of body.data ?? []) {
    if (typeof m.id !== "string" || m.capabilities?.thinking?.types?.adaptive?.supported !== true) continue;
    const efforts = ANTHROPIC_EFFORT_LEVELS.filter(
      (level) => m.capabilities?.effort?.[level]?.supported === true,
    );
    if (efforts.length === 0) continue;
    listed.push({
      id: m.id,
      displayName: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
      tested: m.id === TESTED_COACH_MODEL.model,
      efforts,
      createdAt: typeof m.created_at === "string" ? m.created_at : "",
    });
  }
  return listed;
}

/**
 * Tested default first (added if the listing left it out), the rest newest
 * first, and the saved model kept even when the listing no longer has it.
 */
function mergeCatalogue(listed: ListedModel[], saved: CoachModel | null): CatalogueModel[] {
  const tested: CatalogueModel = listed.find((m) => m.tested) ?? {
    id: TESTED_COACH_MODEL.model,
    displayName: TESTED_COACH_MODEL_DISPLAY_NAME,
    tested: true,
    efforts: [...ANTHROPIC_EFFORT_LEVELS],
  };
  const rest = listed
    .filter((m) => !m.tested)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const models: CatalogueModel[] = [
    { id: tested.id, displayName: tested.displayName, tested: true, efforts: tested.efforts },
    ...rest.map(({ createdAt: _createdAt, ...m }) => m),
  ];
  if (saved && !models.some((m) => m.id === saved.model)) {
    models.push({ id: saved.model, displayName: saved.model, tested: false, efforts: [saved.effort] });
  }
  return models;
}

export type CoachModelCatalogue = {
  /** The models the athlete can choose now. */
  load(options: { saved: CoachModel | null }): Promise<Catalogue>;
  /** Forget the cached listing (the key or connection changed). */
  forget(): void;
};

/**
 * Lists the models the saved Anthropic key can use, from `GET /v1/models`,
 * cached in memory for an hour. With no key, or when the listing fails, offers
 * the fallback set: the tested default plus the saved model.
 */
export function createCoachModelCatalogue(options: {
  readApiKey: () => Promise<string | null>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}): CoachModelCatalogue {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  let cached: { listed: ListedModel[]; at: number } | null = null;

  async function list(apiKey: string): Promise<ListedModel[] | null> {
    if (cached && now() - cached.at < CATALOGUE_TTL_MS) return cached.listed;
    try {
      const res = await fetchImpl(ANTHROPIC_MODELS_URL, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const listed = readListing((await res.json()) as ModelsResponse);
      cached = { listed, at: now() };
      return listed;
    } catch {
      // A failed listing is not cached: the next visit to Settings asks again.
      return null;
    }
  }

  return {
    async load({ saved }) {
      const apiKey = await options.readApiKey();
      const listed = apiKey ? await list(apiKey) : null;
      return {
        models: mergeCatalogue(listed ?? [], saved),
        fallback: listed ? null : apiKey ? "unavailable" : "no_key",
      };
    },
    forget() {
      cached = null;
    },
  };
}
