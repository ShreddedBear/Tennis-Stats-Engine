// Wires three metrics into the LIVE researcher pipeline that a prior audit pass incorrectly
// reported as fully data-blocked -- 038 (Opponent-Adjusted Residual Performance), 040
// (Hidden Decline Detector), and 062 (Motivation/Stakes) -- following the exact tier pattern
// established by every prior batch (deterministic-batch1-standalone-metrics.server.ts
// through deterministic-batch5-new-metrics.server.ts): adapt each module's LaneOutcome<T>
// into this app's MetricFinding shape, GO -> a real certified finding, NOT_ENOUGH_DATA ->
// null (fall through to the next tier). See docs/audit-task-038-040-062.md for the full
// re-verification against real source data that unblocked these three.
//
// 038 and 062 are synchronous, static-index-only replays (same contract as batch1/2/5). 040
// requires a live PBP fetch over the player's own past matches (same contract as 026's own
// live-fetch tier) -- it is therefore tried in the live-fetch phase of
// warehouse-first-researcher.server.ts, alongside 026, not in the cheap synchronous
// deterministic chain the other two codes use.
import type { EvidenceTourFamily } from "./evidence-match-identity";
import type { MetricFinding } from "./audit-pipeline";
import { certifyMetricFinding } from "./metric-certification";
import type { TourLane } from "./audit-metrics-shared";
import { computeOpponentAdjustedResidualPerformance } from "./audit-metric-038-opponent-adjusted-residual-performance";
import { computeHiddenDecline } from "./audit-metric-040-hidden-decline-detector";
import { computeMotivationStakes } from "./audit-metric-062-motivation-stakes";

const SYNCHRONOUS_OWNED = new Set(["038", "062"]);

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}

function residualFinding038(player: string, lane: TourLane, asOfDate: string): MetricFinding | null {
  const result = computeOpponentAdjustedResidualPerformance({ player, lane, asOfDate });
  if (result.status !== "GO") return null;
  const v = result.value;
  const value = `own_games_won_pct=${v.own_games_won_pct}; cohort_games_won_pct=${v.cohort_games_won_pct}; games_won_residual_pct=${v.games_won_residual_pct}; own_sets_won_pct=${v.own_sets_won_pct}; cohort_sets_won_pct=${v.cohort_sets_won_pct}; sets_won_residual_pct=${v.sets_won_residual_pct}; elo_band=+/-${v.elo_band}`;
  return certifyMetricFinding({
    metric_code: "038", p1_value: value, p2_value: null, p1_treatment: "PARTIAL", p2_treatment: "UNAVAILABLE",
    differential: null, evidence_family: "STANDALONE_OPPONENT_ADJUSTED_RESIDUAL_PERFORMANCE", reliability: 68,
    sample: `Elo-band cohort residual (games/sets-won% only -- hold%/break%/Dominance Ratio/serve-return-points excluded, see module header); own_matches=${v.own_matches}; cohort_players=${v.cohort_players}; cohort_matches=${v.cohort_matches}; tour_lane=${lane}`,
    unavailable_reason: null, sources: [{ source_name: "Four-tour static history index (data/generated/tennis-runtime-index.json)", url: null, retrieved_at: null }],
  });
}

function stakesFinding062(player: string, lane: TourLane, asOfDate: string): MetricFinding | null {
  const result = computeMotivationStakes({ player, lane, asOfDate });
  if (result.status !== "GO") return null;
  const v = result.value;
  const value = `seeded_rate_pct=${v.seeded_rate_pct}; avg_seed_when_seeded=${v.avg_seed_when_seeded ?? "NA"}; avg_rank_points_at_stake=${v.avg_rank_points_at_stake ?? "NA"}`;
  return certifyMetricFinding({
    metric_code: "062", p1_value: value, p2_value: null, p1_treatment: "PARTIAL", p2_treatment: "UNAVAILABLE",
    differential: null, evidence_family: "STANDALONE_MOTIVATION_STAKES", reliability: 62,
    sample: `Seeding/points-at-stake profile from own ATP_CHALLENGER history (not year-over-year points-defended, not public milestone context -- see module header); evaluable_matches=${v.evaluable_matches}; seeded_matches=${v.seeded_matches}`,
    unavailable_reason: null, sources: [{ source_name: "TennisMyLife ATP Challenger normalized history (data/public/tennismylife-challenger)", url: null, retrieved_at: null }],
  });
}

/** Synchronous tier for 038/062 -- called once per player side from the cheap deterministic chain. */
export async function deterministicBatch6ResidualStakes(args: { metricCode: string; p1: string; p2: string; asOfDate: string; tourFamily?: EvidenceTourFamily | null }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (!SYNCHRONOUS_OWNED.has(code)) return null;
  const lane = args.tourFamily as TourLane | null | undefined;
  if (!lane) return null;
  try {
    const p1Finding = code === "038" ? residualFinding038(args.p1, lane, args.asOfDate) : stakesFinding062(args.p1, lane, args.asOfDate);
    const p2Finding = code === "038" ? residualFinding038(args.p2, lane, args.asOfDate) : stakesFinding062(args.p2, lane, args.asOfDate);
    if (!p1Finding && !p2Finding) return null;
    // Independent P1/P2 evidence: each side's own finding stands alone, never suppressing or overwriting the other.
    const p1Value = p1Finding?.p1_value ?? null, p2Value = p2Finding?.p1_value ?? null;
    const base = p1Finding ?? p2Finding!;
    return { ...base, p1_value: p1Value, p2_value: p2Value, p1_treatment: p1Value ? "PARTIAL" : "UNAVAILABLE", p2_treatment: p2Value ? "PARTIAL" : "UNAVAILABLE" };
  } catch {
    return null; // malformed/unavailable static-index lane falls through, never crashes or fabricates
  }
}

/** Live-fetch tier for 040 -- same phase as metric 026's own live-fetch tier (needs a live BSD PBP call). */
export async function deterministicBatch6HiddenDecline(args: { metricCode: string; p1: string; p2: string; asOfDate: string; tourFamily?: EvidenceTourFamily | null }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (code !== "040") return null;
  const lane = args.tourFamily as TourLane | null | undefined;
  if (!lane) return null;
  try {
    const [p1Result, p2Result] = await Promise.all([
      computeHiddenDecline({ player: args.p1, lane, asOfDate: args.asOfDate }),
      computeHiddenDecline({ player: args.p2, lane, asOfDate: args.asOfDate }),
    ]);
    const fmt = (r: Awaited<ReturnType<typeof computeHiddenDecline>>) => r.status !== "GO" ? null : r.value.dimensions.map(d => `${d.dimension}: verdict=${d.verdict}; earlier=${d.earlier_rate_pct ?? "NA"} (n=${d.earlier_n}); recent=${d.recent_rate_pct ?? "NA"} (n=${d.recent_n})`).join("; ");
    const p1Value = fmt(p1Result), p2Value = fmt(p2Result);
    if (!p1Value && !p2Value) return null;
    return certifyMetricFinding({
      metric_code: "040", p1_value: p1Value, p2_value: p2Value, p1_treatment: p1Value ? "PARTIAL" : "UNAVAILABLE", p2_treatment: p2Value ? "PARTIAL" : "UNAVAILABLE",
      differential: null, evidence_family: "STANDALONE_HIDDEN_DECLINE_DETECTOR", reliability: 65,
      sample: `Cross-match ace/DF/service/return/hold/break trend over BSD-approved PBP-covered matches, two-proportion CI test per dimension; serve velocity, first/second-serve split, match duration, and three-set dependency excluded (see module header); tour_lane=${lane}`,
      unavailable_reason: null, sources: [{ source_name: "BSD/Bzzoiro approved point-by-point (per-lane historical index)", url: null, retrieved_at: null }],
    });
  } catch {
    return null;
  }
}
