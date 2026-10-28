import { pool } from "../db.js";
import type { PrescribedDay, SafetyCallout } from "../llm/types.js";
import type {
  DossierProposalKind,
  DossierProposalStatus,
} from "../dossier/proposals.js";
import type { ModelPacketAttachment } from "../packet/types.js";

/** "weekly_read" is the short Sunday message pointing at the plan; everything else is "chat". */
export type ThreadMessageKind = "chat" | "weekly_read";

export type ThreadMessage = {
  id: string;
  role: "athlete" | "coach" | "system";
  kind: ThreadMessageKind;
  body: string;
  createdAt: string;
  weekSessionId: string | null;
  /** Compact coaching workout summary (no GPS); null when none attached. */
  attachment: ModelPacketAttachment | null;
  /** LLM call log row that produced this coach message; null otherwise. */
  llmCallId: string | null;
  /** Safety callouts that came with this coach message; empty when none. */
  safetyCallouts: SafetyCallout[];
  /** The note this reply produced, as it stands now; null when it produced none. */
  dossierProposal: ThreadNote | null;
  /** The plan days this reply changed, as they were then; null when it changed none. */
  planChanges: PrescribedDay[] | null;
};

/** What a thread message shows of the note it produced. */
export type ThreadNote = {
  id: number;
  kind: DossierProposalKind;
  status: DossierProposalStatus;
  summaryBullets: string[];
  appliedVersionId: number | null;
  previousVersionId: number | null;
  createdAt: string;
};

type Row = {
  id: string;
  role: string;
  kind: ThreadMessageKind;
  body: string;
  created_at: Date;
  week_session_id: string | null;
  attachment: ModelPacketAttachment | null;
  llm_call_id: string | null;
  safety_callouts: SafetyCallout[] | null;
  plan_changes: PrescribedDay[] | null;
  p_id: string | number | null;
  p_kind: DossierProposalKind | null;
  p_status: DossierProposalStatus | null;
  p_bullets: string[] | null;
  p_applied: string | number | null;
  p_previous: string | number | null;
  p_created: Date | null;
};

const SELECT_MESSAGE = `
  SELECT m.id::text AS id, m.role, m.kind, m.body, m.created_at, m.week_session_id::text AS week_session_id,
         m.attachment, m.llm_call_id::text AS llm_call_id, m.safety_callouts, m.plan_changes,
         p.id AS p_id, p.kind AS p_kind, p.status AS p_status,
         p.summary_bullets AS p_bullets, p.applied_version_id AS p_applied,
         p.previous_version_id AS p_previous, p.created_at AS p_created
  FROM thread_messages m
  LEFT JOIN dossier_proposals p ON p.id = m.dossier_proposal_id`;

function toMessage(row: Row): ThreadMessage {
  return {
    id: row.id,
    role: row.role as ThreadMessage["role"],
    kind: row.kind ?? "chat",
    body: row.body,
    createdAt: row.created_at.toISOString(),
    weekSessionId: row.week_session_id,
    attachment: row.attachment ?? null,
    llmCallId: row.llm_call_id ?? null,
    safetyCallouts: row.safety_callouts ?? [],
    planChanges: row.plan_changes && row.plan_changes.length > 0 ? row.plan_changes : null,
    dossierProposal:
      row.p_id == null
        ? null
        : {
            id: Number(row.p_id),
            kind: row.p_kind!,
            status: row.p_status!,
            summaryBullets: row.p_bullets ?? [],
            appliedVersionId: row.p_applied == null ? null : Number(row.p_applied),
            previousVersionId:
              row.p_previous == null ? null : Number(row.p_previous),
            createdAt: row.p_created!.toISOString(),
          },
  };
}

async function getMessage(id: string): Promise<ThreadMessage> {
  const result = await pool.query<Row>(`${SELECT_MESSAGE} WHERE m.id = $1`, [id]);
  return toMessage(result.rows[0]!);
}

export async function listThreadMessages(
  weekSessionId?: string,
): Promise<ThreadMessage[]> {
  if (weekSessionId) {
    const result = await pool.query<Row>(
      `${SELECT_MESSAGE}
       WHERE m.week_session_id = $1
       ORDER BY m.created_at ASC, m.seq ASC`,
      [weekSessionId],
    );
    return result.rows.map(toMessage);
  }

  const result = await pool.query<Row>(
    `${SELECT_MESSAGE} ORDER BY m.created_at ASC, m.seq ASC`,
  );
  return result.rows.map(toMessage);
}

export async function createAthleteMessage(
  at: Date,
  body: string,
  weekSessionId?: string | null,
  attachment?: ModelPacketAttachment | null,
): Promise<ThreadMessage> {
  const result = await pool.query<Row>(
    `
    INSERT INTO thread_messages (role, body, week_session_id, attachment, created_at)
    VALUES ('athlete', $1, $2, $3::jsonb, $4)
    RETURNING id::text AS id
    `,
    [
      body,
      weekSessionId ?? null,
      attachment ? JSON.stringify(attachment) : null,
      at,
    ],
  );
  return getMessage((result.rows[0] as unknown as { id: string }).id);
}

/** Remove one message, e.g. an athlete message whose reply failed (#5). */
export async function deleteThreadMessage(id: string): Promise<void> {
  await pool.query(`DELETE FROM thread_messages WHERE id = $1`, [id]);
}

/** Coach-authored thread message (dossier proposal summary, weekly analysis, …). */
export async function createCoachMessage(
  at: Date,
  body: string,
  weekSessionId?: string | null,
  llmCallId?: string | null,
  safetyCallouts?: SafetyCallout[] | null,
  dossierProposalId?: number | null,
  kind: ThreadMessageKind = "chat",
  planChanges?: PrescribedDay[] | null,
): Promise<ThreadMessage> {
  const result = await pool.query<{ id: string }>(
    `
    INSERT INTO thread_messages
      (role, body, week_session_id, attachment, llm_call_id, safety_callouts, dossier_proposal_id, created_at, kind, plan_changes)
    VALUES ('coach', $1, $2, NULL, $3, $4::jsonb, $5, $6, $7, $8::jsonb)
    RETURNING id::text AS id
    `,
    [
      body,
      weekSessionId ?? null,
      llmCallId ?? null,
      safetyCallouts && safetyCallouts.length > 0
        ? JSON.stringify(safetyCallouts)
        : null,
      dossierProposalId ?? null,
      at,
      kind,
      planChanges && planChanges.length > 0 ? JSON.stringify(planChanges) : null,
    ],
  );
  return getMessage(result.rows[0]!.id);
}
