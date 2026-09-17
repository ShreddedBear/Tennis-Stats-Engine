# LIVE ABLATION HARNESS — IMPLEMENTATION REPORT

*P1 Package 4 follow-on. Implemented 2026-09-17. This report documents evaluation-layer harness
additions only. No production Prediction Engine methodology, weight, prior, threshold, or
calibration was changed. No database connection was made or attempted. No live ablation, replay,
optimizer sweep, or historical-prediction regeneration was run.*

---

## 1. What was added

Three evaluation-only harness pieces, exactly as scoped:

1. **`combo_pure_trio`** — a new `COMBO_VARIANTS` entry in `ablation.ts` that excludes every
   `AblationModelKey` except Surface Elo, Serve & Return, and Recent Form (Fatigue, Availability,
   Match Load Recovery, Head-to-Head, Market Consensus, General, Specialist all named explicitly
   and defensively).
2. **Monte Carlo ON/OFF isolation** — a new `combo_simulator_on` variant plus a small,
   dependency-injected mechanism (`useResolvedSimulatorAdoption` on `Variant`,
   `resolveVariantSimulatorAdoption()`) that lets the ablation harness pass the REAL, measured
   simulator adoption (via the existing `resolveSimulatorAdoption()` — the exact function the
   live/paper-trading path already uses) into one variant's replay, while every other variant
   (including baseline) keeps passing `null`, unchanged from before this existed.
3. **Standalone per-model metrics** (`perModelMetrics.ts`) — a new, DB-free module computing
   accuracy/Brier/log loss/calibration error/sample size for Surface Elo, Serve & Return, Recent
   Form, General Model, and Segment Specialist individually from already-stored
   `EvaluationPredictionRow[]`, with an explicit three-state availability classification
   (`unavailable` / `available_excluded` / `active`) so an unavailable model is never scored as a
   50% prediction and never counted as incorrect.

Plus one small supporting piece not separately requested but needed by item 3's "50% analysis"
requirement: **`near50Bands.ts`**, a pure classifier for exact-50%/49-51%/48-52%/47-53% band
membership, reusable by any future report or script rather than each one reimplementing the
boundary logic.

## 2. Exact files changed

| File | Type | Lines |
|---|---|---|
| `artifacts/api-server/src/services/evaluation/ablation.ts` | Modified | +67 / −5 |
| `artifacts/api-server/src/services/evaluation/perModelMetrics.ts` | New | 216 |
| `artifacts/api-server/src/services/evaluation/near50Bands.ts` | New | 58 |
| `artifacts/api-server/src/services/evaluation/perModelMetrics.test.ts` | New | 115 |
| `artifacts/api-server/src/services/evaluation/near50Bands.test.ts` | New | 55 |
| `artifacts/api-server/src/services/evaluation/ablation.pureTrioAndSimulator.test.ts` | New | 155 |
| `docs/live-ablation-harness-implementation-report.md` | New | this file |

`ablation.ts`'s modifications, precisely:
- New import: `SimulatorAdoptionInput` (type), `resolveSimulatorAdoption` (from
  `./simulatorValidation`, already existed for the live path).
- `Variant` interface: exported (was file-private), gained one new optional field
  (`useResolvedSimulatorAdoption?: boolean`).
- New exported pure function `resolveVariantSimulatorAdoption(variant, resolvedAdoption)`.
- `COMBO_VARIANTS`: exported (was file-private); two new entries appended
  (`combo_pure_trio`, `combo_simulator_on`).
- `scoreMatch()`: gained one new parameter, `simulatorAdoption: SimulatorAdoptionInput | null =
  null` — defaults to `null`, so every existing call site that doesn't pass it keeps today's exact
  behavior.
- `runAblationAnalysis()`: one new line resolving `resolvedSimulatorAdoption` once via
  `resolveSimulatorAdoption()` (a real DB call, but one that already existed on the live path and
  is only reached when this function actually runs against a real database — not reached by
  anything in this implementation pass); the `runVariant` loop's `scoreMatch` call now passes
  `resolveVariantSimulatorAdoption(variant, resolvedSimulatorAdoption)` instead of relying on the
  old implicit `null`.

No other line in `predictionEngine/`, `dataQuality.ts`, `calibration.ts`, or `ensemble.ts` was
touched.

## 3. Why each change is evaluation-only

- **`combo_pure_trio` / `combo_simulator_on`** are entries in a `Variant[]` array read exclusively
  by `runAblationAnalysis`, a diagnostic replay function. They control which already-existing,
  already-supported inputs (`excludedModels`, `simulatorAdoption`) get passed into
  `runPredictionEngine` for a single diagnostic call — both inputs were designed for exactly this
  purpose (`excludedModels`'s own doc comment: "Omit/undefined in every real (non-ablation) call
  -- this never changes live prediction behavior"; `simulatorAdoption` is the same parameter the
  live/paper-trading path already populates with a real value). No new input type, no new
  ensemble/calibration code path, and no live/paper-trading call site was touched — a live
  prediction never sets `excludedModels`, and the live path already calls
  `resolveSimulatorAdoption()` on its own, unaffected by this change.
- **`resolveVariantSimulatorAdoption`** is a pure function operating only on `ablation.ts`'s own
  `Variant` type and a `SimulatorAdoptionInput` value — it makes no adoption decision itself
  (rejected an earlier design that would have let a variant carry an arbitrary invented weight;
  this version can only route the ONE real value `resolveSimulatorAdoption()` already computed,
  never fabricate a different one).
- **`perModelMetrics.ts`** takes `EvaluationPredictionRow[]` as a parameter and performs no
  database I/O, no write, and no mutation of any stored row. It reads `feature_snapshot.engine`
  and `feature_snapshot.moduleWeights` — fields already persisted for exactly this kind of
  after-the-fact analysis (see `LiveFeatureSnapshot.moduleWeights`'s own doc comment: "Enables
  direct SQL queries over module contributions... without manually reconstructing the path through
  engine.models blobs"). It reuses `logLoss`/`brierScore` (`calibration.ts`) and `computeECE`
  (`metrics.ts`) rather than reimplementing their math.
- **`near50Bands.ts`** classifies a number the caller already has; it does not read from or write
  to any table, model, or config.

## 4. Tests performed

All tests are `node:test` files run directly via `tsx --test`, no test runner config changes. None
connect to a real database (see §6 for the one caveat on this).

1. `near50Bands.test.ts` — 9 tests: exact-50 boundary, all four band boundaries (inclusive), the
   player-swap symmetry property, and `tallyNear50Bands`'s handling of `null`/`undefined`/`NaN`
   input (must not count them, must not fabricate a default).
2. `perModelMetrics.test.ts` — 10 tests: Specialist's three-way classification
   (no-segment → unavailable; segment-but-didn't-apply → available_excluded; applied → active),
   General's conservative absent → unavailable rule, Surface Elo's `moduleWeights`-based
   ablation-exclusion detection and its fallback path for rows predating `moduleWeights`, and two
   end-to-end `computePerModelMetrics` tests confirming (a) unavailable/excluded rows never enter
   the accuracy/Brier/logLoss computation and are never treated as incorrect or as 50%, and (b) a
   hand-computed Brier-score check against a known correct/incorrect pair.
3. `ablation.pureTrioAndSimulator.test.ts` — 6 tests, calling `runPredictionEngine` directly (no
   `runAblationAnalysis`, no historical corpus, no database query) with the exact `excludedModels`/
   `simulatorAdoption` values the real variants use:
   - `combo_pure_trio` is defined and its `excluded` set contains every non-trio
     `AblationModelKey`.
   - Running the engine with that exclusion set actually produces the intended trio-only
     *probability* (see §6's Finding 1 for the one real nuance this surfaced).
   - Segment Specialist cannot enter even when a qualifying segment is supplied, and
     `specialistApplied`/`calibratedProbability` confirm it didn't affect the actual blend, not
     just its display entry.
   - `resolveVariantSimulatorAdoption` returns `null` for every variant except
     `combo_simulator_on`, and returns exactly the passed-in resolved value (never a different
     number) for that one variant.
   - Monte Carlo ON vs. OFF: every non-simulator model vote and the raw ensemble probability are
     identical between the two runs; only the simulator's own entry/effect differs.

## 5. Test results

| Suite | Result |
|---|---|
| `near50Bands.test.ts` | 9/9 pass |
| `perModelMetrics.test.ts` | 10/10 pass |
| `ablation.pureTrioAndSimulator.test.ts` | 6/6 pass |
| Full existing `predictionEngine` regression suite (17 files, 233 tests) re-run for safety | 232/233 pass — the 1 failure (`opponentStrength.test.ts`) is a whole-file `DATABASE_URL` module-load failure, confirmed present identically on unmodified `main` before any of this work (re-verified via `git stash`); unrelated to and untouched by this change |
| `tsc -p tsconfig.json --noEmit`, scoped to every file this task touched | 0 errors, after building `lib/db`'s project reference once (`npx tsc --build lib/db`) — the same pre-existing `TS6305` cascade this unbuilt reference causes shows up identically on unmodified `main` for `ablation.ts`'s own pre-existing line; confirmed via `git stash` before attributing it |

**Finding surfaced by test 2 above, worth flagging on its own** (not a defect in this
implementation, a real, verified fact about existing production code): `runPredictionEngine`
(`predictionEngine/index.ts`) unconditionally pushes a `"General Model"` entry onto
`engine.models[]` — ablating `generalEnsemble` only changes what *value* `generalProbability`
reports (it becomes the raw trio blend instead of a calibrated one), it does not remove the entry
itself. Segment Specialist has no equivalent issue — it is correctly absent whenever
`segmentSpecialist` is excluded. This means `combo_pure_trio`'s `engine.models[]` will always show
4 entries (trio + a redundant "General Model" whose `player1Probability` exactly echoes the trio's
own raw blend — verified equal in the test), not 3. The **actual number this variant measures**
(`calibratedProbability`) is confirmed genuinely trio-pure regardless (also verified equal to
`rawEnsembleProbability` in the test) — this is a display/diagnostic-array quirk, not a
contamination of the metric. Documented in code (`ablation.ts`'s `combo_pure_trio` comment) and
here so a future report-writer or `perModelMetrics.ts` caller doesn't misread `engine.models.length`
for this specific variant. This is existing production methodology, unconditional and unrelated to
this task's changes, and was left untouched per "do not modify production Prediction Engine
methodology."

## 6. Anything that remains blocked by database availability

- **`resolveSimulatorAdoption()`** (called once inside `runAblationAnalysis`) queries
  `evaluation_predictions`/`predictions` — this cannot be exercised in this sandbox (no
  `DATABASE_URL`, confirmed absent again before this work). It was not called anywhere in this
  implementation pass; `runAblationAnalysis` itself was never invoked.
- **`runAblationAnalysis`/`runPredictionEngine` against the real historical corpus** — untouched
  and unexecuted, per the explicit "do not run the live ablation" instruction. The three new
  pieces were validated by calling `runPredictionEngine` directly with synthetic fixtures (no
  corpus, no DB), which exercises the exact same engine code path a real ablation run would use,
  without needing the corpus itself.
- **The one new test file that imports `ablation.ts`** (`ablation.pureTrioAndSimulator.test.ts`)
  needed a placeholder `DATABASE_URL` (an unreachable connection string,
  `postgres://user:pass@localhost:5432/placeholder_no_connection_made`) to satisfy
  `@workspace/db`'s module-load-time guard (`if (!process.env.DATABASE_URL) throw`), because
  `ablation.ts` imports `db` as a real (non-type) value at its top, purely to run
  `db.select()...` elsewhere in the file that this test never reaches. `new Pool()` is lazy — no
  network connection was ever opened, confirmed by the test passing with a connection string that
  points nowhere reachable. This is the same technique (and the same pre-existing coupling) used
  and disclosed during Step 2's verification of Agent 7's fix; it is not new to this task and not
  a real database connection.
- **`perModelMetrics.ts`/`near50Bands.ts` tests** needed no `DATABASE_URL` at all — both files
  only `import type` from `@workspace/db`, which is erased at compile time.
- **Held-out `segment = 'test'` population's actual size/date range** — still unknown, as reported
  previously; nothing in this implementation pass queried it or could have.

## 7. Confirmation that production Prediction Engine methodology is unchanged

- `ensemble.ts`, `dataQuality.ts` (`ENSEMBLE_WEIGHT_PRIOR`, `MODULE_IMPORTANCE`,
  `EXCLUDED_FROM_ENSEMBLE`), and `calibration.ts` do not appear in any diff produced by this task.
- `predictionEngine/index.ts` was not modified. The one behavioral nuance this task's tests
  *discovered* (§5's "General Model" leftover entry) was found by testing existing, already-shipped
  code — nothing about it was introduced or altered here.
- `simulator.ts` and `simulatorValidation.ts` were not modified; `resolveSimulatorAdoption` is
  called by the new harness code exactly as-is, with zero changes to its own logic.
- The live prediction path (`predictionSnapshot.ts`, the paper-trading loop) does not call
  anything added in this task and was not touched.
- No weight, prior, threshold, or calibration constant changed anywhere in this diff.

---

*Stopping here per the task's instruction. The live ablation has not been executed. No further
phase should begin automatically from this report.*
