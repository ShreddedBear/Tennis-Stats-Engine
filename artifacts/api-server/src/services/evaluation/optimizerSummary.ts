import {
  db,
  evaluationPredictionsTable,
  candidateConfigsTable,
  configPromotionsTable,
  evaluationRunsTable,
  thresholdEvaluationRunsTable,
  patternAnalysisRunsTable,
  type EvaluationPredictionRow,
} from "@workspace/db";
import { desc } from "drizzle-orm";
import { computeSegmentMetrics, type SegmentMetrics } from "./metrics";
import { getCurrentProductionStrategyIdentity } from "./strategyIdentity";

interface StrategyPick {
  id: number | null;
  name: string | null;
  status: string | null;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  calibrationError: number | null;
  createdAt: string | null;
}

interface CandidateRow {
  id: number;
  name: string;
  strategyName: string | null;
  strategyVersion: string | null;
  status: string;
  notes: string | null;
  holdoutMetrics: unknown;
  validationMetrics: unknown;
  proposedConfig: unknown;
  createdAt: Date;
}

export interface ProductionPerformanceSummary {
  strategyName: string | null;
  strategyVersion: string | null;
  dateImplemented: string | null;
  lastValidationDate: string | null;
  overallAccuracy: number | null;
  walkForwardAccuracy: number | null;
  shadowReplayAccuracy: number | null;
  paperTradingAccuracy: number | null;
  liveGradedAccuracy: number | null;
  brierScore: number | null;
  logLoss: number | null;
  ece: number | null;
  calibrationError: number | null;
  coverage: number | null;
  abstentionRate: number | null;
  totalPredictions: number;
  totalGradedPredictions: number;
}

export interface OptimizerSummary {
  status: "idle" | "running" | "completed";
  lastRunAt: string | null;
  currentStage: string | null;
  strategiesGenerated: number;
  strategiesTested: number;
  uniqueStrategies: number;
  duplicateStrategiesRejected: number;
  strategiesAwaitingValidation: number;
  strategiesInShadowMode: number;
  challengers: number;
  archivedStrategies: number;
  failedStrategies: number;
  bestNewStrategy: StrategyPick;
  bestHistoricalStrategy: StrategyPick;
  largestAccuracyImprovement: number | null;
  largestBrierImprovement: number | null;
  largestLogLossImprovement: number | null;
  nextScheduledOptimizerRun: string | null;
}

export interface OptimizerAccuracySummaryResponse {
  production: ProductionPerformanceSummary;
  optimizer: OptimizerSummary;
  comparison: {
    production: StrategyPick;
    challenger: StrategyPick;
  };
  bestByCategory: {
    currentProductionStrategy: StrategyPick;
    currentChallengerStrategy: StrategyPick;
    bestHistoricalStrategy: StrategyPick;
    bestNewlyGeneratedStrategy: StrategyPick;
    bestBySurface: StrategyPick;
    bestByTourLevel: StrategyPick;
    bestByCompetitiveBalanceTier: StrategyPick;
    bestByEvidenceReliabilityTier: StrategyPick;
    bestByRecommendationType: StrategyPick;
    bestByCalibrationQuality: StrategyPick;
    bestByRawWinnerAccuracy: StrategyPick;
  };
  validation600: {
    sampleTarget: number;
    sampleSize: number;
    sampleReady: boolean;
    status: string;
    timestamp: string | null;
    datasetRangeStart: string | null;
    datasetRangeEnd: string | null;
    baseline: {
      accuracy: number | null;
      logLoss: number | null;
      brier: number | null;
      ece: number | null;
      coverage: number | null;
      abstentionRate: number | null;
      gradedRows: number;
    };
    candidate: {
      id: number | null;
      name: string | null;
      strategyVersion: string | null;
      status: string | null;
      accuracy: number | null;
      logLoss: number | null;
      brier: number | null;
      ece: number | null;
      coverage: number | null;
      abstentionRate: number | null;
    };
    deltas: {
      accuracy: number | null;
      logLoss: number | null;
      brier: number | null;
      ece: number | null;
    };
    tradesRejected: number | null;
    tradesRejectedEstimated: boolean;
    lossesAvoided: number | null;
    lossesAvoidedEstimated: boolean;
    promotionRecommendation: "Promote" | "Hold";
    limitation: string | null;
  };
  updatedAt: string;
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function readMetric(metrics: Record<string, unknown>, keys: string[]): number | null {
  // Honesty guard (temporal-integrity-leakage-report.md #3.2): candidateOptimizer.ts marks a
  // batch-generated candidate's holdoutMetrics `candidateSpecificallyScored: false` when those
  // numbers are the ONE shared walk-forward run's pooled result, not this candidate's own
  // strategySpec independently scored. Never let ranking/comparison read a metric explicitly
  // flagged that way -- an absent flag (older/manually-entered rows) is unaffected.
  if (metrics["candidateSpecificallyScored"] === false) return null;
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readStrategySpec(row: Record<string, unknown>): Record<string, unknown> {
  const strategySpec = row["strategySpec"];
  return strategySpec && typeof strategySpec === "object" ? (strategySpec as Record<string, unknown>) : {};
}

function emptyPick(): StrategyPick {
  return {
    id: null,
    name: null,
    status: null,
    accuracy: null,
    brier: null,
    logLoss: null,
    calibrationError: null,
    createdAt: null,
  };
}

function toPickFromCandidate(row: CandidateRow | null): StrategyPick {
  if (!row) return emptyPick();
  const holdout = asObj(row.holdoutMetrics);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    accuracy: readMetric(holdout, ["accuracy", "overallAccuracy", "candidateAccuracy"]),
    brier: readMetric(holdout, ["brier", "brierScore", "candidateBrier"]),
    logLoss: readMetric(holdout, ["logLoss", "candidateLogLoss"]),
    calibrationError: readMetric(holdout, ["ece", "eceCalibrated", "calibrationError"]),
    createdAt: row.createdAt.toISOString(),
  };
}

function bestCandidateBy(
  rows: CandidateRow[],
  predicate: (row: CandidateRow) => boolean,
  score: (row: CandidateRow) => number | null,
): CandidateRow | null {
  let winner: CandidateRow | null = null;
  let winnerScore: number | null = null;
  for (const row of rows) {
    if (!predicate(row)) continue;
    const s = score(row);
    if (s === null) continue;
    if (winnerScore === null || s > winnerScore) {
      winner = row;
      winnerScore = s;
    }
  }
  return winner;
}

function bestBy(
  rows: CandidateRow[],
  predicate: (row: CandidateRow) => boolean,
  score: (row: CandidateRow) => number | null,
): StrategyPick {
  return toPickFromCandidate(bestCandidateBy(rows, predicate, score));
}

function normalizeProductionRows(rows: EvaluationPredictionRow[], strategyId: string | null): EvaluationPredictionRow[] {
  if (!strategyId) return rows;
  return rows.filter((row) => row.strategyId === strategyId && (row.predictionMode === "production" || row.predictionMode === "paper_trading"));
}

function mergeMetrics(a: SegmentMetrics, b: SegmentMetrics): SegmentMetrics {
  const rowsN = (a.n ?? 0) + (b.n ?? 0);
  const weighted = (x: number | null, y: number | null): number | null => {
    if (x === null && y === null) return null;
    if (x !== null && y === null) return x;
    if (x === null && y !== null) return y;
    if (rowsN === 0) return null;
    return Math.round((((x as number) * (a.n ?? 0) + (y as number) * (b.n ?? 0)) / rowsN) * 1000) / 1000;
  };
  return {
    n: rowsN,
    accuracy: weighted(a.accuracy, b.accuracy),
    logLoss: weighted(a.logLoss, b.logLoss),
    brier: weighted(a.brier, b.brier),
    dateRangeStart: a.dateRangeStart ?? b.dateRangeStart,
    dateRangeEnd: b.dateRangeEnd ?? a.dateRangeEnd,
    retiredCount: (a.retiredCount ?? 0) + (b.retiredCount ?? 0),
    retiredAccuracy: weighted(a.retiredAccuracy, b.retiredAccuracy),
    voidCount: (a.voidCount ?? 0) + (b.voidCount ?? 0),
    missedCount: (a.missedCount ?? 0) + (b.missedCount ?? 0),
    eceRaw: weighted(a.eceRaw, b.eceRaw),
    eceCalibrated: weighted(a.eceCalibrated, b.eceCalibrated),
  };
}

function strategyFingerprintFromRow(row: CandidateRow): string | null {
  const proposed = asObj(row.proposedConfig);
  const fingerprint = proposed["strategyFingerprint"];
  return typeof fingerprint === "string" ? fingerprint : null;
}

function readStrategyVersionFromPromotion(newConfig: unknown): string | null {
  const cfg = asObj(newConfig);
  const direct = cfg["modelVersion"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct;
  const metadata = asObj(cfg["metadata"]);
  const nested = metadata["modelVersion"];
  if (typeof nested === "string" && nested.trim().length > 0) return nested;
  return null;
}

function strategyCategoryMatches(
  row: CandidateRow,
  key: "surface" | "tour" | "competitiveBalance" | "reliability" | "recommendation",
): boolean {
  const proposed = asObj(row.proposedConfig);
  const spec = readStrategySpec(proposed);
  const gates = asObj(spec["gates"]);

  if (key === "surface") return spec["specialistRouting"] === "surface-only" || spec["specialistRouting"] === "active-segments";
  if (key === "tour") return spec["specialistRouting"] === "tour-only" || spec["specialistRouting"] === "active-segments";
  if (key === "competitiveBalance") return gates["useCompetitiveBalanceShrink"] === true;
  if (key === "reliability") return gates["useReliabilityGates"] === true;
  return typeof spec["abstentionPolicy"] === "string";
}

function deriveDuplicateRejected(row: CandidateRow): number {
  const validation = asObj(row.validationMetrics);
  const checks = validation["acceptanceChecks"];
  if (!Array.isArray(checks)) return 0;
  let rejected = 0;
  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    const item = check as Record<string, unknown>;
    const checkName = typeof item["check"] === "string" ? item["check"] : "";
    const passed = item["passed"] === true;
    if (!passed && (checkName.includes("duplicate") || checkName.includes("novelty"))) rejected += 1;
  }
  return rejected;
}

function readCoverage(metrics: Record<string, unknown>): number | null {
  const direct = readMetric(metrics, ["coverage"]);
  if (direct !== null) return direct;
  const total = metrics["totalPredictions"];
  const graded = metrics["totalGradedPredictions"];
  if (typeof total === "number" && Number.isFinite(total) && total > 0 && typeof graded === "number" && Number.isFinite(graded)) {
    return Math.round((graded / total) * 1000) / 10;
  }
  return null;
}

function readAbstention(metrics: Record<string, unknown>): number | null {
  const direct = readMetric(metrics, ["abstentionRate"]);
  if (direct !== null) return direct;
  const coverage = readCoverage(metrics);
  if (coverage === null) return null;
  return Math.round((100 - coverage) * 10) / 10;
}

export async function getOptimizerAccuracySummary(): Promise<OptimizerAccuracySummaryResponse> {
  const [lastPromotion, allCandidates, allPredictions, lastWalkForward, latestThreshold, latestPattern] = await Promise.all([
    db.select().from(configPromotionsTable).orderBy(desc(configPromotionsTable.approvedAt)).limit(1),
    db.select().from(candidateConfigsTable).orderBy(desc(candidateConfigsTable.createdAt)).limit(500),
    db.select().from(evaluationPredictionsTable),
    db.select().from(evaluationRunsTable).orderBy(desc(evaluationRunsTable.createdAt)).limit(1),
    db.select().from(thresholdEvaluationRunsTable).orderBy(desc(thresholdEvaluationRunsTable.createdAt)).limit(1),
    db.select().from(patternAnalysisRunsTable).orderBy(desc(patternAnalysisRunsTable.createdAt)).limit(1),
  ]);

  const promotion = lastPromotion[0] ?? null;
  const productionIdentity = await getCurrentProductionStrategyIdentity();
  const implementedAt = promotion?.approvedAt ?? null;
  const promotedModelVersion = readStrategyVersionFromPromotion(promotion?.newConfig ?? null) ?? productionIdentity.strategyVersion;

  const candidateStrategies: CandidateRow[] = allCandidates.map((c) => ({
    id: c.id,
    name: c.name,
    strategyName: c.strategyName,
    strategyVersion: c.strategyVersion,
    status: c.status,
    notes: c.notes,
    holdoutMetrics: c.holdoutMetrics,
    validationMetrics: c.validationMetrics,
    proposedConfig: c.proposedConfig,
    createdAt: c.createdAt,
  }));

  const productionRows = normalizeProductionRows(allPredictions, productionIdentity.strategyId);
  const productionWalkForwardRows = productionRows.filter((r) => r.runKind === "historical_test" && r.segment === "test");
  const productionShadowRows = productionRows.filter((r) => r.runKind === "paper_trade_shadow");
  const productionPaperRows = productionRows.filter((r) => r.runKind === "paper_trade");
  const productionLiveRows = productionRows.filter((r) => r.runKind === "live");

  const wfMetrics = computeSegmentMetrics(productionWalkForwardRows);
  const shadowMetrics = computeSegmentMetrics(productionShadowRows);
  const paperMetrics = computeSegmentMetrics(productionPaperRows);
  const liveMetrics = computeSegmentMetrics(productionLiveRows);
  const overallMetrics = mergeMetrics(mergeMetrics(wfMetrics, paperMetrics), liveMetrics);

  const totalPredictions = productionRows.length;
  const totalGradedPredictions = productionRows.filter((r) => r.status === "graded" || r.status === "void").length;
  const abstentions = productionRows.filter((r) => r.status === "missed" || r.predictedWinnerId === null).length;
  const abstentionRate = totalPredictions > 0 ? Math.round((abstentions / totalPredictions) * 1000) / 10 : null;
  const coverage = abstentionRate === null ? null : Math.round((100 - abstentionRate) * 10) / 10;

  const productionPick: StrategyPick = {
    id: promotion?.candidateConfigId ?? null,
    name: promotion?.candidateConfigId ? `Promoted Candidate #${promotion.candidateConfigId}` : "Default Production",
    status: "promoted",
    accuracy: overallMetrics.accuracy,
    brier: overallMetrics.brier,
    logLoss: overallMetrics.logLoss,
    calibrationError: overallMetrics.eceCalibrated,
    createdAt: asIso(implementedAt),
  };

  const challengerRow = candidateStrategies.find((c) => c.status === "approved" || c.status === "under-review") ?? null;
  const challengerPick = toPickFromCandidate(challengerRow);

  const bestHistorical = bestBy(
    candidateStrategies,
    (r) => r.status !== "promoted" && r.status !== "archived",
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy", "candidateAccuracy"]),
  );

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const bestNew = bestBy(
    candidateStrategies,
    (r) => r.createdAt >= oneWeekAgo,
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy", "candidateAccuracy"]),
  );

  const bySurface = bestBy(
    candidateStrategies,
    (r) => strategyCategoryMatches(r, "surface"),
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy"]),
  );

  const byTour = bestBy(
    candidateStrategies,
    (r) => strategyCategoryMatches(r, "tour"),
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy"]),
  );

  const byCompetitiveBalance = bestBy(
    candidateStrategies,
    (r) => strategyCategoryMatches(r, "competitiveBalance"),
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy"]),
  );

  const byReliability = bestBy(
    candidateStrategies,
    (r) => strategyCategoryMatches(r, "reliability"),
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy"]),
  );

  const byRecommendation = bestBy(
    candidateStrategies,
    (r) => strategyCategoryMatches(r, "recommendation"),
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy"]),
  );

  const byCalibrationQuality = bestBy(
    candidateStrategies,
    (r) => readMetric(asObj(r.holdoutMetrics), ["logLoss", "candidateLogLoss"]) !== null,
    (r) => {
      const ll = readMetric(asObj(r.holdoutMetrics), ["logLoss", "candidateLogLoss"]);
      return ll === null ? null : -ll;
    },
  );

  const byRawAccuracy = bestBy(
    candidateStrategies,
    () => true,
    (r) => readMetric(asObj(r.holdoutMetrics), ["accuracy", "overallAccuracy", "candidateAccuracy"]),
  );

  const uniqueFingerprints = new Set(
    candidateStrategies.map(strategyFingerprintFromRow).filter((x): x is string => x !== null),
  );

  const duplicateRejected = candidateStrategies.map(deriveDuplicateRejected).reduce((a, b) => a + b, 0);

  const strategiesTested = candidateStrategies.filter((r) => {
    const holdout = asObj(r.holdoutMetrics);
    return readMetric(holdout, ["accuracy", "overallAccuracy", "candidateAccuracy", "logLoss", "brier"]) !== null;
  }).length;

  const awaitingValidation = candidateStrategies.filter((r) => r.status === "pending" || r.status === "under-review").length;
  const inShadow = candidateStrategies.filter((r) => (r.notes ?? "").toLowerCase().includes("shadow")).length;
  const challengers = candidateStrategies.filter((r) => r.status === "approved" || r.status === "under-review").length;
  const archived = candidateStrategies.filter((r) => r.status === "archived").length;
  const failed = candidateStrategies.filter((r) => r.status === "rejected").length;

  const prodAcc = overallMetrics.accuracy;
  const prodBrier = overallMetrics.brier;
  const prodLl = overallMetrics.logLoss;

  let largestAccImprovement: number | null = null;
  let largestBrierImprovement: number | null = null;
  let largestLlImprovement: number | null = null;
  for (const row of candidateStrategies) {
    const holdout = asObj(row.holdoutMetrics);
    const acc = readMetric(holdout, ["accuracy", "overallAccuracy", "candidateAccuracy"]);
    const brier = readMetric(holdout, ["brier", "brierScore", "candidateBrier"]);
    const ll = readMetric(holdout, ["logLoss", "candidateLogLoss"]);

    if (prodAcc !== null && acc !== null) {
      const delta = Math.round((acc - prodAcc) * 100) / 100;
      if (largestAccImprovement === null || delta > largestAccImprovement) largestAccImprovement = delta;
    }
    if (prodBrier !== null && brier !== null) {
      const delta = Math.round((prodBrier - brier) * 1000) / 1000;
      if (largestBrierImprovement === null || delta > largestBrierImprovement) largestBrierImprovement = delta;
    }
    if (prodLl !== null && ll !== null) {
      const delta = Math.round((prodLl - ll) * 1000) / 1000;
      if (largestLlImprovement === null || delta > largestLlImprovement) largestLlImprovement = delta;
    }
  }

  const lastRunAt = latestThreshold[0]?.createdAt ?? latestPattern[0]?.createdAt ?? lastWalkForward[0]?.createdAt ?? null;

  const VALIDATION_SAMPLE_TARGET = 600;
  const gradedProductionRows = productionRows
    .filter((r) => r.status === "graded" || r.status === "void")
    .filter((r) => r.runKind !== "paper_trade_shadow")
    .filter((r) => !(r.runKind === "historical_test" && r.segment === "validation"));
  const latestSampleRows = [...gradedProductionRows]
    .sort((a, b) => {
      const aT = (a.gradedAt ?? a.lockedAt).getTime();
      const bT = (b.gradedAt ?? b.lockedAt).getTime();
      return bT - aT;
    })
    .slice(0, VALIDATION_SAMPLE_TARGET);
  const latestSampleMetrics = computeSegmentMetrics(latestSampleRows);
  const sampleCoverage = latestSampleRows.length > 0 ? Math.round((latestSampleMetrics.n / latestSampleRows.length) * 1000) / 10 : null;
  const sampleAbstention = sampleCoverage === null ? null : Math.round((100 - sampleCoverage) * 10) / 10;
  const latestSampleTimestamps = latestSampleRows.map((r) => (r.gradedAt ?? r.lockedAt).getTime());

  let bestCandidateForValidation: CandidateRow | null = null;
  let bestCandidateAccuracy = -Infinity;
  for (const row of candidateStrategies) {
    if (row.status === "rejected" || row.status === "archived") continue;
    const holdout = asObj(row.holdoutMetrics);
    const candidateAcc = readMetric(holdout, ["accuracy", "overallAccuracy", "candidateAccuracy"]);
    if (candidateAcc === null) continue;
    if (candidateAcc > bestCandidateAccuracy) {
      bestCandidateAccuracy = candidateAcc;
      bestCandidateForValidation = row;
    }
  }

  const candidateMetrics = bestCandidateForValidation ? asObj(bestCandidateForValidation.holdoutMetrics) : {};
  const candidateAcc = readMetric(candidateMetrics, ["accuracy", "overallAccuracy", "candidateAccuracy"]);
  const candidateLogLoss = readMetric(candidateMetrics, ["logLoss", "candidateLogLoss"]);
  const candidateBrier = readMetric(candidateMetrics, ["brier", "brierScore", "candidateBrier"]);
  const candidateEce = readMetric(candidateMetrics, ["ece", "eceCalibrated", "calibrationError"]);
  const candidateCoverage = readCoverage(candidateMetrics);
  const candidateAbstention = readAbstention(candidateMetrics);

  const sampleReady = latestSampleRows.length >= VALIDATION_SAMPLE_TARGET;
  const deltaAcc = candidateAcc !== null && latestSampleMetrics.accuracy !== null
    ? Math.round((candidateAcc - latestSampleMetrics.accuracy) * 100) / 100
    : null;
  const deltaLogLoss = candidateLogLoss !== null && latestSampleMetrics.logLoss !== null
    ? Math.round((candidateLogLoss - latestSampleMetrics.logLoss) * 1000) / 1000
    : null;
  const deltaBrier = candidateBrier !== null && latestSampleMetrics.brier !== null
    ? Math.round((candidateBrier - latestSampleMetrics.brier) * 1000) / 1000
    : null;
  const deltaEce = candidateEce !== null && latestSampleMetrics.eceCalibrated !== null
    ? Math.round((candidateEce - latestSampleMetrics.eceCalibrated) * 1000) / 1000
    : null;

  const promotionRecommendation: "Promote" | "Hold" =
    sampleReady && deltaAcc !== null && deltaLogLoss !== null && deltaBrier !== null && deltaEce !== null && deltaAcc >= 0.5 && deltaLogLoss < 0 && deltaBrier < 0 && deltaEce <= 0
      ? "Promote"
      : "Hold";

  // Exact same-cohort candidate rows are not yet persisted; derive transparent estimates from
  // aggregate deltas when candidate holdout metrics include coverage/accuracy.
  const estimatedTradesRejected =
    candidateCoverage !== null && sampleCoverage !== null
      ? Math.max(0, Math.round((sampleCoverage - candidateCoverage) * latestSampleRows.length / 100))
      : null;
  const estimatedLossesAvoided =
    deltaAcc !== null
      ? Math.max(0, Math.round((deltaAcc / 100) * latestSampleMetrics.n))
      : null;

  const validationStatus = sampleReady
    ? `Ready (${VALIDATION_SAMPLE_TARGET} graded rows)`
    : `Insufficient graded rows (${latestSampleRows.length}/${VALIDATION_SAMPLE_TARGET})`;

  const limitation =
    bestCandidateForValidation === null
      ? "No candidate with holdout metrics exists yet."
      : "Candidate metrics are holdout-summary metrics and are not yet persisted as per-match outcomes on the exact same 600-row cohort. Trades Rejected and Losses Avoided are aggregate estimates derived from coverage/accuracy deltas.";

  return {
    production: {
      strategyName: productionPick.name,
      strategyVersion: promotedModelVersion ?? productionIdentity.strategyVersion,
      dateImplemented: asIso(implementedAt),
      lastValidationDate: asIso(lastWalkForward[0]?.createdAt ?? null),
      overallAccuracy: overallMetrics.accuracy,
      walkForwardAccuracy: wfMetrics.accuracy,
      shadowReplayAccuracy: shadowMetrics.accuracy,
      paperTradingAccuracy: paperMetrics.accuracy,
      liveGradedAccuracy: liveMetrics.accuracy,
      brierScore: overallMetrics.brier,
      logLoss: overallMetrics.logLoss,
      ece: overallMetrics.eceCalibrated,
      calibrationError: overallMetrics.eceCalibrated,
      coverage,
      abstentionRate,
      totalPredictions,
      totalGradedPredictions,
    },
    optimizer: {
      status: candidateStrategies.length === 0 ? "idle" : "completed",
      lastRunAt: asIso(lastRunAt),
      currentStage: "idle",
      strategiesGenerated: candidateStrategies.length,
      strategiesTested,
      uniqueStrategies: uniqueFingerprints.size,
      duplicateStrategiesRejected: duplicateRejected,
      strategiesAwaitingValidation: awaitingValidation,
      strategiesInShadowMode: inShadow,
      challengers,
      archivedStrategies: archived,
      failedStrategies: failed,
      bestNewStrategy: bestNew,
      bestHistoricalStrategy: bestHistorical,
      largestAccuracyImprovement: largestAccImprovement,
      largestBrierImprovement: largestBrierImprovement,
      largestLogLossImprovement: largestLlImprovement,
      nextScheduledOptimizerRun: null,
    },
    comparison: {
      production: productionPick,
      challenger: challengerPick,
    },
    bestByCategory: {
      currentProductionStrategy: productionPick,
      currentChallengerStrategy: challengerPick,
      bestHistoricalStrategy: bestHistorical,
      bestNewlyGeneratedStrategy: bestNew,
      bestBySurface: bySurface,
      bestByTourLevel: byTour,
      bestByCompetitiveBalanceTier: byCompetitiveBalance,
      bestByEvidenceReliabilityTier: byReliability,
      bestByRecommendationType: byRecommendation,
      bestByCalibrationQuality: byCalibrationQuality,
      bestByRawWinnerAccuracy: byRawAccuracy,
    },
    validation600: {
      sampleTarget: VALIDATION_SAMPLE_TARGET,
      sampleSize: latestSampleRows.length,
      sampleReady,
      status: validationStatus,
      timestamp: latestSampleTimestamps.length > 0 ? new Date(Math.max(...latestSampleTimestamps)).toISOString() : null,
      datasetRangeStart: latestSampleMetrics.dateRangeStart,
      datasetRangeEnd: latestSampleMetrics.dateRangeEnd,
      baseline: {
        accuracy: latestSampleMetrics.accuracy,
        logLoss: latestSampleMetrics.logLoss,
        brier: latestSampleMetrics.brier,
        ece: latestSampleMetrics.eceCalibrated,
        coverage: sampleCoverage,
        abstentionRate: sampleAbstention,
        gradedRows: latestSampleRows.length,
      },
      candidate: {
        id: bestCandidateForValidation?.id ?? null,
        name: bestCandidateForValidation?.strategyName ?? bestCandidateForValidation?.name ?? null,
        strategyVersion: bestCandidateForValidation?.strategyVersion ?? null,
        status: bestCandidateForValidation?.status ?? null,
        accuracy: candidateAcc,
        logLoss: candidateLogLoss,
        brier: candidateBrier,
        ece: candidateEce,
        coverage: candidateCoverage,
        abstentionRate: candidateAbstention,
      },
      deltas: {
        accuracy: deltaAcc,
        logLoss: deltaLogLoss,
        brier: deltaBrier,
        ece: deltaEce,
      },
      tradesRejected: estimatedTradesRejected,
      tradesRejectedEstimated: estimatedTradesRejected !== null,
      lossesAvoided: estimatedLossesAvoided,
      lossesAvoidedEstimated: estimatedLossesAvoided !== null,
      promotionRecommendation,
      limitation,
    },
    updatedAt: new Date().toISOString(),
  };
}
