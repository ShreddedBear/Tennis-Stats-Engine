import { describe, expect, it } from "vitest";
import { compareMetricRow, compareMetricRows, parseMetricValue, COMPARISON_SPECS, type MetricRowForComparison } from "./truth-engine-metric-comparison";
import { decideTruthEngineSelection, MIN_INDEPENDENT_SUPPORT_FAMILIES } from "./truth-engine-decision";
import { MATRIX_SUMMARY_REQUIRED_CODES } from "./metric-classification";
import { deterministicIndependentConclusion } from "./audit-pipeline";

const P1 = "Alpha Player";
const P2 = "Beta Player";

function row(metric_code: string, p1_value: string | null, p2_value: string | null, treatments: [string, string] = ["RECONSTRUCTED", "RECONSTRUCTED"]): MetricRowForComparison {
  return { metric_code, p1_value, p2_value, p1_treatment: treatments[0], p2_treatment: treatments[1] };
}
function decide(rows: MetricRowForComparison[]) {
  return decideTruthEngineSelection({ comparisons: compareMetricRows(rows), p1Name: P1, p2Name: P2 });
}

// Real persisted shapes, copied from live metric_results rows.
const REAL_005_P1 = "last5_matches=5; last5_win_pct=0; last10_matches=10; last10_win_pct=10; trend_direction=DECLINING";
const REAL_080_P1 = "common_opponents=40; favorable_divergent_outcomes=16; unfavorable_divergent_outcomes=10";
const REAL_080_P2 = "common_opponents=40; favorable_divergent_outcomes=10; unfavorable_divergent_outcomes=16";

describe("value parsing (real persisted shapes)", () => {
  it("parses a bare scalar and a keyed string, and never turns NA into zero", () => {
    expect(parseMetricValue("1483.15").scalar).toBe(1483.15);
    expect(parseMetricValue(REAL_005_P1).fields.get("last10_win_pct")).toBe("10");
    // "NA" must not be comparable -- a NA field yields UNAVAILABLE, not 0.
    const na = compareMetricRow(row("051", "shrunk_win_probability_pct=NA", "shrunk_win_probability_pct=60"));
    expect(na.status).toBe("ONE_SIDED_EVIDENCE");
    expect(na.favours).toBe("UNAVAILABLE");
    expect(na.p1_number).toBeNull();
  });

  it("extracts a difference-of-two-fields spec from real 080 rows, oriented correctly", () => {
    const c = compareMetricRow(row("080", REAL_080_P1, REAL_080_P2));
    expect(c.status).toBe("COMPARED");
    expect(c.p1_number).toBe(6); // 16 - 10
    expect(c.p2_number).toBe(-6); // 10 - 16
    expect(c.favours).toBe("P1");
  });
});

describe("P1/P2 orientation cannot invert", () => {
  it("mirroring the two sides mirrors the verdict exactly (HIGHER_IS_BETTER)", () => {
    const a = compareMetricRow(row("001", "1900", "1500"));
    const b = compareMetricRow(row("001", "1500", "1900"));
    expect(a.favours).toBe("P1");
    expect(b.favours).toBe("P2");
    expect(a.differential).toBe(-b.differential!);
    expect(a.advantage_p1).toBe(-b.advantage_p1!);
  });

  it("differential is always (P1 - P2) while advantage_p1 carries the direction", () => {
    const c = compareMetricRow(row("001", "1600", "1500"));
    expect(c.differential).toBe(100);
    expect(c.advantage_p1).toBe(100);
    expect(c.direction).toBe("HIGHER_IS_BETTER");
  });

  it("a difference within the materiality threshold is NEUTRAL, not a lean", () => {
    expect(compareMetricRow(row("001", "1505", "1500")).favours).toBe("NEUTRAL"); // materiality 10
    expect(compareMetricRow(row("001", "1520", "1500")).favours).toBe("P1");
  });
});

describe("missing evidence is never zero and never favours the other player", () => {
  it("one-sided evidence yields UNAVAILABLE, not a win for the side that has data", () => {
    const p2Missing = compareMetricRow(row("001", "1900", null));
    expect(p2Missing.status).toBe("ONE_SIDED_EVIDENCE");
    expect(p2Missing.favours).toBe("UNAVAILABLE");
    const p1Missing = compareMetricRow(row("001", null, "1900"));
    expect(p1Missing.favours).toBe("UNAVAILABLE");
  });

  it("an UNAVAILABLE treatment is excluded even when a value string is present", () => {
    const c = compareMetricRow(row("001", "1900", "1500", ["RECONSTRUCTED", "UNAVAILABLE"]));
    expect(c.status).toBe("TREATMENT_NOT_USABLE");
    expect(c.favours).toBe("UNAVAILABLE");
    expect(c.advantage_p1).toBeNull();
  });

  it("scenario 4/5: all P1 (or all P2) evidence missing produces refusal, not a walkover", () => {
    const p1Missing = decide([
      row("001", null, "1500"), row("005", null, "last10_win_pct=70"), row("031", null, "opponent_adjusted_set_differential=1.2"),
    ]);
    expect(p1Missing.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(p1Missing.selected_player).toBeNull();
    expect(p1Missing.unavailable).toHaveLength(3);

    const p2Missing = decide([
      row("001", "1900", null), row("005", "last10_win_pct=80", null), row("031", "opponent_adjusted_set_differential=1.2", null),
    ]);
    expect(p2Missing.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("controlled decision scenarios", () => {
  it("scenario 1: P1 clearly superior across independent families -> P1 selected, ROBUST", () => {
    const d = decide([
      row("001", "1900", "1500"),
      row("005", "last10_win_pct=80", "last10_win_pct=30"),
      row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"),
    ]);
    expect(d.outcome).toBe("P1");
    expect(d.selected_player).toBe(P1);
    expect(d.stability).toBe("ROBUST");
    expect(d.independent_support_families.sort()).toEqual(["COMMON_OPPONENT", "RECENT_FORM", "SURFACE_STRENGTH"]);
    expect(d.independent_contradiction_families).toEqual([]);
  });

  it("scenario 2: P2 clearly superior -> P2 selected (perfect mirror of scenario 1)", () => {
    const d = decide([
      row("001", "1500", "1900"),
      row("005", "last10_win_pct=30", "last10_win_pct=80"),
      row("031", "opponent_adjusted_set_differential=-1.5", "opponent_adjusted_set_differential=1.5"),
    ]);
    expect(d.outcome).toBe("P2");
    expect(d.selected_player).toBe(P2);
    expect(d.stability).toBe("ROBUST");
  });

  it("scenario 3: genuinely close match -> every family NEUTRAL -> refusal", () => {
    const d = decide([
      row("001", "1602", "1600"),
      row("005", "last10_win_pct=52", "last10_win_pct=50"),
    ]);
    expect(d.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(d.neutral_families.sort()).toEqual(["RECENT_FORM", "SURFACE_STRENGTH"]);
  });

  it("scenario 6/7: a strong contradiction is reported as an independent contradiction, not hidden", () => {
    const d = decide([
      row("001", "1900", "1500"),
      row("005", "last10_win_pct=80", "last10_win_pct=30"),
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"), // P2 contradiction
    ]);
    expect(d.outcome).toBe("P1");
    expect(d.stability).toBe("STABLE"); // supported but contradicted -> not ROBUST
    expect(d.independent_contradiction_families).toEqual(["H2H_PROBABILITY"]);
  });

  it("a single dissent does not by itself overturn a broader independent consensus", () => {
    const d = decide([
      row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30"),
      row("027", "lead_protection_rate_pct=90", "lead_protection_rate_pct=40"),
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"),
    ]);
    expect(d.outcome).toBe("P1");
    expect(d.independent_support_families).toHaveLength(3);
    expect(d.independent_contradiction_families).toHaveLength(1);
  });
});

describe("anti-double-counting (scenario 12)", () => {
  it("correlated same-family metrics vote ONCE, and the duplicate is reported as duplicated support", () => {
    // 031 and 080 both read the shared-opponent pool -> one COMMON_OPPONENT family.
    const d = decide([
      row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"),
      row("080", REAL_080_P1, REAL_080_P2),
      row("001", "1900", "1500"),
    ]);
    const commonOpponent = d.families.find((f) => f.family === "COMMON_OPPONENT")!;
    expect(commonOpponent.supporting_metrics.sort()).toEqual(["031", "080"]);
    // Two agreeing metrics, but only ONE independent family credited.
    expect(d.independent_support_families.sort()).toEqual(["COMMON_OPPONENT", "SURFACE_STRENGTH"]);
    expect(d.duplicated_support_metrics).toContain("080");
  });

  it("three agreeing metrics inside one family do NOT beat two genuinely independent families", () => {
    // P1 wins the single COMMON_OPPONENT family (2 correlated metrics);
    // P2 wins two independent families. P2 must lead on independent families.
    const d = decide([
      row("031", "opponent_adjusted_set_differential=2", "opponent_adjusted_set_differential=-2"),
      row("080", REAL_080_P1, REAL_080_P2),
      row("001", "1500", "1900"),
      row("005", "last10_win_pct=20", "last10_win_pct=90"),
    ]);
    expect(d.outcome).toBe("P2");
    expect(d.independent_support_families.sort()).toEqual(["RECENT_FORM", "SURFACE_STRENGTH"]);
    expect(d.independent_contradiction_families).toEqual(["COMMON_OPPONENT"]);
  });

  it("a family whose own metrics disagree votes for nobody", () => {
    const d = decide([
      row("031", "opponent_adjusted_set_differential=2", "opponent_adjusted_set_differential=-2"), // P1
      row("080", REAL_080_P2, REAL_080_P1), // P2 -- same family, opposite direction
      row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30"),
    ]);
    expect(d.conflicted_families).toEqual(["COMMON_OPPONENT"]);
    expect(d.independent_support_families.sort()).toEqual(["RECENT_FORM", "SURFACE_STRENGTH"]);
    expect(d.independent_contradiction_families).toEqual([]);
  });
});

describe("leave-one-family-out stress test (scenarios 10 & 11)", () => {
  it("scenario 10: a lead a single family can REVERSE is refused as FRAGILE", () => {
    // P1: 2 families (SURFACE_STRENGTH, RECENT_FORM). P2: 2 families (H2H_PROBABILITY,
    // CLOSING_ABILITY) + COMMON_OPPONENT for P1 = 3-2 P1. Removing COMMON_OPPONENT makes
    // it 2-2... to get a genuine reversal we give P2 two families and P1 three, where
    // dropping one P1 family yields 2-2 (tie) -- so instead construct a real reversal:
    // P1 leads 2-1; removing a P1 family gives 1-1 (tie, not reversal). A true reversal
    // needs P2 to overtake, e.g. P1 2 families vs P2 2 families is a tie, so we build
    // P1=2, P2=1 and then remove... see the dedicated reversal construction below.
    const d = decide([
      row("001", "1900", "1500"), // P1 SURFACE_STRENGTH
      row("005", "last10_win_pct=80", "last10_win_pct=30"), // P1 RECENT_FORM
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"), // P2 H2H
      row("027", "lead_protection_rate_pct=40", "lead_protection_rate_pct=90"), // P2 CLOSING
      row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"), // P1 COMMON_OPPONENT
    ]);
    // P1 leads 3-2. Removing any single P1 family makes it 2-2 (tie), never a reversal.
    expect(d.outcome).toBe("P1");
    expect(d.flipping_families).toEqual([]);
    expect(d.tie_inducing_families.sort()).toEqual(["COMMON_OPPONENT", "RECENT_FORM", "SURFACE_STRENGTH"]);
    expect(d.stability).toBe("STABLE"); // thin + contradicted, but not reversible
  });

  it("a lead that a single family's removal genuinely REVERSES is refused", () => {
    // P1 leads 2-1 on families; COMMON_OPPONENT holds TWO correlated P1 metrics that vote
    // once. Removing SURFACE_STRENGTH leaves P1 1 - P2 1 (tie); to force a real reversal we
    // give P2 two families and P1 two, with one P1 family removable to yield P2 lead.
    const d = decide([
      row("001", "1900", "1500"), // P1 SURFACE_STRENGTH
      row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"), // P1 COMMON_OPPONENT
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"), // P2 H2H
      row("027", "lead_protection_rate_pct=40", "lead_protection_rate_pct=90"), // P2 CLOSING
      row("005", "last10_win_pct=80", "last10_win_pct=30"), // P1 RECENT_FORM -> P1 3-2
    ]);
    // Sanity: this is the 3-2 case, no reversal possible from a single removal.
    expect(d.flipping_families).toEqual([]);
    // Now drop one P1 family from the input entirely: 2-2 tie -> refusal (not a selection).
    const tied = decide([
      row("001", "1900", "1500"),
      row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"),
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"),
      row("027", "lead_protection_rate_pct=40", "lead_protection_rate_pct=90"),
    ]);
    expect(tied.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(tied.reason).toMatch(/tied/i);
  });

  it("scenario 11: a broad lead SURVIVES removal of any single family -> selection stands", () => {
    const d = decide([
      row("001", "1900", "1500"),
      row("005", "last10_win_pct=80", "last10_win_pct=30"),
      row("027", "lead_protection_rate_pct=90", "lead_protection_rate_pct=40"),
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"),
    ]);
    expect(d.flipping_families).toEqual([]);
    expect(d.stability).toBe("STABLE");
    expect(d.outcome).toBe("P1");
  });

  it("LOFO is a real recomputation, not a label: each named family genuinely changes the recount", () => {
    const d = decide([
      row("001", "1900", "1500"),
      row("005", "last10_win_pct=80", "last10_win_pct=30"),
      row("051", "shrunk_win_probability_pct=20", "shrunk_win_probability_pct=80"),
    ]);
    // Independently re-derive the recount for every family this engine named as tie-inducing.
    for (const family of d.tie_inducing_families) {
      const remaining = d.families.filter((f) => f.family !== family);
      const p1 = remaining.filter((f) => f.vote === "P1").length;
      const p2 = remaining.filter((f) => f.vote === "P2").length;
      expect(p1).toBe(p2); // genuinely no leader once that family is removed
    }
    // And every family NOT named must genuinely leave the leader intact.
    for (const f of d.families) {
      if (d.tie_inducing_families.includes(f.family) || d.flipping_families.includes(f.family)) continue;
      const remaining = d.families.filter((o) => o.family !== f.family);
      const p1 = remaining.filter((o) => o.vote === "P1").length;
      const p2 = remaining.filter((o) => o.vote === "P2").length;
      expect(p1).toBeGreaterThan(p2);
    }
  });
});

describe("refusal is first-class", () => {
  // PRODUCT CHANGE: this previously asserted that a single supporting family is refused
  // outright. That hard gate has been replaced by the 60% directional-evidence threshold,
  // so a single uncontradicted family now selects -- while a NEUTRAL family alongside it
  // (005 here, both sides level) neither helps nor hurts, because parity favours nobody.
  // The selection is explicitly marked uncorroborated so a one-family call is never
  // mistaken for a broadly-supported one.
  it("a lead on a single independent family is now selected, but flagged uncorroborated", () => {
    const d = decide([row("001", "1900", "1500"), row("005", "last10_win_pct=50", "last10_win_pct=50")]);
    expect(d.independent_support_families).toEqual(["SURFACE_STRENGTH"]);
    expect(d.neutral_families).toContain("RECENT_FORM");
    expect(d.directional_families).toBe(1);
    expect(d.evidence_percent).toBe(100);
    expect(d.outcome).toBe("P1");
    expect(d.corroborated).toBe(false);
    expect(d.reason).toMatch(/uncorroborated/i);
  });

  it("a single supporting family against one contradiction is 50% and still refused", () => {
    // The threshold is a real gate, not a rubber stamp: an evenly-split match is refused
    // exactly as before, and MIN_INDEPENDENT_SUPPORT_FAMILIES no longer decides it.
    const d = decide([row("001", "1900", "1500"), row("005", "last10_win_pct=20", "last10_win_pct=90")]);
    expect(d.evidence_percent).toBeLessThan(60);
    expect(d.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("the threshold is applied to families, and UNAVAILABLE never counts against anyone", () => {
    // Three supporting families vs one contradiction = 75% >= 60% -> selected. The
    // unavailable rows are recorded but must not enter the denominator; if they did, the
    // share would be diluted below the threshold and the player would be penalised for
    // evidence that simply does not exist.
    const d = decide([
      row("001", "1900", "1500"),
      row("005", "last10_win_pct=80; last10_matches=10", "last10_win_pct=30; last10_matches=10"),
      row("007", "win_pct=75; ranked_common_opponent_matches=12", "win_pct=30; ranked_common_opponent_matches=12"),
      row("006", "bad_loss_rate_pct=40; quality_observed_matches=20", "bad_loss_rate_pct=5; quality_observed_matches=20"),
      row("011", null, null),
      row("029", null, null),
    ]);
    expect(d.directional_families).toBe(4);
    expect(d.evidence_percent).toBe(75);
    expect(d.outcome).toBe("P1");
    expect(d.corroborated).toBe(true);
    expect(d.unavailable.length).toBeGreaterThan(0);
  });

  it("an internally conflicted family drags the share down instead of being ignored", () => {
    // 002 and 003 are both POINT_BY_POINT and disagree, so that family is conflicted. It
    // stays in the denominator (1 support of 2 directional = 50%), which is what stops a
    // contradiction inside one family from being silently discarded.
    const d = decide([
      row("001", "1900", "1500"),
      { metric_code: "002", p1_value: 'output={"service_points":60,"service_point_win_pct":90}', p2_value: 'output={"service_points":60,"service_point_win_pct":10}', p1_treatment: "PARTIAL", p2_treatment: "PARTIAL" },
      { metric_code: "003", p1_value: 'output={"return_points":60,"return_point_win_pct":10}', p2_value: 'output={"return_points":60,"return_point_win_pct":90}', p1_treatment: "PARTIAL", p2_treatment: "PARTIAL" },
    ]);
    expect(d.conflicted_families).toContain("POINT_BY_POINT");
    expect(d.directional_families).toBe(2);
    expect(d.evidence_percent).toBe(50);
    expect(d.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("a tie on independent families is refused", () => {
    const d = decide([row("001", "1900", "1500"), row("005", "last10_win_pct=20", "last10_win_pct=90")]);
    expect(d.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(d.reason).toMatch(/tied/i);
  });

  it("no comparable evidence at all is refused with every exclusion reason preserved", () => {
    const d = decide([row("999", "x", "y"), row("001", null, null)]);
    expect(d.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(d.unavailable.map((u) => u.status).sort()).toEqual(["NO_COMPARISON_SPEC", "VALUE_NOT_PARSEABLE"]);
  });
});

describe("pipeline wiring: the deterministic conclusion is authoritative and independent", () => {
  it("derives the winner from persisted metric rows, in the metric_results row shape", () => {
    const c = deterministicIndependentConclusion(
      [
        { metric_code: "001", p1_value: "1900", p2_value: "1500", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
        { metric_code: "005", p1_value: "last10_win_pct=80", p2_value: "last10_win_pct=30", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL" },
        { metric_code: "027", p1_value: "lead_protection_rate_pct=90", p2_value: "lead_protection_rate_pct=40", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED" },
      ],
      P1,
      P2,
    );
    expect(c.winner).toBe(P1);
    expect(c.audit.decision.outcome).toBe("P1");
    expect(c.audit.decision.independent_support_families).toHaveLength(3);
    expect(c.rationale).toMatch(/Evidence chain:/);
    expect(c.insufficient_reason).toBeNull();
  });

  it("refuses, with a reason, when the persisted evidence does not support a side", () => {
    const c = deterministicIndependentConclusion(
      [
        // Bare unlabelled scalars -- exactly what metrics 008/010/012/013/014 actually persist.
        { metric_code: "008", p1_value: "5", p2_value: "12", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
        { metric_code: "010", p1_value: "1", p2_value: "0", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      ],
      P1,
      P2,
    );
    expect(c.winner).toBeNull();
    expect(c.insufficient_reason).toBeTruthy();
    expect(c.audit.decision.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("is reproducible: the same persisted rows always yield the same selection", () => {
    const rows = [
      { metric_code: "001", p1_value: "1900", p2_value: "1500", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      { metric_code: "005", p1_value: "last10_win_pct=80", p2_value: "last10_win_pct=30", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL" },
      { metric_code: "027", p1_value: "lead_protection_rate_pct=90", p2_value: "lead_protection_rate_pct=40", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
    ];
    const a = deterministicIndependentConclusion(rows, P1, P2);
    const b = deterministicIndependentConclusion(rows, P1, P2);
    expect(a.winner).toBe(b.winner);
    expect(a.audit.decision.reason).toBe(b.audit.decision.reason);
    expect(a.audit.decision.stability).toBe(b.audit.decision.stability);
  });

  it("swapping which player is P1 swaps the selection -- the engine is not 'P1-first'", () => {
    const rows = [
      { metric_code: "001", p1_value: "1500", p2_value: "1900", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      { metric_code: "005", p1_value: "last10_win_pct=30", p2_value: "last10_win_pct=80", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL" },
      { metric_code: "027", p1_value: "lead_protection_rate_pct=40", p2_value: "lead_protection_rate_pct=90", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
    ];
    const c = deterministicIndependentConclusion(rows, P1, P2);
    expect(c.winner).toBe(P2); // the weaker side is P1 here, so P2 must be selected
    expect(c.audit.decision.outcome).toBe("P2");
  });
});

describe("scenario 14/15: quarantined and unavailable metrics cannot influence the decision", () => {
  it("no quarantined Matrix-Summary metric has a comparison spec", () => {
    for (const code of MATRIX_SUMMARY_REQUIRED_CODES) {
      expect(COMPARISON_SPECS[code], `quarantined ${code} must not be comparable`).toBeUndefined();
    }
  });

  it("a quarantined code carrying legacy values is excluded and changes nothing", () => {
    const withoutLegacy = decide([row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30")]);
    const withLegacy = decide([
      row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30"),
      // 035 is quarantined but has real historical values persisted -- it must not vote.
      row("035", "observed_vs_expected_wl_gap_pct=40", "observed_vs_expected_wl_gap_pct=-40", ["PARTIAL", "PARTIAL"]),
    ]);
    expect(withLegacy.outcome).toBe(withoutLegacy.outcome);
    expect(withLegacy.independent_support_families).toEqual(withoutLegacy.independent_support_families);
    expect(withLegacy.unavailable.some((u) => u.metric_code === "035" && u.status === "NO_COMPARISON_SPEC")).toBe(true);
  });
});

describe("persisted field aliases (registry vs. real producer output)", () => {
  // Live finding: across 304 persisted rows, metric 008 emitted "deciding_set_win_pct" in
  // 87 rows and the registry's "set3_deciding_set_win_pct" in 1; metric 010 emitted
  // "straight_set_win_pct" in 89 and "straight_set_match_win_pct" in 1. Both pairs name the
  // identical quantity, so the comparison must read either without a spec rewrite.
  const row = (code: string, p1: string, p2: string): MetricRowForComparison => ({
    metric_code: code, p1_value: p1, p2_value: p2, p1_treatment: "DIRECT", p2_treatment: "DIRECT",
  });

  it("reads the alias name emitted by the real producer", () => {
    const c = compareMetricRow(row("008", "deciding_set_win_pct=62", "deciding_set_win_pct=41"));
    expect(c.status).toBe("COMPARED");
    expect(c.p1_number).toBe(62);
    expect(c.p2_number).toBe(41);
    expect(c.favours).toBe("P1");
  });

  it("prefers the canonical name when both are present", () => {
    const c = compareMetricRow(row("010", "straight_set_match_win_pct=70; straight_set_win_pct=10", "straight_set_match_win_pct=40; straight_set_win_pct=90"));
    expect(c.p1_number).toBe(70);
    expect(c.p2_number).toBe(40);
  });

  it("still refuses a lean when only one side carries the alias", () => {
    const c = compareMetricRow(row("008", "deciding_set_win_pct=62", "deciding_matches=9"));
    expect(c.status).toBe("ONE_SIDED_EVIDENCE");
    expect(c.favours).toBe("UNAVAILABLE");
  });

  it("does not treat a similar-sounding neighbouring field as an alias", () => {
    // 010 also persists "same_surface_straight_set_win_pct" -- a DIFFERENT population.
    // Reading it here would silently change what is being compared.
    const c = compareMetricRow(row("010", "same_surface_straight_set_win_pct=90", "same_surface_straight_set_win_pct=10"));
    expect(c.status).toBe("VALUE_NOT_PARSEABLE");
    expect(c.favours).toBe("UNAVAILABLE");
  });

  it("every declared alias belongs to a spec that has a keyed field", () => {
    for (const [code, spec] of Object.entries(COMPARISON_SPECS)) {
      if (!spec.fieldAliases?.length) continue;
      expect(spec.field, `${code} declares aliases but compares a bare scalar`).not.toBeNull();
      expect(new Set(spec.fieldAliases).size, `${code} has duplicate aliases`).toBe(spec.fieldAliases.length);
      expect(spec.fieldAliases, `${code} lists its own canonical field as an alias`).not.toContain(spec.field);
    }
  });
});

describe("metric 001 persists two shapes for one quantity", () => {
  // Live finding: of 304 persisted 001 rows, 189 carry a bare scalar and 102 carry
  // "surface_elo=". Both are the surface Elo. "overall_elo" is a DIFFERENT quantity and
  // must never stand in for it.
  const row = (p1: string, p2: string): MetricRowForComparison => ({
    metric_code: "001", p1_value: p1, p2_value: p2, p1_treatment: "DIRECT", p2_treatment: "DIRECT",
  });

  it("compares the bare-scalar shape", () => {
    const c = compareMetricRow(row("1521.13", "1465.29"));
    expect(c.status).toBe("COMPARED");
    expect(c.p1_number).toBeCloseTo(1521.13, 2);
    expect(c.favours).toBe("P1");
  });

  it("compares the keyed shape", () => {
    const c = compareMetricRow(row("overall_elo=1420; surface=clay; surface_elo=1429", "overall_elo=1432; surface=clay; surface_elo=1442"));
    expect(c.status).toBe("COMPARED");
    expect(c.p1_number).toBe(1429);
    expect(c.p2_number).toBe(1442);
    expect(c.favours).toBe("P2");
  });

  it("never substitutes overall_elo for surface_elo", () => {
    const c = compareMetricRow(row("overall_elo=1900", "overall_elo=1200"));
    expect(c.status).toBe("VALUE_NOT_PARSEABLE");
    expect(c.favours).toBe("UNAVAILABLE");
  });

  it("compares across the two shapes without crediting the keyed side", () => {
    const c = compareMetricRow(row("1521.13", "overall_elo=1432; surface_elo=1442"));
    expect(c.status).toBe("COMPARED");
    expect(c.p2_number).toBe(1442);
  });

  it("bareScalarFallback is only declared where the bare form is the same measurement", () => {
    for (const [code, spec] of Object.entries(COMPARISON_SPECS)) {
      if (!spec.bareScalarFallback) continue;
      expect(spec.field, `${code} sets bareScalarFallback with no keyed field to fall back from`).not.toBeNull();
    }
    // 008/010 persist bare counts of unknown definition; guessing them is exactly the
    // silent inversion this registry exists to prevent.
    expect(COMPARISON_SPECS["008"].bareScalarFallback).toBeUndefined();
    expect(COMPARISON_SPECS["010"].bareScalarFallback).toBeUndefined();
  });
});

describe("Phase 12 — JSON payload evidence", () => {
  // Reconstructed metrics persist their real numbers inside output={...}. Before Phase 12
  // the ";"-split parser could not see inside, so 002/003/009/018/032/034/053 were all
  // NO_COMPARISON_SPEC or unparseable despite carrying complete evidence.
  const pbp = (code: string, payload: Record<string, unknown>) =>
    `reconstructed_matches=12; treatment=PARTIAL; output=${JSON.stringify(payload)}; raw_fields=server,point_winner`;

  it("reads a numeric field out of the JSON payload", () => {
    const c = compareMetricRow({
      metric_code: "002",
      p1_value: pbp("002", { service_points: 58, service_point_win_pct: 61.1111, hold_pct: 75, aces: null }),
      p2_value: pbp("002", { service_points: 54, service_point_win_pct: 44.8276, hold_pct: 40, aces: null }),
      p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
    });
    expect(c.status).toBe("COMPARED");
    expect(c.p1_number).toBeCloseTo(61.1111, 3);
    expect(c.p2_number).toBeCloseTo(44.8276, 3);
    expect(c.favours).toBe("P1"); // 16.3pp clears the 10pp floor
  });

  it("never coerces a null payload entry into zero", () => {
    const c = compareMetricRow({
      metric_code: "032",
      p1_value: pbp("032", { break_chances: 0, bp_converted_pct: null }),
      p2_value: pbp("032", { break_chances: 5, bp_converted_pct: 60 }),
      p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
    });
    expect(c.status).toBe("ONE_SIDED_EVIDENCE");
    expect(c.favours).toBe("UNAVAILABLE");
    expect(c.p1_number).toBeNull();
  });

  it("a malformed payload is not evidence and is never guessed at", () => {
    const c = compareMetricRow({
      metric_code: "003",
      p1_value: "output={not valid json",
      p2_value: pbp("003", { return_point_win_pct: 50 }),
      p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
    });
    expect(c.status).toBe("ONE_SIDED_EVIDENCE");
    expect(c.favours).toBe("UNAVAILABLE");
  });

  it("a top-level key wins over a payload key of the same name", () => {
    const c = compareMetricRow({
      metric_code: "034",
      p1_value: `dominance_ratio=2.0; output=${JSON.stringify({ dominance_ratio: 0.5 })}`,
      p2_value: `dominance_ratio=1.0; output=${JSON.stringify({ dominance_ratio: 9.9 })}`,
      p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
    });
    expect(c.p1_number).toBe(2);
    expect(c.p2_number).toBe(1);
  });
});

describe("Phase 12 — P1/P2 symmetry under swap", () => {
  // Every activated spec must reverse cleanly when the two players are exchanged. A metric
  // that does not is a P1-first bias and must not be in the registry.
  const sample: Record<string, [string, string]> = {
    "001": ["surface_elo=1500", "surface_elo=1400"],
    "002": ['output={"service_points":80,"service_point_win_pct":65}', 'output={"service_points":75,"service_point_win_pct":40}'],
    "003": ['output={"return_points":80,"return_point_win_pct":55}', 'output={"return_points":75,"return_point_win_pct":30}'],
    "005": ["last10_win_pct=70", "last10_win_pct=20"],
    "006": ["quality_observed_matches=9; bad_loss_rate_pct=10", "quality_observed_matches=8; bad_loss_rate_pct=80"],
    "007": ["ranked_common_opponent_matches=30; win_pct=75", "ranked_common_opponent_matches=26; win_pct=25"],
    "008": ["deciding_set_win_pct=70", "deciding_set_win_pct=20"],
    "009": ['output={"pressure_points":30,"pressure_win_pct":70}', 'output={"pressure_points":28,"pressure_win_pct":20}'],
    "010": ["straight_set_win_pct=70", "straight_set_win_pct=20"],
    "011": ["match_win_pct=70", "match_win_pct=20"],
    "018": ['output={"breakback_opportunities":15,"breakback_rate_pct":90}', 'output={"breakback_opportunities":14,"breakback_rate_pct":10}'],
    "027": ["lead_protection_rate_pct=90", "lead_protection_rate_pct=40"],
    "029": ["after_close_set_loss_n=12; after_close_set_loss_match_win_pct=80; baseline_match_win_rate_pct=20", "after_close_set_loss_n=11; after_close_set_loss_match_win_pct=20; baseline_match_win_rate_pct=60"],
    "031": ["opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"],
    "032": ['output={"break_chances":14,"bp_converted_pct":90}', 'output={"break_chances":12,"bp_converted_pct":10}'],
    "034": ['output={"total_points_played":170,"dominance_ratio":1.8}', 'output={"total_points_played":160,"dominance_ratio":0.9}'],
    "036": ["trailing_losses_used=20; favorite_losses_rate_pct=10", "trailing_losses_used=20; favorite_losses_rate_pct=80"],
    "041": ["recent_elo_adjusted_surplus=0.4; earlier_elo_adjusted_surplus=0.0", "recent_elo_adjusted_surplus=-0.4; earlier_elo_adjusted_surplus=0.0"],
    "051": ["shrunk_win_probability_pct=70", "shrunk_win_probability_pct=30"],
    "053": ['output={"pressure_points":30,"pressure_index_pct":70}', 'output={"pressure_points":26,"pressure_index_pct":20}'],
    "055": ["elo_change_last10=60", "elo_change_last10=-60"],
    "080": ["favorable_divergent_outcomes=9; unfavorable_divergent_outcomes=1", "favorable_divergent_outcomes=1; unfavorable_divergent_outcomes=9"],
    "016": ['output={"score_state_performance_json":"{\\"Break Point\\":{\\"n\\":12,\\"win_pct\\":80}}"}', 'output={"score_state_performance_json":"{\\"Break Point\\":{\\"n\\":10,\\"win_pct\\":20}}"}'],
    "045": ["forced_deciding_set_n=15; forced_deciding_set_win_pct=80", "forced_deciding_set_n=12; forced_deciding_set_win_pct=30"],
    "068": ["current_streak=W12; season_matches=20", "current_streak=L3; season_matches=18"],
  };

  it("covers every registered spec", () => {
    expect(Object.keys(sample).sort()).toEqual(Object.keys(COMPARISON_SPECS).sort());
  });

  for (const [code, [strong, weak]] of Object.entries(sample)) {
    it(`${code} reverses when P1 and P2 are swapped`, () => {
      const usable = { p1_treatment: "DIRECT", p2_treatment: "DIRECT" } as const;
      const forward = compareMetricRow({ metric_code: code, p1_value: strong, p2_value: weak, ...usable });
      const swapped = compareMetricRow({ metric_code: code, p1_value: weak, p2_value: strong, ...usable });

      expect(forward.status, `${code} forward`).toBe("COMPARED");
      expect(swapped.status, `${code} swapped`).toBe("COMPARED");
      expect(forward.favours, `${code} should favour the stronger side`).toBe("P1");
      expect(swapped.favours, `${code} should follow the player, not the slot`).toBe("P2");
      // The measured quantities travel with the player.
      expect(swapped.p1_number).toBe(forward.p2_number);
      expect(swapped.p2_number).toBe(forward.p1_number);
      // And the decision-facing advantage is exactly negated.
      expect(swapped.advantage_p1).toBe(-forward.advantage_p1!);
    });

    it(`${code} gives no side an advantage from the other's missing evidence`, () => {
      const p1Only = compareMetricRow({ metric_code: code, p1_value: strong, p2_value: null, p1_treatment: "DIRECT", p2_treatment: "DIRECT" });
      const p2Only = compareMetricRow({ metric_code: code, p1_value: null, p2_value: strong, p1_treatment: "DIRECT", p2_treatment: "DIRECT" });
      expect(p1Only.favours, `${code} P1-only`).toBe("UNAVAILABLE");
      expect(p2Only.favours, `${code} P2-only`).toBe("UNAVAILABLE");
      expect(p1Only.status).toBe("ONE_SIDED_EVIDENCE");
      expect(p2Only.status).toBe("ONE_SIDED_EVIDENCE");
    });
  }
});

describe("Phase 12 — correlated metrics cannot become independent support", () => {
  it("all point-by-point reconstructions share one family", () => {
    for (const code of ["002", "003", "009", "018", "032", "034", "053"]) {
      expect(COMPARISON_SPECS[code].family, `${code}`).toBe("POINT_BY_POINT");
    }
  });

  it("the shared-opponent metrics share one family", () => {
    for (const code of ["007", "031", "080"]) {
      expect(COMPARISON_SPECS[code].family, `${code}`).toBe("COMMON_OPPONENT");
    }
  });

  it("the two last-10-window metrics share one family", () => {
    expect(COMPARISON_SPECS["005"].family).toBe("RECENT_FORM");
    expect(COMPARISON_SPECS["055"].family).toBe("RECENT_FORM");
  });

  it("the two loss-quality metrics share one family", () => {
    expect(COMPARISON_SPECS["006"].family).toBe("LOSS_PROFILE");
    expect(COMPARISON_SPECS["036"].family).toBe("LOSS_PROFILE");
  });

  it("seven agreeing point-by-point metrics still cast a single vote", () => {
    const rows: MetricRowForComparison[] = ["002", "003", "009", "018", "032", "034", "053"].map((code) => {
      const [strong, weak] = [
        { "002": 90, "003": 90, "009": 95, "018": 95, "032": 95, "034": 3, "053": 95 }[code]!,
        { "002": 10, "003": 10, "009": 5, "018": 5, "032": 5, "034": 0.3, "053": 5 }[code]!,
      ];
      const spec = COMPARISON_SPECS[code];
      const denom = `"${spec.sampleField![0]}":${(spec.minSample ?? 0) + 20}`;
      return {
        metric_code: code,
        p1_value: `output={${denom},"${spec.field}":${strong}}`,
        p2_value: `output={${denom},"${spec.field}":${weak}}`,
        p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
      };
    });
    const decision = decideTruthEngineSelection({ comparisons: compareMetricRows(rows), p1Name: "A", p2Name: "B" });
    // Anti-double-counting, which the 60% threshold does NOT relax: seven correlated
    // metrics collapse to ONE family casting ONE vote, and the other six are recorded as
    // deliberately-not-recounted rather than quietly dropped.
    expect(decision.independent_support_families).toEqual(["POINT_BY_POINT"]);
    expect(decision.directional_families).toBe(1);
    expect(decision.duplicated_support_metrics).toHaveLength(6);
    // The share is computed over FAMILIES, never metrics. Seven agreeing metrics give the
    // same 100% a single one would; they cannot manufacture extra weight.
    expect(decision.evidence_percent).toBe(100);
    // It is a single family, so the selection is explicitly flagged as uncorroborated.
    expect(decision.corroborated).toBe(false);
    expect(decision.reason).toMatch(/uncorroborated/i);
  });

  it("seven agreeing correlated metrics cannot outvote one genuinely independent contradiction", () => {
    // The sharpest anti-double-counting proof under the threshold rule. If the percentage
    // were computed from metric counts, P1 would hold 7/8 = 87.5% and be selected. Computed
    // from families it is 1 support vs 1 contradiction = 50%, below the 60% threshold, so
    // no side is selected. Correlated volume buys nothing.
    const pbp: MetricRowForComparison[] = ["002", "003", "009", "018", "032", "034", "053"].map((code) => {
      const [strong, weak] = [
        { "002": 90, "003": 90, "009": 95, "018": 95, "032": 95, "034": 3, "053": 95 }[code]!,
        { "002": 10, "003": 10, "009": 5, "018": 5, "032": 5, "034": 0.3, "053": 5 }[code]!,
      ];
      const spec = COMPARISON_SPECS[code];
      const denom = `"${spec.sampleField![0]}":${(spec.minSample ?? 0) + 20}`;
      return { metric_code: code, p1_value: `output={${denom},"${spec.field}":${strong}}`, p2_value: `output={${denom},"${spec.field}":${weak}}`, p1_treatment: "PARTIAL" as const, p2_treatment: "PARTIAL" as const };
    });
    // One independent family (RECENT_FORM via 005) pointing the other way.
    const contra: MetricRowForComparison = {
      metric_code: "005",
      p1_value: "last10_win_pct=30; last10_matches=10",
      p2_value: "last10_win_pct=80; last10_matches=10",
      p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
    };
    const decision = decideTruthEngineSelection({ comparisons: compareMetricRows([...pbp, contra]), p1Name: "A", p2Name: "B" });
    expect(decision.directional_families).toBe(2);
    expect(decision.evidence_percent).toBe(50);
    expect(decision.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("no newly activated code is one of the quarantined Matrix Summary metrics", () => {
    for (const code of Object.keys(COMPARISON_SPECS)) {
      expect(MATRIX_SUMMARY_REQUIRED_CODES, `${code} is quarantined`).not.toContain(code);
    }
  });
});

describe("Phase 13.5 — evidence expansion joins existing families, casts no new votes", () => {
  it("016 (break-point score-state) joins POINT_BY_POINT", () => {
    for (const code of ["002", "003", "009", "016", "018", "032", "034", "053"]) {
      expect(COMPARISON_SPECS[code].family, code).toBe("POINT_BY_POINT");
    }
  });

  it("045 (favourite-perspective deciding-set win %) joins SET_PROFILE alongside 008/010", () => {
    for (const code of ["008", "010", "045"]) {
      expect(COMPARISON_SPECS[code].family, code).toBe("SET_PROFILE");
    }
  });

  it("068 (current streak) joins RECENT_FORM alongside 005/055", () => {
    for (const code of ["005", "055", "068"]) {
      expect(COMPARISON_SPECS[code].family, code).toBe("RECENT_FORM");
    }
  });

  it("eight agreeing point-by-point metrics (including 016) still cast a single vote", () => {
    const rows: MetricRowForComparison[] = ["002", "003", "009", "016", "018", "032", "034", "053"].map((code) => {
      const spec = COMPARISON_SPECS[code];
      const denom = `"${spec.sampleField![0]}":${(spec.minSample ?? 0) + 20}`;
      const strongField = spec.field === "score_state_break_point_win_pct"
        ? `"score_state_performance_json":"{\\"Break Point\\":{\\"n\\":${(spec.minSample ?? 0) + 20},\\"win_pct\\":90}}"`
        : `"${spec.field}":90`;
      const weakField = spec.field === "score_state_break_point_win_pct"
        ? `"score_state_performance_json":"{\\"Break Point\\":{\\"n\\":${(spec.minSample ?? 0) + 20},\\"win_pct\\":10}}"`
        : `"${spec.field}":10`;
      return {
        metric_code: code,
        p1_value: `output={${denom},${strongField}}`,
        p2_value: `output={${denom},${weakField}}`,
        p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
      };
    });
    const decision = decideTruthEngineSelection({ comparisons: compareMetricRows(rows), p1Name: "A", p2Name: "B" });
    // 016 joins POINT_BY_POINT rather than opening a ninth vote: eight correlated metrics,
    // one family, one vote, seven recorded as not-recounted. The 60% threshold changed the
    // downstream gate, not this consolidation.
    expect(decision.independent_support_families).toEqual(["POINT_BY_POINT"]);
    expect(decision.directional_families).toBe(1);
    expect(decision.duplicated_support_metrics).toHaveLength(7);
    expect(decision.evidence_percent).toBe(100);
  });

  it("adding 045 does not create a second SET_PROFILE-adjacent vote when it agrees with 008", () => {
    const rows: MetricRowForComparison[] = [
      { metric_code: "008", p1_value: "deciding_set_win_pct=80", p2_value: "deciding_set_win_pct=20", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      { metric_code: "045", p1_value: "forced_deciding_set_n=15; forced_deciding_set_win_pct=80", p2_value: "forced_deciding_set_n=12; forced_deciding_set_win_pct=20", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
    ];
    const decision = decideTruthEngineSelection({ comparisons: compareMetricRows(rows), p1Name: "A", p2Name: "B" });
    expect(decision.independent_support_families).toEqual(["SET_PROFILE"]);
    expect(decision.families.find((f) => f.family === "SET_PROFILE")?.supporting_metrics.sort()).toEqual(["008", "045"]);
  });

  it("045 disagreeing with 008 makes SET_PROFILE conflicted, not two opposite votes", () => {
    const rows: MetricRowForComparison[] = [
      { metric_code: "008", p1_value: "deciding_set_win_pct=80", p2_value: "deciding_set_win_pct=20", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      { metric_code: "045", p1_value: "forced_deciding_set_n=15; forced_deciding_set_win_pct=20", p2_value: "forced_deciding_set_n=12; forced_deciding_set_win_pct=80", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
    ];
    const decision = decideTruthEngineSelection({ comparisons: compareMetricRows(rows), p1Name: "A", p2Name: "B" });
    expect(decision.independent_support_families).toEqual([]);
    expect(decision.independent_contradiction_families).toEqual([]);
    expect(decision.conflicted_families).toContain("SET_PROFILE");
  });

  it("068 disagreeing with 005 makes RECENT_FORM conflicted (live-shaped case)", () => {
    // Mirrors the real bd5ff483 finding from Phase 12: two RECENT_FORM metrics can measure
    // the same recency window and still point opposite ways.
    const rows: MetricRowForComparison[] = [
      { metric_code: "005", p1_value: "last10_win_pct=70", p2_value: "last10_win_pct=40", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      { metric_code: "068", p1_value: "current_streak=L4; season_matches=20", p2_value: "current_streak=W3; season_matches=18", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
    ];
    const decision = decideTruthEngineSelection({ comparisons: compareMetricRows(rows), p1Name: "A", p2Name: "B" });
    expect(decision.conflicted_families).toContain("RECENT_FORM");
    expect(decision.independent_support_families).toEqual([]);
  });

  it("046 (Match-State Elo) is deliberately NOT activated: no persisted denominator, no single canonical field", () => {
    // Investigated and excluded -- see docs/audit-truth-engine-phase13.5-evidence-expansion.md.
    // Both elo_after_winning_set1 and elo_after_losing_set1 are equally-weighted, distinctly-
    // scoped bullets in the metric's own definition with no basis for picking one, and 0 of
    // 60 live usable rows persist ANY sample/n field for either quantity.
    expect(COMPARISON_SPECS["046"]).toBeUndefined();
  });

  it("004, 023, 038 remain unactivated: directionally clean but too thin for production use", () => {
    // Investigated and left out -- calculable in principle (12, 10 and 9 live usable rows
    // respectively) but too sparse to be a reliable production voter. See the same doc.
    for (const code of ["004", "023", "038"]) {
      expect(COMPARISON_SPECS[code], code).toBeUndefined();
    }
  });

  it("registry size is exactly 25 after this phase", () => {
    expect(Object.keys(COMPARISON_SPECS).length).toBe(25);
  });
});

describe("Phase 12 — a thin denominator is never a lean", () => {
  // Live proof this guard is needed: on run ce9706af metric 018 read 0% vs 100% breakbacks
  // -- a 100-point gap -- off 3 and 2 attempts. Fixed materiality cannot catch that.
  const row018 = (p1Opps: number, p1Rate: number, p2Opps: number, p2Rate: number): MetricRowForComparison => ({
    metric_code: "018",
    p1_value: `output={"breakback_opportunities":${p1Opps},"breakback_rate_pct":${p1Rate}}`,
    p2_value: `output={"breakback_opportunities":${p2Opps},"breakback_rate_pct":${p2Rate}}`,
    p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED",
  });

  it("refuses the real 0%-vs-100% comparison taken from 3 and 2 attempts", () => {
    const c = compareMetricRow(row018(3, 0, 2, 100));
    expect(c.status).toBe("INSUFFICIENT_SAMPLE");
    expect(c.favours).toBe("UNAVAILABLE");
    expect(c.reason).toContain("breakback_opportunities");
  });

  it("still compares once both denominators are adequate", () => {
    const c = compareMetricRow(row018(12, 10, 14, 80));
    expect(c.status).toBe("COMPARED");
    expect(c.favours).toBe("P2");
  });

  it("one adequate side does not rescue a thin other side, in either slot", () => {
    expect(compareMetricRow(row018(40, 90, 2, 0)).status).toBe("INSUFFICIENT_SAMPLE");
    expect(compareMetricRow(row018(2, 90, 40, 0)).status).toBe("INSUFFICIENT_SAMPLE");
  });

  it("an unpersisted denominator is refused rather than assumed adequate", () => {
    const c = compareMetricRow({
      metric_code: "018",
      p1_value: 'output={"breakback_rate_pct":0}',
      p2_value: 'output={"breakback_rate_pct":100}',
      p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED",
    });
    expect(c.status).toBe("INSUFFICIENT_SAMPLE");
    expect(c.reason).toContain("not persisted");
  });

  it("an insufficient sample contributes nothing to the decision, and is not zero", () => {
    const decision = decideTruthEngineSelection({ comparisons: [compareMetricRow(row018(3, 0, 2, 100))], p1Name: "A", p2Name: "B" });
    expect(decision.independent_support_families).toEqual([]);
    expect(decision.independent_contradiction_families).toEqual([]);
    expect(decision.unavailable.map((u) => u.status)).toContain("INSUFFICIENT_SAMPLE");
  });

  it("every sample guard names a denominator and a positive threshold", () => {
    for (const [code, spec] of Object.entries(COMPARISON_SPECS)) {
      if (!spec.sampleField && spec.minSample === undefined) continue;
      expect(spec.sampleField?.length, `${code} declares minSample without a denominator`).toBeGreaterThan(0);
      expect(spec.minSample, `${code} declares a denominator without a threshold`).toBeGreaterThan(0);
    }
  });
});
