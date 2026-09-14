// Metric #038 -- Opponent-Adjusted Residual Performance
// (docs/audit-task-038-040-062.md; public/seed/metrics.txt #38)
//
// A prior audit pass reported 038 as structurally UNAVAILABLE ("needs a population-level
// opponent-strength norm to compare against -- no norming model exists"). That conclusion
// was correct about the code (no engine existed) but wrong about the data: the population
// norm the catalog asks for ("how other players normally perform against the same
// opponent") is constructible from the same static four-tour history index every other
// metric in this codebase already replays -- it just needed to actually be built.
//
// Scope, stated honestly up front: the full catalog phrase asks for hold/break/points/
// games/sets/Dominance-Ratio/serve-points/return-points residuals against an
// "opponent-specific" cohort. Hold%, break%, Dominance Ratio, and serve/return-points
// residuals need point-level PBP data on a POPULATION of other players' matches against
// the same opponent -- BSD approved PBP coverage is far too sparse (recent years only, a
// small fraction of all matches) to build a reliable per-opponent cohort from it. What IS
// broadly available across the static index is set_scores (game-by-game set outcomes),
// present for 99%+ of WTA_MAIN and ATP_CHALLENGER matches (docs/audit-task-new-batch1-
// step0.md Step 0 table). This module therefore ships GAMES-WON% and SETS-WON% residuals
// only, computed against an Elo-band cohort (see below), and explicitly does NOT compute
// hold%, break%, Dominance Ratio, or serve/return-points residuals -- those stay excluded
// from this metric's output rather than being faked from data that can't reliably support
// them, the same honest-partial pattern already used for metrics 032/034/053.
//
// Cohort definition (a real compromise, documented rather than silently narrowed): the
// catalog's "opponent-specific cohort" (other players similar in strength to X, specifically
// against THIS opponent Y) is usually too sparse to use directly -- most opponents simply
// haven't played enough Elo-matched players for a per-opponent cohort to be meaningfully
// sized. This module instead compares a player's own games/sets-won rate (pooled across
// ALL their own matches before asOfDate, not just vs today's specific opponent) against the
// pooled rate of an ELO-BAND cohort (other players within +/-100 Elo of X, using the same
// general-Elo replay task18c-rank-form-workload.ts's replayElo already computes, pooled
// across ALL of the cohort's own matches). This answers "does this player under/over-perform
// relative to players of similar overall strength" -- a real, non-fabricated residual signal
// -- rather than the narrower "vs this specific opponent" framing the catalog's wording
// implies. That narrowing is deliberate and documented here, not silent.
import { laneMatchesBefore, replayElo, type HistoryLane } from "./task18c-rank-form-workload";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const RESIDUAL_PERFORMANCE_ELIGIBLE_LANES: ReadonlySet<TourLane> = new Set(["WTA_MAIN", "ATP_CHALLENGER"]);
const ELO_BAND = 100;
const MIN_OWN_MATCHES = 20;
const MIN_COHORT_MATCHES = 100;
const MIN_COHORT_PLAYERS = 8;

type SetScores = Array<[number, number]>;

function extractSetScores(entry: unknown): SetScores | undefined {
  const detail = (entry as unknown[])[7] as { set_scores?: SetScores } | undefined;
  return detail?.set_scores;
}

interface PooledRate { games_won: number; games_played: number; sets_won: number; sets_played: number; matches: number }

function emptyRate(): PooledRate {
  return { games_won: 0, games_played: 0, sets_won: 0, sets_played: 0, matches: 0 };
}

function addMatch(rate: PooledRate, setScores: SetScores) {
  let counted = false;
  for (const [a, b] of setScores) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    rate.games_won += a;
    rate.games_played += a + b;
    rate.sets_played += 1;
    if (a > b) rate.sets_won += 1;
    counted = true;
  }
  if (counted) rate.matches += 1;
}

/**
 * Builds every player's pooled games/sets-won rate from their own matches strictly before
 * asOfDate, in one pass over the lane -- reused both for the target player's own rate and
 * for pooling the Elo-band cohort, rather than replaying the lane once per cohort member.
 */
function buildLaneRates(lane: HistoryLane, asOfDate: string): Map<string, PooledRate> {
  const out = new Map<string, PooledRate>();
  for (const [rawKey, rows] of Object.entries(lane ?? {})) {
    const player = normalizeEvidenceIdentity(rawKey);
    if (!player || !Array.isArray(rows)) continue;
    const rate = emptyRate();
    for (const entry of rows) {
      const [dateRaw] = entry as unknown[];
      const date = String(dateRaw ?? "").slice(0, 10);
      if (!date || date >= asOfDate) continue;
      const setScores = extractSetScores(entry);
      if (!Array.isArray(setScores) || !setScores.length) continue;
      addMatch(rate, setScores);
    }
    if (rate.matches) out.set(player, rate);
  }
  return out;
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Number(((100 * n) / d).toFixed(4)) : null;
}

export interface ResidualPerformanceResult {
  own_games_won_pct: number | null;
  own_sets_won_pct: number | null;
  cohort_games_won_pct: number | null;
  cohort_sets_won_pct: number | null;
  games_won_residual_pct: number | null;
  sets_won_residual_pct: number | null;
  own_matches: number;
  cohort_players: number;
  cohort_matches: number;
  elo_band: number;
}

/**
 * Replays the whole lane's Elo and game/set rates as of asOfDate. Caller should replay once
 * per (lane, asOfDate) and query both players from the returned state, same performance
 * contract as audit-metric-046-match-state-elo.ts's replayMatchStateElo.
 */
export function replayResidualPerformance(lane: HistoryLane, asOfDate: string) {
  const elo = replayElo(lane, asOfDate);
  const rates = buildLaneRates(lane, asOfDate);
  return { elo, rates };
}

export function computeResidualPerformanceFromReplay(
  player: string,
  replay: ReturnType<typeof replayResidualPerformance>,
): ResidualPerformanceResult | null {
  const key = normalizeEvidenceIdentity(player);
  const ownElo = replay.elo.overall.get(key);
  const ownRate = replay.rates.get(key);
  if (ownElo === undefined || !ownRate || ownRate.matches < MIN_OWN_MATCHES) return null;

  const cohort = emptyRate();
  let cohortPlayers = 0;
  for (const [otherKey, otherElo] of replay.elo.overall) {
    if (otherKey === key) continue;
    if (Math.abs(otherElo - ownElo) > ELO_BAND) continue;
    const otherRate = replay.rates.get(otherKey);
    if (!otherRate) continue;
    cohort.games_won += otherRate.games_won;
    cohort.games_played += otherRate.games_played;
    cohort.sets_won += otherRate.sets_won;
    cohort.sets_played += otherRate.sets_played;
    cohort.matches += otherRate.matches;
    cohortPlayers += 1;
  }
  if (cohort.matches < MIN_COHORT_MATCHES || cohortPlayers < MIN_COHORT_PLAYERS) return null;

  const ownGamesPct = pct(ownRate.games_won, ownRate.games_played);
  const ownSetsPct = pct(ownRate.sets_won, ownRate.sets_played);
  const cohortGamesPct = pct(cohort.games_won, cohort.games_played);
  const cohortSetsPct = pct(cohort.sets_won, cohort.sets_played);

  return {
    own_games_won_pct: ownGamesPct === null ? null : round1(ownGamesPct),
    own_sets_won_pct: ownSetsPct === null ? null : round1(ownSetsPct),
    cohort_games_won_pct: cohortGamesPct === null ? null : round1(cohortGamesPct),
    cohort_sets_won_pct: cohortSetsPct === null ? null : round1(cohortSetsPct),
    games_won_residual_pct: ownGamesPct === null || cohortGamesPct === null ? null : round1(ownGamesPct - cohortGamesPct),
    sets_won_residual_pct: ownSetsPct === null || cohortSetsPct === null ? null : round1(ownSetsPct - cohortSetsPct),
    own_matches: ownRate.matches,
    cohort_players: cohortPlayers,
    cohort_matches: cohort.matches,
    elo_band: ELO_BAND,
  };
}

/** Live wrapper: replays the lane once and computes the residual for `player`, gated by lane eligibility. */
export function computeOpponentAdjustedResidualPerformance(args: { player: string; lane: TourLane; asOfDate: string }): LaneOutcome<ResidualPerformanceResult> {
  const { player, lane, asOfDate } = args;
  if (!RESIDUAL_PERFORMANCE_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane} does not have broad enough set_scores coverage in the static history index to build a games/sets-won cohort norm.` };
  }
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayResidualPerformance(historyLane as never, asOfDate);
  const value = computeResidualPerformanceFromReplay(player, replay);
  if (!value) {
    const key = normalizeEvidenceIdentity(player);
    const ownMatches = replay.rates.get(key)?.matches ?? 0;
    return { lane, status: "NOT_ENOUGH_DATA", n: ownMatches, reason: `Player has ${ownMatches} own set_scores-bearing match(es) before asOfDate (needs >=${MIN_OWN_MATCHES}), or the Elo-band cohort was too small (needs >=${MIN_COHORT_PLAYERS} players / >=${MIN_COHORT_MATCHES} matches).` };
  }
  // laneMatchesBefore is not used directly here (buildLaneRates reads the lane's raw entries
  // itself for set_scores access), but confirms this lane genuinely has leakage-safe match
  // data at all -- guards against a malformed/empty lane silently producing a "GO" from stale
  // Elo state alone.
  if (!laneMatchesBefore(historyLane as never, asOfDate).length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Lane has no leakage-safe matches before asOfDate." };
  }
  return { lane, status: "GO", n: value.own_matches, value };
}
