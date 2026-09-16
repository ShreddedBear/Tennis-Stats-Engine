/**
 * Historical PBP evidence: shared types.
 *
 * Five axes, kept deliberately separate (never collapsed into one field or one
 * boolean) per the architecture correction that created this module:
 *
 *   A. MATCH IDENTITY STATUS   -- IdentityStatus: is this evidence row correctly
 *      attached to the right historical_matches row?
 *   B. DATA VERIFICATION STATUS -- ValidationLevel: how far has the evidence
 *      itself progressed (structural validity, corroboration, ...)?
 *   C. SOURCE/PROVENANCE STATUS -- LicenseStatus: what does the source's own
 *      license/terms actually say?
 *   D. USAGE/REDISTRIBUTION STATUS -- UsagePolicy (usagePolicy.ts): given C,
 *      does THIS deployment (private/non-paid today; may change later) permit
 *      internal use? This is a deployment-level POLICY decision, never a
 *      change to C itself.
 *   E. PREDICTION FEATURE ELIGIBILITY -- evidenceEligibility.ts: the final
 *      combination of A+B+C+D+cutoff+data-quality into one eligibility
 *      decision for one specific (match, as-of-date) pair.
 */

/** Mirrors tennis-truth-engine's verification_status.py ValidationLevel exactly --
 * keep these two enums in sync by hand if either changes. */
export type ValidationLevel =
  | "CANDIDATE"
  | "STRUCTURALLY_VALIDATED"
  | "MATCH_CORROBORATED"
  | "PBP_CORROBORATED"
  | "LEVEL_1_VERIFIED"
  | "CONFLICT"
  | "REVIEW_REQUIRED";

/** Mirrors tennis-truth-engine's pbp_source_adapter.py LicenseStatus. */
export type LicenseStatus =
  | "APPROVED_COMMERCIAL"
  | "NONCOMMERCIAL_ONLY"
  | "LICENSE_UNCERTAIN"
  | "NOT_LICENSED_FOR_USE";

/** Match-identity status for ONE evidence row against the historical_matches
 * row it claims to belong to. Distinct from ValidationLevel: identity can be
 * fine while the tape itself is a CONFLICT, or identity itself can be the
 * problem (AMBIGUOUS/MISMATCHED) regardless of tape quality. */
export type IdentityStatus = "RESOLVED" | "AMBIGUOUS" | "MISMATCHED";

/** The validation levels that represent a genuine, unresolved problem with the
 * evidence itself -- these can NEVER contribute to a feature, regardless of
 * license/usage policy or deployment mode. */
export const BLOCKING_VALIDATION_LEVELS: ReadonlySet<ValidationLevel> = new Set(["CONFLICT", "REVIEW_REQUIRED"]);

/** Validation levels a private, non-commercial deployment may use as internal
 * historical evidence (subject to identity/cutoff/license-policy checks on
 * top -- this set alone is not sufficient for eligibility). CANDIDATE is
 * deliberately excluded even for private use: a raw, never-structurally-checked
 * tape is not "usable evidence" under any policy, it is unvalidated input. */
export const USABLE_VALIDATION_LEVELS: ReadonlySet<ValidationLevel> = new Set([
  "STRUCTURALLY_VALIDATED",
  "MATCH_CORROBORATED",
  "PBP_CORROBORATED",
  "LEVEL_1_VERIFIED",
]);

export interface EvidenceReliability {
  level: ValidationLevel;
  /** Coarse tier for feature-weighting purposes -- see evidenceEligibility.ts's
   * reliabilityTierFor(). Never invented independently of ValidationLevel;
   * always derived from it. */
  tier: "HIGHEST" | "HIGH" | "USABLE" | "UNUSABLE";
}
