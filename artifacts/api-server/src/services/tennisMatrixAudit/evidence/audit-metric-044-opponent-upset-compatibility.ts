// Metric #044 -- Opponent Upset Compatibility (real, evidence-gap.ts-spec-
// compliant build; docs/audit-task-043-044-opponent-upset-compatibility.md)
//
// evidence-gap.ts's real definition: "historical matches where the player
// was the underdog, verified upset outcomes, and similarity features for
// today's favorite across Elo, serve style, return quality, surface,
// ranking, handedness, rally style, price, and tournament level."
//
// Before this task, code "044" was wired only to
// deterministic-market-metrics.server.ts's de-vig market pricing/movement
// text -- real, but only "price," one of the definition's nine named
// similarity dimensions, standing in for the whole metric. This module
// builds the actual per-player historical-pattern content: (1) this
// player's own verified underdog wins (mirror image of
// audit-metric-036-loss-autopsy.ts's favorite-role losses -- same
// chronological replayElo pass, same set_scores-derived condition
// classifiers, reused directly from that module rather than re-derived),
// and (2) a similarity comparison between today's favorite and the
// favorites this player has upset before.
//
// Of the definition's nine similarity dimensions, this ships what a real,
// already-existing signal in this codebase can back:
//   - Elo: task18c-rank-form-workload.ts's replayElo (the same leakage-safe
//     K=32 replay #020/#031/#036/#041/#045/#046 already use) gives both
//     today's favorite's derived Elo and each historical upset opponent's
//     pre-match derived Elo -- directly comparable.
//   - Surface: every static-index match row carries a surface; the match
//     rate of this player's past upset wins on today's match surface is a
//     real, computed similarity feature.
//   - Serve/return-adjacent "reproduction" conditions: took_set_1 /
//     deciding_set / tiebreak_factor / blowout_win, reusing
//     audit-metric-036-loss-autopsy.ts's exported blowoutMargin/tiebreakSet/
//     buildSetScoreIndex set-score classifiers -- restricted to
//     WTA_MAIN/ATP_CHALLENGER, the same structural set_scores gap #036/#046
//     already document (reported null, never guessed, elsewhere).
//   - Price: kept as a SECONDARY signal only -- see the wiring layer
//     (deterministic-batch3-favorite-underdog-patterns.server.ts) for why
//     deterministic-market-metrics.server.ts's existing de-vig computation
//     is left in place as a fallback tier rather than merged into this
//     synchronous, static-index-only engine.
//
// Explicitly EXCLUDED, not guessed:
//   - Ranking: the static four-tour history index does not store a
//     historical ranking value on each match row (only current/latest
//     rankings are separately DB-sourced, via deterministic-ranking-
//     metrics.server.ts, with no historical per-match snapshot) -- the same
//     "ranking is sparse/absent, substituted with derived Elo" pattern
//     #020/#031/#041 already document for their own strength inputs.
//   - Handedness: metric-recoverability-map.ts's own #068 row states
//     plainly, "match results exist but handedness field is not confirmed
//     in current evidence universe" (TRULY_UNAVAILABLE) -- verified, not
//     assumed, and unchanged since. No historical or current handedness
//     field exists anywhere in this system to compare.
//   - Serve style / return quality / rally style: no serve/return/shot
//     statistic exists anywhere in the static history index, and no
//     approved BSD point-by-point source aggregates to a chronological
//     per-player serve/return/rally-shape series -- the same gap
//     audit-metric-036-loss-autopsy.ts's header already documents for its
//     own (mirror-image) Loss Serve/Return Deterioration bullets.
//   - Tournament level: the static index rows carry a tournament NAME and
//     ROUND, not a level/tier field, and this whole computation is already
//     scoped to a single tour lane (ATP_MAIN/WTA_MAIN/ATP_CHALLENGER/
//     WTA_CHALLENGER) per call -- so within one lane's replay, tour level
//     is structurally constant, not a real differentiator between a
//     player's various historical upset opponents. Cross-lane tournament-
//     level merging is the same materially-larger plumbing task
//     audit-metric-020-level-tour-transition.ts's header already declines
//     to attempt for its own "Tour-Level Transition Performance" bullet.
//
// Standing pattern (same as every module audit-metrics-shared.ts documents):
// per-tour-lane GO/NOT_ENOUGH_DATA, never a single fabricated verdict.
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { replayElo, type HistoryLane } from "./task18c-rank-form-workload";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";
import { blowoutMargin, tiebreakSet, buildSetScoreIndex, LOSS_AUTOPSY_SET_SEQUENCE_LANES, DEFAULT_TRAILING_LOSSES } from "./audit-metric-036-loss-autopsy";

export const UPSET_COMPATIBILITY_SET_SEQUENCE_LANES = LOSS_AUTOPSY_SET_SEQUENCE_LANES;
export const DEFAULT_TRAILING_UPSET_WINS = DEFAULT_TRAILING_LOSSES;

export interface UpsetWinRecord {
  date: string;
  opponent: string;
  elo_gap: number; // player_pre_elo - opponent_pre_elo; negative means player was the underdog (always negative in this list by construction)
  opponent_quality_elo: number; // the favorite's pre-match derived Elo -- the "quality of favorite upset" this win establishes a track record against
  surface: string | null;
  took_set_1: boolean | null;
  deciding_set: boolean | null;
  tiebreak_factor: boolean | null;
  blowout_win: boolean | null;
}

export interface UnderdogWinProfileResult {
  trailing_underdog_wins_used: number;
  set_sequence_available: boolean;
  underdog_wins: UpsetWinRecord[]; // most recent first, capped to trailing_underdog_wins_used
  avg_upset_opponent_quality_elo: number | null;
  took_set_1_rate_pct: number | null;
  deciding_set_rate_pct: number | null;
  tiebreak_factor_rate_pct: number | null;
  blowout_win_rate_pct: number | null;
  surface_breakdown: Record<string, number>;
}

/**
 * Pure core: given this player's chronologically-ordered (oldest-first) WIN
 * perspectives from a single replayElo pass, already filtered to the ones
 * where the player was the underdog (a "verified upset outcome" -- the
 * match result plus a lower pre-match Elo than the opponent, both drawn
 * from the same leakage-safe replay every other module in this batch
 * relies on), compute the trailing-N underdog win profile.
 */
export function computeUnderdogWinProfileFromPerspectives(
  chronologicalUpsetWins: Array<{ date: string; opponent: string; pre_elo: number; opponent_pre_elo: number }>,
  setScoresFor: ((date: string, opponent: string) => Array<[number, number]> | undefined) | null,
  trailingN: number = DEFAULT_TRAILING_UPSET_WINS,
): UnderdogWinProfileResult {
  const trailing = chronologicalUpsetWins.slice(-trailingN);
  const wins: UpsetWinRecord[] = trailing.map(w => {
    const gap = round1(w.pre_elo - w.opponent_pre_elo)!;
    const setScores = setScoresFor?.(w.date, normalizeEvidenceIdentity(w.opponent));
    const hasSets = Array.isArray(setScores) && setScores.length > 0;
    return {
      date: w.date,
      opponent: w.opponent,
      elo_gap: gap,
      opponent_quality_elo: round1(w.opponent_pre_elo)!,
      surface: null, // attached by the live wrapper, same convention as #036's computeLossAutopsy
      took_set_1: hasSets ? (setScores![0][0] > setScores![0][1]) : null,
      deciding_set: hasSets ? setScores!.length >= 3 : null,
      tiebreak_factor: hasSets ? setScores!.some(tiebreakSet) : null,
      blowout_win: hasSets ? setScores!.some(blowoutMargin) : null,
    };
  }).reverse(); // most recent first for output

  const withSets = wins.filter(w => w.took_set_1 !== null);
  const rate = (n: number, d: number) => (d ? round1((100 * n) / d) : null);
  const surfaceBreakdown: Record<string, number> = {};
  for (const w of wins) if (w.surface) surfaceBreakdown[w.surface] = (surfaceBreakdown[w.surface] ?? 0) + 1;

  return {
    trailing_underdog_wins_used: wins.length,
    set_sequence_available: setScoresFor !== null,
    underdog_wins: wins,
    avg_upset_opponent_quality_elo: wins.length ? round1(wins.reduce((s, w) => s + w.opponent_quality_elo, 0) / wins.length) : null,
    took_set_1_rate_pct: rate(withSets.filter(w => w.took_set_1).length, withSets.length),
    deciding_set_rate_pct: rate(withSets.filter(w => w.deciding_set).length, withSets.length),
    tiebreak_factor_rate_pct: rate(withSets.filter(w => w.tiebreak_factor).length, withSets.length),
    blowout_win_rate_pct: rate(withSets.filter(w => w.blowout_win).length, withSets.length),
    surface_breakdown: surfaceBreakdown,
  };
}

/**
 * Live wrapper: replays Elo for the lane, extracts this player's
 * chronological UNDERDOG win perspectives (with surface attached from the
 * raw lane rows) and set-sequence lookup where the lane supports it. Reused
 * directly by audit-metric-043-favorite-failure-mode.ts to assess an
 * opponent's own "sourced ability to reproduce" a favorite's failure
 * conditions -- an opponent's underdog-win profile IS that ability, viewed
 * from the other side of the same replay.
 */
export function computeUnderdogWinProfile(args: { player: string; lane: TourLane; asOfDate: string; trailingN?: number }): LaneOutcome<UnderdogWinProfileResult> {
  const { player, lane, asOfDate, trailingN = DEFAULT_TRAILING_UPSET_WINS } = args;
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayElo(historyLane as never, asOfDate);
  const key = normalizeEvidenceIdentity(player);
  const chronologicalUpsetWins = replay.perspectives
    .filter(p => p.player === key && p.won && p.pre_elo < p.opponent_pre_elo)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(p => ({ date: p.date, opponent: p.opponent, pre_elo: p.pre_elo, opponent_pre_elo: p.opponent_pre_elo, surface: p.surface }));
  if (!chronologicalUpsetWins.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No verified prior underdog wins before asOfDate in this lane." };
  }
  const setSequenceLane = UPSET_COMPATIBILITY_SET_SEQUENCE_LANES.has(lane);
  const players = new Set(chronologicalUpsetWins.map(w => w.opponent).concat(player));
  const setScoreIndex = setSequenceLane ? buildSetScoreIndex(historyLane as never, players) : null;
  const setScoresFor = setSequenceLane
    ? (date: string, opponent: string) => setScoreIndex!.get(key)?.get(`${date}|${opponent}`)
    : null;
  const result = computeUnderdogWinProfileFromPerspectives(chronologicalUpsetWins, setScoresFor, trailingN);
  const surfaceByKey = new Map(chronologicalUpsetWins.map(w => [`${w.date}|${normalizeEvidenceIdentity(w.opponent)}`, w.surface]));
  for (const w of result.underdog_wins) w.surface = surfaceByKey.get(`${w.date}|${normalizeEvidenceIdentity(w.opponent)}`) ?? null;
  const surfaceBreakdown: Record<string, number> = {};
  for (const w of result.underdog_wins) if (w.surface) surfaceBreakdown[w.surface] = (surfaceBreakdown[w.surface] ?? 0) + 1;
  result.surface_breakdown = surfaceBreakdown;
  return { lane, status: "GO", n: result.trailing_underdog_wins_used, value: result };
}

export const OPPONENT_UPSET_COMPATIBILITY_EXCLUDED_DIMENSIONS = [
  "ranking (no historical per-match ranking snapshot in the static index; derived Elo substitutes, same as #020/#031/#041)",
  "handedness (metric-recoverability-map.ts #068: TRULY_UNAVAILABLE, not confirmed anywhere in this system's evidence universe)",
  "serve style (no chronological per-player serve series anywhere in the static index or approved BSD PBP aggregation)",
  "return quality (same gap as serve style)",
  "rally style (no shot-level data anywhere in this system)",
  "tournament level (static index rows carry name/round, not a level field; this computation is already scoped to one tour lane, making level structurally constant within it)",
] as const;

export interface OpponentUpsetCompatibilityResult {
  underdog_win_profile: UnderdogWinProfileResult;
  todays_favorite_elo: number | null;
  elo_gap_to_avg_upset_opponent: number | null; // todays_favorite_elo - avg_upset_opponent_quality_elo; smaller absolute value = more similar to favorites already upset
  surface_match_rate_pct: number | null; // % of underdog wins that were on today's match surface (null if surface not supplied)
  todays_match_surface: string | null;
  excluded_similarity_dimensions: typeof OPPONENT_UPSET_COMPATIBILITY_EXCLUDED_DIMENSIONS;
}

/**
 * Live wrapper: builds this player's underdog-win profile, then compares
 * today's favorite (by derived Elo) and today's match surface against it.
 * "Price" is deliberately not computed here -- see the module header and
 * the wiring layer for why that stays a separate, secondary tier rather
 * than a merged input to this synchronous engine.
 */
export function computeOpponentUpsetCompatibility(args: {
  player: string;
  todaysFavorite: string;
  lane: TourLane;
  asOfDate: string;
  todaysMatchSurface?: string | null;
  trailingN?: number;
}): LaneOutcome<OpponentUpsetCompatibilityResult> {
  const { player, todaysFavorite, lane, asOfDate, todaysMatchSurface = null, trailingN } = args;
  const profile = computeUnderdogWinProfile({ player, lane, asOfDate, trailingN });
  if (profile.status !== "GO") return profile;

  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayElo(historyLane as never, asOfDate);
  const favoriteElo = replay.overall.get(normalizeEvidenceIdentity(todaysFavorite)) ?? null;
  const avgUpsetOpponentElo = profile.value.avg_upset_opponent_quality_elo;
  const eloGap = favoriteElo !== null && avgUpsetOpponentElo !== null ? round1(favoriteElo - avgUpsetOpponentElo) : null;

  const surfaceKey = todaysMatchSurface ? String(todaysMatchSurface).trim().toLowerCase() : null;
  const winsWithSurface = profile.value.underdog_wins.filter(w => w.surface);
  const surfaceMatchRate = surfaceKey && winsWithSurface.length
    ? round1((100 * winsWithSurface.filter(w => w.surface === surfaceKey).length) / winsWithSurface.length)
    : null;

  return {
    lane, status: "GO", n: profile.n,
    value: {
      underdog_win_profile: profile.value,
      todays_favorite_elo: favoriteElo !== null ? round1(favoriteElo) : null,
      elo_gap_to_avg_upset_opponent: eloGap,
      surface_match_rate_pct: surfaceMatchRate,
      todays_match_surface: surfaceKey,
      excluded_similarity_dimensions: OPPONENT_UPSET_COMPATIBILITY_EXCLUDED_DIMENSIONS,
    },
  };
}
