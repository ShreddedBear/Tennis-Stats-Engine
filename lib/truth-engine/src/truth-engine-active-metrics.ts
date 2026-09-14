import { COMPARISON_SPECS } from "./truth-engine-metric-comparison";
import { classifyMetricActivation, type MetricActivationForMatch } from "./metric-activation-status";

// THE ACTIVE TRUTH ENGINE METRIC SET — one definition, derived, never typed out.
//
// Two different denominators were being conflated in the audit UI, which is what made
// "P1 METRIC EXECUTION 51/81" misleading:
//
//   PROCESSING PROGRESS (x/81) — how many of the run's metric_results rows the processor
//   has TREATED for one side. All 81 defined codes are still instantiated and still
//   executed; a row counts as treated even when it ends UNAVAILABLE. This is a throughput
//   number, and it is also the P2 resume cursor, so it is deliberately left alone.
//
//   ACTIVE TRUTH ENGINE EVIDENCE (x/25) — how many of the codes that actually GRADE a match
//   produced genuinely usable, two-sided evidence. This is the readiness number.
//
// The denominator is the key set of COMPARISON_SPECS rather than a literal 25, because
// those specs are what the comparison layer actually uses to grade. Deriving it means the
// two can never drift: promoting a metric by adding its spec moves this denominator to 26
// in the same commit, and nothing else has to be edited. There is no "25" constant here.
//
// The other 56 codes are NOT excluded from the system by any of this. They stay in the
// processing universe, keep executing, and keep their evidence; they simply are not part of
// the graded set until a spec exists for them.
export const ACTIVE_METRIC_CODES: readonly string[] = Object.keys(COMPARISON_SPECS).sort();

export function isActiveMetricCode(code: string | null | undefined) {
  return ACTIVE_METRIC_CODES.includes(normalizeMetricCode(code));
}

export function normalizeMetricCode(code: string | null | undefined) {
  const match = String(code ?? "").match(/(\d{1,3})$/);
  return match ? match[1].padStart(3, "0") : String(code ?? "").padStart(3, "0");
}

/** Treatments that represent evidence the engine may actually read. */
const USABLE_TREATMENTS = ["DIRECT", "RECONSTRUCTED", "PARTIAL"];

export interface MetricRowForReadiness {
  metric_code?: string | null;
  p1_treatment?: string | null;
  p2_treatment?: string | null;
  p1_value?: string | null;
  p2_value?: string | null;
  /** Already-persisted machine-readable reasons (metricPairPatch's UnavailableReason). */
  p1_unavailable_reason?: string | null;
  p2_unavailable_reason?: string | null;
}

export type ActiveMetricOutcome = "USABLE_TWO_SIDED" | "ONE_SIDED" | "UNAVAILABLE" | "NOT_EXECUTED";

export interface ActiveMetricReadiness {
  /** The active-set denominator, from the registry -- never a hardcoded number. */
  expected: number;
  /** Active codes whose evidence is usable on BOTH sides. Nothing else counts. */
  usable: number;
  /** Present for exactly one player. Real evidence, but it cannot create a lean. */
  oneSided: number;
  /** Executed and honestly reported as having no usable evidence on either side. */
  unavailable: number;
  /** Active codes with no row in this run at all. */
  notExecuted: number;
  /** usable / expected(25) -- the ORIGINAL, unchanged, fixed-denominator readiness number. */
  percent: number;
  /**
   * How many of the 25 are legitimately eligible FOR THIS MATCH: `expected` minus codes
   * where BOTH sides independently landed on an evidence-based absence (see
   * metric-activation-status.ts's DENOMINATOR_EXCUSED_STATUSES) -- never a metric merely
   * NOT_EXECUTED or broken by a real pipeline bug, which stay counted as misses.
   */
  eligible: number;
  /** usable / eligible -- the DYNAMIC, per-match coverage number this task adds. */
  eligiblePercent: number;
  byCode: Array<{ code: string; outcome: ActiveMetricOutcome; activation: MetricActivationForMatch }>;
}

function sideUsable(treatment: string | null | undefined, value: string | null | undefined) {
  // A usable treatment with no value behind it is not evidence. This mirrors the backing
  // check audit-engine.ts's coverageFor() already applies, so the two agree.
  return USABLE_TREATMENTS.includes(String(treatment ?? "")) && Boolean(String(value ?? "").trim());
}

/**
 * Readiness of the ACTIVE set for one run.
 *
 * `codes` is injectable purely so promotion can be tested without mutating the real
 * registry; production callers use the default.
 *
 * Nothing here converts a non-success into a success: UNAVAILABLE, NO_SOURCE, EXCLUDED, a
 * missing row, a treatment with no value behind it, and one-sided evidence are all counted
 * as what they are. Only both-sides-usable increments `usable`.
 */
export function activeMetricReadiness(
  rows: readonly MetricRowForReadiness[],
  codes: readonly string[] = ACTIVE_METRIC_CODES,
): ActiveMetricReadiness {
  const byCode = new Map<string, MetricRowForReadiness>();
  for (const row of rows) {
    const code = normalizeMetricCode(row.metric_code);
    // Keep the most complete row if a code somehow appears twice, rather than last-wins.
    const existing = byCode.get(code);
    if (!existing) byCode.set(code, row);
    else if (sideUsable(row.p1_treatment, row.p1_value) || sideUsable(row.p2_treatment, row.p2_value)) byCode.set(code, row);
  }

  const outcomes = codes.map((code) => {
    const row = byCode.get(code);
    const activation = classifyMetricActivation(
      code,
      { executed: Boolean(row), treatment: row?.p1_treatment, value: row?.p1_value, reason: row?.p1_unavailable_reason },
      { executed: Boolean(row), treatment: row?.p2_treatment, value: row?.p2_value, reason: row?.p2_unavailable_reason },
    );
    if (!row) return { code, outcome: "NOT_EXECUTED" as const, activation };
    const p1 = sideUsable(row.p1_treatment, row.p1_value);
    const p2 = sideUsable(row.p2_treatment, row.p2_value);
    if (p1 && p2) return { code, outcome: "USABLE_TWO_SIDED" as const, activation };
    if (p1 || p2) return { code, outcome: "ONE_SIDED" as const, activation };
    return { code, outcome: "UNAVAILABLE" as const, activation };
  });

  const count = (outcome: ActiveMetricOutcome) => outcomes.filter((entry) => entry.outcome === outcome).length;
  const usable = count("USABLE_TWO_SIDED");
  const eligible = outcomes.filter((entry) => entry.activation.countsTowardDenominator).length;
  return {
    expected: codes.length,
    usable,
    eligible,
    eligiblePercent: eligible > 0 ? Number(((usable / eligible) * 100).toFixed(1)) : 0,
    oneSided: count("ONE_SIDED"),
    unavailable: count("UNAVAILABLE"),
    notExecuted: count("NOT_EXECUTED"),
    percent: codes.length > 0 ? Number(((usable / codes.length) * 100).toFixed(1)) : 0,
    byCode: outcomes,
  };
}
