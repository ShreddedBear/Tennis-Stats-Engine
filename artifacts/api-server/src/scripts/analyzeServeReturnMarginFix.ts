// One-off, non-destructive before/after comparison for Task #92: does fixing the padded-array
// bug in `serveReturn.ts`'s `ratingsFromMargins` (padded {0,0} trailing setGameMargins entries
// were counted into the weighted-margin denominator, diluting every match's real per-set margin)
// meaningfully change Serve & Return's measured predictive accuracy on matches that fall back to
// the margin proxy (i.e. matches without provider point-level stats)?
//
// Does NOT re-run the destructive `runWalkForwardEvaluation` pipeline. Reads the historical
// corpus directly and reconstructs each player's leak-proof prior history the same way
// `historicalScoring.ts` does, computing the OLD (buggy) and NEW (fixed) margin-proxy rating
// formulas side by side against real recorded outcomes -- restricted to matches where the module
// actually falls back to the proxy (no real point-level provider stats), since that's the only
// path this bug affects.
//
// Usage: pnpm --filter @workspace/api-server exec tsx src/scripts/analyzeServeReturnMarginFix.ts
import { db, historicalMatchesTable, pool } from "@workspace/db";
import { asc } from "drizzle-orm";
import { buildMatchHistoryIndex, reconstructPlayerMatchHistory } from "../services/historicalData/matchRecordReconstruction";
import { realSetGameMargins } from "../services/shared/matchModels/setMargins";
import type { MatchRecord } from "../services/tennisData/types";

const BASELINE_ELO = 1500;
const MIN_SEGMENT_N = 200;

/** OLD (buggy) behavior: counts every one of the fixed 5 `setGameMargins` slots, including padded {0,0} trailing entries. */
function oldRating(matches: MatchRecord[]): number | null {
  const withMargins = matches.filter((m) => m.setGameMargins.length > 0);
  if (withMargins.length === 0) return null;
  let sum = 0;
  let weight = 0;
  for (const m of withMargins) {
    for (const set of m.setGameMargins) {
      sum += set.playerGames - set.opponentGames;
      weight += 1;
    }
  }
  const avgMargin = weight > 0 ? sum / weight : 0;
  return Math.max(5, Math.min(95, 50 + avgMargin * 6));
}

/** NEW (fixed) behavior: filters padded {0,0} trailing entries out before counting/summing. */
function newRating(matches: MatchRecord[]): number | null {
  const withMargins = matches.map((m) => realSetGameMargins(m)).filter((real) => real.length > 0);
  if (withMargins.length === 0) return null;
  let sum = 0;
  let weight = 0;
  for (const real of withMargins) {
    for (const set of real) {
      sum += set.playerGames - set.opponentGames;
      weight += 1;
    }
  }
  const avgMargin = weight > 0 ? sum / weight : 0;
  return Math.max(5, Math.min(95, 50 + avgMargin * 6));
}

function hasRealPointLevelStats(matches: MatchRecord[]): boolean {
  return matches.filter((m) => m.stats?.servicePointsWonPct != null && m.stats?.returnPointsWon != null).length >= 3;
}

function reportAccuracy(label: string, rows: { correct: boolean }[]): void {
  const n = rows.length;
  const acc = n > 0 ? (rows.filter((r) => r.correct).length / n) * 100 : 0;
  const flag = n < MIN_SEGMENT_N ? "  [INCONCLUSIVE: n < 200]" : "";
  console.log(`  ${label}: n=${n}, accuracy=${acc.toFixed(2)}%${flag}`);
}

async function main(): Promise<void> {
  const rows = await db.select().from(historicalMatchesTable).orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));
  console.log(`Loaded ${rows.length} historical matches`);
  const index = buildMatchHistoryIndex(rows);
  const eligible = rows.filter((m) => !m.cancelled && m.winnerId !== null && !m.retired && !m.walkover);
  console.log(`Eligible (clean, determinate) matches: ${eligible.length}\n`);

  const oldRows: { correct: boolean }[] = [];
  const newRows: { correct: boolean }[] = [];
  let bothProxyPath = 0;
  let ratingsDiffered = 0;

  let processed = 0;
  for (const m of eligible) {
    const player1Matches = reconstructPlayerMatchHistory(index, m.player1Id, m.cutoffAt);
    const player2Matches = reconstructPlayerMatchHistory(index, m.player2Id, m.cutoffAt);
    if (player1Matches.length === 0 || player2Matches.length === 0) continue;

    // Only matches where BOTH players actually fall back to the margin proxy are affected by
    // this bug -- if either player has real point-level stats, `computeServeReturnModule` uses
    // `realRatingsFromStats` instead, which this bug never touched.
    if (hasRealPointLevelStats(player1Matches) && hasRealPointLevelStats(player2Matches)) continue;

    const p1Old = oldRating(player1Matches);
    const p2Old = oldRating(player2Matches);
    const p1New = newRating(player1Matches);
    const p2New = newRating(player2Matches);
    if (p1Old === null || p2Old === null || p1New === null || p2New === null) continue;

    bothProxyPath++;
    const actualWinnerIsP1 = m.winnerId === m.player1Id;

    const oldGap = p1Old - p2Old;
    if (oldGap !== 0) {
      oldRows.push({ correct: (oldGap > 0) === actualWinnerIsP1 });
    }
    const newGap = p1New - p2New;
    if (newGap !== 0) {
      newRows.push({ correct: (newGap > 0) === actualWinnerIsP1 });
    }
    if (Math.abs(oldGap - newGap) > 0.5) ratingsDiffered++;

    processed++;
    if (processed % 3000 === 0) console.log(`  ...processed ${processed}`);
  }

  console.log(`\nMatches where both players used the margin-proxy path: ${bothProxyPath}`);
  console.log(`Matches where the fix meaningfully changed the rating gap (>0.5pt): ${ratingsDiffered} (${((ratingsDiffered / bothProxyPath) * 100).toFixed(1)}%)\n`);
  console.log("=== OLD (buggy: padded zero-sets counted in the weighted-margin denominator) ===");
  reportAccuracy("Overall accuracy (predict higher-rated player wins)", oldRows);
  console.log("\n=== NEW (fixed: padded zero-sets excluded) ===");
  reportAccuracy("Overall accuracy (predict higher-rated player wins)", newRows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
