import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Positive whitelist of EVERY table that has a pgTable() definition in
// lib/db/src/schema/.  Drizzle ignores all other tables it finds in the DB
// (including the ones created exclusively by ensureEvaluationSchema.ts raw SQL
// such as optimizer_runs, walk_forward_runs, parlay_*, strategy_*, etc.).
//
// Rule: when you add a new pgTable() to the schema, add the table name here.
// When ensureEvaluationSchema.ts creates a raw-SQL-only table, do NOT add it here.
const DRIZZLE_MANAGED_TABLES = [
  // core prediction/evaluation ledger
  "predictions",
  "historical_matches",
  "match_feature_snapshots",
  "calibration_models",
  "evaluation_predictions",
  "evaluation_runs",
  "job_runs",
  "pattern_analysis_runs",
  "prediction_settings",
  "simulator_validation",
  "specialist_models",
  "threshold_evaluation_runs",
  // backtesting
  "backtest_predictions",
  "backtest_runs",
  // strategy lifecycle (Drizzle-managed subset)
  "candidate_configs",
  "config_promotions",
  // players / stats
  "master_players",
  "player_stats",
  // payments / billing
  "payments_accounts",
  "webhook_events",
  // user-facing / CRM
  "legal_consents",
  "support_attachments",
  "support_messages",
  "support_tickets",
  "admin_audit_log",
  "admin_user_notes",
  "saved_prediction_cards",
  // canonical identity / match linking
  "canonical_matches",
  "canonical_players",
  "historical_feature_diagnostics",
  "match_source_links",
  "player_aliases",
  "player_resolution_reviews",
  // Tennis Matrix Audit — every table has a pgTable() definition in
  // src/schema/tennisMatrixAudit.ts, so each one belongs on this whitelist.
  "audit_coverage",
  "audit_runs",
  "audit_runtime_index",
  "audit_stage_runs",
  "calibration_buckets",
  "calibration_ledger",
  "calibration_versions",
  "disagreement_results",
  "execution_logs",
  "final_decisions",
  "match_identity_records",
  "matches",
  "metric_coverage_rates",
  "metric_evidence_store",
  "metric_registry",
  "metric_results",
  "parsed_summary_fields",
  "prediction_slates",
  "reconstruction_results",
  "result_grades",
  "rule_document_versions",
  "rule_documents",
  "rules",
  "source_conflicts",
  "source_definitions",
  "source_observations",
  "source_snapshots",
  "stress_results",
  "summary_uploads",
  "summary_versions",
  "truth_engine_calibration_observations",
  "underdog_results",
  "verification_results",
];

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: DRIZZLE_MANAGED_TABLES,
});
