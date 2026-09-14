// Metric #051 -- Opponent-Specific Set/Match Probabilities
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #51)
//
// "Opponent-Specific Break Expectancy: the probability of breaking this
// exact opponent's serve, rather than a generic break percentage." The
// broader, structurally-buildable version of this bullet family this module
// ships is the win-probability analogue: a player's H2H win rate against
// this exact opponent, shrunk toward a general (non-opponent-specific)
// probability by Bayesian shrinkage weighted on H2H sample size, since raw
// H2H alone is nearly always too small a sample to trust on its own (most
// pairs have 0-3 meetings).
//
// Data source: repository-results-history.server.ts's repositoryResultsRows,
// the same four-tour static history index (data/generated/tennis-runtime-
// index.json) used elsewhere in this app for evidence reconstruction.
// Leakage safety: repositoryResultsRows(..., {strictBefore:true}) only
// returns rows with event_date strictly before asOfDate -- enforced by the
// function this module calls, not reimplemented here.
import { repositoryResultsRows, type RepositoryResultsObservation } from "./repository-results-history.server";
import { evidencePairMatches, normalizeEvidenceIdentity } from "./evidence-player-alias";
import { asTourFamily, round1, type LaneOutcome, type TourLane } from "./audit-metrics-shared";

// Shrinkage constant k (see shrinkageWeight below). Chosen, not guessed, so
// it can be tuned later: k=8 means an opponent with 8 prior meetings gets
// equal weight between the raw H2H rate and the general model; k=2 meetings
// gets ~20% weight on H2H; k=20 meetings gets ~71% weight. This mirrors a
// common empirical-Bayes shrinkage choice (weight = n / (n + k)) and is
// deliberately conservative (a handful of H2H meetings should not dominate
// a well-supported general probability) until real validation data justifies
// a different k. Documented here, not scattered as a magic number.
export const DEFAULT_SHRINKAGE_K = 8;

export interface OpponentSpecificProbabilityResult {
  n_h2h: number;
  raw_h2h_win_pct: number | null;
  general_win_probability_pct: number;
  shrinkage_weight: number;
  shrinkage_k: number;
  shrunk_win_probability_pct: number;
}

/**
 * Pure, directly-testable core: given the player's own prior-match rows
 * (already leakage-filtered by the caller) and the opponent's name, compute
 * the shrunk opponent-specific win probability.
 *
 * @param generalWinProbabilityPct The player's win probability against this
 *   opponent from a general (non-opponent-specific) model -- e.g. an Elo
 *   expected-score conversion, or TennisMatrixAi's own pre-match probability
 *   when auditing a specific TennisMatrixAi prediction. This module does not
 *   compute that number itself; it only shrinks it toward the H2H rate.
 */
export function computeOpponentSpecificProbabilityFromRows(args: {
  player: string;
  opponent: string;
  rows: RepositoryResultsObservation[];
  generalWinProbabilityPct: number;
  shrinkageK?: number;
}): { n_h2h: number; raw_h2h_win_pct: number | null; shrinkage_weight: number; shrinkage_k: number; shrunk_win_probability_pct: number } | null {
  const { player, opponent, generalWinProbabilityPct } = args;
  const k = args.shrinkageK ?? DEFAULT_SHRINKAGE_K;
  if (!Number.isFinite(generalWinProbabilityPct) || generalWinProbabilityPct < 0 || generalWinProbabilityPct > 100) return null;
  if (normalizeEvidenceIdentity(player) === normalizeEvidenceIdentity(opponent)) return null;
  const meetings = args.rows.filter(row => evidencePairMatches(row.player_name, row.opponent_name, player, opponent));
  const nH2h = meetings.length;
  const wins = meetings.filter(row => (row.raw_payload as { winner?: string | null }).winner === player).length;
  const rawH2hWinPct = nH2h > 0 ? round1((100 * wins) / nH2h) : null;
  const shrinkageWeight = nH2h / (nH2h + k);
  const shrunkWinProbabilityPct = rawH2hWinPct === null
    ? generalWinProbabilityPct
    : shrinkageWeight * rawH2hWinPct + (1 - shrinkageWeight) * generalWinProbabilityPct;
  // This metric is designed to be informative even at n_h2h=0 -- shrinkage
  // toward the general model IS the point, not a fallback to suppress.
  return {
    n_h2h: nH2h,
    raw_h2h_win_pct: rawH2hWinPct,
    shrinkage_weight: round1(shrinkageWeight * 100)! / 100,
    shrinkage_k: k,
    shrunk_win_probability_pct: round1(shrunkWinProbabilityPct)!,
  };
}

/** Live wrapper: fetches leakage-safe prior-match rows for `player` in `lane` before pairing off against `opponent`. */
export function computeOpponentSpecificProbability(args: {
  player: string;
  opponent: string;
  lane: TourLane;
  asOfDate: string;
  generalWinProbabilityPct: number;
  shrinkageK?: number;
}): LaneOutcome<OpponentSpecificProbabilityResult> {
  const { lane } = args;
  const rows = repositoryResultsRows(args.player, asTourFamily(lane), args.asOfDate, { strictBefore: true });
  const core = computeOpponentSpecificProbabilityFromRows({ ...args, rows });
  if (!core) {
    const reason = normalizeEvidenceIdentity(args.player) === normalizeEvidenceIdentity(args.opponent)
      ? "Player and opponent resolve to the same identity."
      : "No usable general (non-opponent-specific) win probability was supplied to shrink toward.";
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason };
  }
  return { lane, status: "GO", n: core.n_h2h, value: { ...core, general_win_probability_pct: args.generalWinProbabilityPct } };
}
