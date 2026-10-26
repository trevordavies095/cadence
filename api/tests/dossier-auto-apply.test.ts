import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

type Proposal = {
  id: number;
  kind: string;
  status: string;
  appliedVersionId: number | null;
  previousVersionId: number | null;
};

describe("coach notes apply immediately and can be undone (#102)", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  async function open() {
    await acceptAndReady();
    return createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
  }

  const put = (app: ReturnType<typeof createApp>, body: string) =>
    app.request("/dossier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });

  const propose = (
    app: ReturnType<typeof createApp>,
    kind: string | undefined,
    proposedBody: string,
  ) =>
    app.request("/dossier/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summaryBullets: ["A change"],
        proposedBody,
        ...(kind ? { kind } : {}),
      }),
    });

  const current = async (app: ReturnType<typeof createApp>) =>
    (await json(await app.request("/dossier"))).current as {
      id: number;
      body: string;
    };

  for (const kind of ["settings", "correction"]) {
    it(`a ${kind} proposal applies when it is created`, async () => {
      const app = await open();
      const v1 = (await json(await put(app, "# About you\n\nBase."))) as {
        id: number;
      };

      const res = await propose(app, kind, "# About you\n\nBase.\n\nNew note.");
      expect(res.status).toBe(201);
      const proposal = (await json(res)) as unknown as Proposal;

      expect(proposal).toMatchObject({
        kind,
        status: "accepted",
        previousVersionId: v1.id,
      });
      const now = await current(app);
      expect(proposal.appliedVersionId).toBe(now.id);
      expect(now.body).toContain("New note.");
      expect(now.id).toBeGreaterThan(v1.id);

      // Nothing is left waiting.
      expect((await json(await app.request("/dossier/proposals"))).proposals).toEqual([]);
    });
  }

  it("onboarding and audit proposals still wait for a yes", async () => {
    const app = await open();
    await put(app, "# About you\n\nBase.");
    for (const kind of ["onboarding", "audit"]) {
      const proposal = (await json(
        await propose(app, kind, `# About you\n\n${kind}`),
      )) as unknown as Proposal;
      expect(proposal).toMatchObject({
        kind,
        status: "pending",
        appliedVersionId: null,
        previousVersionId: null,
      });
    }
    expect((await current(app)).body).toBe("# About you\n\nBase.");
    expect(
      ((await json(await app.request("/dossier/proposals"))).proposals as unknown[]).length,
    ).toBe(2);
  });

  it("an applied note on a brand-new profile has nothing to go back to", async () => {
    const app = await open();
    const proposal = (await json(
      await propose(app, "settings", "# About you\n\nFirst."),
    )) as unknown as Proposal;
    expect(proposal.previousVersionId).toBeNull();

    const undo = await app.request(`/dossier/proposals/${proposal.id}/undo`, {
      method: "POST",
    });
    expect(undo.status).toBe(409);
    expect((await json(undo)).error).toBe("nothing_to_restore");
    expect((await current(app)).body).toContain("First.");
  });

  describe("undo", () => {
    it("restores the earlier text as a new version and marks the note undone", async () => {
      const app = await open();
      const v1 = (await json(await put(app, "# About you\n\nBase."))) as { id: number };
      const proposal = (await json(
        await propose(app, "settings", "# About you\n\nBase.\n\nWrong note."),
      )) as unknown as Proposal;

      const res = await app.request(`/dossier/proposals/${proposal.id}/undo`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect((body.proposal as Proposal).status).toBe("undone");
      const version = body.version as { id: number; body: string };
      expect(version.body).toBe("# About you\n\nBase.");

      // History only grows: the restored text is a new version, not the old id.
      expect(version.id).toBeGreaterThan(proposal.appliedVersionId!);
      expect(version.id).not.toBe(v1.id);
      expect((await current(app)).id).toBe(version.id);
      const versions = (await json(await app.request("/dossier/versions"))).versions as unknown[];
      expect(versions).toHaveLength(3);
    });

    it("refuses to undo twice, or a note that is still pending, or one that is unknown", async () => {
      const app = await open();
      await put(app, "# About you\n\nBase.");
      const applied = (await json(
        await propose(app, "settings", "# About you\n\nBase.\n\nNote."),
      )) as unknown as Proposal;
      const pending = (await json(
        await propose(app, "audit", "# About you\n\nTidied."),
      )) as unknown as Proposal;

      const undo = (id: number) =>
        app.request(`/dossier/proposals/${id}/undo`, { method: "POST" });

      expect((await undo(applied.id)).status).toBe(200);
      const again = await undo(applied.id);
      expect(again.status).toBe(409);
      expect((await json(again)).error).toBe("not_applied");

      const waiting = await undo(pending.id);
      expect(waiting.status).toBe(409);
      expect((await json(waiting)).error).toBe("not_applied");

      expect((await undo(999999)).status).toBe(404);
      expect(
        (await app.request("/dossier/proposals/abc/undo", { method: "POST" })).status,
      ).toBe(400);
    });

    it("also undoes a note the athlete accepted, using the version it replaced", async () => {
      const app = await open();
      await put(app, "# About you\n\nBase.");
      const audit = (await json(
        await propose(app, "audit", "# About you\n\nTidied."),
      )) as unknown as Proposal;

      const accepted = await json(
        await app.request(`/dossier/proposals/${audit.id}/accept`, { method: "POST" }),
      );
      const acceptedProposal = accepted.proposal as Proposal;
      expect(acceptedProposal.status).toBe("accepted");
      expect(acceptedProposal.appliedVersionId).toBe(
        (accepted.version as { id: number }).id,
      );
      expect(acceptedProposal.previousVersionId).not.toBeNull();

      const undone = await app.request(`/dossier/proposals/${audit.id}/undo`, {
        method: "POST",
      });
      expect(undone.status).toBe(200);
      expect((await current(app)).body).toBe("# About you\n\nBase.");
    });
  });

  it("lists what changed, newest first, with undone notes marked", async () => {
    const app = await open();
    await put(app, "# About you\n\nBase.");
    const first = (await json(
      await propose(app, "settings", "# About you\n\nOne."),
    )) as unknown as Proposal;
    const second = (await json(
      await propose(app, "correction", "# About you\n\nOne.\n\nTwo."),
    )) as unknown as Proposal;
    await propose(app, "audit", "# About you\n\nStill waiting.");
    await app.request(`/dossier/proposals/${first.id}/undo`, { method: "POST" });

    const changes = (await json(await app.request("/dossier/changes"))).changes as Proposal[];
    // Pending proposals are not changes yet.
    expect(changes.map((c) => [c.id, c.status])).toEqual([
      [second.id, "accepted"],
      [first.id, "undone"],
    ]);
  });

  it("rejects an unknown kind and keeps the disclaimer gate", async () => {
    const app = await open();
    const bad = await propose(app, "nonsense", "# About you");
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("invalid_kind");

    await resetAppTables();
    const gated = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await gated.request("/dossier/changes")).status).toBe(403);
    expect(
      (await gated.request("/dossier/proposals/1/undo", { method: "POST" })).status,
    ).toBe(403);
  });
});
