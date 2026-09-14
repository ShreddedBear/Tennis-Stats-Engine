// Metric #062 -- Motivation / Stakes
// (docs/audit-task-038-040-062.md; public/seed/metrics.txt #62)
//
// Catalog definition: "ranking points defended, seeding implications and public milestone
// context."
//
// A prior audit pass reported 062 as fully BLOCKED: "confirmed schema gap on both
// ranking-points-defended and draw/seed/bye metadata." That conclusion was checked against
// the live 48-table Supabase schema, which genuinely has no such columns -- but it never
// checked this repository's raw static-index SOURCE CSVs. `winner_seed`, `loser_seed`,
// `draw_size`, `winner_rank_points`, and `loser_rank_points` are real columns in the
// TennisMyLife ATP Challenger normalized CSVs (data/public/tennismylife-challenger/
// normalized/*.csv) -- they were simply never carried through
// scripts/build-runtime-tennis-index.mjs's compactDetails() into the runtime index before
// this task. That build script was extended (self_seed/opponent_seed/draw_size/
// self_rank_points/opponent_rank_points added to compactDetails() and reverseDetails())
// specifically to unlock this metric; see that script's own comment at the same change.
//
// Scope, stated honestly: this data exists ONLY for ATP_CHALLENGER (the one lane sourced
// from the TennisMyLife normalized CSVs) -- ATP_MAIN (predixsport/atp/atp_elo_matches.csv),
// WTA_MAIN (tennisdata-wta-main), and WTA_CHALLENGER (production-history/wta_challenger) do
// not carry seed/draw_size/rank_points columns at all, verified directly against each
// source file's own header row. This metric is therefore GO only on ATP_CHALLENGER.
//
// "Ranking points defended" in the strict sense (comparing this year's points at stake to
// what the SAME player earned at the SAME tournament last year, which are about to roll
// off their ranking) needs a reliable same-tournament year-over-year match, which this pass
// does not build -- tourney_id values are year-prefixed and not a stable cross-year key,
// and tournament-name matching across years is its own reconstruction problem. What ships
// here instead is a real, non-fabricated "stakes profile": how often this player has been
// seeded in their own past ATP_CHALLENGER tournament matches, their average seed when
// seeded, and their average ranking points at stake in those matches -- real signal, but
// narrower than the catalog's full "points defended" framing. "Public milestone context"
// (a specific ranking milestone at stake, e.g. "first top-100 appearance") is not attempted
// here at all -- it needs event-level narrative context this static index cannot supply.
import { laneMatchesBefore, type HistoryLane } from "./task18c-rank-form-workload";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const MOTIVATION_STAKES_ELIGIBLE_LANES: ReadonlySet<TourLane> = new Set(["ATP_CHALLENGER"]);
const MIN_EVALUABLE_MATCHES = 15;

interface StakesDetail { self_seed?: number | null; draw_size?: number | null; self_rank_points?: number | null }

export interface MotivationStakesResult {
  evaluable_matches: number;
  seeded_matches: number;
  seeded_rate_pct: number;
  avg_seed_when_seeded: number | null;
  avg_rank_points_at_stake: number | null;
}

/**
 * Replays a player's own past ATP_CHALLENGER matches (strictly before asOfDate) and
 * aggregates their seeding/points-at-stake profile. `laneMatchesBefore` is used only to
 * confirm the lane has real leakage-safe matches at all (same guard pattern as
 * audit-metric-038); the seed/draw_size/rank_points detail itself is read directly from the
 * lane's own raw entries (index 7), the same technique audit-metric-046's
 * buildSetScoreIndex and audit-metric-038's buildLaneRates already use for other detail
 * fields not exposed on the laneMatchesBefore Match type.
 */
export function computeMotivationStakesProfile(player: string, lane: HistoryLane, asOfDate: string): MotivationStakesResult | null {
  const key = normalizeEvidenceIdentity(player);
  const rows = (lane as unknown as Record<string, unknown[][]>)[key];
  if (!Array.isArray(rows)) return null;

  let evaluable = 0, seeded = 0, seedSum = 0, pointsSum = 0, pointsN = 0;
  for (const entry of rows) {
    const [dateRaw] = entry as unknown[];
    const date = String(dateRaw ?? "").slice(0, 10);
    if (!date || date >= asOfDate) continue;
    const detail = (entry as unknown[])[7] as StakesDetail | undefined;
    if (!detail || detail.draw_size === null || detail.draw_size === undefined) continue; // no draw metadata for this row -- not evaluable either way
    evaluable++;
    if (typeof detail.self_seed === "number" && Number.isFinite(detail.self_seed)) {
      seeded++;
      seedSum += detail.self_seed;
    }
    if (typeof detail.self_rank_points === "number" && Number.isFinite(detail.self_rank_points)) {
      pointsSum += detail.self_rank_points;
      pointsN++;
    }
  }
  if (evaluable < MIN_EVALUABLE_MATCHES) return null;

  return {
    evaluable_matches: evaluable,
    seeded_matches: seeded,
    seeded_rate_pct: round1((100 * seeded) / evaluable)!,
    avg_seed_when_seeded: seeded > 0 ? round1(seedSum / seeded) : null,
    avg_rank_points_at_stake: pointsN > 0 ? round1(pointsSum / pointsN) : null,
  };
}

/** Live wrapper: gated to ATP_CHALLENGER (the only lane with real seed/draw_size/rank_points source data). */
export function computeMotivationStakes(args: { player: string; lane: TourLane; asOfDate: string }): LaneOutcome<MotivationStakesResult> {
  const { player, lane, asOfDate } = args;
  if (!MOTIVATION_STAKES_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane}'s source data has no seed/draw_size/ranking-points columns -- verified directly against that lane's own source CSV header row. Only ATP_CHALLENGER (TennisMyLife normalized CSVs) carries this data.` };
  }
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  if (!laneMatchesBefore(historyLane as never, asOfDate).length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Lane has no leakage-safe matches before asOfDate." };
  }
  const value = computeMotivationStakesProfile(player, historyLane as never, asOfDate);
  if (!value) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `Player has fewer than ${MIN_EVALUABLE_MATCHES} own ATP_CHALLENGER matches with known draw_size before asOfDate.` };
  }
  return { lane, status: "GO", n: value.evaluable_matches, value };
}
