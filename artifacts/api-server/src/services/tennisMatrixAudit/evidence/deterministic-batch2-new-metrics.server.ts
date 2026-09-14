// Wires the four newly-built (this task) standalone audit-metric modules --
// 020 (Level/Tour Transition), 036 (Loss Autopsy Metrics), 045 (Favorite
// Fragility Under Resistance), and 052 (Entropy & Lead Durability) -- into
// the LIVE researcher pipeline. Same reconnection pattern as
// deterministic-batch1-standalone-metrics.server.ts (which wires the
// earlier 027/031/041/046/051 batch): adapts each module's LaneOutcome<T>
// into this app's MetricFinding shape, GO on both players -> a real
// certified finding, anything else -> null (fall through to the next
// tier). No fabrication: a lane a module structurally cannot support
// (missing set_scores, etc.) always falls through here, never gets a
// guessed value.
import type { EvidenceTourFamily } from "./evidence-match-identity";
import type { MetricFinding } from "./audit-pipeline";
import { certifyMetricFinding } from "./metric-certification";
import type { TourLane } from "./audit-metrics-shared";
import { computeLevelTourTransition } from "./audit-metric-020-level-tour-transition";
import { computeLossAutopsy } from "./audit-metric-036-loss-autopsy";
import { computeFavoriteFragility } from "./audit-metric-045-favorite-fragility";
import { computeEntropyLeadDurability } from "./audit-metric-052-entropy-lead-durability";

const OWNED = new Set(["020", "036", "045", "052"]);

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
function fmt(obj: Record<string, unknown>): string {
  return Object.entries(obj).map(([k, v]) => `${k}=${v === null || v === undefined ? "NA" : v}`).join("; ");
}

type FoundValues = { p1Value: string; p2Value: string; n: number } | null;

function levelTourTransition020(p1: string, p2: string, lane: TourLane, asOfDate: string): FoundValues {
  const a = computeLevelTourTransition({ player: p1, lane, asOfDate });
  const b = computeLevelTourTransition({ player: p2, lane, asOfDate });
  if (a.status !== "GO" || b.status !== "GO") return null;
  const fmtSide = (r: typeof a.value) => fmt({
    matches_used: r.matches_used,
    ...Object.fromEntries(r.elo_differential_bands.map(band => [`elo_band_${band.band.toLowerCase()}_win_pct`, band.win_rate])),
    following_strong_tournament_win_pct: r.following_strong_tournament.win_rate,
    following_weak_tournament_win_pct: r.following_weak_tournament.win_rate,
  });
  return { p1Value: fmtSide(a.value), p2Value: fmtSide(b.value), n: Math.min(a.n, b.n) };
}

function lossAutopsy036(p1: string, p2: string, lane: TourLane, asOfDate: string): FoundValues {
  const a = computeLossAutopsy({ player: p1, lane, asOfDate });
  const b = computeLossAutopsy({ player: p2, lane, asOfDate });
  if (a.status !== "GO" || b.status !== "GO") return null;
  const fmtSide = (r: typeof a.value) => fmt({
    trailing_losses_used: r.trailing_losses_used,
    favorite_losses_n: r.favorite_losses_n,
    favorite_losses_rate_pct: r.favorite_losses_rate_pct,
    bad_loss_severity_index: r.bad_loss_severity_index,
    set_sequence_available: r.set_sequence_available,
  });
  return { p1Value: fmtSide(a.value), p2Value: fmtSide(b.value), n: Math.min(a.n, b.n) };
}

function favoriteFragility045(p1: string, p2: string, lane: TourLane, asOfDate: string): FoundValues {
  const a = computeFavoriteFragility({ player: p1, lane, asOfDate });
  const b = computeFavoriteFragility({ player: p2, lane, asOfDate });
  if (a.status !== "GO" || b.status !== "GO") return null;
  const fmtSide = (r: typeof a.value) => fmt({
    eligible_matches_n: r.eligible_matches_n,
    first_set_tiebreak_n: r.first_set_tiebreak.n,
    first_set_tiebreak_win_pct: r.first_set_tiebreak.win_rate,
    forced_deciding_set_n: r.forced_deciding_set.n,
    forced_deciding_set_win_pct: r.forced_deciding_set.win_rate,
  });
  return { p1Value: fmtSide(a.value), p2Value: fmtSide(b.value), n: Math.min(a.n, b.n) };
}

function entropyLeadDurability052(p1: string, p2: string, lane: TourLane, asOfDate: string): FoundValues {
  const a = computeEntropyLeadDurability({ player: p1, lane, asOfDate });
  const b = computeEntropyLeadDurability({ player: p2, lane, asOfDate });
  if (a.status !== "GO" || b.status !== "GO") return null;
  const fmtSide = (r: typeof a.value) => fmt({
    sets_n: r.sets_n,
    set_score_entropy_bits: r.set_score_entropy_bits,
    game_score_entropy_bits: r.game_score_entropy_bits,
    distinct_set_scores: r.distinct_set_scores,
  });
  return { p1Value: fmtSide(a.value), p2Value: fmtSide(b.value), n: Math.min(a.n, b.n) };
}

/**
 * Live wrapper for the deterministic-*-metrics.server.ts tier chain in
 * warehouse-first-researcher.server.ts. Returns null (fall through) unless
 * BOTH players resolve to a GO lane outcome.
 */
export async function deterministicBatch2NewMetric(args: { metricCode: string; p1: string; p2: string; asOfDate: string; tourFamily?: EvidenceTourFamily | null }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (!OWNED.has(code)) return null;
  const lane = args.tourFamily as TourLane | null | undefined;
  if (!lane) return null;
  const { p1, p2, asOfDate } = args;
  let found: FoundValues = null;
  let evidenceFamily = "";
  try {
    if (code === "020") { found = levelTourTransition020(p1, p2, lane, asOfDate); evidenceFamily = "STANDALONE_LEVEL_TOUR_TRANSITION"; }
    else if (code === "036") { found = lossAutopsy036(p1, p2, lane, asOfDate); evidenceFamily = "STANDALONE_LOSS_AUTOPSY"; }
    else if (code === "045") { found = favoriteFragility045(p1, p2, lane, asOfDate); evidenceFamily = "STANDALONE_FAVORITE_FRAGILITY"; }
    else if (code === "052") { found = entropyLeadDurability052(p1, p2, lane, asOfDate); evidenceFamily = "STANDALONE_ENTROPY_LEAD_DURABILITY"; }
  } catch {
    return null; // malformed/unavailable static-index lane falls through, never crashes or fabricates
  }
  if (!found) return null;
  return certifyMetricFinding({
    metric_code: code,
    p1_value: found.p1Value,
    p2_value: found.p2Value,
    p1_treatment: "RECONSTRUCTED",
    p2_treatment: "RECONSTRUCTED",
    differential: null,
    evidence_family: evidenceFamily,
    reliability: 78,
    sample: `standalone metric #${code} deterministic replay through ${asOfDate}; tour_lane=${lane}; n=${found.n}`,
    unavailable_reason: null,
    sources: [{ source_name: "Four-tour static history index (data/generated/tennis-runtime-index.json)", url: null, retrieved_at: null }],
  });
}
