// ----------------------------------------------------------------------------
// THE RUNTIME TENNIS INDEX — Postgres-backed.
//
// This is the Audit's local evidence backbone: per-player Elo/form buckets and per-tour
// match history, which ~24 producer modules read to compute the deterministic metrics.
// Its PUBLIC API is unchanged from the standalone app (`ensureRuntimeIndexLoaded()` and
// `loadRuntimeIndex(): RuntimeTennisIndex`), so not one producer had to be edited and no
// metric is computed from different rows than before.
//
// WHAT CHANGED, AND WHY: the standalone app carried this as an 80MB Git-LFS JSON blob
// built at prebuild time from 211MB of committed CSVs, with a second gzipped copy shipped
// as a static asset because the raw file exceeds the host's per-asset size cap. Carrying
// that into this repository would have meant ~291MB of duplicated statistical data living
// beside a database that is already this application's system of record -- the duplication
// the integration brief explicitly rules out.
//
// So the bytes moved into Postgres instead. The index is stored once, gzipped, in
// audit_runtime_index and hydrated into memory on first read. Same rows, same shape, same
// API; one system of record, no repository bloat, and no per-asset size cliff.
//
// The table is populated out-of-band by scripts/loadAuditRuntimeIndex.ts, which also
// carries the CSV -> index build. Until that has been run the index is EMPTY, and that is
// reported honestly: producers return no statistics rather than fabricated ones, and the
// engine's activation taxonomy records the affected metrics as real misses.
// ----------------------------------------------------------------------------
import { gunzipSync } from "node:zlib";
import { pool } from "@workspace/db";

type Bucket = { n: number; w: number; l: number; sets: number; setsWon: number; straightWins: number; deciding: number; decidingWins: number; elo: number | null; peak: number | null; lastDate: string | null; recent: Array<[string, number, string, number | null, string, string]> };
type Player = { name: string; overall: Bucket; surface: Record<string, Bucket> };
export type RuntimeTennisIndex = {
  generatedAt: string;
  ATP: Record<string, Player>;
  WTA: Record<string, Player>;
  matchHistory: {
    ATP_MAIN: Record<string, unknown[]>;
    WTA_MAIN: Record<string, unknown[]>;
    ATP_CHALLENGER: Record<string, unknown[]>;
    WTA_CHALLENGER: Record<string, unknown[]>;
  };
};

function empty(): RuntimeTennisIndex {
  return { generatedAt: "", ATP: {}, WTA: {}, matchHistory: { ATP_MAIN: {}, WTA_MAIN: {}, ATP_CHALLENGER: {}, WTA_CHALLENGER: {} } };
}

let cache: RuntimeTennisIndex | null = null;

/**
 * Kept for signature compatibility with the standalone app's Workers entry point, which
 * passed a static-asset binding. There is no asset tier here -- the index comes from the
 * database -- so the parameter is accepted and ignored rather than changing every caller.
 */
export type WorkersAssetsBinding = { fetch(request: Request): Promise<Response> };

async function loadFromDatabase(): Promise<RuntimeTennisIndex | null> {
  try {
    const { rows } = await pool.query<{ payload: Buffer; generated_at: string }>(
      `select payload, generated_at from audit_runtime_index order by generated_at desc limit 1`,
    );
    const row = rows[0];
    if (!row?.payload) return null;
    const parsed = JSON.parse(gunzipSync(row.payload).toString("utf8")) as RuntimeTennisIndex;
    // A structurally wrong payload is treated as absent, never as an index with no players:
    // a silently-empty index would make every local producer report "no data" as though the
    // sources genuinely held nothing.
    if (!parsed || typeof parsed !== "object" || !parsed.ATP || !parsed.WTA) return null;
    return parsed;
  } catch {
    // Left uncached on purpose, so a transient database problem is retried on the next
    // request rather than poisoning the process with a permanent empty index.
    return null;
  }
}

export async function ensureRuntimeIndexLoaded(_assets?: WorkersAssetsBinding): Promise<void> {
  if (cache) return;
  const loaded = await loadFromDatabase();
  if (loaded) cache = loaded;
}

/**
 * Synchronous by contract, because every producer calls it inline while computing a metric.
 * It serves whatever ensureRuntimeIndexLoaded() has already hydrated; callers that need the
 * index await that once before running a pipeline (see the audit routes).
 */
export function loadRuntimeIndex(): RuntimeTennisIndex {
  return cache ?? empty();
}

/** True once a real index is resident — surfaced in diagnostics so an empty index is visible. */
export function runtimeIndexLoaded(): boolean {
  return cache !== null && Object.keys(cache.ATP).length + Object.keys(cache.WTA).length > 0;
}

/** Test/loader hook: drop the memoised index so the next read re-hydrates from Postgres. */
export function resetRuntimeIndexCache(): void {
  cache = null;
}
