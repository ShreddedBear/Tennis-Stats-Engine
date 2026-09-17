/**
 * Regression tests for the Defect 3 honesty fix (temporal-integrity-leakage-report.md #3.3):
 * runEvaluationBacktest loaded a candidate's proposedConfig but never applied it to scoring --
 * every match was silently scored with the production engine's default configuration regardless
 * of candidateConfigId, with only a quiet info-level log line as any trace of the gap.
 *
 * The scoring engine (runPredictionEngine) still has no mechanism to apply a candidate's
 * strategySpec (weights/gates/thresholds) -- building that would mean redesigning the ensemble,
 * out of scope here. This fix instead makes the gap impossible to miss: a candidate backtest now
 * marks `metrics.candidateConfigApplied: false` and pushes a run-level error (which downgrades the
 * final status to 'completed-with-warnings'), instead of silently looking identical to a real,
 * validated candidate-specific run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvaluationBacktest, type BacktestMatchLike, type BacktestTestHooks } from "./backtestService";

function fakeMatch(i: number, winner: "p1" | "p2"): BacktestMatchLike {
  return {
    id: i,
    player1Id: `p${i}a`,
    player1Name: `Player ${i}A`,
    player2Id: `p${i}b`,
    player2Name: `Player ${i}B`,
    winnerId: winner === "p1" ? `p${i}a` : `p${i}b`,
    cancelled: false,
    walkover: false,
    retired: false,
    surface: "Hard",
    matchFormat: "best_of_3",
    tournamentLevel: "ATP 250",
    tournamentName: "Test Tournament",
    scheduledStartAt: new Date(`2024-06-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`),
  };
}

const STUB_OPTIONS_BASE = {
  runId: 999_999_998, // sentinel value -- no real DB row
  dateRange: { start: "2024-01-01", end: "2024-12-31" },
  filters: {},
  mode: "optimization" as const,
};

describe("runEvaluationBacktest — candidate config honesty disclosure", () => {
  it("marks candidateConfigApplied:false and downgrades to completed-with-warnings when a candidateConfigId is supplied", async () => {
    let finalPayload: Record<string, unknown> | null = null;
    const hooks: BacktestTestHooks = {
      matchesForTest: [fakeMatch(1, "p1"), fakeMatch(2, "p2"), fakeMatch(3, "p1")],
      candidateConfigForTest: {
        strategySpec: { family: "minimalist", weights: { surfaceElo: 1.7, serveReturn: 1.4 } },
      },
      onRunUpdated: async (data) => {
        if (data.status === "completed" || data.status === "completed-with-warnings") finalPayload = data;
      },
    };

    await runEvaluationBacktest({ ...STUB_OPTIONS_BASE, candidateConfigId: 42 }, hooks);

    assert.ok(finalPayload, "expected a terminal status write");
    const metrics = (finalPayload as Record<string, unknown>).metrics as Record<string, unknown>;
    assert.equal(metrics.candidateConfigApplied, false, "a requested candidate config that the engine cannot apply must be disclosed as candidateConfigApplied:false, not silently look like a real candidate-specific run");
    assert.equal(
      (finalPayload as Record<string, unknown>).status,
      "completed-with-warnings",
      "a backtest that could not honor its requested candidate config must not report a clean 'completed' status, which downstream consumers would read as a validated run",
    );
  });

  it("leaves candidateConfigApplied null and reports a clean 'completed' status for a plain evaluation-mode backtest with no candidateConfigId", async () => {
    let finalPayload: Record<string, unknown> | null = null;
    const hooks: BacktestTestHooks = {
      matchesForTest: [fakeMatch(1, "p1"), fakeMatch(2, "p2"), fakeMatch(3, "p1")],
      onRunUpdated: async (data) => {
        if (data.status === "completed" || data.status === "completed-with-warnings") finalPayload = data;
      },
    };

    await runEvaluationBacktest({ ...STUB_OPTIONS_BASE, mode: "evaluation" }, hooks);

    assert.ok(finalPayload, "expected a terminal status write");
    const metrics = (finalPayload as Record<string, unknown>).metrics as Record<string, unknown>;
    assert.equal(metrics.candidateConfigApplied, null, "a backtest that never requested a candidate config has nothing to disclose here -- must stay null, not false");
    assert.equal((finalPayload as Record<string, unknown>).status, "completed", "a plain evaluation-mode backtest must not be downgraded to completed-with-warnings by the candidate-config disclosure");
  });
});
