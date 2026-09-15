import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeParlayServeReturnRating, computeParlayServeReturnPair } from "./parlayServeReturnRating.js";
import type { MatchRecord } from "../tennisData/types.js";

function matchWithMargins(id: string, surface: MatchRecord["surface"], margins: Array<{ playerGames: number; opponentGames: number }>): MatchRecord {
  return {
    id,
    date: "2025-06-01",
    tournamentName: null,
    tournamentLevel: null,
    round: null,
    matchFormat: null,
    surface,
    indoor: null,
    opponentId: "opp",
    opponentName: "Opponent",
    opponentRank: null,
    result: "W",
    score: null,
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: margins,
  };
}

test("computeParlayServeReturnRating / computeParlayServeReturnPair: has no import/require statement reaching into predictionEngine/ (doc comments explaining the independence are fine)", () => {
  const src = readFileSync(new URL("./parlayServeReturnRating.ts", import.meta.url), "utf8");
  assert.ok(!/from\s+['"].*predictionEngine/.test(src) && !/require\(['"].*predictionEngine['"]\)/.test(src));
});

test("computeParlayServeReturnRating: dominant set margins produce a rating above neutral", () => {
  const matches = [
    matchWithMargins("m1", "Hard", [{ playerGames: 6, opponentGames: 2 }, { playerGames: 6, opponentGames: 3 }]),
    matchWithMargins("m2", "Hard", [{ playerGames: 6, opponentGames: 1 }]),
    matchWithMargins("m3", "Hard", [{ playerGames: 6, opponentGames: 4 }]),
  ];
  const result = computeParlayServeReturnRating(matches, "Hard");
  assert.ok(result.serveRating > 50, `expected above-neutral rating, got ${result.serveRating}`);
  assert.equal(result.serveRating, result.returnRating, "set-margin data alone cannot separate serve from return dominance -- both must be the same honestly-labeled figure");
});

test("computeParlayServeReturnRating: no real set data -> neutral 50, defaulted", () => {
  const matches = [matchWithMargins("m1", "Hard", [{ playerGames: 0, opponentGames: 0 }])]; // padded/unplayed
  const result = computeParlayServeReturnRating(matches, "Hard");
  assert.equal(result.serveRating, 50);
  assert.equal(result.sampleSize, 0);
  assert.equal(result.defaulted, true);
});

test("computeParlayServeReturnRating: rating is bounded within [5, 95] even for an extreme margin", () => {
  const matches = [matchWithMargins("m1", "Hard", [{ playerGames: 6, opponentGames: 0 }])];
  const result = computeParlayServeReturnRating(matches, "Hard");
  assert.ok(result.serveRating >= 5 && result.serveRating <= 95);
});

test("computeParlayServeReturnPair: pairs two independently-computed single-player ratings", () => {
  const strong = [matchWithMargins("m1", "Hard", [{ playerGames: 6, opponentGames: 1 }]), matchWithMargins("m2", "Hard", [{ playerGames: 6, opponentGames: 2 }]), matchWithMargins("m3", "Hard", [{ playerGames: 6, opponentGames: 1 }])];
  const weak = [matchWithMargins("m4", "Hard", [{ playerGames: 1, opponentGames: 6 }]), matchWithMargins("m5", "Hard", [{ playerGames: 2, opponentGames: 6 }]), matchWithMargins("m6", "Hard", [{ playerGames: 1, opponentGames: 6 }])];
  const pair = computeParlayServeReturnPair(strong, weak, "Hard");
  assert.ok(pair.player1ServeRating > pair.player2ServeRating);
  assert.equal(pair.defaulted, false);
});
