// Wires the two classification-decision resolutions (this task) into the LIVE researcher
// pipeline -- 047 (Uncertainty-Adjusted Advantage) and 061 (Historical Twin Match Search) --
// same reconnection pattern as deterministic-batch4-favorite-underdog-patterns.server.ts:
// adapts each module's LaneOutcome<T> into this app's MetricFinding shape, GO -> a real
// certified finding, NOT_ENOUGH_DATA -> null (fall through to the next tier). No
// fabrication: a lane/player pair either sub-engine cannot support (insufficient sample,
// missing set-sequence data, no Elo history, etc.) always falls through here, never gets a
// guessed value.
//
// docs/audit-task-047-061-classification-decisions.md documents the full classification
// resolution: 047 was moved out of UNKNOWN_REQUIRES_REVIEW into ordinary
// LEGITIMATE_PLAYER_METRIC status and given a real engine (audit-metric-047-uncertainty-
// adjusted-advantage.ts); 061 was split into a real Historical Twin Match Search piece
// (audit-metric-061-historical-twin-match-search.ts, also moved to LEGITIMATE_PLAYER_METRIC)
// and a permanently-excluded counterfactual/opponent-upgrade-rerun component that is not
// given any metric code at all (see that module's header).
//
// Wiring precedence: this tier is placed in the same deterministic chain as batch4, after
// it (043/044 take priority for their own codes; there is no overlap in owned codes between
// the two tiers). Both 047 and 061 are synchronous, static-index-only replays, same
// contract as every other module in this family of tiers.
import type { EvidenceTourFamily } from "./evidence-match-identity";
import type { MetricFinding } from "./audit-pipeline";
import { certifyMetricFinding } from "./metric-certification";
import type { TourLane } from "./audit-metrics-shared";
import { computeUncertaintyAdjustedAdvantage, type DimensionComparison } from "./audit-metric-047-uncertainty-adjusted-advantage";
import { computeHistoricalTwinMatchSearchForLane } from "./audit-metric-061-historical-twin-match-search";

const OWNED = new Set(["047", "061"]);

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}

function fmtDimension(d: DimensionComparison): string {
  if (!d.test) return `dimension=${d.dimension}: status=SKIPPED; reason=${d.skipped_reason}`;
  const t = d.test;
  return `dimension=${d.dimension}: p1_rate_pct=${t.p1_rate_pct} (n=${t.p1_n}); p2_rate_pct=${t.p2_rate_pct} (n=${t.p2_n}); rate_differential_pct=${t.rate_differential_pct}; ci95=[${t.ci95_lower_pct}, ${t.ci95_upper_pct}]; z_score=${t.z_score ?? "NA"}; verdict=${t.verdict}`;
}

/**
 * 047 is inherently a joint P1-vs-P2 fact (a confidence-interval-adjusted comparison of the
 * two players' own rates on the same underlying dimension) -- both sides report the exact
 * same symmetric text, same convention as the Historical Twin Match Search result below and
 * as evidence-gap.ts's own definition of the metric (a comparison, not a per-player value).
 */
async function uncertaintyAdjustedAdvantage047(p1: string, p2: string, lane: TourLane, asOfDate: string): Promise<MetricFinding | null> {
  const result = computeUncertaintyAdjustedAdvantage({ p1, p2, lane, asOfDate });
  if (result.status !== "GO") return null;
  const value = result.value.dimensions.map(fmtDimension).join("; ");
  return certifyMetricFinding({
    metric_code: "047",
    p1_value: value,
    p2_value: value,
    p1_treatment: "RECONSTRUCTED",
    p2_treatment: "RECONSTRUCTED",
    differential: null,
    evidence_family: "STANDALONE_UNCERTAINTY_ADJUSTED_ADVANTAGE",
    reliability: 80,
    sample: `standalone metric #047 CI-adjusted comparison over metric #027 (Opponent Finishing Ability) dimensions; two-sample Wald z-test; tour_lane=${lane}; n=${result.n}`,
    unavailable_reason: null,
    sources: [{ source_name: "Four-tour static history index (data/generated/tennis-runtime-index.json)", url: null, retrieved_at: null }],
  });
}

async function historicalTwinMatchSearch061(p1: string, p2: string, lane: TourLane, asOfDate: string, surface: string | null): Promise<MetricFinding | null> {
  const result = computeHistoricalTwinMatchSearchForLane({ p1, p2, lane, asOfDate, surface });
  if (result.status !== "GO") return null;
  const { p1_value, p2_value, differential, sample, reliability, sources } = result.value;
  return certifyMetricFinding({
    metric_code: "061",
    p1_value,
    p2_value,
    p1_treatment: "RECONSTRUCTED",
    p2_treatment: "RECONSTRUCTED",
    differential,
    evidence_family: "STANDALONE_HISTORICAL_TWIN_MATCH_SEARCH",
    reliability,
    sample,
    unavailable_reason: null,
    sources,
  });
}

export async function deterministicBatch5NewMetrics(args: { metricCode: string; p1: string; p2: string; asOfDate: string; tourFamily?: EvidenceTourFamily | null; surface?: string | null }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (!OWNED.has(code)) return null;
  const lane = args.tourFamily as TourLane | null | undefined;
  if (!lane) return null;
  const { p1, p2, asOfDate, surface = null } = args;
  try {
    if (code === "047") return await uncertaintyAdjustedAdvantage047(p1, p2, lane, asOfDate);
    if (code === "061") return await historicalTwinMatchSearch061(p1, p2, lane, asOfDate, surface);
  } catch {
    return null; // malformed/unavailable static-index lane falls through, never crashes or fabricates
  }
  return null;
}
