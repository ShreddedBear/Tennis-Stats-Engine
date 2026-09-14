// Metrics #036/#037 -- Loss Autopsy Metrics / Win Autopsy Metrics
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #36/#37)
//
// Classifies a completed, TennisMatrixAi-scored match into a win or loss
// category using (a) TennisMatrixAi's own pre-match win probability for the
// player and (b) the final score margin. Bounded strictly to matches
// TennisMatrixAi actually scored pre-match (matches.actual_winner populated
// AND a parsed_summary_fields "matrix_wp" for that match) -- this module
// never extends classification to the ~200k-row four-tour historical index
// by inventing a win probability TennisMatrixAi never produced. Real n for
// this population is pending GitHub issue #82 (Copilot read-only query);
// this module enforces MIN_SUPPORT_N regardless of what that n turns out to
// be.
//
// "Opponent Collapse" (an in-play win-probability-drop subtype of Win
// Autopsy) is not implemented: it needs in-play/point-by-point win
// probability tracking over the course of the match, which this audit DB
// does not store (only a single pre-match probability). Per the ticket,
// skipped rather than approximated.
import { round1, MIN_SUPPORT_N } from "./audit-metrics-shared";

// Unlike #027/#029/#031/#041/#046, this metric family is bounded to the
// audit DB's own parsed_summary_fields-scored population -- it is not
// reconstructed from the four-tour historical index, so there is no
// ATP_MAIN/WTA_MAIN/etc. lane to split by (docs/audit-task-new-batch1-step0.md
// Resolution: "#036/#037/#039 ... GO, strictly bounded to the audit DB's own
// parsed_summary_fields-scored matches"). It reports as a single population,
// not per tour lane.
export type AuditDbOutcome<T> =
  | { population: "AUDIT_DB"; status: "GO"; n: number; value: T }
  | { population: "AUDIT_DB"; status: "NOT_ENOUGH_DATA"; n: number; reason: string };

// Thresholds, stated explicitly and centralized here so they're one place to
// tune, not magic numbers scattered through the classifier.
export const FAVORITE_STRONG_PCT = 70; // ">70%" per the ticket
export const FAVORITE_MODERATE_MIN_PCT = 55; // "55-70%"
export const UNDERDOG_PCT = 45; // "<45%"
// The 45%-55% "coin-flip" band and the exact 70%/55%/45% boundary values
// themselves are deliberately left UNCLASSIFIED rather than silently folded
// into a neighboring bucket -- the ticket only defined bands with gaps
// between them (e.g. nothing named for "won at 50%"), and inventing a rule
// to fill that gap would be exactly the kind of unstated judgment call this
// project's guardrails exist to avoid. classifyWinOutcome/classifyLossOutcome
// return null for anything outside the defined bands.

export type WinCategory = "DOMINANT" | "ROUTINE" | "ESCAPE" | "UPSET_WIN";
export type LossCategory = "BAD_LOSS" | "CLOSE_LOSS" | "EXPECTED_LOSS";

export interface ScoredOutcome {
  /** TennisMatrixAi's pre-match win probability for the player being classified, 0-100. */
  playerWinProbabilityPct: number;
  playerWon: boolean;
  /** Did the match go the distance / come down to a close final margin? See isCloseMatch in this module for the exact definition applied when the caller doesn't already know this. */
  wasClose: boolean;
}

export function classifyWinOutcome(o: ScoredOutcome): WinCategory | null {
  if (!o.playerWon) return null;
  const p = o.playerWinProbabilityPct;
  if (p > FAVORITE_STRONG_PCT) return "DOMINANT";
  if (p >= FAVORITE_MODERATE_MIN_PCT) return "ROUTINE"; // 55-70%, inclusive of 70 itself (>70 already claimed by DOMINANT)
  if (p < UNDERDOG_PCT) return o.wasClose ? "ESCAPE" : "UPSET_WIN";
  return null; // 45%-<55% coin-flip band: not classified, see module header
}

export function classifyLossOutcome(o: ScoredOutcome): LossCategory | null {
  if (o.playerWon) return null;
  const p = o.playerWinProbabilityPct;
  if (p > FAVORITE_STRONG_PCT) return "BAD_LOSS";
  if (p >= FAVORITE_MODERATE_MIN_PCT) return "CLOSE_LOSS"; // ticket only names this band's loss as "close score", applied uniformly across the whole 55-70 band -- see doc entry
  if (p < UNDERDOG_PCT) return "EXPECTED_LOSS";
  return null;
}

// Reuses the same permissive raw-scoreline convention already relied on
// elsewhere in this codebase (datahub-atp-score-profile.server.ts's
// parseDataHubSets: "6-4" / "7-6(5)" tokens, space-separated). This assumes
// matches.final_score uses the same convention; if the live audit DB stores
// a different format, this degrades to returning false (never crashes, never
// guesses "close"), which is the same fail-closed posture every other
// reconstruction engine in this project already takes for unparseable
// scorelines.
export function parseFinalScoreSets(finalScore: string | null): Array<[number, number]> {
  if (!finalScore) return [];
  return finalScore.split(/\s+/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(\d+)-(\d+)/);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    return Number.isFinite(a) && Number.isFinite(b) ? ([a, b] as [number, number]) : null;
  }).filter((x): x is [number, number] => x !== null);
}

/** A match is "close" when it went to a deciding set, or any set was a tiebreak / decided by a two-game-or-fewer margin at 6+ games. */
export function isCloseMatch(finalScore: string | null, bestOf: number | null): boolean {
  const sets = parseFinalScoreSets(finalScore);
  if (!sets.length) return false;
  if (bestOf && sets.length >= bestOf) return true; // went the full distance
  return sets.some(([a, b]) => {
    if (a === 7 && b === 6) return true;
    if (a === 6 && b === 7) return true;
    // A set only reads as "narrow" once it's gone past the minimum 6 games
    // (e.g. 7-5) -- a plain 6-4 is a completely ordinary, non-close set at
    // the minimum length and must not trip this check.
    return Math.max(a, b) >= 7 && Math.abs(a - b) <= 2;
  });
}

export interface LossWinAutopsyResult {
  category: WinCategory | LossCategory | null;
  player_win_probability_pct: number;
  was_close: boolean;
}

export function computeLossWinAutopsy(o: ScoredOutcome): LossWinAutopsyResult {
  const category = o.playerWon ? classifyWinOutcome(o) : classifyLossOutcome(o);
  return { category, player_win_probability_pct: round1(o.playerWinProbabilityPct)!, was_close: o.wasClose };
}

// Leakage guard for this metric class: unlike the trailing-N historical
// metrics (which leak if a row dated on/after the target match slips in),
// this metric operates on a single already-completed match's own stored
// pre-match probability -- the leak risk here is a probability that was
// actually recorded (or corrected) AFTER the result was already known,
// which would make the "prediction" trivially accurate by hindsight rather
// than a genuine pre-match call. The live DB wrapper (not implemented in
// this pure module -- see the module header) must only use a
// parsed_summary_fields row whose created_at precedes the match's own
// result_recorded_at.
export function isPredictionBeforeResult(predictionCreatedAt: string, resultRecordedAt: string | null): boolean {
  if (!resultRecordedAt) return false; // no recorded result timestamp to compare against -- fail closed, not "assume it's fine"
  const predicted = Date.parse(predictionCreatedAt), recorded = Date.parse(resultRecordedAt);
  if (!Number.isFinite(predicted) || !Number.isFinite(recorded)) return false;
  return predicted < recorded;
}

/** Aggregates the audit DB's whole scored population into a category distribution, gated by MIN_SUPPORT_N. */
export function summarizeAutopsyDistribution(outcomes: ScoredOutcome[]): AuditDbOutcome<Record<string, number>> {
  const n = outcomes.length;
  if (n < MIN_SUPPORT_N) return { population: "AUDIT_DB", status: "NOT_ENOUGH_DATA", n, reason: `Only ${n} TennisMatrixAi-scored matches available; minimum support is ${MIN_SUPPORT_N}.` };
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    const { category } = computeLossWinAutopsy(o);
    const key = category ?? "UNCLASSIFIED";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { population: "AUDIT_DB", status: "GO", n, value: counts };
}
