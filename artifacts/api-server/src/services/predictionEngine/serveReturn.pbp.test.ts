import test from "node:test";
import assert from "node:assert/strict";
import { computeServeReturnModule, type MatchPbpStatsLookup } from "./serveReturn";
import type { MatchRecord } from "../tennisData/types";
import type { PbpDerivedStats } from "../pbp/types";

function makeMatch(id: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id,
    date: "2014-01-01",
    tournamentName: "Test Open",
    tournamentLevel: "Challenger",
    round: "R32",
    matchFormat: "BestOf3",
    surface: "Hard",
    indoor: false,
    opponentId: "opp",
    opponentName: "Opponent",
    opponentRank: 100,
    result: "W",
    score: "6-4 6-4",
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: [{ playerGames: 6, opponentGames: 4 }, { playerGames: 6, opponentGames: 4 }],
    ...overrides,
  };
}

function pbpStats(servicePct: number, returnPct: number): PbpDerivedStats {
  return {
    pointsPlayed: 80,
    serverPointsWon: { player1: 40, player2: 30 },
    serverPointsPlayed: { player1: 45, player2: 35 },
    servicePointsWonPct: { player1: servicePct, player2: null },
    returnPointsWonPct: { player1: returnPct, player2: null },
    aces: { player1: 3, player2: null },
    doubleFaults: { player1: 1, player2: null },
    adfDataComplete: true,
    gamesPlayed: 12,
    setsPlayed: 2,
    sourceRecordId: "x",
  };
}

test("serveReturn: PBP tier is used (primarySource=POINT_PBP) when enough real PBP resolves for both players", () => {
  const p1Matches = [makeMatch("m1"), makeMatch("m2"), makeMatch("m3")];
  const p2Matches = [makeMatch("n1"), makeMatch("n2"), makeMatch("n3")];
  const p1Pbp: MatchPbpStatsLookup = new Map([
    ["m1", pbpStats(70, 30)],
    ["m2", pbpStats(72, 28)],
    ["m3", pbpStats(68, 32)],
  ]);
  const p2Pbp: MatchPbpStatsLookup = new Map([
    ["n1", pbpStats(60, 40)],
    ["n2", pbpStats(58, 42)],
    ["n3", pbpStats(62, 38)],
  ]);

  const result = computeServeReturnModule(p1Matches, p2Matches, "Hard", new Map(), new Map(), p1Pbp, p2Pbp);
  assert.equal(result.primarySource, "POINT_PBP");
  assert.equal(result.pbpSampleSize, 3);
  assert.equal(result.defaulted, false);
  // Player 1's real service% (70) is meaningfully above player 2's (60) -- rating should reflect it.
  assert.ok(result.player1ServeRating > result.player2ServeRating);
});

test("serveReturn: falls back to existing MATCH_STATS/GAME_MARGIN_PROXY tiers unchanged when PBP maps are empty (backward compatible)", () => {
  const p1Matches = [makeMatch("m1")];
  const p2Matches = [makeMatch("n1")];
  // No 5th/6th args passed at all -- must behave exactly as before this change.
  const result = computeServeReturnModule(p1Matches, p2Matches, "Hard", new Map(), new Map());
  assert.equal(result.primarySource, "GAME_MARGIN_PROXY");
  assert.equal(result.pbpSampleSize, 0);
});

test("serveReturn: insufficient PBP sample on one side falls through to the next tier, not a partial PBP result", () => {
  const p1Matches = [makeMatch("m1"), makeMatch("m2"), makeMatch("m3")];
  const p2Matches = [makeMatch("n1")]; // only 1 match with PBP -- below MIN_PBP_SAMPLE
  const p1Pbp: MatchPbpStatsLookup = new Map([
    ["m1", pbpStats(70, 30)],
    ["m2", pbpStats(72, 28)],
    ["m3", pbpStats(68, 32)],
  ]);
  const p2Pbp: MatchPbpStatsLookup = new Map([["n1", pbpStats(60, 40)]]);

  const result = computeServeReturnModule(p1Matches, p2Matches, "Hard", new Map(), new Map(), p1Pbp, p2Pbp);
  assert.notEqual(result.primarySource, "POINT_PBP");
});

test("serveReturn: PBP tier reliability floors higher than the margin proxy, never masquerades as less certain than it is", () => {
  const p1Matches = [makeMatch("m1"), makeMatch("m2"), makeMatch("m3")];
  const p2Matches = [makeMatch("n1"), makeMatch("n2"), makeMatch("n3")];
  const pbpMap: MatchPbpStatsLookup = new Map([
    ["m1", pbpStats(65, 35)], ["m2", pbpStats(65, 35)], ["m3", pbpStats(65, 35)],
    ["n1", pbpStats(65, 35)], ["n2", pbpStats(65, 35)], ["n3", pbpStats(65, 35)],
  ]);
  const p1Only: MatchPbpStatsLookup = new Map([["m1", pbpStats(65, 35)], ["m2", pbpStats(65, 35)], ["m3", pbpStats(65, 35)]]);
  const p2Only: MatchPbpStatsLookup = new Map([["n1", pbpStats(65, 35)], ["n2", pbpStats(65, 35)], ["n3", pbpStats(65, 35)]]);
  const pbpResult = computeServeReturnModule(p1Matches, p2Matches, "Hard", new Map(), new Map(), p1Only, p2Only);
  const proxyResult = computeServeReturnModule(p1Matches, p2Matches, "Hard");
  assert.ok(pbpResult.reliability > proxyResult.reliability);
  assert.ok(pbpResult.reliability >= 75);
  void pbpMap;
});
