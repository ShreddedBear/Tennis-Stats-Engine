/**
 * Boundary check tests (Task #111).
 *
 * Verifies that checkParlayBoundary.ts:
 *   1. Passes cleanly on the actual codebase (no violations exist today).
 *   2. Catches a deliberate predictionEngine import injected for the test.
 *   3. Catches a deliberate DB table reference injected for the test.
 *
 * These tests write and immediately delete a temporary file inside
 * src/services/parlayBuilder/ for case 2 & 3 — cleanup runs in t.after()
 * so it is guaranteed even on assertion failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// api-server package root: src/scripts/ → src/ → api-server/ (2 levels up)
const API_SERVER_DIR = join(__dirname, "../..");
// tsx binary is in the api-server's own node_modules (not workspace root)
const TSX_BIN        = join(API_SERVER_DIR, "node_modules/.bin/tsx");
const PARLAY_DIR     = join(__dirname, "../services/parlayBuilder");
const PREDICTION_ENGINE_DIR = join(__dirname, "../services/predictionEngine");

function runCheck(): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX_BIN, ["src/scripts/checkParlayBoundary.ts"], {
      cwd: API_SERVER_DIR,
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("checkParlayBoundary: clean codebase passes with exit code 0", () => {
  const { ok, stdout } = runCheck();
  assert.equal(ok, true, `Expected boundary check to pass on the clean codebase. stdout: ${stdout}`);
  assert.ok(stdout.includes("✓"), "Expected ✓ in output for a clean check");
});

test("checkParlayBoundary: catches a deliberate predictionEngine import (Task #111 regression guard)", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_import.ts");
  writeFileSync(
    violatingFile,
    `// Deliberate violation for testing\nimport { computeRecommendation } from "../predictionEngine/recommendation";\n`,
  );
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when a predictionEngine import is present");
  const combined = stdout + stderr;
  assert.ok(
    combined.includes("predictionEngine") || combined.includes("violation"),
    `Expected output to mention the violation. Got: ${combined.slice(0, 400)}`,
  );
});

test("checkParlayBoundary: catches a deliberate evaluationPredictionsTable reference (Task #111 regression guard)", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_table.ts");
  writeFileSync(
    violatingFile,
    `// Deliberate table reference violation\nconst t = evaluationPredictionsTable.runKind;\n`,
  );
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when evaluationPredictionsTable is referenced");
});

// ---------------------------------------------------------------------------
// Calibration-leak regression guards (docs/CROSS_ENGINE_BOUNDARY.md).
//
// builderScoringService.ts read Prediction Engine's live-trained calibration via
// evaluation/calibration.ts and evaluation/calibrationCache.ts -- neither file lives under
// predictionEngine/, so the original checker (predictionEngine-import + 5 table names only)
// missed it entirely. These tests prove the extended checker now catches that whole class,
// by every route named in the incident: the calibrationModelsTable symbol, an import of
// either evaluation/calibration file, and a direct call to a Prediction Engine calibration
// function.
// ---------------------------------------------------------------------------

test("checkParlayBoundary: catches a deliberate calibrationModelsTable reference", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_calibration_table.ts");
  writeFileSync(violatingFile, `// Deliberate violation for testing\nconst t = calibrationModelsTable.active;\n`);
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when calibrationModelsTable is referenced");
  assert.ok((stdout + stderr).includes("calibrationModelsTable"));
});

test("checkParlayBoundary: catches a deliberate import from evaluation/calibrationCache.ts", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_calibration_cache_import.ts");
  writeFileSync(violatingFile, `// Deliberate violation for testing\nimport { getActiveCalibration } from "../evaluation/calibrationCache";\n`);
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when evaluation/calibrationCache is imported");
  assert.ok((stdout + stderr).includes("calibrationCache"));
});

test("checkParlayBoundary: catches a deliberate import from evaluation/calibration.ts", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_calibration_import.ts");
  writeFileSync(violatingFile, `// Deliberate violation for testing\nimport { applyCalibrationOriented } from "../evaluation/calibration";\n`);
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when evaluation/calibration is imported");
  assert.ok((stdout + stderr).includes("evaluation/calibration"));
});

test("checkParlayBoundary: catches a deliberate call to Prediction Engine's getActiveCalibration() even without a matching import line (defense in depth)", (t) => {
  const violatingFile = join(PARLAY_DIR, "_boundary_test_violation_calibration_call.ts");
  writeFileSync(violatingFile, `// Deliberate violation for testing -- simulates a re-exported/aliased import\nasync function x() { return getActiveCalibration(); }\n`);
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail on a call to getActiveCalibration()");
  assert.ok((stdout + stderr).includes("getActiveCalibration"));
});

test("checkParlayBoundary: catches a deliberate reverse-direction import (predictionEngine -> parlayBuilder)", (t) => {
  const violatingFile = join(PREDICTION_ENGINE_DIR, "_boundary_test_violation_reverse_import.ts");
  writeFileSync(violatingFile, `// Deliberate violation for testing\nimport { computeParlaySurfaceRating } from "../parlayBuilder/parlaySurfaceRating";\n`);
  t.after(() => { if (existsSync(violatingFile)) unlinkSync(violatingFile); });

  const { ok, stdout, stderr } = runCheck();
  assert.equal(ok, false, "Expected boundary check to fail when predictionEngine imports from parlayBuilder");
  assert.ok((stdout + stderr).includes("parlayBuilder"));
});
