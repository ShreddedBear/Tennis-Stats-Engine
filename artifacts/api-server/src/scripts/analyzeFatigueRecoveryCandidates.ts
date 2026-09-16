// One-off, expensive batch analysis (per `follow-up-tasks`/spec conventions this is NOT re-run
// casually). Task #91: tests whether a redesigned, single-most-recent-match "recovery risk"
// signal (see `predictionEngine/matchLoadRecovery.ts`) is a genuinely different, decorrelated
// fatigue proxy -- as opposed to the old 3/7/14-day match-COUNT windows in `fatigue.ts`, which
// Task #89 found were really measuring tournament-survivorship/winning-momentum in disguise
// (61.5% directional overlap with Recent Form; see `docs/audit-fatigue-window-logic-investigation.md`).
//
// This deliberately avoids re-running the full destructive `runWalkForwardEvaluation` pipeline
// (which wipes `evaluation_runs`/`evaluation_predictions` and refits+activates the live
// calibration model as a side effect -- unnecessary and unsafe for an investigation script).
// Instead it reads the full historical corpus directly, reconstructs each player's leak-proof
// prior match history the same way `historicalScoring.ts` does for a real backtest, and computes
// each candidate signal PLUS an independent, freshly-computed Recent Form value (not reused from
// any stored run) to check overlap -- all against real recorded match outcomes.
//
// Usage: pnpm --filter @workspace/api-server exec tsx src/scripts/analyzeFatigueRecoveryCandidates.ts
import { db, historicalMatchesTable, pool } from "@workspace/db";
import { asc } from "drizzle-orm";
import { buildMatchHistoryIndex, reconstructPlayerMatchHistory } from "../services/historicalData/matchRecordReconstruction";
import { computeRecentFormModule } from "../services/predictionEngine/recentForm";
import { realSetGameMargins } from "../services/shared/matchModels/setMargins";
import type { MatchRecord, Surface } from "../services/tennisData/types";

const MIN_SEGMENT_N = 200;
const HIGH_OVERLAP_THRESHOLD = 0.55; // ~55%+ directional agreement with Recent Form = rejected as redundant

interface CandidateDef {
  name: string;
  description: string;
  /** Higher score = hypothesized MORE likely to lose (higher fatigue/recovery risk). Returns null when this candidate has no opinion for this player (unknown data) -- caller drops ties/unknowns. */
  score: (matches: MatchRecord[], asOf: number) => number | null;
}

const SHORT_REST_DAYS_THRESHOLD = 3;

function restDaysOf(matches: MatchRecord[], asOf: number): number | null {
  if (matches.length === 0) return null;
  const days = Math.floor((asOf - new Date(matches[0].date).getTime()) / (24 * 60 * 60 * 1000));
  return days >= 0 ? days : null;
}

// `setGameMargins` is a fixed-length (5-slot) array padded with {0,0} trailing entries for
// unplayed sets -- `.length` alone is always 5 and cannot be used to count real sets played (see
// the same fix/comment in `matchLoadRecovery.ts`, found via this script's own debugging).
function realSetsPlayed(m: MatchRecord): number {
  return realSetGameMargins(m).length;
}

function wentDistance(matches: MatchRecord[]): boolean | null {
  if (matches.length === 0) return null;
  const m = matches[0];
  const sets = realSetsPlayed(m);
  if (sets === 0) return null;
  if (m.matchFormat === "BestOf5") return sets >= 4;
  return sets >= 3;
}

function restOnlyScore(restDays: number | null): number | null {
  if (restDays === null) return null;
  if (restDays >= SHORT_REST_DAYS_THRESHOLD) return 0;
  if (restDays >= 2) return 25;
  if (restDays >= 1) return 45;
  return 60;
}

const CANDIDATES: CandidateDef[] = [
  {
    name: "A: rest-days-only",
    description: "Score from days-since-last-match alone (short rest = higher risk), ignoring whether that match went the distance.",
    score: (matches, asOf) => restOnlyScore(restDaysOf(matches, asOf)),
  },
  {
    name: "B: went-distance-only",
    description: "Score is 20 if the player's most recent match went the distance (3+ sets BestOf3 / 4+ sets BestOf5), 0 otherwise -- ignores rest days entirely.",
    score: (matches) => {
      const distance = wentDistance(matches);
      if (distance === null) return null;
      return distance ? 20 : 0;
    },
  },
  {
    name: "C: combined recovery risk",
    description: "Rest-days penalty plus a +20 bonus when the most recent match also went the distance -- matchLoadRecovery.ts's actual computeMatchLoadRecoveryModule formula.",
    score: (matches, asOf) => {
      const restDays = restDaysOf(matches, asOf);
      const rest = restOnlyScore(restDays);
      if (rest === null) return null;
      const distance = wentDistance(matches);
      return Math.min(100, rest + (distance ? 20 : 0));
    },
  },
];

interface Row {
  candidateName: string;
  correctlyPredicted: boolean;
  gapBucket: string;
  surface: Surface;
  agreesWithRecentForm: boolean | null; // null when recent form had no opinion (tied at 50) or candidate had no gap
}

function gapBucket(gap: number): string {
  if (gap >= 40) return ">=40";
  if (gap >= 30) return ">=30";
  if (gap >= 20) return ">=20";
  if (gap >= 10) return ">=10";
  return ">0";
}

function reportSegment(label: string, rows: { correct: boolean }[]): void {
  const n = rows.length;
  const acc = n > 0 ? (rows.filter((r) => r.correct).length / n) * 100 : 0;
  const flag = n < MIN_SEGMENT_N ? "  [INCONCLUSIVE: n < 200]" : "";
  console.log(`    ${label}: n=${n}, accuracy=${acc.toFixed(2)}%${flag}`);
}

async function main(): Promise<void> {
  const rows = await db.select().from(historicalMatchesTable).orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));
  console.log(`Loaded ${rows.length} historical matches`);

  const index = buildMatchHistoryIndex(rows);

  const eligible = rows.filter((m) => !m.cancelled && m.winnerId !== null && !m.retired && !m.walkover && m.surface !== null);
  console.log(`Eligible (clean, determinate, surface-known) matches: ${eligible.length}\n`);

  const perCandidate = new Map<string, Row[]>();
  for (const c of CANDIDATES) perCandidate.set(c.name, []);

  let processed = 0;
  for (const m of eligible) {
    const asOf = m.cutoffAt.getTime();
    const player1Matches = reconstructPlayerMatchHistory(index, m.player1Id, m.cutoffAt);
    const player2Matches = reconstructPlayerMatchHistory(index, m.player2Id, m.cutoffAt);
    if (player1Matches.length === 0 || player2Matches.length === 0) continue;

    const surface = m.surface as Surface;
    const recentForm = computeRecentFormModule(player1Matches, player2Matches, surface);
    const formGap = recentForm.player1Form - recentForm.player2Form;
    const formFavorsP1 = formGap > 0 ? true : formGap < 0 ? false : null;

    for (const c of CANDIDATES) {
      const p1Score = c.score(player1Matches, asOf);
      const p2Score = c.score(player2Matches, asOf);
      if (p1Score === null || p2Score === null) continue;
      const gap = p1Score - p2Score;
      if (gap === 0) continue; // no directional opinion

      // Candidate predicts the LOWER-risk player wins.
      const predictedWinnerIsP1 = gap < 0;
      const actualWinnerIsP1 = m.winnerId === m.player1Id;
      const correctlyPredicted = predictedWinnerIsP1 === actualWinnerIsP1;

      // "More at-risk" player, for the Recent-Form-overlap check (mirrors Task #89's methodology exactly).
      const moreAtRiskIsP1 = gap > 0;
      const agreesWithRecentForm = formFavorsP1 === null ? null : moreAtRiskIsP1 === formFavorsP1;

      perCandidate.get(c.name)!.push({ candidateName: c.name, correctlyPredicted, gapBucket: gapBucket(Math.abs(gap)), surface, agreesWithRecentForm });
    }
    processed++;
    if (processed % 3000 === 0) console.log(`  ...processed ${processed}/${eligible.length}`);
  }

  for (const c of CANDIDATES) {
    const data = perCandidate.get(c.name)!;
    console.log(`\n=== Candidate ${c.name} ===`);
    console.log(`    ${c.description}`);
    reportSegment("Overall accuracy (predict lower-risk player wins)", data.map((r) => ({ correct: r.correctlyPredicted })));

    console.log("  By gap magnitude:");
    for (const bucket of [">0", ">=10", ">=20", ">=30", ">=40"]) {
      const seg = data.filter((r) => {
        const buckets = [">0", ">=10", ">=20", ">=30", ">=40"];
        const idx = buckets.indexOf(bucket);
        const rBucketIdx = buckets.indexOf(r.gapBucket);
        return rBucketIdx >= idx;
      });
      reportSegment(bucket, seg.map((r) => ({ correct: r.correctlyPredicted })));
    }

    console.log("  By surface:");
    for (const surface of ["Hard", "Clay", "Grass", "IndoorHard"] as Surface[]) {
      const seg = data.filter((r) => r.surface === surface);
      reportSegment(surface, seg.map((r) => ({ correct: r.correctlyPredicted })));
    }

    const withFormOpinion = data.filter((r) => r.agreesWithRecentForm !== null);
    const agreeCount = withFormOpinion.filter((r) => r.agreesWithRecentForm === true).length;
    const overlapPct = withFormOpinion.length > 0 ? (agreeCount / withFormOpinion.length) * 100 : 0;
    const overlapFlag = withFormOpinion.length < MIN_SEGMENT_N ? " [INCONCLUSIVE: n < 200]" : overlapPct / 100 >= HIGH_OVERLAP_THRESHOLD ? " [HIGH OVERLAP >= 55% -- redundant with Recent Form]" : " [not high overlap]";
    console.log(`  Directional agreement with (independently computed) Recent Form: n=${withFormOpinion.length}, agree=${overlapPct.toFixed(2)}%${overlapFlag}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
