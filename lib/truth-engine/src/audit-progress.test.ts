import { describe, expect, it } from "vitest";
import { activeRunExecutionPercent, computeBatchExecutionPercent, computeExecutionPercent, type ActiveRunRow, type ScopedStageRow } from "./audit-progress";
import { STAGES } from "./audit-pipeline";
import { INVALIDATED_RUN_STATUS, resolveActiveRun } from "./audit-stages";

describe("computeExecutionPercent", () => {
  it("stays in sync with the real pipeline's stage count", () => {
    // audit-progress.ts duplicates this count locally to avoid pulling
    // audit-pipeline.ts's dependency graph into the client bundle. If the
    // pipeline ever gains/loses a stage, this test must fail until the
    // duplicated constant is updated to match.
    expect(STAGES.length).toBe(16);
  });

  it("does not report near-100% when only the first two of sixteen stages have started", () => {
    // Reproduces the reported bug: MATCH IDENTITY VERIFICATION (0/2, but
    // COMPLETE -- identity search was unavailable, a settled terminal
    // outcome) and MATCH CONTEXT RESOLUTION (5/6, COMPLETE) are done, and
    // DEFINITION INSTANTIATION has just started (0/0, RUNNING, its own item
    // count not yet known). The other 10 stages haven't started at all.
    const rows = [
      { status: "COMPLETE", done_count: 0, total_count: 2 },
      { status: "COMPLETE", done_count: 5, total_count: 6 },
      { status: "RUNNING", done_count: 0, total_count: 0 },
    ];
    const pct = computeExecutionPercent(rows);
    expect(pct).toBeLessThan(20);
    expect(pct).toBe(Math.round((2 / 16) * 100));
  });

  it("gives partial credit within a stage that has a known total", () => {
    const rows = [
      { status: "COMPLETE", done_count: 2, total_count: 2 },
      { status: "RUNNING", done_count: 40, total_count: 80 },
    ];
    const pct = computeExecutionPercent(rows);
    expect(pct).toBe(Math.round((1.5 / 16) * 100));
  });

  it("reaches 100% only when every stage is COMPLETE", () => {
    const rows = Array.from({ length: 16 }, () => ({ status: "COMPLETE", done_count: 1, total_count: 1 }));
    expect(computeExecutionPercent(rows)).toBe(100);
  });

  it("caps a BLOCKED run at 99% even if stages otherwise look complete", () => {
    const rows = Array.from({ length: 16 }, () => ({ status: "COMPLETE", done_count: 1, total_count: 1 }));
    expect(computeExecutionPercent(rows, "BLOCKED")).toBe(99);
  });

  it("returns 0 for no rows at all", () => {
    expect(computeExecutionPercent([])).toBe(0);
  });

  it("is never 0% when the current run has persisted completed stages: 4 of 16 stages complete is 25%, not 0%", () => {
    const rows = Array.from({ length: 4 }, () => ({ status: "COMPLETE", done_count: 1, total_count: 1 }));
    expect(computeExecutionPercent(rows)).toBe(25);
  });

  it("does not count a stage twice because it has multiple retry/attempt records for the same stage name", () => {
    // Same stage, three "records" (as if a caller accidentally handed in
    // retry history instead of the one canonical row) -- must score as ONE
    // COMPLETE stage, not three.
    const rows = [
      { stage: "P1 METRIC EXECUTION", status: "RUNNING", done_count: 21, total_count: 81 },
      { stage: "P1 METRIC EXECUTION", status: "COMPLETE", done_count: 81, total_count: 81 },
      { stage: "P1 METRIC EXECUTION", status: "COMPLETE", done_count: 81, total_count: 81 },
    ];
    expect(computeExecutionPercent(rows)).toBe(Math.round((1 / 16) * 100));
  });

  it("P1 with 3 attempts that ultimately completes counts once, alongside 3 other genuinely complete stages", () => {
    const rows = [
      { stage: "MATCH INGESTION / PDF EXTRACTION", status: "COMPLETE", done_count: 1, total_count: 1 },
      { stage: "MATCH IDENTITY VERIFICATION", status: "COMPLETE", done_count: 2, total_count: 2 },
      { stage: "MATCH CONTEXT RESOLUTION", status: "COMPLETE", done_count: 6, total_count: 6 },
      { stage: "P1 METRIC EXECUTION", status: "RUNNING", done_count: 21, total_count: 81, attempts: 1 },
      { stage: "P1 METRIC EXECUTION", status: "COMPLETE", done_count: 81, total_count: 81, attempts: 3 },
    ];
    expect(computeExecutionPercent(rows)).toBe(25);
  });
});

describe("computeBatchExecutionPercent", () => {
  it("weights every run's pipeline equally, not just its already-known stages", () => {
    const stuck = [
      { status: "COMPLETE", done_count: 0, total_count: 2 },
      { status: "COMPLETE", done_count: 5, total_count: 6 },
      { status: "RUNNING", done_count: 0, total_count: 0 },
    ];
    const byRun = new Map([
      ["run-a", stuck],
      ["run-b", stuck],
    ]);
    const pct = computeBatchExecutionPercent(byRun);
    expect(pct).toBeLessThan(20);
  });

  it("returns 0 for an empty batch", () => {
    expect(computeBatchExecutionPercent(new Map())).toBe(0);
  });

  it("does not double-count a stage that appears more than once for the same run", () => {
    const byRun = new Map([
      [
        "run-a",
        [
          { stage: "P1 METRIC EXECUTION", status: "RUNNING", done_count: 21, total_count: 81 },
          { stage: "P1 METRIC EXECUTION", status: "COMPLETE", done_count: 81, total_count: 81 },
        ],
      ],
    ]);
    expect(computeBatchExecutionPercent(byRun)).toBe(Math.round((1 / 16) * 100));
  });
});

// activeRunExecutionPercent is THE canonical Active Slate execution
// calculation: it takes an already-resolved (via resolveActiveRun) run plus
// this match's full stage-row history, scopes to that one run's rows itself,
// and canonicalizes through the exact same audit-stages.ts logic Execution
// Diagnostics on the match workspace renders from. These tests reproduce the
// reported bug end to end (RUN 7 with 5 stages complete + P2 running showing
// 0% on Active Slate) and the scenarios that must never regress again.
describe("activeRunExecutionPercent (the Active Slate execution calculation)", () => {
  const RUN_ID = "run-current";
  const MATCH_ID = "match-1";
  const activeRun: ActiveRunRow = { id: RUN_ID, match_id: MATCH_ID, status: "RUNNING", run_number: 7 };

  function stageRow(stage: string, status: string, done: number, total: number, runId = RUN_ID): ScopedStageRow {
    return { audit_run_id: runId, stage, status, done_count: done, total_count: total };
  }

  it("1. a fresh active run with no stage rows yet reports 0%", () => {
    expect(activeRunExecutionPercent(activeRun, [])).toBe(0);
  });

  it("2. one or more completed stages report a non-zero percentage", () => {
    const rows = [stageRow(STAGES[0], "COMPLETE", 1, 1)];
    expect(activeRunExecutionPercent(activeRun, rows)).toBeGreaterThan(0);
  });

  it("3. exactly reproduces the reported RUN 7 scenario: 5 stages complete + P2 actively running MUST be non-zero", () => {
    // The exact example from the bug report: stages 1-5 COMPLETE (including
    // P1 metric execution at 81/81), P2 metric execution RUNNING at 51/81,
    // stages 7-16 PENDING.
    const rows = [
      stageRow(STAGES[0], "COMPLETE", 1, 1),
      stageRow(STAGES[1], "COMPLETE", 2, 2),
      stageRow(STAGES[2], "COMPLETE", 6, 6),
      stageRow(STAGES[3], "COMPLETE", 1, 1),
      stageRow(STAGES[4], "COMPLETE", 81, 81),
      stageRow(STAGES[5], "RUNNING", 51, 81),
    ];
    const pct = activeRunExecutionPercent(activeRun, rows);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBe(Math.round(((5 + 51 / 81) / 16) * 100));
  });

  it("4. a partially completed current stage increases progress as done_count grows", () => {
    const early = [stageRow(STAGES[5], "RUNNING", 10, 81)];
    const later = [stageRow(STAGES[5], "RUNNING", 51, 81)];
    expect(activeRunExecutionPercent(activeRun, later)).toBeGreaterThan(activeRunExecutionPercent(activeRun, early));
  });

  it("5. when all 16 canonical stages are COMPLETE, execution is 100%", () => {
    const rows = STAGES.map((stage) => stageRow(stage, "COMPLETE", 1, 1));
    expect(activeRunExecutionPercent(activeRun, rows)).toBe(100);
  });

  it("6. an invalidated/cleared run resolves to null and reports 0%, even with fully-complete stage history", () => {
    const invalidatedRun = { id: RUN_ID, match_id: MATCH_ID, status: INVALIDATED_RUN_STATUS, run_number: 6 };
    const resolved = resolveActiveRun([invalidatedRun]);
    expect(resolved).toBeNull();
    const rows = STAGES.map((stage) => stageRow(stage, "COMPLETE", 1, 1));
    expect(activeRunExecutionPercent(resolved, rows)).toBe(0);
  });

  it("7. multiple historical runs' rows cannot affect the current run's execution percentage", () => {
    // An old, fully-COMPLETE run for the same match sits alongside the
    // current run's rows in the same stage-row history (exactly what a
    // global, unscoped fetch would hand this function). The current run has
    // only just started (1 of 16 stages complete) and must score
    // accordingly -- not 100% from the old run's rows leaking in.
    const oldRunRows = STAGES.map((stage) => stageRow(stage, "COMPLETE", 1, 1, "run-old-invalidated"));
    const currentRunRows = [stageRow(STAGES[0], "COMPLETE", 1, 1)];
    const pct = activeRunExecutionPercent(activeRun, [...oldRunRows, ...currentRunRows]);
    expect(pct).toBe(Math.round((1 / 16) * 100));
    expect(pct).toBeLessThan(100);
  });

  it("8. duplicate rows for the same canonical stage on the current run cannot inflate progress", () => {
    // Retry/attempt history for the same stage -- must still count as ONE
    // COMPLETE stage among 16, not multiples.
    const rows = [
      stageRow(STAGES[4], "RUNNING", 20, 81),
      stageRow(STAGES[4], "COMPLETE", 81, 81),
      stageRow(STAGES[4], "COMPLETE", 81, 81),
    ];
    expect(activeRunExecutionPercent(activeRun, rows)).toBe(Math.round((1 / 16) * 100));
  });

  it("returns 0% when there is no active run at all (null)", () => {
    expect(activeRunExecutionPercent(null, [])).toBe(0);
  });

  it("moves continuously from 0% toward 100% as more of the 16 stages complete", () => {
    let previous = -1;
    for (let count = 0; count <= STAGES.length; count++) {
      const rows = STAGES.slice(0, count).map((stage) => stageRow(stage, "COMPLETE", 1, 1));
      const pct = activeRunExecutionPercent(activeRun, rows);
      expect(pct).toBeGreaterThanOrEqual(previous);
      previous = pct;
    }
    expect(previous).toBe(100);
  });
});
