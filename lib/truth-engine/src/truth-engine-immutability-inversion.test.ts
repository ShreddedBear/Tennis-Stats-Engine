import { describe, expect, it } from "vitest";
import { computeHistoryMetric, replayElo, laneMatchesBefore, type HistoryLane, type HistoryEntry } from "./task18c-rank-form-workload";
import { compareMetricRows, type MetricRowForComparison } from "./truth-engine-metric-comparison";
import { runTruthEngineAudit } from "./truth-engine-audit";

// PHASE 14 — the two system-level properties a deterministic audit engine must hold, which
// no existing suite covered end to end:
//
//   IMMUTABILITY (checklist 11). An audit of a past match is a statement about what was
//   knowable BEFORE that match. Adding matches after it, or changing how the players
//   performed after it, must not move the answer by a single digit. If it can, the engine
//   is reading the future -- the failure mode the whole temporal boundary exists to stop,
//   observed at the level of the answer rather than the filter.
//
//   INVERSION (checklist 10). "P1" and "P2" are slots, not players. Feeding the identical
//   match in with the two players exchanged must exchange the entire audit -- selection,
//   verification, contradiction, underdog and stress -- with no residue of slot order.
//   Anything that survives the swap unchanged is the engine preferring a position.

// ---------------------------------------------------------------------------
// IMMUTABILITY
// ---------------------------------------------------------------------------

const AUDIT_DATE = "2026-03-01";

/** [date, tournament, surface, opponent, won(1|0), round, source] */
const entry = (date: string, opponent: string, won: 0 | 1, surface = "hard"): HistoryEntry =>
  [date, "Fixture Open", surface, opponent, won, "R32", "fixture"];

/** History both players genuinely accumulated BEFORE the audited match. */
function priorLane(): HistoryLane {
  return {
    "ana rivera": [
      entry("2025-11-02", "cara diaz", 1),
      entry("2025-12-07", "dana ellis", 1),
      entry("2026-01-11", "cara diaz", 1),
      entry("2026-02-08", "dana ellis", 0),
    ],
    "bo tanaka": [
      entry("2025-11-02", "dana ellis", 0),
      entry("2025-12-07", "cara diaz", 0),
      entry("2026-01-11", "dana ellis", 1),
      entry("2026-02-08", "cara diaz", 0),
    ],
    "cara diaz": [
      entry("2025-11-02", "ana rivera", 0),
      entry("2025-12-07", "bo tanaka", 1),
      entry("2026-01-11", "ana rivera", 0),
      entry("2026-02-08", "bo tanaka", 1),
    ],
    "dana ellis": [
      entry("2025-11-02", "bo tanaka", 1),
      entry("2025-12-07", "ana rivera", 0),
      entry("2026-01-11", "bo tanaka", 0),
      entry("2026-02-08", "ana rivera", 1),
    ],
  };
}

/** The same history, plus a rewritten future: the audited match itself and everything after. */
function laneWithFuture(): HistoryLane {
  const lane = priorLane();
  // The audited match itself, on the audit date.
  lane["ana rivera"].push(entry(AUDIT_DATE, "bo tanaka", 0));
  lane["bo tanaka"].push(entry(AUDIT_DATE, "ana rivera", 1));
  // A dramatic reversal of form AFTER the audited match: the player who was losing now
  // wins everything, and vice versa. A leaking engine would notice.
  for (const [i, date] of ["2026-03-15", "2026-04-02", "2026-05-20", "2026-06-11"].entries()) {
    lane["ana rivera"].push(entry(date, "cara diaz", 0));
    lane["bo tanaka"].push(entry(date, "dana ellis", 1));
    lane["cara diaz"].push(entry(date, "ana rivera", 1));
    lane["dana ellis"].push(entry(date, "bo tanaka", 0));
    void i;
  }
  return lane;
}

const metricArgs = { code: "001" as const, p1: "Ana Rivera", p2: "Bo Tanaka", asOfDate: AUDIT_DATE, family: "ATP_CHALLENGER" as const, surface: "hard" };

describe("historical immutability — a past audit cannot be moved by the future", () => {
  it("the admissible match set is identical with and without the future appended", () => {
    const before = laneMatchesBefore(priorLane(), AUDIT_DATE);
    const after = laneMatchesBefore(laneWithFuture(), AUDIT_DATE);
    expect(after).toEqual(before);
    // And the audited match itself is not in it, even though laneWithFuture contains it.
    expect(after.every((m) => m.date < AUDIT_DATE)).toBe(true);
  });

  it("the Elo replay produces identical ratings after future matches are added", () => {
    const before = replayElo(priorLane(), AUDIT_DATE);
    const after = replayElo(laneWithFuture(), AUDIT_DATE);
    expect([...after.overall.entries()].sort()).toEqual([...before.overall.entries()].sort());
    expect(after.perspectives).toEqual(before.perspectives);
  });

  it("metric 001 returns a byte-identical finding after the future is rewritten", () => {
    const before = computeHistoryMetric({ ...metricArgs, lane: priorLane() });
    const after = computeHistoryMetric({ ...metricArgs, lane: laneWithFuture() });
    expect(before).not.toBeNull();
    // Not "roughly the same" -- the same object, field for field, including the rendered
    // value strings the audit persists and a human later reads.
    expect(after).toEqual(before);
  });

  it("re-running the same audit twice is deterministic", () => {
    const a = computeHistoryMetric({ ...metricArgs, lane: priorLane() });
    const b = computeHistoryMetric({ ...metricArgs, lane: priorLane() });
    expect(a).toEqual(b);
  });

  it("a later audit date DOES move the answer -- the boundary is real, not a no-op filter", () => {
    // The converse check. If the immutability tests above passed simply because the lane
    // argument were ignored, this would also pass; it must not.
    const atMatch = computeHistoryMetric({ ...metricArgs, lane: laneWithFuture() });
    const muchLater = computeHistoryMetric({ ...metricArgs, lane: laneWithFuture(), asOfDate: "2026-07-01" });
    expect(muchLater).not.toEqual(atMatch);
  });
});

// ---------------------------------------------------------------------------
// INVERSION
// ---------------------------------------------------------------------------

/** Rows spanning several independent families, deliberately not unanimous. */
function auditRows(): MetricRowForComparison[] {
  const usable = { p1_treatment: "RECONSTRUCTED" as const, p2_treatment: "RECONSTRUCTED" as const };
  return [
    // SURFACE_STRENGTH -> P1
    { metric_code: "001", p1_value: "overall_elo=1720; surface_elo=1705", p2_value: "overall_elo=1540; surface_elo=1530", ...usable },
    // RECENT_FORM -> P1
    { metric_code: "005", p1_value: "last10_win_pct=80; last10_matches=10", p2_value: "last10_win_pct=40; last10_matches=10", ...usable },
    // COMMON_OPPONENT -> P1
    { metric_code: "007", p1_value: "win_pct=75; ranked_common_opponent_matches=12", p2_value: "win_pct=33; ranked_common_opponent_matches=12", ...usable },
    // LOSS_PROFILE -> P2 (a genuine independent contradiction). LOWER_IS_BETTER, and the
    // 35pp gap must CLEAR the 25pp materiality floor -- an exactly-25 gap reads NEUTRAL,
    // which would make the contradiction assertions below compare two empty arrays.
    { metric_code: "006", p1_value: "bad_loss_rate_pct=40; quality_observed_matches=20", p2_value: "bad_loss_rate_pct=5; quality_observed_matches=20", ...usable },
  ];
}

/** The same rows with every P1/P2 value exchanged -- the identical match, sides swapped. */
function swappedRows(): MetricRowForComparison[] {
  return auditRows().map((row) => ({ ...row, p1_value: row.p2_value, p2_value: row.p1_value, p1_treatment: row.p2_treatment, p2_treatment: row.p1_treatment }));
}

describe("P1/P2 inversion — the full audit swaps, nothing prefers a slot", () => {
  const forward = runTruthEngineAudit(compareMetricRows(auditRows()), "Ana Rivera", "Bo Tanaka");
  const inverted = runTruthEngineAudit(compareMetricRows(swappedRows()), "Bo Tanaka", "Ana Rivera");

  it("the fixture is genuinely contested, so the swap assertions below are not vacuous", () => {
    // Guards against the failure this suite actually hit while being written: a fixture
    // whose intended contradiction fell exactly ON the materiality threshold and read
    // NEUTRAL, leaving the contradiction assertions comparing two empty arrays.
    expect(forward.decision.independent_support_families.length).toBeGreaterThanOrEqual(2);
    expect(forward.decision.independent_contradiction_families.length).toBeGreaterThan(0);
    expect(forward.verification.findings.length).toBeGreaterThan(0);
  });

  it("selects the same PLAYER before and after the swap", () => {
    expect(forward.decision.outcome).toBe("P1");
    expect(forward.decision.selected_player).toBe("Ana Rivera");
    // Ana is now in the P2 slot, so the outcome label flips while the player does not.
    expect(inverted.decision.outcome).toBe("P2");
    expect(inverted.decision.selected_player).toBe("Ana Rivera");
  });

  it("reaches that selection on the same evidence families, in the same strength", () => {
    expect(inverted.decision.independent_support_families).toEqual(forward.decision.independent_support_families);
    expect(inverted.decision.independent_contradiction_families).toEqual(forward.decision.independent_contradiction_families);
    expect(inverted.decision.stability).toBe(forward.decision.stability);
    expect(inverted.decision.conflicted_families).toEqual(forward.decision.conflicted_families);
  });

  it("names the same underdog player, not the same slot", () => {
    expect(forward.underdog.underdog_side).toBe("P2");
    expect(inverted.underdog.underdog_side).toBe("P1");
    expect(inverted.underdog.underdog_player).toBe(forward.underdog.underdog_player);
    expect(inverted.underdog.underdog_player).toBe("Bo Tanaka");
    expect(inverted.underdog.overall_viability).toBe(forward.underdog.overall_viability);
  });

  it("surfaces the same contradiction at the same severity", () => {
    expect(inverted.disagreement.overall_severity).toBe(forward.disagreement.overall_severity);
    expect(inverted.disagreement.contradiction_families.map((f) => f.family).sort()).toEqual(
      forward.disagreement.contradiction_families.map((f) => f.family).sort(),
    );
  });

  it("reaches the same stress verdict", () => {
    expect(inverted.stress.stability).toBe(forward.stress.stability);
  });

  it("reports the same verification outcome, expressed for the same player", () => {
    // SUPPORTS_P1 forward must read SUPPORTS_P2 inverted -- same finding, other slot.
    const flip = (o: string) => (o === "SUPPORTS_P1" ? "SUPPORTS_P2" : o === "SUPPORTS_P2" ? "SUPPORTS_P1" : o);
    expect(inverted.verification.findings.length).toBe(forward.verification.findings.length);
    const forwardByFamily = new Map(forward.verification.findings.map((f) => [f.family, f.outcome]));
    for (const finding of inverted.verification.findings) {
      expect(finding.outcome, `${finding.family} must mirror under swap`).toBe(flip(String(forwardByFamily.get(finding.family))));
    }
  });

  // Added after mutation testing, which found the fixture above never exercises the tie
  // path at all (it carries a decisive 3-1 family lead). This covers the case where the
  // evidence does NOT decide, which is where a slot preference would hide.
  //
  // Honest limitation, established by actually running the mutation: seeding a tie-breaking
  // bias into leaderOf (`if (p1 === p2) return { leader: "P1" }`) does NOT fail this test,
  // and should not be expected to. Under a 2-2 tie, removing any one supporting family
  // reverses the biased leader, so leave-one-family-out classifies it FRAGILE and refuses
  // anyway -- the bias is unobservable at the output. That is defence in depth in the
  // engine, not a hole in the test. What this test does prove is the property that
  // matters: whatever the engine concludes about a tied match, it concludes the same thing
  // about the same PLAYER from either orientation. A slot-order-dependent refusal, or a
  // selection that named Ana one way and Bo the other, fails here.
  it("a tied match refuses from both orientations -- ties are not resolved by slot order", () => {
    const tied: MetricRowForComparison[] = [
      // SURFACE_STRENGTH -> P1
      { metric_code: "001", p1_value: "overall_elo=1720; surface_elo=1705", p2_value: "overall_elo=1540; surface_elo=1530", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED" },
      // RECENT_FORM -> P1
      { metric_code: "005", p1_value: "last10_win_pct=80; last10_matches=10", p2_value: "last10_win_pct=40; last10_matches=10", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED" },
      // COMMON_OPPONENT -> P2
      { metric_code: "007", p1_value: "win_pct=33; ranked_common_opponent_matches=12", p2_value: "win_pct=75; ranked_common_opponent_matches=12", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED" },
      // LOSS_PROFILE -> P2
      { metric_code: "006", p1_value: "bad_loss_rate_pct=40; quality_observed_matches=20", p2_value: "bad_loss_rate_pct=5; quality_observed_matches=20", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED" },
    ];
    const swapped = tied.map((r) => ({ ...r, p1_value: r.p2_value, p2_value: r.p1_value }));

    const a = runTruthEngineAudit(compareMetricRows(tied), "Ana Rivera", "Bo Tanaka");
    const b = runTruthEngineAudit(compareMetricRows(swapped), "Bo Tanaka", "Ana Rivera");

    // The evidence genuinely ties 2-2, so neither orientation may select anyone.
    expect(a.decision.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(b.decision.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.decision.selected_player).toBeNull();
    expect(b.decision.selected_player).toBeNull();
    // The load-bearing assertion: a slot-biased engine would name Ana in one orientation
    // and Bo in the other. Whatever is selected, both orientations must agree on the PLAYER.
    expect(b.decision.selected_player).toBe(a.decision.selected_player);
  });

  it("a refusal is also symmetric: an unselectable match is unselectable from either side", () => {
    // A single supporting family is no longer unselectable (the 60% directional-evidence
    // threshold replaced the two-family gate), so this uses a genuinely unselectable shape:
    // one supporting family against one contradicting family is 50%, below the threshold,
    // from whichever orientation it is read.
    const split: MetricRowForComparison[] = [auditRows()[0], auditRows()[3]];
    const a = runTruthEngineAudit(compareMetricRows(split), "Ana Rivera", "Bo Tanaka");
    const b = runTruthEngineAudit(
      compareMetricRows(split.map((r) => ({ ...r, p1_value: r.p2_value, p2_value: r.p1_value }))),
      "Bo Tanaka",
      "Ana Rivera",
    );
    expect(a.decision.evidence_percent).toBeLessThan(60);
    expect(a.decision.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(b.decision.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(b.decision.selected_player).toBeNull();
  });
});
