// Metric #041 -- Hidden Improvement Detector
// (docs/audit-task-new-batch1-step0.md; public/seed/metrics.txt #41)
//
// Of the catalog's two bullets:
//   - "Opponent-Quality-Adjusted Record Trend: whether a player's win-loss
//     record is understating improvement because it comes against tougher
//     opponents." -- this ships, using derived Elo (see below).
//   - "Underlying-Metric Improvement Despite Losses" (needs hold rate,
//     return points won, Dominance Ratio, break points created) --
//     BLOCKED, not implemented. None of those point/game-level stats exist
//     anywhere in the four-tour static history index (results-only: date,
//     opponent, won/lost, round, set counts). Documented here so it is not
//     re-attempted without new data, per this batch's established pattern
//     for dropped refinements (#029's break-point-advantage closeness).
//
// Strength adjustment: derived Elo via task18c-rank-form-workload.ts's
// replayElo (deterministic, leakage-safe K=32 replay), per
// docs/audit-task-new-batch1-step0.md's resolution -- same substitution
// #031 uses, and for the same reason (rank is sparse/absent in exactly the
// lanes rank always is; Elo replays from raw results alone in every lane).
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { replayElo } from "./task18c-rank-form-workload";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const DEFAULT_TREND_WINDOW = 20;

export interface HalfWindowStats {
  n: number;
  raw_win_rate: number | null;
  avg_opponent_elo: number | null;
  mean_elo_adjusted_surplus: number | null; // avg(actual outcome - Elo-expected win probability)
}

export type HiddenImprovementFlag = "IMPROVEMENT_HIDDEN_BY_RECORD" | "NO_HIDDEN_IMPROVEMENT_DETECTED";

export interface HiddenImprovementResult {
  earlier_half: HalfWindowStats;
  recent_half: HalfWindowStats;
  flag: HiddenImprovementFlag;
}

function expectedWinProbability(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

interface TrendPerspective { won: boolean; pre_elo: number; opponent_pre_elo: number }

function summarizeHalf(matches: TrendPerspective[]): HalfWindowStats {
  const n = matches.length;
  if (n === 0) return { n: 0, raw_win_rate: null, avg_opponent_elo: null, mean_elo_adjusted_surplus: null };
  const wins = matches.filter(m => m.won).length;
  const avgOpponentElo = matches.reduce((sum, m) => sum + m.opponent_pre_elo, 0) / n;
  const meanSurplus = matches.reduce((sum, m) => sum + ((m.won ? 1 : 0) - expectedWinProbability(m.pre_elo, m.opponent_pre_elo)), 0) / n;
  return {
    n,
    raw_win_rate: round1((100 * wins) / n),
    avg_opponent_elo: round1(avgOpponentElo),
    mean_elo_adjusted_surplus: round1(meanSurplus * 100)! / 100,
  };
}

/**
 * Pure core: given a player's chronologically-ordered (oldest-first)
 * trailing perspectives, splits them into an earlier and a recent half and
 * flags "hidden improvement" when the raw win rate is flat or declining
 * while the Elo-adjusted surplus (performance relative to what tougher
 * opponents predict) is actually improving.
 */
export function computeHiddenImprovementFromPerspectives(chronological: TrendPerspective[], window: number = DEFAULT_TREND_WINDOW): HiddenImprovementResult {
  const trailing = chronological.slice(-window);
  const mid = Math.floor(trailing.length / 2);
  const earlier = summarizeHalf(trailing.slice(0, mid));
  const recent = summarizeHalf(trailing.slice(mid));
  const recordFlatOrDeclining = earlier.raw_win_rate !== null && recent.raw_win_rate !== null && recent.raw_win_rate <= earlier.raw_win_rate;
  const qualityAdjustedImproving = earlier.mean_elo_adjusted_surplus !== null && recent.mean_elo_adjusted_surplus !== null && recent.mean_elo_adjusted_surplus > earlier.mean_elo_adjusted_surplus;
  const flag: HiddenImprovementFlag = recordFlatOrDeclining && qualityAdjustedImproving ? "IMPROVEMENT_HIDDEN_BY_RECORD" : "NO_HIDDEN_IMPROVEMENT_DETECTED";
  return { earlier_half: earlier, recent_half: recent, flag };
}

/** Live wrapper: replays Elo for the lane and extracts this player's chronological perspectives before delegating to the pure core. */
export function computeHiddenImprovementDetector(args: {
  player: string;
  lane: TourLane;
  asOfDate: string;
  window?: number;
}): LaneOutcome<HiddenImprovementResult> {
  const { player, lane, asOfDate, window = DEFAULT_TREND_WINDOW } = args;
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayElo(historyLane as never, asOfDate);
  const key = normalizeEvidenceIdentity(player);
  const chronological = replay.perspectives
    .filter(p => p.player === key)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(p => ({ won: p.won, pre_elo: p.pre_elo, opponent_pre_elo: p.opponent_pre_elo }));
  if (chronological.length < 2) {
    return { lane, status: "NOT_ENOUGH_DATA", n: chronological.length, reason: "Fewer than 2 prior matches before asOfDate -- cannot split into an earlier/recent half." };
  }
  const result = computeHiddenImprovementFromPerspectives(chronological, window);
  return { lane, status: "GO", n: chronological.length, value: result };
}
