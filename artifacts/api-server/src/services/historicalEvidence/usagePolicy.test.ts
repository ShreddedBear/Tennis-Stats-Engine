import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isInternalUseEligible,
  isInternalUseEligibleForThisDeployment,
  DEPLOYMENT_USAGE_MODE,
} from "./usagePolicy.js";

describe("usagePolicy — DEPLOYMENT_USAGE_MODE", () => {
  it("is explicitly PRIVATE_NONPAID for the current deployment, per the user's confirmed instruction", () => {
    assert.strictEqual(DEPLOYMENT_USAGE_MODE, "PRIVATE_NONPAID");
  });
});

describe("isInternalUseEligible — PRIVATE_NONPAID mode", () => {
  it("LICENSE_UNCERTAIN is usable (the 4,065 records' actual license status)", () => {
    assert.strictEqual(isInternalUseEligible("LICENSE_UNCERTAIN", "PRIVATE_NONPAID"), true);
  });

  it("NONCOMMERCIAL_ONLY is usable", () => {
    assert.strictEqual(isInternalUseEligible("NONCOMMERCIAL_ONLY", "PRIVATE_NONPAID"), true);
  });

  it("APPROVED_COMMERCIAL is usable", () => {
    assert.strictEqual(isInternalUseEligible("APPROVED_COMMERCIAL", "PRIVATE_NONPAID"), true);
  });

  it("NOT_LICENSED_FOR_USE is NEVER usable, even privately", () => {
    assert.strictEqual(isInternalUseEligible("NOT_LICENSED_FOR_USE", "PRIVATE_NONPAID"), false);
  });
});

describe("isInternalUseEligible — COMMERCIAL_PRODUCTION mode", () => {
  it("only APPROVED_COMMERCIAL is usable", () => {
    assert.strictEqual(isInternalUseEligible("APPROVED_COMMERCIAL", "COMMERCIAL_PRODUCTION"), true);
  });

  it("LICENSE_UNCERTAIN is blocked (matches tennis-truth-engine's existing LICENSE_BLOCKED behavior)", () => {
    assert.strictEqual(isInternalUseEligible("LICENSE_UNCERTAIN", "COMMERCIAL_PRODUCTION"), false);
  });

  it("NONCOMMERCIAL_ONLY is blocked", () => {
    assert.strictEqual(isInternalUseEligible("NONCOMMERCIAL_ONLY", "COMMERCIAL_PRODUCTION"), false);
  });

  it("NOT_LICENSED_FOR_USE is blocked", () => {
    assert.strictEqual(isInternalUseEligible("NOT_LICENSED_FOR_USE", "COMMERCIAL_PRODUCTION"), false);
  });
});

describe("isInternalUseEligibleForThisDeployment — convenience wrapper", () => {
  it("matches isInternalUseEligible(status, DEPLOYMENT_USAGE_MODE) for every status", () => {
    for (const status of ["APPROVED_COMMERCIAL", "NONCOMMERCIAL_ONLY", "LICENSE_UNCERTAIN", "NOT_LICENSED_FOR_USE"] as const) {
      assert.strictEqual(
        isInternalUseEligibleForThisDeployment(status),
        isInternalUseEligible(status, DEPLOYMENT_USAGE_MODE),
      );
    }
  });
});
