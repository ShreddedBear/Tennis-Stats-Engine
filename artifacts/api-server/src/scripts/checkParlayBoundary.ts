#!/usr/bin/env tsx
/**
 * checkParlayBoundary.ts — Task #111 (extended after the calibration-leak incident, see
 * docs/CROSS_ENGINE_BOUNDARY.md)
 *
 * Enforces the architectural separation between the Parlay Builder and the
 * Prediction Engine. The Parlay Builder (src/services/parlayBuilder/) must NEVER
 * import from the Prediction Engine (src/services/predictionEngine/) or reference
 * its DB tables (evaluation_predictions, calibration_models, saved_cards,
 * evaluation_runs).  This prevents the "independent validation" guarantee from
 * being silently broken by future edits, including AI-assisted ones.
 *
 * Also checks the reverse direction (Prediction Engine importing from Parlay
 * Builder) and, specifically, every indirect route into Prediction Engine's
 * calibration system via evaluation/ -- the class of leak that slipped past the
 * original (import-from-predictionEngine-only) version of this check entirely,
 * because calibration.ts/calibrationCache.ts live in services/evaluation/, not
 * services/predictionEngine/.
 *
 * Usage:
 *   pnpm exec tsx src/scripts/checkParlayBoundary.ts
 *
 * Exit code 0 = clean, exit code 1 = violations found.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PARLAY_DIR = join(__dirname, "../services/parlayBuilder");
const PREDICTION_ENGINE_DIR = join(__dirname, "../services/predictionEngine");

// Patterns that must NOT appear in non-comment, non-test lines inside parlayBuilder/.
// Each entry is [pattern, humanReadableReason].
const FORBIDDEN_IN_PARLAY: Array<[RegExp, string]> = [
  [/from\s+['"].*predictionEngine['"]/,          "import from predictionEngine/"],
  [/from\s+['"].*\/predictionEngine\//,          "import from predictionEngine/"],
  [/require\(['"].*predictionEngine['"]\)/,       "require() from predictionEngine/"],
  [/evaluationPredictionsTable/,                 "direct reference to evaluationPredictionsTable"],
  [/calibrationModelsTable/,                     "direct reference to Prediction Engine's calibrationModelsTable"],
  [/historicalMatchesTable/,                     "direct reference to historicalMatchesTable"],
  [/savedCardsTable/,                            "direct reference to savedCardsTable"],
  [/evaluationRunsTable/,                        "direct reference to evaluationRunsTable"],
  // Calibration-leak incident (docs/CROSS_ENGINE_BOUNDARY.md): builderScoringService.ts read
  // Prediction Engine's live-trained calibration via evaluation/calibration.ts and
  // evaluation/calibrationCache.ts -- neither file lives under predictionEngine/, so none of
  // the patterns above caught it. Parlay Builder has its own calibration system
  // (parlayCalibrationFit.ts / parlayCalibrationCache.ts / parlay_calibration_models) --
  // it must never import evaluation/'s calibration files or call Prediction Engine's
  // calibration functions by name, however they're imported.
  [/from\s+['"].*\/evaluation\/calibration['"]/,      "import from evaluation/calibration.ts (Prediction Engine's calibration fitting/apply) -- use parlayCalibrationFit.ts instead"],
  [/from\s+['"].*\/evaluation\/calibrationCache['"]/, "import from evaluation/calibrationCache.ts (Prediction Engine's active-model cache) -- use parlayCalibrationCache.ts instead"],
  [/\bapplyCalibrationOriented\s*\(/,            "call to Prediction Engine's applyCalibrationOriented() -- use applyParlayCalibration() instead"],
  [/\bfitIsotonicCalibration\b/,                 "reference to Prediction Engine's fitIsotonicCalibration"],
  [/\bfitPlattScaling\b/,                        "reference to Prediction Engine's fitPlattScaling"],
  [/\bfitBestCalibration\b/,                      "reference to Prediction Engine's fitBestCalibration"],
  [/\bgetActiveCalibration\s*\(/,                "call to Prediction Engine's getActiveCalibration() -- use getActiveParlayCalibration() instead"],
];

// Patterns that must NOT appear in non-comment, non-test lines inside predictionEngine/ --
// the reverse direction. Prediction Engine must remain usable (and correct) with zero
// knowledge of Parlay Builder's existence.
const FORBIDDEN_IN_PREDICTION_ENGINE: Array<[RegExp, string]> = [
  [/from\s+['"].*parlayBuilder['"]/,          "import from parlayBuilder/"],
  [/from\s+['"].*\/parlayBuilder\//,          "import from parlayBuilder/"],
  [/require\(['"].*parlayBuilder['"]\)/,       "require() from parlayBuilder/"],
  [/parlayCalibrationModelsTable/,            "reference to Parlay Builder's parlay_calibration_models table"],
];

function getAllTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...getAllTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function scan(dir: string, forbidden: Array<[RegExp, string]>): string[] {
  const found: string[] = [];
  for (const file of getAllTsFiles(dir)) {
    const rel = relative(process.cwd(), file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      // Skip pure comment lines (single-line // or block * comments)
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      // Skip strings that mention the forbidden term only as a doc reference inside a comment
      const commentStart = line.indexOf("//");
      const codePart = commentStart >= 0 ? line.slice(0, commentStart) : line;

      for (const [pattern, reason] of forbidden) {
        if (pattern.test(codePart)) {
          found.push(`  ${rel}:${i + 1}  (${reason})\n    ${line.trim()}`);
        }
      }
    }
  }
  return found;
}

const violations: string[] = [
  ...scan(PARLAY_DIR, FORBIDDEN_IN_PARLAY),
  ...scan(PREDICTION_ENGINE_DIR, FORBIDDEN_IN_PREDICTION_ENGINE),
];

if (violations.length > 0) {
  console.error("❌  Cross-engine boundary violations:");
  console.error(violations.join("\n\n"));
  console.error(`\n${violations.length} violation(s) detected. Fix before committing.`);
  process.exit(1);
}

console.log("✓  Parlay Builder / Prediction Engine boundary is clean — no cross-imports, forbidden table references, or Prediction Engine calibration usage found in either direction.");
process.exit(0);
