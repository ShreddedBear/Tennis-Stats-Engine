// Metric #036 -- Loss Autopsy Metrics (real, per-player, evidence-gap.ts-
// spec-compliant build; docs/audit-task-020-026-034-036-045-052-053.md;
// public/seed/metrics.txt #36)
//
// NOT to be confused with audit-metric-036-037-039-live.server.ts /
// audit-metric-036-037-loss-win-autopsy.ts, an earlier build that classifies
// TennisMatrixAi's WHOLE scored-match population into a single DB-wide
// distribution -- see that file's own header. This module instead replays
// THIS player's own chronological loss history from the four-tour static
// index (the same source/pattern audit-metric-027/031/041/046 already use),
// which is what evidence-gap.ts's per-player definition actually requires.
//
// Of the catalog's fifteen bullets, this ships the ones derivable from the
// static history index + derived Elo:
//   - Loss Favorite Status: was the player the Elo favorite going into each
//     loss (pre-match derived Elo higher than the opponent's)?
//   - Loss Opponent Quality: opponent's pre-match derived Elo for each loss.
//   - Loss Surface: surface of each loss.
//   - Lost Set 1 / Loss in Deciding Set / Loss in Tiebreak: derived from
//     set_scores -- restricted to WTA_MAIN/ATP_CHALLENGER (the same
//     structural set-sequence gap #027/#046 already document); reported as
//     null (never guessed) on ATP_MAIN/WTA_CHALLENGER.
//   - Competitive vs Blowout Loss: same set_scores restriction.
//   - Bad-Loss Severity Index: a composite, defined here as the average
//     Elo gap by which the player was favored in their trailing losses
//     (0 for underdog losses) -- directly reflects "how damaging" a loss
//     was using only the Elo-favorite signal and opponent quality this
//     index can actually support, not a fabricated multi-factor score.
//
// NOT shipped (BLOCKED, not implemented -- no such data anywhere in the
// static history index or approved BSD PBP aggregated to a chronological
// per-player series): Loss Point Differential, Loss Break Differential,
// Loss Serve Deterioration, Loss Return Deterioration, Loss Physical
// Problem, Loss Match Length. "Lost After Leading" is also not shipped --
// set_scores gives the final per-set score, not whether the player held a
// mid-match lead before losing it, so it cannot be honestly derived from
// this row type either.
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { replayElo, type HistoryLane } from "./task18c-rank-form-workload";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const DEFAULT_TRAILING_LOSSES = 20;
export const LOSS_AUTOPSY_SET_SEQUENCE_LANES: ReadonlySet<TourLane> = new Set(["WTA_MAIN", "ATP_CHALLENGER"]);

export type FavoriteStatus = "FAVORITE" | "UNDERDOG" | "EVEN";

export interface LossRecord {
  date: string;
  opponent: string;
  favorite_status: FavoriteStatus;
  elo_gap: number; // player_pre_elo - opponent_pre_elo; positive means player was favored
  opponent_quality_elo: number;
  surface: string | null;
  lost_set_1: boolean | null;
  deciding_set: boolean | null;
  tiebreak_factor: boolean | null;
  blowout_loss: boolean | null;
}

export interface LossAutopsyResult {
  trailing_losses_used: number;
  set_sequence_available: boolean;
  losses: LossRecord[]; // most recent first, capped to trailing_losses_used
  favorite_losses_n: number;
  favorite_losses_rate_pct: number | null;
  bad_loss_severity_index: number; // avg elo_gap among favorite-role losses only (0 floor)
  surface_breakdown: Record<string, number>;
}

// Exported (in addition to being used locally below) so metrics #043/#044
// (audit-metric-043-favorite-failure-mode.ts / audit-metric-044-opponent-
// upset-compatibility.ts) can reuse the exact same set-score condition
// classifiers this module already defines and tests, rather than
// re-deriving a second, potentially-diverging copy of "what counts as a
// blowout / a tiebreak set" for the mirror-image win/underdog side of this
// same analysis.
export function blowoutMargin([a, b]: [number, number]): boolean {
  return Math.abs(a - b) >= 4;
}
export function tiebreakSet([a, b]: [number, number]): boolean {
  return (a === 7 && b === 6) || (a === 6 && b === 7);
}

/**
 * Builds a per-player {date|normalizedOpponent -> set_scores} index directly
 * from the raw lane object, mirroring audit-metric-046-match-state-elo.ts's
 * buildSetScoreIndex so this stays drawn from exactly the same source
 * laneMatchesBefore/replayElo already read (never a separately-diverging
 * global lookup). Exported for the same reuse reason as blowoutMargin/
 * tiebreakSet above.
 */
export function buildSetScoreIndex(lane: HistoryLane, players: Set<string>): Map<string, Map<string, Array<[number, number]>>> {
  const index = new Map<string, Map<string, Array<[number, number]>>>();
  for (const player of players) {
    const key = normalizeEvidenceIdentity(player);
    const entries = (lane as Record<string, unknown[][]>)[key];
    const byKey = new Map<string, Array<[number, number]>>();
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const [dateRaw, , , opponentRaw, , , , detailRaw] = entry as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, { set_scores?: Array<[number, number]> }?];
        const date = String(dateRaw ?? "").slice(0, 10);
        const opponent = normalizeEvidenceIdentity(String(opponentRaw ?? ""));
        const setScores = detailRaw?.set_scores;
        if (!date || !opponent || !Array.isArray(setScores) || !setScores.length) continue;
        const lookupKey = `${date}|${opponent}`;
        if (!byKey.has(lookupKey)) byKey.set(lookupKey, setScores);
      }
    }
    index.set(key, byKey);
  }
  return index;
}

/**
 * Pure core: given this player's chronologically-ordered (oldest-first)
 * loss perspectives from a single replayElo pass, and an optional
 * set-scores lookup (null when the lane structurally lacks set-sequence
 * data), compute the trailing-N loss autopsy.
 */
export function computeLossAutopsyFromPerspectives(
  chronologicalLosses: Array<{ date: string; opponent: string; pre_elo: number; opponent_pre_elo: number }>,
  setScoresFor: ((date: string, opponent: string) => Array<[number, number]> | undefined) | null,
  trailingN: number = DEFAULT_TRAILING_LOSSES,
): LossAutopsyResult {
  const trailing = chronologicalLosses.slice(-trailingN);
  const losses: LossRecord[] = trailing.map(l => {
    const gap = round1(l.pre_elo - l.opponent_pre_elo)!;
    const favoriteStatus: FavoriteStatus = gap > 0 ? "FAVORITE" : gap < 0 ? "UNDERDOG" : "EVEN";
    const setScores = setScoresFor?.(l.date, normalizeEvidenceIdentity(l.opponent));
    const hasSets = Array.isArray(setScores) && setScores.length > 0;
    return {
      date: l.date,
      opponent: l.opponent,
      favorite_status: favoriteStatus,
      elo_gap: gap,
      opponent_quality_elo: round1(l.opponent_pre_elo)!,
      surface: null, // surface is attached by the live wrapper (repositoryResultsRows carries it; the raw perspective replay does not)
      lost_set_1: hasSets ? (setScores![0][0] < setScores![0][1]) : null,
      deciding_set: hasSets ? setScores!.length >= 3 : null,
      tiebreak_factor: hasSets ? setScores!.some(tiebreakSet) : null,
      blowout_loss: hasSets ? setScores!.some(blowoutMargin) : null,
    };
  }).reverse(); // most recent first for output

  const favoriteLosses = losses.filter(l => l.favorite_status === "FAVORITE");
  const surfaceBreakdown: Record<string, number> = {};
  for (const l of losses) if (l.surface) surfaceBreakdown[l.surface] = (surfaceBreakdown[l.surface] ?? 0) + 1;

  return {
    trailing_losses_used: losses.length,
    set_sequence_available: setScoresFor !== null,
    losses,
    favorite_losses_n: favoriteLosses.length,
    favorite_losses_rate_pct: losses.length ? round1((100 * favoriteLosses.length) / losses.length) : null,
    bad_loss_severity_index: favoriteLosses.length ? round1(favoriteLosses.reduce((s, l) => s + l.elo_gap, 0) / favoriteLosses.length)! : 0,
    surface_breakdown: surfaceBreakdown,
  };
}

/** Live wrapper: replays Elo for the lane, extracts this player's chronological loss perspectives (with surface attached from the raw lane rows) and set-sequence lookup where the lane supports it. */
export function computeLossAutopsy(args: { player: string; lane: TourLane; asOfDate: string; trailingN?: number }): LaneOutcome<LossAutopsyResult> {
  const { player, lane, asOfDate, trailingN = DEFAULT_TRAILING_LOSSES } = args;
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayElo(historyLane as never, asOfDate);
  const key = normalizeEvidenceIdentity(player);
  const chronologicalLosses = replay.perspectives
    .filter(p => p.player === key && !p.won)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(p => ({ date: p.date, opponent: p.opponent, pre_elo: p.pre_elo, opponent_pre_elo: p.opponent_pre_elo, surface: p.surface }));
  if (!chronologicalLosses.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior losses before asOfDate in this lane." };
  }
  const setSequenceLane = LOSS_AUTOPSY_SET_SEQUENCE_LANES.has(lane);
  const players = new Set(chronologicalLosses.map(l => l.opponent).concat(player));
  const setScoreIndex = setSequenceLane ? buildSetScoreIndex(historyLane as never, players) : null;
  const setScoresFor = setSequenceLane
    ? (date: string, opponent: string) => setScoreIndex!.get(key)?.get(`${date}|${opponent}`)
    : null;
  const result = computeLossAutopsyFromPerspectives(chronologicalLosses, setScoresFor, trailingN);
  // Attach surface (the pure core intentionally leaves it null -- see its own comment).
  const surfaceByKey = new Map(chronologicalLosses.map(l => [`${l.date}|${normalizeEvidenceIdentity(l.opponent)}`, l.surface]));
  for (const l of result.losses) l.surface = surfaceByKey.get(`${l.date}|${normalizeEvidenceIdentity(l.opponent)}`) ?? null;
  const surfaceBreakdown: Record<string, number> = {};
  for (const l of result.losses) if (l.surface) surfaceBreakdown[l.surface] = (surfaceBreakdown[l.surface] ?? 0) + 1;
  result.surface_breakdown = surfaceBreakdown;
  return { lane, status: "GO", n: result.trailing_losses_used, value: result };
}
