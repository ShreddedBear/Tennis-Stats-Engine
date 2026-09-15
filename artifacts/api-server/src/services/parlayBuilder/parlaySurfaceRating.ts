import type { MatchRecord, Surface } from "../tennisData/types.js";

/**
 * Parlay Builder's OWN surface-strength rating -- independent of, and never calling into,
 * Prediction Engine's computeSurfaceEloModule (see docs/CROSS_ENGINE_BOUNDARY.md).
 *
 * This is a deliberately simpler, single-sided Elo variant:
 *  - No opponent-strength lookup table (every opponent is treated as baseline-rated).
 *    Prediction Engine's OpponentEloLookup infrastructure (opponentStrength.ts) is itself
 *    Prediction-Engine-owned; reusing it would reintroduce exactly the coupling this module
 *    exists to avoid.
 *  - No recency decay, no tournament-level K-factor calibration, no corpus-baseline
 *    blending, no tour-level-credibility shrink. Prediction Engine's version tunes all of
 *    these against its own real corpus statistics (see surfaceElo.ts's CORPUS_BASELINE_ELO/
 *    LEVEL_BASELINE_ELO comments) -- reproducing that tuning here would make this a
 *    disguised copy rather than an independent calculation, even without an import
 *    statement naming predictionEngine/.
 *
 * The result is intentionally less sophisticated than Prediction Engine's own model. That is
 * the point: an "independent validator" that happened to match Prediction Engine's
 * sophistication step for step would not actually be validating anything independently.
 */

const BASELINE_RATING = 1500;
/** Fixed K-factor -- no recency/level scaling, unlike Prediction Engine's BASE_K=32 with
 * per-match multipliers. A different constant AND a different (unscaled) usage. */
const K_FACTOR = 24;
const MIN_SAMPLE = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function replayNaiveElo(matches: MatchRecord[], surface: Surface): { rating: number; sampleSize: number } {
  const onSurface = [...matches.filter((m) => m.surface === surface)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let rating = BASELINE_RATING;
  for (const m of onSurface) {
    // Opponent is always assumed to be at the baseline rating -- see module doc above for why
    // this deliberately does not reach for a real per-opponent strength figure.
    const expected = 1 / (1 + Math.pow(10, (BASELINE_RATING - rating) / 400));
    const actual = m.result === "W" ? 1 : 0;
    rating += K_FACTOR * (actual - expected);
  }
  return { rating, sampleSize: onSurface.length };
}

export interface ParlaySurfaceRatingResult {
  player1Rating: number;
  player2Rating: number;
  winProbabilityPlayer1: number; // 0-100
  reliability: number; // 0-100, simple sample-based confidence
  sampleSizePlayer1: number;
  sampleSizePlayer2: number;
  defaulted: boolean;
}

/** Linear-with-cap confidence from raw sample size -- deliberately simpler than Prediction
 * Engine's diminishing-returns exponential (confidenceFromEffectiveSampleSize). */
function confidenceFromSampleSize(sampleSize: number): number {
  return clamp(Math.round(sampleSize * 8), 5, 95);
}

export function computeParlaySurfaceRating(player1Matches: MatchRecord[], player2Matches: MatchRecord[], surface: Surface): ParlaySurfaceRatingResult {
  const p1 = replayNaiveElo(player1Matches, surface);
  const p2 = replayNaiveElo(player2Matches, surface);
  const diff = p1.rating - p2.rating;
  const winProbabilityPlayer1 = clamp(Math.round((1 / (1 + Math.pow(10, -diff / 400))) * 100), 5, 95);
  const reliability = Math.min(confidenceFromSampleSize(p1.sampleSize), confidenceFromSampleSize(p2.sampleSize));
  return {
    player1Rating: Math.round(p1.rating),
    player2Rating: Math.round(p2.rating),
    winProbabilityPlayer1,
    reliability,
    sampleSizePlayer1: p1.sampleSize,
    sampleSizePlayer2: p2.sampleSize,
    defaulted: p1.sampleSize < MIN_SAMPLE || p2.sampleSize < MIN_SAMPLE,
  };
}
