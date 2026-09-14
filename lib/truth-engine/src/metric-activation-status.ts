// METRIC ACTIVATION STATUS -- machine-readable classification of WHY each side of each
// active metric ended up where it did, and whether that reason legitimately excuses the
// match from counting that metric in its evidence-coverage denominator.
//
// This is a pure, read-side classifier over fields the pipeline ALREADY persists
// (metric_results.p1_unavailable_reason/p2_unavailable_reason, whose values are the
// UnavailableReason enum audit-pipeline.ts's metricPairPatch already computes and writes).
// No schema change, no new column, no change to what gets persisted -- it only interprets
// what is already there into the coarser, decision-relevant taxonomy this audit needs.
//
// Two questions this answers for every (metric, side):
//   1. ActivationStatus -- the specific, named reason (for the audit trail).
//   2. Whether that status legitimately excuses this match from the metric's denominator
//      (countsAgainstCoverage: false) or is a real miss that should still be counted as a
//      failure to fix (countsAgainstCoverage: true).
//
// The three EXCUSED statuses (SOURCE_EMPTY, INSUFFICIENT_SAMPLE, GENUINELY_UNAVAILABLE) are
// only ever reached AFTER a genuine, evidenced attempt found nothing -- never assumed in
// advance, never used to avoid trying. That is what keeps a dynamic denominator honest
// rather than a way to make a low coverage number look better: nothing here removes a
// metric from the denominator until the pipeline has actually asked and gotten a real
// "there is nothing" answer.

export type ActivationStatus =
  | "ACTIVATED"
  | "RETRYING"
  | "NOT_ATTEMPTED"
  | "SOURCE_EMPTY"
  | "INSUFFICIENT_SAMPLE"
  | "IDENTITY_MISMATCH"
  | "CONTEXT_MISMATCH"
  | "PARSE_FAILURE"
  | "PRODUCER_FAILURE"
  | "GENUINELY_UNAVAILABLE";

/** The existing UnavailableReason enum audit-pipeline.ts's metricPairPatch persists. */
export type PersistedUnavailableReason =
  | "NO_SOURCE_FOUND"
  /**
   * The side produced no usable value and offered no evidence-based explanation: either the
   * provider errored in a way this pipeline could not classify, or the producer simply
   * returned nothing and said nothing. Deliberately distinct from NO_SOURCE_FOUND -- that one
   * is a claim that the source was asked and holds nothing, which neither of these proves.
   */
  | "PRODUCER_FAILED_WITHOUT_REASON"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_AUTH_FAILED"
  | "PLAYER_NOT_FOUND"
  | "MATCH_NOT_FOUND"
  | "SURFACE_DATA_NOT_FOUND"
  | "INSUFFICIENT_SAMPLE"
  | "MISSING_REQUIRED_INPUT"
  | "SOURCE_CONFLICT"
  | "RECONSTRUCTION_FAILED"
  | "API_RATE_LIMIT"
  | "PARSING_FAILED"
  | "HISTORICAL_DATA_UNAVAILABLE";

/**
 * Reasons that represent a TRANSIENT/technical hiccup rather than a proven absence of data:
 * the exact set audit-pipeline.ts's bounded metric retry loop re-attempts within the same
 * audit run. If retries are exhausted and one of these is still the reason, it becomes
 * PRODUCER_FAILURE (the pipeline genuinely could not get through, not proof nothing exists).
 */
const RETRIABLE_REASONS = new Set<PersistedUnavailableReason>(["PROVIDER_TIMEOUT", "API_RATE_LIMIT"]);

/** Statuses that legitimately excuse a match from this metric's evidence-coverage denominator. */
export const DENOMINATOR_EXCUSED_STATUSES = new Set<ActivationStatus>(["SOURCE_EMPTY", "INSUFFICIENT_SAMPLE", "GENUINELY_UNAVAILABLE"]);

export interface SideActivationInput {
  /** False when no metric_results row exists for this code/run at all. */
  executed: boolean;
  treatment?: string | null;
  value?: string | null;
  /** The already-persisted p1_unavailable_reason/p2_unavailable_reason for this side. */
  reason?: string | null;
  /** True once the bounded retry loop has used its last attempt for this side/run. */
  retriesExhausted?: boolean;
}

const USABLE_TREATMENTS = new Set(["DIRECT", "RECONSTRUCTED", "PARTIAL"]);

function isUsable(treatment: string | null | undefined, value: string | null | undefined) {
  return USABLE_TREATMENTS.has(String(treatment ?? "")) && Boolean(String(value ?? "").trim());
}

/**
 * Classifies ONE side of ONE metric for ONE match. Pure function: same inputs, same
 * output, every time -- nothing here can be influenced by anything other than what was
 * actually observed for this side.
 */
export function classifySideActivation(input: SideActivationInput): ActivationStatus {
  if (!input.executed) return "NOT_ATTEMPTED";
  if (isUsable(input.treatment, input.value)) return "ACTIVATED";

  const reason = (input.reason ?? null) as PersistedUnavailableReason | null;
  if (reason && RETRIABLE_REASONS.has(reason)) {
    return input.retriesExhausted ? "PRODUCER_FAILURE" : "RETRYING";
  }
  switch (reason) {
    case "PLAYER_NOT_FOUND":
      return "IDENTITY_MISMATCH";
    case "MATCH_NOT_FOUND":
    case "SURFACE_DATA_NOT_FOUND":
      return "CONTEXT_MISMATCH";
    case "PARSING_FAILED":
      return "PARSE_FAILURE";
    case "MISSING_REQUIRED_INPUT":
    case "SOURCE_CONFLICT":
    case "RECONSTRUCTION_FAILED":
    case "PROVIDER_AUTH_FAILED":
    case "PRODUCER_FAILED_WITHOUT_REASON":
      return "PRODUCER_FAILURE";
    case "INSUFFICIENT_SAMPLE":
      return "INSUFFICIENT_SAMPLE";
    case "NO_SOURCE_FOUND":
      return "SOURCE_EMPTY";
    case "HISTORICAL_DATA_UNAVAILABLE":
      return "GENUINELY_UNAVAILABLE";
    default:
      // A row exists, isn't usable, and carries no recognised reason at all. Never assumed
      // to be a proven absence -- treated as a producer defect (something to fix) rather
      // than quietly excused from the denominator.
      return "PRODUCER_FAILURE";
  }
}

export interface MetricActivationForMatch {
  code: string;
  p1: ActivationStatus;
  p2: ActivationStatus;
  /** Both sides genuinely activated -- this is what feeds the P1/P2 comparison. */
  activated: boolean;
  /**
   * False only when BOTH sides independently landed on an excused status -- neither side's
   * attempt turned up any real signal, or trace of a technical failure, for this match. A
   * single side showing a bug-class status (IDENTITY_MISMATCH, CONTEXT_MISMATCH,
   * PARSE_FAILURE, PRODUCER_FAILURE, NOT_ATTEMPTED) keeps the metric IN the denominator as
   * a real miss, even if the other side is excused -- that asymmetry is itself evidence the
   * metric is real and reachable, just currently broken on one side.
   */
  countsTowardDenominator: boolean;
}

export function classifyMetricActivation(code: string, p1: SideActivationInput, p2: SideActivationInput): MetricActivationForMatch {
  const p1Status = classifySideActivation(p1);
  const p2Status = classifySideActivation(p2);
  const bothExcused = DENOMINATOR_EXCUSED_STATUSES.has(p1Status) && DENOMINATOR_EXCUSED_STATUSES.has(p2Status);
  return {
    code,
    p1: p1Status,
    p2: p2Status,
    activated: p1Status === "ACTIVATED" && p2Status === "ACTIVATED",
    countsTowardDenominator: !bothExcused,
  };
}
