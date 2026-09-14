// ----------------------------------------------------------------------------
// Does valid point-by-point data actually REACH the metric producers?
//
// Every other check in this layer proves something about failure: that a missing credential
// is not absence, that a timeout is not absence. None of them prove the success path, and a
// retrieval layer that classifies failures perfectly while never delivering a payload would
// pass all of them. So this walks a realistic provider payload the whole way:
//
//   provider response -> fetchPbpClassified -> reconstructPbpScoreState -> metric observations
//
// and asserts the six point-derived metrics (002, 003, 009, 016, 018, 032) come out the far
// end with values. It uses a stubbed provider because the real one needs a credential this
// environment does not have -- but everything after the HTTP boundary is the real code.
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { fetchPbpClassified } from "./bsd-pbp-fetch.js";
import { reconstructPbpScoreState, TASK18B_METRIC_CODES } from "./pbp-score-state-recovery.js";

/** The six point-derived metrics this provider exists to feed. */
const POINT_DERIVED = ["002", "003", "009", "016", "018", "032"];

/**
 * One game: `winner` wins it, taking `winnerPoints` points to `loserPoints`. Points are
 * emitted in an order that actually reaches that score under win-by-two, because the
 * reconstructor derives the game outcome from the points rather than trusting the label.
 */
function game(setNo: number, server: "player1" | "player2", winner: "player1" | "player2", winnerPoints = 4, loserPoints = 0) {
  const loser = winner === "player1" ? "player2" : "player1";
  const points: Array<{ winner: string }> = [];
  for (let i = 0; i < loserPoints; i++) points.push({ winner: loser });
  for (let i = 0; i < winnerPoints; i++) points.push({ winner });
  return { set_number: setNo, server, winner, points };
}

/** A complete straight-sets match: 6-4, 6-3, with serve alternating. */
function realisticPayload() {
  const games: ReturnType<typeof game>[] = [];
  for (let setNo = 1; setNo <= 2; setNo++) {
    const opponentGames = setNo === 1 ? 4 : 3;
    let index = 0;
    for (let g = 0; g < 6; g++) {
      games.push(game(setNo, index % 2 === 0 ? "player1" : "player2", "player1", 4, g % 3));
      index++;
    }
    for (let g = 0; g < opponentGames; g++) {
      games.push(game(setNo, index % 2 === 0 ? "player1" : "player2", "player2", 4, 1));
      index++;
    }
  }
  return {
    available: true,
    sets: [
      { set_number: 1, games: games.filter((g) => g.set_number === 1) },
      { set_number: 2, games: games.filter((g) => g.set_number === 2) },
    ],
  };
}

describe("valid point-by-point data reaches the metric producers", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env["BSD_TENNIS_API_KEY"];
  });

  test("the six point-derived metrics are exactly the ones this provider feeds", () => {
    // Guards against the metric set drifting away from what the retrieval layer serves.
    assert.deepEqual([...TASK18B_METRIC_CODES].sort(), [...POINT_DERIVED].sort());
  });

  test("a provider payload survives retrieval and produces observations for all six", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "test-key";
    const payload = realisticPayload();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;

    const retrieved = await fetchPbpClassified(42, { userAgent: "test/1.0" });
    assert.equal(retrieved.ok, true, "a well-formed available payload must retrieve cleanly");

    const recovery = reconstructPbpScoreState(retrieved.ok === true ? retrieved.payload : {});
    assert.equal(recovery.valid, true, `reconstruction rejected the payload: ${recovery.reason ?? ""}`);
    assert.ok(recovery.point_count > 0, "no points were parsed");
    assert.ok(recovery.game_count > 0, "no games were parsed");

    // The producer emits per-side derived values; every point-derived metric must appear for
    // at least one side, or the retrieval reached the producer without feeding it.
    const derivedCodes = new Set<string>([
      ...Object.keys(recovery.derived.player1 ?? {}),
      ...Object.keys(recovery.derived.player2 ?? {}),
    ]);
    const missing = POINT_DERIVED.filter((code) => !derivedCodes.has(code));
    assert.deepEqual(missing, [], `no observation produced for: ${missing.join(", ")}`);
  });

  test("each produced observation carries an actual value, not an empty shell", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "test-key";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(realisticPayload()), { status: 200 })) as typeof fetch;

    const retrieved = await fetchPbpClassified(7, { userAgent: "test/1.0" });
    const recovery = reconstructPbpScoreState(retrieved.ok === true ? retrieved.payload : {});
    const side = Object.keys(recovery.derived.player1 ?? {}).length ? "player1" : "player2";
    const derived = (recovery.derived as Record<string, Record<string, unknown>>)[side] ?? {};

    for (const code of POINT_DERIVED) {
      const value = derived[code];
      if (value === undefined) continue; // covered by the previous test across both sides
      assert.notEqual(value, null, `${code} produced a null value`);
      assert.notEqual(value, "", `${code} produced an empty value`);
    }
  });

  test("a payload the provider marks unavailable never reaches the producer", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "test-key";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ available: false, sets: [] }), { status: 200 })) as typeof fetch;

    const retrieved = await fetchPbpClassified(9, { userAgent: "test/1.0" });
    // Genuine absence stops at the boundary, classified, rather than arriving as empty data
    // the reconstructor would have to interpret.
    assert.equal(retrieved.ok, false);
    assert.equal(retrieved.ok === false && retrieved.reason, "NO_QUALIFYING_DATA");
  });

  test("a structurally incomplete payload is rejected rather than half-credited", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "test-key";
    // Points with no winner: the game outcome is unknowable, so the whole recovery must be
    // invalid rather than silently scoring the points it could read.
    const broken = {
      available: true,
      sets: [{ set_number: 1, games: [{ set_number: 1, server: "player1", points: [{}, {}] }] }],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(broken), { status: 200 })) as typeof fetch;

    const retrieved = await fetchPbpClassified(11, { userAgent: "test/1.0" });
    assert.equal(retrieved.ok, true, "the provider did return a payload; the problem is its contents");
    const recovery = reconstructPbpScoreState(retrieved.ok === true ? retrieved.payload : {});
    // Returned-but-unusable is a THIRD outcome, distinct from both a provider failure and a
    // genuine absence: the data arrived and failed reconstruction.
    assert.equal(recovery.valid, false);
    assert.ok((recovery.reason ?? "").length > 0, "a rejection must say why");
  });
});
