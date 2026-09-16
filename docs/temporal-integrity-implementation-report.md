# TEMPORAL INTEGRITY & LEAKAGE — IMPLEMENTATION REPORT

Follow-up to `docs/temporal-integrity-leakage-report.md` (the audit). Scope: fix the three
confirmed defects and resolve the calibration-window risk, without touching model weights,
ensemble methodology, calibration methodology, thresholds, or any other production prediction
behavior. All changes are in `Tennis-Stats-Engine` only — the truth-engine repo's findings were
all VERIFIED SAFE and needed no fix.

**Scope note on Defects 2 and 3:** tracing revealed these are not "propagate a dropped variable"
bugs. `runPredictionEngine` has no parameter for weights/gates/thresholds at all —
`ENSEMBLE_WEIGHT_PRIOR` is a hardcoded constant in `dataQuality.ts`, and the `eliteDQFloor`/
`tieBand`/`confidenceFloor`/etc. fields a `StrategySpec` carries don't correspond to anything the
engine reads. Building real per-candidate scoring would mean adding override plumbing through
`ensemble.ts` and wiring up threshold/gate checks that don't exist yet — on files that also serve
live predictions. That is ensemble redesign, explicitly out of scope. I flagged this mid-task and
the user chose **honest-labeling**: make the evaluation machinery stop claiming a validation that
never happened, rather than build new engine surface area to make the claim true.

---

## 1. Findings Addressed

### Defect 1 — Availability used wall-clock time instead of the historical asOfDate

**Finding:** `predictionEngine/index.ts:390` called `computeAvailabilityModule(...,  new Date(), ...)`
instead of forwarding `input.asOfDate`, while the sibling Fatigue/MatchLoadRecovery calls on the
same two lines correctly used `input.asOfDate`.

**Root Cause:** The 2026-07-14 "Fatigue asOfDate fix" (see `types.ts`'s doc comment) was applied to
Fatigue and MatchLoadRecovery but never extended to Availability, which computes the same shape of
feature (rest-days, recent-walkover/retirement recency windows) the same way. Availability's edge
feeds the ensemble as a weighted vote (`index.ts:459`), so this was not cosmetic: a historically-
scored match's Availability signal — and therefore its final probability — silently depended on
what real-world day the evaluation happened to run on, violating reproducibility.

Tracing every caller of `runPredictionEngine` also found four more call sites that reconstruct
match history bounded to a historical `cutoffAt` but never set `asOfDate` at all (so it defaulted
to `new Date()` for Fatigue/MatchLoadRecovery too, in these files, independent of the Availability
bug): `services/evaluation/ablation.ts`, `scripts/regenerateLedgerPredictions.ts`,
`scripts/backtestLedgerJuly8_9.ts`, and `scripts/eloOpponentResolutionRebuild.ts` (two call sites).
The live path (`predictionSnapshot.ts`) correctly omits `asOfDate` — for a live call, "now" is the
right default and this is unchanged.

**Change:**
- `predictionEngine/index.ts:390` — `input.asOfDate ?? new Date()` instead of `new Date()`.
- `predictionEngine/types.ts` — updated the `asOfDate` doc comment to name Availability alongside
  Fatigue/MatchLoadRecovery.
- `services/evaluation/ablation.ts`, `scripts/regenerateLedgerPredictions.ts`,
  `scripts/backtestLedgerJuly8_9.ts`, `scripts/eloOpponentResolutionRebuild.ts` — added
  `asOfDate: match.cutoffAt` / `asOfDate: cutoffAt` to their `runPredictionEngine` calls, matching
  the pattern already used correctly in `historicalScoring.ts` and `auditMarketConsensusAblation.ts`.

**Test:** Added to `predictionEngine/index.test.ts`:
- *"Availability measures recency against the provided historical asOfDate, not the real current
  time"* — a match dated exactly 3 days before a fixed 2024 `asOfDate` must show
  `daysSinceLastMatch === 3` regardless of what day the test suite actually runs on. Under the old
  `new Date()` behavior this would be however many days have elapsed since 2024 (hundreds), so the
  assertion is a genuine regression guard, not just a smoke test.
- *"Availability with no asOfDate defaults to the real current time (live-path behavior,
  unchanged)"* — proves the live path's behavior is byte-identical before and after the fix.

**Result:** Both new tests pass. Full curated suite `pnpm test:predictionEngine`: **212/213 pass**
(the 1 failure is `opponentStrength.test.ts`, which crashes at module-import time on
`DATABASE_URL must be set` — confirmed pre-existing and unrelated by diffing against the
unmodified file; it fails identically with or without this change).

---

### Defect 2 — Optimizer candidates shared one holdout-metrics snapshot

**Finding:** `candidateOptimizer.ts`'s `runOptimizerRun` performs exactly one walk-forward
evaluation and one pooled calibration fit, then generates up to 13 structurally distinct
`StrategySpec` candidates and writes the **same** `snapshotCalibration`-derived numbers onto every
one's `holdoutMetrics`, without ever scoring a candidate's own weights/gates/thresholds.

**Root Cause:** No mechanism exists in `runPredictionEngine` to apply a `StrategySpec`'s
weights/gates/thresholds during scoring (see scope note above) — so there was never a way for
`runOptimizerRun` to produce a candidate-specific number even if it tried. Separately confirmed:
no other code path in the repository (routes, jobs, or the alternate `sprintStage2Candidates.ts`
generator) ever writes `accuracy`/`overallAccuracy`/`candidateAccuracy`/`logLoss`/`brier` onto a
`runOptimizerRun`-generated row, so `optimizerSummary.ts`'s accuracy-based ranking
(`bestNewStrategy`, `bestByCategory.*`, `largestAccuracyImprovement`, etc.) currently returns "no
pick" (null) for these candidates rather than a false "best" — the identical-numbers risk the
audit flagged is real but latent, not yet actively producing a wrong ranking today. Given the
user's direction, this is fixed by making it structurally impossible to become active, not just
noting that it hasn't yet.

**Change:**
- `candidateOptimizer.ts` — `holdoutMetrics` now carries `candidateSpecificallyScored: false` and
  `metricsSource: "shared-walk-forward-run"`, with a comment explaining that every candidate in the
  batch shares this exact object and none of these numbers reflect the candidate's own strategySpec.
- `optimizerSummary.ts`'s `readMetric` — added a guard: `if (metrics["candidateSpecificallyScored"]
  === false) return null;`. This single change closes every read site at once (`toPickFromCandidate`,
  `bestBy`, the improvement-delta loop, `strategiesTested`) — none of them will ever again treat a
  disclosed-shared metric as real performance data, present or future. Rows without the flag
  (older/manually-entered data) are unaffected.

**Test:** Not independently added. `readMetric` is a private helper in a module whose top-level
imports pull in `@workspace/db`, so any test importing it hits the same
`DATABASE_URL must be set` crash as every other `services/evaluation/*.test.ts` file in this
sandbox — verified this is a pre-existing, module-wide constraint, not something introduced here
(see Remaining Work). The `holdoutMetrics` write itself is a static object literal with no branching
logic to regress. I verified the guard by direct code reading and by tracing every one of
`readMetric`'s call sites (listed above) to confirm each one flows through the single guarded
function.

**Result:** No candidate generated by `runOptimizerRun` from here on can be read by
`optimizerSummary.ts` as having independently-measured performance. `validationStatus`,
`acceptanceChecks`, and `acceptanceChecksPassed` were left untouched — they check generation
quality (fold count, diversity, novelty, retest quota, duplicate rate), a distinct and honestly-named
concept that was never claiming predictive performance in the first place.

---

### Defect 3 — Backtest candidate configuration never reached the scorer

**Finding:** `backtestService.ts`'s `runEvaluationBacktest` loaded a candidate's `proposedConfig`
into `effectiveConfig`, logged an info line noting it was present, and then called
`scoreHistoricalMatch(match, scoringContext)` with no reference to `effectiveConfig` anywhere else.
Every candidate backtest silently scored with the production engine's default configuration.

**Root Cause:** Same engineering gap as Defect 2 — `scoreHistoricalMatch`/`runPredictionEngine`
have no parameter to receive a candidate's strategySpec at all. There was no dropped wire to
reconnect.

**Change (honest-labeling, per user direction):**
- `backtestService.ts` now computes `candidateConfigRequestedButNotApplied` up front. When true, it
  (a) logs at `warn` instead of a quiet `info` line, (b) pushes an explicit, specific message into
  the run's own `errors` array (which downgrades `finalStatus` from `"completed"` to
  `"completed-with-warnings"` through the existing status logic — no new status plumbing needed),
  and (c) sets `metrics.candidateConfigApplied: false` (vs. `null` when no candidate config was
  requested at all, e.g. a plain evaluation-mode backtest). A candidate backtest can no longer look
  identical to a real, validated candidate-specific run in its own persisted record.
- Added `BacktestTestHooks.candidateConfigForTest` (mirrors the existing `matchesForTest` /
  `getCancellationStatus` DI pattern) so this logic is unit-testable without a live candidate row.

**Test:** New file `backtestService.candidateConfigHonesty.test.ts`, two tests:
- *"marks candidateConfigApplied:false and downgrades to completed-with-warnings when a
  candidateConfigId is supplied"* — asserts both the `metrics` field and the status downgrade.
- *"leaves candidateConfigApplied null and reports a clean 'completed' status ... with no
  candidateConfigId"* — proves the disclosure never fires for a plain evaluation-mode run (no
  false positives).

**Result:** Written and read for correctness, but **could not be executed in this sandbox** —
`backtestService.ts` imports `@workspace/db` at module load time, which throws
`DATABASE_URL must be set` before any test body runs. This is identical to the pre-existing
`backtestCancellation.test.ts` in the same module, confirmed to fail the same way, unmodified, for
the same reason — not a regression introduced here. Both tests will run in any environment with a
configured database (see Remaining Work).

---

### Calibration-Window Risk — traced, confirmed, fixed

**Instruction:** trace first; only fix if an actual overlap is confirmed.

**Trace:** `walkForward.ts`'s pooled calibration fit (`runWalkForwardEvaluation`, training mode)
restricts its validation corpus to points from `[now() − CALIBRATION_WINDOW_MONTHS, now()]`
(`CALIBRATION_WINDOW_MONTHS = 24`, computed at fit time and stored as the model's `fittedAt`).
`backtestService.ts` reads whichever `calibration_models` row is `active` and applies its mapping
uniformly to every match in the **user-requested** date range, with no check on whether that range
overlaps the active model's own fitting window. `calibration_models.validationDateRangeStart/End`
exist in the schema but are populated from the walk-forward run's *entire unrestricted corpus*
(`allMatches`, which can span back to 2010), not the actual 24-month fit window — so those two
columns could not have been used for an accurate overlap check even if `backtestService.ts` had
read them.

**Confirmed overlap, not theoretical:** a walk-forward fold's chronological chunk is split in half
(first half = validation/fit, second half = test/held-out). The ad-hoc backtest does not
distinguish between these — it includes every match in the requested range in its accuracy
computation. Any backtest date range less than 24 months old (i.e. almost every realistic "how did
we do recently" use case) therefore includes matches whose validation-half data contributed to
fitting the exact calibration curve now being applied to score them. This is genuine in-sample
calibration contamination, confirmed by tracing the actual window arithmetic in both files, not an
unproven theoretical risk.

**Fix (minimum required boundary problem — disclosure, not exclusion):** Following the same
honest-labeling approach as Defects 2/3 (and because changing which rows count toward accuracy
would be a larger behavioral change than "fix only the minimum boundary problem" calls for),
`backtestService.ts` now:
- Computes the true fit window directly from `activeCalibration.fittedAt − CALIBRATION_WINDOW_MONTHS`
  (imported from `walkForward.ts` rather than re-declared, so the two can never drift), and checks
  it against the requested date range.
- When they overlap: logs a `warn`, pushes an explicit `errors` entry naming the fitted date and
  recommending either a date range entirely before the calibration window, or `shadowReplay.ts`'s
  point-in-time calibration reconstruction for an in-sample-free comparison, and sets
  `metrics.calibrationWindowOverlap: true` (`false` when no overlap).
- Added `BacktestTestHooks.activeCalibrationForTest` for the same DI/testability reason as Defect 3.
- Explicitly did **not** touch `applyCalibrationOriented`, the isotonic/platt fitting logic, or which
  calibration model is "active" — the methodology is unchanged; only the previously-silent boundary
  violation is now surfaced.

**Test:** Covered by the same `backtestService.candidateConfigHonesty.test.ts` file's
infrastructure conceptually, but a dedicated overlap test was not added given the same DB-import
blocker documented above applies identically — writing it would not have added executable coverage
in this sandbox. The arithmetic was verified by direct trace against `walkForward.ts:492-493`'s own
window computation, and the check reuses the exact same constant (`CALIBRATION_WINDOW_MONTHS`,
imported not duplicated) so the two can never silently drift out of sync.

**Classification: CONFIRMED OVERLAP → FIXED (disclosure).**

---

## 2. Files Changed

| File | Why |
|---|---|
| `artifacts/api-server/src/services/predictionEngine/index.ts` | Defect 1 core fix: Availability now receives `input.asOfDate` |
| `artifacts/api-server/src/services/predictionEngine/types.ts` | Doc comment updated to name Availability alongside Fatigue/MatchLoadRecovery |
| `artifacts/api-server/src/services/predictionEngine/index.test.ts` | Two new regression tests for Defect 1 |
| `artifacts/api-server/src/services/evaluation/ablation.ts` | Sibling asOfDate gap (historical diagnostic replay) |
| `artifacts/api-server/src/scripts/regenerateLedgerPredictions.ts` | Sibling asOfDate gap (reusable no-look-ahead regeneration script) |
| `artifacts/api-server/src/scripts/backtestLedgerJuly8_9.ts` | Sibling asOfDate gap (one-time no-look-ahead backtest script) |
| `artifacts/api-server/src/scripts/eloOpponentResolutionRebuild.ts` | Sibling asOfDate gap, two call sites (one-time diagnostic rebuild) |
| `artifacts/api-server/src/services/evaluation/candidateOptimizer.ts` | Defect 2: honest `holdoutMetrics` disclosure fields |
| `artifacts/api-server/src/services/evaluation/optimizerSummary.ts` | Defect 2: `readMetric` guard closes all ranking read-sites at once |
| `artifacts/api-server/src/services/evaluation/backtestService.ts` | Defect 3 + calibration-window fix: explicit disclosure, test DI hooks |
| `artifacts/api-server/src/services/evaluation/backtestService.candidateConfigHonesty.test.ts` | New: Defect 3 regression tests |

No file outside `Tennis-Stats-Engine` was touched. No file belonging to another package's
in-flight work was modified — `git status` was checked before every edit; the only overlap with
another agent's territory is `walkForward.ts`, which was only **imported from** (`CALIBRATION_WINDOW_MONTHS`), never edited.

---

## 3. Tests

| Suite | Result |
|---|---|
| `predictionEngine/index.test.ts` (new + existing, run directly) | 22/22 pass |
| `pnpm --filter api-server run test:predictionEngine` (curated, 16 files) | 212/213 pass — 1 pre-existing DB-import failure (`opponentStrength.test.ts`), confirmed unrelated |
| `pnpm --filter api-server run test:evaluation` (curated, 14 files) | 13/24 pass — 11 fail on the same pre-existing `DATABASE_URL must be set` module-import crash across the whole `services/evaluation/` directory, present before this change |
| `backtestService.candidateConfigHonesty.test.ts` (new) | Not executable in this sandbox (same DB-import crash); read for correctness, will run against a configured database |
| `npx tsc -p tsconfig.json --noEmit` | Zero new errors: diffed the full error list against the unmodified baseline and confirmed every error touching an edited file is a pre-existing `lib/db` build-output (TS6305) or implicit-any cascade, at lines outside every diff hunk |

---

## 4. Temporal Integrity Result

**Yes — historical scoring is now reproducible using the correct asOfDate.** Availability no longer
reads wall-clock time during a historical evaluation; it, Fatigue, and MatchLoadRecovery are now
consistently threaded with `asOfDate` across every caller that reconstructs match history bounded
to a historical cutoff (`historicalScoring.ts`, `ablation.ts`, `auditMarketConsensusAblation.ts`,
and the three `scripts/` one-off replays). Re-scoring the same historical match on two different
real-world days, with no new data inserted, now produces identical Availability output — verified
by a test that would have failed under the pre-fix behavior.

## 5. Optimizer Result

**Not yet independently scored — and now honestly labeled as such.** Each candidate does *not* yet
receive independently generated evaluation metrics; the engine has no mechanism to apply a
candidate's own weights/gates/thresholds (see the scope note). What changed: every candidate's
`holdoutMetrics` now explicitly discloses `candidateSpecificallyScored: false`, and
`optimizerSummary.ts` can no longer read a disclosed-shared metric as if it were a real,
differentiating measurement. The dashboard will show "not yet measured" rather than a false "best
candidate," which is the honest floor the user asked for. Building real per-candidate scoring is a
separate, larger, ensemble-adjacent task (see Remaining Work).

## 6. Backtest Result

**Not yet applied — and now loudly disclosed when requested.** A candidate's configuration still
does not reach `scoreHistoricalMatch`/`runPredictionEngine` (same root cause as the optimizer
result). What changed: a backtest run that was asked to use a candidate config now marks
`metrics.candidateConfigApplied: false`, pushes an explicit warning into its own `errors` record,
and is downgraded from `"completed"` to `"completed-with-warnings"` — it can no longer be mistaken
for a validated, candidate-specific result by a human or by downstream code reading the run.

## 7. Calibration Result

**Confirmed Risk — Fixed (disclosure).** Traced the full lifecycle: calibration is fit from a
rolling `[fittedAt − 24 months, fittedAt]` window (`walkForward.ts`), and `backtestService.ts`
applied that same active model uniformly to any requested date range with no overlap check. Since
roughly half of any 24-month-old-or-newer period's matches contributed to fitting that curve, this
was a real, confirmed in-sample contamination risk for the common case of backtesting a recent
period — not theoretical. Fixed by computing the true fit window from the model's own `fittedAt`
and `CALIBRATION_WINDOW_MONTHS` (imported, not duplicated) and disclosing
`metrics.calibrationWindowOverlap` plus a specific, actionable `errors` entry when it fires. The
fitting/evaluation methodology itself (`applyCalibrationOriented`, `fitBestCalibration`, which model
is `active`) was not touched.

## 8. Production Methodology

Confirmed: **no model weights, ensemble methodology, calibration methodology, thresholds, or
prediction methodology were changed.** Every edit either (a) threads an existing, already-designed
`asOfDate` parameter to a module that was missing it (Defect 1), or (b) adds disclosure fields and
log/status changes to evaluation-machinery bookkeeping that live predictions never read (Defects
2/3, calibration risk). `ensemble.ts`, `eliteTier.ts`, `recommendation.ts`, `classificationPolicy.ts`,
`dataQuality.ts` (source of `ENSEMBLE_WEIGHT_PRIOR`), and every specialist/serve-return/recent-
form/surface-Elo module were not opened for editing. `applyCalibrationOriented` and
`fitBestCalibration` were not touched. Live prediction behavior (`predictionSnapshot.ts`'s call
path) is unaffected: it never sets `asOfDate`, `candidateConfigId`, or a backtest date range, so
none of these changes have any code path into it.

## 9. Remaining Work

- **Real per-candidate/per-backtest scoring** (making Defects 2 and 3's underlying claim literally
  true, not just honestly labeled false) requires building weight/gate/threshold override plumbing
  through `runPredictionEngine`'s ensemble — this is ensemble-adjacent work this package was
  explicitly told not to do, and needs its own scoped decision (see the three options I raised
  mid-task; the user chose to defer building it, not to rule it out permanently).
- **Live database access** would let every test in `services/evaluation/` and
  `services/predictionEngine/opponentStrength.test.ts` actually execute rather than fail at
  module-import time — none of the tests added or verified logically in this task depend on
  anything beyond a working `DATABASE_URL`; there is no additional code work implied here, only an
  environment gap in this sandbox.
- **No 3-month walk-forward, no optimizer sweep, no weight tuning, no new audit package** was
  started, per the stop condition.
