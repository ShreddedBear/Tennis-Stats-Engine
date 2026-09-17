# Surface-sample double-counting -- root cause, minimal fix, and evidence

## Root cause

`LOW_SURFACE_SAMPLE_DISCOUNT` (0.75, `dataQuality.ts`) was applied as a FOURTH, independent
post-calibration shrink toward 50% on top of THREE mechanisms that already fully account for the
same surface-sample-size signal (`surfaceElo.sampleSizePlayer1`/`sampleSizePlayer2`):

1. **Surface Elo's own internal shrink.** `surfaceElo.ts`'s `eloWinProbabilityPlayer1 = 50 +
   (rawEloWinProbabilityPlayer1*100 - 50) * (reliability/100)` pulls Surface Elo's OWN vote
   toward 50 in direct proportion to `reliability`, which is
   `confidenceFromEffectiveSampleSize(effectiveSampleSize)` -- a function of exactly the same
   surface-match-count signal. Surface Elo is the only module in the ensemble with this internal,
   sample-size-driven probability shrink (confirmed: `grep "reliability / 100"` across
   `predictionEngine/*.ts` matches only `surfaceElo.ts`).
2. **Ensemble voting weight.** That same low `reliability` also reduces Surface Elo's ensemble
   voting weight (`ensemble.ts`'s `buildEnsemble`: `rawWeights = Math.max(1, reliability) *
   weightPrior`), diluting the already-shrunk vote a second time.
3. **Data Quality blend.** That same low `reliability`, at `MODULE_IMPORTANCE.surfaceElo = 1.3`
   (the highest importance of any module), drags down the overall Data Quality score, which
   lowers `calibrateProbability`'s `confidenceFactor` and shrinks the fallback-calibration
   probability toward 50 a second time (fallback-calibration path only).

`LOW_SURFACE_SAMPLE_DISCOUNT`, introduced in a LATER commit than (1) and the sample-depth label it
keys off (see below), added a fourth shrink on top, keyed to a cruder raw-count label
(`computeSurfaceSampleDepth`) rather than Surface Elo's own effective/decayed sample size. Its own
doc in `dataQuality.ts` already said as much: "this isn't a validated accuracy gap on its own
baseline, just added noise-sensitivity on top of already-thin data that `calibrateProbability`'s
Data Quality curve only partly captures."

## Git-history evidence (full, unshallowed history)

```
a234fcf  2026-07-13 08:15:03  Task 45 -- introduces computeSurfaceSampleDepth
afafc29  2026-07-13 09:21:33  Enhance surface-specific ELO calculation -- introduces
                               confidenceFromEffectiveSampleSize / eloWinProbabilityPlayer1's
                               reliability-proportional shrink
648b915  2026-07-14 23:45:41  Task #151 -- introduces BOTH TOUR_RELIABILITY_DISCOUNT AND
                               LOW_SURFACE_SAMPLE_DISCOUNT together, a day after (1) and (2)
                               above already existed
```

`LOW_SURFACE_SAMPLE_DISCOUNT` was layered on top of an already-complete signal path, not designed
alongside it.

## Why `TOUR_RELIABILITY_DISCOUNT` (ATP x0.63) is NOT touched

Introduced in the same commit (648b915) but targets a completely different, independently
validated signal: a real, tour-level accuracy gap (54.6% ATP vs 57.3% pool baseline,
2026-07-13 ablation report, n=1,242) with **no other representation anywhere in this pipeline** --
confirmed by repo-wide search: tour identity ("ATP") otherwise only appears in `segments.ts`'s
specialist-segment resolution, a separate, already-gated mechanism (`specialistApplied`). Removing
it was never proposed and the dependency analysis found no basis to.

## The fix

`predictionEngine/index.ts`'s `surfaceSampleDiscount` is now fixed at `1` (never fires), removing
exactly the fourth, redundant shrink. Nothing else changed:
- `computeSurfaceSampleDepth` / `surfaceSampleDepth` (display field) -- untouched.
- Surface Elo's internal reliability formula and ensemble weighting -- untouched.
- `computeDataQuality` -- untouched.
- `calibrateProbability` (the fallback curve) -- untouched.
- `TOUR_RELIABILITY_DISCOUNT` / the ATP discount -- untouched.
- `LOW_SURFACE_SAMPLE_DISCOUNT` itself -- left exported with its value and evidence trail intact,
  purely as a historical record; no longer referenced by any call site.

See `predictionEngine/surfaceSampleDiscountRetirement.test.ts` for the regression suite and the
task report for the synthetic before/after table and hard-ceiling comparison.

## A pre-existing, unrelated bug this fix unmasks (not caused, and out of scope here)

Moving Low-surface-sample fallback-path probabilities further from 50 (the intended effect) can
cross into a margin band where `finalConsistencyCheck.ts`'s Rule 10 and Rule 12 misfire: Rule 10
never forwards `eloGapPoints` to its internal `computeRecommendation` recompute (silently defaults
to `Infinity`, i.e. always "Decisive" separation), and Rule 12 hardcodes a margin/agreement
assumption that predates `computeRecommendation`'s 2026-08-13 `eloGapPoints`/eloSeparation-band
gate. Reproduced in isolation against the untouched baseline (`computeRecommendation` called
directly with and without a real `eloGapPoints`), independent of this fix. Left unfixed here --
out of scope for surface-sample double-counting; recommended as a separate follow-up task.
