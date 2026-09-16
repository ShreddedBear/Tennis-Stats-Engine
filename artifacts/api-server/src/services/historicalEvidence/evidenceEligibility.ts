/**
 * Historical PBP evidence: feature-eligibility decision chain (axis E).
 *
 * Combines axes A-D (match identity, validation level, license status, usage
 * policy) with cutoff validity into ONE decision for ONE (evidence row, as-of
 * date) pair: may the historical feature pipeline retrieve and use this row?
 *
 * The chain, in order (first failure wins -- this mirrors the order the user's
 * architecture-correction message specified: "identity valid? -> cutoff valid?
 * -> conflict-free? -> sufficient data? -> verification status -> evidence
 * reliability -> feature eligible"):
 *
 *   1. Identity resolved?          (IdentityStatus === "RESOLVED")
 *   2. Within cutoff?              (evidence's source timestamp < match cutoff)
 *   3. Not a blocking validation
 *      level?                      (CONFLICT / REVIEW_REQUIRED always excluded)
 *   4. Validation level usable?    (must be in USABLE_VALIDATION_LEVELS --
 *                                   CANDIDATE excluded even for private use)
 *   5. License usable under this
 *      deployment's usage policy?  (usagePolicy.ts, axis D)
 *
 * Independent corroboration is NOT part of this chain -- corroboration only
 * upgrades axis B (ValidationLevel) upstream in tennis-truth-engine. This
 * function reads whatever ValidationLevel a row already carries; it never
 * requires MATCH_CORROBORATED/PBP_CORROBORATED/LEVEL_1_VERIFIED to retrieve
 * and use a STRUCTURALLY_VALIDATED row as internal evidence, per the
 * architecture correction: "independent corroboration is required only to
 * UPGRADE verification status, not to retrieve/use as internal evidence."
 *
 * This module NEVER auto-upgrades a row's ValidationLevel and never invents a
 * numeric weight independent of the existing model -- `reliabilityTierFor`
 * below is a direct, static mapping from ValidationLevel, nothing else.
 */

import {
  BLOCKING_VALIDATION_LEVELS,
  USABLE_VALIDATION_LEVELS,
  type EvidenceReliability,
  type IdentityStatus,
  type LicenseStatus,
  type ValidationLevel,
} from "./types.js";
import { isInternalUseEligible, type DeploymentUsageMode } from "./usagePolicy.js";

export type EligibilityDenialReason =
  | "IDENTITY_NOT_RESOLVED"
  | "OUT_OF_CUTOFF"
  | "BLOCKING_VALIDATION_LEVEL"
  | "VALIDATION_LEVEL_NOT_USABLE"
  | "LICENSE_NOT_USABLE_UNDER_POLICY";

export interface EvidenceEligibilityInput {
  identityStatus: IdentityStatus;
  validationLevel: ValidationLevel;
  licenseStatus: LicenseStatus;
  /** When the evidence's own underlying facts existed (import/source timestamp) -- compared
   * against the match's frozen cutoffAt, exactly like `matchFeatureSnapshotsTable.sourceTimestamp`
   * vs `matchCutoffAt` elsewhere in the pipeline. Historical PBP evidence describes a match that
   * has already finished, so in practice this is always the match's own completion time; it is
   * still checked explicitly rather than assumed, so a mis-dated or future-tagged row can never
   * slip through. */
  evidenceSourceTimestamp: Date;
  matchCutoffAt: Date;
  usageMode: DeploymentUsageMode;
}

export type EvidenceEligibilityResult =
  | { eligible: true; reliability: EvidenceReliability }
  | { eligible: false; reason: EligibilityDenialReason };

/** Direct, static mapping from ValidationLevel to a coarse reliability tier. Never independently
 * invented -- CONFLICT/REVIEW_REQUIRED map to UNUSABLE because they are always blocked upstream
 * (see BLOCKING_VALIDATION_LEVELS), CANDIDATE maps to UNUSABLE because it is excluded from
 * USABLE_VALIDATION_LEVELS for every deployment mode. */
export function reliabilityTierFor(level: ValidationLevel): EvidenceReliability["tier"] {
  switch (level) {
    case "LEVEL_1_VERIFIED":
      return "HIGHEST";
    case "MATCH_CORROBORATED":
    case "PBP_CORROBORATED":
      return "HIGH";
    case "STRUCTURALLY_VALIDATED":
      return "USABLE";
    case "CANDIDATE":
    case "CONFLICT":
    case "REVIEW_REQUIRED":
      return "UNUSABLE";
  }
}

export function evaluateEvidenceEligibility(input: EvidenceEligibilityInput): EvidenceEligibilityResult {
  if (input.identityStatus !== "RESOLVED") {
    return { eligible: false, reason: "IDENTITY_NOT_RESOLVED" };
  }

  if (!(input.evidenceSourceTimestamp.getTime() < input.matchCutoffAt.getTime())) {
    return { eligible: false, reason: "OUT_OF_CUTOFF" };
  }

  if (BLOCKING_VALIDATION_LEVELS.has(input.validationLevel)) {
    return { eligible: false, reason: "BLOCKING_VALIDATION_LEVEL" };
  }

  if (!USABLE_VALIDATION_LEVELS.has(input.validationLevel)) {
    return { eligible: false, reason: "VALIDATION_LEVEL_NOT_USABLE" };
  }

  if (!isInternalUseEligible(input.licenseStatus, input.usageMode)) {
    return { eligible: false, reason: "LICENSE_NOT_USABLE_UNDER_POLICY" };
  }

  return {
    eligible: true,
    reliability: { level: input.validationLevel, tier: reliabilityTierFor(input.validationLevel) },
  };
}
