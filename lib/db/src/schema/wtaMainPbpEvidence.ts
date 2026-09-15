import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * WTA Main-tour historical point-by-point evidence, one-way synced from
 * tennis-truth-engine's data/metrics/pbp/wta_main/approved-index.jsonl
 * (scripts/syncWtaMainPbpEvidence.ts). See that repo's
 * docs/audit-wta-main-historical-pbp.md for how this evidence was verified.
 *
 * Ground truth only -- never a model output. This table is the ONE
 * deliberate exception to the Prediction Engine / Parlay Builder isolation
 * boundary (checkParlayBoundary.ts): both may read it directly, because raw
 * point-by-point evidence is not a prediction or a Truth Engine verdict --
 * sharing it does not compromise Parlay Builder's "independent validation"
 * guarantee the way sharing Prediction Engine's own outputs would. Truth
 * Engine's audit conclusions/decisions/calibration are deliberately NOT
 * synced here and must never be -- only this raw evidence crosses the
 * repo boundary, one-way (tennis-truth-engine -> tennis-stats-engine).
 *
 * LICENSE: this data is NONCOMMERCIAL_ONLY (CC BY-NC-SA 4.0, or for the
 * non-Slam ppaulojr lane, entirely unlicensed) -- see
 * tennis-truth-engine's docs/WTA_MAIN_HISTORICAL_PBP_ATTRIBUTION.md. Do not
 * use in a commercial/monetized path without resolving that first; the
 * licenseStatus column below carries this through so any reader can filter
 * on it rather than needing to know to go check another repo's docs.
 */
export const wtaMainPbpEvidenceTable = pgTable(
  "wta_main_pbp_evidence",
  {
    id: text("id").primaryKey(), // matchKey from the source index (stable, deterministic)

    tour: text("tour").notNull().default("WTA_MAIN"),
    year: integer("year").notNull(),
    player1Name: text("player1_name").notNull(),
    player2Name: text("player2_name").notNull(),
    tournament: text("tournament"),
    eventDate: text("event_date"), // YYYY-MM-DD; slam-lane rows carry the tournament's start date, not the exact match date -- see sourceTrustLevel
    round: text("round"),
    surface: text("surface"),
    eventLevel: text("event_level"), // G / PM / P / I / F (WTA tourney_level codes)

    // Which of the two source lanes this row came from, and how strongly it was verified --
    // never collapsed into a single "verified" boolean. See tennis-truth-engine's
    // docs/audit-wta-main-historical-pbp.md for what each tier actually means.
    source: text("source").notNull(), // SACKMANN_ARCHIVE_PPAULOJR | SACKMANN_SLAM_ARCHIVE
    trustLevel: text("trust_level").notNull(), // LEVEL_1_RESULT_VERIFIED_PBP | LEVEL_2_SINGLE_SOURCE_STRUCTURALLY_VALIDATED
    licenseStatus: text("license_status").notNull().default("NONCOMMERCIAL_ONLY"),

    pbpSha256: text("pbp_sha256").notNull(),
    // Full per-point game sequence, already shaped for direct input to tennis-truth-engine's
    // reconstructPbpScoreState()-style consumers: [{server:"player1"|"player2", tiebreak,
    // points:[{winner,ace,double_fault}]}, ...]. Kept as the source's own shape rather than
    // reprojected into this repo's own historical_matches conventions, so a diff against the
    // source index stays meaningful.
    games: jsonb("games").notNull(),
    canonicalHist: jsonb("canonical_hist").notNull(), // {winner,loser,score,tourney_id} from the source's own identity check

    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("wta_main_pbp_evidence_pbp_sha256_idx").on(table.pbpSha256),
    index("wta_main_pbp_evidence_players_idx").on(table.player1Name, table.player2Name),
    index("wta_main_pbp_evidence_year_idx").on(table.year),
    index("wta_main_pbp_evidence_event_date_idx").on(table.eventDate),
  ],
);

export const insertWtaMainPbpEvidenceSchema = createInsertSchema(wtaMainPbpEvidenceTable).omit({
  syncedAt: true,
});
export type InsertWtaMainPbpEvidence = z.infer<typeof insertWtaMainPbpEvidenceSchema>;
export type WtaMainPbpEvidence = typeof wtaMainPbpEvidenceTable.$inferSelect;
