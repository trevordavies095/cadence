import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("dossier version history", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("writing creates versions; prior versions remain readable", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    expect((await json(await app.request("/dossier"))).current).toBeNull();

    const v1 = await json(
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "# Dossier\n\nBase: 5k fitness." }),
      }),
    );
    expect(v1.body).toContain("5k fitness");
    expect(v1.id).toBeTruthy();

    const v2res = await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# Dossier\n\nBuilding toward half." }),
    });
    expect(v2res.status).toBe(201);
    const v2 = await json(v2res);
    expect(v2.id).not.toBe(v1.id);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { body: string }).body).toContain("half");

    const versions = await json(await app.request("/dossier/versions"));
    const list = versions.versions as Array<{ id: number }>;
    expect(list.length).toBeGreaterThanOrEqual(2);

    const older = await json(
      await app.request(`/dossier/versions/${v1.id as number}`),
    );
    expect(older.body).toContain("5k fitness");
  });

  it("disclaimer gates dossier", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/dossier")).status).toBe(403);
  });
});
