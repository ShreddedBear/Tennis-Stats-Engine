// Metric #020 -- Level/Tour Transition (real, evidence-gap.ts-spec-compliant
// build; docs/audit-task-020-026-034-036-045-052-053.md; public/seed/metrics.txt #20)
//
// historical-results-recovery.ts's old "020" case computed a trailing-90-day
// opponent-quality-banded win record -- that has been retargeted to real
// code 006 ("Opponent-Adjusted Strength of Schedule"), freeing this code to
// be built fresh against its actual definition.
//
// Of the catalog's three bullets, this ships two:
//   - Performance vs Opponent Elo Differential: win rate binned by the exact
//     pre-match derived-Elo gap (task18c-rank-form-workload.ts's replayElo,
//     the same leakage-safe K=32 replay #031/#036/#041/#045 already use),
//     not ranking bands (the catalog explicitly asks for Elo gap "rather
//     than ranking bands", and rank is sparse/absent in exactly the lanes
//     rank always is here -- same substitution #031/#041 already made).
//   - Post-Strong/Weak-Tournament Performance: for each of a player's
//     tournament "runs" (a maximal sequence of consecutive matches sharing
//     one tournament name), the immediately preceding different-tournament
//     run is classified STRONG (its own win rate >= 50%) or WEAK; this
//     player's win rate in matches following a STRONG vs. a WEAK prior
//     tournament is reported separately -- a direct regression-to-the-mean
//     check.
//
// NOT shipped (BLOCKED): "Tour-Level Transition Performance" (results when
// moving between tour levels, e.g. ITF->Challenger->ATP/WTA or
// qualifying->main-draw) needs merging a player's identity across two
// SEPARATE static-index lane dictionaries (e.g. ATP_MAIN and
// ATP_CHALLENGER) ordered by date to detect a level switch -- a materially
// larger cross-lane plumbing task than any other module in this batch
// attempts, and not built here. The round field does carry some qualifying
// signal ("Q1"/"Q2" etc., used elsewhere in this codebase for qualifying
// detection), but a genuine "moving between tour levels" signal needs the
// cross-lane merge regardless, so this was not partially approximated
// either. Documented, not attempted.
//
// Available on all four tour lanes -- neither shipped bullet needs
// set_scores (the structural gap #027/#036/#045/#046/#052 all work around).
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { replayElo } from "./task18c-rank-form-workload";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export type EloDifferentialBand = "FAVORITE_STRONG_100_PLUS" | "FAVORITE_SLIGHT_0_100" | "UNDERDOG_SLIGHT_0_100" | "UNDERDOG_STRONG_100_PLUS";
const ELO_BANDS: EloDifferentialBand[] = ["FAVORITE_STRONG_100_PLUS", "FAVORITE_SLIGHT_0_100", "UNDERDOG_SLIGHT_0_100", "UNDERDOG_STRONG_100_PLUS"];

function bandOf(gap: number): EloDifferentialBand {
  if (gap >= 100) return "FAVORITE_STRONG_100_PLUS";
  if (gap >= 0) return "FAVORITE_SLIGHT_0_100";
  if (gap > -100) return "UNDERDOG_SLIGHT_0_100";
  return "UNDERDOG_STRONG_100_PLUS";
}

export interface EloBandRecord { band: EloDifferentialBand; n: number; win_rate: number | null }
export interface PostTournamentBucket { n: number; win_rate: number | null }

export interface LevelTourTransitionResult {
  matches_used: number;
  elo_differential_bands: EloBandRecord[];
  following_strong_tournament: PostTournamentBucket;
  following_weak_tournament: PostTournamentBucket;
}

interface ChronoMatch { date: string; tournament: string; won: boolean; pre_elo: number; opponent_pre_elo: number }

function computeEloBands(matches: ChronoMatch[]): EloBandRecord[] {
  const buckets = new Map<EloDifferentialBand, { n: number; w: number }>();
  for (const band of ELO_BANDS) buckets.set(band, { n: 0, w: 0 });
  for (const m of matches) {
    const band = bandOf(m.pre_elo - m.opponent_pre_elo);
    const b = buckets.get(band)!;
    b.n++;
    if (m.won) b.w++;
  }
  return ELO_BANDS.map(band => {
    const b = buckets.get(band)!;
    return { band, n: b.n, win_rate: b.n > 0 ? round1((100 * b.w) / b.n) : null };
  });
}

function normTournament(v: string): string {
  return v.trim().toLowerCase();
}

/** Pure core: given a player's chronologically-ordered (oldest-first) matches, group into tournament runs and classify each run's outcomes by whether the immediately preceding (different) run was STRONG (>=50% win rate) or WEAK. */
function computePostTournamentBuckets(matchesAsc: ChronoMatch[]): { following_strong_tournament: PostTournamentBucket; following_weak_tournament: PostTournamentBucket } {
  type Run = { tournament: string; matches: ChronoMatch[] };
  const runs: Run[] = [];
  for (const m of matchesAsc) {
    const key = normTournament(m.tournament);
    const last = runs[runs.length - 1];
    if (last && last.tournament === key) last.matches.push(m);
    else runs.push({ tournament: key, matches: [m] });
  }
  let strongN = 0, strongW = 0, weakN = 0, weakW = 0;
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1], cur = runs[i];
    if (!prev.tournament) continue; // no usable tournament label -- never guessed
    const prevWins = prev.matches.filter(m => m.won).length;
    const prevWinRate = prevWins / prev.matches.length;
    const isStrong = prevWinRate >= 0.5;
    for (const m of cur.matches) {
      if (isStrong) { strongN++; if (m.won) strongW++; }
      else { weakN++; if (m.won) weakW++; }
    }
  }
  return {
    following_strong_tournament: { n: strongN, win_rate: strongN > 0 ? round1((100 * strongW) / strongN) : null },
    following_weak_tournament: { n: weakN, win_rate: weakN > 0 ? round1((100 * weakW) / weakN) : null },
  };
}

export function computeLevelTourTransitionFromMatches(matchesAsc: ChronoMatch[]): LevelTourTransitionResult {
  const bands = computeEloBands(matchesAsc);
  const post = computePostTournamentBuckets(matchesAsc);
  return { matches_used: matchesAsc.length, elo_differential_bands: bands, ...post };
}

/** Live wrapper: replays Elo for the lane and extracts this player's chronological perspectives (with tournament attached) before delegating to the pure core. */
export function computeLevelTourTransition(args: { player: string; lane: TourLane; asOfDate: string }): LaneOutcome<LevelTourTransitionResult> {
  const { player, lane, asOfDate } = args;
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family];
  const replay = replayElo(historyLane as never, asOfDate);
  const key = normalizeEvidenceIdentity(player);
  const matchesAsc: ChronoMatch[] = replay.perspectives
    .filter(p => p.player === key)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(p => ({ date: p.date, tournament: p.tournament ?? "", won: p.won, pre_elo: p.pre_elo, opponent_pre_elo: p.opponent_pre_elo }));
  if (!matchesAsc.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior matches before asOfDate in this lane." };
  }
  const result = computeLevelTourTransitionFromMatches(matchesAsc);
  return { lane, status: "GO", n: result.matches_used, value: result };
}
