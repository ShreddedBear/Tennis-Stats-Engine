# Fifty-Percent Census — Phase 0 Audit

**Scope:** classify what causes real production predictions to land at or near 50%.
**No live DB access this session.** This document cannot report real sample counts — doing so would fabricate data, which the working agreement explicitly forbids. Instead, this is the **definitive code-path map of every mechanism that can produce a near-50% prediction**, with the exact SQL a human with DB access should run to classify real rows against this map. Treat every mechanism below as a hypothesis to be counted, not a pre-computed result.

---

## 0. Top-level pipeline (orientation)

`predictionEngine/index.ts: runPredictionEngine` (lines 370-1249). Stages in order, each captured in `decisionTrace.pipeline` for every stored row:
```
rawEnsemble → afterTieBreaker → afterCalibration (fitted or fallback) → afterSpecialist → afterReliabilityDiscount → afterSimulator → hard clamp [0.6, 99.4]
```
Every mechanism below maps to exactly one stage. **`decisionTrace` is the single most useful column for root-causing any specific near-50 row** — always join here first.

---

## 1. Mechanisms that can produce a ~50% (48-52%) final probability

### M1. Zero match history → structural defaults ("missing data collapsed to neutral")
**Code**: `index.ts:595-616` (`ZERO_HISTORY_MODULE_FLOOR=40`); `surfaceElo.ts:50,71,75-86` (level-aware corpus baselines ~1500-1537). When either player has zero recorded matches, surfaceElo/recentForm/serveReturn all fall back to the corpus baseline for both players → near-zero edge → logistic ≈50.
**Distinguishable?** Yes, richly: `engine.coverageGaps` names the affected player, `engine.defaultedInputs` lists which modules defaulted, `engine.surfaceElo.sampleSizePlayer1/2 = 0` confirms directly.
```sql
SELECT count(*) AS n, round(avg(calibrated_probability),2) AS avg_calib_prob
FROM predictions
WHERE created_at >= now() - interval '30 days'
  AND ((engine->'surfaceElo'->>'sampleSizePlayer1')::int = 0 OR (engine->'surfaceElo'->>'sampleSizePlayer2')::int = 0);
```

### M2. Upstream data-provider outage cascading to zero history ("cache miss / upstream API failure caught and defaulted")
**Code**: `tennisData/compositeProvider.ts` 5-tier cascade (MatchStat → API-Tennis → BSD → Sofascore → DB history fallback), every tier's catch block non-fatal (`compositeProvider.ts:260-265,274-277,296-298,315-317,350-352`; `dbHistoryFallback.ts:108-111`). Documented root cause of a real historical incident (`.agents/memory/prediction-engine-50-50-root-cause.md`) when API-Tennis billing lapsed — every prediction during the outage collapsed to 50/50.
**Distinguishable?** Only partially — the only trace is a `logger.warn` line, not persisted to any column. **Indistinguishable from M1 in the `predictions` table alone** — requires cross-referencing application logs for the time window, or looking for a correlated spike (many distinct players simultaneously zero-history = outage; a flat trickle = normal debutant rate).
```sql
SELECT date_trunc('hour', created_at) AS hr, count(*) AS zero_hist_predictions,
       count(DISTINCT player1_id) + count(DISTINCT player2_id) AS distinct_players
FROM predictions
WHERE created_at >= now() - interval '30 days'
  AND ((engine->'surfaceElo'->>'sampleSizePlayer1')::int = 0 OR (engine->'surfaceElo'->>'sampleSizePlayer2')::int = 0)
GROUP BY 1 ORDER BY zero_hist_predictions DESC LIMIT 50;
```

### M3. Player not found → stub profile ("broken player-name matching")
**Code**: `tennisData/playerIdentity.ts:677-748`. When `getPlayer()` returns null and a name-search also fails, a stub profile is built (`{id, name, fullName:null, currentRank:null, ...}`) and the request proceeds with empty match history — falls straight into M1.
**Distinguishable?** No direct column — a stub profile is indistinguishable from a genuine zero-history debutant in the stored row. Only a `logger.warn` (not persisted). **Recommend as a Phase-1 follow-up**: add a `playerResolutionMethod`/`stubProfile` column; until then this is folded into M1's count.

### M4. Genuine no-edge / honest tie-break disclosure ("genuine no-edge")
**Code**: `tieBreakers.ts:103-128`, `TIE_BAND=3`. When `|rawEnsembleProbability-50| < 3`, the raw ensemble value passes through **completely unchanged** — deliberately does not nudge toward or away from 50 (fixed 2026-07-15 after the old 7-step directional cascade was found to underperform a coin flip — see `model-lineage.md` §9, -13.34pp). Gated in `index.ts:802-820` so the disclosure is only forced into `INSUFFICIENT_EDGE` under `HighDisagreement`.
**Distinguishable?** Yes — the clearest mechanism in the engine. `engine.tieBreakerApplied` (boolean) + `engine.tieBreakerNote` + cross-reference against `defaultedInputs` (if both fire together, it's really M1/M2 wearing a tie-break label).
```sql
SELECT (engine->>'tieBreakerApplied')::boolean AS tie_breaker_applied,
       (jsonb_array_length(coalesce(engine->'defaultedInputs','[]'::jsonb)) > 0) AS data_incomplete,
       count(*) AS n, round(avg(calibrated_probability),2) AS avg_calib_prob
FROM predictions WHERE created_at >= now() - interval '30 days'
GROUP BY 1,2 ORDER BY n DESC;
```

### M5. Ensemble cancellation (modules disagree and average toward 50)
**Code**: `ensemble.ts:43-71` weighted average; `disagreement.ts:125-205` classifies `"HighDisagreement"` only when there is genuine directional conflict among meaningfully-weighted (≥15% share) core models.
**Distinguishable?** Yes. `engine.modelAgreement` ∈ {Strong, Moderate, Mixed, HighDisagreement}; `engine.disagreementNote` names the exact conflicting modules; `engine.models[]` has every module's own probability/weight.
```sql
SELECT engine->>'modelAgreement' AS agreement, count(*) AS n
FROM predictions WHERE created_at >= now() - interval '30 days' AND ABS(calibrated_probability - 50) <= 2
GROUP BY 1 ORDER BY n DESC;
```

### M6. Calibration fallback shrink toward 50 (no fitted model yet)
**Code**: `predictionEngine/calibration.ts:47-62`, `confidenceFactor` 0.4-0.85 by Data Quality; `calibrated = 50 + (raw-50)×confidenceFactor`. Only used when `activeCalibration` is empty (no fitted isotonic model exists) — see `model-lineage.md` §3 for which calibration model is/was active.
**Distinguishable?** Yes. `decisionTrace.pipeline.calibrationMethod` = `"fitted"` vs `"fallback"`; `fallbackShrinkFactor` gives the exact multiplier. This is also the one source `used_fallback`/`fallback_sources` correctly tracks structurally (see `silent-fallbacks.md` §10.3) — though it conflates a systemic (server-wide, no fitted model) condition with a per-match data gap.
```sql
SELECT decision_trace->'pipeline'->>'calibrationMethod' AS calib_method, count(*) AS n
FROM predictions WHERE created_at >= now() - interval '30 days' GROUP BY 1;
```

### M7. Reliability discount stack (tour × low-surface-sample discount) — systematic shrink toward 50
**Code**: `index.ts:693-704`. `TOUR_RELIABILITY_DISCOUNT.ATP=0.63`, `LOW_SURFACE_SAMPLE_DISCOUNT=0.75` (`dataQuality.ts:233-262`). `preSimulatorProbability = 50 + (blendedProbability-50) × reliabilityDiscount`. Only applies when NOT using fitted calibration and NOT specialist-applied — explicitly documented as a double-correction risk if real calibration is active.
**Distinguishable?** Yes. `engine.disclosures` contains an explicit string when this fires; `decisionTrace.pipeline.reliabilityDiscount` (<1.0 when fired) gives before/after.

### M8. De-vig market-consensus blend producing ~50%
**Code**: `index.ts:506-527`. When the market itself is genuinely a pick'em, the de-vigged probability ≈0.5 → market module votes ~50 (weight 0.5), contributing to M5-style cancellation.
**Distinguishable?** Yes, but requires unnesting `decision_trace.modules`. `predictions.odds_status` (`included`/`outside_window`/`provider_error`) tells you whether odds were used at all — see `engine-io.md` §8 for the `oddsStatus` mislabeling caveat when neither provider is configured.

### M9. `usedFallback`/`fallbackSources` naming trap — read this before trusting either column
**Code**: `evaluation/fallbackInstrumentation.ts:12-59`. Fires **only** for 3 narrow things (serveReturn proxy-note string match, recentForm coverage<100%, calibrationMethod==="fallback") — **does not fire for the M2 provider-outage cascade at all.** A human classifying rows must not assume `usedFallback=true` means "provider outage"; cross-check `fallbackSources` contents. Full treatment in `silent-fallbacks.md`.

### M10. Hard probability clamp [0.6, 99.4]
Not itself a "produces 50%" mechanism — the ledger will never contain exactly 50.000 or 0/100. Expected floor/ceiling behavior, not a bug.

### M11. PAVA isotonic calibration flat-zone — pushes genuine near-50% raw signals *away* from 50 (important sampling caveat)
**Code**: `.agents/memory/calibration-flat-zone-overconfidence.md`; PAVA's monotonicity constraint (`services/evaluation/calibration.ts pavaFit`) can merge a near-50 raw bin into a flat block at a pooled average that is *not* 50 — for calibration model #712, raw 48-52% was calibrated *out* to 55.65%. **This means a naive `calibrated_probability BETWEEN 48 AND 52` filter will miss some genuinely-uncertain matches**, which instead appear at ~55.65%. Mitigation: `computeRecommendation`'s `margin<8` gate still correctly routes these to `INSUFFICIENT_EDGE`/`LOW_CONFIDENCE`, so **`recommendation` is a more honest near-coin-flip indicator than raw `calibrated_probability`** for rows affected by this specific calibration model.
**Recommended sampling method**: run the near-50 query twice — once filtering `calibrated_probability` (48-52), once filtering `recommendation IN ('INSUFFICIENT_EDGE','LOW_CONFIDENCE')` — and diff the two sets. Rows in the second but not the first are flat-zone-affected.

### M12. `INSUFFICIENT_EDGE` recommendation gate — classification-level "near 50," independent of the raw number
**Code**: `classificationPolicy.ts:107-110` (`DATA_QUALITY_MIN=25`, `SMALL_LEAN_MAX_MARGIN=8`). Three *different* root causes collapse to the same label: DQ<25/Poor, tie-breaker applied, or margin<8 with Mixed/HighDisagreement. **Always join on `decision_trace.recommendation.rulesChecked` to find the true cause** — never trust `recommendation` alone.

### M13. Elo-gap "Caution band" underperformance (past finding, still live logic)
`classificationPolicy.ts:43-55` — a documented backtest found the 25-50pt Elo-gap "Caution" band scores *worse* than the "Thin" band below it. Not itself a 50%-producing mechanism, but relevant when cross-referencing "confidently-looking number the classification layer doesn't actually trust."

### M14. Recent Form / Surface Elo conflict gate (contributes to M5)
`index.ts:396-411`, `formWeightPrior=0.1` when Form and Elo disagree — documented to have previously caused the ensemble to follow the worse signal 73% of the time at only 45.4% accuracy (see `feature-trace.md` §3, `number-provenance.md` Form-Elo conflict figures). `engine.formEloConflict` boolean — add to any M5 cross-tab.

### M15. Zero-vote / empty-model-list defensive branch — historically real, now fixed to report honest 50, not fabricate
`disagreement.ts:128-136`. A past bug (`|| 1` fallback on zero total weight) fabricated 100% support for player 2 out of no data; now returns neutral 50/50. Only reachable if every module is ablation-excluded simultaneously — expect ~0 rows in live traffic.

### M16. Legacy DDL default — `calibrated_probability REAL DEFAULT 0.5` (scale-mismatch landmine, check reachability)
`lib/db/src/sql/predictions-forward-compat.sql:21-22` — a raw-SQL table definition with a `DEFAULT 0.5` on a column that every live-inserted row scales 0-100, not 0-1. **If any insert path ever bypasses `saveOrUpdatePrediction`, a row would read `calibrated_probability=0.5`** — i.e. "0.5%", not "50%" — a scale-corruption bug, not a near-50% prediction. Any row with `calibrated_probability < 1` in a table whose median is ~55-75 is almost certainly this default firing, not a genuine near-0% prediction.
```sql
SELECT count(*) FROM predictions WHERE calibrated_probability < 1;
```

---

## 2. Predictions ledger — columns relevant to classifying these mechanisms

Full schema detail in `engine-io.md`; columns most relevant here: `calibratedProbability`, `predictedWinnerProbability`, `dataQuality`/`dataQualityLabel`, `recommendation`, `usedFallback`/`fallbackSources` (see M9 caveat), `engine` (jsonb — modelAgreement, disagreementNote, defaultedInputs, coverageGaps, tieBreakerApplied/Note, formEloConflict, models[]), `decisionTrace` (jsonb — the full pipeline stage trace, richest column for root-causing any single row), `oddsStatus`.

**Companion ledger with denormalized columns and graded outcomes already joined** (better for accuracy-conditioned analysis): `evaluation_predictions` (`lib/db/src/schema/evaluation.ts:106-232`) — has `modelAgreement`/`upsetRiskTier` as plain TEXT (no JSON unnesting needed), `status` (pending/graded/void/missed), `includedInAccuracy`, and real market-odds columns.

`calibration_models` (`evaluation.ts:243-274`) — check which model was `active=true` during the window being analyzed, since M6/M11's behavior depends entirely on which model was live (see `model-lineage.md` for the #691/#712 history).

---

## 3. Master classification query for the human running this census

```sql
-- Sample: every near-50% live prediction in the last 30 days, every distinguishing signal joined in.
SELECT
  p.id, p.player1_name, p.player2_name, p.surface, p.tournament_level, p.created_at,
  p.calibrated_probability, p.predicted_winner_probability, p.data_quality, p.data_quality_label,
  p.recommendation, p.upset_risk, p.used_fallback, p.fallback_sources, p.odds_status,
  p.engine->>'modelAgreement' AS model_agreement,
  p.engine->>'disagreementNote' AS disagreement_note,
  (p.engine->>'tieBreakerApplied')::boolean AS tie_breaker_applied,
  p.engine->>'tieBreakerNote' AS tie_breaker_note,
  p.engine->'defaultedInputs' AS defaulted_inputs,
  p.engine->'coverageGaps' AS coverage_gaps,
  (p.engine->>'formEloConflict')::boolean AS form_elo_conflict,
  (p.engine->'surfaceElo'->>'sampleSizePlayer1')::int AS p1_surface_sample,
  (p.engine->'surfaceElo'->>'sampleSizePlayer2')::int AS p2_surface_sample,
  p.decision_trace->'pipeline'->>'calibrationMethod' AS calibration_method,
  p.decision_trace->'pipeline'->>'rawEnsemble' AS raw_ensemble,
  p.decision_trace->'pipeline'->>'reliabilityDiscount' AS reliability_discount,
  (SELECT r->>'rule' FROM jsonb_array_elements(p.decision_trace->'recommendation'->'rulesChecked') r
     WHERE (r->>'decided')::boolean = true LIMIT 1) AS recommendation_deciding_rule
FROM predictions p
WHERE p.created_at >= now() - interval '30 days' AND ABS(p.calibrated_probability - 50) <= 2
ORDER BY random() LIMIT 300;

-- Aggregate mechanism-frequency count (heuristic priority order — data-completeness causes checked first):
SELECT
  CASE
    WHEN (engine->'surfaceElo'->>'sampleSizePlayer1')::int = 0 OR (engine->'surfaceElo'->>'sampleSizePlayer2')::int = 0
      THEN 'M1_M2_M3_zero_history_or_provider_or_stub'
    WHEN (engine->>'tieBreakerApplied')::boolean = true AND jsonb_array_length(coalesce(engine->'defaultedInputs','[]'::jsonb)) = 0
      THEN 'M4_genuine_no_edge'
    WHEN engine->>'modelAgreement' = 'HighDisagreement' THEN 'M5_ensemble_cancellation'
    WHEN decision_trace->'pipeline'->>'calibrationMethod' = 'fallback' THEN 'M6_calibration_fallback_shrink'
    WHEN (decision_trace->'pipeline'->>'reliabilityDiscount')::numeric < 1 THEN 'M7_reliability_discount_stack'
    ELSE 'UNCLASSIFIED_manual_review_needed'
  END AS mechanism_bucket, count(*) AS n
FROM predictions
WHERE created_at >= now() - interval '30 days' AND ABS(calibrated_probability - 50) <= 2
GROUP BY 1 ORDER BY n DESC;
```
A human reviewer should open the full per-row join for anything landing in `UNCLASSIFIED_manual_review_needed`, and separately check M8 (unnest `decision_trace.modules`) and M16 (`calibrated_probability < 1`) — both excluded from the heuristic CASE above.

---

## 4. Past incident writeups already in the repo (context, not new findings)

- **`.agents/memory/prediction-engine-50-50-root-cause.md`** — the api-tennis billing-lapse incident (M1+M2), now partially mitigated by the tier-5 DB fallback, not eliminated (players with no `historical_matches` rows still get 50/50).
- **`.agents/memory/tiebreak-cascade-underperformance.md`** and **`docs/audit-task162-findings-report.md`** — the old 7-step tie-break cascade's -13.34pp finding (M4's predecessor bug, now fixed — see `model-lineage.md` §9). Verified fixed against current code: `tieBreakers.ts` no longer nudges the probability at all.
- **`.agents/memory/calibration-orientation-bias.md`** — the Sackmann-storage-convention bias where near-50% raw signals were miscalibrated to a confident-but-wrong ~85%; verified fixed against current code (`applyCalibrationOriented`, `WINNER_ALWAYS_PLAYER1_PROVIDERS`).
- **`.agents/memory/degenerate-calibration-guard.md`** — model #697 incident; verified the 3-gate guard described is live in `walkForward.ts` today (see `model-lineage.md` §2).
- **`.agents/memory/calibration-flat-zone-overconfidence.md`** — the M11 PAVA flat-zone finding for model #712; structurally sound given `pavaFit`'s monotonicity requirement, though the specific 55.65% figure is DB state and could not be re-verified this session.
- **`docs/audit-task162-findings-report.md:208-212`** — a 2026-07-15-era finding that 61% of the then-corpus sat within 5 points of a coin flip; this is tied to the OLD tie-break cascade and OLD Elite gates, both since replaced (Elo-gap-separation-band gates, 2026-08-13). **Do not cite "61% near coin-flip" as a current fact** — a fresh margin-distribution re-run against current logic is needed first.

---

## Recommendation

Run §3's master query against the live DB before Phase 1. The mechanism-frequency breakdown it produces — not this document's code-path enumeration alone — is what actually answers the task's original question ("classify real production predictions, give counts"). This document supplies the classification scheme and the tooling; it deliberately does not supply counts, since none could be honestly produced without database access this session.
