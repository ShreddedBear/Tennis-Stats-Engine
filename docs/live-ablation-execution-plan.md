# LIVE ENSEMBLE ABLATION — EXECUTION PLAN (DO NOT RUN YET)

*P1 Package 4 follow-on. Prepared 2026-09-16. Planning only — no code, weights, calibration,
thresholds, or methodology were changed to produce this document, and nothing in it has been
executed. Execution is explicitly gated on Agent 7's temporal-integrity fixes landing and being
verified — see "Go/No-Go Gate" at the end.*

This plan answers the seven inspection questions first, then lays out the smallest DB-backed run
that can answer: current frozen ensemble vs. General/Specialist/Recent Form/Serve & Return/Surface
Elo removed, core-trio-only, Recent Form↔Serve & Return correlation, Monte Carlo marginal value,
and exact/near-50% behavior.

---

## 0. Inspection of existing historical prediction records

**1. Which table/dataset contains the usable predictions.**
`evaluation_predictions` (`lib/db/src/schema/evaluation.ts:110-224`) is the single ledger for both
out-of-sample backtest rows (`run_kind='historical_test'`) and live paper-trading rows
(`run_kind='paper_trade'`/`'live'`/`'paper_trade_shadow'`). It is append-only/immutable after
settlement (`status: pending → graded|void|missed`, never reverted). This is the dataset to use —
not `historical_matches` directly, which holds only match facts (no model output) and is the
*source* the walk-forward/ablation runner replays through the live engine, not a place predictions
are stored.

**2. Which fields contain each model's output.**
- `raw_probability` / `calibrated_probability` (`real`, player1-relative, 0-100) — the *final*
  pipeline output pre/post Phase-4 calibration, not per-module.
- `feature_snapshot` (`jsonb`) — the frozen `EngineBreakdown` at lock time. For `historical_test`
  rows this is a **reduced feature set** (per `services/evaluation/types.ts`); for
  `paper_trade`/`live`/`paper_trade_shadow` rows it is the **full** `EngineBreakdown`, including
  `engine.models[]` (one entry per voting module: `modelName`, `player1Probability`, `weightUsed`,
  `reliability`) and `engine.modelAgreement`. **Per-model outputs (Surface Elo/Serve &
  Return/Recent Form/Head-to-Head/General/Specialist/Market Consensus vote) are only present in
  rows whose `feature_snapshot.engine.models` array was populated** — confirmed by
  `analyzeCorrelatedCoreClusterOverconfidence.ts:33-38`, which already extracts exactly this path
  and by contract only trusts `run_kind IN ('historical_test','paper_trade','live')` with
  `status IN ('graded','void')`.
- `model_agreement`, `upset_risk_tier` — denormalized copies of `engine.modelAgreement` /
  `engine.upsetRiskBreakdown.upsetRisk`, queryable without parsing JSON (added specifically to
  avoid a full-table JSON scan for tier-level aggregates — evaluation.ts:206-216).
- Monte Carlo's own output (`simulation.player1WinProbability`) is **not a top-level column** and
  is only inside `feature_snapshot.engine` when the simulator actually voted
  (`simulatorApplied`/`afterSimulator` fields per `predictionEngine/index.ts:1198-1202`) — see
  §5 below, this is the field the harness currently never populates.

**3. Which fields contain the actual match outcome.**
`actual_winner_id` / `actual_winner_name` (set once at settlement), `predicted_winner_id` (the
engine's own pick), `status` (`graded` = has a real outcome; `void`/`missed` = no usable outcome),
`result_type` (`normal`/`retired`/`walkover`/`cancelled`), `included_in_accuracy` (boolean — the
authoritative "does this row count" flag, already excluding walkovers/cancellations and applying
the admin-configured retirement rule). **Always filter on `included_in_accuracy = true` and
`status = 'graded'`**, matching what `ablation.ts`'s own `eligible` filter and
`analyzeCorrelatedCoreClusterOverconfidence.ts:56-65` both already do.

**4. Whether prediction timestamps and cutoff timestamps are available.**
Yes, both are first-class columns: `scheduled_start_at` (match time) and `cutoff_at` (the hard
data boundary — nothing timestamped at/after this may appear in the pre-match feature snapshot)
and `locked_at` (when the row was actually written; for `historical_test` this is the walk-forward
run time, not the match date). `historical_matches` carries its own `cutoff_at` derived from
`cutoff_minutes` frozen at import time (`historicalMatches.ts:58-63`), which is what
`reconstructPlayerMatchHistory`/`buildEloHistoryIndex` key off when the ablation harness rebuilds
each match's pre-match state (`ablation.ts:194-199`).

**5. Whether the records are temporally valid for an out-of-sample analysis.**
Structurally yes — `matchFeatureSnapshotsTable` (`historicalMatches.ts:100-129`) stores
`existedBeforeCutoff`, computed once at write time as `sourceTimestamp < matchCutoffAt`, and "there
is no path that inserts a feature that fails its own check" (schema comment). However, this exact
question — whether temporal/cutoff integrity currently holds across the full corpus — is stated in
this task to be the subject of **Agent 7's pending fixes**. This plan does not assume the answer;
it is the explicit Go/No-Go gate below. Two known historical instances where temporal validity was
*not* automatic and had to be fixed are on record and worth re-checking after Agent 7's fixes land:
(a) fatigue's recency windows originally compared historical match dates against `Date.now()`
instead of each match's own `cutoffAt`, silently emptying every backtest fatigue window until a
2026-07-14 fix (`types.ts:114-121` comment; `asOfDate` param); (b) the cascade-exclusion filter
(`isKnownBadCascadeRow`, `calibration.ts`) is keyed on `locked_at`, not match date, specifically
because `historical_test` rows' `locked_at` reflects run time, not the underlying match's
chronology — a plausible class of bug this task's cutoff audit should re-check for other modules.

**6. The smallest representative sample that can answer the questions reliably.**
There is a **direct, real precedent already on record**: `docs/audit-matchloadrecovery-live-
revalidation.md` documents that a full-corpus ablation run (then ~18.2k matches, 12 variants)
takes **1.5–2 hours uninterrupted and repeatedly failed to finish** in this environment, and that a
**stratified sample of n=4,001** (via `buildRepresentativeSample`, proportional by surface ×
calendar year) was sized to "complete in one sitting" and produced a stable, trustworthy result
after one no-op-detection retry. This is the template to reuse, not a new sample-size derivation:
**start at n≈4,000–5,000** (see §Resource Estimate for why this package's broader variant set
argues for the upper end of that range) rather than a fresh full-corpus run or a multi-month replay
(explicitly ruled out by this task).

**7. Which existing ablation/evaluation scripts can be reused.**
- `services/evaluation/ablation.ts` (`runAblationAnalysis`) — already implements baseline +
  leave-one-out for `surfaceElo`, `serveReturn`, `recentForm`, `fatigue`, `availability`,
  `headToHead`, `matchLoadRecovery`, `generalEnsemble`, `segmentSpecialist`, plus a
  `combo_core_signals_only` variant (trio + market/general/specialist, fatigue/availability/H2H
  removed) — this is almost exactly the "core trio only" ablation requested, modulo General/
  Specialist/Market Consensus still being active in it (see §Ablations for the exact variant to
  add).
- `services/evaluation/ablationJob.ts` (`startAblationJob`/`getAblationJobStatus`) — runs
  `runAblationAnalysis` in-process (not a detached shell command, which would be killed), polled
  via `GET /api/evaluation/ablation/status`, writes `reports/model-ablation-analysis[-sampled].json`
  and `.md`. This is the correct execution vehicle — reuse as-is via
  `POST /api/evaluation/ablation/run` with `{ sampleSize: N }` in the request body
  (`RunAblationAnalysisBody`, `routes/evaluation.ts:2001-2010`).
- `scripts/analyzeCorrelatedCoreClusterOverconfidence.ts` — already implements exactly the
  Recent Form/Serve & Return/Surface Elo correlation + calibration-comparison test requested (it
  currently names the trio `CORE_TRIO = ["Surface Elo","Serve & Return","Recent Form"]`); reusable
  unmodified as a read-only query against whatever rows exist after the live ablation writes new
  `historical_test` rows, or against the existing `paper_trade`/`live` corpus in parallel — it does
  not depend on the ablation job's output at all, it reads `evaluation_predictions` directly.
- `services/evaluation/metrics.ts` (`computeSegmentMetrics`, `computeECE`) — the accuracy/logLoss/
  Brier/ECE primitives everything above already calls; reusable directly for the standalone
  per-model metrics that need new plumbing (see §Metrics).
- **Not reusable as-is**: Monte Carlo has no ablation lever today. `AblationModelKey`
  (`predictionEngine/types.ts:127-137`) has no `monteCarlo`/`simulator` entry, and
  `ablation.ts:scoreMatch` (line ~217) always passes `simulatorAdoption: null` to
  `runPredictionEngine` — meaning **the Monte Carlo simulator never votes in any existing ablation
  variant, baseline included**. Measuring its marginal value requires the harness extension in
  §Ablations item 4 below (a new variant, not a change to production `index.ts`/`simulator.ts`).

---

## 1. Dataset

| Item | Value |
|---|---|
| Source table | `evaluation_predictions`, filtered `run_kind IN ('historical_test','paper_trade','live')`, `status IN ('graded','void')` |
| Per-model detail source | `feature_snapshot.engine.models[]` (full `EngineBreakdown`) — only reliably present on `paper_trade`/`live` rows and on `historical_test` rows produced by a *fresh* ablation run (the reduced historical feature set may omit it — confirm during Step 1 of execution) |
| Ground truth | `actual_winner_id`, gated by `included_in_accuracy = true` |
| Underlying match facts | `historical_matches` (for the ablation replay's match-history/Elo reconstruction) — never queried for model output, only for re-deriving pre-match state |
| Preferred generation path | **Reuse the existing walk-forward/ablation replay against the already-imported `historical_matches` corpus** (no new data collection, no new provider calls) — this satisfies "prefer an existing committed historical prediction dataset over regenerating predictions" as closely as this system allows, since `evaluation_predictions.historical_test` rows are themselves generated by replaying the frozen, already-imported corpus rather than fetching anything new |
| Sample size | Stratified sample via `buildRepresentativeSample`, target **n ≈ 4,500** (surface × calendar-year proportional, deterministic evenly-spaced selection — not random, reproducible) |

---

## 2. Eligibility

Reuse `ablation.ts`'s existing eligibility filter verbatim (`allMatches.filter(m => !m.cancelled &&
m.winnerId)`, plus per-match `player1Matches.length > 0 && player2Matches.length > 0` after history
reconstruction) — do not loosen or tighten it for this run. Additionally, for every question in
this plan:

- **Standalone per-model metrics / correlation / 50% tests** additionally require
  `feature_snapshot.engine.models` to be a non-empty array (rows without a stored per-model
  breakdown are silently unusable for anything except the ensemble-level accuracy/Brier/logLoss
  numbers `ablation.ts` already computes).
- **Temporal validity precondition (blocking):** every row's `cutoffAt`/`lockedAt` ordering must
  pass Agent 7's fixed integrity check before being included — this plan assumes that check exists
  as a queryable flag or a rerunnable validator by the time execution starts; if Agent 7's fix
  ships as a data migration rather than a query-time filter, re-verify eligibility counts change
  before trusting them (a shrinking eligible set is expected and correct, not a bug in this plan).
- **50%-band tests** specifically also need `raw_probability` (pre-calibration) alongside
  `calibrated_probability`, both already stored — no extra fields needed.

---

## 3. Metrics

Per the prior static audit's Section 2 classification, reused here:

| Metric | Source | Notes for this run |
|---|---|---|
| Availability rate | `feature_snapshot.engine.models[].reliability` presence / each module's own `defaulted` flag (module-specific field, not uniformly named — confirm per module during Step 2) | Aggregate `% of sampled rows where module X's vote is present and non-defaulted` |
| Sample size (per model, per row) | Each module's own result type already carries this (`surfaceElo.sampleSizePlayer1/2`, `recentForm`'s `formScore().sample`, etc.) — present inside `feature_snapshot`, not top-level | Needs one small extraction script (new, ~50 lines), not new instrumentation |
| Accuracy / Brier / log loss (per model, standalone) | **New plumbing, no new math**: feed `engine.models[].player1Probability` (per `modelName`) through the exact same `computeSegmentMetrics`/`toPoint` logic in `metrics.ts`, once per module name, instead of the ensemble's `calibrated_probability` | This is the single piece of new code this plan requires outside the ablation harness itself |
| Calibration (reliability curve) per model | Same `calibration.ts` isotonic-fit machinery, re-pointed at a single module's probability column instead of the ensemble's | Reuses existing fit code; only the input column changes |
| Mean effective weight | `AVG(engine.models[].weightUsed)` per `modelName`, straight aggregation over the sampled rows — no new code | |
| Mean absolute contribution | `AVG(weightUsed * abs(player1Probability - 50))` per `modelName` — same data, one more derived column | |
| Correlation with other models | Extend `analyzeCorrelatedCoreClusterOverconfidence.ts`'s `favorsPlayer1`/pairwise-agreement logic from the trio-only `CORE_TRIO` set to all voting modules (Surface Elo, Serve & Return, Recent Form, Head-to-Head, Market Consensus when present) | Small generalization of an existing script, not new methodology |
| Marginal contribution | `runAblationAnalysis`'s `modelDeltas[].deltaPoints` — exactly this metric, already implemented | No new code |
| Disagreement frequency | `computeWeightedDisagreement`'s `modelAgreement` distribution + `analyzeCorrelatedCoreClusterOverconfidence.ts`'s trio-all-agree / pairwise rates, generalized the same way as correlation above | |

---

## 4. Ablations

Baseline + leave-one-out reuse `ablation.ts` unmodified for: **General removed**
(`generalEnsemble`), **Specialist removed** (`segmentSpecialist`), **Recent Form removed**
(`recentForm`), **Serve & Return removed** (`serveReturn`), **Surface Elo removed** (`surfaceElo`).
These five plus baseline are 6 of the 9 `LEAVE_ONE_OUT_VARIANTS` already defined
(`ablation.ts:31-41`) — no new variant code needed for this subset; the plan can simply run the
existing full leave-one-out set and report on this subset, since running all 9 costs nothing extra
once the harness is invoked.

**Core trio only**: `combo_core_signals_only` (`ablation.ts:63-67`) removes fatigue/availability/
headToHead, which leaves Surface Elo + Serve & Return + Recent Form + Market Consensus (when
present) + General + Specialist active — **not** a pure trio-only variant as the package's mandate
implies. A new combo variant is needed: `combo_pure_trio` = exclude
`{fatigue, availability, headToHead, generalEnsemble, segmentSpecialist, marketOdds}`, leaving only
`surfaceElo, serveReturn, recentForm` voting. This is a one-line addition to `COMBO_VARIANTS`
(`ablation.ts:60-75`), not a change to any scoring/weighting logic — flagged for pre-execution
implementation, not done now.

**Monte Carlo marginal value**: requires the harness extension noted in §0 item 7 — a new combo
pair, `combo_simulator_off` (current default: `simulatorAdoption: null`, i.e. today's baseline
already IS "simulator off") vs. a new `combo_simulator_on` that passes a real
`SimulatorAdoptionInput` (`adopted: true`, `weight` taken from whatever the live/paper-trade path
currently uses — check `simulatorAdoption` computation in the paper-trading loop, not invented) to
`runPredictionEngine` for every scored match. This is the only place this plan requires understanding
a *second* code path (wherever paper-trading currently computes `simulatorAdoption` before calling
the engine) well enough to reuse its exact weight-selection logic rather than guessing a number —
flagged as a pre-execution research task, not a methodology decision to make now.

| Variant | Reuses existing code? | New code needed |
|---|---|---|
| Baseline (frozen ensemble) | Yes | none |
| General removed | Yes | none |
| Specialist removed | Yes | none |
| Recent Form removed | Yes | none |
| Serve & Return removed | Yes | none |
| Surface Elo removed | Yes | none |
| Core trio only | Partial | one `COMBO_VARIANTS` entry |
| Monte Carlo on vs. off | No | one new combo pair + reuse of the paper-trading path's real `simulatorAdoption` weight |

---

## 5. Correlation Tests

Run `analyzeCorrelatedCoreClusterOverconfidence.ts` unmodified first, against the **existing**
`evaluation_predictions` corpus (no new run required for this part — it already queries
`historical_test`/`paper_trade`/`live` rows directly) to get an up-to-date version of the
2026-07(?) 1,031-row finding cited inline in `disagreement.ts:40-55` (trio pairwise agreement
74.2%, trio-only "Strong" log loss 0.715 vs. broad-agreement 0.692). This is free — it costs one
script invocation, no new predictions, and directly answers "is Recent Form ↔ Serve & Return
correlation still elevated on the current, larger corpus" from §8 of the prior static report.

Second, generalize its `favorsPlayer1`/pairwise-agreement helpers (already written, just scoped to
`CORE_TRIO`) to also report: Recent Form × Serve & Return pairwise agreement specifically (not just
the 3-way trio number), since that is the pair with the confirmed *field-level* shared-input
finding from the static report (`recentForm.ts`'s `serveReturnQualityRating()` reads the same
`servicePointsWonPct`/`returnPointsWon` fields `serveReturn.ts` uses, blended at 25% weight) — this
pair deserves its own correlation number distinct from the 3-way trio figure, which could mask a
strong 2-way correlation with a weaker 3-way one.

---

## 6. 50% Tests

Using the same sampled ablation run's baseline pass (no extra queries needed — `ablation.ts`
already stores every scored match's `dataQuality`/`predictedWinnerId`/outcome in
`baselineRecords`):

1. **Exact/near-50% histogram**: bucket `calibratedProbability` (and separately `rawProbability`
   for pre-calibration) at ==50.0, 49–51, 48–52, 47–53, 46–54, 45–55, in the baseline variant only
   — this is a pure aggregation over already-computed baseline rows, no new scoring.
2. **Equal-strength matches**: cross-tab the near-50% band against `dataQuality` (already computed
   per row) — the static report's hypothesis is that thin/zero-history matches over-populate this
   band; this test directly checks it by comparing 45-55% band membership rate at high vs. low
   `dataQuality` (reuse the existing `DQ_HIGH_THRESHOLD = 65` split `ablation.ts` already applies).
3. **Strong model disagreement**: cross-tab the near-50% band against `modelAgreement` (already
   computed and stored per row) — checks whether 50%-band rows are disproportionately
   `HighDisagreement`/trio-split rows vs. genuine consensus-on-a-close-match rows.
4. **Player reversal (swap symmetry)**: not answerable from stored historical rows alone (each
   historical match only has one player-order). Requires a small, explicitly-scoped **extra**
   scoring pass: for a subset of the sampled matches (suggest n=200, not the full 4,500 — this is
   a symmetry spot-check, not a corpus-wide metric), re-run `runPredictionEngine` with player1/
   player2 swapped and confirm `calibratedProbability_swapped ≈ 100 - calibratedProbability_original`.
   This reuses `runPredictionEngine` directly (already the case for `swapInvariance.test.ts`, which
   exists as a unit test) rather than the ablation harness — cite/extend that existing test's
   fixtures rather than writing new swap logic from scratch.
5. **Missing model / unavailable Specialist**: already directly measurable from the `generalEnsemble
   removed`/`segmentSpecialist removed` ablation variants' own baseline-vs-ablated near-50%-band
   population counts (no extra step — a byproduct of §4's leave-one-out runs).
6. **Calibration**: compare the near-50% band's population under `rawProbability` vs.
   `calibratedProbability` on the same rows — directly answers whether calibration is *creating*
   the band or merely relabeling a band that was already there pre-calibration (this is exactly the
   distinction the static report's §6.4 could not resolve without live data).
7. **Fallback values / rounding**: tag each baseline row with whether any module's `defaulted`
   flag fired (zero-history fallback) and separately compute the near-50% band's rounding-adjacency
   (rows within ±0.05 of a `Math.round(x*10)/10` boundary at any of the seven pipeline stages named
   in the static report §6.3) — this needs the per-stage intermediate values already captured in
   `decision_trace` (`index.ts:1124+`, e.g. `afterReliabilityDiscount`, `afterSimulator`), which
   the plan confirms are stored per-row and do not need new instrumentation.

---

## 7. Resource Estimate

- **Compute**: in-process background job inside the already-running API server
  (`ablationJob.ts`), no separate infrastructure. Full corpus (~18.6k matches × 12+ variants) is
  documented to take 1.5–2 hours and has repeatedly failed to complete uninterrupted
  (`docs/audit-matchloadrecovery-live-revalidation.md`). At n≈4,500 (roughly 1.1× the n=4,001
  precedent, to cover 2 more combo variants than that prior run had), expect proportionally
  **~25-35 minutes** for the full variant set (baseline + 9 leave-one-out + up to 5 combo variants
  including the 2 new ones from §4), based on linear scaling off the cited precedent's timing class
  (the precedent doc doesn't give an exact n=4,001 wall-clock time, so this is an estimate to
  validate empirically at execution time, not a committed figure).
- **New code required before execution** (explicitly NOT written by this plan): one `COMBO_VARIANTS`
  entry (`combo_pure_trio`), one new simulator-on/off combo pair plus locating the real
  `simulatorAdoption` weight computation to reuse, and one small standalone script for per-model
  standalone accuracy/Brier/logLoss/calibration (reusing `metrics.ts`/`calibration.ts` primitives).
  Total estimated new code: **under 150 lines across 2-3 files**, all additive to the
  evaluation/diagnostic layer, none touching `predictionEngine/index.ts`'s live-path logic.
- **Storage**: reuses `reports/model-ablation-analysis[-sampled].json`/`.md` output path already
  established by `ablationJob.ts` — no new storage design needed.
- **Risk to production**: none — `ablationJob.ts` runs read replays through `runPredictionEngine`
  with `excludedModels`/ablation-only inputs that "never change live prediction behavior" per its
  own doc comment (`types.ts:105-112`), and writes only to the standalone `reports/` directory, not
  to `evaluation_predictions` or any live-serving table.

---

## 8. Exact Execution Steps (for when the gate below clears)

1. Confirm Agent 7's temporal-integrity fix has landed and re-run its own verification (not
   assumed here — this plan does not know its exact scope).
2. Spot-check 20-30 recent `paper_trade`/`live` rows to confirm `feature_snapshot.engine.models[]`
   is populated with the expected module set post-fix (cheap, read-only query; catches a schema/
   snapshot regression before committing to a full sampled run).
3. Implement the three small additions from §Resource Estimate (`combo_pure_trio`,
   simulator-on/off combo pair, standalone per-model metrics script) as isolated, reviewed changes
   to `services/evaluation/` — not to `predictionEngine/index.ts`'s production logic.
4. `POST /api/evaluation/ablation/run` with `{ sampleSize: 4500 }`; poll
   `GET /api/evaluation/ablation/status` until `state: "done"`.
5. Run `analyzeCorrelatedCoreClusterOverconfidence.ts` (as-is) plus its extended pairwise variant
   from §Correlation Tests, against the current `evaluation_predictions` corpus (independent of
   step 4, can run in parallel).
6. Run the swap-symmetry spot-check (§6 item 4) on 200 matches from the same sample.
7. Assemble results into a single follow-up report (structured the same way as the completed
   static report) with real numbers replacing every "needs a live DB run" item from
   `docs/ensemble-influence-and-50-percent-root-cause-report.md`'s §8.
8. **Do not** change any weight, prior, threshold, or calibration constant based on this run's
   results without a separate, explicit go-ahead — this package's mandate remains measurement, not
   optimization.

---

## Go/No-Go Gate

This plan is **not authorized to execute** until:
1. Agent 7's temporal-integrity fixes are implemented, and
2. Their own verification confirms the fix, and
3. Someone with authority over this package explicitly says to proceed.

No live ablation, no sampled run, no new predictions, and no code changes described in this plan
have been made. This document is planning output only.
