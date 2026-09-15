# Cross-engine boundary: Prediction Engine / Parlay Builder / Truth Engine

Three engines, one application, deliberately kept independent:

```
Truth Engine (tennis-truth-engine-8ecc1270)
    | one-way evidence sync (raw PBP data only -- never verdicts/decisions)
    v
Shared PBP evidence (wta_main_pbp_evidence table, this repo)
    |
    +--> Prediction Engine (services/predictionEngine/) -- independent model/scoring logic
    |
    +--> Parlay Builder (services/parlayBuilder/) -- independent validation/decision logic
```

Shared **data** (raw match results, raw point-by-point evidence) is permitted between engines.
Shared **decision/model logic** (a trained rating, a fitted calibration curve, a probability,
a confidence score) is not. `checkParlayBoundary.ts` enforces the Prediction Engine / Parlay
Builder half of this mechanically; there is no equivalent automated check yet for the Truth
Engine side (it lives in a separate repository) -- see that repo's own
`docs/audit-wta-main-historical-pbp.md` and `docs/WTA_MAIN_HISTORICAL_PBP_ATTRIBUTION.md`.

## Incidents this file documents

### 1. Surface Elo / Serve-Return rating (found and fixed)

`builderScoringService.ts` called Prediction Engine's `computeSurfaceEloModule` and
`computeServeReturnModule` directly for two of its highest-weighted factors (~29.5% of total
scoring weight combined). Fixed by giving Parlay Builder its own, genuinely differently-
designed implementations: `parlaySurfaceRating.ts` (naive single-sided Elo, no opponent
lookup/recency/level tuning) and `parlayServeReturnRating.ts` (set-margin proxy with a bounded
tanh transform instead of Prediction Engine's linear clamp).

### 2. Calibration (found and fixed)

`builderScoringService.ts` separately read Prediction Engine's live-trained probability-
calibration curve via `evaluation/calibrationCache.ts` -> `evaluation/calibration.ts` ->
`calibration_models` table, and applied it to reshape Parlay Builder's own `validationScore`
into the `builderCalibratedProbability` that drives its final pick. This was **worse** than
incident #1: it shaped the final decision, not just one input factor, and the original
`checkParlayBoundary.ts` didn't catch it because `evaluation/calibration.ts` doesn't live
under `services/predictionEngine/`.

Fixed with a genuinely independent Builder-owned calibration system:
- `parlay_calibration_models` table (`lib/db/src/schema/parlayCalibration.ts`) -- fit
  exclusively from `parlay_leg_outcomes`, Parlay Builder's own graded-leg ledger (tens of
  thousands of backfilled rows already existed at the time of the fix -- see
  `auditParlayFactorWeights.ts`'s n=39,000 comment -- comfortably clearing the >=150-row
  minimum `fitParlayCalibration` requires before it will fit anything at all).
- `parlayCalibrationFit.ts` -- empirical win-rate binning with a simple forward monotonic
  clamp. Deliberately not isotonic regression (PAVA) or Platt scaling (Prediction Engine's two
  methods) -- a real, differently-implemented, non-renamed algorithm.
- `parlayCalibrationCache.ts` -- reads only `parlay_calibration_models`.
- `refitParlayCalibration.ts` -- refits from `parlay_leg_outcomes`, versioned (new row,
  previous deactivated), same pattern as Prediction Engine's own refit job but touching only
  Parlay Builder's own table.
- `checkParlayBoundary.ts` extended to catch this whole class going forward (evaluation/
  calibration imports, the calibration function names, `calibrationModelsTable`, and the
  reverse direction), plus a standalone cross-file test
  (`crossEngineCalibrationIndependence.test.ts`) proving Parlay Builder's calibrated output
  for a given score cannot be moved by any Prediction Engine calibration mapping.

## Rule going forward

If Parlay Builder needs a calculation Prediction Engine already has (a rating, a probability,
a calibration, anything derived rather than raw), it needs its **own** independent
implementation from permitted raw evidence -- never a call into Prediction Engine's function,
and never a value read from a Prediction-Engine-owned or Prediction-Engine-fed table, however
indirectly. When in doubt: shared *data* input is fine; shared *derived output* is not.
