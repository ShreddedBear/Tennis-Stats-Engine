# Model Lineage — Phase 0 Audit

**Scope:** Statistical Prediction Engine, `Tennis-Stats-Engine` repo, branch `claude/engine-audit-phase-zero-5fj00z`.
**Method:** git history + code, not doc prose, per the working agreement. Docs and `.agents/memory/*.md` are treated as *claims to check*, not as ground truth — every claim below is labeled by how it was verified (direct code read, git commit, or doc-only/unverifiable-without-DB).
**No live DB access this session.** Several items below have a specific, unresolved question that can only be settled with a live query — each is called out explicitly with the exact SQL to run.

---

## 1. `calibration_models` schema

`lib/db/src/schema/evaluation.ts:243-278`. Key columns: `id`, `method` ("isotonic"|"platt"), `mapping` (jsonb knots), `validationSampleSize`, `validationDateRangeStart/End`, **`active`** (boolean, default true — the lineage/status flag), `isotonicHoldoutLogLoss`/`plattHoldoutLogLoss`, `holdoutSampleSize` (default 0), `fittedAt`, `pendingActivation` (Task #198), `pendingSpecialistData`.

**There is no `parentModelId`/`constrainedAgainst`/version-FK column.** Lineage is implicit only — a code comment (line 241) states "exactly one row has `active=true`," and the table is append-only by convention (a refit flips the old active row to `false` and inserts a new one), not by schema enforcement.

Related: `specialist_models` (`evaluation.ts:290-324`) stores `generalAccuracy/generalLogLoss/generalBrier` — the general model's metrics on the *same* validation slice — as the only record of "what general model was this compared to," and it's **metrics-only, not an FK to `calibration_models.id`**. This is a real audit-trail gap (see §4).

## 2. Who sets `active` — application paths vs. manual DB updates

**Application code paths** (all in `evaluation/walkForward.ts`):
- Auto-activation (`requireApproval=false`, line 640): deactivates the current active row, inserts a new one with `active = fitsPassesQualityGate`.
- Task #198 require-approval path (lines 604-616): always inserts `active:false, pendingActivation:fitsPassesQualityGate`; a human must hit a separate `POST /evaluation/walk-forward/activate/:modelId` admin endpoint.
- **Three-gate quality check before any activation** (lines 551-563): `gate1_nonDegenerate` (holdout > 0), `gate2_aboveFloor` (holdout ≥ `MIN_HOLDOUT_SAMPLE_SIZE_TO_ACTIVATE=500`), `gate3_notWorseThanCurrent` (new log-loss ≤ active log-loss, with a documented bootstrap exception when no active model exists or the active model's LL is null/legacy). **Confirmed current in code**, not stale — this is the fix for the #697 degenerate-model incident (below).

**Manual out-of-band updates — confirmed, not just alleged:**
- Model **#697** (2026-07-30): validation_sample_size=14, a degenerate isotonic fit, briefly displaced the good model #691. Rolled back **manually** (`active=false` on #697, `active=true` on #691) — no commit reference. This incident is what motivated the three-gate guard above.
- Model **#691 manually reactivated 2026-08-08**, both #707 and #708 set inactive by direct DB update (per `.agents/memory/market-odds-ablation-results.md:238`).
- Model **#691 manually reactivated again 2026-08-10**: #712 (full-corpus refit, holdout LL=0.6397 — *worse* than #691's 0.6390) had displaced #691; restored via manual DB update (`market-odds-ablation-results.md:275-278`).
- **Git-verified** (`.agents/memory/constraint-gate-and-691-reactivation.md:17-24`, commit `6955537`, 2026-08-10 08:11:13 UTC): *"The reactivation was a direct DB UPDATE with no corresponding commit... No commit between those timestamps has a message referencing the model switch."* The same memory file also documents that a **prior compacted-session summary hallucinated a "Task #125" attribution** for this change, which had to be corrected — this is a concrete, git-verified instance of the exact "closure docs / fabricated attribution" pattern the working agreement warns about, not a hypothetical.

**Is there a safeguard today?** Partial, not complete. The three-gate check protects the *application* activation path (auto-activation and the Task #198 approval endpoint). **There is no DB-level constraint** — no trigger, no CHECK constraint, no unique-partial-index enforcing "exactly one active row" — searched all schema files, none present. **Conclusion: anyone with direct DB access can still run a bare `UPDATE calibration_models SET active=true WHERE id=X` today with zero audit trail.** This is a currently-open gap, not a historical one.

## 3. #691 vs #712 reconstruction (git-cited)

Chronology (`git log --all --format="%H %ad %s" --date=iso`):

| Commit | Timestamp (UTC) | Event |
|---|---|---|
| — | 2026-07-29 | #691 fitted: isotonic, n=21,570, window 2025-01-01→2026-07-26, holdout LL=0.6390. Stable model through early August. |
| — | 2026-07-30 | #697 (degenerate, n=14) briefly active, manually rolled back to #691 — pre-dates the 3-gate guard. |
| `f368f5b` | 08-08 00:29:31 | #707 active (holdout LL 0.5673 vs 0.6390) |
| `decc030` | 08-08 04:19:21 | "Run corrected market-odds Section B ablation (n=174/184)... **keep excluded**" (see §6 — reversed same day) |
| — | 08-08 | #691 manually reactivated; #707 and #708 (LL=0.6904, both worse, traced to a walk-forward double-run bug from a server restart mid-run) set inactive by direct DB update |
| `20e4eed` | 08-10 01:38:40 | commits doc stating "Active model: id=712 (isotonic, 8 knots, 21,222 holdout rows, LL=0.6397)" |
| `be263f8` | 08-10 06:30:18 | Task #184: specialist curve refit, **executed `computeAndStoreSpecialistSegments` against calibration model #712** |
| — | 08-10 06:42:59 | separate walk-forward run completes, regenerates ATP specialist knots "from the corrected orientation" — target general-model id at that exact moment not stated in the doc |
| `9188b64` | 08-10 06:49:13 | commits WTA/ATP specialist verification docs, both citing "Active general model: **#691**" — i.e. #691 was active again by this point |
| `6955537` | 08-10 08:11:13 | reconstruction memory doc — confirms the #712→#691 reactivation was a bare DB UPDATE, no commit |
| `cfdcb69` | 08-10 08:21:29 | Task #193: "Restrict pooled calibration fit to last 24 months to prevent full-corpus dilution" — the code-level fix targeting the #712 failure mode |

**Relationship**: #712 did **not** supersede #691 in a "better model won" sense — it was a full-historical-corpus refit that scored *worse* on holdout (0.6397 vs 0.6390) **and** worse on a live cross-check (B-CAL on 184 paper-trade rows: #712 reapplied LL=0.6599 vs stored #691-locked LL=0.6361). It was activated anyway (most likely via gate3's bootstrap exception, since the immediately-prior active model, #711, had just been deactivated for an orientation-bias bug — see below), then reverted out-of-band. Task #193 (`cfdcb69`) is the durable code fix meant to prevent a recurrence via the *application* refit path — it does **not** touch the manual-UPDATE gap in §2.

**As of the last git-traceable state** (2026-08-10, ~06:49 UTC onward), **#691 is the active general calibration model** per every downstream doc written after that point. No later commit in this repo's history touches `calibration_models.active` again (checked `git log --all --since="2026-08-10 10:28:26"` for calibration/walkforward/specialist-related commits — found only endpoint/feature commits, no further refit executions).

**Orphan check**: no code or doc after 2026-08-10 08:11 still points at #707, #708, or #712 as authoritative. #691 is the consistently-cited active model in every doc written after that timestamp.

Separately: model **#711** (active before #691's most recent stretch) was deactivated as part of Task #175's orientation-bias fix (the predicted-winner-space rewrite) — #711 is the model responsible for the flat-zone/direction-inversion mispredictions (e.g. Rinderknech/Nakashima) that motivated the whole Task #172/#175/#182 cluster.

**⚠ Caveat, repeated from the task itself**: this section is a git/doc reconstruction, not a live query. The manual-UPDATE gap in §2 means **a live query is the only way to be certain which model is active right now**:
```sql
SELECT id, method, active, holdout_sample_size, fitted_at, isotonic_holdout_log_loss
FROM calibration_models ORDER BY fitted_at DESC LIMIT 20;
```

## 4. Specialist knots — what are they constrained against, and is any orphaned?

`constrainSpecialistKnotsToGeneral` (`evaluation/specialistWeights.ts:50`, called at line 342) receives `generalMapping` as a plain array passed in by the caller at fit time — **it is baked into the frozen specialist knot values, not stored as a live reference**. If the general model changes later, specialist knots are **not** automatically re-applied.

Convergence mechanics (`docs/audit-task184-specialist-curve-refit.md:66-72`): trust ramp `clamp((x-0.5)/(0.75-0.5), 0, 1)`; blended = trust×specialistY + (1-trust)×generalY for x∈[0.5,0.75), full specialist trust at x≥0.75. A regression test (`specialistWeights.test.ts`, Task #184) asserts every active specialist's stored knots stay within 15pp of the general model in that band.

8 live specialist segments (ATP/WTA × Hard/Clay/Grass/IndoorHard), all `meetsThreshold=true`, weights 0.549-0.709 (clamped [0.1, 0.85], derived from measured validation-log-loss improvement — not hand-tuned). Clay is **hard-disabled at inference time** regardless (see `feature-trace.md` §10) — a live-application gate, not a fit-time exclusion.

**⚠ CRITICAL, UNRESOLVED — likely orphaned constraint, top priority for a live-DB check:**
- Task #184 (`be263f8`, 06:30:18 UTC) persisted all 8 `specialist_models` rows **constrained against calibration model #712**.
- A separate walk-forward run completed at 06:42:59 UTC regenerated ATP specialist knots — its target general-model id is not stated in the doc.
- The verification docs committed at 06:49:13 UTC (`9188b64`) present comparison tables against **#691**, not #712 — meaning #691 was active again by the time those docs were written.
- **Unresolved**: did the 06:42:59 run (or anything after it) actually re-run `computeAndStoreSpecialistSegments` against #691 and rewrite `specialist_models`? Or are the 06:49 docs read-only comparisons that recomputed display numbers against #691's mapping without touching the DB? **If the latter, the specialist_models rows in the DB right now may still carry knots constrained against #712** — a model that was itself worse than #691 and was manually deactivated — while `predictionEngine/index.ts` blends those specialist knots against whatever the *live-active* general model is (#691) at inference time. That is a genuine lineage mismatch: specialists fit against a rejected general model, blended live against a different one.
- **Resolving SQL**:
  ```sql
  SELECT segment_key, computed_at FROM specialist_models;
  -- compare each computed_at against calibration_models.fitted_at for #691 (2026-07-29) and #712 (2026-08-10)
  -- a computed_at between be263f8's timestamp (08-10 06:30) and cfdcb69's (08-10 08:21) is almost certainly still anchored to #712's mapping.
  ```

## 5. WTA specialist-constraint question — RESOLVED (with a caveat tied to §4)

Doc: `artifacts/api-server/docs/audit-task186-wta-specialist-constraint-verification.md` (committed `9188b64`, 06:49:13 UTC) — this **is** the constrained-vs-unconstrained log-loss comparison the open thread asked about.

**Conclusion** (compares pre-fix raw PAVA vs post-fix `constrainSpecialistKnotsToGeneral`, Task #182, for all 4 WTA segments in the 50-75% confidence band, against general model #691):

| Segment | Max gap vs general | Verdict | LL improvement retained |
|---|---|---|---|
| WTA-Hard | 5.5pp | within 10pp threshold, well-calibrated | −0.109 nats |
| WTA-Clay | 5.0pp | constraint clean, genuine value added | −0.203 nats |
| WTA-Grass | 10.3pp at x=0.70 | marginally exceeds threshold, attributed to sparse high-x data (n=3,304), judged acceptable | −0.192 nats |
| WTA-IndoorHard | 22.2pp, but **under**-confident direction | no overconfidence risk, conservative; n=58 only | −0.375 nats |

Accuracy unchanged pre/post-constraint in all four. Referenced predecessor "Task #183 confirmed WTA training data is NOT affected by [cascade-exclusion] bias" — **no standalone `audit-task183*.md` file was found** in `docs/` or `artifacts/api-server/docs/`; flagging this predecessor claim as unverified rather than asserting it.

**Was it acted on?** Yes — `constrainSpecialistKnotsToGeneral` (Task #182, first introduced `b1f4b1d`, 2026-08-10 02:57:00 UTC) is the live code path, and Task #184 executed it against all 8 segments.

**Resolution for this open thread**: **the constraint question is closed** — the constraint exists in code, is live, and was verified not to harm WTA calibration. **However**, per §4, the specific rows this verification doc compares against are ambiguous: the doc's comparison table references #691, but the DB write that produced the rows it might be describing happened against #712, 19 minutes earlier. **Recommend**: re-run the WTA verification fresh once §4's `specialist_models.computed_at` query confirms which general model the persisted rows actually carry.

## 6. Market odds gate — n=174 vs documented n≥200

- **Documented threshold**: n≥200, stated **only in code comments**, `predictionEngine/dataQuality.ts:174-181`:
  ```
  // marketOdds: ACTIVATED 2026-08-08 as a deliberate documented override of the n≥200 threshold.
  // Corrected paired-arm Section B (n=174 processed / 184 eligible; 10 cross-val rejections):
  // ... but n=174 < 200 gate NOT MET. Override justified by effect-size stability across three ...
  export const EXCLUDED_FROM_ENSEMBLE = new Set(["availability", "fatigue", "matchLoadRecovery"]);
  ```
  `"marketOdds"` is **absent** from this exclusion set — removed 2026-08-08 — so market odds is currently included in the live ensemble vote.
- **There is no runtime-enforced sample-size gate anywhere in code.** Searched `dataQuality.ts` and the whole `predictionEngine` directory for a `MIN_SAMPLE`/sample-size check tied to market odds — none exists. **"n≥200" is a documented policy threshold that was overridden by a code edit removing the module from an exclusion set, not a computed/enforced gate.** Nothing will automatically re-exclude market odds if the effective sample shrinks again, and nothing recomputes n at runtime.
- **Same-day reversal, git-confirmed**: commit `decc030` (2026-08-08 04:19:21) message literally says *"Run corrected market-odds Section B ablation (n=174/184): both thresholds met but n<200 — keep excluded."* The module was activated later **that same day** (per the `dataQuality.ts` comment date and `.agents/memory/market-odds-ablation-results.md:206`). The decision reversed from "keep excluded" to "activate via override" within hours, and that reversal is a code diff, not a re-run of the n≥200 check.
- The repo's own memory file already self-flags this: `.agents/memory/market-odds-ablation-results.md:204-217`: *"✅ STATUS: ACTIVATED 2026-08-08 — Documented Override... NOT a Section B pass... Future sessions must not treat this activation as a validated Section B result."*

**Resolution for this open thread**: **keep, but re-test now that more rows exist, per the task's own instruction.** The activation was an explicit, self-documented override of the project's own gate — not a silent violation — but it has never been re-tested against a larger sample since, and nothing in code will do so automatically. **Recommend as a Phase-1 P2/P3 item**: re-run the Section B ablation against current live/paper-trade row counts; if n≥200 now, formally promote the override to a passed gate (remove the "override" language from the comment); if still <200, decide explicitly whether to keep the override, raise the required n, or revert — do not leave the "documented override, not a validated pass" state open indefinitely.

## 7. Frozen vs. dynamic weight backtest — form weight

Form's ensemble weight is **static code**, not dynamic: `dataQuality.ts:98-118`, `ENSEMBLE_WEIGHT_PRIOR = { surfaceElo: 1.5, serveReturn: 1.5, recentForm: 1.3, fatigue: 0.4, headToHead: 0.4, availability: 0.4, matchLoadRecovery: 0.3 }` — a hand-set constant object (re-tuned from ablation deltas per its own comment), `as const`. `recentForm: 1.3` never varies match-to-match; only the *effective* weight (`weightUsed = reliability × prior`) varies, because per-match reliability varies — the prior itself is frozen.

**Naming mismatch found and worth flagging explicitly**: a script `scripts/backtestFrozenVsDynamicWeights.ts` exists, but per its own header comment it does **not** compare static vs. dynamic `ENSEMBLE_WEIGHT_PRIOR` values — it compares "frozen: apply the currently-active deployed *calibration* to every fold" vs. "dynamic: fit a fold-specific *calibration* on each validation slice." **This is a frozen-vs-dynamic calibration backtest, not a form/ensemble-weight backtest.**

**Resolution for this open thread**: the task's premise — "form weight swinging by roughly an order of magnitude match to match, despite no frozen-vs-dynamic weight backtest ever being run" — is **partially wrong as stated**: the *ensemble weight prior* for form does not swing at all; it is a frozen constant (1.3, or 0.1 under the Form/Elo conflict gate — a different, already-documented mechanism, see `feature-trace.md` §3). What *does* swing by roughly an order of magnitude is the *effective* weight (`weightUsed`), because `reliability` varies with per-match sample size. **No backtest of a genuinely dynamic ensemble-weight-prior mechanism exists because no such mechanism exists in code today** — there is nothing to backtest. Recommend closing this thread as "premise corrected, no action needed" unless the intent was specifically to backtest *reliability*-driven weight swings, which would be a new analysis, not a re-run of the existing (differently-scoped) frozen/dynamic script.

## 8. Data Quality signal vs. `computeCrossEngineAgreement` independence

- `computeCrossEngineAgreement`: **not found in Tennis-Stats-Engine** — confirmed by grep across `predictionEngine/` and `services/evaluation/`. It is owned by the separate `tennis-truth-engine` repo, out of scope to edit. **The cross-repo verification grep (confirming its input signature) was not completed** — the `tennis-truth-engine` working directory was removed from the session mid-task before this item was reached. Flagged as not verified rather than guessed. *(Separately, the parallel output-contract research for this audit did examine the boundary from this repo's side — see `docs/contracts/engine-io.md` §Cross-Engine Boundary — and confirms `crossEngineAgreement` is always `null` from this engine's own output, populated only by an out-of-band backfill script that calls into the other engine's `computeCrossEngineAgreement`.)*
- **Data Quality** (`computeDataQuality`, `dataQuality.ts:390-396`): weighted blend `score = Σ(reliability_i × importance_i) / Σ(importance_i)`, each module input `{reliability, importance}`.
- **Agreement** (`computeWeightedDisagreement`/`modelAgreement`, `disagreement.ts:125-205`): computed from `{modelName, player1Probability, weightUsed}`, where `weightUsed = reliability × ENSEMBLE_WEIGHT_PRIOR` (comment, lines 7-8).
- **Confirmed non-independence**: Data Quality's per-module `reliability` values are the **same** reliability values that feed `weightUsed`, which feeds the Agreement computation. Both signals consume identical per-module reliability scores as their primary shared input.
- **Existing in-repo precedent for this exact failure mode**: `disagreement.ts:39-53` (Task #146) already documents that Surface Elo, Serve & Return, and Recent Form "derive their edges from largely the same underlying recent-match history" (74.2% pairwise same-direction rate vs. ~50% expected if independent) and are deliberately collapsed into one combined vote (`collapseCorrelatedCluster`) specifically because their agreement was found to be non-independent double-counting rather than real confirmation. This is the closest in-repo precedent, though it addresses core-module correlation, not the DQ-vs-Agreement question directly.
- **Not completed**: an exhaustive per-field list of which specific per-module reliability functions feed both `computeDataQuality`'s module array and `disagreement.ts`'s `weightUsed` with identical values — the shared *mechanism* is confirmed (reliability × prior = weightUsed, and reliability also = DataQualityModuleInput.reliability), but the field-by-field enumeration was not finished.

**Resolution for this open thread**: **confirmed, not deferred** — Data Quality and Agreement are not independent; they share their primary input (`reliability`) by construction. This is a real inversion risk (the task notes Data Quality is inverted, Excellent underperforming Limited — plausible if DQ and Agreement are both driven by the same reliability inputs that also determine which modules dominate the ensemble). **Recommend as a Phase-1 P1/P2 item**: either (a) decorrelate Data Quality's inputs from Agreement's inputs (e.g., DQ from raw sample-size/coverage measures, Agreement from post-weighting vote spread only), or (b) if kept coupled, stop presenting them to users as two independent confidence signals — merge or clearly relabel them. Complete the field-by-field enumeration as a first step before deciding.

## 9. Tie-break cascade — HighDisagreement-only gate

**Confirmed live and uncommented in code** (`predictionEngine/index.ts:817-818`):
```ts
const tieBreakerGated = tieBreaker.applied && modelAgreement !== "HighDisagreement"
  ? tieBreaker
  : { ...tieBreaker, applied: false, ... };
```
`applied` is forced `false` unless `modelAgreement === "HighDisagreement"`. Every downstream consumer reads `tieBreakerGated`, not the raw `tieBreaker` (recommendation computation, output fields, recommendation trace) — including a self-verifying trace field, `notHighDisagreement: { actual: modelAgreement, passed: modelAgreement !== "HighDisagreement" }` (line 1225), baked directly into `decisionTrace` for per-prediction auditability. A separate recommendation rule (`r8`) independently excludes both "Mixed" and "HighDisagreement" from a high-confidence path, consistent with the gate's intent.

**Evidence for why**: `.agents/memory/tiebreaker-highDisagreement-gate.md:13-15` — the tie-breaker fired on 28.2% of test-segment rows and cost **−13.34pp overall**; only HighDisagreement showed any (marginal, +1.45pp, noise-level) benefit; Strong −11.30pp, Moderate −17.03pp, Mixed −20.11pp.

**Resolution for this open thread**: **verified — the gate is actually holding in production code, no drift found.** No further action needed for Phase 1 on this specific item.

---

## Summary: open-thread resolutions

| Thread | Status |
|---|---|
| WTA specialist-constraint question | **Resolved** — constraint exists, live, verified not to harm WTA. Caveat: re-verify once §4's DB check confirms which general model the persisted specialist rows actually carry. |
| Market odds n=174 vs n≥200 gate | **Deferred to Phase 1** — keep as documented override, but re-test against current row counts; no code enforces the gate automatically. |
| Frozen vs. dynamic weight backtest | **Resolved — premise corrected.** Form's ensemble-weight *prior* is frozen (no dynamic mechanism exists to backtest); the swings the task observed are in *effective* weight (reliability-driven), a different and already-documented phenomenon. |
| Data Quality / Agreement independence | **Confirmed non-independent**, not deferred — both share `reliability` as their primary input. Flagged as a Phase-1 P1/P2 item. |
| Tie-break cascade gating | **Verified holding in production** — no action needed. |

## Top unresolved question requiring live DB access

**§4**: does `specialist_models` currently hold knots constrained against calibration model #712 (rejected, worse-than-#691) rather than #691 (the actual active general model)? Run before any Phase-1 decision touching specialists:
```sql
SELECT id, active, fitted_at, isotonic_holdout_log_loss FROM calibration_models ORDER BY fitted_at DESC LIMIT 5;
SELECT segment_key, computed_at, meets_threshold, weight FROM specialist_models;
```
