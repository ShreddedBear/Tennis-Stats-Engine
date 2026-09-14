// Metric #039 -- Performance Surprise Rating
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #39)
//
// Same audit-DB-bounded population as #036/#037 (see that module's header):
// a single completed, TennisMatrixAi-scored match (matches.actual_winner
// populated AND a parsed_summary_fields "matrix_wp" for the player being
// scored). Never extended to the four-tour historical index, which has no
// stored pre-match win probability to compare against.
//
// Per-match signed surprise = actual outcome (1 = won, 0 = lost) minus
// TennisMatrixAi's own pre-match win probability (0-1 scale). Positive =
// player outperformed the prediction; negative = underperformed. A rolling
// average of the *absolute* surprise over a player's trailing N scored
// matches is reported as a volatility/unpredictability indicator -- high
// average absolute surprise means TennisMatrixAi's pre-match probability
// for this player has been a poor fit to outcomes recently, regardless of
// direction.
import { round1, MIN_SUPPORT_N } from "./audit-metrics-shared";
import type { AuditDbOutcome } from "./audit-metric-036-037-loss-win-autopsy";

export interface SurpriseInput {
  /** TennisMatrixAi's pre-match win probability for the player, 0-100. */
  playerWinProbabilityPct: number;
  playerWon: boolean;
}

/** Signed surprise on a -1..+1 scale: +1 = won a match TennisMatrixAi gave 0% chance of, -1 = lost one it gave 100%. */
export function computeSignedSurprise(input: SurpriseInput): number {
  const predicted = input.playerWinProbabilityPct / 100;
  const actual = input.playerWon ? 1 : 0;
  return actual - predicted;
}

export interface RollingSurpriseResult {
  /** Trailing matches actually used (may be fewer than the requested window if the player has less history). */
  n: number;
  mean_absolute_surprise: number;
  mean_signed_surprise: number;
}

/**
 * Rolling average of |surprise| (and mean signed surprise) over a player's
 * most recent `window` scored matches. `chronologicalInputs` must already be
 * ordered oldest-to-newest by the caller (this function does not sort, so it
 * cannot silently paper over a caller passing an unordered or leaking set --
 * see the live wrapper for the leakage guard that decides what's eligible).
 */
export function computeRollingSurprise(chronologicalInputs: SurpriseInput[], window: number): RollingSurpriseResult {
  const trailing = chronologicalInputs.slice(-window);
  const n = trailing.length;
  if (n === 0) return { n: 0, mean_absolute_surprise: 0, mean_signed_surprise: 0 };
  const surprises = trailing.map(computeSignedSurprise);
  const meanAbs = surprises.reduce((sum, s) => sum + Math.abs(s), 0) / n;
  const meanSigned = surprises.reduce((sum, s) => sum + s, 0) / n;
  return { n, mean_absolute_surprise: round1(meanAbs * 100)! / 100, mean_signed_surprise: round1(meanSigned * 100)! / 100 };
}

/** Aggregates the audit DB's whole scored population into a mean absolute/signed surprise, gated by MIN_SUPPORT_N. */
export function summarizeSurpriseDistribution(inputs: SurpriseInput[]): AuditDbOutcome<{ mean_absolute_surprise: number; mean_signed_surprise: number }> {
  const n = inputs.length;
  if (n < MIN_SUPPORT_N) return { population: "AUDIT_DB", status: "NOT_ENOUGH_DATA", n, reason: `Only ${n} TennisMatrixAi-scored matches available; minimum support is ${MIN_SUPPORT_N}.` };
  const surprises = inputs.map(computeSignedSurprise);
  const meanAbs = surprises.reduce((sum, s) => sum + Math.abs(s), 0) / n;
  const meanSigned = surprises.reduce((sum, s) => sum + s, 0) / n;
  return { population: "AUDIT_DB", status: "GO", n, value: { mean_absolute_surprise: round1(meanAbs * 100)! / 100, mean_signed_surprise: round1(meanSigned * 100)! / 100 } };
}
