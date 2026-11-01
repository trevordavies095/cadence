import { Hono } from "hono";
import { SecretProtector } from "../crypto/secretProtector.js";
import { TESTED_COACH_MODEL } from "../llm/coachModel.js";
import { parseAnthropicEffort } from "../llm/effort.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  assertPacketHasNoPiiOrGps,
  getLastOutboundPacket,
} from "../packet/index.js";
import {
  deleteAnthropicConnection,
  getAnthropicConnection,
  putAnthropicConnection,
  readAnthropicApiKey,
} from "../settings/anthropicStore.js";
import {
  createCoachModelCatalogue,
  type CoachModelCatalogue,
} from "../settings/coachModelCatalogue.js";
import {
  clearCoachModel,
  getSavedCoachModel,
  parseCoachProvider,
  saveCoachModel,
  type SavedCoachProvider,
} from "../settings/coachModelStore.js";
import { testSelfHostedConnection } from "../settings/selfHostedConnectionTest.js";
import { createSelfHostedModelCatalogue } from "../settings/selfHostedModelCatalogue.js";
import {
  deleteSelfHostedConnection,
  getSelfHostedConnection,
  normalizeSelfHostedBaseUrl,
  putSelfHostedConnection,
  readSelfHostedApiKey,
  selfHostedHost,
} from "../settings/selfHostedStore.js";
import type { RuntimeSources } from "../settings/sources.js";
import {
  deleteTempoConnection,
  getTempoConnection,
  putTempoConnection,
} from "../settings/tempoStore.js";

export type SettingsRouteOptions = {
  /** Override wrapping key (tests). Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
  /** What the API is running with; an export or the stub needs no saved connection (#6). */
  sources: RuntimeSources;
  /** Injected fetch for the model listings, Anthropic's and the self-hosted server's (tests). */
  anthropicFetch?: typeof globalThis.fetch;
  /** Cap on a self-hosted Test connection probe (tests). Defaults to the self-hosted idle limit. */
  selfHostedTestTimeoutMs?: number;
};

// wired to resolveSelfHostedIdleTimeoutMs after ticket 05 merges
const SELF_HOSTED_TEST_TIMEOUT_MS = 600_000;

function protectorFrom(options: SettingsRouteOptions): SecretProtector {
  return new SecretProtector(options.dataProtectionKey);
}

type Catalogues = Record<SavedCoachProvider, CoachModelCatalogue>;

/** The saved model and effort when they belong to `provider`; nothing carries across providers. */
async function savedFor(provider: SavedCoachProvider) {
  const saved = await getSavedCoachModel();
  return saved?.provider === provider ? { model: saved.model, effort: saved.effort } : null;
}

/**
 * What Settings shows for Coach Cade's model: the provider, the choice, what is
 * in force, and what can be chosen from that provider's catalogue. `asked` names
 * another provider's catalogue, for the page before anything is saved for it; its
 * `saved` is then null, since nothing carries across providers.
 */
async function coachModelView(catalogues: Catalogues, asked?: SavedCoachProvider) {
  const provider = asked ?? (await getSavedCoachModel())?.provider ?? "anthropic";
  const saved = await savedFor(provider);
  const { models, fallback } = await catalogues[provider].load({ saved });
  return {
    provider,
    saved,
    effective: saved ?? TESTED_COACH_MODEL,
    tested: TESTED_COACH_MODEL,
    models,
    fallback,
  };
}

/** Which provider serves Coach Cade, and for self-hosted the server's hostname. */
async function coachProviderSummary() {
  const provider = (await getSavedCoachModel())?.provider ?? "anthropic";
  if (provider !== "self_hosted") return { provider, host: null };
  const connection = await getSelfHostedConnection();
  return { provider, host: connection.baseUrl ? selfHostedHost(connection.baseUrl) : null };
}

export function createSettingsRoutes(options: SettingsRouteOptions): Hono {
  const { sources } = options;
  const routes = new Hono();
  const catalogue = createCoachModelCatalogue({
    readApiKey: () => readAnthropicApiKey(protectorFrom(options)),
    fetchImpl: options.anthropicFetch,
  });
  const selfHostedCatalogue = createSelfHostedModelCatalogue({
    readConnection: async () => {
      const connection = await getSelfHostedConnection();
      if (!connection.baseUrl) return null;
      const apiKey = connection.keyConfigured
        ? await readSelfHostedApiKey(protectorFrom(options))
        : null;
      return { baseUrl: connection.baseUrl, apiKey };
    },
    fetchImpl: options.anthropicFetch,
  });
  const catalogues: Catalogues = { anthropic: catalogue, self_hosted: selfHostedCatalogue };

  routes.use("/settings", requireDisclaimer);
  routes.use("/settings/*", requireDisclaimer);

  routes.get("/settings", async (c) => {
    const [tempo, anthropic, coach] = await Promise.all([
      getTempoConnection(),
      getAnthropicConnection(),
      coachProviderSummary(),
    ]);
    return c.json({
      tempo: { ...tempo, source: sources.tempo },
      anthropic: { ...anthropic, source: sources.model },
      demo: sources.demo,
      provider: coach.provider,
      host: coach.host,
    });
  });

  routes.get("/settings/tempo", async (c) => {
    return c.json(await getTempoConnection());
  });

  routes.put("/settings/tempo", async (c) => {
    let body: { baseUrl?: unknown; apiKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!baseUrl || !apiKey) {
      return c.json({ error: "baseUrl_and_apiKey_required" }, 400);
    }
    try {
      new URL(baseUrl);
    } catch {
      return c.json({ error: "invalid_baseUrl" }, 400);
    }
    try {
      const view = await putTempoConnection(
        baseUrl.replace(/\/+$/, ""),
        apiKey,
        protectorFrom(options),
      );
      return c.json(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : "encrypt_failed";
      return c.json({ error: "encrypt_failed", message }, 500);
    }
  });

  routes.delete("/settings/tempo", async (c) => {
    await deleteTempoConnection();
    return c.json(await getTempoConnection());
  });

  routes.get("/settings/anthropic", async (c) => {
    return c.json(await getAnthropicConnection());
  });

  routes.put("/settings/anthropic", async (c) => {
    let body: { apiKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return c.json({ error: "apiKey_required" }, 400);
    }
    try {
      const view = await putAnthropicConnection(apiKey, protectorFrom(options));
      // A new key may reach different models.
      catalogue.forget();
      return c.json(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : "encrypt_failed";
      return c.json({ error: "encrypt_failed", message }, 500);
    }
  });

  routes.delete("/settings/anthropic", async (c) => {
    await deleteAnthropicConnection();
    catalogue.forget();
    return c.json(await getAnthropicConnection());
  });

  // The self-hosted model server. Like the coach-model routes, writes are accepted in
  // stub and demo modes; only the page hides the section.
  routes.get("/settings/self-hosted", async (c) => {
    return c.json(await getSelfHostedConnection());
  });

  routes.put("/settings/self-hosted", async (c) => {
    let body: { baseUrl?: unknown; apiKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
      return c.json(
        { error: "baseUrl_required", message: "Enter the model server's address." },
        400,
      );
    }
    const baseUrl = normalizeSelfHostedBaseUrl(body.baseUrl);
    if (!baseUrl) {
      return c.json(
        {
          error: "invalid_baseUrl",
          message: "The address must be a full http:// or https:// URL.",
        },
        400,
      );
    }
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
      return c.json(
        { error: "invalid_apiKey", message: "The key must be text, or empty to remove it." },
        400,
      );
    }
    try {
      const view = await putSelfHostedConnection(baseUrl, body.apiKey, protectorFrom(options));
      // Another server, or another key, may list other models.
      selfHostedCatalogue.forget();
      return c.json(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : "encrypt_failed";
      return c.json({ error: "encrypt_failed", message }, 500);
    }
  });

  routes.delete("/settings/self-hosted", async (c) => {
    await deleteSelfHostedConnection();
    selfHostedCatalogue.forget();
    return c.json(await getSelfHostedConnection());
  });

  // Test connection: `{ model }`. Lists the saved server's models, then sends the chosen
  // model a prompt of about 40k tokens and checks it arrived whole. Self-hosted only, so
  // it never spends money on an Anthropic key.
  routes.post("/settings/self-hosted/test", async (c) => {
    let body: { model?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const model = body && typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return c.json({ error: "model_required" }, 400);
    if ((await getSavedCoachModel())?.provider !== "self_hosted") {
      return c.json({ error: "not_self_hosted" }, 400);
    }
    const connection = await getSelfHostedConnection();
    if (!connection.baseUrl) {
      return c.json({ error: "no_self_hosted_connection" }, 400);
    }
    const apiKey = connection.keyConfigured
      ? await readSelfHostedApiKey(protectorFrom(options))
      : null;
    return c.json(
      await testSelfHostedConnection({
        baseUrl: connection.baseUrl,
        apiKey,
        model,
        fetchImpl: options.anthropicFetch ?? globalThis.fetch.bind(globalThis),
        timeoutMs: options.selfHostedTestTimeoutMs ?? SELF_HOSTED_TEST_TIMEOUT_MS,
      }),
    );
  });

  // Writes are accepted in stub and demo modes too: only the page hides the section,
  // and the demo season sets its effort through here.
  // `?provider=` asks for that provider's catalogue rather than the saved one's, so the
  // page can list a self-hosted server's models before a self-hosted model is saved.
  routes.get("/settings/coach-model", async (c) => {
    const query = c.req.query("provider");
    if (query === undefined) return c.json(await coachModelView(catalogues));
    const asked = parseCoachProvider(query);
    if (!asked) return c.json({ error: "invalid_provider" }, 400);
    return c.json(await coachModelView(catalogues, asked));
  });

  // `{ provider, model, effort }`. An omitted provider is Anthropic, as before #54.
  // The model is checked against the catalogue of the provider being saved, so a
  // model from the other provider's list is refused.
  routes.put("/settings/coach-model", async (c) => {
    let body: { provider?: unknown; model?: unknown; effort?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }
    const provider =
      body.provider === undefined ? "anthropic" : parseCoachProvider(body.provider);
    if (!provider) {
      return c.json({ error: "invalid_provider" }, 400);
    }
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model || typeof body.effort !== "string") {
      return c.json({ error: "model_and_effort_required" }, 400);
    }
    const effort = parseAnthropicEffort(body.effort);
    if (!effort) {
      return c.json({ error: "invalid_effort" }, 400);
    }
    if (provider === "self_hosted" && !(await getSelfHostedConnection()).configured) {
      return c.json({ error: "no_self_hosted_connection" }, 400);
    }
    // Self-hosted: the server's listing, or, when it fails, only the saved model.
    const { models } = await catalogues[provider].load({ saved: await savedFor(provider) });
    const choice = models.find((m) => m.id === model);
    if (!choice) {
      return c.json({ error: "unknown_model" }, 400);
    }
    if (!choice.efforts.includes(effort)) {
      return c.json({ error: "effort_not_supported" }, 400);
    }
    await saveCoachModel({ provider, model, effort });
    return c.json(await coachModelView(catalogues));
  });

  routes.delete("/settings/coach-model", async (c) => {
    await clearCoachModel();
    return c.json(await coachModelView(catalogues));
  });

  /**
   * Last redacted outbound model packet (issue #42).
   * Persisted after POST /packet (and future LlmPort sends).
   */
  routes.get("/settings/last-packet", async (c) => {
    const lastPacket = await getLastOutboundPacket();
    if (lastPacket) {
      assertPacketHasNoPiiOrGps(lastPacket.packet, {
        forbiddenSubstrings: ["LineString", "rawGpxData", "rawFitData"],
      });
    }
    return c.json({ lastPacket });
  });

  return routes;
}
