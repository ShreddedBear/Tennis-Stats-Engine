// Metric #061 -- Final Advanced Tests -> Historical Twin Match Search
// (docs/audit-task-047-061-classification-decisions.md; public/seed/metrics.txt #61)
//
// Classification decision (see metric-classification.ts): code 061's original catalog
// definition mixed three sub-items -- (1) counterfactual leave-one-input-out reruns of the
// model's own winner pick, (2) realistic opponent-upgrade reruns of key inputs, and (3) a
// Historical Twin Match Search over prior matchups with similar Elo/form/market gaps. The
// human review decided to SPLIT this rather than keep it as one ambiguous whole:
//   - (1) and (2) are re-runs of THIS SYSTEM'S OWN prediction under perturbed inputs -- a
//     property of the model/process, not a fact about either player (the same test this
//     registry already applies to 048/049/050/056/057/058/059). They are permanently
//     EXCLUDED from player evidence and, per the resolution, are NOT given their own metric
//     code either: they were never a distinct catalog entry on their own, only a component
//     of 061's original mixed definition, so there is nothing to retarget them to. (This
//     mirrors how pbp-score-state-recovery.ts's header documents dropping a component
//     outright, e.g. its "004 removed" note, rather than inventing a new home for content
//     that duplicates an already-excluded concept -- 050 "Robustness Tests" already covers
//     the same "rerun the prediction under perturbations" idea and is already
//     META_OR_NON_PLAYER.) If a future task wants to persist this content anywhere, it
//     belongs alongside 050's stress-test machinery, never counted as code 061 or as player
//     evidence.
//   - (3) Historical Twin Match Search IS real, reconstructable player/matchup evidence --
//     it searches the four-tour static history index for past matches with a similar Elo
//     gap (and surface) to today's pairing, and reports how the analogous favorite actually
//     fared. Code 061 now means ONLY this. It is moved out of UNKNOWN_REQUIRES_REVIEW into
//     ordinary LEGITIMATE_PLAYER_METRIC status (metric-classification.ts's default for any
//     code with no registry record) -- same mechanism as 047.
//
// This module does not re-derive the search itself -- historical-twin-match-search.server.ts
// already implements it (nearest-neighbor Elo-gap search over a leakage-safe K=32 Elo
// replay, surface-mismatch penalized; see that file's own header for exactly which of the
// twin-match definition's eleven named similarity dimensions are covered -- elo_gap and
// court_speed only, the rest are not reconstructable from this system's approved evidence
// universe and are not synthesized). This file only adapts that existing, already-tested
// engine into this batch's LaneOutcome<T> convention (per-tour-lane GO/NOT_ENOUGH_DATA) so
// it can be wired into the same deterministic tier chain as every other #04x/#05x module.
//
// final-advanced-meta.server.ts previously mixed this same twin-search result together with
// a persisted stress-test "strongest independent family removal" outcome (ST03) under code
// 061 -- exactly the excluded counterfactual-rerun content described above. That mixing is
// removed as part of this split; see final-advanced-meta.server.ts's own updated header.
import { asTourFamily, type LaneOutcome, type TourLane } from "./audit-metrics-shared";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { computeHistoricalTwinMatchSearch, type TwinMatchSearchResult } from "./historical-twin-match-search.server";

/** Live wrapper: resolves the lane's static history data and delegates to the already-real, already-tested twin-match search engine. */
export function computeHistoricalTwinMatchSearchForLane(args: {
  p1: string;
  p2: string;
  lane: TourLane;
  asOfDate: string;
  surface?: string | null;
}): LaneOutcome<NonNullable<TwinMatchSearchResult>> {
  const { p1, p2, lane, asOfDate, surface = null } = args;
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  if (!historyLane || typeof historyLane !== "object") {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `No match-history lane data available for ${lane}.` };
  }
  const result = computeHistoricalTwinMatchSearch({ p1, p2, asOfDate, surface, lane: historyLane as never });
  if (!result) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No usable Elo history for one or both players, or fewer than the minimum number of nearest-neighbor twin matches, before asOfDate in this lane." };
  }
  const n = Number(String(result.sample).match(/twin_matches=(\d+)/)?.[1] ?? 0);
  return { lane, status: "GO", n, value: result };
}
