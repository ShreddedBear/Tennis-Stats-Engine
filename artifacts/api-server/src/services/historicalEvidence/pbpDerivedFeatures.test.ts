import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computePbpDerivedFeatures } from "./pbpDerivedFeatures.js";

describe("computePbpDerivedFeatures", () => {
  it("computes pbpPointsPerGame from a valid reconstruction", () => {
    const features = computePbpDerivedFeatures({ valid: true, sets: [[6, 4], [6, 3]], winner: 0, points: 140, games: 19 });
    assert.strictEqual(features.length, 1);
    assert.strictEqual(features[0].featureName, "pbpPointsPerGame");
    assert.ok(Math.abs(features[0].featureValue - 140 / 19) < 1e-9);
  });

  it("returns empty (never a fabricated 0) for an invalid reconstruction", () => {
    const features = computePbpDerivedFeatures({ valid: false, reason: "ILLEGAL_GAME" });
    assert.deepStrictEqual(features, []);
  });

  it("returns empty when points/games are missing even if valid=true", () => {
    const features = computePbpDerivedFeatures({ valid: true });
    assert.deepStrictEqual(features, []);
  });

  it("returns empty when games is 0 (guards divide-by-zero)", () => {
    const features = computePbpDerivedFeatures({ valid: true, points: 0, games: 0 });
    assert.deepStrictEqual(features, []);
  });
});
