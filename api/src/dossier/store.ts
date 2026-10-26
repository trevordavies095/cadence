import { pool } from "../db.js";

export type DossierVersion = {
  id: number;
  body: string;
  createdAt: string;
};

export type DossierVersionMeta = {
  id: number;
  createdAt: string;
};

type Row = {
  id: string | number;
  body: string;
  created_at: Date;
};

function toVersion(row: Row): DossierVersion {
  return {
    id: Number(row.id),
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getCurrentDossier(): Promise<DossierVersion | null> {
  const result = await pool.query<Row>(
    `SELECT id, body, created_at
     FROM dossier_versions
     ORDER BY id DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  return row ? toVersion(row) : null;
}

export async function createDossierVersion(body: string): Promise<DossierVersion> {
  const result = await pool.query<Row>(
    `
    INSERT INTO dossier_versions (body)
    VALUES ($1)
    RETURNING id, body, created_at
    `,
    [body],
  );
  return toVersion(result.rows[0]!);
}

export async function listDossierVersions(): Promise<DossierVersionMeta[]> {
  const result = await pool.query<{ id: string | number; created_at: Date }>(
    `SELECT id, created_at FROM dossier_versions ORDER BY id DESC`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    createdAt: row.created_at.toISOString(),
  }));
}

export async function getDossierVersion(
  id: number,
): Promise<DossierVersion | null> {
  const result = await pool.query<Row>(
    `SELECT id, body, created_at FROM dossier_versions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toVersion(row) : null;
}
