// Metric #043 -- Favorite Failure-Mode Score (real, evidence-gap.ts-spec-
// compliant build; docs/audit-task-043-044-opponent-upset-compatibility.md)
//
// evidence-gap.ts's real definition: "favorite-role historical losses with
// pre-match favorite designation, the exact failure conditions observed in
// those losses (including serve/return and set-state conditions), and
// today's opponent's sourced ability to reproduce those same conditions."
//
// Before this task, code "043" was wired only to
// deterministic-market-metrics.server.ts's de-vig market pricing/movement
// text -- real, but market pricing text standing in for the definition's
// actual per-player historical-pattern content.
//
// This module builds that content directly, by composing two already-real
// engines rather than re-deriving either:
//   1. audit-metric-036-loss-autopsy.ts's computeLossAutopsy for the
//      PLAYER -- their own favorite-role losses, with pre-match Elo
//      favorite designation and the exact set-state failure conditions
//      observed (lost_set_1 / deciding_set / tiebreak_factor / blowout_loss
//      -- restricted to WTA_MAIN/ATP_CHALLENGER where set_scores exists,
//      the same structural gap #036 already documents).
//   2. audit-metric-044-opponent-upset-compatibility.ts's
//      computeUnderdogWinProfile for the OPPONENT -- their own verified
//      underdog wins, classified by the exact same set-state conditions.
//      An opponent's rate of reproducing a given condition IN THEIR OWN
//      underdog wins (e.g. taking set 1 off a stronger player, forcing a
//      decider, winning tiebreaks) is a real, sourced measure of their
//      ability to reproduce that same condition against today's favorite --
//      not a guess, not a generic form proxy.
//
// "today's opponent's sourced ability to reproduce those same conditions"
// is reported per-condition (so the reader sees exactly which failure mode
// the opponent can and cannot back up), plus one explicit, documented
// composite: reproduction_compatibility_score_pct, a relevance-weighted
// average of the opponent's own reproduction rate across only the
// conditions that actually appear in the player's favorite-role losses
// (a condition the player never fails on contributes nothing to the
// score, weighted by how often it recurs in their own losses). See
// computeReproductionCompatibility's own comment for the exact formula.
//
// "pre-match favorite designation" cross-checked against market price:
// deliberately NOT merged into this synchronous, static-index-only engine
// -- see this module's wiring layer
// (deterministic-batch3-favorite-underdog-patterns.server.ts) for why
// deterministic-market-metrics.server.ts's existing de-vig computation is
// instead left as a separate, lower-priority fallback tier for this code.
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { round1, type LaneOutcome, type TourLane } from "./audit-metrics-shared";
import { computeLossAutopsy, type LossAutopsyResult, DEFAULT_TRAILING_LOSSES } from "./audit-metric-036-loss-autopsy";
import { computeUnderdogWinProfile, type UnderdogWinProfileResult } from "./audit-metric-044-opponent-upset-compatibility";

export const FAILURE_CONDITIONS = ["lost_set_1", "deciding_set", "tiebreak_factor", "blowout_loss"] as const;
export type FailureCondition = (typeof FAILURE_CONDITIONS)[number];

export interface FailureConditionCompatibility {
  condition: FailureCondition;
  player_favorite_loss_rate_pct: number | null; // % of player's favorite-role losses that showed this condition
  opponent_reproduction_rate_pct: number | null; // % of opponent's own underdog wins that showed this same condition
}

// Loss condition key -> the mirror-image win condition key on the opponent's
// underdog-win side (audit-metric-036 loses set 1 / #044 takes set 1, etc.
// -- same event, opposite outcome, both derived from the same setScores[0]
// comparison in each module).
const CONDITION_TO_LOSS_FIELD: Record<FailureCondition, keyof LossAutopsyResult["losses"][number]> = {
  lost_set_1: "lost_set_1",
  deciding_set: "deciding_set",
  tiebreak_factor: "tiebreak_factor",
  blowout_loss: "blowout_loss",
};
const CONDITION_TO_WIN_FIELD: Record<FailureCondition, keyof UnderdogWinProfileResult["underdog_wins"][number]> = {
  lost_set_1: "took_set_1", // player losing set 1 IS the opponent taking set 1 -- same match-level event
  deciding_set: "deciding_set",
  tiebreak_factor: "tiebreak_factor",
  blowout_loss: "blowout_win",
};

function rateOf(bools: Array<boolean | null>): number | null {
  const known = bools.filter((b): b is boolean => b !== null);
  return known.length ? round1((100 * known.filter(Boolean).length) / known.length) : null;
}

/**
 * Pure core: given the player's favorite-role losses and the opponent's
 * underdog-win profile (both already computed by their respective owning
 * modules), compute the per-condition reproduction compatibility and the
 * relevance-weighted composite score.
 *
 * Composite formula: reproduction_compatibility_score_pct = weighted
 * average of opponent_reproduction_rate_i, weighted by
 * player_favorite_loss_rate_i, over conditions where BOTH rates are known
 * and the player's own rate is > 0 (a condition the player never fails on
 * cannot be weighted into "how compatible is this opponent with MY
 * failure modes" -- it isn't one of their failure modes). Null when no
 * condition has both a known player rate > 0 and a known opponent rate
 * (e.g. neither side has set-sequence data in this lane).
 */
export function computeFailureConditionCompatibility(
  playerLosses: LossAutopsyResult["losses"],
  opponentUnderdogWins: UnderdogWinProfileResult["underdog_wins"],
): { conditions: FailureConditionCompatibility[]; reproduction_compatibility_score_pct: number | null } {
  const conditions: FailureConditionCompatibility[] = FAILURE_CONDITIONS.map(condition => {
    const lossField = CONDITION_TO_LOSS_FIELD[condition];
    const winField = CONDITION_TO_WIN_FIELD[condition];
    return {
      condition,
      player_favorite_loss_rate_pct: rateOf(playerLosses.map(l => l[lossField] as boolean | null)),
      opponent_reproduction_rate_pct: rateOf(opponentUnderdogWins.map(w => w[winField] as boolean | null)),
    };
  });

  let weightedSum = 0, weightTotal = 0;
  for (const c of conditions) {
    if (c.player_favorite_loss_rate_pct === null || c.opponent_reproduction_rate_pct === null) continue;
    if (c.player_favorite_loss_rate_pct <= 0) continue;
    weightedSum += c.player_favorite_loss_rate_pct * c.opponent_reproduction_rate_pct;
    weightTotal += c.player_favorite_loss_rate_pct;
  }
  const score = weightTotal > 0 ? round1(weightedSum / weightTotal) : null;
  return { conditions, reproduction_compatibility_score_pct: score };
}

export interface FavoriteFailureModeResult {
  trailing_favorite_losses_n: number;
  favorite_losses_rate_pct: number | null;
  bad_loss_severity_index: number;
  set_sequence_available: boolean;
  failure_conditions: FailureConditionCompatibility[];
  opponent_underdog_wins_n: number;
  reproduction_compatibility_score_pct: number | null;
}

/**
 * Live wrapper: computes the player's own loss autopsy (#036), keeps only
 * the favorite-role losses, computes the opponent's underdog-win profile
 * (#044's shared core), and cross-references failure conditions between
 * them. GO requires the player to have at least one favorite-role loss AND
 * the opponent to have at least one verified underdog win in this lane
 * before asOfDate -- both leakage-safe via the replayElo pass each
 * sub-engine already performs (see #036/#044's own leakage tests).
 */
export function computeFavoriteFailureMode(args: {
  player: string;
  opponent: string;
  lane: TourLane;
  asOfDate: string;
  trailingN?: number;
}): LaneOutcome<FavoriteFailureModeResult> {
  const { player, opponent, lane, asOfDate, trailingN = DEFAULT_TRAILING_LOSSES } = args;
  if (normalizeEvidenceIdentity(player) === normalizeEvidenceIdentity(opponent)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Player and opponent resolve to the same identity." };
  }
  const lossResult = computeLossAutopsy({ player, lane, asOfDate, trailingN });
  if (lossResult.status !== "GO") {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `Player: ${lossResult.reason}` };
  }
  const favoriteLosses = lossResult.value.losses.filter(l => l.favorite_status === "FAVORITE");
  if (!favoriteLosses.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Player has prior losses before asOfDate, but none as the pre-match Elo favorite." };
  }
  const opponentProfile = computeUnderdogWinProfile({ player: opponent, lane, asOfDate, trailingN });
  if (opponentProfile.status !== "GO") {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `Opponent: ${opponentProfile.reason}` };
  }
  const { conditions, reproduction_compatibility_score_pct } = computeFailureConditionCompatibility(favoriteLosses, opponentProfile.value.underdog_wins);
  return {
    lane, status: "GO", n: Math.min(favoriteLosses.length, opponentProfile.n),
    value: {
      trailing_favorite_losses_n: favoriteLosses.length,
      favorite_losses_rate_pct: lossResult.value.favorite_losses_rate_pct,
      bad_loss_severity_index: lossResult.value.bad_loss_severity_index,
      set_sequence_available: lossResult.value.set_sequence_available && opponentProfile.value.set_sequence_available,
      failure_conditions: conditions,
      opponent_underdog_wins_n: opponentProfile.n,
      reproduction_compatibility_score_pct,
    },
  };
}
