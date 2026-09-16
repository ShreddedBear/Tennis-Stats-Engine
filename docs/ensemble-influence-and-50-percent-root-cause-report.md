# ENSEMBLE INFLUENCE & 50% ROOT-CAUSE REPORT

*P1 Package 4 — Ensemble Influence + 50% Investigation. Generated 2026-09-16.*

**Mandate**: determine whether General/Specialist overpower the other models and whether
correlated evidence is counted multiple times, and separately root-cause the ~50% probability
clustering. **No weights were changed.** This is a diagnostic report only, per the package's
explicit instruction not to treat the ablation harness or these findings as authorization to touch
production weights or calibration.

**Scope / method**: static source-code investigation of `artifacts/api-server/src/services/predictionEngine`,
`.../services/evaluation`, and `.../scripts` in this repo. No database connection is available in
this sandbox, so the existing ablation harness (`services/evaluation/ablation.ts`) and the existing
correlation diagnostic (`scripts/analyzeCorrelatedCoreClusterOverconfidence.ts`) were read in full
but **not executed**. All numeric evidence below is either (a) read directly from committed code
comments that already cite completed prior live runs, or (b) pulled from
`docs/audit-task183-specialist-cascade-exclusion-bias.md`. Section 8 lists exactly what a follow-up
live-DB run needs to confirm.

---

## 1. Executive Summary

**Confirmed from code:**
- General Model and Segment Specialist do **not** re-vote the same trio of signals as independent
  ensemble members. `generalProbability` is a monotonic recalibration (`calibrateProbability` /
  `applyCalibrationOriented`) of the *same* `ensembleProbability` that Surface Elo/Serve &
  Return/Recent Form already produced — it is not a second, independently-computed opinion fed
  back into the weighted sum. This refutes the most literal form of "General re-votes the trio."
  (`artifacts/api-server/src/services/predictionEngine/index.ts:639-672`)
- However, Recent Form's own edge computation **does** reuse the same match-level serve/return
  stat fields (`servicePointsWonPct`, `returnPointsWon`) that Serve & Return uses, blended in at
  25% weight per match (`recentForm.ts:73-81,110-120,153-154`). This is genuine, code-level
  evidence of shared inputs between two nominally "independent" ensemble voters.
- The Monte Carlo simulator's *only* inputs are Surface Elo's win probability and Serve & Return's
  ratings (`simulator.ts:17-22,42-59`) — it is explicitly documented as blind to Recent Form,
  Fatigue, Availability, Head-to-Head, and the specialist blend.
- `ENSEMBLE_WEIGHT_PRIOR` gives Surface Elo/Serve & Return/Recent Form priors of 1.5/1.5/1.3, far
  above Fatigue/Head-to-Head/Availability/MatchLoadRecovery (0.3–0.4) — a **structural, admitted**
  overweighting of the core trio, done deliberately per a 2026-07-13 ablation report
  (`dataQuality.ts:91-118`).
- General Model and Segment Specialist are **not** in `ENSEMBLE_WEIGHT_PRIOR` at all — they aren't
  part of the `buildEnsemble()` weighted sum. Their "weight" in the UI/decision-trace `models[]`
  array (General=1 or 1-specialistWeight, Specialist=specialistWeight) is a display artifact of a
  sequential blend, not an ensemble voting weight comparable to the feature modules'.
- `disagreement.ts` already contains a **completed, cited real-data finding** for the exact
  question Task #146's diagnostic script asks: trio pairwise same-direction rate 74.2% (vs ~50%
  expected if independent); trio-only "Strong" agreement shows log loss 0.715 (worse than a 0.693
  coin flip) vs. 0.692 for genuine trio disagreement (`disagreement.ts:40-55`). This appears to be
  the actual, already-executed answer to what
  `scripts/analyzeCorrelatedCoreClusterOverconfidence.ts` recomputes — the script re-derives it from
  stored rows rather than being unrun code with no answer.
- No completed "50% collapse root-cause" report exists in `docs/` in this repo, nor in
  `tennis-truth-engine-8ecc1270/docs/` — `docs/ROOT_CAUSE_50_PERCENT.md` there is a **verbatim copy
  of the task spec itself**, not a filled-in report. This investigation is the first substantive
  pass.

**Needs a live DB run to confirm:**
- Actual current ablation deltaPoints for each model on the present corpus (last cited numbers are
  from 2026-07-13 to 2026-08-10 audits, now stale).
- Whether real predictions are actually clustering at 50% today, and in what volume/segment — this
  report finds many *legitimate, disclosed* mechanisms that pull toward 50 (thin data, tie
  gates, calibration shrink) but no smoking-gun code bug that silently zeroes real signal.
- Per-model Brier/log-loss/calibration/correlation-with-other-models numbers (item 2 below).

---

## 2. Model Inventory & Measurement Plan (11 metrics)

| # | Metric | Computable now? | Where / how |
|---|---|---|---|
| 1 | Availability rate (module fires vs. defaults) | **Yes** | Each module returns `defaulted: boolean` (`recentForm.ts:23`, `serveReturn.ts:35`, `surfaceElo.ts:46`) and `warnings[]`; aggregate across `decision_trace.modules[].excludedFromEnsemble/rawEdge` or `EngineBreakdown.defaultedInputs` (`index.ts:563-568`). |
| 2 | Sample size per model | **Yes** | `surfaceElo.sampleSizePlayer1/2`, `recentForm` uses `formScore().sample`, `serveReturn` uses `p1Real.sample`/margin `sample` — all already returned in each module's result type. |
| 3 | Accuracy (per model, standalone) | **Partially** — needs instrumentation | `computeSegmentMetrics` (`services/evaluation/metrics.ts`) computes accuracy/logloss/Brier over a row set, but only for the *final* graded outcome, not per-module standalone accuracy. The ablation harness (`ablation.ts`) gets closest by measuring accuracy with/without a model, which is a proxy for the model's marginal accuracy contribution, not standalone accuracy. True standalone per-model accuracy (module's own vote vs. outcome) would need a new script filtering `engine.models[].player1Probability` vs. actual winner. |
| 4 | Brier score per model | **Needs instrumentation** — same as above; `computeSegmentMetrics` already computes Brier for a probability column, so a new script feeding `engine.models[].player1Probability` per model name through the same function would work with no new math. |
| 5 | Log loss per model | **Needs instrumentation** — identical situation to Brier; `computeSegmentMetrics`/`metrics.ts` already has the log-loss formula. |
| 6 | Calibration (reliability curve) per model | **Needs instrumentation** — `services/evaluation/calibration.ts` fits isotonic calibration from `raw_probability -> actual_outcome`; could be re-pointed at a single module's stored probability instead of the ensemble's, but no script does this today. |
| 7 | Mean effective weight | **Yes** | `ModelVote.weightUsed`, persisted per prediction in `decision_trace.modules[].effectiveWeight` (`index.ts:1153-1156`) — a straight `AVG()` over stored rows answers this with no new code. |
| 8 | Mean absolute contribution (weight × \|prob-50\|) | **Yes**, derivable | Same stored fields (`effectiveWeight`, `player1Probability`) let this be computed in a simple query/script; no existing script does it but no new instrumentation is needed, just a query. |
| 9 | Correlation with other models | **Partially** | `analyzeCorrelatedCoreClusterOverconfidence.ts` computes pairwise same-direction rate for the trio + Head-to-Head only (`CORE_TRIO`, `INDEPENDENT_MODULES` in that file, lines 26-30). Extending to all module pairs (Fatigue, Availability, MatchLoadRecovery, Market Consensus) needs a small generalization of that script — the machinery (favorsPlayer1, `EngineBreakdown.models`) already exists. |
| 10 | Marginal contribution (ablation delta) | **Yes**, but requires a live run | `runAblationAnalysis` (`services/evaluation/ablation.ts:371`) does exactly this via `LEAVE_ONE_OUT_VARIANTS` and reports `deltaPoints`/`rank`/`recommendation` per model (lines 288-305, 558-573). Needs `DATABASE_URL` and historical corpus access — cannot be run in this sandbox. |
| 11 | Disagreement frequency | **Yes** | `computeWeightedDisagreement` (`disagreement.ts:125-205`) is called on every live prediction and produces `modelAgreement`/`coreModelsConflict`/`conflictingModels`, persisted in `decision_trace`; `analyzeCorrelatedCoreClusterOverconfidence.ts` already aggregates a version of this (trio-all-agree rate, pairwise agree rate) for stored rows. |

**Bottom line**: metrics 1, 2, 7, 8, 9 (partial), 10 (code exists, needs DB), 11 are computable
today from existing code/fields with at most a new query script. Metrics 3, 4, 5, 6 require a new
(small) script that reuses `computeSegmentMetrics`/`calibration.ts` machinery against a single
module's stored probability rather than the ensemble's — not a new measurement methodology, just
new plumbing pointed at existing per-model data already stored in `evaluation_predictions.feature_snapshot.engine.models`.

---

## 3. Ensemble Weighting Mechanics

### 3.1 How `weightUsed` is computed

`buildEnsemble()` (`artifacts/api-server/src/services/predictionEngine/ensemble.ts:43-71`):

```ts
const priors = modules.map((m) => m.weightPrior ?? 1);
const rawWeights = models.map((m, i) => Math.max(1, m.reliability) * priors[i]);
const totalWeight = rawWeights.reduce((sum, w) => sum + w, 0);
models.forEach((m, i) => {
  m.weightUsed = Math.round((rawWeights[i] / totalWeight) * 1000) / 1000;
});
```

So `weightUsed = max(1, reliability) × weightPrior`, normalized to sum to 1 across whatever set of
modules is actually passed into `buildEnsemble`. `reliability` is each module's own 0–100
confidence-in-its-own-data score (e.g. `surfaceElo.reliability`, computed from effective sample
size, `surfaceElo.ts`), and `weightPrior` comes from `ENSEMBLE_WEIGHT_PRIOR` in `dataQuality.ts`.

### 3.2 Exact prior values (`dataQuality.ts:98-118`)

```ts
export const ENSEMBLE_WEIGHT_PRIOR = {
  surfaceElo: 1.5,
  serveReturn: 1.5,
  recentForm: 1.3,
  fatigue: 0.4,
  headToHead: 0.4,
  availability: 0.4,   // moot -- availability is in EXCLUDED_FROM_ENSEMBLE
  matchLoadRecovery: 0.3,
} as const;
```

Market Consensus gets `weightPrior: 0.5` set inline in `index.ts:525` ("modest supplemental vote;
below the three core signal modules"). **There is no entry for `generalEnsemble` or
`segmentSpecialist`** in this table — they are not members of the set fed into `buildEnsemble()`
at all (see 3.3).

The comment block directly above (`dataQuality.ts:91-96`) states this was a deliberate re-tuning
"from the 2026-07-13 ablation report's leave-one-out deltas: Surface Elo, Serve & Return, and
Recent Form are the only modules whose removal measurably hurt accuracy... and are now the
dominant vote." This is an explicit, documented decision to overweight the trio relative to
Fatigue/H2H/Availability — by design, not an oversight, and grounded in a (now nine-plus-weeks-old)
cited ablation run.

### 3.3 General Model / Segment Specialist do not enter the weighted sum

Reading `runPredictionEngine` (`index.ts:546-552`):

```ts
const ensembleModuleEdges = [
  ...moduleEdges.filter((m) => !excludedModels?.has(m.key) && !EXCLUDED_FROM_ENSEMBLE.has(m.key)),
  ...(marketConsensusInput ? [marketConsensusInput] : []),
];
const { models: featureModels, ensembleProbability: rawEnsembleProbability, modelAgreement: featureAgreement } = buildEnsemble(ensembleModuleEdges);
```

`ensembleModuleEdges` contains only: Surface Elo, Serve & Return, Recent Form, Fatigue,
Availability, Head-to-Head, Match Load Recovery (filtered by `EXCLUDED_FROM_ENSEMBLE`), and Market
Consensus when present. `featureModels`/`rawEnsembleProbability` are the ONLY output of
`buildEnsemble`.

General Model's probability is computed *afterward*, from that same `ensembleProbability`
(`index.ts:639-644`):

```ts
const generalProbability = generalEnsembleExcluded
  ? ensembleProbability
  : input.activeCalibration && input.activeCalibration.length > 0
    ? Math.round(applyCalibrationOriented(input.activeCalibration, ensembleProbability / 100) * 1000) / 10
    : calibrateProbability(ensembleProbability, dataQuality);
```

This is a **monotonic re-mapping** of the trio's already-blended probability (isotonic calibration
or the `calibrateProbability` heuristic shrink toward 50 based on Data Quality) — not a second
independent model output. Segment Specialist similarly reruns `applyCalibrationOriented` on the
**same** `ensembleProbability` through a segment-specific isotonic curve
(`index.ts:663-668`).

`models.push({ modelName: "General Model", ..., weightUsed: specialistApplied ? 1 - specialistWeight : 1, ... })`
(`index.ts:756-762`) — this "weight" is **only used for display/decision-trace and the
General-vs-Specialist secondary disagreement check** (`index.ts:774-782`); it is never fed back
into `buildEnsemble()`. So while General/Specialist show up in `EngineBreakdown.models` alongside
the feature modules (which is what `analyzeCorrelatedCoreClusterOverconfidence.ts` and
`voteFavorsPlayer1` read from), they do not add a second layer of trio-derived signal into the
`ensembleProbability` sum — they recalibrate it once, sequentially.

**Conclusion on "structural overweighting"**: Yes for the trio vs. the other feature modules
(1.5/1.5/1.3 vs 0.3/0.4/0.4/0.4, explicit and documented), but General/Specialist are not additional
independent votes of the same evidence baked into the weighted average — they are recalibration
stages downstream of it. The place double-counting *could* still occur is if General/Specialist's
own calibration curves happen to reproduce the trio's raw signal almost 1:1 (since 
`ensembleProbability` is trio-dominated already) and then get displayed as a fourth/fifth "model"
with its own weight in the UI — which can visually overstate independent confirmation even though
it isn't literally re-summed. This is a presentation risk, not an arithmetic double-count.

---

## 4. Ablation Harness

`artifacts/api-server/src/services/evaluation/ablation.ts` (`runAblationAnalysis`,
`services/evaluation/ablation.ts:371`) replays the full historical corpus (or a stratified
representative sample via `buildRepresentativeSample`, lines 104+) through `runPredictionEngine`
once per **variant**:

- `BASELINE_VARIANT`: everything active.
- `LEAVE_ONE_OUT_VARIANTS` (`ablation.ts:53-58`): one variant per `MODEL_DEFS` entry —
  `surfaceElo`, `serveReturn`, `recentForm`, `fatigue`, `availability`, `headToHead`,
  `matchLoadRecovery`, `generalEnsemble`, `segmentSpecialist` (lines 31-41) — each removes exactly
  that model via `excludedModels` and reruns the engine.
- `COMBO_VARIANTS` (`ablation.ts:60-75`): `combo_everything`, `combo_core_signals_only` (removes
  fatigue/availability/headToHead — i.e. leaves only the trio + market/general/specialist),
  `combo_specialists_off`, `combo_no_calibration_no_specialist` (raw ensemble only, no
  calibration or specialist).
- Market Consensus is explicitly excluded from `MODEL_DEFS` because it never fires on the frozen
  historical corpus (`ablation.ts:20-30`) — a separate script (`scripts/auditMarketConsensusAblation.ts`)
  handles that model.

For each leave-one-out variant, `deltaPoints = ablated.overall - baseline.overall` (accuracy
points; negative means removing the model *hurt* accuracy) drives `rankAndRecommend`
(`ablation.ts:299-305`):
- `deltaPoints <= -3` → "Most Valuable" / Keep
- `-3 < deltaPoints <= -1` → "Valuable" / Keep
- `-1 < deltaPoints < 1` → "Neutral" / Review
- `1 <= deltaPoints < 3` → "Weak" / Candidate for lower weight
- `deltaPoints >= 3` → "Harmful" / Candidate for lower weight

The report also breaks deltas down `byTour`, `bySurface`, and `byDataQuality` (high/low), plus
diagnostic rows for losing-prediction attribution, overconfident-strong-vote failure rate,
confidence miscalibration, and dissent-from-final-prediction, all keyed by `MODEL_DEFS`
(`ablation.ts:558-660`).

**How to run it (once DB access exists)**: `POST /api/evaluation/ablation/run`
(`routes/evaluation.ts:2001`), which calls `startAblationJob` →
`services/evaluation/ablationJob.ts:56` → `runAblationAnalysis(...)`. Equivalently from a shell
with a live `DATABASE_URL`: `pnpm --filter @workspace/api-server exec tsx
src/scripts/analyzeCorrelatedCoreClusterOverconfidence.ts` style invocation would be for the
diagnostic script; the ablation itself is driven through the job/route rather than a standalone
CLI script (no bare `tsx ablation.ts` entry point exists — it's a library called by the job/route
layer). `getAblationJobStatus` polls progress; the finished `AblationReport` has `modelDeltas[]`
(`deltaPoints`, `rank`, `recommendation`, `byTour`/`bySurface`/`byDataQuality` breakdowns) directly
usable to fill in Section 2's items 3–6/9/10 once numbers exist.

**Caveat**: `dataQuality.ts`'s comments cite a 2026-07-13 run (n=13,066–18,281 depending on the
audit) and later 2026-07-14/2026-07-15 re-checks; these are all now dated relative to "today"
(2026-09-16 per the session), and the corpus has grown since ("since 7x-grown historical corpus" is
mentioned in `calibration.ts:26-32`). Any new ablation run should be treated as the current source
of truth, not the numbers quoted here.

---

## 5. Correlation & Double-Counting Analysis

### 5.1 Recent Form vs. Serve & Return — confirmed shared inputs

`serveReturn.ts`'s primary path (`realRatingsFromStats`, lines 209-234) reads
`m.stats.servicePointsWonPct` / `m.stats.returnPointsWon` directly from `MatchRecord.stats`.

`recentForm.ts`'s `serveReturnQualityRating()` (lines 104-120) reads the **exact same two fields**
from the **exact same** `MatchRecord.stats`:

```ts
function serveReturnQualityRating(match: MatchRecord): number | null {
  const servicePct = match.stats?.servicePointsWonPct ?? null;
  const returnPct = match.stats?.returnPointsWon ?? null;
  ...
}
```

and blends it into every match's contribution to the form score at `SERVE_RETURN_BLEND_WEIGHT =
0.25` (`recentForm.ts:81,154`):

```ts
const contribution = srRating !== null
  ? outcomeContribution * (1 - SERVE_RETURN_BLEND_WEIGHT) + (srRating / 100) * SERVE_RETURN_BLEND_WEIGHT
  : outcomeContribution;
```

This is concrete, unambiguous evidence that 25% of Recent Form's per-match contribution (when
provider stats are available) is literally the same signal Serve & Return computes independently
— not merely correlated via shared match history, but derived from the identical fields. Both
modules also apply the same `SURFACE_MISMATCH_WEIGHT = 0.7` de-weighting and reuse the same
`OpponentEloLookup`/opponent-strength machinery (`opponentStrength.ts`) to weight matches by
opponent strength — another shared input path (both modules import `type { OpponentEloLookup }
from "./opponentStrength"` and consume the same per-match Elo lookup built once in
`index.ts:374-386` and passed to both `computeServeReturnModule` and `computeRecentFormModule`).

### 5.2 Surface Elo — shares the same match-history rows, not literally the same fields

`surfaceElo.ts` builds its rating from `MatchRecord[]` win/loss + opponent Elo (Elo update
formula), not from `servicePointsWonPct`/`returnPointsWon` directly — so it doesn't share the exact
field-level overlap Recent Form/Serve & Return have with each other. But it consumes the **same
underlying match rows** (`input.player1Matches`/`input.player2Matches`, passed unfiltered to all
three modules in `index.ts:374-390`) and the **same opponent-Elo lookup**
(`player1OpponentElo`/`player2OpponentElo`, built once and reused across Surface Elo, Serve &
Return, and Recent Form — `index.ts:371-372,374-390`). This is the weaker, "same underlying
history, different transform" flavor of correlation that `disagreement.ts`'s own comment
(`disagreement.ts:40-53`) already describes and quantifies (74.2% pairwise agreement).

### 5.3 Monte Carlo simulator — confirmed narrow, two-signal input

`simulator.ts:42` — `deriveServicePointEstimate(surfaceElo: SurfaceEloResult, serveReturn:
ServeReturnResult)` — takes exactly these two module outputs and nothing else:

```ts
const eloEdge = (surfaceElo.eloWinProbabilityPlayer1 / 100 - 0.5) / 8;
const p1ServeEdge = (serveReturn.player1ServeRating - serveReturn.player2ReturnRating) / 10 / 100 * 1.5;
const p2ServeEdge = (serveReturn.player2ServeRating - serveReturn.player1ReturnRating) / 10 / 100 * 1.5;
const reliability = Math.round(Math.min(surfaceElo.reliability, serveReturn.reliability));
```

The file's own header comment (lines 6-22) states this explicitly: "this narrow two-signal input
scope (Surface Elo + Serve & Return only, never Recent Form/Fatigue/Availability/Head-to-
Head/the specialist blend) is exactly why this simulator's `player1WinProbability` can disagree
sharply... with the card's final ensemble probability." `index.ts` independently measures and
corrects for this scope mismatch via `simulatorScopeGap`/`simulatorScopeScale`
(`index.ts:713-741`), scaling the simulator's blend weight down (never up) when a signal outside
its scope (Recent Form, Fatigue, Availability, H2H, MatchLoadRecovery, the specialist, or the
General Model's own `dataQuality` reliability) is more reliable than the simulator's own two-signal
reliability floor. So the simulator both reuses Surface Elo/Serve & Return AND is a third
consumer of the same evidence those two modules already vote with in the ensemble — but its final
blend weight is explicitly discounted for exactly that reason, which is a real, coded mitigation,
not just documentation.

### 5.4 General Model / Segment Specialist re-voting the trio — refuted (see §3.3)

As shown in §3.3, General Model's and Segment Specialist's probabilities are calibration
transforms of `ensembleProbability`, not independently-computed re-runs of Surface
Elo/Serve&Return/Recent Form. They do NOT feed back into `buildEnsemble()`'s weighted sum. This
means the crux hypothesis in the task ("is General Model itself a function of the trio, and then
the trio ALSO votes separately, double-counting") is **partially true but not in the arithmetic
sense feared**: General Model *is* a function of the trio (via `ensembleProbability`), and the trio
*does* also appear separately in `EngineBreakdown.models[]` — but General Model's `weightUsed` is
not summed against the trio's `weightUsed` inside a shared normalization; it's a sequential
recalibration stage displayed alongside the feature votes. The double-counting risk that IS real is
in `computeWeightedDisagreement`'s optional secondary calls (`index.ts:775-782,792-799`), which
compute a 2-model disagreement between "General Model" and "Segment Specialist" using
`weightUsed: 1 - specialistWeight` / `specialistWeight` as if they were two independent votes; since
General Model's probability is itself trio-derived, this secondary check is comparing "trio,
recalibrated one way" against "trio, recalibrated another way" — a comparison of two calibration
curves fitted to the same base signal, which is a legitimate way to detect a specialist that
disagrees with the general-model calibration, but not a check that surfaces independent evidence.

### 5.5 Cross-reference with `analyzeCorrelatedCoreClusterOverconfidence.ts`'s assumptions

The script's own header (`analyzeCorrelatedCoreClusterOverconfidence.ts:1-30`) explicitly limits
its `INDEPENDENT_MODULES` set to `["Head-to-Head"]`, with the comment: "Fatigue/Availability/Match
Load Recovery are excluded from the ensemble VOTE... so they never appear in `engine.models` at
all -- Head-to-Head is the only genuinely-independent module that actually votes alongside the
trio." This is accurate per `EXCLUDED_FROM_ENSEMBLE = new Set(["availability", "fatigue",
"matchLoadRecovery"])` (`dataQuality.ts:181`) — confirmed correct, not an assumption needing
correction. The script does **not** treat General Model/Segment Specialist as independent
confirmers of the trio (they're absent from both `CORE_TRIO` and `INDEPENDENT_MODULES`), so it
implicitly agrees with §3.3/§5.4's finding that General/Specialist aren't a source of the same kind
of double-counting the trio itself is. What the script measures — and what `disagreement.ts`'s own
comment already answers with real numbers (§5.6) — is purely about the trio's *internal*
correlation, which is the genuine, already-demonstrated double-counting concern in this system.

### 5.6 The double-counting finding that already exists

`disagreement.ts:40-55` cites a completed analysis over 1,031 graded rows
(`docs/audit-task146-correlated-cluster-overconfidence.md`, not present in the current `docs/`
listing but referenced inline — likely superseded/archived, or produced by an earlier run of this
same script):

- Trio pairwise same-direction rate: **74.2%** (vs. ~50% expected under independence).
- With Fatigue/Availability/MatchLoadRecovery excluded from the vote, Head-to-Head is the *only*
  other module that ever votes alongside the trio, and it never reaches
  `MEANINGFUL_WEIGHT_SHARE` (0.15) — so every "Strong" agreement reading in practice is trio-only,
  with no genuinely independent confirmation.
- Trio-only-driven "Strong" rows: log loss **0.715** (worse than a 0.693 coin flip), ECE 0.079.
- Genuine trio-disagreement rows: log loss **0.692**, ECE 0.040 — both markedly better.

This is a structural finding of real over-trust in correlated agreement, already partially
remediated by `collapseCorrelatedCluster()` in `disagreement.ts:68-93`, which merges the trio into
one combined vote for the purposes of computing `weightedStdDev`/`leadingSupportPercent` (so their
mutual agreement can't manufacture an artificially tight spread) — while deliberately leaving
`coreModelsConflict`/`ensembleProbability` itself untouched (the collapse doesn't change the actual
blended probability, only the disagreement/agreement label). **This means the fix targets the
`modelAgreement` label and Elite-tier gating, not the raw probability magnitude** — so it would not
by itself explain a 50%-clustering pattern in `calibratedProbability`, only in the confidence label
attached to it.

---

## 6. 50% Root-Cause Trace

### 6.1 Pipeline stages, in order (`index.ts`)

1. **Module edges computed** (lines 374-477): Surface Elo, Serve & Return, Recent Form, Fatigue,
   Availability, Head-to-Head, Match Load Recovery — each independently defaults to a neutral
   value when its own inputs are empty:
   - `recentForm.ts:133`: `if (recent.length === 0) return { form: 50, ... }` — literal 50 default
     when a player has zero matches in the window.
   - `serveReturn.ts:183`: `if (withMargins.length === 0) return { serve: 50, ret: 50, ... }` —
     same, for the margin-proxy path.
   - These are legitimate "no information → neutral" defaults, not bugs, but they DO mean a
     zero-history player pulls that module's edge to exactly 0 (`50-50=0`), which then feeds
     `edgeToProbability(0) = 50.0` for that module specifically.
2. **`edgeToProbability`** (`ensemble.ts:17-20`): `Math.round((1 / (1 + Math.exp(-clamped/12))) *
   1000) / 10`. At `edge=0` this is exactly `50.0` (sigmoid centered at 0). At small edges (±2) it
   is `~50 ± 8.3` scaled by the /12 divisor — e.g. edge=2 → `1/(1+e^{-2/12})*100 ≈ 54.2`. This is
   the **intended, designed response of a sigmoid to small edges**, not signal loss — a genuinely
   small edge (players are close in the underlying metric) SHOULD map close to 50. The distinction
   the task asks for: this is "real 50/50" when the edge itself is small because the underlying
   evidence (Elo gap, form gap) is genuinely small; it becomes "signal lost before reaching here"
   only if the edge computation upstream (in `index.ts`, e.g. `rawEloEdge = surfaceElo.eloDifference
   / 8`) is itself artificially zeroed — which happens exactly when both players have equal/no
   history (module defaults, point 1 above), not from a bug in `edgeToProbability` itself.
3. **Ensemble weighted average** (`ensemble.ts:63`): `Math.round(ensembleProbability * 10) / 10` —
   one rounding step to 1 decimal.
4. **Tie-breaker gate** (`index.ts:570-583`, `tieBreakers.ts` — not fully read here but referenced):
   `tieBreakerGated.applied` no longer nudges the probability (2026-07-15 removal, `index.ts:91-98`)
   — `adjustedProbability === rawEnsembleProbability` always. It only sets a flag that forces
   `INSUFFICIENT_EDGE` in `computeRecommendation` when `modelAgreement === "HighDisagreement"`
   (`index.ts:802-820`). So the tie-breaker mechanism itself no longer collapses probabilities
   toward 50 — it used to (a "directional cascade"), and was explicitly removed because "every step
   performed at or below a coin flip in the tight-signal regime" (comment at `index.ts:91-95`).
5. **Calibration** (`index.ts:639-644`): either `applyCalibrationOriented` (fitted isotonic) or the
   `calibrateProbability` fallback heuristic (`calibration.ts:47-62`), which explicitly shrinks
   toward 50 by a `confidenceFactor` between 0.4 and 0.85 depending on `dataQuality`:
   ```ts
   const calibrated = 50 + (rawProbability - 50) * confidenceFactor;
   return Math.round(Math.max(5, Math.min(95, calibrated)) * 10) / 10;
   ```
   At `dataQuality < 20`, `confidenceFactor = 0.4` — a raw 70% probability becomes `50 +
   20*0.4 = 58%`. This is a **deliberate, documented, and heavily re-validated shrink** (see the
   long comment history in `calibration.ts:1-46` citing multiple audits from Task #75 through
   Task #157) — not an accidental collapse. It is the single largest engineered pull-toward-50 in
   the whole pipeline, and it fires hardest exactly when Data Quality is low (thin data), which is
   the intended behavior per its own design rationale.
6. **Specialist blend** (`index.ts:670-672`): weighted average of General and Specialist
   probabilities — another rounding step (`Math.round(...*10)/10`).
7. **Reliability discount** (`index.ts:695-704`): `TOUR_RELIABILITY_DISCOUNT.ATP = 0.63` and
   `LOW_SURFACE_SAMPLE_DISCOUNT = 0.75`, multiplicative, applied via the same `50 + (x-50)*discount`
   pattern — ANOTHER shrink-toward-50 stage, but explicitly gated OFF once real fitted calibration
   is active (`usingRealCalibration` check, `index.ts:693-700`) specifically to avoid
   double-shrinking (documented as a fixed double-correction bug at Task #33, `dataQuality.ts:226-231`).
8. **Simulator blend** (`index.ts:744-746`): weighted average with the Monte Carlo output — another
   rounding step.
9. **Hard clamp** (`index.ts:754`): `Math.max(0.6, Math.min(99.4, calibratedProbabilityRaw))` — the
   engine can never output exactly 0% or 100%, and by construction never outputs exactly 50%
   either unless every upstream stage independently lands there (there is no explicit `|| 50` or
   `?? 50` fallback anywhere in the pipeline — see grep results below).

### 6.2 Literal `0.5`/`50` occurrences found (full-repo grep of `predictionEngine/*.ts`, excluding tests)

| File:line | Context | When it fires |
|---|---|---|
| `recentForm.ts:133` | `return { form: 50, ... }` | Player has 0 matches in the 10-match window |
| `serveReturn.ts:183` | `return { serve: 50, ret: 50, ... }` | Player has 0 matches with real set-score margins (proxy path) |
| `recentForm.ts:152` | `0.5 + p.performanceDelta / 2` | Per-match outcome contribution when opponent Elo is known (not a fallback — this is the normal formula centering a ±1 delta on 0.5) |
| `disagreement.ts:135` | `leadingSupportPercent: 50, player1SupportPercent: 50` | Empty/zero-weight model list — explicitly a fixed 2026 bug fix so an empty list can't fabricate 100% support for player 2 (comment lines 128-136) |
| `classificationPolicy.ts:51` | `CAUTION_MAX: 50` | A named threshold constant, not a probability fallback |
| `calibration.ts:60` | `50 + (rawProbability - 50) * confidenceFactor` | Every fallback-calibration call (dataQuality-based shrink toward 50; see §6.1.5) |
| `ensemble.ts:19` | `edgeToProbability`'s sigmoid, centered at edge=0 → 50.0 | Any module whose edge is exactly 0 (equal-strength or defaulted-equal inputs) |
| `index.ts:703` | `50 + (blendedProbability - 50) * reliabilityDiscount` | ATP/thin-surface-sample discount (see §6.1.7) |

No occurrence of `?? 50`, `|| 50`, or a raw `probability = 0.5` fallback exists anywhere in
`predictionEngine/` — every 50-adjacent value found is either (a) an explicit, documented "neutral
= no data" module default (2 occurrences), (b) part of the intended shrink-toward-50 calibration
math (2 occurrences), or (c) the mathematically correct behavior of a sigmoid/support calculation
at a genuine zero/tie input (2 occurrences). **No hidden "silently force to 50%" bug was found in
this codebase.**

### 6.3 Rounding compounding

Every stage rounds to one decimal place independently:
`ensemble.ts:70` (`ensembleProbability`), `ensemble.ts:47` (`shrunkProbability`), `calibration.ts:61`
(`calibrateProbability`), `index.ts:643` (`generalProbability`), `index.ts:666` (`specialistProbability`),
`index.ts:671` (`blendedProbability`), `index.ts:703` (`preSimulatorProbability`), `index.ts:745`
(`calibratedProbabilityRaw`). With up to 7 sequential `Math.round(x*10)/10` operations, each ±0.05
rounding error can in principle compound to roughly ±0.3-0.4 points of drift by the final output —
small in absolute terms, but real, and it means two matches with genuinely tiny (sub-0.1pt) input
differences could occasionally round to the identical final number, contributing to visible
"clustering" at specific values (e.g. 49.9/50.0/50.1) without any single stage being at fault. This
is a candidate contributor to *visual* banding around 50 in aggregate distributions, distinct from
an actual information-loss bug.

### 6.4 Real vs. artifactual 50%

Based on the trace above, the pipeline has **at least four independent, legitimate reasons** a
match can land near 50% without a bug:
1. Genuinely balanced Elo/form/serve-return inputs (real 50/50 matchup).
2. Zero-history player on one or both sides → multiple modules independently default to their own
   neutral value, and the `ZERO_HISTORY_MODULE_FLOOR = 40` reliability floor (`index.ts:604-616`)
   plus low `dataQuality` triggers the heaviest calibration shrink (`confidenceFactor=0.4`) — this
   pulls a might-be-differentiated raw edge hard toward 50, which is a *designed* conservative
   response to a genuine data gap, not a computation error, but IS a place where real (if thin)
   signal gets heavily discounted.
3. `HighDisagreement` matches where the trio splits — `computeRecommendation`'s margin<8 rule
   (`index.ts:272-274`) forces `INSUFFICIENT_EDGE`, but this does not itself change
   `calibratedProbability`; it only changes the recommendation label.
4. Segments with no specialist and `TOUR_RELIABILITY_DISCOUNT`/`LOW_SURFACE_SAMPLE_DISCOUNT` firing
   (only when NOT using real fitted calibration) — an additional multiplicative shrink toward 50 for
   ATP matches and thin-surface-sample matches specifically.

None of these four is "signal silently zeroed" — all are visible, documented, and disclosed via
`disclosures[]`/`decisionTrace` fields. The strongest candidate for *unintended* clustering is #2
combined with #4: a zero/thin-history player on a thin-sample surface, on the ATP tour, with no
active fitted calibration, would compound the DQ shrink (`confidenceFactor` as low as 0.4) with the
`0.63 × 0.75 = 0.4725` reliability discount — a raw 70-point edge could be shrunk to roughly `50 +
20*0.4*0.4725 ≈ 53.8` in the worst case, which would visually read as "the model has no opinion" for
a match where some real (if thin) signal existed. This compounding is real and code-confirmed, but
it is explicitly gated OFF once a fitted calibration model is active
(`usingRealCalibration`, `index.ts:693-700`) — so whether it's actually firing today depends on
whether `input.activeCalibration` is populated in production, which needs a live check.

---

## 7. Prior Empirical Evidence

From `docs/audit-task183-specialist-cascade-exclusion-bias.md` (Task #183, completed 2026-08-10,
read-only, real DB numbers):

- The cascade-exclusion filter (`isKnownBadCascadeRow` in `calibration.ts`) is currently **inert**
  — zero rows excluded from any of the 8 ATP/WTA × Hard/Clay/Grass/IndoorHard specialist training
  segments, because all training rows post-date the `CASCADE_CUTOFF_DATE` (2026-07-15).
- `tieBreakerApplied=true` rows are concentrated exclusively in the 50–54% confidence band across
  all 8 segments (58.6%–65.2% of that band's rows), confirming the cascade/tie-break mechanism only
  ever fired on already-close calls, not on confidently-differentiated matches.
- Current specialist weights (2026-08-08 walk-forward run): ATP-Clay 0.728, ATP-Grass 0.736,
  ATP-Hard 0.702, ATP-IndoorHard 0.850, WTA-Clay 0.850, WTA-Grass 0.850, WTA-Hard 0.850,
  WTA-IndoorHard 0.737 — i.e. specialist weights in the 0.70–0.85 range cited in the task context.
- WTA log-loss improvements over the general model were large: WTA-Clay +0.2029, WTA-Grass
  +0.1919, WTA-Hard +0.1092, WTA-IndoorHard +0.3752 nats — vs. much smaller ATP improvements
  (ATP-Hard +0.0005, ATP-Clay +0.0070, ATP-Grass +0.0089), except ATP-IndoorHard (+0.2521, small
  n=386).
- Accuracy in the 50–54% band is close to 50/50 for both tours (44.4%–60.1%), confirming these are
  genuinely hard matches rather than a labeling artifact.

From `dataQuality.ts`'s inline citations (not independently re-verified against a live DB in this
session, but part of the committed record):
- 2026-07-13 full-corpus ablation (n=13,066–18,281 depending on the specific audit cited):
  Surface Elo/Serve & Return/Recent Form are the only modules whose removal measurably hurt
  accuracy; Availability's inclusion cost -0.1pt; Fatigue showed an inverted relationship (more
  "fatigued" player won 54.9% of matches, worsening to 61.7% at the widest gaps) attributed to
  tournament-survivorship confound, not real fatigue signal.
- Match Load Recovery: 4,001-match leave-one-out ablation found 83/2,820 predictions flip on
  removal but overall accuracy unchanged at 57.3% both ways.
- Market Consensus: activated via a documented override of an n≥200 threshold (actual n=174),
  Δaccuracy +3.45pp, Δlog-loss −0.0519, both clearing the effect-size bar but not the sample-size
  gate — explicitly logged as "NOT a Section B pass," override justified by stability across 3 runs
  (Δacc 3.45–3.80pp).
- ATP tour-level accuracy gap: 54.6% (n=1,242) vs. pooled 57.3% — basis for
  `TOUR_RELIABILITY_DISCOUNT.ATP = 0.63`.
- Data Quality miscalibration: DQ 85–100 band showed 10.7pt overconfidence and log loss 0.719
  (worse than a 0.693 coin flip) — basis for `calibrateProbability`'s counterintuitive "trust peaks
  at DQ 55–65, then decays" curve.

All of these numbers are 5–9+ weeks old relative to the stated "today" (2026-09-16) and are
explicitly flagged in the source comments as needing periodic re-validation as the corpus grows
(e.g. `calibration.ts:26-32` notes the corpus grew "7x" between two of its own re-checks).

---

## 8. Open Questions / What Requires a Live DB Run

1. **Current ablation deltas** — none of the deltaPoints numbers above are fresher than
   2026-08-10; a fresh `runAblationAnalysis` call is needed to know whether Surface
   Elo/Serve&Return/Recent Form's dominance is still justified on the current (larger) corpus.
2. **Whether `input.activeCalibration` is populated in live production traffic** — this determines
   whether `TOUR_RELIABILITY_DISCOUNT`/`LOW_SURFACE_SAMPLE_DISCOUNT` (§6.4's compounding scenario)
   are actually firing today or are dormant because real fitted calibration is active.
3. **Actual distribution of `calibratedProbability`** across recent live/paper-trade predictions —
   this report identifies mechanisms that CAN pull toward 50 but has no live data confirming actual
   clustering severity, segment concentration (ATP vs WTA, thin-surface vs deep-surface), or
   whether it's within the range these documented, intentional shrink mechanisms would produce.
4. **Per-model standalone accuracy/Brier/log-loss/calibration** (Section 2, items 3–6) — need a new
   (small) script reusing `computeSegmentMetrics`/`calibration.ts` against each module's own stored
   `player1Probability`, not just the ensemble/final outcome.
5. **Full pairwise correlation matrix** across all modules (not just the trio + Head-to-Head) —
   extending `analyzeCorrelatedCoreClusterOverconfidence.ts`'s logic to Fatigue/Availability/
   MatchLoadRecovery/Market Consensus even though they don't vote, to check whether they'd be
   correlated with the trio if they DID vote (relevant to any future re-inclusion decision).
6. **Whether the docs/audit-task146-correlated-cluster-overconfidence.md file cited inline in
   `disagreement.ts:44` still exists / is current** — it is not present in the current `docs/`
   directory listing, so either it was archived/renamed or the citation predates a doc cleanup;
   worth confirming its 1,031-row finding still holds on the current, larger corpus.
7. **`tieBreakers.ts` internals** were not read in full in this pass (only referenced via its call
   site in `index.ts:570-583`); its `applied`/`decidingStep`/`note` semantics are inferred from
   `index.ts`'s usage and comments, not from a direct read of `applyTieBreaker`'s implementation.

---

## 9. No Weights Changed

This investigation is read-only. No source file, weight, prior, threshold, or configuration value
in `artifacts/api-server/src/services/predictionEngine`, `artifacts/api-server/src/services/evaluation`,
or `artifacts/api-server/src/scripts` was modified. No script or migration was run, and no database
connection was made or attempted (none is available in this sandbox). All quoted numbers are either
read verbatim from committed source comments/docs or newly derived by static reading of the current
code — none were produced by executing the ablation harness or any other script against live or
historical data.
