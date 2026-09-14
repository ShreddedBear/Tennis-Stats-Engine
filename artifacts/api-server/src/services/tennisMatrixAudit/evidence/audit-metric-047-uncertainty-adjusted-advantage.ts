// Metric #047 -- Uncertainty-Adjusted Advantage (Confidence-Interval-Adjusted Metric
// Comparison)
// (docs/audit-task-047-061-classification-decisions.md; public/seed/metrics.txt #47)
//
// Classification decision (see metric-classification.ts): this code sat in the
// UNKNOWN_REQUIRES_REVIEW holding pattern because it was genuinely ambiguous whether
// "comparing two players' own statistics with confidence intervals applied" was a player
// fact or a meta-method for weighing other metrics' outputs. The human decision made is
// that it IS a legitimate player-comparison fact: applying statistical rigor to a
// comparison of two players' own numbers is itself a fact about the two players (how
// well-supported their apparent edge on some other metric actually is), not a judgment
// about this system's own prediction or evidence base -- unlike 048/049/050/056/057/058/059,
// which are all genuinely about the model/prediction/evidence process itself. So 047 is
// built here as a real engine and removed from the UNKNOWN registry (see
// metric-classification.ts's diff for this task).
//
// Statistical method: a two-sample (two-proportion) Wald z-test for the difference between
// two independent binomial rates -- the standard textbook approach for asking "is the
// apparent gap between two observed rates distinguishable from sampling noise, given each
// side's own sample size?" (see e.g. Newcombe, R.G. (1998), "Interval estimation for the
// difference between independent proportions", Statistics in Medicine 17(8); or any
// introductory-statistics two-proportion z-test / CI treatment). Given rate1 (%) over n1
// trials and rate2 (%) over n2 trials:
//   p1 = rate1/100, p2 = rate2/100
//   SE = sqrt( p1*(1-p1)/n1 + p2*(1-p2)/n2 )     (unpooled Wald standard error)
//   z  = (p1 - p2) / SE
//   95% CI on the difference = (p1-p2) +/- 1.96 * SE
// A difference is reported WELL_SUPPORTED_EDGE only when the 95% CI on the difference
// excludes zero (|z| >= 1.96, two-tailed p < 0.05) -- exactly the point of the metric's own
// definition: "so a small uncertain edge isn't weighted the same as a large well-supported
// one." The normal approximation underlying a Wald test needs a reasonably-sized sample
// per side (the common rule of thumb is n*p*(1-p) not too small); this module additionally
// requires MIN_N_PER_SIDE observations on EACH side before it will report any verdict at
// all -- below that, the comparison is honestly skipped as INSUFFICIENT_SAMPLE rather than
// computed with a misleadingly precise but statistically unreliable interval.
//
// Scope (first pass, deliberately bounded rather than run across all 60 metrics): 047 is a
// meta-layer OVER another metric's own P1/P2 comparison, so it needs a base metric that
// already produces, for BOTH players independently, a clean {rate_pct, n} pair on the exact
// same dimension. Covered in this first pass:
//   - metric #027 (Opponent Finishing Ability) -- audit-metric-027-opponent-finishing-
//     ability.ts's computeOpponentFinishingAbility already returns exactly this shape on two
//     dimensions: lead_protection (win-rate after taking set 1) and closing_as_underdog
//     (win-rate after losing set 1), each with an explicit, unambiguous n. Both dimensions
//     are covered here. Same lane restriction as #027 itself (WTA_MAIN/ATP_CHALLENGER only
//     -- set_scores schema gap on ATP_MAIN/WTA_CHALLENGER).
// Deliberately OUT OF SCOPE for this first pass (documented, not silently skipped):
//   - metric #044's underdog-win-profile rates (took_set_1_rate_pct, deciding_set_rate_pct,
//     tiebreak_factor_rate_pct) expose a rate but not the exact denominator behind it (each
//     rate is computed over a `withSets` subset of `trailing_underdog_wins_used` that
//     computeUnderdogWinProfile does not surface separately) -- using
//     `trailing_underdog_wins_used` as a stand-in n would overstate precision. Left for a
//     future pass that extends that module's return shape to expose the real per-rate n,
//     rather than approximated here.
//   - metric #051's opponent-specific probability is a single shrunk estimate, not two
//     independent samples: P1's raw H2H win rate and P2's are complementary numbers over the
//     exact same shared meetings (P2's rate = 100 - P1's rate), not independent draws -- a
//     two-proportion test assumes independence and does not apply to a mirrored pair.
//   - Hold%/break% aggregates (metrics 002/003) do not have a single clean {rate,n} accessor
//     in this codebase yet -- their PBP-derived values are folded directly into a formatted
//     value string in pbp-score-state-recovery.ts rather than exposed as a {rate,n} pair. A
//     future pass could add this once that module exposes the raw counts.
import { round1, type LaneOutcome, type TourLane } from "./audit-metrics-shared";
import { computeOpponentFinishingAbility, type FinishingAbilityResult } from "./audit-metric-027-opponent-finishing-ability";

// Minimum observations required on EACH side before a two-proportion comparison is even
// attempted. Conservative floor for the normal approximation the Wald z-test relies on to
// stay reasonably valid; below this, a computed CI would carry a false sense of precision.
export const MIN_N_PER_SIDE = 10;
const Z_95 = 1.96;

export type UncertaintyVerdict = "WELL_SUPPORTED_EDGE" | "NOT_STATISTICALLY_DISTINGUISHABLE";

export interface TwoProportionTestResult {
  p1_rate_pct: number;
  p1_n: number;
  p2_rate_pct: number;
  p2_n: number;
  rate_differential_pct: number; // p1 - p2
  ci95_lower_pct: number;
  ci95_upper_pct: number;
  z_score: number | null; // null only in the degenerate zero-variance case (see below)
  significant_at_95: boolean;
  verdict: UncertaintyVerdict;
}

/**
 * Pure core: two-sample Wald z-test for the difference between two independent binomial
 * rates. Callers are responsible for the MIN_N_PER_SIDE gate (this function will still
 * compute a mathematically valid result below that threshold -- it is not itself the
 * honesty gate, see computeUncertaintyAdjustedAdvantage below for where that is enforced).
 */
export function twoProportionZTest(p1RatePct: number, n1: number, p2RatePct: number, n2: number): TwoProportionTestResult {
  const p1 = p1RatePct / 100, p2 = p2RatePct / 100;
  const variance = (p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2;
  const se = Math.sqrt(Math.max(variance, 0));
  const diff = p1 - p2;
  // se===0 is the degenerate case where both sides' observed rate is exactly 0% or 100%
  // (zero binomial variance at the boundary) -- the Wald formula's z is undefined there
  // (0/0 or a division by zero), so it is reported honestly as z_score=null rather than a
  // fabricated +/-Infinity; the CI still collapses to the point estimate, which is accurate
  // for a boundary case, just not usable as a hypothesis-test statistic.
  const z = se > 0 ? diff / se : null;
  const marginPct = round1(Z_95 * se * 100)!;
  const diffPct = round1(diff * 100)!;
  const significant = z !== null ? Math.abs(z) >= Z_95 : diff !== 0;
  return {
    p1_rate_pct: p1RatePct,
    p1_n: n1,
    p2_rate_pct: p2RatePct,
    p2_n: n2,
    rate_differential_pct: diffPct,
    ci95_lower_pct: round1(diffPct - marginPct)!,
    ci95_upper_pct: round1(diffPct + marginPct)!,
    z_score: z === null ? null : round1(z),
    significant_at_95: significant,
    verdict: significant ? "WELL_SUPPORTED_EDGE" : "NOT_STATISTICALLY_DISTINGUISHABLE",
  };
}

export type FinishingAbilityDimension = "lead_protection" | "closing_as_underdog";
const DIMENSIONS: FinishingAbilityDimension[] = ["lead_protection", "closing_as_underdog"];

export interface DimensionComparison {
  base_metric_code: "027";
  dimension: FinishingAbilityDimension;
  test: TwoProportionTestResult | null;
  skipped_reason: string | null;
}

export interface UncertaintyAdjustedAdvantageResult {
  dimensions: DimensionComparison[];
}

function dimensionSide(result: FinishingAbilityResult, dimension: FinishingAbilityDimension) {
  return dimension === "lead_protection" ? result.lead_protection : result.closing_as_underdog;
}

/**
 * Live wrapper: runs #027's finishing-ability engine for BOTH players in the same lane, then
 * applies the confidence-interval-adjusted two-proportion test to each of the two dimensions
 * #027 exposes. GO requires at least one dimension to have MIN_N_PER_SIDE+ observations on
 * BOTH sides; a dimension that doesn't qualify is reported with skipped_reason rather than
 * silently dropped or computed anyway.
 */
export function computeUncertaintyAdjustedAdvantage(args: {
  p1: string;
  p2: string;
  lane: TourLane;
  asOfDate: string;
  trailingN?: number;
}): LaneOutcome<UncertaintyAdjustedAdvantageResult> {
  const { p1, p2, lane, asOfDate, trailingN } = args;
  const a = computeOpponentFinishingAbility({ player: p1, lane, asOfDate, trailingN });
  const b = computeOpponentFinishingAbility({ player: p2, lane, asOfDate, trailingN });
  if (a.status !== "GO" || b.status !== "GO") {
    const failing = a.status !== "GO" ? "P1" : "P2";
    const reason = a.status !== "GO" ? a.reason : (b as { reason: string }).reason;
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `Base metric #027 (Opponent Finishing Ability) requires BOTH players to have a GO result for a two-sample comparison; ${failing}: ${reason}` };
  }

  const dimensions: DimensionComparison[] = DIMENSIONS.map((dimension) => {
    const sideA = dimensionSide(a.value, dimension);
    const sideB = dimensionSide(b.value, dimension);
    if (sideA.rate === null || sideB.rate === null || sideA.n < MIN_N_PER_SIDE || sideB.n < MIN_N_PER_SIDE) {
      return {
        base_metric_code: "027",
        dimension,
        test: null,
        skipped_reason: `Insufficient sample for a reliable normal-approximation CI (need >= ${MIN_N_PER_SIDE} observations per side; have P1 n=${sideA.n}, P2 n=${sideB.n}).`,
      };
    }
    return { base_metric_code: "027", dimension, test: twoProportionZTest(sideA.rate, sideA.n, sideB.rate, sideB.n), skipped_reason: null };
  });

  if (dimensions.every((d) => d.test === null)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Neither finishing-ability dimension has enough sample on both sides for a reliable CI-adjusted comparison (see per-dimension skipped_reason)." };
  }
  return { lane, status: "GO", n: Math.min(a.n, b.n), value: { dimensions } };
}
