/**
 * refitParlayCalibration.ts
 *
 * Fits Parlay Builder's OWN calibration model from its own graded-leg ledger
 * (parlay_leg_outcomes) and writes a new active row to parlay_calibration_models,
 * deactivating the previous one. Never reads Prediction Engine's evaluation_predictions
 * or calibration_models tables. See docs/CROSS_ENGINE_BOUNDARY.md.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/refitParlayCalibration.ts
 *
 * Env vars:
 *   DRY_RUN=1   Fit and print the result, but don't write to the database.
 */
import { pool, db, parlayCalibrationModelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { fitParlayCalibration, parlayCalibrationLogLoss, type ParlayCalibrationPoint } from "../services/parlayBuilder/parlayCalibrationFit.js";
import { invalidateParlayCalibrationCache } from "../services/parlayBuilder/parlayCalibrationCache.js";

const DRY_RUN = process.env["DRY_RUN"] === "1";
/** Holds out the most recent 15% of resolved legs (by created_at) purely to report an honest
 * log-loss figure on the model row -- not used for fitting itself. */
const HOLDOUT_FRACTION = 0.15;

interface ResolvedLegRow {
  validation_score: number;
  selected_player_id: string;
  actual_winner_id: string;
}

async function main() {
  const { rows } = await pool.query<ResolvedLegRow>(
    `SELECT validation_score, selected_player_id, actual_winner_id
     FROM parlay_leg_outcomes
     WHERE actual_winner_id IS NOT NULL
     ORDER BY created_at ASC`,
  );

  const points: ParlayCalibrationPoint[] = rows.map((r) => ({
    validationScore: r.validation_score,
    won: r.actual_winner_id === r.selected_player_id,
  }));
  console.log(`[refit-parlay-calibration] ${points.length} resolved legs from parlay_leg_outcomes`);

  const holdoutStart = Math.floor(points.length * (1 - HOLDOUT_FRACTION));
  const trainPoints = points.slice(0, holdoutStart);
  const holdoutPoints = points.slice(holdoutStart);

  const mapping = fitParlayCalibration(trainPoints);
  if (!mapping) {
    console.log(`[refit-parlay-calibration] insufficient data to fit (need >= 150 resolved legs, have ${trainPoints.length}) -- not writing a model.`);
    await pool.end();
    return;
  }

  const logLoss = parlayCalibrationLogLoss(mapping, holdoutPoints);
  console.log(`[refit-parlay-calibration] fit ${mapping.length} bins from ${trainPoints.length} training legs; holdout log loss (n=${holdoutPoints.length}): ${logLoss ?? "n/a"}`);
  console.log(mapping);

  if (DRY_RUN) {
    console.log("[refit-parlay-calibration] DRY_RUN -- not writing to database.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    await tx.update(parlayCalibrationModelsTable).set({ active: false }).where(eq(parlayCalibrationModelsTable.active, true));
    await tx.insert(parlayCalibrationModelsTable).values({
      method: "binned-lookup",
      mapping,
      trainingSampleSize: trainPoints.length,
      logLoss,
      active: true,
    });
  });
  invalidateParlayCalibrationCache();
  console.log("[refit-parlay-calibration] wrote new active model.");
  await pool.end();
}

main().catch((err) => {
  console.error("[refit-parlay-calibration] failed:", err);
  process.exit(1);
});
