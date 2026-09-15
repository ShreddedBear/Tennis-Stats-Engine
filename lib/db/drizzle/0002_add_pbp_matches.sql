CREATE TABLE "pbp_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"canonical_match_id" integer,
	"identity_status" text DEFAULT 'REVIEW_REQUIRED' NOT NULL,
	"identity_reason" text,
	"player1_id" text,
	"player2_id" text,
	"winner_id" text,
	"round" text,
	"source" text NOT NULL,
	"source_record_id" text NOT NULL,
	"date" text NOT NULL,
	"tour" text NOT NULL,
	"tournament_name" text,
	"draw" text,
	"player1_name" text NOT NULL,
	"player2_name" text NOT NULL,
	"winner" integer,
	"score" text,
	"raw_pbp" text NOT NULL,
	"validation_status" text NOT NULL,
	"provenance_note" text,
	"corroborated_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflict_detail" text,
	"derived_stats" jsonb,
	"raw_source" jsonb,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- NOTE: the six statements below are pre-existing schema drift this migration incidentally
-- picked up -- `predictions`/`calibration_models`/`job_runs` already had these fields declared
-- in schema.ts with no migration ever generated for them (unrelated to the PBP work in this
-- migration; not added by it). Left in, rather than silently dropped, so the migration ledger
-- and the TS schema snapshot stay consistent -- see the PBP implementation report for detail.
ALTER TABLE "job_runs" ALTER COLUMN "finished_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "recommendation_v2" text;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "recommendation_version" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "recommendation_changed" boolean;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "recommendation_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calibration_models" ADD COLUMN "pending_activation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calibration_models" ADD COLUMN "pending_specialist_data" jsonb;--> statement-breakpoint
ALTER TABLE "pbp_matches" ADD CONSTRAINT "pbp_matches_canonical_match_id_historical_matches_id_fk" FOREIGN KEY ("canonical_match_id") REFERENCES "public"."historical_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pbp_matches_source_record_idx" ON "pbp_matches" USING btree ("source","source_record_id");--> statement-breakpoint
CREATE INDEX "pbp_matches_players_date_idx" ON "pbp_matches" USING btree ("player1_name","player2_name","date");--> statement-breakpoint
CREATE INDEX "pbp_matches_tour_date_idx" ON "pbp_matches" USING btree ("tour","date");--> statement-breakpoint
CREATE INDEX "pbp_matches_canonical_match_idx" ON "pbp_matches" USING btree ("canonical_match_id");
