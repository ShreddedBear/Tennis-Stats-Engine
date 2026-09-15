/**
 * syncWtaMainPbpEvidence.ts
 *
 * One-way sync: tennis-truth-engine's verified WTA Main PBP evidence index
 * (data/metrics/pbp/wta_main/approved-index.jsonl) -> this repo's own
 * wta_main_pbp_evidence table (lib/db/src/schema/wtaMainPbpEvidence.ts), so
 * Prediction Engine and Parlay Builder can query it locally without a live
 * cross-repo/cross-app network dependency at request time.
 *
 * Source of truth stays in tennis-truth-engine; this script never writes
 * back to it. Only raw PBP evidence crosses the boundary -- never Truth
 * Engine's own audit conclusions/decisions, which this script does not (and
 * must not) touch.
 *
 * Idempotent: upserts by id (the source index's own matchKey), keyed via
 * ON CONFLICT, so re-running is always safe and never duplicates rows.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/syncWtaMainPbpEvidence.ts
 *
 * Env vars:
 *   PBP_SOURCE_PATH   Local filesystem path to approved-index.jsonl. Use this when
 *                      both repos are checked out side by side (e.g. this session,
 *                      or a CI job that clones both). Takes priority over the URL below.
 *   PBP_SOURCE_URL     Raw-content URL to fetch approved-index.jsonl from instead
 *                      (default: tennis-truth-engine's main branch). Only reachable
 *                      once the branch that added this file is merged to main.
 *   BATCH_SIZE         Rows per upsert batch (default 500).
 *   DRY_RUN=1          Parse and validate, but do not write to the database.
 */
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db, pool, wtaMainPbpEvidenceTable } from "@workspace/db";

const DEFAULT_URL = "https://raw.githubusercontent.com/ShreddedBear/tennis-truth-engine-8ecc1270/main/data/metrics/pbp/wta_main/approved-index.jsonl";
const SOURCE_PATH = process.env["PBP_SOURCE_PATH"] ?? null;
const SOURCE_URL = process.env["PBP_SOURCE_URL"] ?? DEFAULT_URL;
const BATCH_SIZE = parseInt(process.env["BATCH_SIZE"] ?? "500", 10) || 500;
const DRY_RUN = process.env["DRY_RUN"] === "1";

type SourceRow = {
  tour: string; year: number; player1: string; player2: string; tournament: string | null;
  date: string | null; round: string | null; surface: string | null; event_level: string | null;
  source: string; trust_level: string; pbp_sha256: string; match_key: string; status: string;
  games: unknown; canonical_hist: unknown;
};

async function loadSourceText(): Promise<string> {
  if (SOURCE_PATH) {
    console.log(`[sync] reading local file ${SOURCE_PATH}`);
    return readFile(SOURCE_PATH, "utf8");
  }
  console.log(`[sync] fetching ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`);
  return res.text();
}

async function main() {
  const text = await loadSourceText();
  const lines = text.split("\n").filter((l) => l.trim());
  console.log(`[sync] ${lines.length} rows in source index`);

  const rows = lines.map((line) => JSON.parse(line) as SourceRow).filter((r) => r.status === "APPROVED_WTA_MAIN_PBP");
  if (rows.length !== lines.length) {
    console.log(`[sync] skipped ${lines.length - rows.length} non-approved rows`);
  }

  if (DRY_RUN) {
    console.log(`[sync] DRY_RUN — would upsert ${rows.length} rows. Sample:`, rows[0]);
    await pool.end();
    return;
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map((r) => ({
      id: r.match_key,
      tour: r.tour,
      year: r.year,
      player1Name: r.player1,
      player2Name: r.player2,
      tournament: r.tournament,
      eventDate: r.date,
      round: r.round,
      surface: r.surface,
      eventLevel: r.event_level,
      source: r.source,
      trustLevel: r.trust_level,
      licenseStatus: "NONCOMMERCIAL_ONLY",
      pbpSha256: r.pbp_sha256,
      games: r.games,
      canonicalHist: r.canonical_hist,
      sourceUpdatedAt: new Date(),
    }));
    await db.insert(wtaMainPbpEvidenceTable).values(batch).onConflictDoUpdate({
      target: wtaMainPbpEvidenceTable.id,
      set: {
        tournament: sql`excluded.tournament`,
        eventDate: sql`excluded.event_date`,
        round: sql`excluded.round`,
        surface: sql`excluded.surface`,
        eventLevel: sql`excluded.event_level`,
        source: sql`excluded.source`,
        trustLevel: sql`excluded.trust_level`,
        pbpSha256: sql`excluded.pbp_sha256`,
        games: sql`excluded.games`,
        canonicalHist: sql`excluded.canonical_hist`,
        sourceUpdatedAt: sql`excluded.source_updated_at`,
      },
    });
    upserted += batch.length;
    console.log(`[sync] upserted ${upserted}/${rows.length}`);
  }

  console.log(`[sync] done — ${upserted} rows synced into wta_main_pbp_evidence`);
  await pool.end();
}

main().catch((err) => {
  console.error("[sync] failed:", err);
  process.exit(1);
});
