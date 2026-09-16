import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { historicalMatchesTable } from "./historicalMatches";

/**
 * Raw point-by-point evidence for a historical match, at whatever validation
 * level it has actually reached -- NOT exclusively "verified" evidence.
 *
 * One row per historicalMatchesTable.id -- matches the "one canonical match <-> one PBP
 * record" firewall rule enforced upstream by tennis-truth-engine's PBP verification
 * pipeline (scripts/verify-sackmann-pbp-v4.py / match_identity_resolver.py /
 * verification_status.py). `validationLevel` records exactly how far a row has
 * progressed (CANDIDATE / STRUCTURALLY_VALIDATED / MATCH_CORROBORATED /
 * PBP_CORROBORATED / LEVEL_1_VERIFIED / CONFLICT / REVIEW_REQUIRED) -- most rows
 * today are STRUCTURALLY_VALIDATED only (reconstructs correctly and agrees with
 * the identity-resolved historical record) and have NOT been independently
 * corroborated. Never read `trustLevel`/`validationLevel` as "verified" without
 * checking its actual value.
 *
 * `licenseStatus` is a SEPARATE axis from validation -- see
 * services/historicalEvidence/usagePolicy.ts for how a deployment decides
 * whether a given licenseStatus permits internal use. A row's licenseStatus
 * being LICENSE_UNCERTAIN does NOT mean the row is deleted, hidden, or
 * unusable -- it means production/commercial persistence and any paid-tier
 * feature must go through that usage-policy check before using it, while a
 * private/non-commercial deployment may still use it for internal historical
 * evidence. This table itself makes no eligibility decision -- it just
 * records the facts (validation level + license status), so the eligibility
 * decision can be recomputed correctly if either the deployment's payment
 * status or a source's license status ever changes.
 *
 * Deliberately excludes BSD/Bzzoiro and TennisMyLife: neither is an approved durable
 * historical-evidence source (BSD is a live runtime fallback only; TennisMyLife's reuse
 * terms are unresolved).
 */
export const pbpEvidenceTable = pgTable(
  "pbp_evidence",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => historicalMatchesTable.id),

    tour: text("tour").notNull(), // ATP_MAIN / WTA_MAIN / ...

    // Where the raw point sequence itself came from. Never BSD/Bzzoiro or TennisMyLife
    // for this table -- see source policy note above.
    pbpSourceRepo: text("pbp_source_repo").notNull(), // e.g. "ppaulojr/tennis_pointbypoint"
    pbpSourceFile: text("pbp_source_file").notNull(),
    pbpSourceRow: integer("pbp_source_row"),

    // Raw point-sequence string exactly as pulled from the source (e.g. "S;S;R;S.S;R;...")
    // and its hash. Never fabricated, never edited, never zero-filled for missing points.
    pbpRaw: text("pbp_raw").notNull(),
    pbpSha256: text("pbp_sha256").notNull(),

    // What independently corroborated this tape's winner/score against a source outside
    // the PBP feed itself (e.g. an independent results table), if any. Null for
    // STRUCTURALLY_VALIDATED-only rows -- independent corroboration has not happened.
    independentSourceName: text("independent_source_name"),
    independentSourceUrl: text("independent_source_url"),

    // Structural reconstruction output (per-set game counts, winner, point/game totals)
    // from replaying pbpRaw against real tennis scoring rules. This is what
    // pbpDerivedFeatures.ts computes hold%/break%-type features from -- never re-parse
    // pbpRaw at feature-computation time, use this stored, already-validated structure.
    reconstructed: jsonb("reconstructed").notNull(),

    verifierVersion: integer("verifier_version").notNull(),
    // Validation-progression axis. Values from verification_status.py's ValidationLevel:
    // CANDIDATE / STRUCTURALLY_VALIDATED / MATCH_CORROBORATED / PBP_CORROBORATED /
    // LEVEL_1_VERIFIED / CONFLICT / REVIEW_REQUIRED. Renamed conceptually from the
    // earlier "trustLevel" (which only ever held "LEVEL_1_RESULT_VERIFIED_PBP" because
    // nothing below that bar was persisted here yet) -- column name kept for schema
    // stability, semantics widened.
    trustLevel: text("trust_level").notNull(),

    // Separate axis from trustLevel/validation. Values from pbp_source_adapter.py's
    // LicenseStatus: APPROVED_COMMERCIAL / NONCOMMERCIAL_ONLY / LICENSE_UNCERTAIN /
    // NOT_LICENSED_FOR_USE. See usagePolicy.ts for how this combines with the
    // deployment's own payment/commercial status to decide internal-use eligibility --
    // this column never encodes that decision itself, only the source fact.
    licenseStatus: text("license_status").notNull().default("LICENSE_UNCERTAIN"),

    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pbp_evidence_match_id_idx").on(table.matchId),
    uniqueIndex("pbp_evidence_pbp_sha256_idx").on(table.pbpSha256),
    index("pbp_evidence_tour_idx").on(table.tour),
  ],
);

export const insertPbpEvidenceSchema = createInsertSchema(pbpEvidenceTable).omit({
  id: true,
  importedAt: true,
});
export type InsertPbpEvidence = z.infer<typeof insertPbpEvidenceSchema>;
export type PbpEvidenceRow = typeof pbpEvidenceTable.$inferSelect;
