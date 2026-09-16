/**
 * Derives feature values from an already-validated `pbp_evidence.reconstructed`
 * structure. Never re-parses `pbpRaw` here -- `reconstructed` is the
 * already-computed, already-validated output of tennis-truth-engine's
 * `reconstruct_pbp()` (scripts/lib/pbp_source_adapter.py), stored once at
 * import time.
 *
 * Honest scope note: `reconstruct_pbp()` currently returns only
 * `{ valid, sets: [[gamesWonP0, gamesWonP1], ...], winner, points, games }` --
 * it discards which player served each individual game while replaying the
 * tape (see that function's source: `server` is tracked only to interpret
 * each game's serve-relative point codes, then thrown away once the game's
 * winner is folded into the set's aggregate `wins` counter). That means
 * hold%/break%, the feature this module was originally scoped to compute,
 * is NOT derivable from the currently-stored `reconstructed` shape without
 * first extending `reconstruct_pbp()` upstream to also emit a per-game
 * (server, winner) list -- a real, tracked follow-up, not done in this
 * session so as to avoid inventing hold/break numbers the stored data does
 * not actually contain.
 *
 * What IS honestly derivable from the stored structure, and genuinely uses
 * point-level information a plain box score (final score string alone) does
 * not carry, is `pointsPerGame` = total points / total games. Two matches
 * with an identical set-score line (e.g. 6-4 6-4) can differ sharply in how
 * many total points were actually played (a set full of deuces vs. one with
 * many love/15 holds), so this is real signal from the PBP tape, not a
 * re-derivation of something already available from `historical_matches.score`.
 *
 * This is a MATCH-level feature (symmetric -- describes how the match as a
 * whole played out, not one player's individual tendency), so the same value
 * is emitted for both players, exactly like other match-level facts already
 * folded into player state elsewhere in this codebase (e.g. surface).
 */

export interface PbpReconstructed {
  valid: boolean;
  sets?: Array<[number, number]>;
  winner?: 0 | 1;
  points?: number;
  games?: number;
  reason?: string;
}

export interface PbpDerivedFeature {
  featureName: string;
  featureValue: number;
}

/**
 * Returns an empty array (never a fabricated 0/default) when `reconstructed`
 * is not a valid, complete reconstruction -- a CONFLICT/REVIEW_REQUIRED row
 * should never reach this function at all (evidenceEligibility.ts blocks it
 * upstream), but this is defense in depth: no derived feature is ever emitted
 * from data this function cannot confirm is structurally valid.
 */
export function computePbpDerivedFeatures(reconstructed: PbpReconstructed): PbpDerivedFeature[] {
  if (!reconstructed.valid) return [];
  const { points, games } = reconstructed;
  if (typeof points !== "number" || typeof games !== "number" || games <= 0) return [];

  return [{ featureName: "pbpPointsPerGame", featureValue: points / games }];
}
