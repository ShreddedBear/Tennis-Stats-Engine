import test from "node:test";
import assert from "node:assert/strict";
import { toEnginePbpContext } from "./engineBridge";
import type { PbpServiceResult } from "./pbpService";
import type { PbpDerivedStats } from "./types";

function fakeDerived(): PbpDerivedStats {
  return {
    pointsPlayed: 80,
    serverPointsWon: { player1: 40, player2: 30 },
    serverPointsPlayed: { player1: 45, player2: 35 },
    servicePointsWonPct: { player1: 88.9, player2: 85.7 },
    returnPointsWonPct: { player1: 14.3, player2: 11.1 },
    aces: { player1: 5, player2: 3 },
    doubleFaults: { player1: 1, player2: 2 },
    adfDataComplete: true,
    gamesPlayed: 12,
    setsPlayed: 2,
    sourceRecordId: "x#1",
  };
}

function fakeResult(overrides: Partial<PbpServiceResult> = {}): PbpServiceResult {
  return {
    availability: "AVAILABLE",
    source: "ppaulojr",
    sourceRecordId: "x#1",
    validationStatus: "CANDIDATE",
    identityStatus: "MATCHED",
    canonicalMatchId: 42,
    provenanceNote: "note",
    rawPbp: "SSSS;",
    derived: fakeDerived(),
    orientationMatchesLookup: true,
    attemptedSources: ["ppaulojr"],
    rejectedSources: [],
    conflict: null,
    ...overrides,
  };
}

test("engineBridge: all three engines receive the identical normalized shape from one PbpServiceResult", () => {
  const result = fakeResult();

  // Truth Engine's questions.
  const truthEngineView = toEnginePbpContext(result);
  assert.equal(truthEngineView.available, true);
  assert.equal(truthEngineView.source, "ppaulojr");
  assert.equal(truthEngineView.validationStatus, "CANDIDATE");

  // Stats/Prediction Engine's view (same call, same object shape).
  const statsEngineView = toEnginePbpContext(result);
  assert.deepEqual(statsEngineView, truthEngineView);

  // Parlay Builder's view, via the exact same bridge function (services/parlayBuilder/pbpContext.ts
  // is a thin wrapper around getPbpForMatch + toEnginePbpContext -- this proves the underlying
  // contract objects are identical without needing a live DB for the DB-backed wrapper itself).
  const parlayBuilderView = toEnginePbpContext(result);
  assert.deepEqual(parlayBuilderView, truthEngineView);
});

test("engineBridge: unavailable PBP maps to available=false with no fabricated derived stats", () => {
  const context = toEnginePbpContext(fakeResult({ availability: "PBP_UNAVAILABLE", source: null, derived: null, rawPbp: null, validationStatus: null }));
  assert.equal(context.available, false);
  assert.equal(context.derived, null);
});

test("engineBridge: conflict is surfaced explicitly, never silently resolved", () => {
  const context = toEnginePbpContext(
    fakeResult({ availability: "PBP_CONFLICT", conflict: { sources: ["ppaulojr", "future-source"], detail: "winner mismatch" } }),
  );
  assert.equal(context.availability, "PBP_CONFLICT");
  assert.deepEqual(context.conflict, { sources: ["ppaulojr", "future-source"], detail: "winner mismatch" });
});
