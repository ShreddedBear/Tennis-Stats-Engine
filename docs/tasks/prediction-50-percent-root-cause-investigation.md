# Full Root-Cause Investigation — Prediction Engines Collapsing to ~50%

## Objective
Investigate why prediction engines are producing final win probabilities clustered around 50% across many matches. This is forensic debugging, not a request to arbitrarily adjust probabilities.

## Rules
- Do not assume the cause.
- Do not immediately change calibration.
- Do not add arbitrary probability boosts or hard-code probabilities.
- Do not use market odds or market sentiment.
- Preserve genuinely 50/50 matches.
- Do not declare fixed until the root cause is demonstrated with runtime/repository evidence and tests.

## Trace the complete pipeline
`INPUT MATCH → player identity resolution → player IDs → historical data → surface → rankings/Elo → serve/return → recent form → H2H/other modules → feature construction → normalization → weighting → ensemble → Monte Carlo → calibration → persistence → API/UI`

Find the **first point where meaningful player-vs-player signal is lost**.

## Investigation

1. Trace at least 20 real recent predictions across ATP/WTA/Challenger/ITF if supported, surfaces, close matches, and data-rich matches. Capture player IDs, surface, data quality, every module output, raw ensemble, pre/post-calibration probability, Monte Carlo probability, final probability, winner, confidence, upset risk, and model agreement.
2. Audit null/undefined/NaN/Infinity/zero/default/fallback features, failed joins, empty history, date filters, surface/tour mismatches. Produce `FEATURE | POPULATED % | NULL % | ZERO % | DEFAULT/FALLBACK % | SAMPLE VALUES`.
3. Audit player identity resolution, including name variants, whitespace, accents, initials, hyphens, duplicates, ATP/WTA IDs, and historical joins.
4. Audit global/surface Elo, historical cutoff, chronological ordering, opponent Elo, missing-opponent fallbacks, and whether both players are assigned the same/default Elo. Report Elo A/B/difference.
5. Audit Serve/Return inputs and verify they are actually differentiated between players rather than league-average/zero fallbacks.
6. Audit Recent Form retrieval, date window, surface filter, opponent adjustment, and actual performance values.
7. Audit ensemble math: weights, signs, cancellation, normalization, difference handling, zero weights, and global neutral fallbacks. Search the entire repo for behavior equivalent to `return 0.5`, `probability = 0.5`, `fallback = 0.5`, and shrinkage/clamping toward 0.5.
8. Audit calibration independently: `RAW → CALIBRATION INPUT → CALIBRATED`. Check constant input, rounding, wrong model/version, double calibration, excessive shrinkage, decimal/percentage errors, and isotonic/logistic implementation. Do not change it until proven causal.
9. Audit Monte Carlo to ensure it receives differentiated player inputs and does not independently collapse outputs toward 50%.
10. Trace frontend → API → prediction service → DB → response → UI. Check rounding, types, serialization, caching, stale records, duplicate records, active summary versions, and overwrites.
11. Compare all prediction engines on the same 20+ matches: `MATCH | ENGINE | RAW OUTPUT | CALIBRATED OUTPUT | FINAL OUTPUT`.
12. Audit Data Quality gates and determine whether low quality forces neutral predictions. Find why data is missing rather than simply lowering thresholds.
13. Audit correlated-module protection to ensure anti-double-counting has not zeroed or neutralized legitimate signal.
14. Use git history to identify the last known-good state and, where practical, bisect the regression affecting prediction/ensemble/calibration/Elo/serve-return/form/Monte Carlo/data quality/player resolution/persistence.

## Required root-cause report BEFORE production changes

Return:
1. Root cause
2. Evidence
3. Exact affected files
4. Exact functions
5. Exact lines
6. Current behavior
7. Expected behavior
8. Before/after pipeline values
9. Failure category: data, logic, calibration, Monte Carlo, database, or UI
10. Regression commit if identifiable
11. Confidence in root-cause finding
12. Recommended fix

## Required regression test

Create a test that reproduces the collapse and fails before the fix. It must test actual data-flow/math, not merely `probability !== 0.5`. Verify materially different inputs produce materially different raw predictions, player-swap symmetry, missing-data fallbacks preserve available signal, calibration preserves differentiation, Monte Carlo preserves differentiation, and persistence preserves the calculated probability.

## Implementation

After documenting the root cause and adding the reproducing test, implement the smallest correct fix if safe and consistent with the intended methodology. Run relevant tests and report exact files changed, corrected behavior, test results, before/after sample predictions, and confirmation that no market odds/sentiment were introduced.

**Most important: find the first point where real player-vs-player information is being lost. Do not treat the 50% symptom.**