// Evaluation-only, DB-free per-model metrics (P1 Package 4 follow-on: "Standalone Per-Model
// Metrics"). Computes accuracy/Brier/log loss/calibration error/sample size for a single named
// ensemble voter (Surface Elo, Serve & Return, Recent Form, General Model, Segment Specialist)
// from already-stored `EvaluationPredictionRow[]` -- callers fetch the rows (respecting the
// held-out `segment = 'test'` restriction, see `services/evaluation/ablation.ts`'s own dataset
// discipline), this module only computes over what it's given. No database access, no production
// weight/ensemble/calibration change -- this reads `feature_snapshot.engine`/`moduleWeights`,
// exactly like `scripts/analyzeCorrelatedCoreClusterOverconfidence.ts` already does, and reuses
// the existing `logLoss`/`brierScore`/`computeECE` primitives from `calibration.ts`/`metrics.ts`
// rather than reimplementing the math.
//
// Availability discipline (the actual point of this file, not an afterthought): a model that
// didn't vote on a given match must NEVER be silently scored as if it had predicted 50%, and must
// NEVER be counted as "wrong" for having no opinion. Every row is classified into exactly one of
// three states before any metric touches it:
//   - "unavailable"       -- no computable value exists for this model on this match at all (e.g.
//                            Segment Specialist has no candidate segment for this tour/surface).
//   - "available_excluded" -- the model produced a value, but it structurally did not vote (e.g.
//                            EXCLUDED_FROM_ENSEMBLE, ablated via excludedModels, or a specialist
//                            that had a candidate segment but didn't meet its own data threshold).
//   - "active"             -- the model's probability actually entered the ensemble/blend.
// Only "active" rows contribute to accuracy/Brier/logLoss/calibration. This collapses the four
// states named in the P1 Package 4 follow-on spec ("unavailable / available / available but
// excluded / active") into three: "available" has no independent meaning of its own here -- it is
// exactly the union of "active" and "available_excluded" (a model whose own computation succeeded,
// whether or not it went on to vote), exposed below as a derived boolean rather than a fourth
// mutually-exclusive state with nothing left to distinguish it from those two.
import type { EvaluationPredictionRow } from "@workspace/db";
import { logLoss, brierScore, type CalibrationPoint } from "./calibration";
import { computeECE } from "./metrics";
import type { LiveFeatureSnapshot } from "./types";
import type { EngineBreakdown, ModuleTrace } from "../predictionEngine";

export type ModelAvailabilityStatus = "unavailable" | "available_excluded" | "active";

/** The five model families this task asks for, plus how to read each one out of a stored row. */
export type PerModelMetricKey = "surfaceElo" | "serveReturn" | "recentForm" | "general" | "specialist";

export const PER_MODEL_METRIC_LABELS: Record<PerModelMetricKey, string> = {
  surfaceElo: "Surface Elo",
  serveReturn: "Serve & Return",
  recentForm: "Recent Form",
  general: "General Model",
  specialist: "Segment Specialist",
};

/** Feature-module trio keys as they appear in `ModuleTrace.key` (see `dataQuality.ts`/`AblationModelKey`). */
const TRIO_MODULE_TRACE_KEY: Partial<Record<PerModelMetricKey, string>> = {
  surfaceElo: "surfaceElo",
  serveReturn: "serveReturn",
  recentForm: "recentForm",
};

export interface ExtractedSnapshot {
  engine: EngineBreakdown;
  /** Present only on rows scored after `moduleWeights` was added to `LiveFeatureSnapshot` -- see that field's own doc comment. Null on older rows or reduced historical snapshots. */
  moduleWeights: ModuleTrace[] | null;
}

export function extractSnapshot(row: EvaluationPredictionRow): ExtractedSnapshot | null {
  const snapshot = row.featureSnapshot as unknown as Partial<LiveFeatureSnapshot> | null;
  const engine = snapshot?.engine as EngineBreakdown | undefined;
  if (!engine || !Array.isArray(engine.models)) return null;
  return { engine, moduleWeights: Array.isArray(snapshot?.moduleWeights) ? (snapshot!.moduleWeights as ModuleTrace[]) : null };
}

function findVote(engine: EngineBreakdown, modelKey: PerModelMetricKey): { player1Probability: number } | null {
  if (modelKey === "general") {
    const vote = engine.models.find((m) => m.modelName === "General Model");
    return vote ? { player1Probability: vote.player1Probability } : null;
  }
  if (modelKey === "specialist") {
    const vote = engine.models.find((m) => m.modelName.startsWith("Segment Specialist"));
    return vote ? { player1Probability: vote.player1Probability } : null;
  }
  const label = PER_MODEL_METRIC_LABELS[modelKey];
  const vote = engine.models.find((m) => m.modelName === label);
  return vote ? { player1Probability: vote.player1Probability } : null;
}

/**
 * Classifies exactly one model's status on exactly one row. Pure and DB-free -- callers already
 * have the row (or its extracted snapshot) in hand.
 */
export function classifyModelAvailability(snapshot: ExtractedSnapshot, modelKey: PerModelMetricKey): ModelAvailabilityStatus {
  const { engine, moduleWeights } = snapshot;

  if (modelKey === "specialist") {
    // `segmentKey` is null only when this match's tour/surface isn't a Phase 6 candidate segment
    // at all -- there is structurally no specialist to evaluate. `specialistApplied` is true only
    // when a specialist that DOES exist for this segment actually cleared its own data threshold
    // and voted. A segment that exists but didn't apply (didn't meet threshold, or was ablated)
    // is "available_excluded": the specialist's own model existed and was evaluable in principle,
    // it simply didn't contribute here.
    if (engine.segmentKey === null) return "unavailable";
    return engine.specialistApplied ? "active" : "available_excluded";
  }

  if (modelKey === "general") {
    // General is always computed unless deliberately ablated (see `generalEnsembleExcluded` in
    // `predictionEngine/index.ts`) -- ablation is the only reason it would be absent from
    // `engine.models`. We can't distinguish "ablated" from "absent for some other reason" purely
    // from `engine.models` alone without also knowing this row came from an ablation run, so this
    // is deliberately conservative: present -> active, absent -> unavailable (never guessed at as
    // "excluded" without positive evidence).
    return findVote(engine, "general") ? "active" : "unavailable";
  }

  // Surface Elo / Serve & Return / Recent Form: prefer `moduleWeights` (the persisted
  // `DecisionTrace.modules` trace), which directly carries `excludedFromEnsemble`/
  // `excludedByAblation`/`player1Probability` per module -- the authoritative source for this
  // distinction. Falls back to `engine.models` presence alone on older rows that predate
  // `moduleWeights`, where "excluded vs. simply missing" can no longer be told apart -- documented
  // as a real, disclosed gap (see the report), not silently assumed one way or the other.
  const traceKey = TRIO_MODULE_TRACE_KEY[modelKey]!;
  const trace = moduleWeights?.find((m) => m.key === traceKey) ?? null;
  if (trace) {
    if (trace.excludedFromEnsemble || trace.excludedByAblation) return "available_excluded";
    return trace.player1Probability !== null ? "active" : "unavailable";
  }
  return findVote(engine, modelKey) ? "active" : "unavailable";
}

export interface PerModelMetrics {
  modelKey: PerModelMetricKey;
  modelLabel: string;
  /** Row counts by classification -- always sums to the input row count. */
  counts: { unavailable: number; availableExcluded: number; active: number };
  /** Convenience derived total: availableExcluded + active. Not an independent state -- see file header. */
  availableCount: number;
  /** Metrics below are computed ONLY over "active" rows with a real graded outcome. Null when there are zero such rows. */
  sampleSize: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Expected Calibration Error over this model's own raw probability vs. real outcomes (see `computeECE`). */
  calibrationError: number | null;
}

function emptyMetrics(modelKey: PerModelMetricKey): PerModelMetrics {
  return {
    modelKey,
    modelLabel: PER_MODEL_METRIC_LABELS[modelKey],
    counts: { unavailable: 0, availableExcluded: 0, active: 0 },
    availableCount: 0,
    sampleSize: 0,
    accuracy: null,
    brier: null,
    logLoss: null,
    calibrationError: null,
  };
}

/**
 * Computes accuracy/Brier/log loss/calibration error/sample size for ONE model across `rows`,
 * respecting availability (see file header). `rows` should already be filtered by the caller to
 * the intended population (e.g. `run_kind = 'historical_test' AND segment = 'test'`) -- this
 * function does not query or filter by dataset segment itself, it only classifies and scores.
 */
export function computePerModelMetrics(rows: EvaluationPredictionRow[], modelKey: PerModelMetricKey): PerModelMetrics {
  const result = emptyMetrics(modelKey);
  const points: CalibrationPoint[] = [];
  let correct = 0;

  for (const row of rows) {
    const snapshot = extractSnapshot(row);
    if (!snapshot) {
      result.counts.unavailable += 1;
      continue;
    }
    const status = classifyModelAvailability(snapshot, modelKey);
    if (status === "unavailable") {
      result.counts.unavailable += 1;
      continue;
    }
    if (status === "available_excluded") {
      result.counts.availableExcluded += 1;
      continue;
    }
    // status === "active" -- but a metric still needs a real graded outcome to score against.
    if (row.actualWinnerId === null || (row.player1Id !== row.actualWinnerId && row.player2Id !== row.actualWinnerId)) {
      // Active but ungraded (e.g. a void/pending/missed row slipped through the caller's filter,
      // or a corrupt actualWinnerId) -- counted as active for availability bookkeeping, but not
      // scoreable. Never treated as incorrect, never treated as 50%.
      result.counts.active += 1;
      continue;
    }
    const vote = findVote(snapshot.engine, modelKey);
    if (!vote) {
      // Classified active but the vote itself couldn't be re-extracted -- should not happen given
      // `classifyModelAvailability`'s own logic, but fail safe rather than fabricate a value.
      result.counts.unavailable += 1;
      continue;
    }
    result.counts.active += 1;
    const outcome: 0 | 1 = row.actualWinnerId === row.player1Id ? 1 : 0;
    const rawProbability = vote.player1Probability / 100;
    points.push({ rawProbability, outcome });
    const predictedPlayer1 = vote.player1Probability >= 50;
    const actualPlayer1Won = outcome === 1;
    if (predictedPlayer1 === actualPlayer1Won) correct += 1;
  }

  result.availableCount = result.counts.availableExcluded + result.counts.active;
  result.sampleSize = points.length;
  if (points.length > 0) {
    result.accuracy = Math.round((correct / points.length) * 1000) / 10;
    result.brier = brierScore(points);
    result.logLoss = logLoss(points);
    result.calibrationError = computeECE(points);
  }
  return result;
}

/** Convenience: run `computePerModelMetrics` for all five requested model families at once. */
export function computeAllPerModelMetrics(rows: EvaluationPredictionRow[]): Record<PerModelMetricKey, PerModelMetrics> {
  const keys: PerModelMetricKey[] = ["surfaceElo", "serveReturn", "recentForm", "general", "specialist"];
  return Object.fromEntries(keys.map((k) => [k, computePerModelMetrics(rows, k)])) as Record<PerModelMetricKey, PerModelMetrics>;
}
