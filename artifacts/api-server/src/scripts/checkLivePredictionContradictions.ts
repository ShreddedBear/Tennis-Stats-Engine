// Batch contradiction check (2026-07-13 upsetRisk.ts labeling task, Step 2). Runs the same
// invariants `checkFinalConsistency` already enforces on every NEW prediction (see index.ts's
// wiring) against every EXISTING row in the live `predictions` table, plus two cross-row/display
// checks that a single-row guard can't express:
//  - duplicate `matchIdentityKey` groups (same match, re-predicted with different resolved
//    inputs, so the DB's uniqueness constraint on (matchIdentityKey, inputSnapshotHash) doesn't
//    block them) never disagree on WHO the predicted winner is.
//  - the Monte Carlo simulator's `inputReliability` figure is never shown without the
//    simulatorNote disclosing that it isn't voted-in/validated, whenever `simulatorApplied` is
//    false.
//
// Usage: pnpm --filter @workspace/api-server exec tsx src/scripts/checkLivePredictionContradictions.ts
// Cheap: single SELECT over `predictions` (a user-facing ledger table, not the multi-thousand-row
// evaluation_predictions corpus) -- safe to re-run, unlike walkForward/analyzeUpsetRiskCalibration.
import { db, predictionsTable, pool } from "@workspace/db";
import { checkFinalConsistency } from "../services/predictionEngine/finalConsistencyCheck";
import type { EngineBreakdown } from "../services/predictionEngine";

async function main(): Promise<void> {
  const rows = await db.select().from(predictionsTable);
  console.log(`Checking ${rows.length} live predictions...`);

  let violationRows = 0;
  const allViolations: string[] = [];
  const byMatchIdentity = new Map<string, { id: number; predictedWinnerId: string; recommendation: string }[]>();

  let legacyRowsSkippedForNewerFields = 0;

  for (const row of rows) {
    const engine = row.engine as EngineBreakdown;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(engine, key);

    // Fields added across several 2026-07-13 phases are genuinely absent on older stored rows
    // (see the "Not present on predictions made before this field existed" doc comments on
    // EngineBreakdown) -- that's expected schema evolution, not a contradiction. Feed
    // checkFinalConsistency a value that can never itself trip the newer rules when the field
    // simply doesn't exist yet, and track how many rows this applies to for the report.
    const isLegacyRow = !has("disagreementNote") || !has("modelConflict") || !has("upsetRiskBreakdown") || !has("isEliteTier");
    if (isLegacyRow) legacyRowsSkippedForNewerFields++;

    const { violations } = checkFinalConsistency({
      player1Id: row.player1Id,
      player2Id: row.player2Id,
      calibratedProbability: row.calibratedProbability,
      predictedWinnerId: row.predictedWinnerId,
      predictedWinnerProbability: row.predictedWinnerProbability,
      isEliteTier: engine.isEliteTier ?? false,
      eliteTierReason: engine.eliteTierReason ?? "",
      modelAgreement: engine.modelAgreement,
      upsetRisk: row.upsetRisk as never,
      upsetRiskBreakdownTier: engine.upsetRiskBreakdown?.upsetRisk ?? (row.upsetRisk as never),
      recommendation: row.recommendation,
      modelConflict: has("modelConflict") ? engine.modelConflict : false,
      // When the field doesn't exist yet, feed back whatever modelAgreement/modelConflict already
      // imply so rule 8 can't fire on a field that predates it -- only real, checkable data.
      disagreementNote: has("disagreementNote") ? engine.disagreementNote : engine.modelAgreement === "Strong" ? null : "(legacy row -- predates disagreementNote)",
      modelConflictNote: has("modelConflictNote") ? engine.modelConflictNote : null,
      upsetRiskNote: has("upsetRiskBreakdown") ? (engine.upsetRiskBreakdown?.note ?? "") : "",
      predictedSetScore: row.predictedSetScore,
      dataQuality: row.dataQuality,
      dataQualityLabel: row.dataQualityLabel as never,
      // Rule 11 (Monte Carlo headline binding): only checkable on rows that actually have a
      // stored simulation (post-Phase-7) -- absent on legacy rows, which is expected schema
      // evolution, not a violation (see `isLegacyRow` above for the same pattern).
      simulationPlayer1WinProbability: typeof engine.simulation?.player1WinProbability === "number" ? engine.simulation.player1WinProbability : null,
      // Surface Elo (and its eloDifference field) predates every "legacy row" field guarded above
      // -- it's a foundational module, not one of the later 2026-07-13 additions -- so this is a
      // real stored value on every row, not a legacy-row default standing in for missing data.
      eloGapPoints: Math.abs(engine.surfaceElo.eloDifference),
    });
    if (violations.length > 0) {
      violationRows++;
      allViolations.push(`prediction #${row.id} (${row.player1Name} vs ${row.player2Name})${isLegacyRow ? " [legacy row]" : ""}: ${violations.join(" ")}`);
    }

    // Monte Carlo unvalidated-but-labeled check.
    if (engine.simulatorApplied === false && engine.simulation && typeof engine.simulation.inputReliability === "number") {
      if (!/not.{0,40}(validated|voted)|transparency only/i.test(engine.simulatorNote ?? "")) {
        violationRows++;
        allViolations.push(`prediction #${row.id}: simulation.inputReliability=${engine.simulation.inputReliability} is shown while simulatorApplied=false, but simulatorNote doesn't disclose it's unvalidated/display-only: "${engine.simulatorNote}"`);
      }
    }

    const group = byMatchIdentity.get(row.matchIdentityKey) ?? [];
    group.push({ id: row.id, predictedWinnerId: row.predictedWinnerId, recommendation: row.recommendation });
    byMatchIdentity.set(row.matchIdentityKey, group);
  }

  let duplicateWinnerConflicts = 0;
  for (const [matchIdentityKey, group] of byMatchIdentity) {
    if (group.length < 2) continue;
    const distinctWinners = new Set(group.map((g) => g.predictedWinnerId));
    if (distinctWinners.size > 1) {
      duplicateWinnerConflicts++;
      allViolations.push(
        `matchIdentityKey ${matchIdentityKey}: ${group.length} rows disagree on predicted winner -- ${group.map((g) => `#${g.id}=${g.predictedWinnerId}`).join(", ")}.`,
      );
    }
  }

  console.log(`\nRows with contradiction-rule violations: ${violationRows}/${rows.length}`);
  console.log(`Legacy rows missing one or more newer engine fields (schema evolution, not a bug): ${legacyRowsSkippedForNewerFields}/${rows.length}`);
  console.log(`Same-match groups with disagreeing predicted winners: ${duplicateWinnerConflicts}`);
  if (allViolations.length > 0) {
    console.log("\nDetails:");
    for (const v of allViolations) console.log(`  - ${v}`);
  } else {
    console.log("\nNo contradictions found in the live predictions table.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
