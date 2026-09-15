import { pgTable, serial, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { historicalMatchesTable } from "./historicalMatches";

/**
 * Normalized point-by-point records — the single, provider-agnostic PBP layer consumed by the
 * Truth Engine, Stats/Prediction Engine, and Parlay Builder. Raw source payload is retained for
 * audit/reproducibility; engines read only the normalized + derived fields, never a provider's
 * own shape directly (see services/pbp/index.ts).
 *
 * `canonicalMatchId`/`player1Id`/`player2Id`/`winnerId`/`round` are populated only once identity
 * resolution succeeds (see services/pbp/identity.ts) — null/unset is the honest state for a
 * candidate row whose match identity is still NO_MATCH/AMBIGUOUS/REVIEW_REQUIRED. A row is never
 * force-attached to a guessed match.
 */
export const pbpMatchesTable = pgTable("pbp_matches", {
  id: serial("id").primaryKey(),

  // Resolved canonical identity — see identityStatus for whether this actually succeeded.
  canonicalMatchId: integer("canonical_match_id").references(() => historicalMatchesTable.id),
  identityStatus: text("identity_status").notNull().default("REVIEW_REQUIRED"), // MATCHED | NO_MATCH | AMBIGUOUS | REVIEW_REQUIRED
  identityReason: text("identity_reason"),
  player1Id: text("player1_id"),
  player2Id: text("player2_id"),
  winnerId: text("winner_id"),
  round: text("round"),

  source: text("source").notNull(),
  sourceRecordId: text("source_record_id").notNull(),
  date: text("date").notNull(),
  tour: text("tour").notNull(),
  tournamentName: text("tournament_name"),
  draw: text("draw"),
  player1Name: text("player1_name").notNull(),
  player2Name: text("player2_name").notNull(),
  winner: integer("winner"),
  score: text("score"),
  rawPbp: text("raw_pbp").notNull(),
  validationStatus: text("validation_status").notNull(),
  provenanceNote: text("provenance_note"),
  /** Set only when a second enabled source disagreed with this record for the same canonical match. */
  corroboratedBy: jsonb("corroborated_by").$type<string[]>().notNull().default([]),
  conflictDetail: text("conflict_detail"),
  derivedStats: jsonb("derived_stats"),
  rawSource: jsonb("raw_source"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("pbp_matches_source_record_idx").on(table.source, table.sourceRecordId),
  index("pbp_matches_players_date_idx").on(table.player1Name, table.player2Name, table.date),
  index("pbp_matches_tour_date_idx").on(table.tour, table.date),
  index("pbp_matches_canonical_match_idx").on(table.canonicalMatchId),
]);

export const insertPbpMatchSchema = createInsertSchema(pbpMatchesTable).omit({ id: true, importedAt: true, updatedAt: true });
export type InsertPbpMatch = z.infer<typeof insertPbpMatchSchema>;
export type PbpMatchRow = typeof pbpMatchesTable.$inferSelect;
