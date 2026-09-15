import test from "node:test";
import assert from "node:assert/strict";
import { filterMatchesBeforeCutoff } from "./predictionEngineBridge";
import type { MatchRecord } from "../tennisData/types";

function makeMatch(id: string, date: string): MatchRecord {
  return {
    id,
    date,
    tournamentName: null,
    tournamentLevel: null,
    round: null,
    matchFormat: null,
    surface: null,
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
    setGameMargins: [],
  };
}

test("leakage: matches strictly before asOfDate are kept", () => {
  const matches = [makeMatch("a", "2015-05-30"), makeMatch("b", "2015-05-31")];
  const filtered = filterMatchesBeforeCutoff(matches, "2015-06-01");
  assert.equal(filtered.length, 2);
});

test("leakage: a match ON the asOfDate is excluded (strict <, matches the historical_matches cutoff invariant)", () => {
  const matches = [makeMatch("a", "2015-06-01")];
  const filtered = filterMatchesBeforeCutoff(matches, "2015-06-01");
  assert.equal(filtered.length, 0);
});

test("leakage: a match AFTER asOfDate is excluded -- this is exactly what stops PBP from leaking future information into a pre-match prediction", () => {
  const matches = [makeMatch("future", "2015-06-05")];
  const filtered = filterMatchesBeforeCutoff(matches, "2015-06-01");
  assert.equal(filtered.length, 0);
});

test("leakage: mixed set keeps only the genuinely pre-cutoff matches", () => {
  const matches = [makeMatch("past", "2014-01-01"), makeMatch("cutoff-day", "2015-06-01"), makeMatch("future", "2015-06-02")];
  const filtered = filterMatchesBeforeCutoff(matches, "2015-06-01");
  assert.deepEqual(filtered.map((m) => m.id), ["past"]);
});
