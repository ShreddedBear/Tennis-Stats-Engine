// Metric #045 -- Favorite Fragility Under Resistance
// (docs/audit-task-020-026-034-036-045-052-053.md; public/seed/metrics.txt #45)
//
// Of the catalog's six bullets, this ships the two derivable from
// set_scores + derived Elo (the same two structural gaps every module in
// this batch runs into): "Performance When Opponent Forces Set 3" and
// "Performance When Set Reaches a Tiebreak" -- both askable purely from a
// match's final set-score sequence plus whether the player was the
// pre-match Elo favorite, without needing in-set game order.
//
// NOT shipped (BLOCKED): "Performance When Opponent Holds First 3 Service
// Games", "Performance After Failing Early Break Chances", "Performance
// After Losing First Break", and "Performance When Set Reaches 4-4" all
// need in-set game-by-game sequence (who served/broke each game) -- the
// static history index only ever carries a set's FINAL score
// ([gamesFor, gamesAgainst]), never the order games were played in, so
// there is no way to tell from this data whether a set passed through 4-4
// or who broke first. Not approximated; left undone.
//
// "Favorite" role: pre-match derived Elo (task18c-rank-form-workload.ts's
// replayElo, the same leakage-safe K=32 replay #031/#036/#041 already use)
// higher than the opponent's, same convention as #036.
//
// Lane restriction: WTA_MAIN/ATP_CHALLENGER only -- set_scores (needed for
// both shipped bullets) is a structural schema gap on ATP_MAIN/WTA_CHALLENGER,
// same as #027/#046.
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { laneMatchesBefore, replayElo, type HistoryLane } from "./task18c-rank-form-workload";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const FAVORITE_FRAGILITY_ELIGIBLE_LANES: ReadonlySet<TourLane> = new Set(["WTA_MAIN", "ATP_CHALLENGER"]);

export interface FragilityBucket { n: number; win_rate: number | null }
export interface FavoriteFragilityResult {
  eligible_matches_n: number; // matches played as Elo favorite with usable set_scores
  first_set_tiebreak: FragilityBucket;
  forced_deciding_set: FragilityBucket;
}

function tiebreakSet([a, b]: [number, number]): boolean {
  return (a === 7 && b === 6) || (a === 6 && b === 7);
}

interface FavoritePerspective { won: boolean; setScores: Array<[number, number]> | undefined }

/** Pure core: given a player's already-favorite-filtered match perspectives (with set_scores attached), compute both fragility buckets. */
export function computeFavoriteFragilityFromPerspectives(perspectives: FavoritePerspective[]): FavoriteFragilityResult {
  const usable = perspectives.filter(p => Array.isArray(p.setScores) && p.setScores.length > 0);
  let tbN = 0, tbWins = 0, decidingN = 0, decidingWins = 0;
  for (const p of usable) {
    const sets = p.setScores!;
    if (tiebreakSet(sets[0])) { tbN++; if (p.won) tbWins++; }
    if (sets.length >= 3) { decidingN++; if (p.won) decidingWins++; }
  }
  return {
    eligible_matches_n: usable.length,
    first_set_tiebreak: { n: tbN, win_rate: tbN > 0 ? round1((100 * tbWins) / tbN) : null },
    forced_deciding_set: { n: decidingN, win_rate: decidingN > 0 ? round1((100 * decidingWins) / decidingN) : null },
  };
}

/** Live wrapper: replays Elo + matches for the lane, restricts to matches where `player` was the pre-match Elo favorite, attaches set_scores, gated by lane eligibility. */
export function computeFavoriteFragility(args: { player: string; lane: TourLane; asOfDate: string }): LaneOutcome<FavoriteFragilityResult> {
  const { player, lane, asOfDate } = args;
  if (!FAVORITE_FRAGILITY_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane} has no set-sequence (set_scores) data in the static history index -- structural schema gap, not sparse data.` };
  }
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family] as unknown as HistoryLane;
  const replay = replayElo(historyLane, asOfDate);
  const key = normalizeEvidenceIdentity(player);
  const matches = laneMatchesBefore(historyLane, asOfDate).filter(m => m.p1 === key || m.p2 === key);
  // replay.perspectives already carries each match's own pre-match Elo for
  // both sides, correctly ordered in time -- used directly below instead of
  // re-deriving favorite status from the final post-replay `overall` map
  // (which would be wrong for anything but the very last match).
  const setScoreIndex = new Map<string, Map<string, Array<[number, number]>>>();
  for (const p of new Set([key, ...matches.map(m => (m.p1 === key ? m.p2 : m.p1))])) {
    const entries = (historyLane as Record<string, unknown[][]>)[p];
    const byKey = new Map<string, Array<[number, number]>>();
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const [dateRaw, , , opponentRaw, , , , detailRaw] = entry as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, { set_scores?: Array<[number, number]> }?];
        const date = String(dateRaw ?? "").slice(0, 10);
        const opponent = normalizeEvidenceIdentity(String(opponentRaw ?? ""));
        const setScores = detailRaw?.set_scores;
        if (!date || !opponent || !Array.isArray(setScores) || !setScores.length) continue;
        const lookupKey = `${date}|${opponent}`;
        if (!byKey.has(lookupKey)) byKey.set(lookupKey, setScores);
      }
    }
    setScoreIndex.set(p, byKey);
  }
  const favoritePerspectives: FavoritePerspective[] = replay.perspectives
    .filter(p => p.player === key && p.pre_elo > p.opponent_pre_elo)
    .map(p => ({ won: p.won, setScores: setScoreIndex.get(key)?.get(`${p.date}|${normalizeEvidenceIdentity(p.opponent)}`) }));
  if (!favoritePerspectives.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior matches before asOfDate where this player was the pre-match Elo favorite." };
  }
  const result = computeFavoriteFragilityFromPerspectives(favoritePerspectives);
  if (result.eligible_matches_n === 0) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No favorite-role matches with usable set_scores before asOfDate." };
  }
  return { lane, status: "GO", n: result.eligible_matches_n, value: result };
}
