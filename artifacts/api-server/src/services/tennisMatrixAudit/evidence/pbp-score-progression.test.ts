// ----------------------------------------------------------------------------
// Point winners derived from a score progression.
//
// The majority of these tests are REJECTION tests, on purpose. Deriving a winner from a
// score that went up is reading the tape. Filling one in when the tape is ambiguous is
// fabricating evidence, and a metric built on a fabricated point is worse than a metric with
// no data at all -- it is confidently wrong rather than honestly absent. So every ambiguous
// shape below must return null for the whole game rather than a plausible-looking answer.
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  derivePointWinners, parseScoreState, pointWinnerBetween, scoreProgressionOf,
} from "./pbp-score-progression.js";

const winners = (result: ReturnType<typeof derivePointWinners>) =>
  (result ?? []).map((p) => p.winner);

describe("reading a score progression", () => {
  test("a clean hold to love is four points to the server", () => {
    const result = derivePointWinners(["15-0", "30-0", "40-0"], "player1");
    assert.deepEqual(winners(result), ["player1", "player1", "player1", "player1"]);
  });

  test("points alternate exactly as the score says", () => {
    const result = derivePointWinners(["15-0", "15-15", "30-15", "30-30"], "player2");
    assert.deepEqual(winners(result), ["player1", "player2", "player1", "player2", "player2"]);
  });

  test("an explicit opening 0-0 is not counted as a point", () => {
    const withOpening = derivePointWinners(["0-0", "15-0", "30-0"], "player1");
    const without = derivePointWinners(["15-0", "30-0"], "player1");
    assert.deepEqual(winners(withOpening), winners(without));
    assert.equal(winners(withOpening).length, 3);
  });

  test("deuce and advantage are read, including advantage surrendered", () => {
    // 40-40 -> AD-40 (p1 wins) -> 40-40 (p2 wins it back) -> AD-40 (p1) -> game.
    const result = derivePointWinners(["15-0", "30-0", "40-0", "40-15", "40-30", "40-40", "A-40", "40-40", "A-40"], "player1");
    assert.deepEqual(winners(result), [
      "player1", "player1", "player1", "player2", "player2", "player2",
      "player1", "player2", "player1", "player1",
    ]);
  });

  test("a tiebreak is read as plain integers", () => {
    const result = derivePointWinners(["1-0", "1-1", "2-1", "3-1"], "player1");
    assert.deepEqual(winners(result), ["player1", "player2", "player1", "player1", "player1"]);
  });

  test("common notations parse to the same thing", () => {
    for (const form of ["15-30", "15:30", "15 30", [1, 2], { p1: 1, p2: 2 }] as unknown[]) {
      const state = parseScoreState(form);
      assert.ok(state, `failed to parse ${JSON.stringify(form)}`);
      assert.equal(state!.p1, 1);
      assert.equal(state!.p2, 2);
    }
  });

  test("advantage spellings are all understood", () => {
    for (const form of ["A-40", "AD-40", "Adv-40", "advantage-40"]) {
      const state = parseScoreState(form);
      assert.equal(state?.p1, 4, `failed on ${form}`);
    }
  });
});

describe("ambiguity rejects rather than guessing", () => {
  test("both sides changing in one step is not a point", () => {
    assert.equal(derivePointWinners(["15-0", "30-15"], "player1"), null);
  });

  test("a score that does not change is not a point", () => {
    assert.equal(derivePointWinners(["15-0", "15-0"], "player1"), null);
  });

  test("a score jumping two steps is rejected, not split into two points", () => {
    // A gap means points are missing from the tape; inventing the intermediate winner would
    // be fabricating a point the provider never reported.
    assert.equal(derivePointWinners(["15-0", "40-0"], "player1"), null);
  });

  test("a score going backwards outside advantage is rejected", () => {
    assert.equal(derivePointWinners(["30-0", "15-0"], "player1"), null);
  });

  test("unparseable notation rejects the whole game", () => {
    assert.equal(derivePointWinners(["15-0", "banana"], "player1"), null);
    assert.equal(derivePointWinners(["15-0", "15-0-0"], "player1"), null);
    assert.equal(derivePointWinners([""], "player1"), null);
  });

  test("switching between ladder and numeric mid-game is rejected", () => {
    // 40-0 then 4-0 is a notation change, not a rally.
    assert.equal(pointWinnerBetween(
      { p1: 3, p2: 0, numeric: false }, { p1: 4, p2: 0, numeric: true },
    ), null);
  });

  test("an empty or missing progression yields nothing", () => {
    assert.equal(derivePointWinners([], "player1"), null);
    assert.equal(derivePointWinners(null as unknown as unknown[], "player1"), null);
  });

  test("without a stated game winner the closing point is not invented", () => {
    // The in-game states stop before the game-winning point. Its winner is genuinely
    // unknown, so it is left out rather than assumed from who was ahead.
    const result = derivePointWinners(["15-0", "30-0", "40-0"], null);
    assert.deepEqual(winners(result), ["player1", "player1", "player1"]);
  });

  test("one bad step rejects the entire game, not just that point", () => {
    // Partial credit would leave a game scored from a tape known to be unreliable.
    assert.equal(derivePointWinners(["15-0", "30-0", "30-30", "40-30"], "player1"), null);
  });
});

describe("locating a progression on a game object", () => {
  test("finds a dedicated progression field", () => {
    assert.deepEqual(scoreProgressionOf({ score_progression: ["15-0", "30-0"] }), ["15-0", "30-0"]);
    assert.deepEqual(scoreProgressionOf({ scores: ["15-0"] }), ["15-0"]);
  });

  test("finds per-point score fields", () => {
    const game = { points: [{ score: "15-0" }, { score_after: "30-0" }] };
    assert.deepEqual(scoreProgressionOf(game), ["15-0", "30-0"]);
  });

  test("returns null when some points carry no score, so a partial tape is not used", () => {
    assert.equal(scoreProgressionOf({ points: [{ score: "15-0" }, {}] }), null);
  });

  test("returns null when there is no progression at all", () => {
    assert.equal(scoreProgressionOf({ points: [{ winner: "player1" }] }), null);
    assert.equal(scoreProgressionOf({}), null);
  });
});
