// Shared types and helpers for the "New Signal Batch 1" audit/verification
// metric modules (docs/audit-task-new-batch1-step0.md). These are standalone
// audit computations -- they evaluate TennisMatrixAi's historical
// predictions after the fact using the same four-tour static history index
// (repository-results-history.server.ts) the rest of this app already uses
// for evidence reconstruction.
//
// UPDATE (docs/audit-task-new-batch1-standalone-modules-wiring.md): the five
// modules that were reviewed and confirmed correct/leakage-safe (027/031/
// 041/046/051) ARE now wired into the live pipeline's Researcher, via
// deterministic-batch1-standalone-metrics.server.ts's new tier inside
// warehouse-first-researcher.server.ts. This shared-helpers file, and any
// module using it, is no longer categorically excluded from production --
// each module's own file header states its actual wiring status.
//
// Standing pattern (Step 0 resolution): every metric reports its result PER
// TOUR LANE, each independently GO or NOT_ENOUGH_DATA -- never a single
// verdict for the whole metric -- because Step 0 found data availability is
// inconsistent by lane (e.g. set-sequence data exists for WTA_MAIN/
// ATP_CHALLENGER but not ATP_MAIN/WTA_CHALLENGER), not uniformly available.
import type { EvidenceTourFamily } from "./evidence-match-identity";

export const TOUR_LANES = ["ATP_MAIN", "WTA_MAIN", "ATP_CHALLENGER", "WTA_CHALLENGER"] as const;
export type TourLane = (typeof TOUR_LANES)[number];

// Working default per the ticket: CALIBRATION_MIN_RELIABLE_BIN_N doesn't
// exist in this codebase (that constant is specific to a different project),
// so this project uses n=50 as the equivalent working default unless a
// metric-specific reason to differ is documented in that metric's own file.
export const MIN_SUPPORT_N = 50;

export type LaneOutcome<T> =
  | { lane: TourLane; status: "GO"; n: number; value: T }
  | { lane: TourLane; status: "NOT_ENOUGH_DATA"; n: number; reason: string };

export function laneOutcome<T>(lane: TourLane, n: number, minN: number, compute: () => T, reason: string): LaneOutcome<T> {
  if (n < minN) return { lane, status: "NOT_ENOUGH_DATA", n, reason };
  return { lane, status: "GO", n, value: compute() };
}

// evidence-match-identity.ts's EvidenceTourFamily values are identical
// strings to this module's TourLane -- kept as two distinct exported types
// (one per module's own vocabulary) rather than importing one as the other,
// so a future rename in either module surfaces as a type error here instead
// of silently drifting apart.
export function asTourFamily(lane: TourLane): EvidenceTourFamily {
  return lane as EvidenceTourFamily;
}

export function round1(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}
