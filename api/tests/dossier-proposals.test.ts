import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("dossier proposals that wait for a yes (onboarding, audit)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("creates and lists pending proposals", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    const empty = await json(await app.request("/dossier/proposals"));
    expect(empty.proposals).toEqual([]);

    const created = await app.request("/dossier/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "onboarding",
        summaryBullets: ["Set half-marathon goal", "Note calf tightness"],
        proposedBody: "# Dossier\n\nGoal: half. Calf: monitor load.",
      }),
    });
    expect(created.status).toBe(201);
    const proposal = await json(created);
    expect(proposal.status).toBe("pending");
    expect(proposal.summaryBullets).toEqual([
      "Set half-marathon goal",
      "Note calf tightness",
    ]);
    expect(String(proposal.proposedBody)).toContain("half");

    const listed = await json(await app.request("/dossier/proposals"));
    const proposals = listed.proposals as Array<{ id: number }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.id).toBe(proposal.id);
  });

  it("accept-default installs original proposal body and clears pending (#50)", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# Dossier\n\nBase: 5k fitness." }),
    });

    const originalBody = "# Dossier\n\nBuilding toward half.";
    const created = await json(
      await app.request("/dossier/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "onboarding",
        summaryBullets: ["Build toward half"],
          proposedBody: originalBody,
        }),
      }),
    );

    const acceptRes = await app.request(
      `/dossier/proposals/${created.id as number}/accept`,
      { method: "POST" },
    );
    expect(acceptRes.status).toBe(200);
    const accepted = await json(acceptRes);
    expect((accepted.proposal as { status: string }).status).toBe("accepted");
    expect((accepted.version as { body: string }).body).toBe(originalBody);

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { body: string }).body).toBe(originalBody);

    const versions = await json(await app.request("/dossier/versions"));
    expect((versions.versions as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("accept-with-edit installs edited body and clears pending (#50)", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    await app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# Dossier\n\nBase: 5k fitness." }),
    });

    const created = await json(
      await app.request("/dossier/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "onboarding",
        summaryBullets: ["Build toward half"],
          proposedBody: "# Dossier\n\nBuilding toward half.",
        }),
      }),
    );

    const editedBody =
      "# Dossier\n\nBuilding toward half. Athlete tweak: prefer AM runs.";
    const acceptRes = await app.request(
      `/dossier/proposals/${created.id as number}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposedBody: editedBody }),
      },
    );
    expect(acceptRes.status).toBe(200);
    const accepted = await json(acceptRes);
    expect((accepted.proposal as { status: string }).status).toBe("accepted");
    expect((accepted.version as { body: string }).body).toBe(editedBody);

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { body: string }).body).toBe(editedBody);
    expect((current.current as { body: string }).body).not.toBe(
      "# Dossier\n\nBuilding toward half.",
    );
  });

  it("reject clears pending without changing dossier", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    const v1 = await json(
      await app.request("/dossier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "# Dossier\n\nKeep this body." }),
      }),
    );

    const created = await json(
      await app.request("/dossier/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "onboarding",
        summaryBullets: ["Would overwrite wrongly"],
          proposedBody: "# Dossier\n\nShould not apply.",
        }),
      }),
    );

    const rejectRes = await app.request(
      `/dossier/proposals/${created.id as number}/reject`,
      { method: "POST" },
    );
    expect(rejectRes.status).toBe(200);
    const rejected = await json(rejectRes);
    expect((rejected.proposal as { status: string }).status).toBe("rejected");

    const pending = await json(await app.request("/dossier/proposals"));
    expect(pending.proposals).toEqual([]);

    const current = await json(await app.request("/dossier"));
    expect((current.current as { id: number; body: string }).id).toBe(v1.id);
    expect((current.current as { body: string }).body).toContain("Keep this");
  });

  it("disclaimer gates proposals", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/dossier/proposals")).status).toBe(403);
  });
});
