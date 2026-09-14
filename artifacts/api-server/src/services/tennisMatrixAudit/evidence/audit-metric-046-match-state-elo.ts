// Metric #046 -- Match-State Elo
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #46)
//
// Ships only the first two of the catalog's six bullets, per the explicit
// batch resolution ("a second, separate Elo track conditioned on first-set
// outcome (Elo_after_winning_set1 vs Elo_after_losing_set1)... must not
// touch the existing general Elo implementation"):
//   - Elo After Winning Set 1
//   - Elo After Losing Set 1
// The other four bullets are out of scope for this batch: "Elo in Deciding
// Sets" and "Elo in Tiebreak-Heavy Matches" were not requested here (could
// plausibly be derived from set_scores in a future batch); "Elo Against Big
// Servers" and "Elo Against Strong Returners" are BLOCKED outright -- no
// serve/return statistic exists anywhere in the static history index to
// classify an opponent as a "big server" or "strong returner" by.
//
// This is a genuinely SEPARATE Elo system from task18c-rank-form-workload.ts's
// replayElo (the "general" Elo used by metric #001 and by #031/#041's
// strength adjustment) -- it is never read from or written into that
// module, and does not modify it in any way.
//
// Model: two independent rating tracks, "after winning set 1" and "after
// losing set 1". For each historical match, the set-1 winner's
// after-winning-set1 rating plays a single Elo contest against the set-1
// loser's after-losing-set1 rating, scored on the MATCH's actual winner
// (not the set-1 winner) -- i.e. this literally measures "how well do you
// convert having taken set 1" vs. "how well do you come back from losing
// it," as two separate, evolving rating pools. K=32, same logistic
// expected-score formula the general Elo replay uses, initial rating 1500.
//
// Restricted to WTA_MAIN/ATP_CHALLENGER: per-set score sequences
// (set_scores) -- needed to know who won set 1 -- only exist in those two
// lanes in the static history index (docs/audit-task-new-batch1-step0.md
// Step 0 table; same structural gap #027/#029 already document).
//
// Performance note: this replays the WHOLE lane's chronological match
// history on every call, the same cost profile task18c's replayElo already
// has and that #031/#041 already accept for the same reason (Elo state is
// inherently a full-history fold, not incrementally cacheable per-query
// without a persistence layer this batch does not add). At current lane
// sizes (max ~65k matches, ATP_CHALLENGER) this is a bounded single pass
// with O(1) per-match work, not a Copilot-scale concern, but it is not free
// -- a caller computing this for many matches in a batch should replay once
// per (lane, asOfDate) and query both players from the same result, not
// call this function once per player.
import { laneMatchesBefore, type HistoryLane } from "./task18c-rank-form-workload";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const MATCH_STATE_ELO_ELIGIBLE_LANES: ReadonlySet<TourLane> = new Set(["WTA_MAIN", "ATP_CHALLENGER"]);
const K = 32;
const INITIAL_RATING = 1500;

function expected(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

export interface MatchStateEloRatings {
  after_winning_set1: Map<string, number>;
  after_losing_set1: Map<string, number>;
  matches_used: number;
}

function firstSetWinner(setScores: Array<[number, number]> | undefined, p1: string, p2: string): string | null {
  const firstSet = setScores?.[0];
  if (!firstSet) return null;
  const [a, b] = firstSet;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a > b ? p1 : p2;
}

/**
 * Builds a per-player {date|normalizedOpponent -> set_scores} index directly
 * from the same raw `lane` object laneMatchesBefore itself reads, so this
 * index is always drawn from exactly the same source as the deduped match
 * list it enriches (not a separate global-index lookup that could silently
 * diverge from it, and testable with a synthetic lane rather than requiring
 * the real generated index to be loaded). Only used to attach set_scores
 * detail to matches laneMatchesBefore has already leakage-filtered -- it
 * never introduces a match that function didn't already approve.
 */
function buildSetScoreIndex(lane: HistoryLane, players: Set<string>): Map<string, Map<string, Array<[number, number]>>> {
  const index = new Map<string, Map<string, Array<[number, number]>>>();
  for (const player of players) {
    const key = normalizeEvidenceIdentity(player);
    const entries = (lane as Record<string, unknown[][]>)[key];
    const byKey = new Map<string, Array<[number, number]>>();
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const [dateRaw, , , opponentRaw, , , , detailRaw] = entry as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, { set_scores?: Array<[number, number]> }?];
        const date = String(dateRaw ?? "").slice(0, 10);
        const opponent = normalizeEvidenceIdentity(String(opponentRaw ?? ""));
        const setScores = detailRaw?.set_scores;
        if (!date || !opponent || !Array.isArray(setScores) || !setScores.length) continue;
        const lookupKey = `${date}|${opponent}`;
        if (!byKey.has(lookupKey)) byKey.set(lookupKey, setScores); // first entry found for this date+opponent pair
      }
    }
    index.set(key, byKey);
  }
  return index;
}

/**
 * Replays the whole lane's match-state Elo as of `asOfDate`. Caller should
 * replay once per (lane, asOfDate) and query both players from the
 * returned ratings, not call this once per player (see module header's
 * performance note).
 */
export function replayMatchStateElo(lane: HistoryLane, asOfDate: string): MatchStateEloRatings {
  const matches = laneMatchesBefore(lane, asOfDate);
  const players = new Set<string>();
  for (const m of matches) { players.add(m.p1); players.add(m.p2); }
  const setScoreIndex = buildSetScoreIndex(lane, players);

  const afterWinningSet1 = new Map<string, number>();
  const afterLosingSet1 = new Map<string, number>();
  let matchesUsed = 0;

  for (const match of matches) {
    const p1Key = normalizeEvidenceIdentity(match.p1), p2Key = normalizeEvidenceIdentity(match.p2);
    const setScores = setScoreIndex.get(p1Key)?.get(`${match.date}|${p2Key}`) ?? setScoreIndex.get(p2Key)?.get(`${match.date}|${p1Key}`);
    const set1Winner = firstSetWinner(setScores, match.p1, match.p2);
    if (!set1Winner) continue; // no usable set-1 detail for this specific match -- skipped, never guessed
    const set1Loser = set1Winner === match.p1 ? match.p2 : match.p1;
    const matchWonBySet1Winner = match.winner === set1Winner;

    const a = afterWinningSet1.get(set1Winner) ?? INITIAL_RATING;
    const b = afterLosingSet1.get(set1Loser) ?? INITIAL_RATING;
    const scoreA = matchWonBySet1Winner ? 1 : 0;
    afterWinningSet1.set(set1Winner, a + K * (scoreA - expected(a, b)));
    afterLosingSet1.set(set1Loser, b + K * ((1 - scoreA) - expected(b, a)));
    matchesUsed++;
  }

  return { after_winning_set1: afterWinningSet1, after_losing_set1: afterLosingSet1, matches_used: matchesUsed };
}

export interface MatchStateEloResult {
  after_winning_set1: number | null;
  after_losing_set1: number | null;
}

/** Live wrapper: replays the lane once and looks up both ratings for `player`, gated by lane eligibility for set-sequence data. */
export function computeMatchStateElo(args: { player: string; lane: TourLane; asOfDate: string }): LaneOutcome<MatchStateEloResult> {
  const { player, lane, asOfDate } = args;
  if (!MATCH_STATE_ELO_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane} has no set-sequence (set_scores) data in the static history index -- cannot determine set-1 outcomes.` };
  }
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayMatchStateElo(historyLane as never, asOfDate);
  const key = normalizeEvidenceIdentity(player);
  const afterWinning = replay.after_winning_set1.get(key) ?? null;
  const afterLosing = replay.after_losing_set1.get(key) ?? null;
  if (afterWinning === null && afterLosing === null) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Player has no matches with a usable set-1 outcome before asOfDate." };
  }
  return {
    lane, status: "GO", n: replay.matches_used,
    value: { after_winning_set1: afterWinning === null ? null : round1(afterWinning), after_losing_set1: afterLosing === null ? null : round1(afterLosing) },
  };
}
