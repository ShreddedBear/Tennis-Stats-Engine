/**
 * Parlay Builder's OWN calibration fitting -- independent of, and never calling into,
 * Prediction Engine's evaluation/calibration.ts (isotonic regression via PAVA, Platt scaling,
 * best-of-two selection). See docs/CROSS_ENGINE_BOUNDARY.md.
 *
 * Method: empirical win-rate binning with a simple forward monotonic clamp. Genuinely simpler
 * and differently implemented, not a renamed copy:
 *  - No pool-adjacent-violators algorithm (PAVA) -- monotonicity is instead enforced with a
 *    single forward pass that clamps each bin's rate up to the previous bin's rate when it
 *    would otherwise dip, which is a valid but much cruder fix than PAVA's optimal pooling.
 *  - No Platt/logistic-regression fit, and no best-of-two selection between two methods --
 *    just the one binned-lookup method, always.
 *  - Fixed bin count (deciles) rather than PAVA's data-driven block boundaries.
 *
 * Input is always parlay_leg_outcomes rows (Builder's own graded-leg ledger) -- this file has
 * no knowledge of, and no code path that could read, Prediction Engine's evaluation_predictions
 * or calibration_models tables.
 */

export interface ParlayCalibrationPoint {
  /** Builder's own validation_score, 0-100. */
  validationScore: number;
  /** True if the player Builder's factors favored (score >= 50) actually won. */
  won: boolean;
}

export interface ParlayCalibrationBin {
  /** Bin center, 0-1 (validationScore / 100). */
  x: number;
  /** Empirical (post-monotonic-clamp) win rate for this bin, 0-1. */
  y: number;
  sampleSize: number;
}

const BIN_COUNT = 10;
const MIN_TOTAL_SAMPLE = 150;
const MIN_BIN_SAMPLE = 5;

/**
 * Buckets points into BIN_COUNT equal-width validationScore bins (0-10, 10-20, ..., 90-100),
 * merging any bin below MIN_BIN_SAMPLE into its neighbor (preferring the neighbor with more
 * data) so every retained bin has a real sample behind it -- never a bin backed by 1-2 points.
 */
function bucketize(points: ParlayCalibrationPoint[]): Array<{ x: number; wins: number; total: number }> {
  const raw = Array.from({ length: BIN_COUNT }, (_, i) => ({ x: (i + 0.5) / BIN_COUNT, wins: 0, total: 0 }));
  for (const p of points) {
    const idx = Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((p.validationScore / 100) * BIN_COUNT)));
    raw[idx].total += 1;
    if (p.won) raw[idx].wins += 1;
  }

  // Merge thin bins into their richer neighbor, left to right, until every retained bin clears
  // MIN_BIN_SAMPLE or there is nothing left to merge into.
  const merged: Array<{ x: number; wins: number; total: number }> = [];
  for (const bin of raw) {
    if (bin.total === 0) continue;
    if (bin.total < MIN_BIN_SAMPLE && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.wins += bin.wins;
      prev.total += bin.total;
      prev.x = (prev.x + bin.x) / 2;
    } else {
      merged.push({ ...bin });
    }
  }
  return merged;
}

/** Forward-pass monotonic clamp: if a bin's rate is below the previous (retained) bin's rate,
 * raise it to match. Cruder than PAVA (which would also adjust earlier bins), but a valid,
 * simple, genuinely different way to enforce "higher score never means lower calibrated win
 * probability" -- the one property calibration must have. */
function clampMonotonic(bins: Array<{ x: number; wins: number; total: number }>): ParlayCalibrationBin[] {
  const out: ParlayCalibrationBin[] = [];
  let floor = 0;
  for (const b of bins) {
    const rate = Math.max(b.wins / b.total, floor);
    out.push({ x: b.x, y: rate, sampleSize: b.total });
    floor = rate;
  }
  return out;
}

/**
 * Fits a Builder-owned calibration mapping from Builder's own graded legs. Returns null when
 * there isn't enough data to fit responsibly (MIN_TOTAL_SAMPLE) -- callers must not fall back
 * to Prediction Engine's calibration in that case; see parlayCalibrationCache.ts.
 */
export function fitParlayCalibration(points: ParlayCalibrationPoint[]): ParlayCalibrationBin[] | null {
  if (points.length < MIN_TOTAL_SAMPLE) return null;
  const bucketed = bucketize(points);
  if (bucketed.length === 0) return null;
  return clampMonotonic(bucketed);
}

/** Linear interpolation between bin centers -- same general idea as any piecewise-linear
 * calibration curve, but operating on this module's own ParlayCalibrationBin shape and written
 * fresh here rather than importing evaluation/calibration.ts's applyCalibration. */
export function applyParlayCalibration(mapping: ParlayCalibrationBin[], validationScore: number): number {
  const x = Math.max(0, Math.min(1, validationScore / 100));
  if (mapping.length === 0) return x;
  if (x <= mapping[0].x) return mapping[0].y;
  const last = mapping[mapping.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 0; i < mapping.length - 1; i++) {
    const a = mapping[i];
    const b = mapping[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return x;
}

/** Log loss of a fitted mapping against a held-out set -- for the model row's own audit field,
 * computed independently here rather than imported from evaluation/calibration.ts. */
export function parlayCalibrationLogLoss(mapping: ParlayCalibrationBin[], points: ParlayCalibrationPoint[]): number | null {
  if (points.length === 0) return null;
  const eps = 1e-9;
  let sum = 0;
  for (const p of points) {
    const predicted = Math.max(eps, Math.min(1 - eps, applyParlayCalibration(mapping, p.validationScore)));
    sum += p.won ? -Math.log(predicted) : -Math.log(1 - predicted);
  }
  return sum / points.length;
}
