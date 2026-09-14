import { describe, expect, it } from "vitest";
import { describeFailure, failureSignature, isStuck } from "./audit-drive";

describe("failureSignature", () => {
  it("is null for a completed run", () => {
    expect(failureSignature({ complete: true, nextStage: null, failures: [] })).toBeNull();
  });

  it("is null when there's no failure yet (still legitimately in progress)", () => {
    expect(failureSignature({ complete: false, nextStage: "P1 METRIC EXECUTION", failures: [] })).toBeNull();
  });

  it("identifies the failing stage and message when a failure is reported", () => {
    const sig = failureSignature({
      complete: false,
      nextStage: "DEFINITION INSTANTIATION",
      failures: [{ stage: "DEFINITION INSTANTIATION", message: "No active rule document version for: METRICS." }],
    });
    expect(sig).toBe("DEFINITION INSTANTIATION|No active rule document version for: METRICS.");
  });
});

describe("isStuck", () => {
  it("is false on the first attempt (nothing to compare against)", () => {
    expect(isStuck(undefined, "DEFINITION INSTANTIATION|missing defs")).toBe(false);
  });

  it("is false when the current slice made real progress (no failure)", () => {
    expect(isStuck("DEFINITION INSTANTIATION|missing defs", null)).toBe(false);
  });

  it("is false when the failure changed stage or message (still moving, even if failing)", () => {
    expect(isStuck("DEFINITION INSTANTIATION|missing defs", "P1 METRIC EXECUTION|different error")).toBe(false);
  });

  it("is true when the exact same stage+message repeats on the next slice", () => {
    const sig = "DEFINITION INSTANTIATION|No active rule document version for: METRICS.";
    expect(isStuck(sig, sig)).toBe(true);
  });
});

describe("describeFailure", () => {
  it("names the failing stage and reason", () => {
    const message = describeFailure({
      complete: false,
      nextStage: "DEFINITION INSTANTIATION",
      failures: [{ stage: "DEFINITION INSTANTIATION", message: "No active rule document version for: METRICS." }],
    });
    expect(message).toBe("DEFINITION INSTANTIATION: No active rule document version for: METRICS.");
  });

  it("falls back gracefully when there is no failure detail", () => {
    expect(describeFailure({ complete: false, nextStage: "P1 METRIC EXECUTION", failures: [] })).toMatch(/unknown reason/);
  });
});
