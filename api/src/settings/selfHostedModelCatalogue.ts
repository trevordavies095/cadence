import type { CoachModel } from "../llm/coachModel.js";
import { ANTHROPIC_EFFORT_LEVELS } from "../llm/effort.js";
import {
  CATALOGUE_TTL_MS,
  type CatalogueModel,
  type CoachModelCatalogue,
} from "./coachModelCatalogue.js";
import { selfHostedEndpoint } from "./selfHostedStore.js";

const LIST_TIMEOUT_MS = 10_000;

/** Where the saved model server is and the key it takes, if any. */
export type SelfHostedListingConnection = { baseUrl: string; apiKey: string | null };

type ModelsResponse = {
  data?: Array<{ id?: unknown; display_name?: unknown }>;
};

/**
 * Every listed id, as the server gives it (oMLX's `model:profile` ids such as
 * `qwen3-8b:thinking` included). The server decides what an effort means, so
 * each model offers all five; none has been measured, so none is tested.
 */
function readListing(body: ModelsResponse): CatalogueModel[] {
  const models: CatalogueModel[] = [];
  const seen = new Set<string>();
  for (const m of body?.data ?? []) {
    if (typeof m?.id !== "string" || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({
      id: m.id,
      displayName: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
      tested: false,
      efforts: [...ANTHROPIC_EFFORT_LEVELS],
    });
  }
  return models;
}

/** With no listing, only the saved model can be offered (or nothing). */
function fallbackModels(saved: CoachModel | null): CatalogueModel[] {
  return saved
    ? [{ id: saved.model, displayName: saved.model, tested: false, efforts: [...ANTHROPIC_EFFORT_LEVELS] }]
    : [];
}

/**
 * Lists the models installed on the athlete's own server, from its
 * `GET /v1/models`, cached in memory for the same hour as Anthropic's. With no
 * saved connection, or when the listing fails, offers only the saved model.
 * `saved` is the saved self-hosted model; the caller passes null when the
 * saved setting is for another provider.
 */
export function createSelfHostedModelCatalogue(options: {
  readConnection: () => Promise<SelfHostedListingConnection | null>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}): CoachModelCatalogue {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  let cached: { models: CatalogueModel[]; at: number } | null = null;

  async function list(connection: SelfHostedListingConnection): Promise<CatalogueModel[] | null> {
    if (cached && now() - cached.at < CATALOGUE_TTL_MS) return cached.models;
    const headers: Record<string, string> = {};
    if (connection.apiKey) {
      headers["x-api-key"] = connection.apiKey;
      headers.authorization = `Bearer ${connection.apiKey}`;
    }
    try {
      const res = await fetchImpl(selfHostedEndpoint(connection.baseUrl, "models"), {
        headers,
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const models = readListing((await res.json()) as ModelsResponse);
      cached = { models, at: now() };
      return models;
    } catch {
      // A failed listing is not cached: the next visit to Settings asks again.
      return null;
    }
  }

  return {
    async load({ saved }) {
      const connection = await options.readConnection();
      const listed = connection ? await list(connection) : null;
      return {
        models: listed ?? fallbackModels(saved),
        fallback: listed ? null : connection ? "unavailable" : "no_connection",
      };
    },
    forget() {
      cached = null;
    },
  };
}
