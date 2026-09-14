// Metric #031 -- Common-Opponent Adjusted Point Differential
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #31
// "Extended Opponent-Network Metrics": "point differential against shared
// opponents, adjusted for opponent strength")
//
// Data-granularity substitution, documented not hidden: no point-by-point
// or game-by-game data is stored anywhere in the four-tour static history
// index for any lane (set_scores, the per-set game sequence, is itself only
// populated for WTA_MAIN/ATP_CHALLENGER -- see #027/#029's doc entry). What
// IS populated uniformly across all four lanes (~98-100%, confirmed by
// directly inspecting the generated index, not estimated) is
// sets_for/sets_against per match. This module uses **set differential**
// (sets won minus sets lost) as the finest-grained proxy for "point
// differential" actually available uniformly -- never point-level data
// that does not exist in this data source.
//
// Strength adjustment: per docs/audit-task-new-batch1-step0.md's
// resolution, this metric uses derived Elo (task18c-rank-form-workload.ts's
// replayElo, a deterministic leakage-safe K=32 replay) rather than rank --
// rank data is itself sparse/absent in exactly the same lanes rank always
// is, whereas Elo can be replayed from raw match results alone and is
// available in every lane. This is what turns the metric from a
// lane-inconsistent PARTIAL into a fully GO metric across all four lanes.
import { repositoryResultsRows, type RepositoryResultsObservation } from "./repository-results-history.server";
import { asTourFamily, round1, type LaneOutcome, type TourLane } from "./audit-metrics-shared";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { replayElo } from "./task18c-rank-form-workload";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";

export interface CommonOpponentDifferentialResult {
  common_opponents_n: number;
  player_adjusted_set_differential: number;
  reference_adjusted_set_differential: number;
  differential: number; // player - reference; positive favors player
}

function setDifferentialsByOpponent(rows: RepositoryResultsObservation[]): Map<string, { diffSum: number; matches: number }> {
  const byOpponent = new Map<string, { diffSum: number; matches: number }>();
  for (const row of rows) {
    const detail = (row.raw_payload as { history_detail?: { sets_for?: number | null; sets_against?: number | null } }).history_detail;
    const sf = detail?.sets_for, sa = detail?.sets_against;
    if (!Number.isFinite(sf) || !Number.isFinite(sa)) continue; // never fabricate a differential from missing data
    const key = normalizeEvidenceIdentity(row.opponent_name ?? "");
    if (!key) continue;
    const existing = byOpponent.get(key) ?? { diffSum: 0, matches: 0 };
    existing.diffSum += (sf as number) - (sa as number);
    existing.matches += 1;
    byOpponent.set(key, existing);
  }
  return byOpponent;
}

/**
 * Pure core: given both players' already leakage-filtered prior-match rows
 * and each common opponent's Elo rating (as of the same asOfDate, supplied
 * by the caller from a single shared replayElo pass), compute the
 * Elo-weighted average set differential each player has posted against
 * their shared opponents, and the gap between the two.
 */
export function computeCommonOpponentDifferentialFromRows(args: {
  playerRows: RepositoryResultsObservation[];
  referenceRows: RepositoryResultsObservation[];
  opponentEloByKey: Map<string, number>;
}): CommonOpponentDifferentialResult | null {
  const playerByOpp = setDifferentialsByOpponent(args.playerRows);
  const referenceByOpp = setDifferentialsByOpponent(args.referenceRows);
  const commonKeys = [...playerByOpp.keys()].filter(k => referenceByOpp.has(k));
  if (!commonKeys.length) return null;

  let playerWeightedSum = 0, playerWeightTotal = 0, referenceWeightedSum = 0, referenceWeightTotal = 0, usedCommon = 0;
  for (const key of commonKeys) {
    const elo = args.opponentEloByKey.get(key);
    if (!Number.isFinite(elo)) continue; // no strength signal for this shared opponent -- excluded, not defaulted to a guessed rating
    // Elo itself is always positive and roughly centered on 1500; using it
    // directly as a weight over-weights nothing toward zero the way a
    // delta could, and naturally gives more weight to stronger common
    // opponents' results, which is the point of "adjusted for opponent
    // strength" -- a beaten 1800-Elo common opponent should count for more
    // than a beaten 1400-Elo one.
    const weight = elo as number;
    const p = playerByOpp.get(key)!, r = referenceByOpp.get(key)!;
    playerWeightedSum += weight * (p.diffSum / p.matches);
    playerWeightTotal += weight;
    referenceWeightedSum += weight * (r.diffSum / r.matches);
    referenceWeightTotal += weight;
    usedCommon++;
  }
  if (usedCommon === 0) return null;

  const playerAdjusted = playerWeightedSum / playerWeightTotal;
  const referenceAdjusted = referenceWeightedSum / referenceWeightTotal;
  return {
    common_opponents_n: usedCommon,
    player_adjusted_set_differential: round1(playerAdjusted * 10)! / 10,
    reference_adjusted_set_differential: round1(referenceAdjusted * 10)! / 10,
    differential: round1((playerAdjusted - referenceAdjusted) * 10)! / 10,
  };
}

/** Live wrapper: replays Elo once for the lane, fetches leakage-safe rows for both players, then delegates to the pure core. */
export function computeCommonOpponentPointDifferential(args: {
  player: string;
  reference: string;
  lane: TourLane;
  asOfDate: string;
}): LaneOutcome<CommonOpponentDifferentialResult> {
  const { player, reference, lane, asOfDate } = args;
  const family = asTourFamily(lane);
  const playerRows = repositoryResultsRows(player, family, asOfDate, { strictBefore: true });
  const referenceRows = repositoryResultsRows(reference, family, asOfDate, { strictBefore: true });
  if (!playerRows.length || !referenceRows.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "One or both players have no prior match rows before asOfDate in this lane." };
  }
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayElo(historyLane as never, asOfDate);
  const result = computeCommonOpponentDifferentialFromRows({ playerRows, referenceRows, opponentEloByKey: replay.overall });
  if (!result) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No common opponents (with a known Elo rating) found between the two players before asOfDate." };
  }
  return { lane, status: "GO", n: result.common_opponents_n, value: result };
}
