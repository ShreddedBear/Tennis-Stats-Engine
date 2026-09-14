// ----------------------------------------------------------------------------
// Reconstruction against REAL captured provider tapes.
//
// Every other test in this layer uses a payload I wrote, which proves the code agrees with
// my idea of a tape. These use point arrays captured from the actual provider
// (__fixtures__/captured-pbp-games.json, taken from the BSD accuracy probe), so the shape is
// the provider's rather than mine.
//
// The shape matters in one way that synthetic payloads keep getting wrong: the tape lists
// the score AFTER each point, and the GAME-DECIDING POINT IS OMITTED. A game ends at "40-A"
// or "30-40" and simply stops. Any derivation that assumed the last listed state was the end
// of the game, or that tried to append the winning point, would either miscount or invent a
// point the provider never sent.
//
// THE CENTRAL ASSERTION: stripping the explicit per-point winners and deriving them from the
// score progression must reproduce the provider's own numbers EXACTLY. Not approximately --
// exactly. If derivation ever disagrees with the ground truth it is guessing, and a guessed
// point is fabricated evidence.
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { reconstructPbpScoreState } from "./pbp-score-state-recovery.js";

const POINT_DERIVED = ["002", "003", "009", "016", "018", "032"];

const capturedGames: Array<Array<Record<string, unknown>>> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "captured-pbp-games.json"), "utf8"),
);

/**
 * The deciding point is omitted from the tape, so the game's winner is whoever the last
 * listed state leaves in a winning position. This is the fixture's own ground truth, used
 * only to build the game wrapper -- never fed to the derivation under test.
 */
function trueGameWinner(points: Array<Record<string, unknown>>): string {
  const last = points[points.length - 1]!;
  const p1 = String(last["player1_score"]);
  const p2 = String(last["player2_score"]);
  if (p1 === "A") return "player1";
  if (p2 === "A") return "player2";
  if (p1 === "40" && p2 !== "40") return "player1";
  if (p2 === "40" && p1 !== "40") return "player2";
  return String(last["winner"] ?? "player1");
}

function build(stripWinners: boolean) {
  const games = capturedGames.map((points, index) => ({
    game: index + 1,
    server: index % 2 === 0 ? "player1" : "player2",
    winner: trueGameWinner(points),
    points: points.map((p) =>
      stripWinners
        ? { player1_score: p["player1_score"], player2_score: p["player2_score"] }
        : { ...p }),
  }));
  return { match_id: 294, available: true, sets: [{ set: 1, games }] };
}

describe("captured provider tapes", () => {
  test("the fixture really is the shape this engine has to read", () => {
    assert.ok(capturedGames.length > 0, "no captured games in the fixture");
    const first = capturedGames[0]![0]!;
    // Split per-point scores, not a single combined "score" string.
    assert.ok("player1_score" in first && "player2_score" in first);
    // And the deciding point is absent: no game ends on a state that has already been won.
    for (const points of capturedGames) {
      const last = points[points.length - 1]!;
      const p1 = String(last["player1_score"]);
      const p2 = String(last["player2_score"]);
      assert.ok(["0", "15", "30", "40", "A"].includes(p1) && ["0", "15", "30", "40", "A"].includes(p2),
        `unexpected closing state ${p1}-${p2}`);
    }
  });

  test("a real tape WITH per-point winners produces all six metrics", () => {
    const recovery = reconstructPbpScoreState(build(false));
    assert.equal(recovery.valid, true, recovery.reason ?? "");
    const codes = new Set([
      ...Object.keys(recovery.derived.player1 ?? {}),
      ...Object.keys(recovery.derived.player2 ?? {}),
    ]);
    assert.deepEqual(POINT_DERIVED.filter((c) => !codes.has(c)), []);
  });

  test("the same tape WITHOUT per-point winners also produces all six -- the run #3 case", () => {
    const recovery = reconstructPbpScoreState(build(true));
    assert.equal(recovery.valid, true,
      `a real score-only tape was rejected: ${recovery.reason ?? ""}`);
    const codes = new Set([
      ...Object.keys(recovery.derived.player1 ?? {}),
      ...Object.keys(recovery.derived.player2 ?? {}),
    ]);
    assert.deepEqual(POINT_DERIVED.filter((c) => !codes.has(c)), []);
  });

  test("derivation reproduces the provider's own numbers EXACTLY", () => {
    const withWinners = reconstructPbpScoreState(build(false));
    const derivedOnly = reconstructPbpScoreState(build(true));

    // Same structure read out of the same tape.
    assert.equal(derivedOnly.point_count, withWinners.point_count);
    assert.equal(derivedOnly.game_count, withWinners.game_count);

    // And the same values. Any difference means the derivation is guessing rather than
    // recovering, which would make every metric built on it fabricated.
    const differences: string[] = [];
    for (const side of ["player1", "player2"] as const) {
      const truth = (withWinners.derived as Record<string, Record<string, unknown>>)[side] ?? {};
      const derived = (derivedOnly.derived as Record<string, Record<string, unknown>>)[side] ?? {};
      for (const code of new Set([...Object.keys(truth), ...Object.keys(derived)])) {
        if (JSON.stringify(truth[code]) !== JSON.stringify(derived[code])) {
          differences.push(`${side}/${code}: ${JSON.stringify(truth[code])} vs ${JSON.stringify(derived[code])}`);
        }
      }
    }
    assert.deepEqual(differences, [], `derivation disagreed with the provider:\n${differences.join("\n")}`);
  });

  test("corrupting one score in a real tape rejects that game rather than mis-scoring it", () => {
    const payload = build(true);
    const game = payload.sets[0]!.games[0]!;
    // Make one transition impossible: jump the server two ladder steps at once.
    (game.points[1] as Record<string, unknown>)["player1_score"] = "40";
    (game.points[1] as Record<string, unknown>)["player2_score"] = "40";
    const recovery = reconstructPbpScoreState(payload);
    // The tape can no longer be read honestly, so it is refused outright.
    assert.equal(recovery.valid, false);
  });
});
