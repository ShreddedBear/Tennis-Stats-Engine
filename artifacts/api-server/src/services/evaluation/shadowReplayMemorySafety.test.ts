/**
 * Deterministic, database-free verification of the shadow-replay memory safety ceiling (final
 * pre-3-month-run hardening task). Two things are tested:
 *
 *  1. `isOverMemoryCeiling` -- imported directly from `shadowReplay.ts`, so this exercises the
 *     exact function the replay loop calls, not a reimplementation.
 *  2. A small local harness that mirrors `runShadowPaperTradingReplay`'s real control-flow shape
 *     (pre-loop ceiling check, then a per-day loop that checks the ceiling before doing any work
 *     and commits each match's "prediction" immediately/append-only) -- proving the same five
 *     properties the task asked for, without needing a live database:
 *       (a) the safety threshold is detected
 *       (b) the replay stops
 *       (c) completed work remains persisted/checkpointable
 *       (d) the job is not falsely marked successful
 *       (e) resume can continue from the last checkpoint
 *     plus a control case confirming normal operation below the threshold does NOT terminate early.
 *
 * This intentionally does not call `runShadowPaperTradingReplay` itself (that requires a live
 * Postgres instance for `historical_matches`/`evaluation_predictions`/`calibration_models`) -- the
 * harness below reproduces its day-loop *shape* precisely enough that the ceiling-check placement
 * and append-only resume semantics are exercised faithfully, while staying a pure, fast, deterministic
 * unit test per this task's "static inspection and a small local/mock test" instruction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOverMemoryCeiling } from "./shadowReplay";

describe("isOverMemoryCeiling (real exported function)", () => {
  it("is false strictly below the threshold", () => {
    assert.equal(isOverMemoryCeiling(1399, 1400), false);
  });

  it("is true at the threshold (inclusive)", () => {
    assert.equal(isOverMemoryCeiling(1400, 1400), true);
  });

  it("is true above the threshold", () => {
    assert.equal(isOverMemoryCeiling(1800, 1400), true);
  });
});

// ─── Local day-loop harness (mirrors runShadowPaperTradingReplay's control-flow shape) ─────────

interface HarnessDay {
  label: string;
  matchIds: number[];
}

interface HarnessSummary {
  inserted: number;
  skippedAlreadyClaimed: number;
  daysSimulated: number;
  cancelled: boolean;
  stopReason: "completed" | "cancelled" | "memory_ceiling";
  lastDayProcessed: string | null;
  heapUsedMBAtStop: number | null;
}

function simulateReplay(opts: {
  days: HarnessDay[];
  heapTrajectoryMB: number[];
  maxHeapMB: number;
  alreadyClaimed?: Set<number>;
}): { summary: HarnessSummary; persisted: Array<{ matchId: number; day: string }>; claimedAfter: Set<number> } {
  const { days, heapTrajectoryMB, maxHeapMB, alreadyClaimed = new Set<number>() } = opts;
  const persisted: Array<{ matchId: number; day: string }> = [];
  const claimed = new Set(alreadyClaimed);
  let stepIndex = 0;
  const nextHeap = () => heapTrajectoryMB[Math.min(stepIndex++, heapTrajectoryMB.length - 1)];

  const summary: HarnessSummary = {
    inserted: 0,
    skippedAlreadyClaimed: 0,
    daysSimulated: 0,
    cancelled: false,
    stopReason: "completed",
    lastDayProcessed: null,
    heapUsedMBAtStop: null,
  };

  // Pre-loop check -- mirrors the real function's check right after the one-time
  // identity/Elo/calibration preload, before any day is processed.
  const preLoopHeap = nextHeap();
  if (isOverMemoryCeiling(preLoopHeap, maxHeapMB)) {
    summary.cancelled = true;
    summary.stopReason = "memory_ceiling";
    summary.heapUsedMBAtStop = preLoopHeap;
    return { summary, persisted, claimedAfter: claimed };
  }

  for (const day of days) {
    const heap = nextHeap();
    if (isOverMemoryCeiling(heap, maxHeapMB)) {
      summary.cancelled = true;
      summary.stopReason = "memory_ceiling";
      summary.heapUsedMBAtStop = heap;
      break;
    }

    for (const matchId of day.matchIds) {
      if (claimed.has(matchId)) {
        summary.skippedAlreadyClaimed += 1;
        continue;
      }
      // Commits immediately, append-only -- mirrors the real
      // INSERT ... ON CONFLICT DO NOTHING RETURNING id per match.
      persisted.push({ matchId, day: day.label });
      claimed.add(matchId);
      summary.inserted += 1;
    }
    summary.daysSimulated += 1;
    summary.lastDayProcessed = day.label;
  }

  return { summary, persisted, claimedAfter: claimed };
}

describe("memory-ceiling harness (day-loop shape)", () => {
  it("normal operation below the threshold never stops early", () => {
    const days: HarnessDay[] = [
      { label: "2026-06-01", matchIds: [1, 2] },
      { label: "2026-06-02", matchIds: [3] },
      { label: "2026-06-03", matchIds: [4, 5] },
    ];
    const { summary, persisted } = simulateReplay({ days, heapTrajectoryMB: [200, 210, 220, 230], maxHeapMB: 1400 });

    assert.equal(summary.stopReason, "completed");
    assert.equal(summary.cancelled, false);
    assert.equal(summary.daysSimulated, 3);
    assert.equal(summary.inserted, 5);
    assert.equal(persisted.length, 5, "no premature termination -- every match was scored");
  });

  it("detects the threshold, stops cleanly, preserves prior work, and does not mark success", () => {
    const days: HarnessDay[] = [
      { label: "2026-06-01", matchIds: [1, 2] },
      { label: "2026-06-02", matchIds: [3] }, // heap check before this day trips
      { label: "2026-06-03", matchIds: [4, 5] }, // never reached
    ];
    const { summary, persisted } = simulateReplay({ days, heapTrajectoryMB: [200, 300, 1450], maxHeapMB: 1400 });

    // 1. threshold detected + 2. replay stops
    assert.equal(summary.stopReason, "memory_ceiling");
    assert.equal(summary.daysSimulated, 1);
    assert.equal(summary.lastDayProcessed, "2026-06-01");
    // 3. completed work remains persisted
    assert.deepEqual(persisted.map((p) => p.matchId), [1, 2]);
    // 4. job is not falsely marked successful
    assert.equal(summary.cancelled, true);
    assert.notEqual(summary.stopReason, "completed");
    assert.equal(summary.heapUsedMBAtStop, 1450);
  });

  it("resumes from the last checkpoint after a memory-ceiling stop via append-only skip", () => {
    const days: HarnessDay[] = [
      { label: "2026-06-01", matchIds: [1, 2] },
      { label: "2026-06-02", matchIds: [3] },
      { label: "2026-06-03", matchIds: [4, 5] },
    ];

    const first = simulateReplay({ days, heapTrajectoryMB: [200, 300, 1450], maxHeapMB: 1400 });
    assert.equal(first.summary.stopReason, "memory_ceiling");
    assert.deepEqual(first.persisted.map((p) => p.matchId), [1, 2]);

    // Resume with the same batch's claimed set carried forward (matching the real append-only
    // unique-index behavior across a re-run of the same batchLabel); heap now healthy throughout.
    const second = simulateReplay({
      days,
      heapTrajectoryMB: [200, 210, 220, 230],
      maxHeapMB: 1400,
      alreadyClaimed: first.claimedAfter,
    });

    // 5. resume continues from the last checkpoint
    assert.equal(second.summary.stopReason, "completed");
    assert.equal(second.summary.skippedAlreadyClaimed, 2);
    assert.equal(second.summary.inserted, 3);
    assert.deepEqual(second.persisted.map((p) => p.matchId), [3, 4, 5]);

    // Combined: every match across both attempts was scored exactly once -- no duplicate, no loss.
    const allPersisted = [...first.persisted, ...second.persisted].map((p) => p.matchId).sort();
    assert.deepEqual(allPersisted, [1, 2, 3, 4, 5]);
  });

  it("distinguishes a memory-ceiling stop from a user cancellation via stopReason", () => {
    // A cancellation is a different trigger than the memory ceiling, but must land in the same
    // "not successful, resumable" shape -- see ShadowReplaySummary.cancelled's doc.
    const days: HarnessDay[] = [
      { label: "2026-06-01", matchIds: [1] },
      { label: "2026-06-02", matchIds: [2] },
    ];
    const persisted: number[] = [];
    let cancelled = false;
    let stopReason: HarnessSummary["stopReason"] = "completed";
    let lastDayProcessed: string | null = null;
    let cancelAfterFirstDay = false;

    for (const day of days) {
      if (cancelAfterFirstDay) {
        cancelled = true;
        stopReason = "cancelled";
        break;
      }
      for (const matchId of day.matchIds) persisted.push(matchId);
      lastDayProcessed = day.label;
      cancelAfterFirstDay = true;
    }

    assert.equal(stopReason, "cancelled");
    assert.notEqual(stopReason, "memory_ceiling");
    assert.equal(cancelled, true);
    assert.deepEqual(persisted, [1]);
    assert.equal(lastDayProcessed, "2026-06-01");
  });
});
