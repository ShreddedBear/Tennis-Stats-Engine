import { describe, expect, it } from "vitest";
import { classifySideActivation, classifyMetricActivation, DENOMINATOR_EXCUSED_STATUSES } from "./metric-activation-status";

describe("classifySideActivation", () => {
  it("ACTIVATED requires both a usable treatment and a real value", () => {
    expect(classifySideActivation({ executed: true, treatment: "DIRECT", value: "1521.75" })).toBe("ACTIVATED");
    expect(classifySideActivation({ executed: true, treatment: "PARTIAL", value: "last10_win_pct=50" })).toBe("ACTIVATED");
    expect(classifySideActivation({ executed: true, treatment: "RECONSTRUCTED", value: "x=1" })).toBe("ACTIVATED");
  });

  it("a usable-looking treatment with no real value behind it is never ACTIVATED", () => {
    expect(classifySideActivation({ executed: true, treatment: "DIRECT", value: "   " })).not.toBe("ACTIVATED");
    expect(classifySideActivation({ executed: true, treatment: "DIRECT", value: null })).not.toBe("ACTIVATED");
  });

  it("no row at all is NOT_ATTEMPTED -- a pipeline gap, never confused with genuine unavailability", () => {
    expect(classifySideActivation({ executed: false })).toBe("NOT_ATTEMPTED");
  });

  it("maps each persisted UnavailableReason to its named taxonomy entry", () => {
    const cases: Array<[string, string]> = [
      ["PLAYER_NOT_FOUND", "IDENTITY_MISMATCH"],
      ["MATCH_NOT_FOUND", "CONTEXT_MISMATCH"],
      ["SURFACE_DATA_NOT_FOUND", "CONTEXT_MISMATCH"],
      ["PARSING_FAILED", "PARSE_FAILURE"],
      ["MISSING_REQUIRED_INPUT", "PRODUCER_FAILURE"],
      ["SOURCE_CONFLICT", "PRODUCER_FAILURE"],
      ["RECONSTRUCTION_FAILED", "PRODUCER_FAILURE"],
      ["PROVIDER_AUTH_FAILED", "PRODUCER_FAILURE"],
      ["INSUFFICIENT_SAMPLE", "INSUFFICIENT_SAMPLE"],
      ["NO_SOURCE_FOUND", "SOURCE_EMPTY"],
      ["HISTORICAL_DATA_UNAVAILABLE", "GENUINELY_UNAVAILABLE"],
    ];
    for (const [reason, expected] of cases) {
      expect(classifySideActivation({ executed: true, treatment: "UNAVAILABLE", value: null, reason }), reason).toBe(expected);
    }
  });

  it("a transient/technical reason is RETRYING mid-audit and PRODUCER_FAILURE once retries are exhausted -- never GENUINELY_UNAVAILABLE", () => {
    for (const reason of ["PROVIDER_TIMEOUT", "API_RATE_LIMIT"]) {
      expect(classifySideActivation({ executed: true, treatment: "UNAVAILABLE", value: null, reason }), reason).toBe("RETRYING");
      expect(classifySideActivation({ executed: true, treatment: "UNAVAILABLE", value: null, reason, retriesExhausted: true }), reason).toBe("PRODUCER_FAILURE");
    }
  });

  it("an unrecognised or missing reason is treated as a producer defect, never silently excused", () => {
    expect(classifySideActivation({ executed: true, treatment: "UNAVAILABLE", value: null, reason: null })).toBe("PRODUCER_FAILURE");
    expect(classifySideActivation({ executed: true, treatment: "UNAVAILABLE", value: null, reason: "SOMETHING_NEW" })).toBe("PRODUCER_FAILURE");
  });
});

describe("classifyMetricActivation", () => {
  it("both sides ACTIVATED -> activated=true, counts toward the denominator", () => {
    const r = classifyMetricActivation("001",
      { executed: true, treatment: "DIRECT", value: "1600" },
      { executed: true, treatment: "DIRECT", value: "1400" },
    );
    expect(r.activated).toBe(true);
    expect(r.countsTowardDenominator).toBe(true);
  });

  it("both sides excused (e.g. genuinely no PBP data for either player) is excluded from the denominator", () => {
    const r = classifyMetricActivation("009",
      { executed: true, treatment: "UNAVAILABLE", value: null, reason: "NO_SOURCE_FOUND" },
      { executed: true, treatment: "UNAVAILABLE", value: null, reason: "HISTORICAL_DATA_UNAVAILABLE" },
    );
    expect(r.activated).toBe(false);
    expect(r.countsTowardDenominator).toBe(false);
  });

  it("one side excused but the other shows a real bug keeps the metric IN the denominator as a miss", () => {
    // P1 genuinely has no data; P2's own identity resolution failed -- a real, fixable defect.
    const r = classifyMetricActivation("055",
      { executed: true, treatment: "UNAVAILABLE", value: null, reason: "NO_SOURCE_FOUND" },
      { executed: true, treatment: "UNAVAILABLE", value: null, reason: "PLAYER_NOT_FOUND" },
    );
    expect(r.countsTowardDenominator).toBe(true);
    expect(r.p2).toBe("IDENTITY_MISMATCH");
  });

  it("a metric never attempted for either side always counts toward the denominator -- never excused", () => {
    const r = classifyMetricActivation("041", { executed: false }, { executed: false });
    expect(r.countsTowardDenominator).toBe(true);
    expect(r.p1).toBe("NOT_ATTEMPTED");
    expect(r.p2).toBe("NOT_ATTEMPTED");
  });

  it("DENOMINATOR_EXCUSED_STATUSES is exactly the three evidence-based absence statuses", () => {
    expect([...DENOMINATOR_EXCUSED_STATUSES].sort()).toEqual(["GENUINELY_UNAVAILABLE", "INSUFFICIENT_SAMPLE", "SOURCE_EMPTY"]);
  });
});
