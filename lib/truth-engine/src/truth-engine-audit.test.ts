import { describe, expect, it } from "vitest";
import { compareMetricRows, type MetricRowForComparison } from "./truth-engine-metric-comparison";
import { runTruthEngineAudit, runVerificationAudit, runDisagreementAudit, runUnderdogAnalysis, runStressTest, magnitudeRatio } from "./truth-engine-audit";
import { MATRIX_SUMMARY_REQUIRED_CODES } from "./metric-classification";

const P1 = "Alpha Player";
const P2 = "Beta Player";

function row(metric_code: string, p1_value: string | null, p2_value: string | null, treatments: [string, string] = ["RECONSTRUCTED", "RECONSTRUCTED"]): MetricRowForComparison {
  return { metric_code, p1_value, p2_value, p1_treatment: treatments[0], p2_treatment: treatments[1] };
}
function audit(rows: MetricRowForComparison[], p1 = P1, p2 = P2) {
  return runTruthEngineAudit(compareMetricRows(rows), p1, p2);
}

// P1 dominant across three independent families.
const P1_DOMINANT = [
  row("001", "1900", "1500"),
  row("005", "last10_win_pct=80", "last10_win_pct=30"),
  row("027", "lead_protection_rate_pct=90", "lead_protection_rate_pct=40"),
];
// Exact mirror.
const P2_DOMINANT = [
  row("001", "1500", "1900"),
  row("005", "last10_win_pct=30", "last10_win_pct=80"),
  row("027", "lead_protection_rate_pct=40", "lead_protection_rate_pct=90"),
];

describe("TEST 1/2/13 — winner is derived, symmetric, and never structurally P1-biased", () => {
  it("Test 1: P1 clearly superior -> audit winner P1", () => {
    const a = audit(P1_DOMINANT);
    expect(a.audit_winner).toBe(P1);
    expect(a.audit_winner_side).toBe("P1");
    expect(a.refused).toBe(false);
  });

  it("Test 2: P2 clearly superior -> audit winner P2", () => {
    const a = audit(P2_DOMINANT);
    expect(a.audit_winner).toBe(P2);
    expect(a.audit_winner_side).toBe("P2");
  });

  it("Test 13: swapping the two players swaps every layer's verdict exactly", () => {
    const forward = audit(P1_DOMINANT);
    const swapped = audit(P2_DOMINANT);
    expect(forward.audit_winner_side).toBe("P1");
    expect(swapped.audit_winner_side).toBe("P2");
    // Verification mirrors.
    expect(forward.verification.supports_p1_families.sort()).toEqual(swapped.verification.supports_p2_families.sort());
    expect(forward.verification.supports_p2_families).toEqual(swapped.verification.supports_p1_families);
    // Structure is identical in magnitude -- only the side changes.
    expect(forward.independent_evidence_families).toBe(swapped.independent_evidence_families);
    expect(forward.evidence_strength).toBe(swapped.evidence_strength);
    expect(forward.stress.stability).toBe(swapped.stress.stability);
  });
});

describe("TEST 3/16 — close matches and insufficient evidence are refused, not forced", () => {
  it("Test 3: a genuinely close match yields no artificial advantage", () => {
    const a = audit([row("001", "1602", "1600"), row("005", "last10_win_pct=52", "last10_win_pct=50")]);
    expect(a.refused).toBe(true);
    expect(a.audit_winner).toBeNull();
    expect(a.evidence_strength).toBe("NONE");
  });

  it("Test 16: no comparable evidence at all -> explicit refusal with a reason", () => {
    const a = audit([row("999", "x", "y")]);
    expect(a.refused).toBe(true);
    expect(a.final_reason).toMatch(/Refused/);
  });
});

describe("TEST 4/5/14 — missing evidence is UNAVAILABLE, never zero, never a walkover", () => {
  it("Test 4: P1 evidence missing -> unavailable, no P2 walkover", () => {
    const a = audit([row("001", null, "1500"), row("005", null, "last10_win_pct=70"), row("027", null, "lead_protection_rate_pct=80")]);
    expect(a.refused).toBe(true);
    expect(a.verification.unavailable_metrics).toHaveLength(3);
    expect(a.verification.supports_p2_families).toEqual([]);
  });

  it("Test 5: P2 evidence missing -> unavailable, no P1 walkover", () => {
    const a = audit([row("001", "1900", null), row("005", "last10_win_pct=80", null), row("027", "lead_protection_rate_pct=90", null)]);
    expect(a.refused).toBe(true);
    expect(a.verification.supports_p1_families).toEqual([]);
  });

  it("Test 14: an UNAVAILABLE metric changes nothing about the winner", () => {
    const withoutIt = audit(P1_DOMINANT);
    const withIt = audit([...P1_DOMINANT, row("031", "opponent_adjusted_set_differential=5", "opponent_adjusted_set_differential=-5", ["UNAVAILABLE", "UNAVAILABLE"])]);
    expect(withIt.audit_winner).toBe(withoutIt.audit_winner);
    expect(withIt.independent_evidence_families).toBe(withoutIt.independent_evidence_families);
  });
});

describe("TEST 6/7 — the Disagreement Audit recognises contradictions on either side", () => {
  it("Test 6: a strong contradiction against P1's selection is identified with evidence and severity", () => {
    const a = audit([...P1_DOMINANT, row("051", "shrunk_win_probability_pct=10", "shrunk_win_probability_pct=90")]);
    expect(a.audit_winner_side).toBe("P1");
    expect(a.disagreement.challenged_side).toBe("P1");
    expect(a.disagreement.contradiction_families.map((f) => f.family)).toEqual(["H2H_PROBABILITY"]);
    // Severity is derived from measured magnitude (80pp / 3pp noise floor ~= 26x), not asserted.
    expect(a.disagreement.contradiction_families[0]!.severity).toBe("CRITICAL");
    expect(a.disagreement.contradiction_families[0]!.evidence).toMatch(/noise floor/);
    expect(a.disagreement.p2_risk).toMatch(/favour this player/);
  });

  it("Test 7: the mirror -- a strong contradiction against P2's selection", () => {
    const a = audit([...P2_DOMINANT, row("051", "shrunk_win_probability_pct=90", "shrunk_win_probability_pct=10")]);
    expect(a.audit_winner_side).toBe("P2");
    expect(a.disagreement.challenged_side).toBe("P2");
    expect(a.disagreement.contradiction_families.map((f) => f.family)).toEqual(["H2H_PROBABILITY"]);
    expect(a.disagreement.p1_risk).toMatch(/favour this player/);
  });

  it("severity escalates with INDEPENDENT contradiction breadth, not with correlated repetition", () => {
    const oneFamily = audit([...P1_DOMINANT, row("051", "shrunk_win_probability_pct=44", "shrunk_win_probability_pct=56")]);
    const twoFamilies = audit([
      row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30"), row("027", "lead_protection_rate_pct=90", "lead_protection_rate_pct=40"),
      row("051", "shrunk_win_probability_pct=44", "shrunk_win_probability_pct=56"),
      row("031", "opponent_adjusted_set_differential=-0.4", "opponent_adjusted_set_differential=0.4"),
    ]);
    expect(twoFamilies.disagreement.contradiction_families).toHaveLength(2);
    // Two independent contradictions outrank one of the same measured depth.
    const order = ["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"];
    expect(order.indexOf(twoFamilies.disagreement.overall_severity)).toBeGreaterThan(order.indexOf(oneFamily.disagreement.overall_severity));
  });

  it("correlated contradictions inside one family are counted once, with the duplicate reported", () => {
    const a = audit([
      row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30"), row("027", "lead_protection_rate_pct=90", "lead_protection_rate_pct=40"),
      // 031 and 080 are both COMMON_OPPONENT and both oppose P1.
      row("031", "opponent_adjusted_set_differential=-1", "opponent_adjusted_set_differential=1"),
      row("080", "favorable_divergent_outcomes=10; unfavorable_divergent_outcomes=20", "favorable_divergent_outcomes=20; unfavorable_divergent_outcomes=10"),
    ]);
    expect(a.disagreement.contradiction_families).toHaveLength(1);
    expect(a.disagreement.contradiction_families[0]!.family).toBe("COMMON_OPPONENT");
    expect(a.disagreement.duplicated_contradiction_metrics).toContain("080");
  });
});

describe("TEST 8/9 — Underdog pathways are evidence-derived, never theoretical", () => {
  it("Test 8: no family favours the underdog -> NO VIABLE PATHWAY (no narrative)", () => {
    const a = audit(P1_DOMINANT);
    expect(a.underdog.underdog_player).toBe(P2);
    expect(a.underdog.pathways).toEqual([]);
    expect(a.underdog.overall_viability).toBe("NO_VIABLE_PATHWAY");
    expect(a.underdog.reason).toMatch(/No independent evidence family measurably favours/);
  });

  it("Test 9: a measured underdog edge produces a real, typed, evidence-backed pathway", () => {
    const a = audit([...P1_DOMINANT, row("051", "shrunk_win_probability_pct=10", "shrunk_win_probability_pct=90")]);
    expect(a.underdog.underdog_player).toBe(P2);
    expect(a.underdog.pathways).toHaveLength(1);
    const pathway = a.underdog.pathways[0]!;
    expect(pathway.pathway_type).toBe("MATCHUP_TACTICAL_ADVANTAGE");
    expect(pathway.family).toBe("H2H_PROBABILITY");
    expect(pathway.viability).toBe("STRONG_PATHWAY");
    expect(pathway.supporting_metrics).toEqual(["051"]);
    expect(pathway.evidence).toMatch(/noise floor/);
    expect(pathway.magnitude_ratio).toBeGreaterThan(4);
  });

  it("an immaterial edge is NOT promoted to a pathway", () => {
    // 2pp on a 3pp noise floor -> below materiality -> NEUTRAL -> no pathway at all.
    const a = audit([...P1_DOMINANT, row("051", "shrunk_win_probability_pct=49", "shrunk_win_probability_pct=51")]);
    expect(a.underdog.pathways).toEqual([]);
    expect(a.underdog.overall_viability).toBe("NO_VIABLE_PATHWAY");
  });

  it("two independent underdog pathways promote overall viability above the strongest single one", () => {
    const a = audit([
      row("001", "1900", "1500"), row("005", "last10_win_pct=80", "last10_win_pct=30"), row("027", "lead_protection_rate_pct=90", "lead_protection_rate_pct=40"),
      row("051", "shrunk_win_probability_pct=44", "shrunk_win_probability_pct=56"), // ~4x -> VIABLE
      row("031", "opponent_adjusted_set_differential=-0.25", "opponent_adjusted_set_differential=0.25"), // ~3.3x -> VIABLE
    ]);
    expect(a.underdog.pathways).toHaveLength(2);
    expect(a.underdog.overall_viability).toBe("STRONG_PATHWAY");
  });
});

describe("TEST 10/11 — the Stress Test genuinely recomputes winner_after", () => {
  it("Test 11: a broad lead survives adverse erosion -> winner_after unchanged", () => {
    const a = audit(P1_DOMINANT);
    expect(a.stress.winner_before).toBe("P1");
    expect(a.stress.winner_after).toBe("P1");
    expect(a.stress.changed).toBe(false);
    expect(a.stress.cases.map((c) => c.case_name)).toEqual(["BASE", "ADVERSE", "FAVOURABLE"]);
    expect(a.audit_winner).toBe(P1);
  });

  it("Test 10: a thin lead collapses under adverse erosion -> winner_after changes and the audit refuses", () => {
    // Each edge is only ~1.4x its noise floor, so one noise-floor erosion removes them all.
    const a = audit([
      row("001", "1514", "1500"), // 14 vs materiality 10
      row("005", "last10_win_pct=57", "last10_win_pct=50"), // 7 vs 5
      row("027", "lead_protection_rate_pct=57", "lead_protection_rate_pct=50"), // 7 vs 5
    ]);
    expect(a.stress.winner_before).toBe("P1");
    expect(a.stress.winner_after).not.toBe("P1");
    expect(a.stress.changed).toBe(true);
    // A selection that does not survive its own stress test is refused, not asserted.
    expect(a.refused).toBe(true);
    expect(a.audit_winner).toBeNull();
    expect(a.final_reason).toMatch(/Refused/);
  });

  it("the ADVERSE case is a real recomputation, not a relabel: its family counts genuinely differ", () => {
    const a = audit([row("001", "1514", "1500"), row("005", "last10_win_pct=57", "last10_win_pct=50"), row("027", "lead_protection_rate_pct=57", "lead_protection_rate_pct=50")]);
    const base = a.stress.cases.find((c) => c.case_name === "BASE")!;
    const adverse = a.stress.cases.find((c) => c.case_name === "ADVERSE")!;
    expect(base.support_families).toBeGreaterThan(adverse.support_families);
  });

  it("stress assumptions are derived from each metric's own declared noise floor", () => {
    const comparisons = compareMetricRows([row("001", "1900", "1500")]);
    expect(magnitudeRatio(comparisons[0]!)).toBeCloseTo(40, 0); // 400 / materiality 10
  });
});

describe("TEST 12 — correlated metrics are one evidence family, not multiple votes", () => {
  it("031 + 080 agreeing count once toward support", () => {
    const a = audit([
      row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"),
      row("080", "favorable_divergent_outcomes=25; unfavorable_divergent_outcomes=15", "favorable_divergent_outcomes=15; unfavorable_divergent_outcomes=25"),
      row("001", "1900", "1500"),
      row("005", "last10_win_pct=80", "last10_win_pct=30"),
    ]);
    expect(a.decision.independent_support_families.sort()).toEqual(["COMMON_OPPONENT", "RECENT_FORM", "SURFACE_STRENGTH"]);
    expect(a.independent_evidence_families).toBe(3); // not 4
    expect(a.verification.findings.find((f) => f.family === "COMMON_OPPONENT")!.metrics).toHaveLength(2);
  });
});

describe("TEST 15 — quarantined Matrix-Summary metrics cannot enter the audit", () => {
  it("a quarantined code carrying legacy values is excluded from every layer", () => {
    const a = audit([...P1_DOMINANT, row("035", "observed_vs_expected_wl_gap_pct=90", "observed_vs_expected_wl_gap_pct=-90", ["PARTIAL", "PARTIAL"])]);
    expect(a.verification.unavailable_metrics.some((u) => u.metric_code === "035")).toBe(true);
    expect(a.verification.findings.some((f) => f.metrics.some((m) => m.metric_code === "035"))).toBe(false);
    expect(a.disagreement.contradiction_families.some((f) => f.metrics.includes("035"))).toBe(false);
    expect(a.underdog.pathways.some((p) => p.supporting_metrics.includes("035"))).toBe(false);
    expect(a.audit_winner).toBe(P1); // unchanged by the quarantined row
  });

  it("no quarantined code appears in any pathway or contradiction across the whole registry", () => {
    for (const code of MATRIX_SUMMARY_REQUIRED_CODES) {
      const a = audit([...P1_DOMINANT, row(code, "x=100", "x=-100", ["PARTIAL", "PARTIAL"])]);
      expect(a.verification.findings.some((f) => f.metrics.some((m) => m.metric_code === code))).toBe(false);
    }
  });
});

describe("verification symmetry and independence", () => {
  it("computes BOTH sides' findings from their own numbers, not by inverting one", () => {
    const v = runVerificationAudit(compareMetricRows(P1_DOMINANT), P1, P2);
    const surface = v.findings.find((f) => f.family === "SURFACE_STRENGTH")!;
    expect(surface.p1_finding).toContain("1900");
    expect(surface.p2_finding).toContain("1500");
    expect(surface.outcome).toBe("SUPPORTS_P1");
    expect(surface.severity).toBe("CRITICAL"); // 400 / 10 = 40x noise floor
  });

  it("a family whose own metrics disagree is INSUFFICIENT_EVIDENCE, crediting neither side", () => {
    const v = runVerificationAudit(
      compareMetricRows([
        row("031", "opponent_adjusted_set_differential=1.5", "opponent_adjusted_set_differential=-1.5"),
        row("080", "favorable_divergent_outcomes=10; unfavorable_divergent_outcomes=25", "favorable_divergent_outcomes=25; unfavorable_divergent_outcomes=10"),
      ]),
      P1, P2,
    );
    const family = v.findings.find((f) => f.family === "COMMON_OPPONENT")!;
    expect(family.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(v.supports_p1_families).toEqual([]);
    expect(v.supports_p2_families).toEqual([]);
  });

  it("layers agree with each other: no selection means nothing to challenge and no underdog", () => {
    const comparisons = compareMetricRows([row("001", "1602", "1600")]);
    expect(runDisagreementAudit(comparisons, null, P1, P2).final_effect).toMatch(/No selection/);
    expect(runUnderdogAnalysis(comparisons, null, P1, P2).overall_viability).toBe("NO_VIABLE_PATHWAY");
    expect(runStressTest(comparisons, P1, P2).stability).toBe("NOT_APPLICABLE");
  });
});

describe("final audit output shape", () => {
  it("produces a complete, inspectable evidence chain ending in the winner", () => {
    const a = audit([...P1_DOMINANT, row("051", "shrunk_win_probability_pct=10", "shrunk_win_probability_pct=90")]);
    expect(a.audit_winner).toBe(P1);
    expect(a.evidence_strength).toBe("MODERATE");
    expect(a.leave_one_family_out_winner).toBe("P1");
    expect(a.contradiction_families).toBe(1);
    expect(a.evidence_chain.join("\n")).toMatch(/VERIFICATION/);
    expect(a.evidence_chain.join("\n")).toMatch(/DISAGREEMENT/);
    expect(a.evidence_chain.join("\n")).toMatch(/UNDERDOG/);
    expect(a.evidence_chain.join("\n")).toMatch(/STRESS/);
    expect(a.evidence_chain.join("\n")).toMatch(/LEAVE-ONE-FAMILY-OUT/);
  });
});
