import { Hono } from "hono";
import { SecretProtector } from "../crypto/secretProtector.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";
import {
  assertPacketHasNoPiiOrGps,
  getLastOutboundPacket,
} from "../packet/index.js";
import {
  deleteAnthropicConnection,
  getAnthropicConnection,
  putAnthropicConnection,
} from "../settings/anthropicStore.js";
import {
  deleteTempoConnection,
  getTempoConnection,
  putTempoConnection,
} from "../settings/tempoStore.js";

export type SettingsRouteOptions = {
  /** Override wrapping key (tests). Defaults to DATA_PROTECTION_SECRET_KEY. */
  dataProtectionKey?: string;
};

function protectorFrom(options?: SettingsRouteOptions): SecretProtector {
  return new SecretProtector(options?.dataProtectionKey);
}

export function createSettingsRoutes(options?: SettingsRouteOptions): Hono {
  const routes = new Hono();

  routes.use("/settings", requireDisclaimer);
  routes.use("/settings/*", requireDisclaimer);

  routes.get("/settings", async (c) => {
    const [tempo, anthropic] = await Promise.all([
      getTempoConnection(),
      getAnthropicConnection(),
    ]);
    return c.json({ tempo, anthropic });
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
      return c.json(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : "encrypt_failed";
      return c.json({ error: "encrypt_failed", message }, 500);
    }
  });

  routes.delete("/settings/anthropic", async (c) => {
    await deleteAnthropicConnection();
    return c.json(await getAnthropicConnection());
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

/** Default routes using process env for the wrapping key. */
export const settingsRoutes = createSettingsRoutes();
