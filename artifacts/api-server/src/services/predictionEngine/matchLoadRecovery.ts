import type { MatchRecord } from "../tennisData/types";
import { realSetGameMargins } from "../shared/matchModels/setMargins";

/**
 * EXPERIMENTAL -- not wired into the live ensemble, `EngineOutput`, or `EngineBreakdown`.
 *
 * Task #89's investigation found that the existing Fatigue module's 3/7/14-day recency-weighted
 * MATCH-COUNT windows are a mislabeled, inverted proxy for tournament-survivorship/winning
 * momentum, not physical tiredness (see `docs/audit-fatigue-window-logic-investigation.md`).
 * This module tests a structurally different idea: instead of counting how many matches a player
 * has played recently (which is confounded with "has been winning and advancing"), it looks only
 * at the player's SINGLE most recent prior match -- how many days of rest since it, and whether
 * it went the distance (a real physical-toll proxy independent of who won it). A short-rest
 * turnaround after a grueling match is a real acute-fatigue mechanism that doesn't require the
 * player to be on any particular winning or losing streak to occur.
 *
 * See `docs/audit-fatigue-redesign-investigation.md` for the full candidate comparison. THREE
 * candidates were tested: rest-days-only, went-distance-only, and a combination of both. Only
 * "went-distance-only" cleared both the decorrelation bar (<55% directional overlap with Recent
 * Form) and the accuracy bar (statistically significant above 50% given sample size). Rest-days
 * alone was REJECTED -- it turned out to be just another proxy for tournament-survivorship
 * (60.6% overlap with Recent Form, 49.7% accuracy, i.e. not even above coin-flip), the same
 * confound that sank the original Fatigue module. Combining it with went-distance diluted the
 * validated signal rather than improving it. Accordingly, `player1RestDays`/`player2RestDays`
 * below are still computed and returned for transparency, but do NOT feed the risk score --
 * only `player1RecentMatchWentDistance`/`player2RecentMatchWentDistance` does.
 */

export interface MatchLoadRecoveryResult {
  /** Real calendar days since this player's single most recent prior match, measured against `asOfDate`. Null when the player has no prior match on record at all. */
  player1RestDays: number | null;
  player2RestDays: number | null;
  /** Whether that most recent prior match went the distance (3 sets in a BestOf3, 4+ sets in a BestOf5) -- a real physical-toll proxy independent of whether the player won or lost it. Null when the format or set count for that match isn't known. */
  player1RecentMatchWentDistance: boolean | null;
  player2RecentMatchWentDistance: boolean | null;
  /**
   * 0-100, higher = more acute-recovery risk. Validated (Candidate B, "went-distance-only") --
   * driven ENTIRELY by whether the player's most recent match went the distance; rest days
   * (above) are informational only and do NOT feed this score. Rest-days-based scoring
   * (Candidate A) was tested and rejected: it re-derives tournament-survivorship (60.6% overlap
   * with Recent Form, 49.7% accuracy -- not even above coin-flip), the same confound that sank
   * the original Fatigue module. See `docs/audit-fatigue-redesign-investigation.md`.
   */
  player1RecoveryRiskScore: number;
  player2RecoveryRiskScore: number;
  reliability: number;
  warnings: string[];
}

const NOTE_NO_PRIOR_MATCH = "No prior match on record for at least one player -- recovery risk defaults to 0 (unknown, not assumed fresh) for that player.";

/** The validated risk contribution when the player's most recent match went the distance -- the ONLY input to `player1RecoveryRiskScore`/`player2RecoveryRiskScore`. */
const WENT_DISTANCE_RISK = 20;

function wentTheDistance(match: MatchRecord): boolean | null {
  const sets = realSetGameMargins(match).length;
  if (sets === 0) return null; // no set-score data for this match
  if (match.matchFormat === "BestOf5") return sets >= 4;
  if (match.matchFormat === "BestOf3") return sets >= 3;
  // Format unknown for this specific match -- fall back to the universal BestOf3 threshold
  // (3+ sets always means a deciding set was needed in either format), rather than guessing.
  return sets >= 3;
}

function computeForPlayer(matches: MatchRecord[], asOf: number): { restDays: number | null; wentDistance: boolean | null; score: number } {
  if (matches.length === 0) return { restDays: null, wentDistance: null, score: 0 };
  const mostRecent = matches[0]; // matches are sorted most-recent-first, same contract fatigue.ts's callers rely on
  const restDays = Math.floor((asOf - new Date(mostRecent.date).getTime()) / (24 * 60 * 60 * 1000));
  const wentDistance = wentTheDistance(mostRecent);
  // Validated formula (Candidate B): score depends ONLY on wentDistance. restDays is returned
  // for transparency/display but deliberately does NOT feed the score -- see the module-level
  // doc comment and `docs/audit-fatigue-redesign-investigation.md` for why rest-days-based
  // scoring was tested and rejected.
  const score = wentDistance ? WENT_DISTANCE_RISK : 0;
  return { restDays: restDays >= 0 ? restDays : null, wentDistance, score };
}

/**
 * `asOfDate` follows the exact same discipline `fatigue.ts` uses (2026-07-14 fix): defaults to
 * the real current time for live predictions, but historical/backtest callers MUST pass each
 * match's own frozen `cutoffAt` so recency is measured against that match's own as-of moment,
 * never today's wall-clock time.
 */
export function computeMatchLoadRecoveryModule(player1Matches: MatchRecord[], player2Matches: MatchRecord[], asOfDate?: Date): MatchLoadRecoveryResult {
  const asOf = (asOfDate ?? new Date()).getTime();
  const p1 = computeForPlayer(player1Matches, asOf);
  const p2 = computeForPlayer(player2Matches, asOf);

  const warnings: string[] = [];
  if (p1.restDays === null || p2.restDays === null) warnings.push(NOTE_NO_PRIOR_MATCH);
  if (p1.wentDistance === null || p2.wentDistance === null) {
    warnings.push("Set-score or match-format data is missing for at least one player's most recent match -- the went-the-distance component falls back to 0 (unknown, not assumed short) for that player.");
  }

  return {
    player1RestDays: p1.restDays,
    player2RestDays: p2.restDays,
    player1RecentMatchWentDistance: p1.wentDistance,
    player2RecentMatchWentDistance: p2.wentDistance,
    player1RecoveryRiskScore: p1.score,
    player2RecoveryRiskScore: p2.score,
    // Single most-recent-match signal, same fixed-reliability treatment as fatigue.ts pending
    // real validation -- this is explicitly the thing Task #91 is testing, not yet a validated
    // per-match data-richness signal.
    reliability: 70,
    warnings,
  };
}
