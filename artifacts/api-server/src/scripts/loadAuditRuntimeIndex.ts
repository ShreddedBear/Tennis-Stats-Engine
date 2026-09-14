/**
 * Loads the Tennis Matrix Audit's runtime tennis index into Postgres.
 *
 * The index is the Audit's local evidence backbone: per-player Elo/form buckets and
 * per-tour match history, read by ~24 deterministic producers. In the standalone app it
 * lived as an 80MB Git-LFS JSON blob built from 211MB of committed CSVs. Here it lives in
 * audit_runtime_index, gzipped, so this application keeps one system of record instead of
 * duplicating a statistical database alongside it.
 *
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/loadAuditRuntimeIndex.ts <path>
 *
 * <path> is a runtime index JSON, as produced by scripts/buildAuditRuntimeIndex.mjs from
 * the source CSVs:
 *
 *   node scripts/buildAuditRuntimeIndex.mjs            # writes data/generated/…json
 *
 * Re-running is safe and additive: each load inserts a new row and the reader takes the
 * most recent, so a bad index is rolled back by loading a known-good one again rather than
 * by repairing rows in place.
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pool } from "@workspace/db";

interface IndexShape {
  generatedAt?: string;
  ATP?: Record<string, unknown>;
  WTA?: Record<string, unknown>;
  matchHistory?: Record<string, Record<string, unknown[]>>;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: loadAuditRuntimeIndex.ts <path-to-runtime-index.json>");
  }

  const absolute = resolve(process.cwd(), inputPath);
  const raw = readFileSync(absolute, "utf8");

  // Git LFS pointer files are small text stubs, not JSON. Caught explicitly because the
  // failure is otherwise a confusing parse error, and because the standalone repository
  // stores this exact file under LFS -- a checkout without LFS objects yields the stub.
  if (raw.startsWith("version https://git-lfs")) {
    throw new Error(
      `${absolute} is a Git LFS pointer, not the index itself. Fetch the LFS object ` +
        `(git lfs pull) or rebuild it with scripts/buildAuditRuntimeIndex.mjs.`,
    );
  }

  const index = JSON.parse(raw) as IndexShape;
  const playerCount = Object.keys(index.ATP ?? {}).length + Object.keys(index.WTA ?? {}).length;
  const matchCount = Object.values(index.matchHistory ?? {}).reduce(
    (total, lane) => total + Object.values(lane ?? {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0),
    0,
  );

  // Refuse an empty index rather than storing it. A stored empty index is worse than no
  // index at all: every producer would report "no data" as though the sources genuinely
  // held nothing, and the engine would record those metrics as evidenced absences.
  if (playerCount === 0) {
    throw new Error(`${absolute} contains no players — refusing to store an index that would read as "no evidence exists".`);
  }

  const payload = gzipSync(Buffer.from(JSON.stringify(index), "utf8"));
  console.log(
    `[audit-runtime-index] ${playerCount.toLocaleString()} players, ${matchCount.toLocaleString()} match rows, ` +
      `${(payload.byteLength / 1024 / 1024).toFixed(1)}MB gzipped`,
  );

  await pool.query(
    `insert into audit_runtime_index (payload, generated_at, source_description, player_count, match_count)
     values ($1, $2, $3, $4, $5)`,
    [
      payload,
      index.generatedAt && !Number.isNaN(Date.parse(index.generatedAt)) ? index.generatedAt : new Date().toISOString(),
      absolute,
      playerCount,
      matchCount,
    ],
  );

  console.log("[audit-runtime-index] stored. The Audit's local evidence producers will pick it up on next run.");
  await pool.end();
}

main().catch((error) => {
  console.error("[audit-runtime-index] load failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
