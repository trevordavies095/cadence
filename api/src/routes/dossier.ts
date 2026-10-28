import { Hono } from "hono";
import type { Clock } from "../clock/clock.js";
import { getDossierAuditMeta } from "../dossier/auditMeta.js";
import {
  acceptDossierProposal,
  createDossierProposal,
  listPendingDossierProposals,
  listResolvedDossierProposals,
  rejectDossierProposal,
  undoDossierProposal,
  type DossierProposalKind,
} from "../dossier/proposals.js";
import {
  createDossierVersion,
  getCurrentDossier,
  getDossierVersion,
  listDossierVersions,
} from "../dossier/store.js";
import { requireDisclaimer } from "../middleware/requireDisclaimer.js";

export type DossierRouteOptions = {
  clock: Clock;
};

export function createDossierRoutes(options: DossierRouteOptions): Hono {
  const routes = new Hono();
  const { clock } = options;

  routes.use("/dossier", requireDisclaimer);
  routes.use("/dossier/*", requireDisclaimer);

  routes.get("/dossier", async (c) => {
    const current = await getCurrentDossier();
    const audit = await getDossierAuditMeta(clock.now());
    return c.json({ current, audit });
  });

  routes.put("/dossier", async (c) => {
    let body: { body?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const text = typeof body.body === "string" ? body.body : "";
    if (!text.trim()) {
      return c.json({ error: "body_required" }, 400);
    }
    const version = await createDossierVersion(clock.now(), text);
    return c.json(version, 201);
  });

  routes.get("/dossier/versions", async (c) => {
    const versions = await listDossierVersions();
    return c.json({ versions });
  });

  routes.get("/dossier/versions/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const version = await getDossierVersion(id);
    if (!version) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(version);
  });

  routes.get("/dossier/proposals", async (c) => {
    const proposals = await listPendingDossierProposals();
    return c.json({ proposals });
  });

  // What the coach changed, newest first, so each change can be undone later.
  routes.get("/dossier/changes", async (c) => {
    const changes = await listResolvedDossierProposals();
    return c.json({ changes });
  });

  routes.post("/dossier/proposals", async (c) => {
    let body: {
      summaryBullets?: unknown;
      proposedBody?: unknown;
      kind?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    if (!Array.isArray(body.summaryBullets)) {
      return c.json({ error: "summary_bullets_required" }, 400);
    }
    const summaryBullets = body.summaryBullets
      .filter((b): b is string => typeof b === "string")
      .map((b) => b.trim())
      .filter(Boolean);
    if (summaryBullets.length === 0) {
      return c.json({ error: "summary_bullets_required" }, 400);
    }

    const proposedBody =
      typeof body.proposedBody === "string" ? body.proposedBody : "";
    if (!proposedBody.trim()) {
      return c.json({ error: "proposed_body_required" }, 400);
    }

    const kinds: DossierProposalKind[] = [
      "settings",
      "correction",
      "audit",
      "onboarding",
    ];
    let kind: DossierProposalKind | undefined;
    if (body.kind !== undefined) {
      if (typeof body.kind !== "string" || !kinds.includes(body.kind as DossierProposalKind)) {
        return c.json({ error: "invalid_kind" }, 400);
      }
      kind = body.kind as DossierProposalKind;
    }

    const proposal = await createDossierProposal({
      summaryBullets,
      proposedBody,
      kind,
      at: clock.now(),
    });
    return c.json(proposal, 201);
  });

  routes.post("/dossier/proposals/:id/accept", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "invalid_id" }, 400);
    }

    // Optional body: `{ proposedBody?: string }`. Omit / empty JSON → accept
    // the stored proposal text (backward compatible). When provided, install
    // the edited body as the new notes version (#50).
    let editedBody: string | undefined;
    try {
      const raw = await c.req.json();
      if (
        raw &&
        typeof raw === "object" &&
        "proposedBody" in raw &&
        raw.proposedBody !== undefined
      ) {
        if (typeof raw.proposedBody !== "string") {
          return c.json({ error: "proposed_body_invalid" }, 400);
        }
        if (!raw.proposedBody.trim()) {
          return c.json({ error: "proposed_body_required" }, 400);
        }
        editedBody = raw.proposedBody;
      }
    } catch {
      // No / invalid JSON body — treat as omit (accept original).
    }

    const result = await acceptDossierProposal(id, {
      acceptedAt: clock.now(),
      ...(editedBody !== undefined ? { proposedBody: editedBody } : {}),
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ error: "not_pending", proposal: result.proposal }, 409);
    }
    const audit =
      result.proposal.kind === "audit"
        ? await getDossierAuditMeta(clock.now())
        : undefined;
    return c.json({
      proposal: result.proposal,
      version: result.version,
      ...(audit ? { audit } : {}),
    });
  });

  routes.post("/dossier/proposals/:id/undo", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const result = await undoDossierProposal(clock.now(), id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return c.json({ error: "not_found" }, 404);
      }
      if (result.reason === "nothing_to_restore") {
        return c.json(
          {
            error: "nothing_to_restore",
            message: "There is no earlier version to go back to.",
            proposal: result.proposal,
          },
          409,
        );
      }
      return c.json({ error: "not_applied", proposal: result.proposal }, 409);
    }
    return c.json({ proposal: result.proposal, version: result.version });
  });

  routes.post("/dossier/proposals/:id/reject", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const result = await rejectDossierProposal(clock.now(), id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ error: "not_pending", proposal: result.proposal }, 409);
    }
    return c.json({ proposal: result.proposal });
  });

  return routes;
}
