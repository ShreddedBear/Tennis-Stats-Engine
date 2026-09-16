/**
 * Historical PBP evidence: retrieval service.
 *
 * This is the ONE place that turns a player's stored `pbp_evidence` rows into a
 * usable historical feature. It is additive to the existing Elo/form pipeline
 * (`historicalData/features.ts`, `historicalData/backfill.ts`) -- it never
 * changes how those are computed, it contributes a SEPARATE feature
 * (`pbpAvgPointsPerGameLast10`) alongside them.
 *
 * Leak-safety: exactly like the existing Elo/form features, this only reads
 * evidence about matches strictly before the match currently being predicted
 * (`asOfCutoff`) -- see `evaluateEvidenceEligibility`'s cutoff check, applied
 * per candidate row using THAT PAST MATCH's own scheduled start as the
 * evidence's source timestamp. A PBP tape is never used to help predict the
 * very match it describes -- only that player's OTHER, earlier matches.
 *
 * DB access is injected (`MinimalDb`, same pattern as
 * `parlayBuilder/builderScoringService.ts`'s `__TEST_writeBuilderDecisionRow`)
 * so the full retrieval + eligibility + feature-derivation path can be unit
 * tested with fake rows, with no live `DATABASE_URL` required.
 *
 * Nothing here reads market odds, EV, or Parlay Builder state -- this module
 * is tennis-evidence-only, matching the "no market contamination" requirement.
 * Nothing here calls `enforceEntitlement`/`canUsePredictionHistory` or any
 * other payment-entitlement check -- see `usagePolicy.ts`'s module docstring
 * for why payment/commercial status is handled as a separate axis (D), not
 * mixed into this retrieval path.
 */

import { logger } from "../../lib/logger.js";
import type { FeatureSnapshot } from "../historicalData/features.js";
import { evaluateEvidenceEligibility, type EligibilityDenialReason } from "./evidenceEligibility.js";
import { computePbpDerivedFeatures, type PbpReconstructed } from "./pbpDerivedFeatures.js";
import { DEPLOYMENT_USAGE_MODE } from "./usagePolicy.js";
import type { EvidenceReliability, LicenseStatus, ValidationLevel } from "./types.js";

const PBP_FORM_WINDOW = 10;

/** Minimal DB interface required by this service (injectable for tests). */
export interface MinimalDb {
  query<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

interface CandidateRow extends Record<string, unknown> {
  evidence_id: number;
  match_id: number;
  pbp_source_repo: string;
  pbp_source_file: string;
  trust_level: string;
  license_status: string;
  reconstructed: PbpReconstructed;
  scheduled_start_at: string | Date;
}

/** Audit record for exactly one contributing (or rejected) evidence row -- this is the
 * "provenance retained" / "prediction audit records evidence was used" artifact the
 * architecture correction required. Returned to the caller (backfill.ts) to log, and
 * asserted on directly by the integration test -- it is never just an assertion that a
 * DB row exists. */
export interface EvidenceUsageRecord {
  evidenceId: number;
  sourceMatchId: number;
  pbpSourceRepo: string;
  pbpSourceFile: string;
  validationLevel: ValidationLevel;
  licenseStatus: LicenseStatus;
  reliability: EvidenceReliability;
}

export interface EvidenceRejectionRecord {
  evidenceId: number;
  sourceMatchId: number;
  reason: EligibilityDenialReason;
}

export interface PlayerPbpFeatureResult {
  /** Null when no eligible evidence contributed anything (honest empty result, never a
   * fabricated default value). */
  feature: FeatureSnapshot | null;
  /** Every row that DID contribute, with full provenance retained -- validationLevel is
   * copied through verbatim (e.g. "STRUCTURALLY_VALIDATED") and is NEVER upgraded here. */
  usedEvidence: EvidenceUsageRecord[];
  /** Every candidate row that was found but rejected, with why -- proves CONFLICT/
   * REVIEW_REQUIRED/out-of-cutoff rows are seen and explicitly blocked, not silently absent. */
  rejectedEvidence: EvidenceRejectionRecord[];
}

/**
 * Looks up all PBP evidence for `playerId`'s past matches strictly before
 * `asOfCutoff`, applies the full eligibility chain to each, and aggregates the
 * eligible ones (most recent `PBP_FORM_WINDOW`) into one feature.
 *
 * `playerId` is matched against BOTH `player1_id` and `player2_id` on
 * `historical_matches` (a player's PBP-evidenced matches can be on either
 * side), and only matches strictly before `asOfCutoff` are even fetched --
 * the SQL WHERE clause enforces this in addition to the per-row eligibility
 * check below, exactly the "defense in depth" pattern `backfill.ts` already
 * uses for its own cutoff filtering.
 */
export async function lookupPlayerPbpFeature(
  db: MinimalDb,
  playerId: string,
  asOfCutoff: Date,
): Promise<PlayerPbpFeatureResult> {
  const result = await db.query<CandidateRow>(
    `SELECT
       pe.id AS evidence_id,
       pe.match_id AS match_id,
       pe.pbp_source_repo AS pbp_source_repo,
       pe.pbp_source_file AS pbp_source_file,
       pe.trust_level AS trust_level,
       pe.license_status AS license_status,
       pe.reconstructed AS reconstructed,
       hm.scheduled_start_at AS scheduled_start_at
     FROM pbp_evidence pe
     JOIN historical_matches hm ON hm.id = pe.match_id
     WHERE (hm.player1_id = $1 OR hm.player2_id = $1)
       AND hm.scheduled_start_at < $2::timestamptz
     ORDER BY hm.scheduled_start_at DESC
     LIMIT $3`,
    [playerId, asOfCutoff.toISOString(), PBP_FORM_WINDOW],
  );

  const usedEvidence: EvidenceUsageRecord[] = [];
  const rejectedEvidence: EvidenceRejectionRecord[] = [];
  const contributions: Array<{ value: number; sourceTimestamp: Date }> = [];

  for (const row of result.rows) {
    const evidenceSourceTimestamp = new Date(row.scheduled_start_at);
    const validationLevel = row.trust_level as ValidationLevel;
    const licenseStatus = row.license_status as LicenseStatus;

    // Identity is "RESOLVED" by construction: pbp_evidence.match_id is a NOT NULL FK with a
    // unique index (one evidence row per canonical match), and the import pipeline only ever
    // imports rows tennis-truth-engine's match_identity_resolver.py already resolved --
    // AMBIGUOUS/UNRESOLVED identity is never exported into this table in the first place (see
    // truth-engine docs/MATCH_IDENTITY_RESOLVER.md and INDEPENDENT_CORROBORATION.md section 8,
    // where AMBIGUOUS/REVIEW_REQUIRED counts are 0). This is a documented, deliberate mapping,
    // not an unchecked assumption.
    const decision = evaluateEvidenceEligibility({
      identityStatus: "RESOLVED",
      validationLevel,
      licenseStatus,
      evidenceSourceTimestamp,
      matchCutoffAt: asOfCutoff,
      usageMode: DEPLOYMENT_USAGE_MODE,
    });

    if (!decision.eligible) {
      rejectedEvidence.push({ evidenceId: row.evidence_id, sourceMatchId: row.match_id, reason: decision.reason });
      continue;
    }

    usedEvidence.push({
      evidenceId: row.evidence_id,
      sourceMatchId: row.match_id,
      pbpSourceRepo: row.pbp_source_repo,
      pbpSourceFile: row.pbp_source_file,
      validationLevel,
      licenseStatus,
      reliability: decision.reliability,
    });

    for (const derived of computePbpDerivedFeatures(row.reconstructed)) {
      if (derived.featureName === "pbpPointsPerGame") {
        contributions.push({ value: derived.featureValue, sourceTimestamp: evidenceSourceTimestamp });
      }
    }
  }

  let feature: FeatureSnapshot | null = null;
  if (contributions.length > 0) {
    const avg = contributions.reduce((sum, c) => sum + c.value, 0) / contributions.length;
    const mostRecentSourceTimestamp = contributions.reduce(
      (latest, c) => (c.sourceTimestamp.getTime() > latest.getTime() ? c.sourceTimestamp : latest),
      contributions[0].sourceTimestamp,
    );
    feature = { featureName: "pbpAvgPointsPerGameLast10", featureValue: avg, sourceTimestamp: mostRecentSourceTimestamp };
  }

  if (usedEvidence.length > 0 || rejectedEvidence.length > 0) {
    logger.info(
      { playerId, asOfCutoff, usedEvidence, rejectedEvidence, feature },
      "pbp evidence lookup for historical feature pipeline",
    );
  }

  return { feature, usedEvidence, rejectedEvidence };
}
