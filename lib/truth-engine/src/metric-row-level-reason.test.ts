// ----------------------------------------------------------------------------
// The row-level unavailability summary must never contradict the per-side evidence.
//
// A real run surfaced metrics 001 and 010 persisted DIRECT/DIRECT, status COMPLETE, both
// per-side reasons NULL -- and a row-level unavailable_reason of
// PRODUCER_FAILED_WITHOUT_REASON. The two sides are written by two different stages, and the
// summary was left as whichever pass wrote last computed it, never recomputed once the
// second side settled. The denominator reads the per-side columns so no decision was wrong,
// but the metrics screen told a person a fully-evidenced metric had failed.
// ----------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { reconcileRowLevelUnavailability } from "./audit-pipeline";

const row = (over: Record<string, unknown> = {}) => ({
  p1_treatment: "UNAVAILABLE", p1_value: null, p1_unavailable_reason: "PRODUCER_FAILED_WITHOUT_REASON",
  p2_treatment: "UNAVAILABLE", p2_value: null, p2_unavailable_reason: "PRODUCER_FAILED_WITHOUT_REASON",
  unavailable_reason: "PRODUCER_FAILED_WITHOUT_REASON",
  ...over,
});

describe("row-level unavailability never contradicts the per-side evidence", () => {
  it("clears the summary when the second side settles usable -- the observed defect", () => {
    // Pass 1 left p1 DIRECT and a stale row-level failure; pass 2 now settles p2 DIRECT.
    const existing = row({ p1_treatment: "DIRECT", p1_value: "surface_elo=1782.14", p1_unavailable_reason: null });
    const patch = reconcileRowLevelUnavailability(
      { p2_treatment: "DIRECT", p2_value: "surface_elo=1526.09", p2_unavailable_reason: null },
      existing,
    );
    expect(patch["unavailable_reason"]).toBeNull();
    expect(patch["unavailable_detail"]).toBeNull();
  });

  it("reports the missing side's own reason when only one side is evidenced", () => {
    const patch = reconcileRowLevelUnavailability(
      { p2_treatment: "UNAVAILABLE", p2_value: null, p2_unavailable_reason: "PROVIDER_TIMEOUT" },
      row({ p1_treatment: "DIRECT", p1_value: "x=1", p1_unavailable_reason: null }),
    );
    // Not MISSING_REQUIRED_INPUT: only one side is missing anything, and this is its reason.
    expect(patch["unavailable_reason"]).toBe("PROVIDER_TIMEOUT");
  });

  it("keeps a shared reason when neither side is evidenced", () => {
    const patch = reconcileRowLevelUnavailability({}, row({
      p1_unavailable_reason: "SOURCE_EMPTY", p2_unavailable_reason: "SOURCE_EMPTY",
    }));
    expect(patch["unavailable_reason"]).toBe("SOURCE_EMPTY");
  });

  it("keeps the disagreement convention when the two sides give different reasons", () => {
    const patch = reconcileRowLevelUnavailability({}, row({
      p1_unavailable_reason: "PROVIDER_TIMEOUT", p2_unavailable_reason: "SOURCE_EMPTY",
    }));
    expect(patch["unavailable_reason"]).toBe("MISSING_REQUIRED_INPUT");
  });

  it("reads the side from the patch when present and the row when not", () => {
    // The patch is authoritative for the side being written; the row for the settled side.
    const patch = reconcileRowLevelUnavailability(
      { p1_treatment: "DIRECT", p1_value: "x=1", p1_unavailable_reason: null },
      row({ p2_treatment: "DIRECT", p2_value: "y=2", p2_unavailable_reason: null }),
    );
    expect(patch["unavailable_reason"]).toBeNull();
  });

  it("a PARTIAL side is not treated as evidenced at row level", () => {
    // PARTIAL means a required input was missing; it must not read as full evidence here.
    const patch = reconcileRowLevelUnavailability({}, row({
      p1_treatment: "PARTIAL", p1_value: "x=1", p1_unavailable_reason: "MISSING_REQUIRED_INPUT",
      p2_treatment: "DIRECT", p2_value: "y=2", p2_unavailable_reason: null,
    }));
    expect(patch["unavailable_reason"]).toBe("MISSING_REQUIRED_INPUT");
  });

  it("an empty-string value is not evidence", () => {
    const patch = reconcileRowLevelUnavailability({}, row({
      p1_treatment: "DIRECT", p1_value: "   ", p1_unavailable_reason: "NO_SOURCE_FOUND",
      p2_treatment: "DIRECT", p2_value: "y=2", p2_unavailable_reason: null,
    }));
    expect(patch["unavailable_reason"]).toBe("NO_SOURCE_FOUND");
  });
});
