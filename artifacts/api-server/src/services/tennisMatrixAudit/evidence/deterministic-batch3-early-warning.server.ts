// Wires metric 026 (Early-Warning / Slow-Start Metrics) into the LIVE researcher
// pipeline. Unlike the batch1/batch2 modules (deterministic-batch1-standalone-
// metrics.server.ts, deterministic-batch2-new-metrics.server.ts), which are pure,
// cheap replays over the already-in-memory static history index, 026's cross-match
// aggregation (audit-metric-026-early-warning-slow-start.ts) makes real live BSD PBP
// fetches for a player's own past matches -- the same cost profile as the four
// bsd-*-pbp.server.ts context builders. It is therefore tried in warehouse-first-
// researcher.server.ts's live-fetch tier (alongside those builders), never in the
// cheap deterministic chain ahead of it.
import type { EvidenceTourFamily } from "./evidence-match-identity";
import type { MetricFinding } from "./audit-pipeline";
import { certifyMetricFinding } from "./metric-certification";
import type { TourLane } from "./audit-metrics-shared";
import { computeSlowStartRecovery, type SlowStartRecoveryResult } from "./audit-metric-026-early-warning-slow-start";

const OWNED = new Set(["026"]);

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
function fmtSide(r: SlowStartRecoveryResult): string {
  return `pbp_covered_matches_examined=${r.pbp_covered_matches_examined}; slow_start_matches=${r.slow_start_matches}; slow_start_matches_won=${r.slow_start_matches_won}; slow_start_recovery_rate_pct=${r.slow_start_recovery_rate_pct ?? "NA"}; non_slow_start_win_rate_pct=${r.non_slow_start_win_rate_pct ?? "NA"}`;
}

/**
 * Live wrapper for warehouse-first-researcher.server.ts's live-fetch tier. Returns null
 * (fall through to the next tier) unless BOTH players resolve to a GO cross-match
 * slow-start-recovery outcome for the resolved tour lane. Never fabricates: a lane this
 * module structurally cannot support (WTA_CHALLENGER) or a player without enough
 * PBP-covered slow-start instances always falls through here.
 */
export async function deterministicBatch3EarlyWarningMetric(args: { metricCode: string; p1: string; p2: string; asOfDate: string; tourFamily?: EvidenceTourFamily | null }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (!OWNED.has(code)) return null;
  const lane = args.tourFamily as TourLane | null | undefined;
  if (!lane) return null;
  const { p1, p2, asOfDate } = args;
  let a: Awaited<ReturnType<typeof computeSlowStartRecovery>>, b: Awaited<ReturnType<typeof computeSlowStartRecovery>>;
  try {
    [a, b] = await Promise.all([
      computeSlowStartRecovery({ player: p1, lane, asOfDate }),
      computeSlowStartRecovery({ player: p2, lane, asOfDate }),
    ]);
  } catch {
    return null; // a live-fetch failure/outage falls through, never crashes or fabricates
  }
  if (a.status !== "GO" || b.status !== "GO") return null;
  return certifyMetricFinding({
    metric_code: code,
    p1_value: fmtSide(a.value),
    p2_value: fmtSide(b.value),
    p1_treatment: "RECONSTRUCTED",
    p2_treatment: "RECONSTRUCTED",
    differential: null,
    evidence_family: "STANDALONE_EARLY_WARNING_SLOW_START",
    reliability: 74,
    sample: `metric #026 cross-match slow-start-recovery through ${asOfDate}; tour_lane=${lane}; p1_n=${a.n}; p2_n=${b.n}`,
    unavailable_reason: null,
    sources: [{ source_name: "Approved BSD four-tour point-by-point (within-match) + static history index (match outcome ground truth)", url: null, retrieved_at: null }],
  });
}
