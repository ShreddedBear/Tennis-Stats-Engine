/**
 * Winner-first slot ordering fix (2026-09-17).
 *
 * Sackmann's ingestion (`sackmannBackfill.ts`'s `rowToFixture`) maps winner_id -> player1_id and
 * loser_id -> player2_id at ingestion time, AFTER the match outcome is known. 179,986+
 * historical_test rows carry that outcome-oriented slot. `historicalScoring.ts`'s
 * `scoreHistoricalMatch` now derives the engine's own player1/player2 from
 * `determineNeutralSlotOrder` -- a deterministic ordering of the two player ids that never reads
 * `match.winnerId` -- instead of the stored (possibly winner-first) slot columns directly.
 *
 * These tests run against the REAL `historicalScoring.ts`/`matchRecordReconstruction.ts`/
 * `opponentStrength.ts`/`specialistWeights.ts` modules, with `@workspace/db` module-mocked
 * (Node's `--experimental-test-module-mocks`) so no live database is needed: every function this
 * test exercises operates on in-memory data structures the caller builds and passes in
 * (`MatchHistoryIndex`, `EloHistoryIndex`, `specialistRowsBySegmentKey`) -- `db` itself is never
 * actually called by any code path these tests reach, only imported at module scope by two of
 * `historicalScoring.ts`'s transitive dependencies.
 *
 * Run directly with:
 *   npx tsx --experimental-test-module-mocks --test \
 *     src/services/evaluation/historicalScoring.winnerFirstOrdering.test.ts
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

await mock.module("@workspace/db", {
  namedExports: {
    db: {},
    historicalMatchesTable: {},
    matchFeatureSnapshotsTable: {},
    evaluationPredictionsTable: {},
    specialistModelsTable: {},
  },
});

const { determineNeutralSlotOrder, scoreHistoricalMatch } = await import("./historicalScoring.js");
const { buildMatchHistoryIndex } = await import("../historicalData/matchRecordReconstruction.js");

type AnyRow = Record<string, unknown>;

// ── Part 1: determineNeutralSlotOrder — pure ordering-rule tests ───────────────────────────────

test("determineNeutralSlotOrder: same two players always land in the same slots regardless of argument order", () => {
  const a = "sackmann-100201";
  const b = "sackmann-200817";

  const forward = determineNeutralSlotOrder(a, b);
  const reversed = determineNeutralSlotOrder(b, a);

  // Whichever id is passed first ("stored player1", i.e. whichever the ingestion recorded as the
  // winner), the SAME physical player ends up as firstId both times.
  assert.equal(forward.firstId, reversed.firstId, "the same player must always occupy the neutral first slot regardless of which one was recorded as the winner");
  assert.equal(forward.secondId, reversed.secondId);
  // Exactly one of the two calls should report swapped=true (whichever call's "stored player1"
  // argument was NOT the neutral firstId).
  assert.notEqual(forward.swapped, reversed.swapped, "exactly one direction must report a swap");
});

test("determineNeutralSlotOrder: ordering is a pure function of the two ids, never depends on which one 'won'", () => {
  // Requirement 9's literal statement: swap the recorded winner/loser (i.e. swap which id is
  // passed as "stored player1") and confirm the competitor receiving the neutral "player1" slot
  // changes ONLY according to the deterministic id-ordering rule, never according to the swap
  // itself carrying any outcome information (the function signature doesn't even accept a winner).
  const pairs: Array<[string, string]> = [
    ["p-alpha", "p-beta"],
    ["sackmann-104925", "sackmann-104745"],
    ["z-last", "a-first"],
    ["same-prefix-1", "same-prefix-2"],
  ];
  for (const [x, y] of pairs) {
    const winnerFirst = determineNeutralSlotOrder(x, y); // "x recorded as winner"
    const loserFirst = determineNeutralSlotOrder(y, x); // "y recorded as winner" (same real match)
    const expectedFirst = x < y ? x : y;
    assert.equal(winnerFirst.firstId, expectedFirst, `expected lexicographically-smaller id to win the neutral slot for pair (${x}, ${y})`);
    assert.equal(loserFirst.firstId, expectedFirst, `neutral slot must be identical whichever id was recorded as the winner, for pair (${x}, ${y})`);
  }
});

test("determineNeutralSlotOrder: identities are preserved exactly -- only the slot label changes, never the id/name values", () => {
  const result = determineNeutralSlotOrder("sackmann-999", "sackmann-111");
  assert.equal(result.swapped, true);
  // Both original ids must still be present, verbatim, just relabeled.
  assert.equal(result.firstId, "sackmann-111");
  assert.equal(result.secondId, "sackmann-999");
});

// ── Part 2: scoreHistoricalMatch — full-pipeline winner-independence proof ─────────────────────

const EMPTY_IDENTITY_INDEX = {
  canonicalIdByName: new Map(),
  canonicalIdById: new Map(),
  aliasIdsByCanonicalId: new Map(),
} as any;

function buildContext(rows: AnyRow[]) {
  return {
    matchHistory: buildMatchHistoryIndex(rows as any),
    eloHistory: new Map(),
    identityIndex: EMPTY_IDENTITY_INDEX,
    specialistRowsBySegmentKey: new Map(),
  } as any;
}

const RUN = Date.now();
const PLAYER_ALPHA = `wfso-alpha-${RUN}`; // stronger record
const PLAYER_ZETA = `wfso-zeta-${RUN}`; // weaker record -- name chosen so "alpha" < "zeta" lexicographically

function priorMatch(id: number, externalId: string, player1Id: string, player2Id: string, winnerId: string, date: string): AnyRow {
  const start = new Date(`${date}T12:00:00Z`);
  const cutoff = new Date(`${date}T11:30:00Z`);
  return {
    id, externalId, provider: "wfso-test",
    tour: "ATP", tournamentName: "Synth Prior", tournamentLevel: null, surface: "Hard", round: null, matchFormat: "BestOf3",
    player1Id, player1Name: player1Id, player2Id, player2Name: player2Id,
    winnerId, score: "6-3 6-3", retired: false, walkover: false, cancelled: false,
    scheduledStartAt: start, cutoffMinutes: 30, cutoffAt: cutoff,
    gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }], indoor: null, player1Rank: null, player2Rank: null,
    rawSource: {},
  };
}

// Alpha: 3 wins vs a common opponent pool. Zeta: 3 losses vs the same pool -- a clearly
// asymmetric record so the two scoring calls below produce a non-trivial (not exactly 50/50)
// probability, making the complementarity assertion a meaningful check rather than a no-op.
const priorRows: AnyRow[] = [
  priorMatch(1, "wfso-p1", PLAYER_ALPHA, "opp-1", PLAYER_ALPHA, "2023-01-01"),
  priorMatch(2, "wfso-p2", PLAYER_ALPHA, "opp-2", PLAYER_ALPHA, "2023-01-02"),
  priorMatch(3, "wfso-p3", PLAYER_ALPHA, "opp-3", PLAYER_ALPHA, "2023-01-03"),
  priorMatch(4, "wfso-p4", "opp-1", PLAYER_ZETA, "opp-1", "2023-01-01"),
  priorMatch(5, "wfso-p5", "opp-2", PLAYER_ZETA, "opp-2", "2023-01-02"),
  priorMatch(6, "wfso-p6", "opp-3", PLAYER_ZETA, "opp-3", "2023-01-03"),
];

const targetStart = new Date("2023-02-01T12:00:00Z");
const targetCutoff = new Date("2023-02-01T11:30:00Z");

function targetMatch(id: number, externalId: string, player1Id: string, player2Id: string, winnerId: string): AnyRow {
  return {
    id, externalId, provider: "wfso-test",
    tour: "ATP", tournamentName: "Synth Target", tournamentLevel: null, surface: "Hard", round: null, matchFormat: "BestOf3",
    player1Id, player1Name: player1Id, player2Id, player2Name: player2Id,
    winnerId, score: "6-3 6-3", retired: false, walkover: false, cancelled: false,
    scheduledStartAt: targetStart, cutoffMinutes: 30, cutoffAt: targetCutoff,
    gameMarginsPlayer1: [{ player1Games: 6, player2Games: 3 }], indoor: null, player1Rank: null, player2Rank: null,
    rawSource: {},
  };
}

test("scoreHistoricalMatch: the same physical player occupies the engine's own player1 slot regardless of which one Sackmann-style ingestion recorded as the winner", async () => {
  // matchAlphaWon: stored exactly as Sackmann would ingest it if Alpha won (winner -> player1).
  const matchAlphaWon = targetMatch(100, "wfso-target-a", PLAYER_ALPHA, PLAYER_ZETA, PLAYER_ALPHA);
  // matchZetaWon: the SAME real-world matchup, but stored as if Zeta had won instead (winner ->
  // player1) -- this is the counterfactual the audit's "insert a record with the winner/loser
  // swapped" test is checking: only the recorded outcome differs, nothing about the players
  // themselves changed.
  const matchZetaWon = targetMatch(101, "wfso-target-b", PLAYER_ZETA, PLAYER_ALPHA, PLAYER_ZETA);

  const context = buildContext([...priorRows, matchAlphaWon]);
  const context2 = buildContext([...priorRows, matchZetaWon]);

  const resultAlphaWon = await scoreHistoricalMatch(matchAlphaWon as any, context);
  const resultZetaWon = await scoreHistoricalMatch(matchZetaWon as any, context2);

  assert.ok(resultAlphaWon, "expected a non-null scoring result for matchAlphaWon");
  assert.ok(resultZetaWon, "expected a non-null scoring result for matchZetaWon");

  const slotA = resultAlphaWon!.snapshot.engineSlotAssignment;
  const slotB = resultZetaWon!.snapshot.engineSlotAssignment;
  assert.ok(slotA && slotB, "expected engineSlotAssignment to be populated on both results");

  // The core assertion: the physical player occupying the engine's own "player1" slot must be
  // IDENTICAL across both calls, even though one row recorded Alpha as the winner and the other
  // recorded Zeta as the winner. If slot assignment were still winner-first, these would differ.
  assert.equal(slotA!.enginePlayer1Id, slotB!.enginePlayer1Id, "engine player1 slot must not depend on which player was recorded as the winner");
  assert.equal(slotA!.enginePlayer2Id, slotB!.enginePlayer2Id);
  // Alpha < Zeta lexicographically, so Alpha must always occupy the neutral first slot.
  assert.equal(slotA!.enginePlayer1Id, PLAYER_ALPHA);
});

test("scoreHistoricalMatch: rawProbability/calibratedProbability stay correctly oriented to each row's own stored player1Id, and are complementary across the winner-swapped pair", async () => {
  const matchAlphaWon = targetMatch(200, "wfso-target-c", PLAYER_ALPHA, PLAYER_ZETA, PLAYER_ALPHA);
  const matchZetaWon = targetMatch(201, "wfso-target-d", PLAYER_ZETA, PLAYER_ALPHA, PLAYER_ZETA);

  const resultAlphaFirst = await scoreHistoricalMatch(matchAlphaWon as any, buildContext([...priorRows, matchAlphaWon]));
  const resultZetaFirst = await scoreHistoricalMatch(matchZetaWon as any, buildContext([...priorRows, matchZetaWon]));

  assert.ok(resultAlphaFirst && resultZetaFirst);

  // resultAlphaFirst.rawProbability = P(matchAlphaWon.player1Id wins) = P(Alpha wins).
  // resultZetaFirst.rawProbability  = P(matchZetaWon.player1Id wins)  = P(Zeta wins).
  // Same real matchup either way -> these must sum to ~1, proving the underlying computation the
  // engine performed was the SAME regardless of which id was stored in the player1 column.
  const rawSum = resultAlphaFirst!.rawProbability + resultZetaFirst!.rawProbability;
  assert.ok(Math.abs(rawSum - 1) < 0.02, `expected P(Alpha wins) + P(Zeta wins) ~= 1, got ${rawSum} (raw ${resultAlphaFirst!.rawProbability} + ${resultZetaFirst!.rawProbability})`);

  const calSum = resultAlphaFirst!.calibratedProbability + resultZetaFirst!.calibratedProbability;
  assert.ok(Math.abs(calSum - 1) < 0.02, `expected calibrated P(Alpha wins) + P(Zeta wins) ~= 1, got ${calSum}`);

  // Alpha has the stronger record (3 wins vs 3 losses for Zeta against the same opponent pool),
  // so the model should favor Alpha regardless of which row we read it from.
  assert.ok(resultAlphaFirst!.rawProbability > 0.5, `expected the model to favor the stronger player (Alpha), got P(Alpha wins)=${resultAlphaFirst!.rawProbability}`);
});

test("scoreHistoricalMatch: changing ONLY match.winnerId (nothing else about the row) does not change the prediction at all -- the current match's own outcome never reaches the engine", async () => {
  const real = targetMatch(300, "wfso-target-e", PLAYER_ALPHA, PLAYER_ZETA, PLAYER_ALPHA);
  // Identical row, except winnerId is corrupted to a value that isn't even one of the two players
  // in the match. If scoreHistoricalMatch read match.winnerId for anything other than the
  // caller's own post-hoc grading (which happens OUTSIDE this function), this would either crash
  // or silently change the output. It must do neither.
  const corruptedWinner = { ...real, winnerId: "not-a-real-player-id-at-all" };

  const resultReal = await scoreHistoricalMatch(real as any, buildContext([...priorRows, real]));
  const resultCorrupted = await scoreHistoricalMatch(corruptedWinner as any, buildContext([...priorRows, corruptedWinner]));

  assert.ok(resultReal && resultCorrupted);
  assert.equal(resultReal!.rawProbability, resultCorrupted!.rawProbability, "match.winnerId must never influence rawProbability");
  assert.equal(resultReal!.calibratedProbability, resultCorrupted!.calibratedProbability, "match.winnerId must never influence calibratedProbability");
  assert.deepEqual(resultReal!.snapshot.engineSlotAssignment, resultCorrupted!.snapshot.engineSlotAssignment, "match.winnerId must never influence engine slot assignment");
});

test("scoreHistoricalMatch: the recorded winner remains correctly usable for post-prediction grading, keyed to the row's own stored player1Id/player2Id", async () => {
  // Mirrors every real caller's own grading logic (backtestService.ts, walkForward.ts,
  // shadowReplay.ts, bridgeRescore.ts): predictedWinnerId is derived from
  // calibratedProbability >= 0.5 against the row's OWN stored player1Id/player2Id, then compared
  // to match.winnerId for grading -- entirely outside and after scoreHistoricalMatch.
  const matchAlphaWon = targetMatch(400, "wfso-target-f", PLAYER_ALPHA, PLAYER_ZETA, PLAYER_ALPHA);
  const result = await scoreHistoricalMatch(matchAlphaWon as any, buildContext([...priorRows, matchAlphaWon]));
  assert.ok(result);

  const predictedWinnerId = result!.calibratedProbability >= 0.5 ? matchAlphaWon.player1Id : matchAlphaWon.player2Id;
  const correct = predictedWinnerId === matchAlphaWon.winnerId;

  // The model favors Alpha (see the complementarity test above), and Alpha is indeed the recorded
  // winner here, so grading should mark this correct -- proving the winner is still fully usable
  // for grading despite never having been visible to the engine during scoring.
  assert.equal(predictedWinnerId, PLAYER_ALPHA);
  assert.equal(correct, true);
});
