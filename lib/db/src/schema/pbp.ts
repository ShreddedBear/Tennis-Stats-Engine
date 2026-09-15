import { pgTable, serial, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

/** Normalized point-by-point records. Raw source is retained for audit; engines consume normalized fields only. */
export const pbpMatchesTable = pgTable("pbp_matches", {
  id: serial("id").primaryKey(),
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
  pbp: text("pbp").notNull(),
  validationStatus: text("validation_status").notNull(),
  provenanceNote: text("provenance_note"),
  derivedStats: jsonb("derived_stats"),
  rawSource: jsonb("raw_source"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("pbp_matches_source_record_idx").on(table.source, table.sourceRecordId),
  index("pbp_matches_players_date_idx").on(table.player1Name, table.player2Name, table.date),
  index("pbp_matches_tour_date_idx").on(table.tour, table.date),
]);

export type PbpMatchRow = typeof pbpMatchesTable.$inferSelect;
