/**
 * In-memory cache for Parlay Builder's OWN active calibration model -- reads exclusively from
 * parlay_calibration_models (lib/db/src/schema/parlayCalibration.ts). Never reads Prediction
 * Engine's calibration_models table or imports evaluation/calibrationCache.ts. See
 * docs/CROSS_ENGINE_BOUNDARY.md.
 */
import { eq, desc } from "drizzle-orm";
import { db, parlayCalibrationModelsTable } from "@workspace/db";
import type { ParlayCalibrationBin } from "./parlayCalibrationFit.js";

const CACHE_TTL_MS = 5 * 60_000;
let _cache: { value: ParlayCalibrationBin[] | null; modelId: number | null; expiresAt: number } | null = null;

export async function getActiveParlayCalibration(): Promise<{ mapping: ParlayCalibrationBin[] | null; modelId: number | null }> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) {
    return { mapping: _cache.value, modelId: _cache.modelId };
  }

  const [row] = await db
    .select({ id: parlayCalibrationModelsTable.id, mapping: parlayCalibrationModelsTable.mapping })
    .from(parlayCalibrationModelsTable)
    .where(eq(parlayCalibrationModelsTable.active, true))
    .orderBy(desc(parlayCalibrationModelsTable.fittedAt))
    .limit(1);

  const entry = {
    value: (row?.mapping as ParlayCalibrationBin[] | undefined) ?? null,
    modelId: row?.id ?? null,
    expiresAt: now + CACHE_TTL_MS,
  };
  _cache = entry;
  return { mapping: entry.value, modelId: entry.modelId };
}

/** Evicts the cache so the next call re-fetches -- call after refitParlayCalibration.ts writes a
 * newly active model row. */
export function invalidateParlayCalibrationCache(): void {
  _cache = null;
}
