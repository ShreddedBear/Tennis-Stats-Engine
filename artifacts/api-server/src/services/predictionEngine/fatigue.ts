import type { MatchRecord } from "../tennisData/types";
import { realSetGameMargins } from "../shared/matchModels/setMargins";

export interface FatigueResult {
  player1FatigueScore: number;
  player2FatigueScore: number;
  player1MatchesLast7Days: number;
  player2MatchesLast7Days: number;
  player1MatchesLast3Days: number;
  player2MatchesLast3Days: number;
  player1MatchesLast14Days: number;
  player2MatchesLast14Days: number;
  /** Estimated total games played (a real, derived-from-actual-scores proxy for court time) in each window. */
  player1EstimatedGamesLast14Days: number;
  player2EstimatedGamesLast14Days: number;
  reliability: number;
  note: string;
  warnings: string[];
}

const NOTE =
  "Fatigue is estimated from real match dates and set scores over 3/7/14-day windows. 'Estimated games played' is a real, derived-from-actual-scores proxy for court time, not a measured duration -- the provider does not expose match duration/court-time data at all.";

function matchesInWindow(matches: MatchRecord[], days: number, asOf: number): MatchRecord[] {
  const cutoff = asOf - days * 24 * 60 * 60 * 1000;
  return matches.filter((m) => new Date(m.date).getTime() >= cutoff);
}

function estimatedGames(matches: MatchRecord[]): number {
  // Padded {0,0} trailing entries contribute 0 games either way, so this sum is unaffected by
  // the padded-array quirk -- but route through the shared helper anyway for consistency and so
  // this doesn't silently regress if the padding value ever changes.
  return matches.reduce((sum, m) => sum + realSetGameMargins(m).reduce((s, set) => s + set.playerGames + set.opponentGames, 0), 0);
}

function fatigueScore(last3: number, last7: number, last14: number, games14: number, hasGameData: boolean): number {
  // Recent matches weigh more heavily than the same count spread over two weeks; estimated game
  // load (when available) adds resolution beyond raw match count (e.g. two 3-set marathons load
  // more fatigue than two quick straight-set wins).
  const matchLoad = last3 * 3 + (last7 - last3) * 1.5 + (last14 - last7) * 0.5;
  const gameLoadBonus = hasGameData ? Math.min(20, games14 / 15) : 0;
  return Math.round(Math.min(100, matchLoad * 8 + gameLoadBonus));
}

/**
 * `asOfDate` is the instant fatigue is measured against -- defaults to the real current time,
 * which is correct for every live prediction. Walk-forward/backtest evaluation (`historicalScoring.ts`)
 * passes each match's own frozen `cutoffAt` here instead, so historical rows measure recency
 * against their own as-of moment rather than today's wall-clock time (2026-07-14 fix: before
 * this, backtest fatigue always compared match dates from years ago against `Date.now()`, so the
 * 3/7/14-day windows were always empty and this module silently voted a flat 50/50 on the entire
 * backtest corpus). Does not change the 3/7/14-day window logic, weighting, or thresholds --
 * only what instant they're measured from.
 */
export function computeFatigueModule(player1Matches: MatchRecord[], player2Matches: MatchRecord[], asOfDate?: Date): FatigueResult {
  const asOf = (asOfDate ?? new Date()).getTime();
  const p1Last3 = matchesInWindow(player1Matches, 3, asOf).length;
  const p1Last7 = matchesInWindow(player1Matches, 7, asOf).length;
  const p1Last14 = matchesInWindow(player1Matches, 14, asOf);
  const p2Last3 = matchesInWindow(player2Matches, 3, asOf).length;
  const p2Last7 = matchesInWindow(player2Matches, 7, asOf).length;
  const p2Last14 = matchesInWindow(player2Matches, 14, asOf);

  const p1Games14 = estimatedGames(p1Last14);
  const p2Games14 = estimatedGames(p2Last14);
  const p1HasGameData = p1Last14.some((m) => realSetGameMargins(m).length > 0);
  const p2HasGameData = p2Last14.some((m) => realSetGameMargins(m).length > 0);

  const warnings: string[] = [];
  if (!p1HasGameData || !p2HasGameData) {
    warnings.push("Set-score data is missing for at least one player's recent matches -- fatigue falls back to match count only for that player.");
  }

  return {
    player1FatigueScore: fatigueScore(p1Last3, p1Last7, p1Last14.length, p1Games14, p1HasGameData),
    player2FatigueScore: fatigueScore(p2Last3, p2Last7, p2Last14.length, p2Games14, p2HasGameData),
    player1MatchesLast7Days: p1Last7,
    player2MatchesLast7Days: p2Last7,
    player1MatchesLast3Days: p1Last3,
    player2MatchesLast3Days: p2Last3,
    player1MatchesLast14Days: p1Last14.length,
    player2MatchesLast14Days: p2Last14.length,
    player1EstimatedGamesLast14Days: p1Games14,
    player2EstimatedGamesLast14Days: p2Games14,
    reliability: 70,
    note: NOTE,
    warnings,
  };
}
