import { pool } from "../db.js";
import { recordAuditAccepted } from "./auditMeta.js";
import type { DossierVersion } from "./store.js";

export type DossierProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  /** Applied, then reverted by the athlete (a newer version restored the old text). */
  | "undone";

/** How the proposal was produced — audit Accept also stamps cadence meta (#40). */
export type DossierProposalKind =
  | "settings"
  | "audit"
  | "correction"
  | "onboarding";

export type DossierProposal = {
  id: number;
  summaryBullets: string[];
  proposedBody: string;
  kind: DossierProposalKind;
  status: DossierProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** The version this proposal installed; null while pending or rejected. */
  appliedVersionId: number | null;
  /** The version it replaced; null when there was none. */
  previousVersionId: number | null;
};

/**
 * Kinds that apply the moment the coach proposes them. The athlete sees what
 * changed and can undo it; nothing waits on an approval. The rest (onboarding,
 * audit) stay pending until the athlete says "looks right".
 */
export const AUTO_APPLY_KINDS: readonly DossierProposalKind[] = [
  "settings",
  "correction",
];

type Row = {
  id: string | number;
  summary_bullets: string[];
  proposed_body: string;
  kind: DossierProposalKind;
  status: DossierProposalStatus;
  created_at: Date;
  resolved_at: Date | null;
  applied_version_id: string | number | null;
  previous_version_id: string | number | null;
};

const PROPOSAL_COLS =
  "id, summary_bullets, proposed_body, kind, status, created_at, resolved_at, applied_version_id, previous_version_id";

function toProposal(row: Row): DossierProposal {
  return {
    id: Number(row.id),
    summaryBullets: row.summary_bullets,
    proposedBody: row.proposed_body,
    kind: row.kind ?? "settings",
    status: row.status,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    appliedVersionId:
      row.applied_version_id == null ? null : Number(row.applied_version_id),
    previousVersionId:
      row.previous_version_id == null ? null : Number(row.previous_version_id),
  };
}

async function latestVersionId(client: {
  query: (sql: string) => Promise<{ rows: Array<{ id: string | number }> }>;
}): Promise<number | null> {
  const result = await client.query(
    "SELECT id FROM dossier_versions ORDER BY id DESC LIMIT 1",
  );
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

export async function createDossierProposal(input: {
  summaryBullets: string[];
  proposedBody: string;
  kind?: DossierProposalKind;
}): Promise<DossierProposal> {
  const kind = input.kind ?? "settings";

  if (!AUTO_APPLY_KINDS.includes(kind)) {
    const result = await pool.query<Row>(
      `
      INSERT INTO dossier_proposals (summary_bullets, proposed_body, kind)
      VALUES ($1, $2, $3)
      RETURNING ${PROPOSAL_COLS}
      `,
      [input.summaryBullets, input.proposedBody, kind],
    );
    return toProposal(result.rows[0]!);
  }

  // Applied on the spot: the new version and the proposal that explains it
  // are written together, so a note can never be half-applied.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previousId = await latestVersionId(client);
    const version = await client.query<{ id: string | number }>(
      "INSERT INTO dossier_versions (body) VALUES ($1) RETURNING id",
      [input.proposedBody],
    );
    const result = await client.query<Row>(
      `
      INSERT INTO dossier_proposals
        (summary_bullets, proposed_body, kind, status, resolved_at,
         applied_version_id, previous_version_id)
      VALUES ($1, $2, $3, 'accepted', NOW(), $4, $5)
      RETURNING ${PROPOSAL_COLS}
      `,
      [
        input.summaryBullets,
        input.proposedBody,
        kind,
        Number(version.rows[0]!.id),
        previousId,
      ],
    );
    await client.query("COMMIT");
    return toProposal(result.rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listPendingDossierProposals(): Promise<DossierProposal[]> {
  const result = await pool.query<Row>(
    `
    SELECT ${PROPOSAL_COLS}
    FROM dossier_proposals
    WHERE status = 'pending'
    ORDER BY id ASC
    `,
  );
  return result.rows.map(toProposal);
}

export type AcceptProposalResult =
  | { ok: true; proposal: DossierProposal; version: DossierVersion }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_pending"; proposal: DossierProposal };

export type RejectProposalResult =
  | { ok: true; proposal: DossierProposal }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_pending"; proposal: DossierProposal };

export type AcceptDossierProposalOptions = {
  /** Injectable "now" for audit cadence stamps (#40). Defaults to system time. */
  acceptedAt?: Date;
  /**
   * When set, install this body as the new dossier version instead of the
   * stored proposal body (light-edit-then-accept, #50). Omit to accept original.
   */
  proposedBody?: string;
};

export async function acceptDossierProposal(
  id: number,
  options?: AcceptDossierProposalOptions,
): Promise<AcceptProposalResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<Row>(
      `
      SELECT ${PROPOSAL_COLS}
      FROM dossier_proposals
      WHERE id = $1
      FOR UPDATE
      `,
      [id],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "not_pending",
        proposal: toProposal(row),
      };
    }

    const bodyToInstall =
      options?.proposedBody !== undefined
        ? options.proposedBody
        : row.proposed_body;
    const previousId = await latestVersionId(client);

    const versionResult = await client.query<{
      id: string | number;
      body: string;
      created_at: Date;
    }>(
      `
      INSERT INTO dossier_versions (body)
      VALUES ($1)
      RETURNING id, body, created_at
      `,
      [bodyToInstall],
    );
    const versionRow = versionResult.rows[0]!;

    const updated = await client.query<Row>(
      `
      UPDATE dossier_proposals
      SET status = 'accepted', resolved_at = NOW(),
          applied_version_id = $2, previous_version_id = $3
      WHERE id = $1
      RETURNING ${PROPOSAL_COLS}
      `,
      [id, Number(versionRow.id), previousId],
    );
    const proposal = toProposal(updated.rows[0]!);
    if (proposal.kind === "audit") {
      await recordAuditAccepted(
        options?.acceptedAt ?? new Date(),
        process.env,
        client,
      );
    }
    await client.query("COMMIT");

    return {
      ok: true,
      proposal,
      version: {
        id: Number(versionRow.id),
        body: versionRow.body,
        createdAt: versionRow.created_at.toISOString(),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectDossierProposal(
  id: number,
): Promise<RejectProposalResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<Row>(
      `
      SELECT ${PROPOSAL_COLS}
      FROM dossier_proposals
      WHERE id = $1
      FOR UPDATE
      `,
      [id],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "not_pending",
        proposal: toProposal(row),
      };
    }

    const updated = await client.query<Row>(
      `
      UPDATE dossier_proposals
      SET status = 'rejected', resolved_at = NOW()
      WHERE id = $1
      RETURNING ${PROPOSAL_COLS}
      `,
      [id],
    );
    await client.query("COMMIT");
    return { ok: true, proposal: toProposal(updated.rows[0]!) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type UndoProposalResult =
  | { ok: true; proposal: DossierProposal; version: DossierVersion }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_applied"; proposal: DossierProposal }
  | { ok: false; reason: "nothing_to_restore"; proposal: DossierProposal };

/**
 * Put back what an applied proposal replaced. The old text is written as a new
 * version, so history only ever grows and an undo is itself visible.
 */
export async function undoDossierProposal(
  id: number,
): Promise<UndoProposalResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<Row>(
      `SELECT ${PROPOSAL_COLS} FROM dossier_proposals WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    // Only an applied proposal can be undone: not pending, rejected or already undone.
    if (row.status !== "accepted") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_applied", proposal: toProposal(row) };
    }
    const previous =
      row.previous_version_id == null
        ? null
        : await client.query<{ body: string }>(
            "SELECT body FROM dossier_versions WHERE id = $1",
            [Number(row.previous_version_id)],
          );
    const previousBody = previous?.rows[0]?.body;
    if (previousBody === undefined) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "nothing_to_restore",
        proposal: toProposal(row),
      };
    }

    const versionResult = await client.query<{
      id: string | number;
      body: string;
      created_at: Date;
    }>(
      "INSERT INTO dossier_versions (body) VALUES ($1) RETURNING id, body, created_at",
      [previousBody],
    );
    const versionRow = versionResult.rows[0]!;
    const updated = await client.query<Row>(
      `
      UPDATE dossier_proposals
      SET status = 'undone', resolved_at = NOW()
      WHERE id = $1
      RETURNING ${PROPOSAL_COLS}
      `,
      [id],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      proposal: toProposal(updated.rows[0]!),
      version: {
        id: Number(versionRow.id),
        body: versionRow.body,
        createdAt: versionRow.created_at.toISOString(),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Applied and undone proposals, newest first: the athlete's change history. */
export async function listResolvedDossierProposals(
  limit = 50,
): Promise<DossierProposal[]> {
  const result = await pool.query<Row>(
    `
    SELECT ${PROPOSAL_COLS}
    FROM dossier_proposals
    WHERE status IN ('accepted', 'undone')
    ORDER BY id DESC
    LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(toProposal);
}

/**
 * A correction replaces whatever the coach drafted before it. Reject the drafts
 * still waiting for a yes (onboarding, tidy-up) so approving one later cannot
 * overwrite the correction with older text.
 */
export async function rejectWaitingDossierProposals(): Promise<number> {
  const result = await pool.query(
    `
    UPDATE dossier_proposals
    SET status = 'rejected', resolved_at = NOW()
    WHERE status = 'pending' AND kind IN ('onboarding', 'audit')
    `,
  );
  return result.rowCount ?? 0;
}
