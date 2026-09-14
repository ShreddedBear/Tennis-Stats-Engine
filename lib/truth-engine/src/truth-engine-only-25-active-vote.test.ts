import { describe, expect, it } from "vitest";
import { COMPARISON_SPECS, compareMetricRows, type MetricRowForComparison } from "./truth-engine-metric-comparison";
import { ACTIVE_METRIC_CODES } from "./truth-engine-active-metrics";
import { decideTruthEngineSelection } from "./truth-engine-decision";

// Required by Task E (section 29/30): a direct, code-verified proof -- not an audit claim --
// that the 25 active COMPARISON_SPECS codes are the ONLY metric codes the Truth Engine
// decision can ever act on, and that a row for any of the 56 inactive codes can never enter
// as voting evidence, no matter how "usable" its own treatment/value looks.
describe("Truth Engine decision: only the 25 active codes can ever vote", () => {
  it("ACTIVE_METRIC_CODES is exactly Object.keys(COMPARISON_SPECS), 25 codes", () => {
    expect(ACTIVE_METRIC_CODES).toEqual([...Object.keys(COMPARISON_SPECS)].sort());
    expect(ACTIVE_METRIC_CODES).toHaveLength(25);
  });

  it("a row for a code outside COMPARISON_SPECS is always NO_COMPARISON_SPEC, however usable its own value looks", () => {
    // "099" is deliberately outside the real 001-081 catalog and outside COMPARISON_SPECS.
    const inactiveCode = "099";
    expect(ACTIVE_METRIC_CODES.includes(inactiveCode)).toBe(false);
    const row: MetricRowForComparison = {
      metric_code: inactiveCode,
      p1_value: "some_field=90", p2_value: "some_field=10",
      p1_treatment: "DIRECT", p2_treatment: "DIRECT",
    };
    const [comparison] = compareMetricRows([row]);
    expect(comparison.status).toBe("NO_COMPARISON_SPEC");
  });

  it("decideTruthEngineSelection never counts an inactive code's comparison as a directional family, even when its own status claims COMPARED", () => {
    // Real active evidence: only code 001 (Surface Elo) genuinely favours P1.
    const activeRow: MetricRowForComparison = {
      metric_code: "001", p1_value: "1600", p2_value: "1400", p1_treatment: "DIRECT", p2_treatment: "DIRECT",
    };
    const [activeComparison] = compareMetricRows([activeRow]);
    expect(activeComparison.status).toBe("COMPARED");

    // A forged "COMPARED" comparison for an inactive code, favouring P2 -- constructed
    // directly (not through compareMetricRow, which structurally can never produce this for
    // a spec-less code) to prove decideTruthEngineSelection's OWN filtering is what keeps
    // inactive evidence out, not merely that compareMetricRow declines to make it.
    const forgedInactiveComparison = {
      metric_code: "099", label: "Forged Inactive Metric", family: "FORGED_FAMILY",
      status: "COMPARED" as const, favours: "P2" as const,
      p1_number: 10, p2_number: 90, differential: -80, advantage_p1: -80,
      direction: "HIGHER_IS_BETTER" as const, reason: "forged",
    };

    const decision = decideTruthEngineSelection({
      comparisons: [activeComparison, forgedInactiveComparison],
      p1Name: "Player One", p2Name: "Player Two",
    });

    // Only the real code-001 family (SURFACE_STRENGTH) may appear as support/contradiction.
    expect(decision.independent_support_families).not.toContain("FORGED_FAMILY");
    expect(decision.independent_contradiction_families).not.toContain("FORGED_FAMILY");
    expect([...decision.independent_support_families, ...decision.independent_contradiction_families]).toEqual(["SURFACE_STRENGTH"]);
  });
});
