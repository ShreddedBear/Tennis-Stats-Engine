// Unit tests for the serve/return module's real-stats vs. margin-proxy fallback behavior.
// Run with: tsx --test src/services/shared/matchModels/serveReturn.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { computeServeReturnModule } from "./serveReturn";
import type { MatchRecord, MatchStatLine } from "../../tennisData/types";

function statLine(overrides: Partial<MatchStatLine>): MatchStatLine {
  return {
    firstServePct: null,
    firstServeWon: null,
    secondServeWon: null,
    aces: null,
    doubleFaults: null,
    breakPointsSaved: null,
    breakPointsFaced: null,
    returnPointsWon: null,
    servicePointsWonPct: null,
    ...overrides,
  };
}

function baseMatch(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: "m1",
    date: "2026-01-01",
    tournamentName: "Test Open",
    tournamentLevel: "ATP250",
    round: "R32",
    matchFormat: "BestOf3",
    surface: "Hard",
    indoor: null,
    opponentId: "opp",
    opponentName: "Opponent",
    opponentRank: null,
    result: "W",
    score: "6-4 6-4",
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: [
      { playerGames: 6, opponentGames: 4 },
      { playerGames: 6, opponentGames: 4 },
    ],
    ...overrides,
  };
}

test("falls back to the margin proxy (capped at 60) when no match has real stats", () => {
  const matches: MatchRecord[] = Array.from({ length: 6 }, (_, i) => baseMatch({ id: `m${i}` }));
  const result = computeServeReturnModule(matches, matches, "Hard");
  assert.ok(result.reliability <= 60, `expected proxy cap <= 60, got ${result.reliability}`);
  assert.match(result.note ?? "", /does not expose point-level/);
});

test("uses real point-level stats and allows reliability above the proxy's 60 cap when both players have enough", () => {
  const withRealStats: MatchRecord[] = Array.from({ length: 6 }, (_, i) =>
    baseMatch({
      id: `real${i}`,
      stats: statLine({ servicePointsWonPct: 68, returnPointsWon: 42 }),
    }),
  );
  const result = computeServeReturnModule(withRealStats, withRealStats, "Hard");
  assert.ok(result.reliability > 60, `expected reliability > 60 with real stats, got ${result.reliability}`);
  assert.match(result.note ?? "", /real match-level point statistics/);
  // Both players have identical stats, so ratings should be roughly symmetric around 50.
  assert.ok(result.player1ServeRating > 50, "a service-points-won% above tour average should rate above 50");
  assert.ok(result.player1ReturnRating > 50, "a return-points-won% above tour average should rate above 50");
});

test("falls back to the proxy when only one player has enough matches with real stats", () => {
  const withRealStats: MatchRecord[] = Array.from({ length: 6 }, (_, i) =>
    baseMatch({ id: `real${i}`, stats: statLine({ servicePointsWonPct: 68, returnPointsWon: 42 }) }),
  );
  const proxyOnly: MatchRecord[] = Array.from({ length: 6 }, (_, i) => baseMatch({ id: `proxy${i}` }));
  const result = computeServeReturnModule(withRealStats, proxyOnly, "Hard");
  assert.match(result.note ?? "", /does not expose point-level/);
  assert.ok(result.reliability <= 60);
});

test("exposes point-level breakdown (first-serve win %, BP saved/converted, games held estimate) from real stats", () => {
  const matches: MatchRecord[] = Array.from({ length: 5 }, (_, i) =>
    baseMatch({
      id: `pl${i}`,
      stats: statLine({ servicePointsWonPct: 65, returnPointsWon: 40, firstServeWon: 75, breakPointsSaved: 3, breakPointsFaced: 4 }),
      opponentStats: statLine({ breakPointsSaved: 1, breakPointsFaced: 3 }),
    }),
  );
  const result = computeServeReturnModule(matches, matches, "Hard");

  assert.equal(result.player1PointLevel.firstServeWinPct, 75);
  assert.equal(result.player1PointLevel.breakPointsSavedPct, 75); // 3/4
  assert.equal(result.player1PointLevel.breakPointsConvertedPct, Math.round(((2 / 3) * 1000)) / 10); // (3-1)/3
  assert.ok(result.player1PointLevel.serviceGamesHeldPct !== null && result.player1PointLevel.serviceGamesHeldPct > 0);
  assert.equal(result.player1PointLevel.sampleSize, 5);
  assert.match(result.note ?? "", /Deepened with point-level inputs/);
});

test("point-level fields resolve independently and stay null when their source stat is missing", () => {
  const matches: MatchRecord[] = Array.from({ length: 5 }, (_, i) =>
    baseMatch({ id: `bp${i}`, stats: statLine({ servicePointsWonPct: 65, returnPointsWon: 40 }) }),
  );
  const result = computeServeReturnModule(matches, matches, "Hard");
  assert.equal(result.player1PointLevel.firstServeWinPct, null);
  assert.equal(result.player1PointLevel.breakPointsSavedPct, null);
  assert.equal(result.player1PointLevel.breakPointsConvertedPct, null);
  assert.ok(result.player1PointLevel.serviceGamesHeldPct !== null);
});

test("point-level breakdown is still computed (all null) on the margin-proxy fallback path, never crashing", () => {
  const matches: MatchRecord[] = Array.from({ length: 3 }, (_, i) => baseMatch({ id: `m${i}` }));
  const result = computeServeReturnModule(matches, matches, "Hard");
  assert.equal(result.player1PointLevel.firstServeWinPct, null);
  assert.equal(result.player1PointLevel.sampleSize, 0);
});

test("real data quirk: padded {0,0} trailing setGameMargins entries must not dilute the weighted margin sum or inflate coverage/sample counts", () => {
  // `historical_matches.game_margins_player1` is a fixed-length 5-slot array; unplayed trailing
  // sets are padded with {playerGames:0, opponentGames:0} rather than trimmed. A real straight-
  // sets (2-set) win stored this way must be scored identically to the same match with the
  // padding stripped -- the padded zero slots must not count toward the weighted-margin
  // denominator (which would silently shrink the real per-set margin toward 0).
  const paddedMatch = baseMatch({
    id: "padded1",
    setGameMargins: [
      { playerGames: 6, opponentGames: 4 },
      { playerGames: 6, opponentGames: 4 },
      { playerGames: 0, opponentGames: 0 },
      { playerGames: 0, opponentGames: 0 },
      { playerGames: 0, opponentGames: 0 },
    ],
  });
  const trimmedMatch = baseMatch({
    id: "trimmed1",
    setGameMargins: [
      { playerGames: 6, opponentGames: 4 },
      { playerGames: 6, opponentGames: 4 },
    ],
  });
  const matches3 = Array.from({ length: 3 }, (_, i) => baseMatch({ id: `filler${i}` }));
  const paddedResult = computeServeReturnModule([paddedMatch, ...matches3], [paddedMatch, ...matches3], "Hard");
  const trimmedResult = computeServeReturnModule([trimmedMatch, ...matches3], [trimmedMatch, ...matches3], "Hard");
  assert.equal(paddedResult.player1ServeRating, trimmedResult.player1ServeRating);
  assert.equal(paddedResult.player1ReturnRating, trimmedResult.player1ReturnRating);
});

test("a match with only padded {0,0} entries (no real set data at all) is excluded from sample/coverage, not counted as a zero-margin match", () => {
  const noRealDataMatch = baseMatch({
    id: "nodata1",
    setGameMargins: [
      { playerGames: 0, opponentGames: 0 },
      { playerGames: 0, opponentGames: 0 },
      { playerGames: 0, opponentGames: 0 },
      { playerGames: 0, opponentGames: 0 },
      { playerGames: 0, opponentGames: 0 },
    ],
  });
  const realMatches = Array.from({ length: 3 }, (_, i) => baseMatch({ id: `real${i}` }));
  const withNoDataMatch = computeServeReturnModule([noRealDataMatch, ...realMatches], [noRealDataMatch, ...realMatches], "Hard");
  const withoutNoDataMatch = computeServeReturnModule(realMatches, realMatches, "Hard");
  // The no-real-data match must be excluded entirely, so ratings match the 3-real-match-only run.
  assert.equal(withNoDataMatch.player1ServeRating, withoutNoDataMatch.player1ServeRating);
  assert.equal(withNoDataMatch.player1ReturnRating, withoutNoDataMatch.player1ReturnRating);
});

test("Task #123: a match on a different surface than the one being predicted is de-weighted, not excluded or full-weighted", () => {
  // One real-stats match on the predicted surface (Clay) plus enough off-surface (Hard) matches
  // to clear MIN_REAL_SAMPLE -- if surface weighting is applied, the off-surface matches should
  // count for less than they would if predicting on Hard instead.
  const onSurface: MatchRecord[] = Array.from({ length: 2 }, (_, i) =>
    baseMatch({ id: `clay${i}`, surface: "Clay", stats: statLine({ servicePointsWonPct: 70, returnPointsWon: 45 }) }),
  );
  const offSurface: MatchRecord[] = Array.from({ length: 4 }, (_, i) =>
    baseMatch({ id: `hard${i}`, surface: "Hard", stats: statLine({ servicePointsWonPct: 50, returnPointsWon: 30 }) }),
  );
  const mixed = [...onSurface, ...offSurface];

  const onClay = computeServeReturnModule(mixed, mixed, "Clay");
  const onHard = computeServeReturnModule(mixed, mixed, "Hard");
  // Predicting on Clay should weight the (higher-rated) Clay matches more heavily than predicting
  // on Hard does, where the (lower-rated) Hard matches are the full-weight majority instead.
  assert.ok(onClay.player1ServeRating > onHard.player1ServeRating, `expected Clay-weighted rating (${onClay.player1ServeRating}) > Hard-weighted rating (${onHard.player1ServeRating})`);
});

test("does not regress a proxy-only prediction: identical inputs and outputs to the pre-existing margin logic", () => {
  const matches: MatchRecord[] = Array.from({ length: 3 }, (_, i) => baseMatch({ id: `m${i}` }));
  const result = computeServeReturnModule(matches, matches, "Hard", new Map(), new Map());
  // 3 matches * 6 = 18 reliability. Both players have identical 6-4 6-4 wins (avg margin +2/set),
  // so ratings should be identical and symmetric, per the pre-existing margin-proxy formula
  // (50 + avgMargin * 6 = 50 + 2*6 = 62).
  assert.equal(result.reliability, 18);
  assert.equal(result.player1ServeRating, 62);
  assert.equal(result.player1ReturnRating, 62);
  assert.equal(result.player1ServeRating, result.player2ServeRating);
  assert.ok(result.warnings.some((w) => /Only 3 match\(es\) with recorded set scores/.test(w)));
  assert.ok(result.warnings.some((w) => /Opponent-strength weighting is only partially available/.test(w)));
});
