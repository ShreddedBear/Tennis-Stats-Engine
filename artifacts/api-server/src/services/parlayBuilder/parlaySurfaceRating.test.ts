import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeParlaySurfaceRating } from "./parlaySurfaceRating.js";
import type { MatchRecord } from "../tennisData/types.js";

function baseMatch(id: string, i: number, surface: MatchRecord["surface"], result: "W" | "L"): MatchRecord {
  return {
    id,
    date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    tournamentName: null,
    tournamentLevel: null,
    round: null,
    matchFormat: null,
    surface,
    indoor: null,
    opponentId: `opp${i}`,
    opponentName: `Opponent ${i}`,
    opponentRank: null,
    result,
    score: null,
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: [],
  };
}

function wins(count: number, surface: MatchRecord["surface"] = "Hard"): MatchRecord[] {
  return Array.from({ length: count }, (_, i) => baseMatch(`w${i}`, i, surface, "W"));
}
function losses(count: number, surface: MatchRecord["surface"] = "Hard"): MatchRecord[] {
  return Array.from({ length: count }, (_, i) => baseMatch(`l${i}`, i, surface, "L"));
}

test("computeParlaySurfaceRating: has no import/require statement reaching into predictionEngine/ (doc comments explaining the independence are fine)", () => {
  const src = readFileSync(new URL("./parlaySurfaceRating.ts", import.meta.url), "utf8");
  assert.ok(!/from\s+['"].*predictionEngine/.test(src) && !/require\(['"].*predictionEngine['"]\)/.test(src));
});

test("computeParlaySurfaceRating: a player with only wins rates above a player with only losses on the same surface", () => {
  const result = computeParlaySurfaceRating(wins(10), losses(10), "Hard");
  assert.ok(result.winProbabilityPlayer1 > 55, `expected player1 favored, got ${result.winProbabilityPlayer1}`);
  assert.ok(result.player1Rating > result.player2Rating);
});

test("computeParlaySurfaceRating: identical histories land at exactly 50/50", () => {
  const matches = [...wins(5), ...losses(5)];
  const result = computeParlaySurfaceRating(matches, [...matches], "Hard");
  assert.equal(result.player1Rating, result.player2Rating);
  assert.equal(result.winProbabilityPlayer1, 50);
});

test("computeParlaySurfaceRating: off-surface matches are excluded entirely (strict surface filter)", () => {
  const onHard = wins(5, "Hard");
  const onClay = wins(5, "Clay"); // should not count toward a Hard-surface rating at all
  const result = computeParlaySurfaceRating(onHard, onClay, "Hard");
  assert.equal(result.sampleSizePlayer1, 5);
  assert.equal(result.sampleSizePlayer2, 0, "player2's clay-only history must not count toward a Hard rating");
  assert.equal(result.defaulted, true, "player2 has zero on-surface matches -- below MIN_SAMPLE");
});

test("computeParlaySurfaceRating: defaults (marks low-confidence) below the minimum sample threshold", () => {
  const result = computeParlaySurfaceRating(wins(2), losses(2), "Hard");
  assert.equal(result.defaulted, true);
});

test("computeParlaySurfaceRating: does not treat an unknown opponent as tour-average via any lookup table (no opponentElo parameter exists at all)", () => {
  // Structural assertion: the function signature itself has no opponent-strength-lookup
  // parameter, unlike Prediction Engine's computeSurfaceEloModule(p1, p2, surface, p1Elo?, p2Elo?).
  assert.equal(computeParlaySurfaceRating.length, 3);
});
