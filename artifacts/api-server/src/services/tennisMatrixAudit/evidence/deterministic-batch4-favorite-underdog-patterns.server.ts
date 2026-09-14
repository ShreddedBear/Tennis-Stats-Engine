// Wires the two newly-built (this task) standalone audit-metric modules --
// 043 (Favorite Failure-Mode Score) and 044 (Opponent Upset Compatibility)
// -- into the LIVE researcher pipeline. Same reconnection pattern as
// deterministic-batch1-standalone-metrics.server.ts and
// deterministic-batch2-new-metrics.server.ts: adapts each module's
// LaneOutcome<T> into this app's MetricFinding shape, GO -> a real
// certified finding, NOT_ENOUGH_DATA -> null (fall through to the next
// tier). No fabrication: a lane/player pair either sub-engine cannot
// support (no favorite-role losses, no verified underdog wins, missing
// set_scores, etc.) always falls through here, never gets a guessed value.
//
// docs/audit-task-043-044-opponent-upset-compatibility.md documents the
// full correction: before this task, deterministic-market-metrics.server.ts
// computed 043/044 as de-vig market pricing/movement text -- real data, but
// not what either code's evidence-gap.ts definition actually asks for
// (favorite-role loss failure conditions / opponent reproduction ability
// for 043; underdog-win history and cross-favorite similarity for 044).
//
// Wiring precedence: this tier is called BEFORE deterministicMarketMetric
// in warehouse-first-researcher.server.ts's deterministic chain, so the
// real per-player historical-pattern engines built here are always tried
// first. MARKET_CODES in deterministic-market-metrics.server.ts
// deliberately still lists "043"/"044" -- when this tier returns null (no
// favorite-role loss history, no verified underdog wins, or an ineligible
// lane), the market tier remains a real, still-useful PARTIAL fallback
// (price context IS one of 044's nine named similarity dimensions, and
// pre-match favorite designation is one of 043's named inputs) rather than
// leaving the code with nothing. It is not merged into these engines
// directly because deterministicMarketMetric is an async Supabase-backed
// call while every other module in this batch (and #036/#046/#051 before
// it) is a synchronous, static-index-only replay -- keeping them separate
// tiers preserves that consistent, already-tested contract instead of
// bolting an async DB dependency onto a pure function.
import type { EvidenceTourFamily } from "./evidence-match-identity";
import type { MetricFinding } from "./audit-pipeline";
import { certifyMetricFinding } from "./metric-certification";
import type { TourLane } from "./audit-metrics-shared";
import { computeFavoriteFailureMode } from "./audit-metric-043-favorite-failure-mode";
import { computeOpponentUpsetCompatibility } from "./audit-metric-044-opponent-upset-compatibility";

const OWNED = new Set(["043", "044"]);

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
function fmt(obj: Record<string, unknown>): string {
  return Object.entries(obj).map(([k, v]) => `${k}=${v === null || v === undefined ? "NA" : v}`).join("; ");
}

type FoundValues = { p1Value: string; p2Value: string; p1Treatment: "RECONSTRUCTED" | "UNAVAILABLE"; p2Treatment: "RECONSTRUCTED" | "UNAVAILABLE"; n: number } | null;

/**
 * 043 is inherently directional (favorite-role losses for one player,
 * cross-referenced against the OTHER player's underdog-win reproduction
 * ability) -- so both directions are computed: p1-as-favorite-failing vs
 * p2-as-reproducer, and p2-as-favorite-failing vs p1-as-reproducer. Each
 * side of the finding reports that player's OWN favorite-failure-mode
 * profile against the actual opponent they face today, not a symmetric or
 * averaged value.
 */
function favoriteFailureMode043(p1: string, p2: string, lane: TourLane, asOfDate: string, surface: string | null): FoundValues {
  const a = computeFavoriteFailureMode({ player: p1, opponent: p2, lane, asOfDate });
  const b = computeFavoriteFailureMode({ player: p2, opponent: p1, lane, asOfDate });
  if (a.status !== "GO" && b.status !== "GO") return null;
  const fmtSide = (r: typeof a) => r.status !== "GO" ? `status=NOT_ENOUGH_DATA; reason=${r.reason}` : fmt({
    trailing_favorite_losses_n: r.value.trailing_favorite_losses_n,
    favorite_losses_rate_pct: r.value.favorite_losses_rate_pct,
    bad_loss_severity_index: r.value.bad_loss_severity_index,
    opponent_underdog_wins_n: r.value.opponent_underdog_wins_n,
    reproduction_compatibility_score_pct: r.value.reproduction_compatibility_score_pct,
    set_sequence_available: r.value.set_sequence_available,
    ...Object.fromEntries(r.value.failure_conditions.map(c => [`${c.condition}_player_rate_pct`, c.player_favorite_loss_rate_pct])),
    ...Object.fromEntries(r.value.failure_conditions.map(c => [`${c.condition}_opponent_reproduction_rate_pct`, c.opponent_reproduction_rate_pct])),
  });
  const n = (a.status === "GO" ? a.n : 0) + (b.status === "GO" ? b.n : 0);
  return { p1Value: fmtSide(a), p2Value: fmtSide(b), p1Treatment: a.status === "GO" ? "RECONSTRUCTED" : "UNAVAILABLE", p2Treatment: b.status === "GO" ? "RECONSTRUCTED" : "UNAVAILABLE", n };
}

/**
 * 044, similarly directional: each player's own underdog-win history
 * compared against the OTHER player (as today's favorite).
 */
function opponentUpsetCompatibility044(p1: string, p2: string, lane: TourLane, asOfDate: string, surface: string | null): FoundValues {
  const a = computeOpponentUpsetCompatibility({ player: p1, todaysFavorite: p2, lane, asOfDate, todaysMatchSurface: surface });
  const b = computeOpponentUpsetCompatibility({ player: p2, todaysFavorite: p1, lane, asOfDate, todaysMatchSurface: surface });
  if (a.status !== "GO" && b.status !== "GO") return null;
  const fmtSide = (r: typeof a) => r.status !== "GO" ? `status=NOT_ENOUGH_DATA; reason=${r.reason}` : fmt({
    trailing_underdog_wins_n: r.value.underdog_win_profile.trailing_underdog_wins_used,
    avg_upset_opponent_quality_elo: r.value.underdog_win_profile.avg_upset_opponent_quality_elo,
    took_set_1_rate_pct: r.value.underdog_win_profile.took_set_1_rate_pct,
    deciding_set_rate_pct: r.value.underdog_win_profile.deciding_set_rate_pct,
    tiebreak_factor_rate_pct: r.value.underdog_win_profile.tiebreak_factor_rate_pct,
    todays_favorite_elo: r.value.todays_favorite_elo,
    elo_gap_to_avg_upset_opponent: r.value.elo_gap_to_avg_upset_opponent,
    surface_match_rate_pct: r.value.surface_match_rate_pct,
    excluded_similarity_dimensions_n: r.value.excluded_similarity_dimensions.length,
  });
  const n = (a.status === "GO" ? a.n : 0) + (b.status === "GO" ? b.n : 0);
  return { p1Value: fmtSide(a), p2Value: fmtSide(b), p1Treatment: a.status === "GO" ? "RECONSTRUCTED" : "UNAVAILABLE", p2Treatment: b.status === "GO" ? "RECONSTRUCTED" : "UNAVAILABLE", n };
}

/**
 * Live wrapper for the deterministic-*-metrics.server.ts tier chain in
 * warehouse-first-researcher.server.ts. Returns null (fall through to the
 * market tier, then the rest of the pipeline) unless AT LEAST ONE player
 * resolves to a GO lane outcome -- unlike the batch1/batch2 tiers (which
 * require both players GO on the same symmetric metric), 043/044 are
 * inherently per-player/directional, so a one-sided real GO result is still
 * a real, non-fabricated finding worth surfacing; the other side reports
 * its own honest NOT_ENOUGH_DATA reason rather than being suppressed.
 */
export async function deterministicBatch4FavoriteUnderdogPatterns(args: { metricCode: string; p1: string; p2: string; asOfDate: string; tourFamily?: EvidenceTourFamily | null; surface?: string | null }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (!OWNED.has(code)) return null;
  const lane = args.tourFamily as TourLane | null | undefined;
  if (!lane) return null;
  const { p1, p2, asOfDate, surface = null } = args;
  let found: FoundValues = null;
  let evidenceFamily = "";
  try {
    if (code === "043") { found = favoriteFailureMode043(p1, p2, lane, asOfDate, surface); evidenceFamily = "STANDALONE_FAVORITE_FAILURE_MODE"; }
    else if (code === "044") { found = opponentUpsetCompatibility044(p1, p2, lane, asOfDate, surface); evidenceFamily = "STANDALONE_OPPONENT_UPSET_COMPATIBILITY"; }
  } catch {
    return null; // malformed/unavailable static-index lane falls through, never crashes or fabricates
  }
  // The two helpers above already return null (fall through entirely) when
  // BOTH sides are NOT_ENOUGH_DATA, so `found` here always has at least one
  // side GO -- p1Treatment/p2Treatment are never both "UNAVAILABLE".
  if (!found) return null;
  const oneSided = found.p1Treatment === "UNAVAILABLE" || found.p2Treatment === "UNAVAILABLE";
  return certifyMetricFinding({
    metric_code: code,
    p1_value: found.p1Value,
    p2_value: found.p2Value,
    p1_treatment: found.p1Treatment,
    p2_treatment: found.p2Treatment,
    differential: null,
    evidence_family: evidenceFamily,
    reliability: 78,
    sample: `standalone metric #${code} deterministic replay through ${asOfDate}; tour_lane=${lane}; n=${found.n}`,
    unavailable_reason: oneSided ? "One side has no qualifying favorite-role loss / verified underdog-win history in this lane before asOfDate -- see that side's own value text for the specific reason." : null,
    sources: [{ source_name: "Four-tour static history index (data/generated/tennis-runtime-index.json)", url: null, retrieved_at: null }],
  });
}
