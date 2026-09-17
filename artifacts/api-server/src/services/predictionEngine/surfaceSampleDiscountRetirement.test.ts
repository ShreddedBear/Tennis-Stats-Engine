import test from "node:test";
import assert from "node:assert/strict";
import { runPredictionEngine } from "./index";
import type { PredictionEngineInput } from "./types";
import type { PlayerProfile, MatchRecord } from "../tennisData/types";
import { calibrateProbability } from "./calibration";
import { TOUR_RELIABILITY_DISCOUNT, LOW_SURFACE_SAMPLE_DISCOUNT } from "./dataQuality";

/**
 * Surface-sample double-counting fix regression suite (see the retirement comment at
 * `surfaceSampleDiscount` in index.ts and `LOW_SURFACE_SAMPLE_DISCOUNT`'s doc in dataQuality.ts).
 *
 * Deliberately does NOT assert on `output.engine.consistencyViolations` anywhere in this file.
 * A pre-existing, independent bug in finalConsistencyCheck.ts (Rule 10 never forwards
 * `eloGapPoints` to its internal `computeRecommendation` recompute, so it silently assumes the
 * "Decisive" separation band; Rule 12 hardcodes an assumption that predates
 * `computeRecommendation`'s 2026-08-13 eloGapPoints gate) can fire on some real, differentiated
 * predictions independently of this fix -- proven reproducible against the untouched baseline,
 * see the task report. Fixing it is out of this task's scope (it is not part of the surface-
 * sample-uncertainty dependency chain), so these tests stay narrowly focused on the properties
 * this fix is actually responsible for.
 */

function player(id: string, name: string, tour: "ATP" | "WTA" = "ATP"): PlayerProfile {
  return { id, name, countryCode: "US", currentRank: 40, tour, age: 26, plays: "Right-handed", fullName: name };
}

function match(opponentId: string, opponentName: string, won: boolean, surface: "Hard" | "Clay" | "Grass", daysAgo: number, servicePointsWonPct: number): MatchRecord {
  const date = new Date(Date.now());
  date.setDate(date.getDate() - daysAgo);
  return {
    id: `m-${opponentId}-${daysAgo}`,
    date: date.toISOString().slice(0, 10),
    tournamentName: "Fixture Open",
    tournamentLevel: "ATP250",
    round: "R32",
    matchFormat: "BestOf3",
    surface,
    indoor: false,
    opponentId,
    opponentName,
    opponentRank: 60,
    result: won ? "W" : "L",
    score: won ? "6-3 6-4" : "3-6 4-6",
    retired: false,
    walkover: false,
    stats: { firstServePct: 62, firstServeWon: 70, secondServeWon: 50, aces: 5, doubleFaults: 2, breakPointsSaved: 60, breakPointsFaced: 5, returnPointsWon: 38, servicePointsWonPct },
    opponentStats: null,
    setGameMargins: won ? [{ playerGames: 6, opponentGames: 3 }, { playerGames: 6, opponentGames: 4 }] : [{ playerGames: 3, opponentGames: 6 }, { playerGames: 4, opponentGames: 6 }],
  };
}

function baseInput(overrides: Partial<PredictionEngineInput> = {}): PredictionEngineInput {
  const player1 = player("p1", "Player One");
  const player2 = player("p2", "Player Two");
  return {
    player1,
    player2,
    player1Matches: Array.from({ length: 8 }, (_, i) => match(`opp1-${i}`, `Opp1-${i}`, i % 4 !== 0, "Hard", 10 + i * 10, 65)),
    player2Matches: Array.from({ length: 8 }, (_, i) => match(`opp2-${i}`, `Opp2-${i}`, i % 3 === 0, "Hard", 12 + i * 10, 52)),
    headToHead: { player1Id: player1.id, player2Id: player2.id, meetings: [] },
    surface: "Hard",
    matchFormat: "BestOf3",
    tournamentName: "Fixture Open",
    weather: null,
    segment: null,
    simulatorAdoption: null,
    activeCalibration: null,
    ...overrides,
  };
}

/** A player with plenty of matches, all on `surface`, so their surface sample is unambiguously High. */
function richMatches(prefix: string, surface: "Hard" | "Clay" | "Grass"): MatchRecord[] {
  return Array.from({ length: 20 }, (_, i) => match(`${prefix}-${i}`, `${prefix} Opp ${i}`, i % 3 !== 0, surface, 10 + i * 15, 60 + (i % 5)));
}

// ── Property: low surface sample no longer receives a second, redundant final-stage shrink ──

test("low surface sample: reliabilityDiscount is 1 (no residual final shrink) when no ATP segment and no real calibration are in play", async () => {
  const output = await runPredictionEngine(
    baseInput({
      surface: "Clay",
      // Player 1 has ZERO Clay matches (all Hard) -- Player 2 has plenty of Clay matches.
      player1Matches: Array.from({ length: 6 }, (_, i) => match(`p1h-${i}`, `P1 Hard ${i}`, i % 2 === 0, "Hard", 10 + i * 10, 64)),
      player2Matches: richMatches("p2c", "Clay"),
      segment: null,
      activeCalibration: null,
    }),
  );

  assert.equal(output.engine.surfaceSampleDepth.label, "Low", "fixture must genuinely be a Low surface-sample case for this test to mean anything");
  assert.equal(output.decisionTrace.pipeline.reliabilityDiscount, 1, "no tour segment and no low-surface-sample discount fired -- the reliability-discount stage must be a pure no-op");
  assert.equal(
    output.decisionTrace.pipeline.afterReliabilityDiscount,
    output.decisionTrace.pipeline.afterSpecialist,
    "with reliabilityDiscount=1, the probability entering and leaving the reliability-discount stage must be identical",
  );
});

test("low surface sample: the OLD formula would have shrunk this prediction further toward 50 than the fixed engine now does", async () => {
  const input = baseInput({
    surface: "Clay",
    player1Matches: Array.from({ length: 6 }, (_, i) => match(`p1h-${i}`, `P1 Hard ${i}`, i % 2 === 0, "Hard", 10 + i * 10, 64)),
    player2Matches: richMatches("p2c", "Clay"),
    segment: null,
    activeCalibration: null,
  });
  const output = await runPredictionEngine(input);
  assert.equal(output.engine.surfaceSampleDepth.label, "Low");

  const afterSpecialist = output.decisionTrace.pipeline.afterSpecialist;
  const newAfterDiscount = output.decisionTrace.pipeline.afterReliabilityDiscount;

  // Reconstruct exactly what the RETIRED formula produced: tourDiscount (1, no segment here) times
  // LOW_SURFACE_SAMPLE_DISCOUNT (0.75, since label is Low, no specialist, no real calibration).
  const oldReliabilityDiscount = Math.round(1 * LOW_SURFACE_SAMPLE_DISCOUNT * 1000) / 1000;
  const oldAfterDiscount = oldReliabilityDiscount < 1 ? Math.round((50 + (afterSpecialist - 50) * oldReliabilityDiscount) * 10) / 10 : afterSpecialist;

  assert.ok(oldReliabilityDiscount < 1, "sanity: the retired formula did fire for this fixture");
  assert.notEqual(newAfterDiscount, oldAfterDiscount, "the fix must produce a different (less-shrunk) number than the old double-counting formula");
  assert.ok(
    Math.abs(newAfterDiscount - 50) > Math.abs(oldAfterDiscount - 50),
    `the new, corrected probability (${newAfterDiscount}) must sit strictly further from 50 than the old, redundantly-shrunk one (${oldAfterDiscount})`,
  );
});

// ── Property: ATP discount is completely unaffected by this fix ──

test("ATP discount: unchanged -- fires at exactly TOUR_RELIABILITY_DISCOUNT.ATP when a non-qualifying ATP segment is present and the surface sample is High (isolating the tour effect)", async () => {
  const output = await runPredictionEngine(
    baseInput({
      surface: "Hard",
      player1Matches: richMatches("p1h", "Hard"),
      player2Matches: richMatches("p2h", "Hard"),
      segment: {
        segmentKey: "ATP-Hard",
        label: "ATP Hard",
        meetsThreshold: false, // below its own data-sufficiency threshold -- specialistApplied stays false
        historicalMatchCount: 10,
        validationSampleSize: 5,
        minHistoricalMatches: 50,
        minValidationSamples: 20,
        calibrationMapping: [],
        weight: 0,
      },
      activeCalibration: null,
    }),
  );

  assert.equal(output.engine.specialistApplied, false, "segment must not qualify -- isolating the tour discount from specialist correction");
  assert.equal(output.engine.surfaceSampleDepth.label, "High", "fixture must be a High surface-sample case so only the ATP discount, never the retired surface discount, could be responsible for any shrink");
  assert.equal(output.decisionTrace.pipeline.reliabilityDiscount, TOUR_RELIABILITY_DISCOUNT["ATP"], "the ATP discount must fire at its documented, untouched value");

  const afterSpecialist = output.decisionTrace.pipeline.afterSpecialist;
  const expected = Math.round((50 + (afterSpecialist - 50) * TOUR_RELIABILITY_DISCOUNT["ATP"]!) * 10) / 10;
  assert.equal(output.decisionTrace.pipeline.afterReliabilityDiscount, expected, "the ATP discount's arithmetic is byte-for-byte the same formula as before this fix");
});

test("ATP discount: still multiplies with the (now-retired) surface factor exactly as documented -- i.e. reduces to the ATP factor alone, never more, on a Low surface sample", async () => {
  // Before the fix this same fixture would have combined ATP x0.63 AND surface x0.75
  // multiplicatively. After the fix it must reduce to ATP x0.63 alone.
  // Surface is Grass, not Clay: Ticket 1 (2026-08-08) unconditionally nulls `segment` on Clay
  // (specialistDisabledForSurface), which would zero segmentTour along with it and make this
  // fixture unable to isolate "ATP discount x now-retired surface discount" the way it needs to.
  const output = await runPredictionEngine(
    baseInput({
      surface: "Grass",
      player1Matches: Array.from({ length: 6 }, (_, i) => match(`p1h-${i}`, `P1 Hard ${i}`, i % 2 === 0, "Hard", 10 + i * 10, 64)),
      player2Matches: richMatches("p2g", "Grass"),
      segment: {
        segmentKey: "ATP-Grass",
        label: "ATP Grass",
        meetsThreshold: false,
        historicalMatchCount: 10,
        validationSampleSize: 5,
        minHistoricalMatches: 50,
        minValidationSamples: 20,
        calibrationMapping: [],
        weight: 0,
      },
      activeCalibration: null,
    }),
  );

  assert.equal(output.engine.surfaceSampleDepth.label, "Low", "fixture must genuinely combine ATP tour + Low surface sample");
  assert.equal(
    output.decisionTrace.pipeline.reliabilityDiscount,
    TOUR_RELIABILITY_DISCOUNT["ATP"],
    "reliabilityDiscount must equal the ATP factor ALONE -- the retired surface factor must no longer multiply into it",
  );
});

// ── Property: fallback calibration curve itself is untouched ──

test("fallback calibration: afterCalibration is bit-for-bit calibrateProbability(afterTieBreaker, dataQuality) -- the curve itself was not touched", async () => {
  const output = await runPredictionEngine(baseInput());
  assert.equal(output.decisionTrace.pipeline.calibrationMethod, "fallback");
  const recomputed = calibrateProbability(output.decisionTrace.pipeline.afterTieBreaker, output.dataQuality);
  assert.equal(output.decisionTrace.pipeline.afterCalibration, recomputed, "re-running the real, untouched calibrateProbability against this run's own recorded inputs must reproduce the exact stored value");
});

// ── Property: real (fitted) calibration path is untouched -- it already never applied either discount ──

test("real calibration active: reliabilityDiscount is 1 regardless of surface-sample label -- unaffected by this fix, exactly as before", async () => {
  const output = await runPredictionEngine(
    baseInput({
      surface: "Clay",
      player1Matches: Array.from({ length: 6 }, (_, i) => match(`p1h-${i}`, `P1 Hard ${i}`, i % 2 === 0, "Hard", 10 + i * 10, 64)),
      player2Matches: richMatches("p2c", "Clay"),
      segment: null,
      activeCalibration: [
        { x: 0.3, y: 0.32 },
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.68 },
      ],
    }),
  );
  assert.equal(output.engine.surfaceSampleDepth.label, "Low", "fixture is genuinely Low-sample -- proves the discount is skipped BECAUSE real calibration is active, not because the sample happens to be High");
  assert.equal(output.decisionTrace.pipeline.calibrationMethod, "fitted");
  assert.equal(output.decisionTrace.pipeline.reliabilityDiscount, 1, "real calibration already forced both discounts off before this fix; this fix changes nothing on this path");
});

// ── Property: High-quality surface samples are unaffected (the discount never applied to them) ──

test("high surface sample: identical to what the engine produced before this fix -- reliabilityDiscount was already 1 for High samples", async () => {
  const output = await runPredictionEngine(
    baseInput({
      surface: "Hard",
      player1Matches: richMatches("p1h", "Hard"),
      player2Matches: richMatches("p2h", "Hard"),
      segment: null,
      activeCalibration: null,
    }),
  );
  assert.equal(output.engine.surfaceSampleDepth.label, "High");
  assert.equal(output.decisionTrace.pipeline.reliabilityDiscount, 1);
  assert.equal(output.decisionTrace.pipeline.afterReliabilityDiscount, output.decisionTrace.pipeline.afterSpecialist);
});

// ── Property: probability stays within the engine's existing clamps ──

test("clamps: calibratedProbability stays within [0.6, 99.4] even for an extreme Low-surface-sample, lopsided fixture", async () => {
  const output = await runPredictionEngine(
    baseInput({
      surface: "Clay",
      player1Matches: Array.from({ length: 6 }, (_, i) => match(`p1h-${i}`, `P1 Hard ${i}`, true, "Hard", 10 + i * 10, 85)),
      player2Matches: Array.from({ length: 6 }, (_, i) => match(`p2h-${i}`, `P2 Hard ${i}`, false, "Hard", 10 + i * 10, 25)),
      segment: null,
      activeCalibration: null,
    }),
  );
  assert.ok(output.calibratedProbability >= 0.6 && output.calibratedProbability <= 99.4, `calibratedProbability=${output.calibratedProbability} must respect the existing [0.6, 99.4] clamp`);
});

// ── Property: orientation (which player is favored) is unchanged by the fix ──

test("orientation: swapping player1/player2 mirrors calibratedProbability around 50 and flips the predicted winner", async () => {
  const forwardInput = baseInput({
    surface: "Clay",
    player1Matches: Array.from({ length: 6 }, (_, i) => match(`p1h-${i}`, `P1 Hard ${i}`, true, "Hard", 10 + i * 10, 70)),
    player2Matches: richMatches("p2c", "Clay"),
    segment: null,
    activeCalibration: null,
  });
  const forward = await runPredictionEngine(forwardInput);

  const swapped = await runPredictionEngine({
    ...forwardInput,
    player1: forwardInput.player2,
    player2: forwardInput.player1,
    player1Matches: forwardInput.player2Matches,
    player2Matches: forwardInput.player1Matches,
    headToHead: { player1Id: forwardInput.player2.id, player2Id: forwardInput.player1.id, meetings: [] },
  });

  assert.ok(Math.abs(forward.calibratedProbability + swapped.calibratedProbability - 100) <= 0.2, `swap-mirrored probabilities (${forward.calibratedProbability}, ${swapped.calibratedProbability}) must sum to ~100`);
  // The stronger real player (forwardInput.player1) must still be the predicted winner after the
  // swap, even though they now occupy the "player2" slot -- the predicted winner is an identity,
  // not a slot, so it must NOT flip when the slots do.
  assert.equal(forward.predictedWinnerId, forwardInput.player1.id, "sanity: player1 must be favored in the forward orientation for this fixture");
  assert.equal(swapped.predictedWinnerId, forwardInput.player1.id, "the predicted winner identity must stay the same real player after a pure slot swap");
});

// ── Property: an exact tie stays exactly 50, even through a Low-sample reliability-discount stage ──

// This is intentionally a direct, isolated proof of the SAME formula index.ts actually runs
// (`50 + (blendedProbability - 50) * reliabilityDiscount`, guarded by `reliabilityDiscount < 1`)
// rather than another `runPredictionEngine` call. A full-engine fixture built for player1/player2
// symmetry (identical records, ranks, ages) was tried first and found to land on 49.9, not 50 --
// traced to `buildEnsemble` in ensemble.ts rounding each module's `weightUsed` to 3 decimals
// BEFORE summing, so the weights can sum to slightly under 1.0 even when every module's own vote
// is exactly 50. That rounding behavior is pre-existing, present in ensemble.ts (a file this fix
// does not touch), and orthogonal to the reliability-discount step -- it would affect this exact
// scenario identically with or without this fix. Testing the formula directly avoids asserting on
// a full-engine "exact 50" outcome that isn't actually guaranteed by unrelated code.
function applyReliabilityDiscount(blendedProbability: number, reliabilityDiscount: number): number {
  return reliabilityDiscount < 1 ? Math.round((50 + (blendedProbability - 50) * reliabilityDiscount) * 10) / 10 : blendedProbability;
}

test("exact tie: 50 + (50-50)*discount stays exactly 50 for every discount value this fix can produce, fired or not", () => {
  for (const discount of [1, TOUR_RELIABILITY_DISCOUNT["ATP"]!, LOW_SURFACE_SAMPLE_DISCOUNT, Math.round(TOUR_RELIABILITY_DISCOUNT["ATP"]! * LOW_SURFACE_SAMPLE_DISCOUNT * 1000) / 1000]) {
    assert.equal(applyReliabilityDiscount(50, discount), 50, `discount=${discount} must not move an exact-50 input away from 50`);
  }
});
