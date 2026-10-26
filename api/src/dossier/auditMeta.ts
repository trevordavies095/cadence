import type { PoolClient } from "pg";
import { pool } from "../db.js";

/** Default cadence: middle of the product's 4–6 week audit window. */
export const DEFAULT_AUDIT_INTERVAL_WEEKS = 5;

type Queryable = {
  query: PoolClient["query"];
};

export type DossierAuditMeta = {
  lastAuditAt: string | null;
  nextAuditDueAt: string | null;
  intervalWeeks: number;
  /** True when next due is null (never audited) or <= now. */
  due: boolean;
};

type Row = {
  last_audit_at: Date | null;
  next_audit_due_at: Date | null;
  interval_weeks: number;
};

function resolveIntervalWeeks(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOSSIER_AUDIT_INTERVAL_WEEKS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n >= 1 && n <= 52) return n;
  }
  return DEFAULT_AUDIT_INTERVAL_WEEKS;
}

function addWeeks(from: Date, weeks: number): Date {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d;
}

function toMeta(row: Row | undefined, now: Date, intervalWeeks: number): DossierAuditMeta {
  if (!row) {
    return {
      lastAuditAt: null,
      nextAuditDueAt: null,
      intervalWeeks,
      due: true,
    };
  }
  const next = row.next_audit_due_at;
  const due = next == null || next.getTime() <= now.getTime();
  return {
    lastAuditAt: row.last_audit_at ? row.last_audit_at.toISOString() : null,
    nextAuditDueAt: next ? next.toISOString() : null,
    intervalWeeks: row.interval_weeks,
    due,
  };
}

/** Load singleton audit cadence metadata (never audited → due). */
export async function getDossierAuditMeta(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DossierAuditMeta> {
  const intervalWeeks = resolveIntervalWeeks(env);
  const result = await pool.query<Row>(
    `
    SELECT last_audit_at, next_audit_due_at, interval_weeks
    FROM dossier_audit_meta
    WHERE id = 1
    `,
  );
  return toMeta(result.rows[0], now, intervalWeeks);
}

/**
 * After Accept of an audit proposal: stamp lastAuditAt and schedule next due.
 * Pass `client` to keep the stamp in the same transaction as Accept.
 */
export async function recordAuditAccepted(
  acceptedAt: Date,
  env: NodeJS.ProcessEnv = process.env,
  client?: Queryable,
): Promise<DossierAuditMeta> {
  const db = client ?? pool;
  const intervalWeeks = resolveIntervalWeeks(env);
  const nextDue = addWeeks(acceptedAt, intervalWeeks);
  const result = await db.query<Row>(
    `
    INSERT INTO dossier_audit_meta (id, last_audit_at, next_audit_due_at, interval_weeks, updated_at)
    VALUES (1, $1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE SET
      last_audit_at = EXCLUDED.last_audit_at,
      next_audit_due_at = EXCLUDED.next_audit_due_at,
      interval_weeks = EXCLUDED.interval_weeks,
      updated_at = NOW()
    RETURNING last_audit_at, next_audit_due_at, interval_weeks
    `,
    [acceptedAt, nextDue, intervalWeeks],
  );
  return toMeta(result.rows[0], acceptedAt, intervalWeeks);
}

/**
 * Athlete phrases that mean “run a settings/dossier audit” in chat (#40 / US-38).
 */
export function isDossierAuditRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\baudit my settings\b/i.test(t) || /\bsettings audit\b/i.test(t)) {
    return true;
  }
  if (/\baudit\b/i.test(t) && /\b(settings|dossier|brief|memory)\b/i.test(t)) {
    return true;
  }
  if (
    /\b(trim|consolidate)\b/i.test(t) &&
    /\b(settings|dossier|brief)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}
