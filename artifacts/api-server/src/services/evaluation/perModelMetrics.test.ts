import { test } from "node:test";
import assert from "node:assert/strict";
import { computePerModelMetrics, classifyModelAvailability, extractSnapshot } from "./perModelMetrics";
import type { EvaluationPredictionRow } from "@workspace/db";
import type { EngineBreakdown, ModuleTrace } from "../predictionEngine";

/** Builds a minimal, type-erased fixture -- only the fields `perModelMetrics.ts` actually reads are populated. */
function fixtureRow(opts: {
  id: number;
  player1Id?: string;
  player2Id?: string;
  actualWinnerId?: string | null;
  engine: Partial<EngineBreakdown>;
  moduleWeights?: ModuleTrace[];
}): EvaluationPredictionRow {
  const player1Id = opts.player1Id ?? "p1";
  const player2Id = opts.player2Id ?? "p2";
  return {
    id: opts.id,
    player1Id,
    player2Id,
    actualWinnerId: opts.actualWinnerId === undefined ? player1Id : opts.actualWinnerId,
    featureSnapshot: {
      engine: { models: [], segmentKey: null, specialistApplied: false, ...opts.engine },
      moduleWeights: opts.moduleWeights,
    },
  } as unknown as EvaluationPredictionRow;
}

function trioModuleTrace(key: string, opts: { excludedFromEnsemble?: boolean; excludedByAblation?: boolean; player1Probability: number | null }): ModuleTrace {
  return {
    key,
    name: key,
    rawEdge: 0,
    reliability: 80,
    importance: 1,
    weightPrior: 1,
    confidenceShrink: 1,
    excludedFromEnsemble: opts.excludedFromEnsemble ?? false,
    excludedFromDataQuality: false,
    excludedByAblation: opts.excludedByAblation ?? false,
    player1Probability: opts.player1Probability,
    effectiveWeight: opts.player1Probability !== null ? 0.3 : null,
    voteDirection: null,
  } as unknown as ModuleTrace;
}

test("classifyModelAvailability: Specialist with no candidate segment is unavailable", () => {
  const row = fixtureRow({ id: 1, engine: { segmentKey: null, specialistApplied: false } });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "specialist"), "unavailable");
});

test("classifyModelAvailability: Specialist with a candidate segment that didn't apply is available_excluded, not unavailable", () => {
  const row = fixtureRow({ id: 2, engine: { segmentKey: "ATP-Clay", specialistApplied: false, models: [] } });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "specialist"), "available_excluded");
});

test("classifyModelAvailability: Specialist that actually voted is active", () => {
  const row = fixtureRow({
    id: 3,
    engine: { segmentKey: "ATP-Clay", specialistApplied: true, models: [{ modelName: "Segment Specialist (ATP-Clay)", player1Probability: 62, weightUsed: 0.7, reliability: 90 }] },
  });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "specialist"), "active");
});

test("classifyModelAvailability: General Model absent from engine.models is unavailable (conservative -- never guessed as excluded)", () => {
  const row = fixtureRow({ id: 4, engine: { models: [] } });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "general"), "unavailable");
});

test("classifyModelAvailability: Surface Elo excluded via moduleWeights (ablation) is available_excluded, not active", () => {
  const row = fixtureRow({
    id: 5,
    engine: { models: [] },
    moduleWeights: [trioModuleTrace("surfaceElo", { excludedByAblation: true, player1Probability: null })],
  });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "surfaceElo"), "available_excluded");
});

test("classifyModelAvailability: Surface Elo present and voting via moduleWeights is active", () => {
  const row = fixtureRow({
    id: 6,
    engine: { models: [{ modelName: "Surface Elo", player1Probability: 58, weightUsed: 0.4, reliability: 85 }] },
    moduleWeights: [trioModuleTrace("surfaceElo", { player1Probability: 58 })],
  });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "surfaceElo"), "active");
});

test("classifyModelAvailability: falls back to engine.models presence when moduleWeights is absent (older rows)", () => {
  const row = fixtureRow({ id: 7, engine: { models: [{ modelName: "Recent Form", player1Probability: 55, weightUsed: 0.3, reliability: 70 }] } });
  const snapshot = extractSnapshot(row)!;
  assert.equal(classifyModelAvailability(snapshot, "recentForm"), "active");
  const rowMissing = fixtureRow({ id: 8, engine: { models: [] } });
  assert.equal(classifyModelAvailability(extractSnapshot(rowMissing)!, "recentForm"), "unavailable");
});

test("computePerModelMetrics: unavailable and available_excluded rows are never scored as 50% and never counted as incorrect", () => {
  const rows: EvaluationPredictionRow[] = [
    // Specialist unavailable (no segment) -- player1 actually won, but Specialist had no opinion.
    fixtureRow({ id: 10, engine: { segmentKey: null, specialistApplied: false }, actualWinnerId: "p1" }),
    // Specialist available_excluded (segment exists, didn't apply) -- player2 actually won.
    fixtureRow({ id: 11, engine: { segmentKey: "WTA-Hard", specialistApplied: false, models: [] }, actualWinnerId: "p2" }),
    // Specialist active and correct.
    fixtureRow({
      id: 12,
      engine: { segmentKey: "ATP-Hard", specialistApplied: true, models: [{ modelName: "Segment Specialist (ATP-Hard)", player1Probability: 70, weightUsed: 0.8, reliability: 90 }] },
      actualWinnerId: "p1",
    }),
  ];
  const metrics = computePerModelMetrics(rows, "specialist");
  assert.equal(metrics.counts.unavailable, 1, "the no-segment row must count as unavailable");
  assert.equal(metrics.counts.availableExcluded, 1, "the segment-exists-but-didn't-apply row must count as available_excluded, not unavailable or active");
  assert.equal(metrics.counts.active, 1, "only the row where the specialist actually voted counts as active");
  assert.equal(metrics.sampleSize, 1, "accuracy/Brier/logLoss must be computed over exactly 1 row (the active, graded one) -- never the 2 non-voting rows");
  assert.equal(metrics.accuracy, 100, "the one scoreable row was a correct prediction");
});

test("computePerModelMetrics: accuracy/Brier/logLoss reflect only active rows, and Brier for a correct/incorrect pair matches hand computation", () => {
  const rows: EvaluationPredictionRow[] = [
    fixtureRow({ id: 20, engine: { models: [{ modelName: "Surface Elo", player1Probability: 80, weightUsed: 0.4, reliability: 90 }] }, actualWinnerId: "p1" }), // correct, confident
    fixtureRow({ id: 21, engine: { models: [{ modelName: "Surface Elo", player1Probability: 80, weightUsed: 0.4, reliability: 90 }] }, actualWinnerId: "p2" }), // incorrect, confident
    fixtureRow({ id: 22, engine: { segmentKey: null } }), // Surface Elo not even in engine.models -- unavailable, must not affect the two rows above
  ];
  const metrics = computePerModelMetrics(rows, "surfaceElo");
  assert.equal(metrics.sampleSize, 2);
  assert.equal(metrics.accuracy, 50);
  // Brier = mean((p - outcome)^2): (0.8-1)^2=0.04, (0.8-0)^2=0.64 -> mean 0.34
  assert.ok(metrics.brier !== null && Math.abs(metrics.brier - 0.34) < 1e-9, `expected Brier ~0.34, got ${metrics.brier}`);
  assert.equal(metrics.counts.unavailable, 1);
});

test("computePerModelMetrics: a row with no featureSnapshot.engine at all is unavailable, not a crash or a silent 50%", () => {
  const row = { id: 30, player1Id: "p1", player2Id: "p2", actualWinnerId: "p1", featureSnapshot: null } as unknown as EvaluationPredictionRow;
  const metrics = computePerModelMetrics([row], "general");
  assert.equal(metrics.counts.unavailable, 1);
  assert.equal(metrics.sampleSize, 0);
  assert.equal(metrics.accuracy, null);
});
