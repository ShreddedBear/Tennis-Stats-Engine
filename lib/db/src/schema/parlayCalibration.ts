import { pgTable, serial, text, integer, real, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Parlay Builder's OWN calibration model -- fit exclusively from parlay_leg_outcomes (Builder's
 * own graded-leg ledger: real validation_score vs actual_winner_id, produced by
 * builderScoringService.ts itself, backfillParlayLegOutcomes.ts / live /validate submissions).
 *
 * This table, and the fit/apply code that reads it (parlayCalibrationFit.ts,
 * parlayCalibrationCache.ts), exist specifically so Parlay Builder never again needs to read
 * Prediction Engine's calibration_models table or call its calibration.ts functions -- see
 * docs/CROSS_ENGINE_BOUNDARY.md for the incident this closes. Never insert a row here from
 * Prediction Engine data; never let Prediction Engine or anything outside parlayBuilder/ read
 * this table as an input to its own scoring.
 */
export const parlayCalibrationModelsTable = pgTable("parlay_calibration_models", {
  id: serial("id").primaryKey(),
  // Always 'binned-lookup' today (see parlayCalibrationFit.ts) -- a deliberately simpler,
  // differently-implemented method than Prediction Engine's isotonic/Platt choice, not a
  // stand-in name for the same algorithm.
  method: text("method").notNull().default("binned-lookup"),
  mapping: jsonb("mapping").$type<{ x: number; y: number; sampleSize: number }[]>().notNull(),
  trainingSampleSize: integer("training_sample_size").notNull(),
  active: boolean("active").notNull().default(true),
  logLoss: real("log_loss"),
  fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertParlayCalibrationModelSchema = createInsertSchema(parlayCalibrationModelsTable).omit({ id: true, fittedAt: true });
export type InsertParlayCalibrationModel = z.infer<typeof insertParlayCalibrationModelSchema>;
export type ParlayCalibrationModelRow = typeof parlayCalibrationModelsTable.$inferSelect;
