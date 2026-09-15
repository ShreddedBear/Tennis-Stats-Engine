import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { historicalMatchesTable } from "./historicalMatches";

/**
 * Verified, approved raw point-by-point evidence for a historical match.
 *
 * One row per historicalMatchesTable.id -- matches the "one canonical match <-> one PBP
 * record" firewall rule enforced upstream by tennis-truth-engine's PBP verification
 * pipeline (scripts/verify-sackmann-pbp-v4.py), which is the only writer of this table's
 * approved-source rows. A row here means the raw point sequence independently
 * reconstructs (via real tennis scoring rules) to the same winner and score already on
 * record for the match, cross-checked against a source outside the PBP feed itself.
 *
 * Deliberately excludes BSD/Bzzoiro and TennisMyLife: neither is an approved durable
 * historical-evidence source (BSD is a live runtime fallback only; TennisMyLife's reuse
 * terms are unresolved). Only write rows sourced from an approved provider.
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
    // the PBP feed itself (e.g. an independent results table), if any.
    independentSourceName: text("independent_source_name"),
    independentSourceUrl: text("independent_source_url"),

    // Structural reconstruction output (per-set game counts, winner, point/game totals)
    // from replaying pbpRaw against real tennis scoring rules.
    reconstructed: jsonb("reconstructed").notNull(),

    verifierVersion: integer("verifier_version").notNull(),
    trustLevel: text("trust_level").notNull(), // e.g. "LEVEL_1_RESULT_VERIFIED_PBP"

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
