import { pool } from "../db.js";
import type {
  GoalDistance,
  GoalKind,
  GoalSource,
  TrainingGoal,
} from "./types.js";

/** One stored goal row. Rows are never updated; the latest is current. */
export type GoalVersion = {
  id: number;
  goal: TrainingGoal;
  source: GoalSource;
  createdAt: string;
};

type Row = {
  id: string | number;
  kind: GoalKind;
  distance: GoalDistance | null;
  race_name: string | null;
  race_date: string | null;
  target: string | null;
  starting_point: string | null;
  since: string | null;
  source: GoalSource;
  created_at: Date;
};

const COLUMNS = `id, kind, distance, race_name,
  to_char(race_date, 'YYYY-MM-DD') AS race_date,
  target, starting_point,
  to_char(since, 'YYYY-MM-DD') AS since,
  source, created_at`;

function toVersion(row: Row): GoalVersion {
  const goal: TrainingGoal = { kind: row.kind };
  if (row.distance !== null) goal.distance = row.distance;
  if (row.race_name !== null) goal.raceName = row.race_name;
  if (row.race_date !== null) goal.raceDate = row.race_date;
  if (row.target !== null) goal.target = row.target;
  if (row.starting_point !== null) goal.startingPoint = row.starting_point;
  if (row.since !== null) goal.since = row.since;
  return {
    id: Number(row.id),
    goal,
    source: row.source,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getCurrentGoal(): Promise<GoalVersion | null> {
  const result = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM training_goals ORDER BY id DESC LIMIT 1`,
  );
  const row = result.rows[0];
  return row ? toVersion(row) : null;
}

/** Append a goal row; it becomes the current goal. `goal` must already be parsed. */
export async function appendGoal(
  at: Date,
  goal: TrainingGoal,
  source: GoalSource,
): Promise<GoalVersion> {
  const result = await pool.query<Row>(
    `
    INSERT INTO training_goals
      (kind, distance, race_name, race_date, target, starting_point, since, source, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING ${COLUMNS}
    `,
    [
      goal.kind,
      goal.distance ?? null,
      goal.raceName ?? null,
      goal.raceDate ?? null,
      goal.target ?? null,
      goal.startingPoint ?? null,
      goal.since ?? null,
      source,
      at,
    ],
  );
  return toVersion(result.rows[0]!);
}
