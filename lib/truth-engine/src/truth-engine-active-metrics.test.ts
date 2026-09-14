import { describe, expect, it } from "vitest";
import { ACTIVE_METRIC_CODES, activeMetricReadiness, isActiveMetricCode, type MetricRowForReadiness } from "./truth-engine-active-metrics";
import { COMPARISON_SPECS } from "./truth-engine-metric-comparison";
import { MATRIX_SUMMARY_REQUIRED_CODES } from "./metric-classification";

// The audit UI reported "P1 METRIC EXECUTION 51/81", which conflated two different things:
// how many rows the PROCESSOR had treated (throughput, and a row counts as treated even
// when it ends UNAVAILABLE) with how many graded metrics actually produced usable evidence
// (readiness). These tests pin the separation and, above all, pin that the denominator is
// DERIVED rather than typed.

const APPROVED_ACTIVE_SET = [
  "001", "002", "003", "005", "006", "007", "008", "009", "010", "011",
  "016", "018", "027", "029", "031", "032", "034", "036", "041", "045",
  "051", "053", "055", "068", "080",
];

const usableRow = (code: string): MetricRowForReadiness => ({
  metric_code: code, p1_treatment: "DIRECT", p2_treatment: "DIRECT", p1_value: "x=1", p2_value: "x=2",
});

describe("the active registry is derived, not declared", () => {
  it("matches the approved active set exactly", () => {
    expect([...ACTIVE_METRIC_CODES]).toEqual(APPROVED_ACTIVE_SET);
  });

  it("is the key set of COMPARISON_SPECS -- the specs that actually grade a match", () => {
    // The load-bearing property: the denominator cannot drift from the graded set, because
    // it IS the graded set. No separate list to keep in sync.
    expect([...ACTIVE_METRIC_CODES]).toEqual(Object.keys(COMPARISON_SPECS).sort());
  });

  it("recognises active codes and rejects inactive ones", () => {
    expect(isActiveMetricCode("016")).toBe(true);
    expect(isActiveMetricCode("METRIC 016")).toBe(true);
    expect(isActiveMetricCode("062")).toBe(false);   // evaluated, deliberately not activated
    expect(isActiveMetricCode("004")).toBe(false);   // too thin, not activated
  });

  it("contains no quarantined code", () => {
    for (const code of MATRIX_SUMMARY_REQUIRED_CODES) expect(ACTIVE_METRIC_CODES).not.toContain(code);
  });
});

describe("promotion moves the denominator automatically", () => {
  // The requirement: adding one metric to the active registry takes the denominator from
  // 25 to 26 with no other edit. `codes` is injected here purely so the real registry is
  // not mutated -- production callers use the default, which is COMPARISON_SPECS' keys.
  it("25 -> 26 when one metric is promoted, with no constant to update", () => {
    const rows = APPROVED_ACTIVE_SET.map(usableRow);
    const before = activeMetricReadiness(rows);
    expect(before.expected).toBe(ACTIVE_METRIC_CODES.length);

    const after = activeMetricReadiness(rows, [...ACTIVE_METRIC_CODES, "004"]);
    expect(after.expected).toBe(before.expected + 1);
    // The newly promoted metric has no row here, so it is honestly NOT_EXECUTED --
    // promotion widens the denominator, it does not invent a success.
    expect(after.usable).toBe(before.usable);
    expect(after.notExecuted).toBe(1);
  });
});

describe("only genuinely usable two-sided evidence counts", () => {
  it("counts a two-sided usable metric", () => {
    const r = activeMetricReadiness([usableRow("001")], ["001"]);
    expect(r.usable).toBe(1);
    expect(r.percent).toBe(100);
  });

  it("does NOT count one-sided evidence -- it cannot create a lean", () => {
    const r = activeMetricReadiness(
      [{ metric_code: "001", p1_treatment: "DIRECT", p1_value: "x=1", p2_treatment: "UNAVAILABLE", p2_value: null }],
      ["001"],
    );
    expect(r.usable).toBe(0);
    expect(r.oneSided).toBe(1);
  });

  it("does NOT count UNAVAILABLE, NO_SOURCE or EXCLUDED as success", () => {
    for (const treatment of ["UNAVAILABLE", "NO_SOURCE", "EXCLUDED"]) {
      const r = activeMetricReadiness(
        [{ metric_code: "001", p1_treatment: treatment, p2_treatment: treatment, p1_value: null, p2_value: null }],
        ["001"],
      );
      expect(r.usable, treatment).toBe(0);
      expect(r.unavailable, treatment).toBe(1);
    }
  });

  it("does NOT count a usable-looking treatment with no value behind it", () => {
    // A DIRECT treatment with an empty value is not evidence.
    const r = activeMetricReadiness(
      [{ metric_code: "001", p1_treatment: "DIRECT", p1_value: "   ", p2_treatment: "DIRECT", p2_value: "x=2" }],
      ["001"],
    );
    expect(r.usable).toBe(0);
    expect(r.oneSided).toBe(1);
  });

  it("counts an active metric with no row at all as NOT_EXECUTED, never as usable", () => {
    const r = activeMetricReadiness([], ["001", "002"]);
    expect(r.usable).toBe(0);
    expect(r.notExecuted).toBe(2);
    expect(r.percent).toBe(0);
  });

  it("ignores rows for inactive codes entirely -- the other 56 cannot inflate readiness", () => {
    const rows = [usableRow("001"), usableRow("004"), usableRow("062"), usableRow("012")];
    const r = activeMetricReadiness(rows, ["001"]);
    expect(r.expected).toBe(1);
    expect(r.usable).toBe(1);   // not 4
  });

  it("every outcome is accounted for exactly once", () => {
    const r = activeMetricReadiness([
      usableRow("001"),
      { metric_code: "002", p1_treatment: "DIRECT", p1_value: "x", p2_treatment: "UNAVAILABLE", p2_value: null },
      { metric_code: "003", p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE", p1_value: null, p2_value: null },
    ], ["001", "002", "003", "005"]);
    expect(r.usable + r.oneSided + r.unavailable + r.notExecuted).toBe(r.expected);
    expect([r.usable, r.oneSided, r.unavailable, r.notExecuted]).toEqual([1, 1, 1, 1]);
  });
});

describe("readiness reproduces the real live run it was built to explain", () => {
  // Live run 0305bc70 as persisted: of its 25 active rows, 3 DIRECT/DIRECT + 1
  // PARTIAL/PARTIAL + 1 RECONSTRUCTED/RECONSTRUCTED were two-sided, 4 were one-sided
  // (3 PARTIAL/UNAVAILABLE, 1 DIRECT/UNAVAILABLE) and 16 were UNAVAILABLE on both sides.
  // Processing progress for that run read 81/81; active evidence is 5/25.
  it("reports 5/25 where processing progress reported 81/81", () => {
    const rows: MetricRowForReadiness[] = [];
    const codes = [...ACTIVE_METRIC_CODES];
    const take = () => codes.shift()!;
    for (let i = 0; i < 3; i++) rows.push({ metric_code: take(), p1_treatment: "DIRECT", p2_treatment: "DIRECT", p1_value: "v", p2_value: "v" });
    rows.push({ metric_code: take(), p1_treatment: "PARTIAL", p2_treatment: "PARTIAL", p1_value: "v", p2_value: "v" });
    rows.push({ metric_code: take(), p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED", p1_value: "v", p2_value: "v" });
    for (let i = 0; i < 3; i++) rows.push({ metric_code: take(), p1_treatment: "PARTIAL", p2_treatment: "UNAVAILABLE", p1_value: "v", p2_value: null });
    rows.push({ metric_code: take(), p1_treatment: "DIRECT", p2_treatment: "UNAVAILABLE", p1_value: "v", p2_value: null });
    for (const code of codes.slice()) rows.push({ metric_code: code, p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE", p1_value: null, p2_value: null });

    const r = activeMetricReadiness(rows);
    expect(r.expected).toBe(25);
    expect(r.usable).toBe(5);
    expect(r.oneSided).toBe(4);
    expect(r.unavailable).toBe(16);
    expect(r.percent).toBe(20);
  });
});

describe("dynamic per-match denominator (eligible/eligiblePercent)", () => {
  it("a metric genuinely unavailable on both sides (real, evidenced absence) is excused from the denominator", () => {
    const rows: MetricRowForReadiness[] = [
      { metric_code: "001", p1_treatment: "DIRECT", p1_value: "1600", p2_treatment: "DIRECT", p2_value: "1400" },
      // 009 (Pressure point win %): no PBP source exists for either player in this match.
      { metric_code: "009", p1_treatment: "UNAVAILABLE", p1_value: null, p1_unavailable_reason: "NO_SOURCE_FOUND", p2_treatment: "UNAVAILABLE", p2_value: null, p2_unavailable_reason: "HISTORICAL_DATA_UNAVAILABLE" },
    ];
    const r = activeMetricReadiness(rows, ["001", "009"]);
    expect(r.expected).toBe(2);
    expect(r.eligible).toBe(1); // only 001 -- 009 is excused, not merely "unavailable"
    expect(r.usable).toBe(1);
    expect(r.eligiblePercent).toBe(100); // 1/1, not diluted by a metric with no real signal
    expect(r.percent).toBe(50); // the ORIGINAL fixed-25-style number is untouched
  });

  it("insufficient sample on both sides is also excused -- real scarcity, not a bug", () => {
    const rows: MetricRowForReadiness[] = [
      { metric_code: "029", p1_treatment: "UNAVAILABLE", p1_value: null, p1_unavailable_reason: "INSUFFICIENT_SAMPLE", p2_treatment: "UNAVAILABLE", p2_value: null, p2_unavailable_reason: "INSUFFICIENT_SAMPLE" },
    ];
    const r = activeMetricReadiness(rows, ["029"]);
    expect(r.eligible).toBe(0);
    expect(r.eligiblePercent).toBe(0);
  });

  it("a real pipeline bug on even one side keeps the metric IN the denominator as a miss", () => {
    const rows: MetricRowForReadiness[] = [
      // P1 genuinely has no data; P2's identity resolution failed -- a fixable defect, not proof of absence.
      { metric_code: "055", p1_treatment: "UNAVAILABLE", p1_value: null, p1_unavailable_reason: "NO_SOURCE_FOUND", p2_treatment: "UNAVAILABLE", p2_value: null, p2_unavailable_reason: "PLAYER_NOT_FOUND" },
    ];
    const r = activeMetricReadiness(rows, ["055"]);
    expect(r.eligible).toBe(1);
    expect(r.eligiblePercent).toBe(0); // counted, but not usable -- an honest miss, not hidden
  });

  it("a metric never attempted at all always counts toward the denominator, never excused", () => {
    const r = activeMetricReadiness([], ["001", "002"]);
    expect(r.eligible).toBe(2);
    expect(r.eligiblePercent).toBe(0);
  });

  it("byCode carries the full per-side activation classification for the audit trail", () => {
    const rows: MetricRowForReadiness[] = [
      { metric_code: "001", p1_treatment: "DIRECT", p1_value: "1600", p2_treatment: "DIRECT", p2_value: "1400" },
    ];
    const r = activeMetricReadiness(rows, ["001"]);
    expect(r.byCode[0].activation).toMatchObject({ code: "001", p1: "ACTIVATED", p2: "ACTIVATED", activated: true, countsTowardDenominator: true });
  });
});
