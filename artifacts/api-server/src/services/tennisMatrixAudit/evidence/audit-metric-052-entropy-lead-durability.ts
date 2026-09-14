// Metric #052 -- Entropy & Lead Durability
// (docs/audit-task-020-026-034-036-045-052-053.md; public/seed/metrics.txt #52)
//
// Of the catalog's eight bullets, this ships "Set-Score Entropy" and
// "Game-Score Entropy" only, and with a documented granularity
// substitution: the catalog defines these as "how concentrated or spread
// out the range of PLAUSIBLE final scorelines is FOR A GIVEN WIN
// PROBABILITY" -- a forward-looking model output. This module instead
// computes the Shannon entropy of the player's own REALIZED historical
// set-score / total-games-per-set distribution (as of asOfDate) -- an
// empirical proxy for the same underlying idea (how varied vs. how
// concentrated this player's actual scorelines tend to be), not the
// win-probability-conditioned model the catalog describes. Documented, not
// hidden, per this project's established convention for this kind of
// substitution (see #031's header).
//
// NOT shipped (BLOCKED): Lead Durability Index, Deficit Survivability
// Index, Double-Break Creation/Surrender Rate, Rebreak-Window Probability,
// and Break Clustering all need in-match break/lead-state sequence -- the
// static history index only ever carries a set's FINAL score, never break
// events or lead state during play. Not approximated; left undone.
//
// Lane restriction: WTA_MAIN/ATP_CHALLENGER only -- set_scores is a
// structural schema gap on ATP_MAIN/WTA_CHALLENGER, same as #027/#045/#046.
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { round1, type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

export const ENTROPY_ELIGIBLE_LANES: ReadonlySet<TourLane> = new Set(["WTA_MAIN", "ATP_CHALLENGER"]);

export interface EntropyLeadDurabilityResult {
  sets_n: number;
  set_score_entropy_bits: number;
  game_score_entropy_bits: number;
  distinct_set_scores: number;
}

/** Shannon entropy in bits over the frequency distribution of `labels`. */
function shannonEntropyBits(labels: string[]): number {
  if (!labels.length) return 0;
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const n = labels.length;
  let h = 0;
  for (const count of counts.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Pure core: given a player's already leakage-filtered set-score sequences (each entry one historical match's set_scores, self-perspective), compute both entropy figures. */
export function computeEntropyFromSetScores(matchSetScores: Array<Array<[number, number]>>): EntropyLeadDurabilityResult {
  const allSets = matchSetScores.filter(s => Array.isArray(s) && s.length > 0).flat();
  const setScoreLabels = allSets.map(([a, b]) => `${a}-${b}`);
  const gameCountLabels = allSets.map(([a, b]) => String(a + b));
  return {
    sets_n: allSets.length,
    set_score_entropy_bits: round1(shannonEntropyBits(setScoreLabels))!,
    game_score_entropy_bits: round1(shannonEntropyBits(gameCountLabels))!,
    distinct_set_scores: new Set(setScoreLabels).size,
  };
}

/** Live wrapper: reads `player`'s own set_scores history strictly before asOfDate from the static index, gated by lane eligibility. */
export function computeEntropyLeadDurability(args: { player: string; lane: TourLane; asOfDate: string }): LaneOutcome<EntropyLeadDurabilityResult> {
  const { player, lane, asOfDate } = args;
  if (!ENTROPY_ELIGIBLE_LANES.has(lane)) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `${lane} has no set-sequence (set_scores) data in the static history index -- structural schema gap, not sparse data.` };
  }
  const family = asTourFamily(lane);
  const historyLane = loadRuntimeIndex().matchHistory[family] as unknown as Record<string, unknown[][]>;
  const key = normalizeEvidenceIdentity(player);
  const entries = historyLane[key];
  if (!Array.isArray(entries) || !entries.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior matches before asOfDate for this player in this lane." };
  }
  const matchSetScores: Array<Array<[number, number]>> = [];
  for (const entry of entries) {
    const [dateRaw, , , , , , , detailRaw] = entry as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, { set_scores?: Array<[number, number]> }?];
    const date = String(dateRaw ?? "").slice(0, 10);
    if (!date || date >= asOfDate) continue; // leakage guard: strictly before asOfDate
    const setScores = detailRaw?.set_scores;
    if (Array.isArray(setScores) && setScores.length) matchSetScores.push(setScores);
  }
  if (!matchSetScores.length) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "No prior matches with usable set_scores before asOfDate." };
  }
  const result = computeEntropyFromSetScores(matchSetScores);
  return { lane, status: "GO", n: result.sets_n, value: result };
}
