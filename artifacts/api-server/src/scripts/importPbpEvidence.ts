// CLI entry point for importing tennis-truth-engine's STRUCTURALLY_VALIDATED PBP export into
// `pbp_evidence`. Usage:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/importPbpEvidence.ts \
//     --file /path/to/atp_main_2012.json --file /path/to/atp_main_2013.json [--dry-run]
//
// Input files are exactly what tennis-truth-engine's
// scripts/export-pbp-structurally-validated-corpus.py produces: `{ records: ExportedPbpRecord[] }`.
//
// This script does TWO things, deliberately kept separate:
//   1. Resolve identity: each record's (provider, externalId) is looked up against this
//      deployment's OWN `historical_matches` table (populated by the existing, separate
//      sackmannBackfill.ts pipeline). A record whose match isn't in historical_matches yet is
//      skipped and reported -- never inserted with a guessed/null matchId.
//   2. Insert `pbp_evidence` rows for every record whose match WAS found, honestly labeling
//      every row's validationLevel/licenseStatus exactly as tennis-truth-engine reported them --
//      never upgraded, never silently defaulted.
//
// Honest scope note: this script was written and unit-tested (importPbpEvidence.test.ts) against
// a fake DB in this session, but was NOT run against a real production database here -- no
// DATABASE_URL exists in this sandbox. It is a real, complete, runnable script, not a stub.
import { readFileSync } from "node:fs";
import { pool } from "@workspace/db";

export interface ExportedPbpRecord {
  provider: string;
  externalId: string;
  tour: string;
  pbpSourceRepo: string;
  pbpSourceFile: string;
  pbpSourceRow: number;
  pbpRaw: string;
  pbpSha256: string;
  reconstructed: unknown;
  verifierVersion: number;
  validationLevel: string;
  licenseStatus: string;
}

export interface DiscardedDuplicate {
  provider: string;
  externalId: string;
  keptSourceRow: number;
  discardedSourceRow: number;
}

export interface DedupeResult {
  kept: ExportedPbpRecord[];
  discardedDuplicates: DiscardedDuplicate[];
}

/**
 * `pbp_evidence` has a UNIQUE constraint on `match_id` (one evidence row per canonical match) --
 * see lib/db/src/schema/pbpEvidence.ts. tennis-truth-engine's export can legitimately contain more
 * than one STRUCTURALLY_VALIDATED candidate for the same (provider, externalId) -- a real,
 * previously-undiscovered wrinkle in ppaulojr's own source data: e.g. externalId "2012-451-14"
 * (Guillermo Garcia-Lopez vs Pablo Andujar) appears twice in pbp_matches_atp_main_archive.csv at
 * rows 1887 and 1888 with two DIFFERENT (but both internally-consistent) PBP tapes. This function
 * makes the tie-break explicit and deterministic (lowest pbpSourceRow wins) instead of letting the
 * DB unique-constraint violation silently abort the whole import or nondeterministically pick
 * whichever row happened to insert first.
 */
export function dedupeByExternalId(records: ExportedPbpRecord[]): DedupeResult {
  const byKey = new Map<string, ExportedPbpRecord[]>();
  for (const r of records) {
    const key = `${r.provider}:${r.externalId}`;
    const group = byKey.get(key);
    if (group) group.push(r);
    else byKey.set(key, [r]);
  }

  const kept: ExportedPbpRecord[] = [];
  const discardedDuplicates: DiscardedDuplicate[] = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => a.pbpSourceRow - b.pbpSourceRow);
    kept.push(sorted[0]);
    for (const extra of sorted.slice(1)) {
      discardedDuplicates.push({
        provider: extra.provider,
        externalId: extra.externalId,
        keptSourceRow: sorted[0].pbpSourceRow,
        discardedSourceRow: extra.pbpSourceRow,
      });
    }
  }
  return { kept, discardedDuplicates };
}

/** Minimal DB interface required by this script (injectable for tests). */
export interface MinimalDb {
  query<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export interface ImportOutcome {
  insertedOrUpdated: Array<{ externalId: string; matchId: number }>;
  skippedMatchNotFound: string[];
}

/**
 * Resolves each (already-deduped) record against `historical_matches` and upserts a
 * `pbp_evidence` row for every match found. `ON CONFLICT (match_id) DO UPDATE` so re-running this
 * script (e.g. after tennis-truth-engine re-exports with an upgraded validationLevel from real
 * independent corroboration) refreshes the row rather than silently no-op'ing forever.
 */
export async function importRecords(db: MinimalDb, records: ExportedPbpRecord[], dryRun: boolean): Promise<ImportOutcome> {
  const insertedOrUpdated: Array<{ externalId: string; matchId: number }> = [];
  const skippedMatchNotFound: string[] = [];

  for (const record of records) {
    const matchRes = await db.query<{ id: number }>(
      `SELECT id FROM historical_matches WHERE provider = $1 AND external_id = $2 LIMIT 1`,
      [record.provider, record.externalId],
    );
    const matchId = matchRes.rows[0]?.id;
    if (matchId === undefined) {
      skippedMatchNotFound.push(record.externalId);
      continue;
    }

    if (!dryRun) {
      await db.query(
        `INSERT INTO pbp_evidence
           (match_id, tour, pbp_source_repo, pbp_source_file, pbp_source_row, pbp_raw, pbp_sha256,
            reconstructed, verifier_version, trust_level, license_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (match_id) DO UPDATE SET
           pbp_source_repo = EXCLUDED.pbp_source_repo,
           pbp_source_file = EXCLUDED.pbp_source_file,
           pbp_source_row = EXCLUDED.pbp_source_row,
           pbp_raw = EXCLUDED.pbp_raw,
           pbp_sha256 = EXCLUDED.pbp_sha256,
           reconstructed = EXCLUDED.reconstructed,
           verifier_version = EXCLUDED.verifier_version,
           trust_level = EXCLUDED.trust_level,
           license_status = EXCLUDED.license_status`,
        [
          matchId,
          record.tour,
          record.pbpSourceRepo,
          record.pbpSourceFile,
          record.pbpSourceRow,
          record.pbpRaw,
          record.pbpSha256,
          JSON.stringify(record.reconstructed),
          record.verifierVersion,
          record.validationLevel,
          record.licenseStatus,
        ],
      );
    }
    insertedOrUpdated.push({ externalId: record.externalId, matchId });
  }

  return { insertedOrUpdated, skippedMatchNotFound };
}

function parseArgs(argv: string[]): { files: string[]; dryRun: boolean } {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") files.push(argv[++i]);
  }
  if (files.length === 0) {
    throw new Error("Usage: --file <export.json> [--file <export2.json> ...] [--dry-run]");
  }
  return { files, dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { files, dryRun } = parseArgs(process.argv.slice(2));

  const allRecords: ExportedPbpRecord[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { records: ExportedPbpRecord[] };
    allRecords.push(...parsed.records);
  }

  const { kept, discardedDuplicates } = dedupeByExternalId(allRecords);
  const outcome = await importRecords(pool, kept, dryRun);

  console.log(JSON.stringify({
    dryRun,
    totalRecordsInFiles: allRecords.length,
    afterDedupe: kept.length,
    discardedDuplicateCount: discardedDuplicates.length,
    discardedDuplicates,
    insertedOrUpdatedCount: outcome.insertedOrUpdated.length,
    skippedMatchNotFoundCount: outcome.skippedMatchNotFound.length,
    skippedMatchNotFoundSample: outcome.skippedMatchNotFound.slice(0, 20),
  }, null, 2));

  await pool.end();
}

if (process.argv[1] && process.argv[1].endsWith("importPbpEvidence.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
