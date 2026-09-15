import test from "node:test";
import assert from "node:assert/strict";
import { parsePbpString, deriveStatsFromPbp } from "./derive";

test("parsePbpString: parses a real short game correctly", () => {
  // server1 wins 4 points straight (S,S,S,S) = one game, one set of one game.
  const parsed = parsePbpString("SSSS.");
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.pointsPlayed, 4);
  assert.equal(parsed.serverWonCount, 4);
  assert.equal(parsed.returnerWonCount, 0);
  assert.equal(parsed.games.length, 1);
});

test("parsePbpString: aces and double faults counted correctly, separate from S/R", () => {
  const parsed = parsePbpString("AASD;");
  assert.equal(parsed.aces, 2);
  assert.equal(parsed.doubleFaults, 1);
  // A counts as server-won, D counts as returner-won.
  assert.equal(parsed.serverWonCount, 3); // A,A,S
  assert.equal(parsed.returnerWonCount, 1); // D
});

test("parsePbpString: tiebreak '/' change-of-serve markers are stripped, not malformed", () => {
  const parsed = parsePbpString("SSRS/RSSR/S.");
  assert.equal(parsed.malformed, false);
  // "/" chars are stripped before counting -- 9 real point tokens remain: S,S,R,S,R,S,S,R,S.
  assert.equal(parsed.pointsPlayed, 9);
});

test("parsePbpString: malformed -- unrecognized token", () => {
  const parsed = parsePbpString("SSXR;");
  assert.equal(parsed.malformed, true);
  assert.match(parsed.malformedReason ?? "", /unrecognized_token/);
});

test("parsePbpString: malformed -- empty string", () => {
  const parsed = parsePbpString("");
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.malformedReason, "empty_pbp_string");
});

test("deriveStatsFromPbp: attributes serve alternation correctly (server1 serves game 0, server2 serves game 1)", () => {
  // Game 0 (server1 serves): SSSS (server1 wins all 4 on serve)
  // Game 1 (server2 serves): RRRR (server2 loses all 4 on serve, i.e. server1/returner wins)
  const derived = deriveStatsFromPbp({ raw: "SSSS;RRRR;", sourceRecordId: "test#1", server1IsPlayer1: true, adfFlag: 1 });
  assert.ok(derived);
  assert.equal(derived!.serverPointsPlayed.player1, 4); // player1 served game 0 only
  assert.equal(derived!.serverPointsWon.player1, 4);
  assert.equal(derived!.serverPointsPlayed.player2, 4); // player2 served game 1
  assert.equal(derived!.serverPointsWon.player2, 0); // player2 lost every point on serve (all R)
  // player1's return points won = player2's serve points lost = 4
  assert.equal(derived!.returnPointsWonPct.player1, 100);
  assert.equal(derived!.gamesPlayed, 2);
});

test("deriveStatsFromPbp: server1IsPlayer1=false flips attribution", () => {
  const derived = deriveStatsFromPbp({ raw: "SSSS;", sourceRecordId: "test#2", server1IsPlayer1: false, adfFlag: 1 });
  assert.ok(derived);
  assert.equal(derived!.serverPointsPlayed.player2, 4); // server1 (game 0) is actually player2 here
  assert.equal(derived!.serverPointsPlayed.player1, 0);
});

test("deriveStatsFromPbp: returns null (never fabricates) for malformed input", () => {
  const derived = deriveStatsFromPbp({ raw: "garbage!!", sourceRecordId: "test#3", server1IsPlayer1: true, adfFlag: 0 });
  assert.equal(derived, null);
});

test("deriveStatsFromPbp: adfDataComplete reflects the source's own adf_flag, aces/DFs still real counts either way", () => {
  const withFlag = deriveStatsFromPbp({ raw: "AASS;", sourceRecordId: "t4", server1IsPlayer1: true, adfFlag: 1 });
  const withoutFlag = deriveStatsFromPbp({ raw: "AASS;", sourceRecordId: "t5", server1IsPlayer1: true, adfFlag: 0 });
  assert.equal(withFlag!.adfDataComplete, true);
  assert.equal(withoutFlag!.adfDataComplete, false);
  // Same parsed aces count in both cases -- adf_flag=0 does not null out real parsed data.
  assert.equal(withFlag!.aces.player1, withoutFlag!.aces.player1);
});

test("deriveStatsFromPbp: never fabricates serve speed / rally length / first-serve% -- not present on the type at all", () => {
  const derived = deriveStatsFromPbp({ raw: "SSSS;", sourceRecordId: "t6", server1IsPlayer1: true, adfFlag: 1 });
  assert.ok(derived);
  assert.equal("serveSpeed" in derived!, false);
  assert.equal("rallyLength" in derived!, false);
  assert.equal("firstServePct" in derived!, false);
});
