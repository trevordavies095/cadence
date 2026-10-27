import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import type { RuntimeSources } from "../src/settings/sources.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("encrypted connection settings", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("Tempo PUT encrypts at rest; GET never returns plaintext key", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const apiKey = "tmp_super_secret_key_xyz9";

    const put = await app.request("/settings/tempo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://localhost:5001",
        apiKey,
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await json(put);
    expect(putBody.configured).toBe(true);
    expect(putBody.baseUrl).toBe("http://localhost:5001");
    expect(putBody.maskedKey).toBe("••••xyz9");
    expect(JSON.stringify(putBody)).not.toContain(apiKey);

    const get = await json(await app.request("/settings/tempo"));
    expect(get.configured).toBe(true);
    expect(get.maskedKey).toBe("••••xyz9");
    expect(JSON.stringify(get)).not.toContain(apiKey);
    expect(get).not.toHaveProperty("apiKey");

    const row = await pool.query<{ api_key_ciphertext: Buffer }>(
      `SELECT api_key_ciphertext FROM tempo_connection WHERE id = 1`,
    );
    const cipher = row.rows[0]!.api_key_ciphertext;
    expect(Buffer.isBuffer(cipher) || cipher instanceof Uint8Array).toBe(true);
    const cipherBuf = Buffer.from(cipher);
    expect(cipherBuf.length).toBeGreaterThan(20);
    expect(cipherBuf.toString("utf8")).not.toContain(apiKey);

    const summary = await json(await app.request("/settings"));
    expect(summary.tempo).toMatchObject({ configured: true });
    expect(JSON.stringify(summary)).not.toContain(apiKey);

    const del = await app.request("/settings/tempo", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await json(del)).configured).toBe(false);
  });

  it("Anthropic PUT encrypts; GET never returns plaintext", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const apiKey = "sk-ant-test-key-not-live-abcd";

    const put = await app.request("/settings/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    expect(put.status).toBe(200);
    const putBody = await json(put);
    expect(putBody.configured).toBe(true);
    expect(putBody.maskedKey).toBe("••••abcd");
    expect(JSON.stringify(putBody)).not.toContain(apiKey);

    const get = await json(await app.request("/settings/anthropic"));
    expect(get.configured).toBe(true);
    expect(JSON.stringify(get)).not.toContain(apiKey);
    expect(get).not.toHaveProperty("apiKey");

    const del = await app.request("/settings/anthropic", { method: "DELETE" });
    expect((await json(del)).configured).toBe(false);
  });

  it("settings routes stay gated until disclaimer accept", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/settings/tempo")).status).toBe(403);
    expect((await app.request("/settings/anthropic")).status).toBe(403);
  });

  describe("key derivation rotation (ai-coach -> cadence)", () => {
    /** Reproduces the pre-rename derivation: HKDF strings "ai-coach:*". */
    function legacyEncrypt(plaintext: string, purpose: string): Buffer {
      const material = Buffer.from(TEST_DATA_PROTECTION_KEY, "base64");
      const master = Buffer.from(
        hkdfSync("sha256", material, Buffer.alloc(0), "ai-coach:master", 32),
      );
      const key = Buffer.from(
        hkdfSync(
          "sha256",
          master,
          Buffer.alloc(0),
          Buffer.from(`ai-coach:${purpose}`),
          32,
        ),
      );
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
    }

    async function seedLegacyRows(): Promise<void> {
      await pool.query(
        `INSERT INTO tempo_connection (id, base_url, api_key_ciphertext, api_key_last4)
         VALUES (1, 'http://localhost:5001', $1, 'ld01')`,
        [legacyEncrypt("tempo-old-key-ld01", "tempo-api-key")],
      );
      await pool.query(
        `INSERT INTO anthropic_connection (id, api_key_ciphertext, api_key_last4)
         VALUES (1, $1, 'ld02')`,
        [legacyEncrypt("legacy-anthropic-key-ld02", "anthropic-api-key")],
      );
    }

    async function put(
      app: ReturnType<typeof createApp>,
      path: string,
      body: object,
    ) {
      return app.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("wipes old-derivation keys once; new keys survive the next boot", async () => {
      await acceptAndReady();
      await seedLegacyRows();
      // resetAppTables cleared the marker, as on the first boot after upgrade.
      await migrate();

      const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
      const summary = await app.request("/settings");
      expect(summary.status).toBe(200);
      const body = await json(summary);
      expect(body.tempo).toMatchObject({ configured: false });
      expect(body.anthropic).toMatchObject({ configured: false });
      for (const path of ["/settings/tempo", "/settings/anthropic"]) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        expect((await json(res)).configured).toBe(false);
      }

      // New keys round-trip under the cadence derivation.
      expect(
        (
          await put(app, "/settings/tempo", {
            baseUrl: "http://localhost:5001",
            apiKey: "tempo-new-key-nw01",
          })
        ).status,
      ).toBe(200);
      expect(
        (await put(app, "/settings/anthropic", { apiKey: "fresh-anthropic-key-nw02" }))
          .status,
      ).toBe(200);
      const tempo = await json(await app.request("/settings/tempo"));
      expect(tempo).toMatchObject({ configured: true, maskedKey: "••••nw01" });
      const protector = new SecretProtector(TEST_DATA_PROTECTION_KEY);
      const trow = await pool.query<{ c: Buffer }>(
        `SELECT api_key_ciphertext AS c FROM tempo_connection WHERE id = 1`,
      );
      expect(
        protector.decrypt(Buffer.from(trow.rows[0]!.c), "tempo-api-key"),
      ).toBe("tempo-new-key-nw01");
      const arow = await pool.query<{ c: Buffer }>(
        `SELECT api_key_ciphertext AS c FROM anthropic_connection WHERE id = 1`,
      );
      expect(
        protector.decrypt(Buffer.from(arow.rows[0]!.c), "anthropic-api-key"),
      ).toBe("fresh-anthropic-key-nw02");

      // Next boot: marker present, so nothing is wiped.
      await migrate();
      const after = await json(await app.request("/settings"));
      expect(after.tempo).toMatchObject({ configured: true });
      expect(after.anthropic).toMatchObject({ configured: true });
    });
  });
});

describe("GET /settings reports the running sources (#6, #12)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
    await acceptAndReady();
  });

  async function summaryFor(sources: RuntimeSources) {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY, sources });
    return json(await app.request("/settings"));
  }

  it("offline: the export and the stub, with nothing saved", async () => {
    const summary = await summaryFor({ tempo: "export", model: "stub", demo: false });
    expect(summary).toMatchObject({
      tempo: { configured: false, source: "export" },
      anthropic: { configured: false, source: "stub" },
      demo: false,
    });
  });

  it("live: saved connections", async () => {
    const summary = await summaryFor({ tempo: "connection", model: "anthropic", demo: false });
    expect(summary).toMatchObject({
      tempo: { source: "connection" },
      anthropic: { source: "anthropic" },
      demo: false,
    });
  });

  it("demo", async () => {
    const summary = await summaryFor({ tempo: "export", model: "stub", demo: true });
    expect(summary.demo).toBe(true);
  });
});
