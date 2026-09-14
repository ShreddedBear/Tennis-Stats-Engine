import { describe, expect, it } from "vitest";
import { buildDecisionRecord, isResolvedObservation } from "./truth-engine-decision-record";
import { compareMetricRows, type MetricRowForComparison } from "./truth-engine-metric-comparison";
import { runTruthEngineAudit } from "./truth-engine-audit";
import { COMPARISON_SPECS } from "./truth-engine-metric-comparison";
import { ACTIVE_METRIC_CODES } from "./truth-engine-active-metrics";

// The four concepts must stay separate and provably so:
//   evidence_coverage_*      DIAGNOSTIC        -- how much evidence was usable
//   evidence_support_percent SELECTION FEATURE -- how surviving evidence is distributed
//   selected_player          THE PREDICTION
//   actual_winner            THE CALIBRATION TARGET
//
// These tests pin that no value from the first ever becomes the third, and that nothing in
// this module invents a probability or a weight.

const usable = { p1_treatment: "DIRECT" as const, p2_treatment: "DIRECT" as const };
const record = (rows: MetricRowForComparison[], p1 = "Ana", p2 = "Bo", actual?: string | null) =>
  buildDecisionRecord({
    audit: runTruthEngineAudit(compareMetricRows(rows), p1, p2),
    metricRows: rows as never,
    now: new Date("2026-09-04T00:00:00Z"),
    actualWinner: actual,
  });

/** Three independent families favouring P1, one contradicting -> 75%, a real selection. */
function strongP1(): MetricRowForComparison[] {
  return [
    { metric_code: "001", p1_value: "1900", p2_value: "1500", ...usable },
    { metric_code: "005", p1_value: "last10_win_pct=80; last10_matches=10", p2_value: "last10_win_pct=30; last10_matches=10", ...usable },
    { metric_code: "007", p1_value: "win_pct=75; ranked_common_opponent_matches=12", p2_value: "win_pct=30; ranked_common_opponent_matches=12", ...usable },
    { metric_code: "006", p1_value: "bad_loss_rate_pct=40; quality_observed_matches=20", p2_value: "bad_loss_rate_pct=5; quality_observed_matches=20", ...usable },
  ];
}

describe("the record separates diagnostic coverage from the prediction", () => {
  it("captures the prediction, the support share and the coverage as three distinct fields", () => {
    const r = record(strongP1());
    expect(r.selected_player).toBe("Ana");
    expect(r.evidence_support_percent).toBe(75);
    // Coverage is 4 of the active set, nothing like 75 -- the two are not the same number.
    expect(r.evidence_coverage_expected).toBe(ACTIVE_METRIC_CODES.length);
    expect(r.evidence_coverage_usable).toBe(4);
    expect(r.evidence_coverage_percent).not.toBe(r.evidence_support_percent);
  });

  it("C. richer coverage does not by itself produce a stronger decision", () => {
    // Same four decisive families in both, but the second adds four MORE usable metrics
    // that all land inside families already represented. Coverage rises; the support share
    // does not, because support is per-family.
    const lean = strongP1();
    const rich: MetricRowForComparison[] = [
      ...lean,
      { metric_code: "055", p1_value: "elo_change_last10=25", p2_value: "elo_change_last10=-25", ...usable },
      { metric_code: "080", p1_value: "comparable_strength_win_pct=70; quality_observed_matches=20", p2_value: "comparable_strength_win_pct=30; quality_observed_matches=20", ...usable },
    ];
    const a = record(lean), b = record(rich);
    expect(b.evidence_coverage_usable).toBeGreaterThan(a.evidence_coverage_usable);
    expect(b.selected_player).toBe(a.selected_player);
    // More usable metrics must not be readable as "more likely to win".
    expect(b.evidence_support_percent).toBeGreaterThanOrEqual(0);
    expect(b.evidence_coverage_percent).not.toBe(b.evidence_support_percent);
  });

  it("B. a thin match can still produce a valid decision when the evidence passes the rules", () => {
    const thin = strongP1();
    const r = record(thin);
    expect(r.evidence_coverage_usable).toBeLessThan(r.evidence_coverage_expected / 2);
    expect(r.outcome).toBe("P1");
    expect(r.selected_player).toBe("Ana");
  });

  it("H. the support percentage is never stored as, or renamed to, a win probability", () => {
    const r = record(strongP1());
    const keys = Object.keys(r);
    // No field in the record claims to be a probability or a win rate.
    expect(keys.filter((k) => /probab|win_rate|win_pct|likelihood/i.test(k))).toEqual([]);
    // And the support share carries a name that says what it is.
    expect(keys).toContain("evidence_support_percent");
  });
});

describe("the calibration target is the actual result, never coverage", () => {
  it("G. an unresolved record is open, not a loss", () => {
    const r = record(strongP1());
    expect(r.actual_winner).toBeNull();
    expect(r.decision_correct).toBeNull();
    expect(isResolvedObservation(r)).toBe(false);
  });

  it("grades against the real winner once it is known", () => {
    const won = record(strongP1(), "Ana", "Bo", "Ana");
    const lost = record(strongP1(), "Ana", "Bo", "Bo");
    expect(won.decision_correct).toBe(true);
    expect(lost.decision_correct).toBe(false);
    expect(isResolvedObservation(won)).toBe(true);
  });

  it("matches a surname-only result to the full selected name", () => {
    expect(record(strongP1(), "Gonzalo Bueno", "Joao Reis", "Bueno").decision_correct).toBe(true);
    expect(record(strongP1(), "Gonzalo Bueno", "Joao Reis", "Reis").decision_correct).toBe(false);
  });

  it("D. two records with identical decision shape but different coverage stay independently gradable", () => {
    // Same selection and same support share; different coverage; opposite real outcomes.
    // Nothing in the record lets coverage override or imply the outcome.
    const a = record(strongP1(), "Ana", "Bo", "Ana");
    const b = record([...strongP1(), { metric_code: "055", p1_value: "elo_change_last10=25", p2_value: "elo_change_last10=-25", ...usable }], "Ana", "Bo", "Bo");
    expect(b.evidence_coverage_usable).toBeGreaterThan(a.evidence_coverage_usable);
    expect(a.decision_correct).toBe(true);
    expect(b.decision_correct).toBe(false);
  });

  it("a refusal records no prediction and can never be graded", () => {
    const split: MetricRowForComparison[] = [
      { metric_code: "001", p1_value: "1900", p2_value: "1500", ...usable },
      { metric_code: "005", p1_value: "last10_win_pct=20; last10_matches=10", p2_value: "last10_win_pct=90; last10_matches=10", ...usable },
    ];
    const r = record(split, "Ana", "Bo", "Ana");
    expect(r.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.selected_player).toBeNull();
    expect(r.decision_correct).toBeNull();
    expect(isResolvedObservation(r)).toBe(false);
  });
});

describe("the record preserves the decision structure calibration will need", () => {
  it("E. seven correlated metrics are preserved as ONE family, not seven votes", () => {
    const rows: MetricRowForComparison[] = ["002", "003", "009", "018", "032", "034", "053"].map((code) => {
      const [strong, weak] = [
        { "002": 90, "003": 90, "009": 95, "018": 95, "032": 95, "034": 3, "053": 95 }[code]!,
        { "002": 10, "003": 10, "009": 5, "018": 5, "032": 5, "034": 0.3, "053": 5 }[code]!,
      ];
      const spec = COMPARISON_SPECS[code];
      const denom = `"${spec.sampleField![0]}":${(spec.minSample ?? 0) + 20}`;
      return { metric_code: code, p1_value: `output={${denom},"${spec.field}":${strong}}`, p2_value: `output={${denom},"${spec.field}":${weak}}`, p1_treatment: "PARTIAL" as const, p2_treatment: "PARTIAL" as const };
    });
    const r = record(rows);
    expect(r.supporting_families).toEqual(["POINT_BY_POINT"]);
    expect(r.directional_families).toBe(1);
    // The seven metrics are still individually visible for audit, inside the one family.
    const pbp = r.families.find((f) => f.family === "POINT_BY_POINT")!;
    expect(pbp.supporting_metrics).toHaveLength(7);
    // But six are explicitly marked as not recounted, so calibration cannot read seven votes.
    expect(r.duplicated_support_metrics).toHaveLength(6);
  });

  it("I. stress, disagreement, underdog and verification survive as features, unscored", () => {
    const r = record(strongP1());
    expect(typeof r.stress_stability).toBe("string");
    expect(typeof r.disagreement_severity).toBe("string");
    expect(typeof r.underdog_viability).toBe("string");
    expect(typeof r.verification_findings).toBe("number");
    // They are recorded as states/counts -- no weight, no points, no contribution to a score.
    expect(Object.keys(r).filter((k) => /score|weight|points/i.test(k))).toEqual([]);
  });

  it("F. inversion stays symmetric: the same player is recorded from either orientation", () => {
    const forward = record(strongP1(), "Ana", "Bo");
    const swapped = record(
      strongP1().map((row) => ({ ...row, p1_value: row.p2_value, p2_value: row.p1_value })),
      "Bo",
      "Ana",
    );
    expect(swapped.selected_player).toBe(forward.selected_player);
    expect(swapped.evidence_support_percent).toBe(forward.evidence_support_percent);
    expect(swapped.supporting_families).toEqual(forward.supporting_families);
  });

  it("J. coverage is measured against the active registry only, so no inactive metric leaks in", () => {
    const withInactive: MetricRowForComparison[] = [
      ...strongP1(),
      { metric_code: "004", p1_value: "dominance_ratio=1.4", p2_value: "dominance_ratio=0.8", ...usable },
      { metric_code: "062", p1_value: "seeded_rate_pct=40", p2_value: "seeded_rate_pct=10", ...usable },
    ];
    const r = record(withInactive);
    expect(r.evidence_coverage_expected).toBe(ACTIVE_METRIC_CODES.length);
    // The two inactive rows are present in the input but cannot raise coverage.
    expect(r.evidence_coverage_usable).toBe(4);
    for (const family of r.families) {
      expect(family.supporting_metrics).not.toContain("004");
      expect(family.supporting_metrics).not.toContain("062");
    }
  });

  it("A. widening the active registry changes coverage but not a recorded historical decision", () => {
    // The record is a snapshot. Re-reading it later cannot retroactively move its numbers,
    // which is what stops a registry change from rewriting historical win rates.
    const r = record(strongP1(), "Ana", "Bo", "Ana");
    const frozen = JSON.parse(JSON.stringify(r));
    expect(r.evidence_coverage_expected).toBe(ACTIVE_METRIC_CODES.length);
    expect(frozen.evidence_support_percent).toBe(r.evidence_support_percent);
    expect(frozen.decision_correct).toBe(true);
    expect(frozen.schema_version).toBe(1);
  });
});

describe("dynamic per-match denominator and the full per-metric audit trail", () => {
  it("a metric with a real, evidenced absence on both sides is excused from evidence_coverage_eligible", () => {
    const rows: MetricRowForComparison[] = [
      ...strongP1(),
      // 009 (Pressure point win %): no PBP source for either player in this match.
      { metric_code: "009", p1_value: null, p2_value: null, p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE", p1_unavailable_reason: "NO_SOURCE_FOUND", p2_unavailable_reason: "HISTORICAL_DATA_UNAVAILABLE" } as never,
    ];
    const r = record(rows);
    expect(r.evidence_coverage_expected).toBe(ACTIVE_METRIC_CODES.length);
    // 009 is excused; every other un-executed active code still counts as a miss.
    expect(r.evidence_coverage_eligible).toBe(ACTIVE_METRIC_CODES.length - 1);
    expect(r.evidence_coverage_eligible_percent).not.toBe(r.evidence_coverage_percent);

    const entry009 = r.metric_activation.find((m) => m.code === "009")!;
    expect(entry009).toMatchObject({ p1_status: "SOURCE_EMPTY", p2_status: "GENUINELY_UNAVAILABLE", activated: false, counts_toward_denominator: false });
  });

  it("metric_activation names every one of the 25 active codes, not just the ones with rows", () => {
    const r = record(strongP1());
    expect(r.metric_activation).toHaveLength(ACTIVE_METRIC_CODES.length);
    expect(r.metric_activation.map((m) => m.code).sort()).toEqual([...ACTIVE_METRIC_CODES].sort());
    const notExecuted = r.metric_activation.find((m) => m.code === "080")!;
    expect(notExecuted).toMatchObject({ p1_status: "NOT_ATTEMPTED", p2_status: "NOT_ATTEMPTED", counts_toward_denominator: true });
  });

  it("a real pipeline defect on one side (e.g. identity resolution) is never excused, even when the other side has none", () => {
    const rows: MetricRowForComparison[] = [
      ...strongP1(),
      { metric_code: "055", p1_value: null, p2_value: null, p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE", p1_unavailable_reason: "NO_SOURCE_FOUND", p2_unavailable_reason: "PLAYER_NOT_FOUND" } as never,
    ];
    const r = record(rows);
    const entry055 = r.metric_activation.find((m) => m.code === "055")!;
    expect(entry055.counts_toward_denominator).toBe(true);
    expect(entry055.p2_status).toBe("IDENTITY_MISMATCH");
  });
});
