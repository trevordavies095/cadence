import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION } from "../src/disclaimer/text.js";
import { PRIVACY_COPY } from "../src/privacy/copy.js";
import { saveCoachModel } from "../src/settings/coachModelStore.js";
import { json, resetAppTables, TEST_DATA_PROTECTION_KEY } from "./helpers.js";

function app() {
  return createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
}

/** Coach Cade on the athlete's own model server at `baseUrl`. */
async function selfHostedAt(baseUrl: string) {
  await pool.query(
    `INSERT INTO self_hosted_connection (id, base_url) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET base_url = EXCLUDED.base_url`,
    [baseUrl],
  );
  await saveCoachModel({ provider: "self_hosted", model: "qwen3:thinking", effort: "high" });
}

async function privacy() {
  const res = await app().request("/privacy");
  expect(res.status).toBe(200);
  return json(res);
}

describe("privacy names the model server's host", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("Anthropic, with nothing saved: the copy is unchanged and there is no host", async () => {
    const body = await privacy();
    expect(body).toMatchObject({ ...PRIVACY_COPY, provider: "anthropic", host: null, onNetwork: null });
  });

  it("Anthropic, saved explicitly, with a self-hosted connection kept: still no host", async () => {
    await pool.query(
      `INSERT INTO self_hosted_connection (id, base_url) VALUES (1, 'http://192.168.1.20:8000')`,
    );
    await saveCoachModel({ provider: "anthropic", model: "claude-opus-4-7", effort: "xhigh" });
    const body = await privacy();
    expect(body).toMatchObject({ provider: "anthropic", host: null, onNetwork: null });
    expect(body.intro).toBe(PRIVACY_COPY.intro);
  });

  const cases: Array<[string, string, string, boolean]> = [
    ["localhost", "http://localhost:8000", "localhost", true],
    ["loopback 127/8", "http://127.0.0.1:8000/v1", "127.0.0.1", true],
    ["loopback 127/8, not .1", "http://127.4.5.6:8000", "127.4.5.6", true],
    ["IPv6 loopback", "http://[::1]:8000", "[::1]", true],
    ["host.docker.internal", "http://host.docker.internal:8000", "host.docker.internal", true],
    ["10/8", "http://10.0.0.5:8000", "10.0.0.5", true],
    ["172.16/12", "http://172.20.1.2:8000", "172.20.1.2", true],
    ["192.168/16", "http://192.168.1.20:8000", "192.168.1.20", true],
    ["link-local 169.254/16", "http://169.254.10.10:8000", "169.254.10.10", true],
    ["IPv6 link-local fe80::/10", "http://[fe80::1]:8000", "[fe80::1]", true],
    ["CGNAT 100.64/10 (Tailscale)", "http://100.101.102.103:8000", "100.101.102.103", true],
    ["IPv6 ULA fc00::/7", "http://[fd12:3456::1]:8000", "[fd12:3456::1]", true],
    [".local name", "http://studio.local:8000", "studio.local", true],
    [".lan name", "http://mac-mini.lan:8000", "mac-mini.lan", true],
    ["bare name", "http://omlx:8000", "omlx", true],
    ["public hostname", "https://models.example.com", "models.example.com", false],
    ["public IPv4", "http://8.8.8.8:8000", "8.8.8.8", false],
    ["just outside 172.16/12", "http://172.32.0.1:8000", "172.32.0.1", false],
    ["just outside 100.64/10", "http://100.128.0.1:8000", "100.128.0.1", false],
    ["public IPv6", "http://[2001:db8::1]:8000", "[2001:db8::1]", false],
    ["a name that only contains .local", "http://local.example.com", "local.example.com", false],
  ];

  it.each(cases)("%s: %s", async (_label, baseUrl, host, onNetwork) => {
    await selfHostedAt(baseUrl);
    const body = await privacy();
    expect(body).toMatchObject({ provider: "self_hosted", host, onNetwork });
  });

  it("self-hosted: the copy names the model server, not Anthropic, as the recipient", async () => {
    await selfHostedAt("http://192.168.1.20:8000");
    const body = await privacy();
    expect(body.intro).toBe(
      "Cadence sends coaching context to the model server you configured to generate replies. This page explains what is sent versus what stays on your deploy.",
    );
    expect(body.sent).toMatchObject({
      heading: "May be sent to the model server you configured",
      items: PRIVACY_COPY.sent.items,
    });
    expect(JSON.stringify([body.intro, body.sent])).not.toMatch(/Anthropic/);
    expect(body.disclosure).toBe(PRIVACY_COPY.disclosure);
  });

  it("is readable before the disclaimer is accepted", async () => {
    await selfHostedAt("http://studio.local:8000");
    const res = await app().request("/privacy");
    expect(res.status).toBe(200);
  });
});

describe("the disclaimer names the model server when self-hosted", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("Anthropic: the text is the canonical one", async () => {
    const body = await json(await app().request("/disclaimer"));
    expect(body).toMatchObject({ provider: "anthropic", version: DISCLAIMER_VERSION, text: DISCLAIMER_TEXT });
  });

  it("self-hosted: the recipient is the model server you configured, and the version is unchanged", async () => {
    await selfHostedAt("http://192.168.1.20:8000");
    const before = await json(await app().request("/disclaimer"));
    expect(before.provider).toBe("self_hosted");
    expect(before.version).toBe(DISCLAIMER_VERSION);
    const text = String(before.text);
    expect(text).toContain("may be sent to the model server you configured to generate coaching replies");
    expect(text).not.toMatch(/Anthropic/);
    expect(text.split(/\n\s*\n/)).toHaveLength(DISCLAIMER_TEXT.split(/\n\s*\n/).length);

    const accepted = await json(await app().request("/disclaimer/accept", { method: "POST" }));
    expect(accepted).toMatchObject({ accepted: true, version: DISCLAIMER_VERSION, provider: "self_hosted" });
    const { rows } = await pool.query<{ disclaimer_version: string }>(
      "SELECT disclaimer_version FROM disclaimer_acceptance",
    );
    expect(rows).toEqual([{ disclaimer_version: DISCLAIMER_VERSION }]);
  });
});
