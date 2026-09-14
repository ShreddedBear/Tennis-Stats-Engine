import type { SourceRef } from "./audit-pipeline";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { laneMatchesBefore, replayElo, type HistoryLane } from "./task18c-rank-form-workload";

// Metric 061 ("Final Advanced Tests") defines a Historical Twin Match Search: "searching
// the historical database for past matchups most similar in Elo gap, hold/break gap,
// Dominance Ratio gap, form gap, market price, fatigue gap, age, ranking gap, court speed,
// model disagreement, Monte Carlo output, and data quality." Of that list, only Elo gap
// (from a deterministic chronological Elo replay) and surface/court speed are honestly
// reconstructable from the four-tour results lane this system has approved evidence for;
// hold/break gap, dominance ratio, form gap, market price, fatigue gap, age, ranking gap,
// model disagreement, Monte Carlo output and data quality are not present in the same
// chronological replay and are deliberately NOT synthesized here. This engine finds the
// nearest-neighbor "twin" matches by Elo gap (with a surface-mismatch penalty) and reports
// how often the analogous favorite (the twin's higher-Elo side) actually won -- a real,
// sourced signal, not a guess -- while remaining explicit that it only covers one of the
// definition's components.

export type TwinMatchSearchResult = {
  p1_value: string;
  p2_value: string;
  differential: string | null;
  sample: string;
  reliability: number;
  sources: SourceRef[];
} | null;

const MIN_TWIN_MATCHES = 5;
const K_NEIGHBORS = 15;
const SURFACE_MISMATCH_PENALTY = 150; // rough Elo-scale penalty for a surface mismatch

type Candidate = { eloGap: number; surface: string; favoriteWon: boolean; date: string };

function buildCandidates(lane: HistoryLane, asOfDate: string) {
  const replay = replayElo(lane, asOfDate);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const persp of replay.perspectives) {
    const forwardKey = `${persp.date}|${persp.player}|${persp.opponent}`;
    const mirrorKey = `${persp.date}|${persp.opponent}|${persp.player}`;
    if (seen.has(mirrorKey)) continue;
    seen.add(forwardKey);
    const eloGap = persp.pre_elo - persp.opponent_pre_elo;
    candidates.push({
      eloGap,
      surface: persp.surface,
      favoriteWon: eloGap >= 0 ? persp.won : !persp.won,
      date: persp.date,
    });
  }
  return { replay, candidates };
}

export function computeHistoricalTwinMatchSearch(args: {
  p1: string;
  p2: string;
  asOfDate: string;
  surface?: string | null;
  lane: HistoryLane;
}): TwinMatchSearchResult {
  const matches = laneMatchesBefore(args.lane, args.asOfDate);
  if (!matches.length) return null;
  const { replay, candidates } = buildCandidates(args.lane, args.asOfDate);
  const p1Key = normalizeEvidenceIdentity(args.p1);
  const p2Key = normalizeEvidenceIdentity(args.p2);
  const p1Elo = replay.overall.get(p1Key);
  const p2Elo = replay.overall.get(p2Key);
  if (!Number.isFinite(p1Elo) || !Number.isFinite(p2Elo)) return null;
  const targetGap = p1Elo! - p2Elo!;
  const surface = String(args.surface ?? "").trim().toLowerCase() || null;

  const ranked = candidates
    .map((c) => ({
      ...c,
      distance: Math.abs(c.eloGap - targetGap) + (surface && c.surface !== surface ? SURFACE_MISMATCH_PENALTY : 0),
    }))
    .sort((a, b) => a.distance - b.distance);

  const twins = ranked.slice(0, Math.min(K_NEIGHBORS, ranked.length));
  if (twins.length < MIN_TWIN_MATCHES) return null;

  const favoriteWins = twins.filter((t) => t.favoriteWon).length;
  const favoriteWinPct = Number(((100 * favoriteWins) / twins.length).toFixed(1));
  const avgTwinEloGap = Math.round(twins.reduce((sum, t) => sum + Math.abs(t.eloGap), 0) / twins.length);
  const surfaceMatchedTwins = surface ? twins.filter((t) => t.surface === surface).length : null;
  const currentFavorite = targetGap >= 0 ? "P1" : "P2";

  const value = [
    `twin_matches_found=${twins.length}`,
    `favorite_win_pct_in_twins=${favoriteWinPct}`,
    `avg_twin_elo_gap=${avgTwinEloGap}`,
    `current_elo_gap_p1_minus_p2=${Math.round(targetGap)}`,
    `current_analogous_favorite=${currentFavorite}`,
    surfaceMatchedTwins !== null ? `surface_matched_twins=${surfaceMatchedTwins}` : null,
    `candidate_pool=${candidates.length}`,
    "calculation=nearest-neighbor Elo-gap search over deterministic K=32 Elo replay, surface-mismatch penalized",
    "covers=elo_gap,court_speed only (hold/break gap, dominance ratio gap, form gap, market price, fatigue gap, age, ranking gap, model disagreement, Monte Carlo output, data quality not reconstructable from this lane)",
  ]
    .filter((x): x is string => x !== null)
    .join("; ");

  return {
    p1_value: value,
    p2_value: value,
    differential: `current_elo_gap_p1_minus_p2=${Math.round(targetGap)}`,
    sample: `twin_matches=${twins.length}; candidate_pool=${candidates.length}; date_window=strict pre-match chronology; future_leakage=blocked(date<match_date)`,
    reliability: 65,
    sources: replay.source_names.map((source_name) => ({ source_name, url: null, retrieved_at: null })),
  };
}
