// Targeted, DB-free tests for the P1 Package 4 follow-on harness additions: `combo_pure_trio`
// and the Monte Carlo ON/OFF isolation mechanism (`useResolvedSimulatorAdoption` /
// `resolveVariantSimulatorAdoption`). These call `runPredictionEngine` directly with the exact
// `excludedModels`/`simulatorAdoption` values the real ablation variants use, rather than running
// `runAblationAnalysis` itself (which needs a live historical-matches corpus from a real
// database) -- this is exactly the "small, credit-efficient, no DB connection" scope requested.
//
// Importing from `./ablation` pulls in `@workspace/db` (a real, non-type import at the top of
// that file) purely as a MODULE-LOAD-TIME guard (`if (!process.env.DATABASE_URL) throw`) -- no
// query runs anywhere in this test file. A placeholder, unreachable connection string satisfies
// that guard without ever opening a real connection (`new Pool()` is lazy). Run with e.g.:
//   DATABASE_URL=postgres://user:pass@localhost:5432/placeholder_no_connection_made \
//     npx tsx --test src/services/evaluation/ablation.pureTrioAndSimulator.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { runPredictionEngine } from "../predictionEngine";
import type { PredictionEngineInput } from "../predictionEngine/types";
import type { PlayerProfile, MatchRecord } from "../tennisData/types";
import { COMBO_VARIANTS, resolveVariantSimulatorAdoption, MODEL_DEFS } from "./ablation";
import type { SimulatorAdoptionInput } from "../predictionEngine/types";

function player(id: string, name: string): PlayerProfile {
  return { id, name, countryCode: "US", currentRank: 40, tour: "ATP", age: 26, plays: "Right-handed", fullName: name };
}

function match(opponentId: string, opponentName: string, won: boolean, daysAgo: number, servicePointsWonPct: number): MatchRecord {
  const date = new Date(Date.now());
  date.setDate(date.getDate() - daysAgo);
  return {
    id: `m-${opponentId}-${daysAgo}`,
    date: date.toISOString().slice(0, 10),
    tournamentName: "Fixture Open",
    tournamentLevel: "ATP250",
    round: "R32",
    matchFormat: "BestOf3",
    surface: "Hard",
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
    player1Matches: Array.from({ length: 8 }, (_, i) => match(`opp1-${i}`, `Opp1-${i}`, i % 4 !== 0, 10 + i * 10, 65)),
    player2Matches: Array.from({ length: 8 }, (_, i) => match(`opp2-${i}`, `Opp2-${i}`, i % 3 === 0, 12 + i * 10, 52)),
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

const pureTrioVariant = COMBO_VARIANTS.find((v) => v.key === "combo_pure_trio");
const simulatorOnVariant = COMBO_VARIANTS.find((v) => v.key === "combo_simulator_on");

test("combo_pure_trio variant is defined and excludes every non-trio AblationModelKey", () => {
  assert.ok(pureTrioVariant, "combo_pure_trio must exist in COMBO_VARIANTS");
  const allKeys = new Set(MODEL_DEFS.map((m) => m.key));
  allKeys.add("marketOdds"); // valid AblationModelKey, not in MODEL_DEFS (see ablation.ts's own comment)
  const trioKeys = new Set(["surfaceElo", "serveReturn", "recentForm"]);
  for (const key of allKeys) {
    if (trioKeys.has(key)) {
      assert.ok(!pureTrioVariant!.excluded.has(key), `${key} is part of the intended trio and must NOT be excluded`);
    } else {
      assert.ok(pureTrioVariant!.excluded.has(key), `${key} must be excluded from the pure-trio variant`);
    }
  }
});

// IMPORTANT, verified-by-running finding (not assumed): `runPredictionEngine`'s
// `models.push({ modelName: "General Model", ... })` (index.ts) is UNCONDITIONAL -- ablating
// "generalEnsemble" only changes what VALUE `generalProbability` reports (it becomes the raw,
// uncalibrated trio blend instead of running it through calibration), it does NOT remove the
// "General Model" entry from `engine.models[]`. This is real, existing production methodology
// (predates this harness) and is explicitly out of scope to change here ("do not modify
// production Prediction Engine methodology"). The actual FINAL probability this ablation cares
// about is still genuinely trio-pure -- General's entry is redundant/uninformative, not a second
// independent vote -- but any consumer of `engine.models[]` (a human reading a report, or
// `perModelMetrics.ts`) must know to disregard a "General Model" entry whose value merely echoes
// the trio's own blend, rather than assume `engine.models.length === 3` for this variant.

test("combo_pure_trio selects exactly the intended three FEATURE models -- Segment Specialist never appears, and General's leftover entry contributes zero new information", async () => {
  const output = await runPredictionEngine(baseInput({ excludedModels: pureTrioVariant!.excluded }));
  const votingNames = output.engine.models.map((m) => m.modelName).sort();
  assert.deepEqual(votingNames, ["General Model", "Recent Form", "Serve & Return", "Surface Elo"], "General Model's entry persists (see comment above) -- Segment Specialist correctly never does");
  const general = output.engine.models.find((m) => m.modelName === "General Model")!;
  assert.equal(general.player1Probability, output.rawEnsembleProbability, "General's leftover value must be IDENTICAL to the trio's own raw blend -- proof it adds no new information beyond the trio when ablated, not a disguised 4th vote");
  assert.equal(general.weightUsed, 1, "with no specialist blended in, General's weightUsed is always 1 -- not itself evidence of independent influence");
});

test("Segment Specialist cannot accidentally enter the pure-trio variant even when a valid segment is present", async () => {
  // segment normally makes Specialist eligible to vote -- confirm the pure-trio exclusion set
  // still keeps it out even under conditions that would otherwise activate it. (General's
  // unconditional leftover entry is asserted separately above, not re-asserted here.)
  const output = await runPredictionEngine(
    baseInput({
      excludedModels: pureTrioVariant!.excluded,
      segment: { segmentKey: "ATP-Hard", label: "ATP Hard", meetsThreshold: true, historicalMatchCount: 500, validationSampleSize: 500, minHistoricalMatches: 0, minValidationSamples: 0, calibrationMapping: [{ x: 0.5, y: 0.5 }], weight: 0.7 },
    }),
  );
  const votingNames = output.engine.models.map((m) => m.modelName);
  assert.ok(!votingNames.some((n) => n.startsWith("Segment Specialist")), "Segment Specialist must not vote in the pure-trio variant, even when a qualifying segment is supplied");
  assert.equal(output.engine.specialistApplied, false, "specialistApplied must be false -- confirms the specialist did not enter blendedProbability either, not just that its display entry is absent");
  assert.equal(output.calibratedProbability, output.rawEnsembleProbability, "with generalEnsemble excluded and specialist forced off, the FINAL probability must equal the trio's own raw blend exactly -- the actual number this ablation measures is genuinely trio-pure");
});

test("resolveVariantSimulatorAdoption: baseline and every leave-one-out/other combo variant get null (Monte Carlo OFF), unchanged from before this existed", () => {
  const fakeResolved: SimulatorAdoptionInput = { adopted: true, weight: 0.25, sampleSize: 200, minSampleSize: 30, note: "test fixture" };
  for (const variant of COMBO_VARIANTS) {
    if (variant.key === "combo_simulator_on") continue;
    assert.equal(resolveVariantSimulatorAdoption(variant, fakeResolved), null, `${variant.key} must keep Monte Carlo off`);
  }
});

test("resolveVariantSimulatorAdoption: only combo_simulator_on receives the real resolved adoption value, never an invented one", () => {
  assert.ok(simulatorOnVariant, "combo_simulator_on must exist in COMBO_VARIANTS");
  const fakeResolved: SimulatorAdoptionInput = { adopted: true, weight: 0.4, sampleSize: 500, minSampleSize: 30, note: "the real resolveSimulatorAdoption() result" };
  const result = resolveVariantSimulatorAdoption(simulatorOnVariant!, fakeResolved);
  assert.equal(result, fakeResolved, "combo_simulator_on must receive exactly the resolved value passed in, not a copy with different numbers");
});

test("Monte Carlo ON vs OFF: same underlying model evidence, only the simulator component differs", async () => {
  const off = await runPredictionEngine(baseInput({ simulatorAdoption: null }));
  const on = await runPredictionEngine(baseInput({ simulatorAdoption: { adopted: true, weight: 0.3, sampleSize: 200, minSampleSize: 30, note: "test fixture" } }));

  // ON legitimately appends one extra "Monte Carlo Simulator" entry to `engine.models` when the
  // simulator actually votes -- that addition IS the isolated effect under test, not noise to
  // exclude. Every OTHER entry (every feature module's own vote, General, Specialist) must be
  // byte-identical, since nothing about the trio/General/Specialist inputs changed between calls.
  const onWithoutSimulator = on.engine.models.filter((m) => m.modelName !== "Monte Carlo Simulator");
  assert.deepEqual(off.engine.models, onWithoutSimulator, "every non-simulator model vote must be unaffected by the simulator toggle");
  assert.ok(on.engine.models.some((m) => m.modelName === "Monte Carlo Simulator"), "ON must add exactly one Monte Carlo Simulator entry that OFF does not have");
  assert.equal(off.rawEnsembleProbability, on.rawEnsembleProbability, "the raw ensemble probability (pre-simulator) must be identical -- the simulator toggle must not reach back and change the trio/General/Specialist blend itself");

  // The simulator itself, and only the simulator, is what should differ downstream of that point.
  assert.equal(off.engine.simulatorApplied, false);
  assert.equal(on.engine.simulatorApplied, true, "with adopted:true and a real weight, the simulator should actually blend in");
});
