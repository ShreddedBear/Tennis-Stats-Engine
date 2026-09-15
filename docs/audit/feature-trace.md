# Feature Trace — Phase 0 Audit

**Scope:** Statistical Prediction Engine, `Tennis-Stats-Engine` repo, branch `claude/engine-audit-phase-zero-5fj00z`, HEAD `03c252c` at time of audit (2026-09-15).
**Method:** static read of source + git history only. No live DB access this session (`DATABASE_URL` unset) — any claim that depends on current row counts (e.g. whether `specialist_models` has qualifying rows today) is flagged **NOT INDEPENDENTLY VERIFIED** below and needs a live-DB re-check before Phase 1 decisions are made on it.
**Verdict vocabulary** (as specified in the task): `live` / `computed-but-never-stored` / `stored-but-never-read` / `read-but-overwritten-by-default` / `dead`. Three real states didn't fit that vocabulary cleanly and are called out explicitly where they occur: **computed-but-excluded-from-voting** (runs and is displayed, but is structurally prevented from ever moving `calibratedProbability` or `dataQuality`) and **live-but-currently-possibly-inert** (the wiring is real but a live DB row-count precondition is unverified).

---

## 0. Top-level pipeline

```
routes/predictions.ts (POST /predictions)
  → evaluation/predictionSnapshot.ts: predictFromSnapshot()
      → tennisData: CompositeTennisProvider.getPlayerMatches / getHeadToHead  (API-Tennis primary, 5-tier fallback cascade)
      → predictionEngine/opponentStrength.ts: resolveOpponentStrength()      (reads match_feature_snapshots)
      → evaluation/calibrationCache.ts: getActiveCalibration()               (reads calibration_models)
      → evaluation/specialistWeights.ts: resolveSegmentSpecialistInput()     (reads specialist_models)
      → evaluation/simulatorValidation.ts: resolveSimulatorAdoption()
      → oddsData: fetchMarketOddsWithStatus()
      → predictionEngine/index.ts: runPredictionEngine()                    [index.ts:370-1249]
  → INSERT INTO predictions (engine: JSONB, decisionTrace: JSONB)
  → GET response: GetPredictionResponse.parse(row)                          [lib/api-zod/src/generated/api.ts:593+]
```

**Governing structural finding — collapses TRUE_ZERO and SOURCE_FAILURE into the same signal everywhere below:**

`predictionSnapshot.ts:137-144`:
```ts
const safeGetMatches = async (id: string) => {
  try { return await input.provider.getPlayerMatches(id); }
  catch { return []; }
};
const safeGetH2H = async (id1: string, id2: string) => {
  try { return await input.provider.getHeadToHead(id1, id2); }
  catch { return { player1Id: id1, player2Id: id2, meetings: [] }; }
};
```
A provider `ProviderUnavailableError` (API-Tennis circuit open / network / auth — thrown from `compositeProvider.ts:5,197,261,275,375,382`) is silently converted into the *exact same* empty array a genuine brand-new player produces. Every downstream module treats `matches.length === 0` identically regardless of cause. `index.ts:595-604`'s `ZERO_HISTORY_MODULE_FLOOR` fires the same way for a debutant or a dead data source. **There is no schema-level distinction anywhere on the live path between TRUE_ZERO and SOURCE_FAILURE.** See §13 for the full missing-data-vocabulary finding.

---

## 1. Surface Elo — **live**

- **SOURCE**: API-Tennis `get_fixtures` (`apiTennisProvider.ts:662-691`). Opponent strength from a *separate* source: `match_feature_snapshots.feature_value WHERE feature_name='eloOverall'`.
- **INGESTION**: `CompositeTennisProvider.getPlayerMatches` → `mapMatchRecord` (`apiTennisProvider.ts:693-725`). Opponent Elo resolved by `resolveOpponentStrength()` (`opponentStrength.ts:234-268`).
- **DB COLUMN**: no dedicated column; opponent Elo lives in `match_feature_snapshots.feature_value` (`historicalMatches.ts:108-133`), written by a *separate, simpler* running-Elo replay in the backfill (`historicalData/features.ts:52,79-100`, `STARTING_ELO=1500`, `ELO_K=32`) — this backfill Elo model is **not** the same algorithm as the live `surfaceElo.ts` model; it exists only to seed the opponent-strength lookup.
- **FEATURE FN**: `predictionEngine/surfaceElo.ts:330-421`. Chronological Elo replay with a 545-day recency half-life, level-based K-multiplier, blend toward overall Elo when surface sample is thin, and a tour-level-credibility shrink toward `CORPUS_BASELINE_ELO=1520`. `defaulted=true` when either player has 0 matches (line 418).
- **ENSEMBLE**: `player1Edge = eloDifference/8`. `weightPrior=1.5` (the single highest prior in the ensemble), `importance=1.3`. Not excluded from ensemble or Data Quality.
- **CALIBRATION**: no per-feature calibration; feeds the scalar `ensembleProbability`. Its raw Elo *gap* (not the calibrated probability) separately gates Elite-tier classification.
- **OUTPUT**: `EngineBreakdown.surfaceElo` → `predictions.engine` JSONB → `GetPredictionResponse.engine.surfaceElo`.

## 2. Serve / Return — **live, with a permanent confidence-shrink correction**

- **SOURCE**: API-Tennis point-level stats; falls back to real set/game-score margins when point stats aren't reported.
- **DB COLUMN**: none. Point stats live only in the transient per-request `MatchRecord.stats` and inside `historical_matches.raw_source` JSONB, which is explicitly documented as **never read by the prediction engine**.
- **FEATURE FN**: `serveReturn.ts:236-326`. Prefers real point-level stats (≥3 matches both players) over the margin proxy. `defaulted=true` only in the proxy branch when either side has zero set-score matches — the real-stats branch never sets `defaulted`, even when a specific rate (e.g. `firstServeWinPct`) failed to resolve.
- **ENSEMBLE**: `weightPrior=1.5`, `importance=1.2`, plus a **permanent `confidenceShrink=0.45`** applied inside `buildEnsemble` — this module's vote is deliberately pulled toward 50 unconditionally (not conditional on data quality) because a 2026-07-13 ablation found its stated confidence overstated real hit-rate by ~9.5pp.
- **CALIBRATION**: general pipeline only.
- **OUTPUT**: `EngineBreakdown.serveReturn`; its `.warnings` also feed `upsetRiskUncertaintyWarnings`.
- **Classified as read-but-shrunk-by-default** (not overwritten by a constant, but its computed edge is unconditionally scaled down ~55% before voting): condition = always, `ensemble.ts:46-47`.

## 3. Recent Form — **live, with a documented weight override under a named condition**

- **DB COLUMN**: none live (an analogous simpler `winPctLast10` is written by the backfill for research scripts only, never read by the live engine).
- **FEATURE FN**: `recentForm.ts:127-254`. 10-match window, opponent-adjusted via `performanceDelta` when opponent Elo resolves else plain win/loss, recency-decay 0.85^i, surface-mismatch de-weight ×0.7, retirement/walkover de-weight ×0.35, tour-level-credibility shrink toward 50 (floor 0.35). `defaulted=true` at 0 matches → `form=50, trend="stable"` (tested, `recentForm.test.ts:43-49`).
- **ENSEMBLE**: `weightPrior=1.3`, `importance=1.1`, `confidenceShrink=0.35`.
- **Read-but-overwritten-by-default — "Form/Elo conflict gate"** (`index.ts:396-411`):
  ```ts
  const formEloConflict = formProbEdge > 3 && eloProbEdge > 2 && Math.sign(rawFormEdge) !== Math.sign(rawEloEdge);
  const formWeightPrior = formEloConflict ? 0.1 : ENSEMBLE_WEIGHT_PRIOR.recentForm;
  ```
  **Condition**: Recent Form's edge exceeds 3pp AND disagrees in direction with Surface Elo's edge (itself >2pp). **Effect**: Recent Form's ensemble weight is cut from 1.3 to 0.1 (~13×) for that single prediction. Disclosed via `EngineBreakdown.formEloConflict`.
- **OUTPUT**: `EngineBreakdown.recentForm` + `formEloConflict`.

## 4. Fatigue — **computed-but-excluded-from-both-ensemble-and-Data-Quality**

- **DB COLUMN**: none — pure per-request computation, never persisted.
- **FEATURE FN**: `fatigue.ts:55-89`. 3/7/14-day match-count windows plus an estimated-games proxy. `reliability` is a **hard-coded constant 70** regardless of data richness (line 85) — not a real per-match signal.
- **ENSEMBLE**: `weightPrior=0.4` on paper, but `fatigue ∈ EXCLUDED_FROM_ENSEMBLE` (`dataQuality.ts:181`) and filtered out at `index.ts:547`. **Rationale (documented, dataQuality.ts:135-156)**: a 2026-07-14 investigation found the "more fatigued" player actually *won* 54.9% of matches — an inversion, confounded with tournament survivorship / Recent Form (61.5% directional overlap) — kept excluded "PERMANENTLY pending a real redesign."
- **Also excluded from the Data Quality blend** — but see §12 for a live regression affecting this exclusion set's rationale.
- Its `.warnings` DO still feed `upsetRiskUncertaintyWarnings` — its only live numeric-adjacent influence path.
- **VERDICT**: runs every request and is fully displayed, but is structurally incapable of moving `calibratedProbability` or `dataQuality`.

## 5. Match Load Recovery — **computed-but-excluded-from-both-ensemble-and-Data-Quality**, plus a stale doc comment

- **FEATURE FN**: `matchLoadRecovery.ts:84-108`. Score depends only on whether the single most-recent prior match "went the distance"; rest-days is computed but explicitly does **not** feed the score (rejected as a tournament-survivorship confound, same failure mode as Fatigue). `reliability` again hard-coded `70`.
- **STALE COMMENT** (`matchLoadRecovery.ts:5-6`): *"EXPERIMENTAL — not wired into the live ensemble, EngineOutput, or EngineBreakdown."* This is **false** as of current code — it is in `EngineBreakdown` (`index.ts:31,1082`) and in `moduleEdges` (`index.ts:466-476`), just excluded from voting. An auditor trusting only the file header would be misled.
- **ENSEMBLE**: excluded from both ensemble vote and Data Quality blend. Rationale: a 4,001-match leave-one-out ablation found it moves 2.9% of individual picks but exactly 0.0pp overall accuracy ("flips roughly cancel out").
- Its `.warnings` are **not** fed into `upsetRiskUncertaintyWarnings` (only serveReturn/fatigue are) — so its fallback disclosures ("recovery risk defaults to 0") never reach the flat, headline `engine.warnings` array either (confirmed separately by the silent-fallbacks audit, Finding 3.5) — they exist only inside the nested `engine.matchLoadRecovery.warnings` object.

## 6. Availability — **computed, zero numeric influence anywhere; one dead sub-path**

- **FEATURE FN**: `availability.ts:202-275`. Rest-day bucketing, haversine travel-distance bucketing against a static ~18-tournament venue table, confirmed-withdrawal detection from real retired/walkover flags. `computeAvailabilityScore` starts from a **hardcoded NEUTRAL=60 baseline** and only nudges for components that resolved.
- **ENSEMBLE**: `weightPrior=0.4` on paper, but `availability ∈ EXCLUDED_FROM_ENSEMBLE` and `EXCLUDED_FROM_DATA_QUALITY`. Rationale: an 18,281-match live-ablation replay showed 57.3% with it included vs 57.4% excluded — net negative.
- Its `.warnings` are **deliberately** excluded from `upsetRiskUncertaintyWarnings` too (`index.ts:879-880`: "these track venue-coverage limits, not a genuine per-match upset signal").
- **DEAD SUB-PATH**: the web-research injury-risk discount (`availability.ts:244-263`) is real, tested logic, but `predictionSnapshot.ts:186-203` — the sole live per-fixture caller — never supplies `webResearch` to `runPredictionEngine` at all. This makes the Gemini web-research injury signal **dead code on the standard live path** today, despite being documented in `types.ts:63-70` as an available input.
- No `defaulted` field exists on `AvailabilityResult` at all, so a purely-neutral-60 row (nothing resolved) is indistinguishable in the output from a genuinely-balanced real signal.

## 7. Head-to-Head — **live** (votes); **excluded from Data Quality by design** (not a bug)

- **SOURCE**: fresh per-request `getHeadToHead()` call — not derived from `historical_matches` in the live path. Subject to the same SOURCE_FAILURE-collapse as §0 (`safeGetH2H`).
- **FEATURE FN**: `headToHead.ts:33-82`. Recency-decayed (15%/yr), tournament-level-weighted. `defaulted=true` when zero meetings exist; edge is 0 by construction then (not silently substituted with a fabricated non-zero value).
- **ENSEMBLE**: `weightPrior=0.4`, `importance=0.5`. Votes (not in `EXCLUDED_FROM_ENSEMBLE`). **Is** in `EXCLUDED_FROM_DATA_QUALITY` — deliberately, because "no prior meeting" is the normal case for most matchups and would otherwise wrongly drag every first-meeting Data Quality score down. This exclusion's rationale is internally consistent (contrast with §12).
- Its `.warnings` route to `disclosures`, not `risks` — structurally prevented from counting as a risk signal.

## 8. Style Matchup ("surface specialist" tags) — **dead for the probability path** (not dead code)

- **FEATURE FN**: `styleMatchup.ts:35-70`. Per-surface win-rate tags at ≥3-match samples, ≥65% win rate.
- **NOT IN `moduleEdges` AT ALL** — no `player1Edge`, no `weightPrior`, no reliability contribution anywhere in `buildEnsemble` or `computeDataQuality`. It is called purely to source `.warnings` into `disclosures` and to populate display tags.
- **Grep-confirmed**: `styleMatchup.player1Styles`/`Advantages` are referenced nowhere downstream except the destructure and the final `engine:` object assembly — nothing ever reads them as a numeric signal.
- **VERDICT**: runs every request, its tags genuinely reach the API response, but has **zero** wiring into `calibratedProbability`, `dataQuality`, or `upsetRisk`.
- **NAMING COLLISION FLAG**: this "specialist" (per-player surface-affinity tag) is a completely different system from the "Segment Specialist" in §10 (a fitted isotonic-calibration model per tour+surface that *does* blend into `calibratedProbability`). The codebase itself calls both "specialist" — do not conflate them in any downstream reporting.

## 9. Ensemble Combiner — **live** for 4-5 voting modules

- `player1Edge` (≈-50..+50) → logistic `edgeToProbability()` (`ensemble.ts:17-20`) → per-module `confidenceShrink` → weight = `max(1,reliability) × weightPrior` → weighted average.
- **Modules that actually vote today**: Surface Elo, Serve & Return, Recent Form, Head-to-Head, and (conditionally) Market Consensus. Fatigue, Availability, Match Load Recovery are structurally excluded (§4-6).
- **Market Consensus**: vig-normalized bookmaker probability, `weightPrior=0.5`, added only when real odds present (never synthesized — see §11 for the honest-absence test). Removed from `EXCLUDED_FROM_ENSEMBLE` on 2026-08-08 per a **documented override of the project's own n≥200 significance gate** — actual activation n=174. See `model-lineage.md` for full detail on this gate.
- **Tie-breaker** (`applyTieBreaker`, `index.ts:570-582`) is now a no-op on the probability itself (removed 2026-07-15 after validation showed every directional step of the old cascade underperformed a coin flip) — it only sets a disclosure flag, gated to fire only under `HighDisagreement`.

## 10. Segment Specialist (statistical tour×surface specialist) — **live-but-currently-possibly-inert (unverified)**

- **Segments**: `{ATP,WTA} × {Hard,Clay,Grass,IndoorHard}` (`segments.ts:12-13`) — tour and surface are combined into one key (e.g. `"WTA-Clay"`); there is no pure-tour specialist independent of surface. No Challenger/ITF/Exhibition/Junior specialist is ever fit (insufficient volume, by design).
- **Thresholds**: `MIN_HISTORICAL_MATCHES_FOR_SEGMENT=150`, `MIN_VALIDATION_SAMPLES_FOR_SEGMENT=30`, `MIN_SPECIALIST_ACCURACY=55`. A segment failing any gets `meetsThreshold:false, weight:0` and falls back to the general model with a visible `segmentNote` disclaimer.
- **Read-but-overwritten-by-default — Clay is hard-coded off** (`index.ts:657`):
  ```ts
  const specialistDisabledForSurface = input.surface === "Clay";
  const segment = excludedModels?.has("segmentSpecialist") || specialistDisabledForSurface ? null : (input.segment ?? null);
  ```
  Unconditional string-equality check, independent of whether an ATP-Clay/WTA-Clay specialist actually clears its threshold in the DB. Rationale: walk-forward showed specialist calibration hurt Clay accuracy by −1.67pp while helping Grass/Hard/IndoorHard (+1.30 to +2.19pp).
- **Knot constraint** (Task #182): fitted specialist knots are blended toward the general model below `x=0.75` confidence, to correct a documented selection-bias steepness — full detail deferred to `model-lineage.md` §5 (WTA specialist-constraint open thread).
- **⚠ NOT INDEPENDENTLY VERIFIED — flag for immediate live-DB check**: `specialistWeights.ts:324-331` states, as of its own last check (dated 2026-07-15 in-code): *"`specialist_models` has zero rows in the current environment... confirmed by a fresh ablation replay where the Active Segment Specialist voted on zero matches."* No live DB access was available this session to confirm whether this remains true. If true, **`specialistApplied` may currently be `false` for 100% of live traffic**, with the fallback-to-general-model path doing all the work — this would mean the entire Segment Specialist tier of the engine is real, wired, and non-functional in production today. **This is the single highest-priority open question for the human running Phase 0 review with DB access.**

## 11. Calibration Layer — **live**, well-instrumented

- **Two mechanisms chosen per-request** (`index.ts:639-644`): (a) fitted isotonic mapping via `applyCalibrationOriented` (orientation-safe as of a 2026-08-09 fix) when `activeCalibration` exists; (b) hand-tuned Data-Quality-indexed shrink-toward-50 heuristic (`calibrateProbability`, `predictionEngine/calibration.ts:47-62`) otherwise.
- Downstream discounts (`TOUR_RELIABILITY_DISCOUNT.ATP=0.63`, `LOW_SURFACE_SAMPLE_DISCOUNT=0.75`) are explicitly skipped once real fitted calibration is active, to avoid double-correction.
- Hard bound: `calibratedProbability = clamp(0.6, 99.4, raw)` — the engine can never claim 0% or 100% certainty (deliberate business rule).
- Calibration operates on the single scalar `ensembleProbability` only — it cannot selectively re-weight individual features.
- The fitted-vs-fallback choice and every downstream discount's on/off condition is captured per-prediction in `decisionTrace.pipeline` — one of the most auditable parts of the engine.
- **Positive finding**: market-odds absence does not synthesize a neutral vote (`index.test.ts:255-264`, explicit test: *"Market Consensus must NOT appear when marketOdds is null — absence must not synthesize a 50/50 noise vote"*).

## 12. CONFIRMED REGRESSION — Data-Quality exclusion set silently reverted (Task #111 fix undone)

The single most concrete, citable bug in this trace.

- **Current code** (`dataQuality.ts:82`): `EXCLUDED_FROM_DATA_QUALITY = new Set(["headToHead","fatigue","availability","matchLoadRecovery","marketOdds"])`.
- **Governing comment directly above the code that reads this Set** (`index.ts:529-544`, unchanged since it was written) still says: *"Task #111 root-cause fix: the Data Quality blend must draw from every module NOT in `EXCLUDED_FROM_DATA_QUALITY` (currently just Head-to-Head)... A 4,111-row walk-forward audit (docs/audit-task111-dq-degradation-above-55.md) traced the calibration reversal above DQ~55 directly to this... Restoring the documented modules shrank the worst-miscalibrated (DQ 85-100) segment from n=422 to n=96."*
- **Git history** (`git log --follow -p`):
  - `fe14654` (2026-07-13): `EXCLUDED_FROM_DATA_QUALITY = new Set(["headToHead"])` — the original, correct-per-its-own-rationale state.
  - `102f88e` (2026-07-14, "Task #111"): added the `allModuleEdgesForDataQuality` restoration logic in `index.ts` — **still present, unchanged today** — this fix assumed the exclusion set stayed `{"headToHead"}`.
  - `325dcad` (2026-07-27, commit message *"add ui components and projects improvements"* — an unrelated-sounding message covering 20+ files): silently changed the exclusion set back to `{"headToHead","fatigue","availability","matchLoadRecovery"}`, i.e. **re-excluded the three modules Task #111 had specifically restored**, with a new comment ("any module whose reliability score cannot affect model inputs... must have zero prediction-DQ weight") that is itself factually inconsistent with the codebase — e.g. Fatigue's `.warnings` *do* reach `upsetRiskUncertaintyWarnings`, contradicting the new comment's own premise.
- **Net effect today**: only Surface Elo, Serve & Return, and Recent Form contribute to `dataQuality` — the exact pre-Task-111 configuration the cited 4,111-row audit found broken — while the in-code comment still claims the opposite, and `docs/audit-task111-dq-degradation-above-55.md`'s finding is silently un-applied in production.
- **This audit does not adjudicate** whether `325dcad`'s rationale was a deliberate, separately-justified re-exclusion or an accidental revert swept up in a large unrelated commit — only that the code and its own governing comment currently contradict each other. **This is a P0/P1 candidate for Phase 1**: it directly determines whether a previously-fixed calibration-degradation bug is currently live again.

## 13. Missing-data vocabulary — does the DB distinguish TRUE_ZERO / MISSING / NOT_APPLICABLE / INSUFFICIENT_SAMPLE / SOURCE_FAILURE / STALE / RECONSTRUCTION_FAILURE?

**No, on the live prediction path.** Missingness is collapsed, with informal, inconsistent conventions layered on top in application code rather than the schema:

- `historical_matches`: no state columns; the *only* schema-level distinction is null-vs-zero on `player1Rank`/`player2Rank` (explicitly documented "never zero" for missing).
- `match_feature_snapshots.feature_value` is `NOT NULL` — missingness is encoded entirely by **row absence**. No `status`/`reason` column distinguishes "no history yet" from "reconstruction failed" from "source never had this field" — all three produce an identical observable state (no row).
- `predictions.engine`/`predictions.decision_trace` are opaque JSONB. There are no separate typed columns per feature, so there is no schema-level way to query "how many live predictions had TRUE_ZERO surface-Elo history vs SOURCE_FAILURE." The only structured-ish signal is free-text `warnings[]`/`disclosures[]`/`coverageGaps[]` — human-readable, not machine-queryable enums.
- The actual application-code convention is a single boolean `defaulted` per module (surfaceElo, serveReturn, recentForm, headToHead only — fatigue/availability/matchLoadRecovery/styleMatchup have **no** `defaulted` field at all, structurally incapable of appearing in `EngineBreakdown.defaultedInputs`). `defaulted=true` fires identically for a genuine debutant (TRUE_ZERO) and a caught provider exception (SOURCE_FAILURE) — no field anywhere lets a query distinguish these after the fact.
- No "as-of"/fetched-at timestamp is threaded through the live `MatchRecord`/engine output at all — a stale-cache-served prediction is indistinguishable from a freshly-fetched one in the stored row. (Contrast: the offline backfill/evaluation corpus *does* carefully track a leak-proof `cutoffMinutes` boundary — this discipline exists in the codebase, just not on the live per-fixture path.)
- **A typed status model already exists elsewhere and was never applied here**: `.agents/memory/validation-engine-data-states.md` documents the (out-of-scope, other-engine-owned) parlay-builder scorer's explicit `PlayerDataStatus` enum (`player_not_found`/`insufficient_data`/`data_available`) and resolution-outcome enum (`CACHE_HIT`/`CACHE_MISS`/`SOURCE_UNAVAILABLE`/`PLAYER_NOT_FOUND`/`NO_MATCH_HISTORY`/`DATA_UNAVAILABLE`) — proof the team has already built and used this exact pattern once. It was simply never threaded into `predictFromSnapshot`/`runPredictionEngine`, the engine this audit covers.

**Recommendation for Phase 1**: the single highest-leverage schema fix is threading a `MatchDataResolutionStatus`-style enum (modeled on the existing parlay-builder pattern) through the `safeGetMatches`/`safeGetH2H` fetches in `predictionSnapshot.ts`, so TRUE_ZERO and SOURCE_FAILURE are distinguishable in `predictions.engine` *before* they reach any feature module's `defaulted` flag.

---

## Feature status summary table

| Feature | Ensemble vote | Data Quality blend | Verdict |
|---|---|---|---|
| Surface Elo | ✅ (weight 1.5) | ✅ | live |
| Serve & Return | ✅ (weight 1.5, shrunk ×0.45) | ✅ | live (permanent confidence-shrink) |
| Recent Form | ✅ (weight 1.3, cut to 0.1 on Form/Elo conflict) | ✅ | live (conditional weight override) |
| Fatigue | ❌ excluded | ❌ excluded | computed-but-excluded-from-voting |
| Match Load Recovery | ❌ excluded | ❌ excluded | computed-but-excluded-from-voting (+ stale doc comment) |
| Availability | ❌ excluded | ❌ excluded | computed, zero numeric influence (+ 1 dead sub-path) |
| Head-to-Head | ✅ (weight 0.4) | ❌ excluded by design | live / DQ-exclusion is intentional and consistent |
| Style Matchup | ❌ never in `moduleEdges` | ❌ | dead for the probability path (not dead code) |
| Market Consensus (odds) | ✅ conditional (weight 0.5) | ❌ excluded | live when odds present; activated below documented sample gate (see model-lineage.md) |
| Segment Specialist | ✅ level-2 blend, Clay hard-disabled | n/a | live-but-possibly-inert — **verify `specialist_models` row count against live DB before Phase 1** |

## Files read in full for this trace

`predictionEngine/{index,dataQuality,ensemble,calibration,segments,surfaceElo,serveReturn,recentForm,fatigue,matchLoadRecovery,availability,headToHead,styleMatchup,opponentStrength,types}.ts`, `evaluation/{predictionSnapshot,specialistWeights,calibrationCache}.ts`, `historicalData/features.ts`, `lib/db/src/schema/{predictions,historicalMatches}.ts`, `lib/db/src/schema/evaluation.ts:243-328`, `lib/api-zod/src/generated/api.ts:593-700+`, `.agents/memory/validation-engine-data-states.md`.

**Not read this pass** (flagged for follow-up if Phase 1 needs deeper detail): `recommendation.ts`, `upsetRisk.ts`, `disagreement.ts`, `eliteTier.ts`, `classificationPolicy.ts`, `finalConsistencyCheck.ts`, `simulator.ts`/`simulatorPool.ts`, `matchPerformance.ts`, `setMargins.ts`, `venueMap.ts`, `weather.ts`, `oddsData/*`, `historicalData/matchRecordReconstruction.ts`, `evaluation/ablation.ts`, `routes/evaluation.ts`.
