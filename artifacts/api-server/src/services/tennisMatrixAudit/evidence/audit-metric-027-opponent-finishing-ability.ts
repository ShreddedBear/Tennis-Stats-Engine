// Metric #027 -- Opponent Finishing Ability
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #27)
//
// Two rates computed over a player's trailing N matches (default 20):
//   - Lead-protection rate: of matches where the player won set 1, what
//     fraction did they go on to win?
//   - Closing rate as underdog: of matches where the player LOST set 1,
//     what fraction did they still come back to win?
//
// Structural data gap (docs/audit-task-new-batch1-step0.md Step 0 table):
// set-sequence data (set_scores) only exists for WTA_MAIN and
// ATP_CHALLENGER in the static history index -- ATP_MAIN and WTA_CHALLENGER
// source CSVs only ever carry sets_for/sets_against totals, never the
// per-set score sequence needed to know who won set 1. This is a schema
// gap, not a sparse-data gap, so those two lanes are excluded from
// eligibility entirely rather than reported as a suspiciously-empty
// NOT_ENOUGH_DATA that looks like it might fill in later.
import { repositoryResultsRows, type RepositoryResultsObservation } from "./repository-results-history.server";
import { asTourFamily, round1, type LaneOutcome, type TourLane } from "./audit-metrics-shared";

export const DEFAULT_TRAILING_N = 20;

export const FINISHING_ABILITY_ELIGIBLE_LANES: ReadonlySet<TourLane> = new Set(["WTA_MAIN", "ATP_CHALLENGER"]);

export interface FinishingAbilityResult {
  trailing_n_used: number;
  lead_protection: { n: number; rate: number | null };
  closing_as_underdog: { n: number; rate: number | null };
}

function firstSetOutcome(row: RepositoryResultsObservation): "WON" | "LOST" | null {
  const detail = (row.raw_payload as { history_detail?: { set_scores?: Array<[number, number]> } }).history_detail;
  const firstSet = detail?.set_scores?.[0];
  if (!firstSet) return null;
  const [forGames, againstGames] = firstSet;
  if (!Number.isFinite(forGames) || !Number.isFinite(againstGames) || forGames === againstGames) return null;
  return forGames > againstGames ? "WON" : "LOST";
}

function matchWon(row: RepositoryResultsObservation, player: string): boolean {
  return (row.raw_payload as { winner?: string | null }).winner === player;
}

/**
 * Pure core: given a player's already leakage-filtered prior-match rows
 * (any order -- this function sorts by event_date itself, ascending, before
 * taking the trailing window), compute both rates over the trailing N.
 */
export function computeFinishingAbilityFromRows(player: string, rows: RepositoryResultsObservation[], trailingN: number = DEFAULT_TRAILING_N): FinishingAbilityResult {
  const sorted = [...rows].sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? ""));
  const trailing = sorted.slice(-trailingN);
  let leadN = 0, leadWins = 0, closeN = 0, closeWins = 0;
  for (const row of trailing) {
    const outcome = firstSetOutcome(row);
    if (outcome === null) continue; // unusable row (no set-score detail on this specific match) -- never guessed
    const won = matchWon(row, player);
    if (outcome === "WON") { leadN++; if (won) leadWins++; }
    else { closeN++; if (won) closeWins++; }
  }
  return {
    trailing_n_used: trailing.length,
    lead_protection: { n: leadN, rate: leadN > 0 ? round1((100 * leadWins) / leadN) : null },
    closing_as_underdog: { n: closeN, rate: closeN > 0 ? round1((100 * closeWins) / closeN) : null },
  };
}

/** Live wrapper: fetches leakage-safe prior-match rows for `player` in `lane`, gated by lane eligibility for set-sequence data. */
export function computeOpponentFinishingAbility(args: {
  player: string;
  lane: TourLane;
  asOfDate: string;
  trailingN?: number;
}): LaneOutcome<FinishingAbilityResult> {
  const { player, lane, asOfDate, trailingN = DEFAULT_TRAILING_N } = args;
  if (!FINISHING_ABILITY_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane} has no set-sequence (set_scores) data in the static history index -- structural schema gap, not sparse data.` };
  }
  const rows = repositoryResultsRows(player, asTourFamily(lane), asOfDate, { strictBefore: true });
  const result = computeFinishingAbilityFromRows(player, rows, trailingN);
  if (result.lead_protection.n === 0 && result.closing_as_underdog.n === 0) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior matches with usable first-set-outcome data before asOfDate." };
  }
  return { lane, status: "GO", n: result.trailing_n_used, value: result };
}
