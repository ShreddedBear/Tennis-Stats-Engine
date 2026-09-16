/**
 * Historical PBP evidence: usage/redistribution policy (axis D).
 *
 * This is the ONLY place a deployment's payment/commercial status is allowed to
 * influence whether a `pbp_evidence` row may be used as internal historical
 * evidence. It never touches, reads, or changes:
 *   - axis B (ValidationLevel) -- a row's validation progress is a fact about the
 *     evidence itself, decided by tennis-truth-engine, never by this deployment.
 *   - axis C (LicenseStatus) -- what the SOURCE's terms actually say never changes
 *     based on who is asking.
 *   - Stripe/payment entitlement gating (payments/entitlementService.ts,
 *     enforceEntitlement() call sites in routes/predictions.ts) -- those remain
 *     completely untouched. This module is deliberately NOT wired to
 *     canUsePredictionHistory or any other PaymentEntitlementKey: a user-facing
 *     paid feature gate and "can our own historical feature pipeline read this
 *     row internally" are different questions answered by different code.
 *
 * DEPLOYMENT_USAGE_MODE below is the single explicit switch for which policy
 * applies. It defaults to the conservative option (COMMERCIAL_PRODUCTION) so a
 * future deployment that forgets to set it explicitly does not silently start
 * treating LICENSE_UNCERTAIN/NONCOMMERCIAL_ONLY sources as usable. The current
 * deployment is explicitly set to PRIVATE_NONPAID per the user's confirmed,
 * repeated instruction (2026-09-16 architecture-correction turn): "Tennis
 * Matrix AI is currently a private, non-paid application... my own use of the
 * historical evidence must not require a paid entitlement." Changing this
 * constant is a deliberate, single-line, reviewable decision -- it is never
 * inferred from Stripe/payments state at runtime.
 */

import type { LicenseStatus } from "./types.js";

export type DeploymentUsageMode = "PRIVATE_NONPAID" | "COMMERCIAL_PRODUCTION";

/**
 * The current deployment's usage mode. See module docstring for why this is a
 * hardcoded, explicit constant rather than derived from `isPaymentsV2Enabled()`
 * or any entitlement check: payment/commercial *readiness* (Stripe being wired
 * up) is a different fact from whether THIS deployment's actual use of the app
 * today is commercial. The user has explicitly confirmed the latter is false.
 */
export const DEPLOYMENT_USAGE_MODE: DeploymentUsageMode = "PRIVATE_NONPAID";

/**
 * Whether a source carrying `licenseStatus` may be used as INTERNAL historical
 * evidence under `mode`. This decides internal usability only -- it says
 * nothing about redistribution, publishing, or reselling the underlying data,
 * which would require the source's actual terms regardless of mode.
 *
 * - PRIVATE_NONPAID: every license status is internally usable, INCLUDING
 *   LICENSE_UNCERTAIN and NONCOMMERCIAL_ONLY. A private individual using their
 *   own historical data internally, for their own non-paid application, does
 *   not need a commercial redistribution license -- that is a fact about the
 *   source's terms, not something this function invents. NOT_LICENSED_FOR_USE
 *   is the one status that is never usable under any mode: it means the source
 *   itself was determined unusable (see pbp_source_adapter.py), not merely
 *   commercially restricted.
 * - COMMERCIAL_PRODUCTION: only APPROVED_COMMERCIAL is usable. Everything else
 *   -- including LICENSE_UNCERTAIN -- is blocked, matching the existing
 *   `RecordStatus.production_status` LICENSE_BLOCKED behavior in
 *   tennis-truth-engine's verification_status.py. This module never weakens
 *   that path; it only adds the separate PRIVATE_NONPAID path.
 */
export function isInternalUseEligible(licenseStatus: LicenseStatus, mode: DeploymentUsageMode): boolean {
  if (licenseStatus === "NOT_LICENSED_FOR_USE") return false;
  if (mode === "PRIVATE_NONPAID") return true;
  return licenseStatus === "APPROVED_COMMERCIAL";
}

/** Convenience wrapper using the current deployment's configured mode. */
export function isInternalUseEligibleForThisDeployment(licenseStatus: LicenseStatus): boolean {
  return isInternalUseEligible(licenseStatus, DEPLOYMENT_USAGE_MODE);
}
