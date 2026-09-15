import test from "node:test";
import assert from "node:assert/strict";
import { resolvePbpMatchIdentity, type CandidateHistoricalMatch } from "./identity";

function candidate(overrides: Partial<CandidateHistoricalMatch>): CandidateHistoricalMatch {
  return {
    id: 1,
    player1Name: "Novak Djokovic",
    player2Name: "Rafael Nadal",
    tournamentName: "Roland Garros",
    scheduledStartAt: "2015-06-01T12:00:00Z",
    surface: "Clay",
    round: "F",
    ...overrides,
  };
}

test("identity: unique player-pair + date match -> MATCHED", () => {
  const result = resolvePbpMatchIdentity(
    { player1Name: "Novak Djokovic", player2Name: "Rafael Nadal", date: "2015-06-01" },
    [candidate({})],
  );
  assert.equal(result.status, "MATCHED");
  assert.equal(result.canonicalMatchId, 1);
});

test("identity: flipped player order still resolves (orientation flagged correctly)", () => {
  const result = resolvePbpMatchIdentity(
    { player1Name: "Rafael Nadal", player2Name: "Novak Djokovic", date: "2015-06-01" },
    [candidate({})],
  );
  assert.equal(result.status, "MATCHED");
  assert.equal(result.orientationMatchesLookup, false); // candidate.player1 is Djokovic, lookup.player1 is Nadal
});

test("identity: player alias / accent normalization resolves via normalizePlayerName", () => {
  // "é"/"í" are real NFD-decomposable diacritics normalizePlayerName strips -- a genuine
  // covered case, unlike a transliterated letter like "Đ" (handled, but maps to a different
  // literal spelling than the accented form, so isn't a same-name diacritic variant).
  const result = resolvePbpMatchIdentity(
    { player1Name: "Felix Auger-Aliassime", player2Name: "Rafael Nadal", date: "2015-06-01" },
    [candidate({ player1Name: "Félix Auger-Aliassimé" })],
  );
  assert.equal(result.status, "MATCHED");
});

test("identity: no candidates -> NO_MATCH, never a guess", () => {
  const result = resolvePbpMatchIdentity({ player1Name: "Novak Djokovic", player2Name: "Rafael Nadal", date: "2015-06-01" }, []);
  assert.equal(result.status, "NO_MATCH");
  assert.equal(result.canonicalMatchId, null);
});

test("identity: wrong player pair on the same date -> NO_MATCH, not a false positive", () => {
  const result = resolvePbpMatchIdentity(
    { player1Name: "Roger Federer", player2Name: "Andy Murray", date: "2015-06-01" },
    [candidate({})],
  );
  assert.equal(result.status, "NO_MATCH");
});

test("identity: date outside tolerance window -> NO_MATCH even with matching players", () => {
  const result = resolvePbpMatchIdentity(
    { player1Name: "Novak Djokovic", player2Name: "Rafael Nadal", date: "2015-06-10" },
    [candidate({})], // candidate is 2015-06-01, 9 days apart
  );
  assert.equal(result.status, "NO_MATCH");
});

test("identity: two candidates, same pair, same date window, no tournament given -> AMBIGUOUS, never a guess", () => {
  const result = resolvePbpMatchIdentity(
    { player1Name: "Novak Djokovic", player2Name: "Rafael Nadal", date: "2015-06-01" },
    [candidate({ id: 1, tournamentName: "Rome Masters" }), candidate({ id: 2, tournamentName: "Roland Garros" })],
  );
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.canonicalMatchId, null);
  assert.deepEqual(result.candidateIds.sort(), [1, 2]);
});

test("identity: ambiguous pair resolved uniquely by tournament tie-break", () => {
  const result = resolvePbpMatchIdentity(
    { player1Name: "Novak Djokovic", player2Name: "Rafael Nadal", date: "2015-06-01", tournamentName: "Roland Garros" },
    [candidate({ id: 1, tournamentName: "Rome Masters" }), candidate({ id: 2, tournamentName: "Roland Garros" })],
  );
  assert.equal(result.status, "MATCHED");
  assert.equal(result.canonicalMatchId, 2);
});

test("identity: missing player name -> REVIEW_REQUIRED, not a crash", () => {
  const result = resolvePbpMatchIdentity({ player1Name: "", player2Name: "Rafael Nadal", date: "2015-06-01" }, [candidate({})]);
  assert.equal(result.status, "REVIEW_REQUIRED");
});
