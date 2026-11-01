import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SecretProtector } from "../src/crypto/secretProtector.js";
import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { readSelfHostedApiKey } from "../src/settings/selfHostedStore.js";
import type { RuntimeSources } from "../src/settings/sources.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

const FIRST_KEY = "omlx-local-key-first-ab12";
const SECOND_KEY = "omlx-local-key-second-cd34";

function appFor(sources?: RuntimeSources) {
  return createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY, sources });
}

function put(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/settings/self-hosted", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type StoredRow = {
  base_url: string;
  api_key_ciphertext: Buffer | null;
  api_key_last4: string | null;
};

async function storedRows(): Promise<StoredRow[]> {
  const { rows } = await pool.query<StoredRow>(
    `SELECT base_url, api_key_ciphertext, api_key_last4 FROM self_hosted_connection`,
  );
  return rows;
}

/** What a later server-side call (the adapter) reads back as the key. */
function savedKey() {
  return readSelfHostedApiKey(new SecretProtector(TEST_DATA_PROTECTION_KEY));
}

describe("self-hosted model server connection", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("is behind the disclaimer", async () => {
    const res = await appFor().request("/settings/self-hosted");
    expect(res.status).toBe(403);
  });

  it("shows nothing saved as not configured, with nulls", async () => {
    await acceptAndReady();
    const res = await appFor().request("/settings/self-hosted");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      configured: false,
      baseUrl: null,
      keyConfigured: false,
      maskedKey: null,
      updatedAt: null,
    });
  });

  it("saves a base URL and key, then shows the URL and a masked key, never the key", async () => {
    await acceptAndReady();
    const app = appFor();

    const saved = await put(app, { baseUrl: "http://192.168.1.20:8000/", apiKey: FIRST_KEY });
    expect(saved.status).toBe(200);
    const savedBody = await json(saved);
    expect(savedBody).toMatchObject({
      configured: true,
      baseUrl: "http://192.168.1.20:8000",
      keyConfigured: true,
      maskedKey: "••••ab12",
    });
    expect(typeof savedBody.updatedAt).toBe("string");
    expect(JSON.stringify(savedBody)).not.toContain(FIRST_KEY);

    const view = await json(await app.request("/settings/self-hosted"));
    expect(view).toEqual(savedBody);
    expect(view).not.toHaveProperty("apiKey");

    const [row] = await storedRows();
    expect(row!.base_url).toBe("http://192.168.1.20:8000");
    expect(row!.api_key_last4).toBe("ab12");
    const cipher = Buffer.from(row!.api_key_ciphertext!);
    expect(cipher.length).toBeGreaterThan(20);
    expect(cipher.toString("utf8")).not.toContain(FIRST_KEY);
  });

  it("saves a connection with no key", async () => {
    await acceptAndReady();
    const res = await put(appFor(), { baseUrl: "https://models.example.test" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      configured: true,
      baseUrl: "https://models.example.test",
      keyConfigured: false,
      maskedKey: null,
    });
    expect(await storedRows()).toEqual([
      { base_url: "https://models.example.test", api_key_ciphertext: null, api_key_last4: null },
    ]);
  });

  it("keeps a base URL already ending in /v1 as given, once", async () => {
    await acceptAndReady();
    const app = appFor();
    const res = await put(app, { baseUrl: "http://localhost:8000/v1/" });
    expect(res.status).toBe(200);
    expect((await json(res)).baseUrl).toBe("http://localhost:8000/v1");

    const plain = await put(app, { baseUrl: "http://localhost:8000/v1" });
    expect((await json(plain)).baseUrl).toBe("http://localhost:8000/v1");
  });

  it.each([
    ["not a URL", "not a url"],
    ["a relative path", "/v1"],
    ["a host without a scheme", "localhost:8000"],
    ["another scheme", "ftp://models.example.test"],
    ["an empty string", "   "],
    ["not a string", 8000],
  ])("refuses %s as the base URL with a 400 and saves nothing", async (_label, baseUrl) => {
    await acceptAndReady();
    const res = await put(appFor(), { baseUrl, apiKey: FIRST_KEY });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(await storedRows()).toEqual([]);
  });

  it("refuses a key that is not text", async () => {
    await acceptAndReady();
    const res = await put(appFor(), { baseUrl: "http://localhost:8000", apiKey: 1234 });
    expect(res.status).toBe(400);
    expect(await storedRows()).toEqual([]);
  });

  it("keeps the saved key when a later save omits it", async () => {
    await acceptAndReady();
    const app = appFor();
    await put(app, { baseUrl: "http://localhost:8000", apiKey: FIRST_KEY });

    const res = await put(app, { baseUrl: "http://localhost:9000" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      baseUrl: "http://localhost:9000",
      keyConfigured: true,
      maskedKey: "••••ab12",
    });
    expect(await savedKey()).toBe(FIRST_KEY);
  });

  it("replaces the saved key with a new one", async () => {
    await acceptAndReady();
    const app = appFor();
    await put(app, { baseUrl: "http://localhost:8000", apiKey: FIRST_KEY });

    const res = await put(app, { baseUrl: "http://localhost:8000", apiKey: SECOND_KEY });
    expect((await json(res)).maskedKey).toBe("••••cd34");
    expect(await savedKey()).toBe(SECOND_KEY);
  });

  it("removes the saved key when a later save sends an empty key", async () => {
    await acceptAndReady();
    const app = appFor();
    await put(app, { baseUrl: "http://localhost:8000", apiKey: FIRST_KEY });

    const res = await put(app, { baseUrl: "http://localhost:8000", apiKey: "" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      configured: true,
      baseUrl: "http://localhost:8000",
      keyConfigured: false,
      maskedKey: null,
    });
    expect(await savedKey()).toBeNull();
    const [row] = await storedRows();
    expect(row).toMatchObject({ api_key_ciphertext: null, api_key_last4: null });
  });

  it("delete removes the connection", async () => {
    await acceptAndReady();
    const app = appFor();
    await put(app, { baseUrl: "http://localhost:8000", apiKey: FIRST_KEY });

    const del = await app.request("/settings/self-hosted", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await json(del)).toMatchObject({ configured: false, baseUrl: null });
    expect(await storedRows()).toEqual([]);
    expect((await json(await app.request("/settings/self-hosted"))).configured).toBe(false);
  });

  it.each<[string, RuntimeSources]>([
    ["demo", { tempo: "export", model: "stub", demo: true }],
    ["stub", { tempo: "connection", model: "stub", demo: false }],
  ])("accepts writes in %s mode", async (_label, sources) => {
    await acceptAndReady();
    const app = appFor(sources);

    const res = await put(app, { baseUrl: "http://localhost:8000", apiKey: FIRST_KEY });
    expect(res.status).toBe(200);
    expect((await json(res)).configured).toBe(true);
    expect(await storedRows()).toHaveLength(1);

    const del = await app.request("/settings/self-hosted", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await storedRows()).toEqual([]);
  });
});
