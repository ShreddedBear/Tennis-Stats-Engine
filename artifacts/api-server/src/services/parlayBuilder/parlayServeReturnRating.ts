import type { MatchRecord, Surface } from "../tennisData/types.js";

/**
 * Parlay Builder's OWN serve/return rating -- independent of, and never calling into,
 * Prediction Engine's computeServeReturnModule (see docs/CROSS_ENGINE_BOUNDARY.md).
 *
 * Derived only from MatchRecord.setGameMargins (real set-score game counts), never from
 * Prediction Engine's realSetGameMargins helper or its opponent-strength weighting -- this
 * file re-derives the (trivial, one-line) "strip padded trailing sets" step itself rather
 * than importing it, so nothing here depends on a predictionEngine/ module at all.
 *
 * Set-score margins alone cannot distinguish serve dominance from return dominance (there is
 * no per-game server identity in this data) -- Prediction Engine's own margin proxy has the
 * same limitation and is equally honest about it (serve/return come out equal there too).
 * This module does not fabricate an artificial split to look different; instead it uses a
 * genuinely different transform for the one figure both ratings share: a bounded tanh
 * dominance curve (diminishing returns at the extremes) rather than Prediction Engine's hard
 * linear clamp, plus a different surface-inclusion rule (strict surface match or unknown
 * surface, vs Prediction Engine's blend-everything-at-reduced-weight approach).
 */

const NEUTRAL = 50;
/** tanh saturation scale, in average games-per-set margin. */
const MARGIN_SCALE = 3;
const MIN_SAMPLE = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function realSetMargins(m: MatchRecord): MatchRecord["setGameMargins"] {
  return m.setGameMargins.filter((s) => s.playerGames > 0 || s.opponentGames > 0);
}

export interface ParlayServeReturnRatingResult {
  serveRating: number;
  returnRating: number;
  sampleSize: number; // real sets counted
  defaulted: boolean;
}

export interface ParlayServeReturnPairResult {
  player1ServeRating: number;
  player2ServeRating: number;
  player1ReturnRating: number;
  player2ReturnRating: number;
  sampleSizePlayer1: number;
  sampleSizePlayer2: number;
  defaulted: boolean;
}

/** Paired convenience wrapper -- each side's rating is still computed entirely
 * independently by computeParlayServeReturnRating; this just shapes the pair the way the
 * call site in builderScoringService.ts wants it. */
export function computeParlayServeReturnPair(player1Matches: MatchRecord[], player2Matches: MatchRecord[], surface: Surface): ParlayServeReturnPairResult {
  const p1 = computeParlayServeReturnRating(player1Matches, surface);
  const p2 = computeParlayServeReturnRating(player2Matches, surface);
  return {
    player1ServeRating: p1.serveRating,
    player2ServeRating: p2.serveRating,
    player1ReturnRating: p1.returnRating,
    player2ReturnRating: p2.returnRating,
    sampleSizePlayer1: p1.sampleSize,
    sampleSizePlayer2: p2.sampleSize,
    defaulted: p1.defaulted || p2.defaulted,
  };
}

export function computeParlayServeReturnRating(matches: MatchRecord[], surface: Surface): ParlayServeReturnRatingResult {
  // Strict surface match, or unknown surface (null) included at full weight -- a different,
  // simpler inclusion rule than Prediction Engine's "any surface, de-weighted 0.7x when it
  // doesn't match" blend.
  const eligible = matches.filter((m) => m.surface === null || m.surface === surface);

  let marginSum = 0;
  let setCount = 0;
  for (const m of eligible) {
    for (const s of realSetMargins(m)) {
      marginSum += s.playerGames - s.opponentGames;
      setCount += 1;
    }
  }

  if (setCount === 0) {
    return { serveRating: NEUTRAL, returnRating: NEUTRAL, sampleSize: 0, defaulted: true };
  }

  const avgMargin = marginSum / setCount;
  const rating = clamp(Math.round(NEUTRAL + Math.tanh(avgMargin / MARGIN_SCALE) * 45), 5, 95);
  return { serveRating: rating, returnRating: rating, sampleSize: setCount, defaulted: setCount < MIN_SAMPLE };
}
