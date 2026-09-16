# POST-FIX TEMPORAL SPOT-CHECK REPORT

*Step 2 independent validation gate. Performed 2026-09-16 by Agent 4, against
`Tennis-Stats-Engine` commit `6c5503a` ("fix: historical-integrity defects from the
temporal-integrity audit") on branch `claude/temporal-integrity-leakage-88qjg0`, which sits on top
of `ef6ee1a` (the audit report commit, "P2 Package 7 temporal integrity & leakage audit report").
Read-only investigation plus small, self-contained code execution. No production code, weights,
calibration, thresholds, ensemble methodology, or prediction methodology were modified by this
gate. No ablation, no walk-forward replay, no optimizer sweep, no calibration refit, no historical
regeneration was run.*

**Correction to the authorization framing**: this branch's HEAD in the *truth-engine* repo
(`tennis-truth-engine-8ecc1270`) is still just the docs-only audit commit — the actual
implementation commit lives on the identically-named branch in the **stats-engine** repo
(`Tennis-Stats-Engine`, commit `6c5503a`). I fetched and inspected that exact commit directly
before running anything, rather than assuming the branch name alone guaranteed a fix existed.

---

## 1. Agent 7 Changes Verified

Read the full diff of `6c5503a` (12 files, 589 insertions / 24 deletions) directly — not the
commit message alone. Confirmed:

- **Availability asOfDate fix** — `predictionEngine/index.ts:390`: `computeAvailabilityModule(...,
  new Date(), ...)` → `computeAvailabilityModule(..., input.asOfDate ?? new Date(), ...)`. This is
  the same pattern already used for Fatigue/MatchLoadRecovery since 2026-07-14 — the fix extends
  it to Availability, which had the identical bug independently.
- **`PredictionEngineInput.asOfDate` doc comment** (`types.ts`) updated to name Availability
  alongside Fatigue/MatchLoadRecovery as a consumer — documentation kept honest with the code.
- **Four sibling callers** now thread `asOfDate: match.cutoffAt` / `cutoffAt` into
  `runPredictionEngine`, where they previously omitted it entirely (silently defaulting to
  wall-clock time for a historical replay): `ablation.ts:222`,
  `scripts/backtestLedgerJuly8_9.ts:172`, `scripts/eloOpponentResolutionRebuild.ts` (two call
  sites, lines ~139 and ~200), `scripts/regenerateLedgerPredictions.ts:170`.
- **Defects 2/3 (optimizer/backtest candidate-config honesty)** — confirmed this was *not* claimed
  as a full fix. The engine genuinely has no mechanism to apply a candidate's
  weights/gates/thresholds during scoring; building one would touch `ensemble.ts`, which also
  serves live predictions, and is explicitly out of this package's scope. Instead:
  - `candidateOptimizer.ts:779-788` — every batch-generated candidate's `holdoutMetrics` now
    carries `candidateSpecificallyScored: false` (this batch's numbers are one shared
    walk-forward run's pooled result, not this candidate's own independently-scored performance).
  - `optimizerSummary.ts:156` — `readMetric()` now returns `null` whenever
    `candidateSpecificallyScored === false`, before checking any of `accuracy`/`logLoss`/etc. I
    checked every call site of `readMetric` in `optimizerSummary.ts` (10 call sites, all of the
    file's ranking/"best candidate" logic) and found no path that reads `holdoutMetrics` fields
    directly, bypassing this gate. I also checked `routes/backtests.ts` for any place that copies
    `backtestService.ts`'s own metrics into `candidateConfigsTable.holdoutMetrics` (which would
    have let the *other* honesty flag, `candidateConfigApplied`, silently bypass this gate under a
    different field name) — found none; the two disclosure mechanisms live on genuinely separate
    tables/paths (`candidate_configs.holdoutMetrics` vs. `backtest_runs.metrics`) and do not
    cross-contaminate.
  - `backtestService.ts` — a `candidateConfigId` that can't actually be applied now sets
    `metrics.candidateConfigApplied: false`, pushes a descriptive error, and the run's final
    status is downgraded from `"completed"` to `"completed-with-warnings"` (confirmed at
    `backtestService.ts:497`: `errors.length > 0 ? "completed-with-warnings" : "completed"`).
- **Calibration-window-overlap disclosure** — `backtestService.ts` computes
  `calibrationWindowOverlap` from the active calibration model's own `fittedAt` minus
  `CALIBRATION_WINDOW_MONTHS`, **imported from `walkForward.ts`** (not redefined/duplicated), and
  compares it against the requested backtest date range. When true, it pushes a warning (same
  status-downgrade mechanism) explaining that the raw ensemble probability is unaffected and only
  the calibration curve's independence from the window is in question. No calibration fitting or
  application code was touched by this change — confirmed by diff: the only lines added are the
  overlap boolean computation and its disclosure, not any change to `calibrationKnots` computation
  or `applyCalibrationOriented`.
- **No unrelated methodology changes**: `ensemble.ts`, `dataQuality.ts` (`ENSEMBLE_WEIGHT_PRIOR`,
  `MODULE_IMPORTANCE`), and `calibration.ts` do not appear anywhere in the 12-file diff. No weight,
  prior, or threshold constant was touched.

## 2. Historical Availability Test

Ran the actual, unmodified, already-committed regression tests directly (not summarized from
Agent 7's report — executed myself):

```
npx tsx --test src/services/predictionEngine/index.test.ts
→ 22 pass, 0 fail
```

Including, by name:
- `Availability measures recency against the provided historical asOfDate, not the real current
  time (sibling of the Fatigue asOfDate fix)` — **PASS**
- `Availability with no asOfDate defaults to the real current time (live-path behavior, unchanged)`
  — **PASS**

I then wrote and ran a small standalone script (not committed) calling `computeAvailabilityModule`
directly, independent of Agent 7's own test file, using a fixed historical `asOfDate` and a
3-days-prior match:

| Scenario | `now` passed | `daysSinceLastMatch` | `restCategory` |
|---|---|---|---|
| Called twice with the same `asOfDate` (wall-clock invariance) | `2024-03-01` both times | 3, 3 (identical) | Normal, Normal |
| Pre-fix-style call (simulating the old `new Date()` behavior) | real wall-clock `2026-01-01` | **674** | **LongLayoff** |
| Post-fix-style call (as `index.ts` now actually calls it) | historical `asOfDate` `2024-03-01` | **3** | **Normal** |

**Matches tested**: 1 representative synthetic case (3-day rest scenario), run under 3 date
configurations — small and credit-efficient, as instructed. This is not 5-10 *real historical* DB
records (no DB access in this sandbox — see §6), but it exercises the exact same code path
(`computeAvailabilityModule`, unmodified, called exactly as `index.ts` calls it) that any real
historical match would go through, and the magnitude/direction of the pre-fix-vs-post-fix
difference (674 days → 3 days) makes the bug class and the fix's effect unambiguous.

**Result: PASS.** Availability is reproducible under different real wall-clock times when the same
historical `asOfDate` is supplied, and the fix demonstrably changes behavior versus the old
`new Date()` call in exactly the direction the audit predicted.

## 3. Future-Information Immutability Test

**Caveat on scope**: Agent 7's fix commit does not touch match-filtering logic at all — it only
changes which `Date` value recency is measured against. The actual future-data exclusion for
historical scoring happens one layer up, in `reconstructPlayerMatchHistory`
(`services/historicalData/matchRecordReconstruction.ts:99-108`), which every real historical
caller (`index.ts`'s historical path, `ablation.ts`, the three one-off scripts) uses to build
`player1Matches`/`player2Matches` before they ever reach the engine. I read that function's
implementation directly: `if (row.scheduledStartAt.getTime() >= cutoffMs) continue;` — a real,
unconditional filter, unrelated to and unmodified by this commit.

To test whether `computeAvailabilityModule` has its **own** defense-in-depth against future data
(independent of that upstream filter), I ran it directly with a future-dated match manually
injected into the player's match array (something the real pipeline should never do, given the
filter above, but worth checking for a second line of defense):

| Fixture | `daysSinceLastMatch` |
|---|---|
| `player1Matches` = [match 3 days before cutoff] | 3 |
| `player1Matches` = [same match, **plus** a match 3 months **after** cutoff] | **0** (picks the future match as "most recent") |

**Finding**: `computeAvailabilityModule` has no internal cutoff check of its own — it fully trusts
the caller to have already filtered. This is a real, evidence-backed structural observation, but:
(a) it is **not a regression** introduced by this commit (the module never had such a check,
before or after the fix — the fix only changed the `now` reference point), and (b) the actual
production choke point (`reconstructPlayerMatchHistory`) does correctly exclude it today, for
every real caller. I am classifying this as a **residual, disclosed risk** (single point of
failure — no defense-in-depth if a future caller ever forgets to pre-filter), not a gate failure.

**Fields compared**: `daysSinceLastMatch`, `restCategory` (Availability's own output fields — the
only ones this commit touches). I did not re-run the broader "compare predicted winner / raw
ensemble probability / calibration output byte-for-byte" comparison from the original Step 2 spec
end-to-end, because doing so meaningfully requires either a real historical fixture from the DB
(unavailable, see §6) or reconstructing the full `PredictionEngineInput` for a synthetic match with
every module's inputs by hand, which would exceed "small and credit-efficient" for what is, in
this commit, a single-module change. The already-existing `index.test.ts` suite (22/22 passing,
including two swap-symmetry/consistency tests unrelated to this commit but exercised by the same
run) provides broader coverage that this commit did not disturb.

**Result: PASS for the specific property this commit could regress** (Availability's own
computation is asOfDate-driven and the upstream filter that has always protected it is untouched
and unbroken). **Flagged, not failed**: Availability's lack of its own internal guard (see §6
Remaining Risks).

## 4. Current-Time Dependency Review

Did not do a fresh full-repo grep for `new Date()` — the audit report already did this
comprehensively and I independently re-verified only the specific sites this commit touched or
claimed to touch, per the "don't redo Agent 7's audit" instruction:

| Site | Classification |
|---|---|
| `predictionEngine/index.ts:390` (Availability) | **FIXED** — now `input.asOfDate ?? new Date()` |
| `ablation.ts` scoreMatch | **FIXED** — now threads `asOfDate: match.cutoffAt` |
| `scripts/backtestLedgerJuly8_9.ts`, `eloOpponentResolutionRebuild.ts` (×2), `regenerateLedgerPredictions.ts` | **FIXED** — all four now thread `asOfDate: cutoffAt`/`match.cutoffAt` |
| `predictionEngine/index.ts`'s live-path default (`asOfDate` omitted → real `new Date()`) | **SAFE** — correct behavior for live (non-historical) predictions, unchanged and untouched |
| `computeAvailabilityModule`'s internal match-array handling (no cutoff filter of its own) | **POTENTIAL RISK** (see §3) — pre-existing, not introduced or worsened by this commit |
| `getPredictionSettings()` call inside `backtestService.ts` | **IRRELEVANT TO HISTORICAL SCORING** — reads `retirement_rule`/`paper_trade_lead_minutes` admin settings, not match data or a timestamp; not a temporal-integrity concern, just an unrelated DB dependency that blocked one test in this sandbox (see §6) |

## 5. End-to-End Historical Trace

Traced `ablation.ts`'s `scoreMatch()` (the representative historical path, since it is what a
future live ablation run would actually execute) end to end for the `asOfDate` value specifically:

```
match.cutoffAt (frozen at import time, historicalMatches.ts)
  → ablation.ts scoreMatch(): asOfDate: match.cutoffAt  [line 222, this commit]
  → runPredictionEngine(input) receives input.asOfDate = match.cutoffAt
  → predictionEngine/index.ts:387-391:
      fatigue = computeFatigueModule(..., input.asOfDate)              [unchanged, already correct]
      matchLoadRecovery = computeMatchLoadRecoveryModule(..., input.asOfDate)  [unchanged, already correct]
      availability = computeAvailabilityModule(..., input.asOfDate ?? new Date(), ...)  [THIS FIX]
  → all three modules now measure recency against the same instant
  → ensemble/calibration/simulator stages downstream are unmodified by this commit and do not
    themselves consume asOfDate at all (confirmed: no other function in the diff receives it)
  → final calibratedProbability, decision_trace, etc. proceed exactly as before, with only
    Availability's own sub-fields (daysSinceLastMatch, restCategory, and any warnings derived from
    them) changed by this fix
```

I did not need to separately trace Elo/Recent Form/Serve & Return/Specialist/calibration for
*this* commit's purposes, since the diff does not touch any of those modules' own cutoff handling
— they were already asOfDate-independent (Elo/Recent Form/Serve & Return derive their timing
entirely from the pre-filtered `player1Matches`/`player2Matches` arrays' own dates, not from a
`now` parameter) or already fixed in the 2026-07-14 pass (Fatigue/MatchLoadRecovery).

## 6. Remaining Temporal Risks

Only evidence-backed items:

1. **`computeAvailabilityModule` has no internal future-date guard** (§3) — relies entirely on
   `reconstructPlayerMatchHistory`'s upstream filter. Verified that filter is real and correct
   today; this is a single-point-of-failure observation for future code changes, not a live bug.
2. **The new `backtestService.candidateConfigHonesty.test.ts` could not be executed in this
   sandbox** — it requires `DATABASE_URL` at module load (`@workspace/db`'s `db` object throws
   without it) and, even with a placeholder connection string to pass that guard, the code path
   under test calls `getPredictionSettings()`, which issues a real query
   (`select ... from prediction_settings`) that has no test-hook bypass. This failed with
   `ECONNREFUSED` in this sandbox — an **environment limitation** (no reachable Postgres), not a
   test or logic failure I can attribute to the fix. I verified the same property by reading the
   code directly instead (§1: `readMetric`'s null-gate, `candidateConfigApplied`'s
   `null`/`false` distinction, the `completed-with-warnings` status threshold, and the absence of
   any bypass path in `optimizerSummary.ts`/`routes/backtests.ts`) and found it internally
   consistent and correctly scoped, but this is static verification, not an executed-test
   confirmation. Classifying this specific sub-item as **UNVERIFIED (environment-blocked)**, using
   the same classification Agent 7's own audit used for its two similarly DB-blocked test files —
   not a failure, but not a green checkmark either.
3. **Items 3/5 of the original Step 2 mandate** (full future-information immutability across Elo/
   rankings/Recent Form/Serve & Return/Specialist/calibration observations) were not independently
   re-verified end-to-end by me in this pass, because this commit does not touch any of those
   modules. I relied on Agent 7's own audit report's citation of already-existing, already-passing
   tests (`leakage.test.ts`'s `sourceTimestamp < cutoffAt` assertions, and the Truth Engine's
   80-adversarial-future-rows byte-identical test) as pre-existing evidence, which I did not
   re-execute myself (the former needs `DATABASE_URL`; the latter lives in the other repo and
   wasn't in scope for this specific commit's validation). If this matters for the live ablation's
   own confidence, it is already covered ground from the audit, not new risk introduced by
   `6c5503a`.

## 7. Gate Decision

**PASS — SAFE TO PROCEED TO LIVE ABLATION**

The specific defect this gate exists to check — Availability substituting wall-clock time for the
historical cutoff, corrupting historical scoring/ablation results — is confirmed fixed by direct
code execution (not just review), the fix is minimal and correctly scoped (7 lines in the core
engine, 4 trivial sibling call-site additions, no ensemble/calibration/weight changes), and its
own regression tests pass. The two honesty-disclosure fixes (Defects 2/3) and the
calibration-window-overlap disclosure are correctly implemented per static review, with one
regression test environment-blocked (not failed) due to this sandbox's lack of database access.
None of the residual items in §6 are temporal-integrity regressions caused by this commit; they
are either pre-existing (§6.1, §6.3) or a sandbox limitation (§6.2). Proceeding to the live
ablation plan (`docs/live-ablation-execution-plan.md`) is reasonable on this evidence — that plan's
own test-segment restriction (§1 of that doc) remains the right approach regardless of this gate's
outcome, since it addresses a different (fit-window overlap) concern than this commit does.

## 8. Production Methodology

**Confirmed unchanged**: no model weight, ensemble methodology, calibration methodology,
threshold, or prediction methodology was touched by commit `6c5503a`. Verified directly from the
diff's file list (`ensemble.ts`, `dataQuality.ts`, `calibration.ts` do not appear) and from the
commit's own stated scope, which I independently corroborated rather than took on faith.

---

*No code changes were made during this gate. No ablation, walk-forward replay, optimizer sweep,
calibration refit, or historical-prediction regeneration was run. This report stops here per the
Step 2 authorization's instruction.*
