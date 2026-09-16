import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateEvidenceEligibility, reliabilityTierFor } from "./evidenceEligibility.js";
import type { EvidenceEligibilityInput } from "./evidenceEligibility.js";

const BASE_MATCH_CUTOFF = new Date("2013-01-01T00:00:00.000Z");
const BEFORE_CUTOFF = new Date("2012-06-01T00:00:00.000Z");
const AFTER_CUTOFF = new Date("2013-06-01T00:00:00.000Z");

function baseInput(overrides: Partial<EvidenceEligibilityInput> = {}): EvidenceEligibilityInput {
  return {
    identityStatus: "RESOLVED",
    validationLevel: "STRUCTURALLY_VALIDATED",
    licenseStatus: "LICENSE_UNCERTAIN",
    evidenceSourceTimestamp: BEFORE_CUTOFF,
    matchCutoffAt: BASE_MATCH_CUTOFF,
    usageMode: "PRIVATE_NONPAID",
    ...overrides,
  };
}

describe("evaluateEvidenceEligibility — the critical positive path", () => {
  it("a STRUCTURALLY_VALIDATED, LICENSE_UNCERTAIN, in-cutoff, identity-resolved record is eligible under PRIVATE_NONPAID", () => {
    const result = evaluateEvidenceEligibility(baseInput());
    assert.strictEqual(result.eligible, true);
    if (result.eligible) {
      assert.strictEqual(result.reliability.level, "STRUCTURALLY_VALIDATED");
      assert.strictEqual(result.reliability.tier, "USABLE");
    }
  });

  it("never upgrades validationLevel — the returned reliability.level echoes exactly what was passed in", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "STRUCTURALLY_VALIDATED" }));
    assert.strictEqual(result.eligible, true);
    if (result.eligible) {
      assert.notStrictEqual(result.reliability.level, "LEVEL_1_VERIFIED");
      assert.notStrictEqual(result.reliability.level, "MATCH_CORROBORATED");
      assert.strictEqual(result.reliability.level, "STRUCTURALLY_VALIDATED");
    }
  });
});

describe("evaluateEvidenceEligibility — negative paths (each must independently block)", () => {
  it("blocks when identity is AMBIGUOUS", () => {
    const result = evaluateEvidenceEligibility(baseInput({ identityStatus: "AMBIGUOUS" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "IDENTITY_NOT_RESOLVED" });
  });

  it("blocks when identity is MISMATCHED", () => {
    const result = evaluateEvidenceEligibility(baseInput({ identityStatus: "MISMATCHED" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "IDENTITY_NOT_RESOLVED" });
  });

  it("blocks a record dated at or after the match's cutoff (future/out-of-cutoff)", () => {
    const result = evaluateEvidenceEligibility(baseInput({ evidenceSourceTimestamp: AFTER_CUTOFF }));
    assert.deepStrictEqual(result, { eligible: false, reason: "OUT_OF_CUTOFF" });
  });

  it("blocks a record dated exactly AT the cutoff instant (strict inequality, not <=)", () => {
    const result = evaluateEvidenceEligibility(baseInput({ evidenceSourceTimestamp: BASE_MATCH_CUTOFF }));
    assert.deepStrictEqual(result, { eligible: false, reason: "OUT_OF_CUTOFF" });
  });

  it("blocks CONFLICT regardless of license/usage mode", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "CONFLICT", licenseStatus: "APPROVED_COMMERCIAL" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "BLOCKING_VALIDATION_LEVEL" });
  });

  it("blocks REVIEW_REQUIRED regardless of license/usage mode", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "REVIEW_REQUIRED", licenseStatus: "APPROVED_COMMERCIAL" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "BLOCKING_VALIDATION_LEVEL" });
  });

  it("blocks CANDIDATE (raw, never structurally checked) even under PRIVATE_NONPAID", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "CANDIDATE" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "VALIDATION_LEVEL_NOT_USABLE" });
  });

  it("blocks NOT_LICENSED_FOR_USE even under PRIVATE_NONPAID", () => {
    const result = evaluateEvidenceEligibility(baseInput({ licenseStatus: "NOT_LICENSED_FOR_USE" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "LICENSE_NOT_USABLE_UNDER_POLICY" });
  });

  it("blocks LICENSE_UNCERTAIN under COMMERCIAL_PRODUCTION (does not weaken the commercial path)", () => {
    const result = evaluateEvidenceEligibility(baseInput({ usageMode: "COMMERCIAL_PRODUCTION" }));
    assert.deepStrictEqual(result, { eligible: false, reason: "LICENSE_NOT_USABLE_UNDER_POLICY" });
  });
});

describe("evaluateEvidenceEligibility — higher validation levels remain eligible and get higher tiers", () => {
  it("MATCH_CORROBORATED -> HIGH", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "MATCH_CORROBORATED" }));
    assert.strictEqual(result.eligible, true);
    if (result.eligible) assert.strictEqual(result.reliability.tier, "HIGH");
  });

  it("PBP_CORROBORATED -> HIGH", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "PBP_CORROBORATED" }));
    assert.strictEqual(result.eligible, true);
    if (result.eligible) assert.strictEqual(result.reliability.tier, "HIGH");
  });

  it("LEVEL_1_VERIFIED -> HIGHEST", () => {
    const result = evaluateEvidenceEligibility(baseInput({ validationLevel: "LEVEL_1_VERIFIED" }));
    assert.strictEqual(result.eligible, true);
    if (result.eligible) assert.strictEqual(result.reliability.tier, "HIGHEST");
  });
});

describe("reliabilityTierFor — static, never independently invented", () => {
  it("maps every ValidationLevel to the expected coarse tier", () => {
    assert.strictEqual(reliabilityTierFor("CANDIDATE"), "UNUSABLE");
    assert.strictEqual(reliabilityTierFor("STRUCTURALLY_VALIDATED"), "USABLE");
    assert.strictEqual(reliabilityTierFor("MATCH_CORROBORATED"), "HIGH");
    assert.strictEqual(reliabilityTierFor("PBP_CORROBORATED"), "HIGH");
    assert.strictEqual(reliabilityTierFor("LEVEL_1_VERIFIED"), "HIGHEST");
    assert.strictEqual(reliabilityTierFor("CONFLICT"), "UNUSABLE");
    assert.strictEqual(reliabilityTierFor("REVIEW_REQUIRED"), "UNUSABLE");
  });
});
