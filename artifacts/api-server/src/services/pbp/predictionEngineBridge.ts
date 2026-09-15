import type { MatchRecord } from "../tennisData/types";
import type { MatchPbpStatsLookup } from "../predictionEngine/serveReturn";
import { getPbpForMatch } from "./pbpService";
import type { PbpTour } from "./types";

/**
 * Builds the `MatchPbpStatsLookup` map `computeServeReturnModule`'s PBP tier expects, for ONE
 * player's own match history. This is the only place a Prediction Engine caller should populate
 * `PredictionEngineInput.player1PbpStats`/`player2PbpStats` — never call `services/pbp` adapters
 * directly from engine code (see docs/pbp-source-policy.md).
 *
 * LEAKAGE PROTECTION: strictly excludes any match whose date is not before `asOfDate` (same
 * `sourceTimestamp < cutoffAt` convention already enforced by the historical backfill pipeline —
 * see lib/db/src/schema/historicalMatches.ts). A match's own PBP is naturally available only
 * after it was played, so this guard is what stops a walk-forward/backtest caller from
 * accidentally feeding a pre-match prediction PBP-derived aggregates that include the very match
 * being predicted, or any later match.
 *
 * Deliberately NOT called from the live per-fixture prediction path by default — see the doc
 * comment on `PredictionEngineInput.player1PbpStats`. Intended for run-scoped callers (walk-
 * forward evaluation, historical backtesting, Truth-Engine-facing status/report tooling) that can
 * afford the per-match DB round trips and need cutoff-correct historical accuracy.
 */
/**
 * Pure, DB-free cutoff filter, extracted so the leakage-critical rule itself is directly unit-
 * testable without a database (same pattern as `__TEST_filterRowsByCeiling` in
 * builderScoringService.ts). Strictly-less-than, matching the backfill pipeline's own
 * `sourceTimestamp < cutoffAt` invariant.
 */
export function filterMatchesBeforeCutoff(matches: MatchRecord[], asOfDate: string): MatchRecord[] {
  return matches.filter((m) => m.date < asOfDate);
}

export async function buildPbpStatsLookup(playerName: string, matches: MatchRecord[], asOfDate: string, tour?: PbpTour): Promise<MatchPbpStatsLookup> {
  const lookup: MatchPbpStatsLookup = new Map();

  for (const match of filterMatchesBeforeCutoff(matches, asOfDate)) {
    const result = await getPbpForMatch({
      player1Name: playerName,
      player2Name: match.opponentName,
      date: match.date,
      tournamentName: match.tournamentName,
      tour,
    });

    if (result.availability === "AVAILABLE" && result.derived) {
      lookup.set(match.id, result.derived);
    }
  }

  return lookup;
}
