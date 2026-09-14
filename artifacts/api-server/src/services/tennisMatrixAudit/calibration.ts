// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — the calibration ledger.
//
// Continuous calibration: every graded result creates a NEW immutable calibration version
// rather than editing the current one. Nothing is ever updated in place, so a board figure
// from three weeks ago can still be traced to the exact bucket record that produced it --
// which is the only reason a "verified win rate" printed next to a selection means anything.
//
// This is NOT the AI prediction engine's calibration. It grades the Matrix summary's stated
// win probability against the real result, and the engine's own deterministic selection
// never consumes it. It is a record of how a stated probability has actually performed.
// ----------------------------------------------------------------------------
import { pool } from "@workspace/db";
import { bucketFor, LOCAL_WORKSPACE_ID, winRate } from "@workspace/truth-engine";

/** Retirements are real results. Walkovers and voids are recorded but never counted. */
export const RESULT_TYPES = ["WIN", "LOSS", "RETIREMENT WIN", "RETIREMENT LOSS", "WALKOVER", "VOID"] as const;
const COUNTING_RESULTS = new Set(["WIN", "LOSS", "RETIREMENT WIN", "RETIREMENT LOSS"]);
const WINNING_RESULTS = new Set(["WIN", "RETIREMENT WIN"]);

/** A graded sample is called small below this, and reported as such rather than rounded up. */
const SMALL_SAMPLE_BELOW = 10;

export interface BucketRow {
  id: string;
  bucket_code: string;
  bucket_label: string;
  wp_min: number;
  wp_max: number;
  wins: number;
  graded: number;
  small_sample: boolean;
  win_rate: number | null;
}

export interface GradeInput {
  matchId: string | null;
  matchLabel: string;
  tournament: string | null;
  surface: string | null;
  matchDate: string | null;
  matrixPredictedWinner: string | null;
  matrixWp: number | null;
  resultType: string;
  actualWinner: string | null;
  note: string | null;
}

/** Numeric columns come back from pg as strings; the bucket search is a numeric comparison. */
const toBucket = (row: Record<string, unknown>): BucketRow => ({
  id: String(row["id"]),
  bucket_code: String(row["bucket_code"]),
  bucket_label: String(row["bucket_label"]),
  wp_min: Number(row["wp_min"]),
  wp_max: Number(row["wp_max"]),
  wins: Number(row["wins"]),
  graded: Number(row["graded"]),
  small_sample: Boolean(row["small_sample"]),
  win_rate: winRate(Number(row["wins"]), Number(row["graded"])),
});

export async function readCalibration(ledgerLimit = 100) {
  const version = await pool.query(`select * from calibration_versions where is_active = true limit 1`);
  const active = (version.rows[0] as Record<string, unknown> | undefined) ?? null;
  const buckets = active
    ? await pool.query(`select * from calibration_buckets where calibration_version_id = $1 order by wp_min`, [active["id"]])
    : { rows: [] as Array<Record<string, unknown>> };
  const ledger = await pool.query(
    `select * from calibration_ledger order by master_sequence desc limit $1`,
    [Math.min(500, Math.max(1, ledgerLimit))],
  );
  return {
    version: active,
    buckets: (buckets.rows as Array<Record<string, unknown>>).map(toBucket),
    ledger: ledger.rows,
  };
}

export async function readCalibrationHistory(limit = 40) {
  const versions = await pool.query(
    `select * from calibration_versions order by version_number desc limit $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  const ids = (versions.rows as Array<{ id: string }>).map((row) => row.id);
  const buckets = ids.length
    ? await pool.query(`select * from calibration_buckets where calibration_version_id = any($1::uuid[]) order by wp_min`, [ids])
    : { rows: [] as Array<Record<string, unknown>> };
  return {
    versions: versions.rows,
    buckets: (buckets.rows as Array<Record<string, unknown>>).map((row) => ({
      ...toBucket(row),
      calibration_version_id: String(row["calibration_version_id"]),
    })),
  };
}

/**
 * Grade one result.
 *
 * Writes a new calibration version, a full copy of the buckets with this result folded in,
 * a ledger row naming the version before and after, and deactivates the previous version --
 * all in ONE transaction. Partway through is the one state that must never be reachable:
 * two active versions, or a bucket set that does not correspond to any version, would make
 * every subsequent verified win rate unattributable.
 */
export async function gradeResult(input: GradeInput) {
  if (!input.matchLabel.trim()) throw new Error("A match label is required to grade a result");
  if (!RESULT_TYPES.includes(input.resultType as (typeof RESULT_TYPES)[number])) {
    throw new Error(`Unknown result type: ${input.resultType}`);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const currentResult = await client.query(
      `select * from calibration_versions where is_active = true limit 1 for update`,
    );
    const current = currentResult.rows[0] as Record<string, unknown> | undefined;
    if (!current) throw new Error("No active calibration version");

    const bucketResult = await client.query(
      `select * from calibration_buckets where calibration_version_id = $1 order by wp_min`,
      [current["id"]],
    );
    const buckets = (bucketResult.rows as Array<Record<string, unknown>>).map(toBucket);
    if (!buckets.length) throw new Error("Active calibration version has no buckets");

    const bucket = bucketFor(input.matrixWp, buckets);
    const counts = COUNTING_RESULTS.has(input.resultType);
    const isWin = WINNING_RESULTS.has(input.resultType);
    // A result with no stated probability has no bucket to land in. It is still recorded --
    // it happened -- but it cannot move a win rate that is defined per probability band.
    const countedInBucket = counts && bucket !== null;

    const versionNumber = Number(current["version_number"]) + 1;
    const inserted = await client.query(
      `insert into calibration_versions
         (user_id, label, version_number, master_sequence_count, graded_sample_count, is_active)
       values ($1, $2, $3, $4, $5, true) returning *`,
      [
        LOCAL_WORKSPACE_ID,
        `Calibration v${versionNumber}`,
        versionNumber,
        Number(current["master_sequence_count"]) + 1,
        Number(current["graded_sample_count"]) + (counts ? 1 : 0),
        ],
    );
    const next = inserted.rows[0] as Record<string, unknown>;

    await client.query(`update calibration_versions set is_active = false where id = $1`, [current["id"]]);

    for (const existing of buckets) {
      const hit = countedInBucket && bucket!.id === existing.id;
      const graded = existing.graded + (hit ? 1 : 0);
      const wins = existing.wins + (hit && isWin ? 1 : 0);
      await client.query(
        `insert into calibration_buckets
           (user_id, calibration_version_id, bucket_code, bucket_label, wp_min, wp_max, wins, graded, small_sample)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          LOCAL_WORKSPACE_ID, next["id"], existing.bucket_code, existing.bucket_label,
          existing.wp_min, existing.wp_max, wins, graded, graded < SMALL_SAMPLE_BELOW,
        ],
      );
    }

    await client.query(
      `insert into calibration_ledger
         (user_id, match_id, match_label, tournament, surface, match_date, matrix_predicted_winner, matrix_wp,
          actual_winner, result_type, result_grading_status, counted_in_bucket, bucket_code, master_sequence,
          calibration_version_before, calibration_version_after, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        LOCAL_WORKSPACE_ID, input.matchId, input.matchLabel, input.tournament, input.surface, input.matchDate,
        input.matrixPredictedWinner, input.matrixWp, input.actualWinner, input.resultType,
        counts ? "GRADED" : "NOT GRADED", countedInBucket, bucket?.bucket_code ?? null,
        Number(next["master_sequence_count"]), current["id"], next["id"], input.note,
      ],
    );

    await client.query("commit");
    return { version: next, bucketCode: bucket?.bucket_code ?? null, counted: countedInBucket };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Prefill the prediction half of the grading form from a match's own parsed summary.
 *
 * Deliberately only the PREDICTION fields. The actual winner and result type are never
 * inferred here: they are the thing being graded, and filling them in from anything other
 * than a person reading the real result would make the ledger self-confirming.
 */
export async function matrixCalibrationInputs(matchId: string) {
  const match = await pool.query(
    `select id, player1_name, player2_name, tournament_name, surface, scheduled_date, active_summary_version_id
       from matches where id = $1`,
    [matchId],
  );
  const row = match.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const fields = row["active_summary_version_id"]
    ? await pool.query(
        `select field_key, normalized_value from parsed_summary_fields where summary_version_id = $1`,
        [row["active_summary_version_id"]],
      )
    : { rows: [] as Array<Record<string, unknown>> };
  const value = (key: string) =>
    (fields.rows as Array<Record<string, unknown>>).find((f) => f["field_key"] === key)?.["normalized_value"] ?? null;

  const wp = value("matrix_wp");
  return {
    matchLabel: `${row["player1_name"]} vs ${row["player2_name"]}`,
    tournament: (row["tournament_name"] as string | null) ?? null,
    surface: (row["surface"] as string | null) ?? null,
    matchDate: (row["scheduled_date"] as string | null) ?? null,
    matrixPredictedWinner: (value("matrix_predicted_winner") as string | null) ?? null,
    matrixWp: wp === null || wp === "" || Number.isNaN(Number(wp)) ? null : Number(wp),
  };
}
