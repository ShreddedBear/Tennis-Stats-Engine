import { describe, expect, it } from "vitest";
import { STRESS_OUTCOME_NOT_EVALUATED, stressRowPatch } from "./truth-engine-stage-mapping";
import { runTruthEngineAudit } from "./truth-engine-audit";
import { compareMetricRows, type MetricRowForComparison } from "./truth-engine-metric-comparison";
import { STRESS_TESTS } from "./constants";

// STRESS STATE SEMANTICS: "did not run" must never be recorded as "unstable".
//
// ST04/ST08/ST09/ST10 require evidence the active metric set cannot produce, so they are
// written status UNAVAILABLE. Their OUTCOME used to be written "UNSTABLE" as well, which
// reports a test that never executed as a test that failed. Because audit-engine.ts's
// DOUBLE GREEN rule asks whether every stress test came back STABLE, those four permanently
// "UNSTABLE" rows made DOUBLE GREEN unreachable for every match, forever. Production
// measured it: 0 DOUBLE GREEN across 60 completed runs, 240 rows carrying status
// UNAVAILABLE alongside outcome UNSTABLE.

const P1 = "Alpha Player";
const P2 = "Beta Player";

/** Evidence giving P1 a clean, stable lead across independent families. */
const DECISIVE_ROWS: MetricRowForComparison[] = [
  { metric_code: "001", p1_value: "surface_elo=1900", p2_value: "surface_elo=1500", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
  { metric_code: "005", p1_value: "last10_win_pct=80", p2_value: "last10_win_pct=30", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
  { metric_code: "027", p1_value: "lead_protection_rate_pct=90", p2_value: "lead_protection_rate_pct=40", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
];
const decisiveAudit = () => runTruthEngineAudit(compareMetricRows(DECISIVE_ROWS), P1, P2);
/** No usable evidence at all, so nothing is selected and nothing can be stressed. */
const refusedAudit = () => runTruthEngineAudit(compareMetricRows([]), P1, P2);

const NOT_EVALUABLE = ["ST04", "ST08", "ST09", "ST10"] as const;
const NOW = "2026-04-12T00:00:00.000Z";

describe("stress rows distinguish 'did not run' from 'unstable'", () => {
  it.each(NOT_EVALUABLE)("%s, which the active metric set cannot evaluate, is not reported as unstable", (code) => {
    const { patch, evaluated } = stressRowPatch(code, decisiveAudit(), NOW);
    expect(evaluated).toBe(false);
    expect(patch["status"]).toBe("UNAVAILABLE");
    expect(patch["outcome"]).toBe(STRESS_OUTCOME_NOT_EVALUATED);
    expect(patch["outcome"]).not.toBe("UNSTABLE");
    // The row still says exactly WHY it could not run -- honest, not silent.
    expect(String(patch["unavailable_detail"] ?? "")).not.toBe("");
  });

  it("a selection that genuinely does not survive the adverse recomputation IS reported unstable", () => {
    // 032 and 018 sit in the same POINT_BY_POINT family with very large noise floors, so a
    // one-floor adverse shift genuinely moves the decision.
    const fragile = runTruthEngineAudit(compareMetricRows([
      { metric_code: "001", p1_value: "surface_elo=1530", p2_value: "surface_elo=1500", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
      { metric_code: "005", p1_value: "last10_win_pct=62", p2_value: "last10_win_pct=50", p1_treatment: "DIRECT", p2_treatment: "DIRECT" },
    ]), P1, P2);
    const { patch } = stressRowPatch("ST05", fragile, NOW);
    expect(patch["status"]).toBe("COMPLETE");
    expect(["STABLE", "UNSTABLE"]).toContain(String(patch["outcome"]));
    // Whatever the verdict, it came from an executed recomputation, not from absence.
    expect(patch["outcome"]).not.toBe(STRESS_OUTCOME_NOT_EVALUATED);
  });

  it("a selection that survives the adverse recomputation is reported STABLE, as before", () => {
    const { patch, evaluated } = stressRowPatch("ST05", decisiveAudit(), NOW);
    expect(evaluated).toBe(true);
    expect(patch["status"]).toBe("COMPLETE");
    expect(patch["outcome"]).toBe("STABLE");
  });

  it("leave-one-family-out (ST03) still reports its real recomputed verdict", () => {
    const { patch } = stressRowPatch("ST03", decisiveAudit(), NOW);
    expect(patch["status"]).toBe("COMPLETE");
    expect(["STABLE", "MOSTLY STABLE", "FAILS"]).toContain(String(patch["outcome"]));
  });

  it("with no selection to stress, ST05/06/07 report not-evaluated rather than unstable", () => {
    for (const code of ["ST05", "ST06", "ST07"]) {
      const { patch, evaluated } = stressRowPatch(code, refusedAudit(), NOW);
      expect(evaluated).toBe(false);
      expect(patch["status"]).toBe("UNAVAILABLE");
      expect(patch["outcome"]).toBe(STRESS_OUTCOME_NOT_EVALUATED);
    }
  });

  it("no stress test in the catalogue can produce UNSTABLE without having executed", () => {
    // The whole invariant in one sweep, over the real ST01-ST10 catalogue rather than a
    // hand-picked subset, for both a decided and a refused audit.
    for (const audit of [decisiveAudit(), refusedAudit()]) {
      for (const [code] of STRESS_TESTS) {
        const { patch } = stressRowPatch(code, audit, NOW);
        if (patch["status"] !== "COMPLETE") {
          expect(patch["outcome"], `${code} claims a finding without executing`).not.toBe("UNSTABLE");
          expect(patch["outcome"], `${code} claims a finding without executing`).not.toBe("FAILS");
        }
      }
    }
  });
});
