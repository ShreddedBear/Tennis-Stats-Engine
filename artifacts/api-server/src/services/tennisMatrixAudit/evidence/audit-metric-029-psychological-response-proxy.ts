// Metric #029 -- Psychological Response Proxy
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #29)
//
// A close-set loss is defined by score margin alone: 7-6, 7-5, or 6-4 (the
// same "narrow margin at 6+ games" shape #036/#037's isCloseMatch already
// uses for a full match, applied here to a single set). Given a close-set
// loss, this reports:
//   - win rate in the immediately-following set of that same match
//   - win rate in the match overall
// versus the player's own baseline (all matches in the trailing window,
// not conditioned on a close-set loss) -- a same-player comparison, not a
// cross-player one, so the "proxy" measures a shift in this player's own
// tendency, not an absolute scale.
//
// Same structural lane gap and same tour-scoping as #027: set_scores only
// exists for WTA_MAIN/ATP_CHALLENGER in the static history index.
//
// Dropped refinement: break-point-advantage-relative closeness (e.g. "lost
// a set despite holding 3 break points") was considered and is explicitly
// NOT implemented -- the static history index stores only final set scores,
// no game/point-level data, so there is nothing to compute that refinement
// from. Score-margin-only is what ships. Documented here so it is not
// re-attempted without new data (per docs/audit-task-new-batch1-step0.md's
// resolution for #029).
import { repositoryResultsRows, type RepositoryResultsObservation } from "./repository-results-history.server";
import { asTourFamily, round1, type LaneOutcome, type TourLane } from "./audit-metrics-shared";
import { DEFAULT_TRAILING_N, FINISHING_ABILITY_ELIGIBLE_LANES } from "./audit-metric-027-opponent-finishing-ability";

/** A single set score reads as "close" at 7-6, 7-5, or 6-4 -- the same narrow-margin-at-6+-games shape used elsewhere in this batch, applied per-set rather than per-match. */
export function isCloseSetLoss(forGames: number, againstGames: number): boolean {
  if (forGames >= againstGames) return false; // not a loss of this set
  if (forGames === 6 && againstGames === 7) return true;
  if (forGames === 5 && againstGames === 7) return true;
  if (forGames === 4 && againstGames === 6) return true;
  return false;
}

export interface PsychologicalResponseResult {
  trailing_n_used: number;
  baseline_match_win_rate: { n: number; rate: number | null };
  after_close_set_loss: {
    n: number;
    next_set_win_rate: number | null;
    match_win_rate: number | null;
  };
}

function matchWon(row: RepositoryResultsObservation, player: string): boolean {
  return (row.raw_payload as { winner?: string | null }).winner === player;
}

function setScoresOf(row: RepositoryResultsObservation): Array<[number, number]> | null {
  const detail = (row.raw_payload as { history_detail?: { set_scores?: Array<[number, number]> } }).history_detail;
  return Array.isArray(detail?.set_scores) && detail.set_scores.length > 0 ? detail.set_scores : null;
}

/**
 * Pure core: given a player's already leakage-filtered prior-match rows
 * (any order -- sorted here by event_date ascending before windowing),
 * compute the baseline match win rate and the close-set-loss response.
 * Only the FIRST close-set loss found in each match is used as the trigger
 * (a match with two separate close-set losses only contributes one
 * "after a close-set loss" observation per following set, not double-counted).
 */
export function computePsychologicalResponseFromRows(player: string, rows: RepositoryResultsObservation[], trailingN: number = DEFAULT_TRAILING_N): PsychologicalResponseResult {
  const sorted = [...rows].sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? ""));
  const trailing = sorted.slice(-trailingN);

  let baselineN = 0, baselineWins = 0;
  let closeLossN = 0, nextSetWinN = 0, closeLossMatchWinN = 0;
  for (const row of trailing) {
    const won = matchWon(row, player);
    baselineN++; if (won) baselineWins++;

    const sets = setScoresOf(row);
    if (!sets) continue;
    const closeLossSetIndex = sets.findIndex(([f, a]) => isCloseSetLoss(f, a));
    if (closeLossSetIndex === -1) continue;
    closeLossN++;
    if (won) closeLossMatchWinN++;
    const nextSet = sets[closeLossSetIndex + 1];
    if (nextSet) {
      const [nf, na] = nextSet;
      if (nf !== na && nf > na) nextSetWinN++; // ties in a single set are unscoreable, never guessed
    }
  }

  return {
    trailing_n_used: trailing.length,
    baseline_match_win_rate: { n: baselineN, rate: baselineN > 0 ? round1((100 * baselineWins) / baselineN) : null },
    after_close_set_loss: {
      n: closeLossN,
      next_set_win_rate: closeLossN > 0 ? round1((100 * nextSetWinN) / closeLossN) : null,
      match_win_rate: closeLossN > 0 ? round1((100 * closeLossMatchWinN) / closeLossN) : null,
    },
  };
}

/** Live wrapper: fetches leakage-safe prior-match rows for `player` in `lane`, gated by the same lane eligibility #027 uses for set-sequence data. */
export function computePsychologicalResponseProxy(args: {
  player: string;
  lane: TourLane;
  asOfDate: string;
  trailingN?: number;
}): LaneOutcome<PsychologicalResponseResult> {
  const { player, lane, asOfDate, trailingN = DEFAULT_TRAILING_N } = args;
  if (!FINISHING_ABILITY_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane} has no set-sequence (set_scores) data in the static history index -- structural schema gap, not sparse data.` };
  }
  const rows = repositoryResultsRows(player, asTourFamily(lane), asOfDate, { strictBefore: true });
  const result = computePsychologicalResponseFromRows(player, rows, trailingN);
  if (result.after_close_set_loss.n === 0) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior matches with a usable close-set loss before asOfDate." };
  }
  return { lane, status: "GO", n: result.trailing_n_used, value: result };
}
