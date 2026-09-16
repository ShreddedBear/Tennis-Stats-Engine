# MODEL TRUTH FORENSIC REPORT

**P0 Package 1 — Model Truth, Provenance & Forensic Audit**
Scope: Specialist Model, General Model, Serve & Return, Recent Form, Surface Elo — the prediction engine in `artifacts/api-server/src/services/predictionEngine/` (this repository, referred to internally in some places as "Tennis Matrix" / "TennisMatrixAI").

This is a **read-only forensic audit**. No model weights, thresholds, or methodology were changed while producing this report. Where a number looked wrong or undesirable, it is flagged as a finding, not corrected.

---

## 1. Executive Summary

The headline conclusion of this audit: **the prediction engine's displayed model numbers are, overwhelmingly, genuinely calculated from real inputs — not fabricated, and not silently defaulted to 50%.** Every one of the five audited models (Surface Elo, Serve & Return, Recent Form, General Model, Specialist Model) traces back to real provider data (match results, per-match point statistics, rankings/tour metadata) through documented, code-cited formulas. When a model's underlying data is thin (e.g. a player with 2 career matches on a surface, or two players who have never met), the code discounts that model's reliability and ensemble weight proportionally — it does not invent a value, and it does not quietly replace the missing model with a 50/50 coin-flip vote. This "absence ≠ neutral vote" invariant is enforced by the ensemble renormalization design and is directly asserted in code comments (`index.ts:489`, `types.ts:102`) and covered by an automated regression suite (`swapInvariance.test.ts`).

However, this audit also surfaces four categories of finding that a naive read of the displayed numbers would miss:

1. **Several of the exact fields this audit was asked to check — Favored, Contribution, Availability, and Sample, in the per-model breakdown table — are not backend fields at all.** They are computed **client-side**, in the React UI (`PredictionResult.tsx` / `predictionCopyText.ts`), from two real backend numbers (`player1Probability`, `weightUsed`) using formulas invented in the frontend. The "Contribution" formula in particular (`probability × weight`, not `(probability − 50) × weight`) does not measure what its label implies — see §6. This is the single most important finding of this audit.
2. **The two prediction snapshots used as this audit's forensic exhibits (dated 2026-07-13) were captured at almost exactly the moment several ensemble-inclusion decisions changed.** Fatigue and Availability both cast real, non-zero ensemble votes in these historical records; current code (`dataQuality.ts`, `EXCLUDED_FROM_ENSEMBLE`) fully excludes both from the ensemble vote, citing a "2026-07-13 ablation report" as the basis. The numbers in the exhibits are not fabricated — they are real for the engine version that generated them — but they are not representative of current live methodology. This is flagged per-match in §8 rather than silently normalized away.
3. **One sampled match (#388, "ATP Challenger Pozoblanco") shows the Specialist Model applying to a match whose `tournamentLevel` is `Challenger`**, which current code's own segment-resolution logic (`segments.ts`) documents as a tour that should never qualify for a specialist segment. This could not be conclusively resolved with the access available in this session (no live DB, shallow git clone) and is flagged as an unresolved anomaly requiring a live-DB follow-up, not asserted as a confirmed bug.
4. **A missing Specialist Model prediction never becomes a silent 50% vote.** Every exclusion path (unsupported tour, unsupported surface, below the 150-historical-match / 30-validation-sample thresholds, a failed accuracy/log-loss performance gate, or the hardcoded Clay-wide disable) removes the Specialist's weight from the ensemble entirely via renormalization and leaves the General Model absorbing 100% of that weight — never a defaulted probability. Every exclusion is disclosed in a mandatory, always-present, human-readable `segmentNote` string — there is no code path that silently omits the explanation.

## 2. Methodology & Access Limitations

This audit was performed against two repositories:
- `tennis-stats-engine` — the actual prediction engine (the system in scope for this audit).
- `tennis-truth-engine-8ecc1270` — a separate, unrelated Lovable-built application ("Tennis Matrix Independent Verification & Audit System") that ingests *external* PDF summaries of Matrix predictions for independent verification. It is architecturally downstream of, and has no source-code relationship to, the prediction engine audited here; it is mentioned only because its README's field list ("General Model", "Specialist Model", "Serve & Return", "Recent Form", "surface Elo") is where this task's terminology comes from. No further findings in this report concern that repository.

This session had **no live `DATABASE_URL` or `API_TENNIS_KEY` credentials**, so the prediction engine could not be invoked live against real upcoming matches, and the historical Postgres tables (`historical_matches`, `specialist_models`, `predictions`, etc.) could not be queried directly. Two things substitute for that access, and both have caveats disclosed here rather than hidden:

- **Static source-code audit** (primary basis for §3–§7): every claim about *how* a number is calculated is cited to a specific file and line number in the repository as checked out at the time of this audit (a shallow, depth-1 git clone — full commit history and `git blame` were not available, which limited this audit's ability to independently date some code changes; where a code comment cites a date or ablation report, that citation is repeated as the source, not independently re-verified).
- **Real persisted prediction records** (primary basis for §8, the 26-match forensic log): this repository ships two committed JSON exports at `artifacts/api-server/predictions_backup_2026-07-13T22-51-29-114Z.json` and `predictions_backup_2026-07-13T23-16-23-444Z.json`, together containing 440 unique, real, previously-generated predictions (deduplicated by `id`), each with the engine's full per-model breakdown, decision notes, and (for 397 of them) actual match outcomes. These are genuine historical exhibits, not synthetic test fixtures, and are the only real forensic match data available without live credentials. Their generation timestamp (2026-07-13) is a hard limitation: as noted in §1, it predates some subsequent methodology changes, so this audit treats them as "true for their generation date" rather than "true today," and calls that out per-model where it applies (Fatigue, Availability).

No values were manufactured to fill gaps. Where a question could not be answered from the code or the available data, this report says so explicitly (e.g. §8's Match #388 anomaly) rather than guessing.

## 3. Orchestration & Ensemble Layer

The engine (`index.ts`, `ensemble.ts`) builds seven candidate feature modules per match — Surface Elo, Serve & Return, Recent Form, Fatigue, Availability, Head-to-Head, Match Load Recovery (`index.ts:374-477`) — plus an optional Market Consensus vote when real bookmaker odds are supplied (`index.ts:498-527`).

**Which modules actually vote on the final probability.** Fatigue, Availability, and Match Load Recovery are computed in full (and disclosed in full) but are excluded from the probability calculation itself: `EXCLUDED_FROM_ENSEMBLE = new Set(["availability","fatigue","matchLoadRecovery"])` (`dataQuality.ts:181`). The actual ensemble vote is Surface Elo + Serve & Return + Recent Form + Head-to-Head (+ Market Consensus when present) (`index.ts:546-551`). A separate, only-partially-overlapping exclusion set, `EXCLUDED_FROM_DATA_QUALITY = {headToHead, fatigue, availability, matchLoadRecovery, marketOdds}` (`dataQuality.ts:82`), governs a different downstream number (the `dataQuality` score) — so Head-to-Head votes on the probability but not on data quality, while Fatigue/Availability/Match Load Recovery do neither. This is a real, deliberate, documented split (each exclusion decision is cited to its own ablation finding in the surrounding comments), but it means three plainly-labeled "models" in the UI (Fatigue, Availability, Match Load Recovery) never influence the number a viewer is looking at, in either of the two ways a viewer might assume they do.

**Combination formula.** Each voting module's signed edge is passed through a logistic, `edgeToProbability(edge) = 1/(1+exp(-edge/12))*100` (`ensemble.ts:17-20`). Each module's ensemble weight is `max(1, reliability) × weightPrior`, normalized so all weights sum to 1 (`ensemble.ts:56-61`); `weightPrior` is a static config constant (`ENSEMBLE_WEIGHT_PRIOR`, `dataQuality.ts:98-118`: Surface Elo 1.5, Serve & Return 1.5, Recent Form 1.3, Fatigue 0.4, Head-to-Head 0.4, Availability 0.4, Match Load Recovery 0.3 — unused for the three permanently-excluded modules). The raw ensemble probability is the weight-normalized average of each module's own logistic-transformed probability (`ensemble.ts:63`) — a weighted average of independently-computed per-model probabilities, not one joint multivariate model.

On top of that raw ensemble, in order: a tie-breaker pass (`tieBreakers.ts` — as of the current code this stage **never changes the probability**, only flips a disclosure flag; the "tie-breaker" name is a holdover from before this stage was gutted), general calibration (isotonic if a fitted `activeCalibration` curve is supplied, else a data-quality-based shrink heuristic), the Specialist Model blend (§5.4), a reliability discount shrinking toward 50, an optional Monte Carlo simulator blend, and finally a hard clamp to `[0.6, 99.4]` (`index.ts:632-754`).

**"Effective Weight" (`weightUsed`).** Computed once, correctly, per model: `weightUsed = rawWeight / totalWeight` where `rawWeight = max(1, reliability) × weightPrior` (`ensemble.ts:56-61`). This is a real, DERIVED number for every module that is actually passed into `buildEnsemble` — see §6 for how this legitimate number is nonetheless used to build a separately-invented, less-legitimate "Contribution" number in the UI.

**No "Contribution" field exists anywhere in the backend.** `ModelVote` (`ensemble.ts:3-8`) carries only `modelName, player1Probability, weightUsed, reliability` — no field computes `weightUsed × (player1Probability − 50)` or any other share-of-edge quantity. If a "Contribution" number is displayed, it is not a backend fact (§6 identifies exactly where and how it's invented).

**"Favored" (winner).** Per-model: `player1Probability >= 50` (consistently, across `eliteTier.ts:158-161`, `index.ts:1139-1140`, `disagreement.ts`). Overall predicted winner: driven by the final **calibrated** probability (`calibratedProbability >= 50`, `index.ts:914-916`), never the raw ensemble probability — this exact distinction (final calibrated winner vs. raw-ensemble-implied winner) is defended by a dedicated regression test (`swapInvariance.test.ts:337-350`).

**Weight redistribution on absence.** There is no separate "redistribute the missing model's weight" step — because `buildEnsemble` normalizes by the sum of whichever weights are actually present, omitting a model (via `EXCLUDED_FROM_ENSEMBLE`, an ablation run's `excludedModels`, or Market Consensus simply not being present) automatically and proportionally redistributes its share to the remaining voting models. This is explicit, deliberate design, documented in two places specifically to rule out a 50/50 substitute: `index.ts:489` ("Absence does NOT synthesize a 50/50 neutral vote — that adds meaningless noise") and `types.ts:102` ("the module is simply absent from the ensemble rather than falling back to 50/50"). No hardcoded literal-`50` fallback for a missing model's *vote value* was found anywhere in the files read for this audit; the only literal-`50` occurrences found are the logistic's center point (`ensemble.ts:19`, a formula constant, not a fallback), a documented zero-models edge case in the disagreement classifier (`disagreement.ts:135`, returns a neutral disagreement *reading*, not a phantom ensemble vote), and a degenerate-odds guard in the Market Consensus parser (`index.ts:517`).

**Model agreement classification.** Computed in `computeWeightedDisagreement` (`disagreement.ts:125-205`) from the weighted mean/stddev of votes, after collapsing Surface Elo/Serve & Return/Recent Form into one combined signal when they agree in direction. `HighDisagreement` requires a genuine directional conflict among meaningfully-weighted models (≥15% weight share each, `MEANINGFUL_WEIGHT_SHARE=0.15`, `disagreement.ts:37`) — pure confidence spread with unanimous direction can reach at most `Mixed`, never `HighDisagreement` (a documented fix, `disagreement.ts:166-178`). Below that: `Mixed` if weighted stddev > 9 or leading support < 65%; `Moderate` if stddev > 6 or leading support < 75%; else `Strong` (`disagreement.ts:180-193`).

## 4. Surface Elo, Serve & Return, Recent Form — Provenance

### 4.1 Surface Elo (`surfaceElo.ts`)
A standard logistic Elo replay per player, played back chronologically from real match results (win/loss only — no score margin feeds this specific formula): `elo += K × (actual − expected)`, where `K = 32 × recencyWeight × levelMultiplier` (`surfaceElo.ts:222-227`). Recency weight decays exponentially with a 545-day half-life, floored at 0.12 (`surfaceElo.ts:114-122`); level multiplier ranges 0.6 (ITF) to 1.3 (Grand Slam) (`surfaceElo.ts:130-142`). When an opponent's own Elo can't be resolved, the formula substitutes a **real, level-aware corpus baseline average** (e.g. Grand Slam 1523, ITF 1522) for that one opponent reference — never a flat guess (`surfaceElo.ts:71-97`), and every such substitution is logged by a dedicated, separate tracking module (`fallbackTracking.ts`) for aggregate/run-level auditing (this tracker is **not** wired into any individual prediction's JSON output — from a single match's displayed numbers alone, there is no visible flag saying "this specific opponent reference used the corpus-baseline fallback"; that is a genuine, if minor, disclosure gap this audit surfaces but did not find any code path to close).

Reliability is `100×(1−exp(−effectiveSampleSize/6))`, clamped [5,100] — a real function of a recency-weighted (not flat) match count, taking the weaker of the two players (`surfaceElo.ts:147,272-275,362`). When a player's same-surface sample is thin, their rating is blended toward their overall (cross-surface) Elo via `blendWeight = exp(−surfaceEffectiveSampleSize/4)` (`surfaceElo.ts:144,298`) — this is exactly the "blended 61% toward overall Elo"-style warning language seen in the real records in §8, and it is a real, formula-driven, sample-size-driven number, not an arbitrary label. Sample size itself (`sampleSize`) is a genuine count of real historical matches on that surface (`surfaceElo.ts:240`), not an estimate.

**Classification: DERIVED.** No fallback path returns a fabricated value; every substitution (opponent baseline, cross-surface blend) is a documented formula over real inputs, and is disclosed via warnings when it materially affects the output.

### 4.2 Serve & Return (`serveReturn.ts`)
Two distinct calculation regimes, both real, gated by data availability:
- **Real-stats regime** (used when both players have ≥3 real-stat matches, `MIN_REAL_SAMPLE=3`, `serveReturn.ts:56,215,246-252`): ratings computed directly from the provider's real per-match point statistics (`servicePointsWonPct`, `returnPointsWon`, `firstServeWon`, `breakPointsSaved/Faced`). One derived (not directly reported) sub-metric — break points converted while returning — is computed from the *opponent's* own stat line, since no provider reports a player's own return-side conversion directly (`serveReturn.ts:17,130-134`). `serviceGamesHeldPct` is an estimate via the closed-form Newton & Keller (1974) formula applied to real service-point-win rates (`serveReturn.ts:19,90-97`) — a real, named, textbook formula, not an invented heuristic. Reliability: `max(65, min(95, 65+(minSample-3)×5))` (`serveReturn.ts:256,282-284`).
- **Proxy regime** (used when either player has <3 real-stat matches — both players fall back together, "fair comparison" rule, `serveReturn.ts:246-252`): ratings derived instead from real set/game score margins. Reliability is capped much lower, `max(5, min(60, minSample×6))`, and is explicitly documented as "never excellent" (`serveReturn.ts:304`).

Both regimes are labeled with an exact, distinguishing, always-present `note` string (`serveReturn.ts:40-44`), which this audit used to determine each sampled match's regime in §8 without guessing.

**Classification: DERIVED** in both regimes — the proxy path is a materially weaker calculation (correctly reflected in its much lower reliability ceiling), not a fallback to a default value.

### 4.3 Recent Form (`recentForm.ts`)
A 10-most-recent-match window (`WINDOW=10`) with positional (not time-based) recency decay `0.85^i`, further weighted by tournament level, a same-surface-mismatch discount (0.7×), and a retired/walkover discount (0.35×) (`recentForm.ts:132,144-147`). When a player's recent matches are mostly sub-tour (Challenger/ITF), the raw form score's deviation from neutral (50) is shrunk by a credibility factor `0.35 + 0.65×tourLevelShare` (`recentForm.ts:60,172-177`) — the same formula and 0.35 floor constant used by Surface Elo's cross-surface blend, applied here to guard against overcrediting a hot streak built against weak competition. Reliability is a flat, simple function of raw match count, `max(10, min(100, minSample×12))` (`recentForm.ts:218`) — deliberately simpler than Surface Elo's effective-sample-size formula, and not adjusted for recency weighting.

**Classification: DERIVED.** The "shrunk toward neutral" language seen verbatim in the real records (§8) is a genuine, formula-driven conservatism measure, not vague marketing copy.

## 5. The Specialist Model ("Segment Specialist") and the General Model

### 5.1 What the Specialist Model is, precisely
"Specialist Model" (backend name `Segment Specialist`, renamed for display — see §6) is a per-tour-per-surface calibration layer, fit only for eight defined segments: `{ATP, WTA} × {Hard, Clay, Grass, IndoorHard}` (`segments.ts:12-13,51-59`). Challenger, ITF, Exhibition, Junior, and any unrecognized tour are, by explicit code-comment design intent, never candidates — "they … always resolve to the general model" (`segments.ts:5-7,67`). Every other surface not in that list (e.g. carpet, or an unspecified/null surface) is likewise never a candidate.

### 5.2 Every reason the Specialist can be unavailable, and how it's disclosed
There is **no enum/coded `exclusionReason` field** — instead, an always-present, human-readable `segmentNote` string (`index.ts:71`, explicitly documented as "Always present and always visible… Never silent") states exactly why:
1. **Unsupported tour** — Challenger/ITF/Exhibition/Junior/unrecognized. `segmentNote`: *"This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only."* (`index.ts:842`)
2. **Unsupported surface** — same note as above; any surface outside Hard/Clay/Grass/IndoorHard.
3. **Insufficient sample** — below `MIN_HISTORICAL_MATCHES_FOR_SEGMENT=150` real historical matches or `MIN_VALIDATION_SAMPLES_FOR_SEGMENT=30` validation-fold predictions (`specialistWeights.ts:94,103`). `segmentNote`: *"No segment specialist for {label} yet -- only {n} historical match(es) and {n} validation prediction(s) recorded so far (needs at least {min} matches and {min} validation predictions). Using the general model only."* (`index.ts:846`)
4. **Performance/quality gate** — segment accuracy below `MIN_SPECIALIST_ACCURACY=55%` (`specialistWeights.ts:114,370-388`), or segment log-loss worse than the general model's by more than `MAX_LOGOSS_DEGRADATION=0.005` nats (`specialistWeights.ts:434,459-460`) — both collapse `meetsThreshold` to `false`, functionally identical to "insufficient sample" from the outside.
5. **Missing data** — no `specialist_models` row has ever been computed for that segment yet; handled as an honest "not enough data" object, `meetsThreshold: false` (`specialistWeights.ts:496-507`) — not distinguishable from case 3 in the disclosed note.
6. **A hardcoded, surface-wide disable specific to Clay** — `index.ts:657`: `specialistDisabledForSurface = input.surface === "Clay"` forces the segment to `null` for **every** Clay match, ATP or WTA, regardless of whether that segment's own `meetsThreshold` is true. `segmentNote`: *"Specialist calibration is currently disabled for Clay (2026-08-08 Ticket 1: …)"* (`index.ts:840`). Per `.agents/memory/specialist-calibration-clay-disable.md`, this is a targeted business decision from a 196,924-row rescore showing the specialist measurably hurt Clay accuracy (−1.67pp) while helping Grass/Hard/IndoorHard (+1.30 to +2.19pp) — a data-driven decision, not a data-sufficiency gate, and it is **live and currently in effect** as of the code checked out for this audit.
7. **"Segment not adopted"** — the closest current equivalent is an admin-approval workflow: computed specialist data can sit in a `pending_specialist_data` column until approved via a dedicated activation endpoint (`specialistWeights.ts:118-124,147-152`), before which it is not written to the live table and cannot be applied. There is no separate "adopted but disabled anyway" flag distinct from `meetsThreshold`/the Clay override above.
8. **Ablation-only override** — `excludedModels?.has("segmentSpecialist")` forces it off for offline ablation testing only (`index.ts:650,658`); never applies to a live user-facing prediction.

### 5.3 Is a missing Specialist ever a silent 50% vote?
**No.** When unavailable, the `"Segment Specialist (...)"` entry is never pushed into the disclosed `models[]` array at all (`index.ts:764`, gated by `if (specialistApplied && specialistProbability !== null && segment)`) — the General Model's `weightUsed` is set to exactly `1` in that case (`index.ts:760`), absorbing the full weight, not split 50/50 with a phantom vote. The final blended probability is likewise a straight pass-through of the General Model (`index.ts:670-672`) with zero Specialist contribution — never a coin-flip stand-in.

### 5.4 The blend, when applied
When applied, it is a genuine partial blend, never a full replacement: `blendedProbability = specialistWeight × specialistProbability + (1 − specialistWeight) × generalProbability` (`index.ts:670-672`). `specialistWeight` itself is derived from validation sample size (`min(0.7, sampleSize/(sampleSize+50))`), then adjusted ±0.2 by measured log-loss improvement over the general model, clamped to `[0.1, 0.85]` — **0.85 is a hard ceiling; the Specialist can never fully override the General Model**, and a measured performance degradation returns exactly `0` (full exclusion), never a floor value (`specialistWeights.ts:453-464`). A second, separate mechanism (`constrainSpecialistKnotsToGeneral`, `specialistWeights.ts:50-84`) blends the specialist's *calibration curve itself* toward the general model's curve at moderate input confidence (<0.75) — this was introduced (per `docs/audit-task184-specialist-curve-refit.md`) specifically to fix a documented prior bug where ATP-Hard mapped a modest 57% input into an anomalous 91% output; the fix is present and live in the current code, with a regression test (`specialistWeights.test.ts:453-510`) that reads the live DB and fails if the constraint regresses.

### 5.5 Known, already-investigated issues (from this team's own prior audits)
- **Task #183/184** (2026-08-10): identified and fixed the ATP-Hard overconfidence bug above via `constrainSpecialistKnotsToGeneral`. Fixed, live, tested.
- **Task #186/#194** (WTA/ATP constraint verification, 2026-08-10): independently re-verified the fix holds across all 8 segments; both conclude "closed."
- **specialist-tour-column-distinction.md**: documents an already-fixed historical bug where segment queries used the wrong DB column (`tournament_level` instead of `tour`), which silently returned zero rows for every segment — current code correctly queries the `tour` column (`specialistWeights.ts:217,270`).
- **specialist-segment-thresholds.md**: documents a still-open, architectural (not live-engine) gap — the historical/walk-forward scoring harness hardcodes `segment: null`, so specialists never apply during backtesting, only in live prediction. `eliteTier.ts`'s `computeNearEliteTier` exists specifically as a documented workaround for this gap in backtest analysis.

### 5.6 Segment status as checked out
All 8 candidate segments (`ATP`/`WTA` × `Hard`/`Clay`/`Grass`/`IndoorHard`) had, per the most recent audit docs available (2026-08-10 snapshots), `meetsThreshold=true`. **However, Clay is unconditionally disabled at inference time regardless of that** (§5.2, item 6) — so in practice, live Specialist coverage as checked out is: **Hard, Grass, IndoorHard — both tours — live; Clay — both tours — computed and validated but not applied.** Challenger/ITF/Exhibition/Junior — never candidates, always General Model only.

## 6. UI-Derived Fields — Favored, Effective Weight, Contribution, Reliability, Availability, Sample, Status

This section directly answers the audit's "Required checks" list. The per-model breakdown table a user sees on a prediction's result page is rendered by `artifacts/tennis-predictor/src/pages/PredictionResult.tsx:894-934` (and mirrored for copy/export text in `artifacts/tennis-predictor/src/lib/predictionCopyText.ts:201-223`), iterating the backend's `engine.models[]` array. Backend `ModelVote` objects carry exactly four fields: `modelName`, `player1Probability`, `weightUsed`, `reliability` (`ensemble.ts:3-8`). Everything else in that table is invented in the frontend:

| Displayed field | Formula (verbatim, `PredictionResult.tsx:906-912`) | Classification | Finding |
|---|---|---|---|
| **Model Name** | `toVisibleModelName(vote.modelName)` — a lookup table that renames the backend's `"Segment Specialist"` to `"Specialist Model"` (`:53,69`), leaves `"General Model"` unchanged (no matching rule), etc. | DERIVED (cosmetic) | Explains why this audit's task brief and the UI both say "Specialist Model" while the backend/database say "Segment Specialist" — same thing, renamed for display only. Harmless. |
| **Raw Prob** | `vote.player1Probability` | **VERIFIED/DERIVED** (direct passthrough) | A genuine backend fact, per §3–§5. |
| **Effective Weight** | `vote.weightUsed * 100` | **DERIVED** (direct passthrough, formatted as %) | A genuine backend fact (`ensemble.ts:56-61`) *whenever the model actually appears in `models[]`* — see the Fatigue/Availability caveat in §1 and §8 for records where a since-excluded module still appears with a real historical weight. |
| **Weighted Contribution ("Contribution")** | `vote.player1Probability * vote.weightUsed` | **UI-DERIVED — no backend counterpart, and arguably mislabeled** | See finding below. |
| **Reliability** | `vote.reliability` | **VERIFIED/DERIVED** (direct passthrough) | A genuine backend fact, per §3–§5. |
| **Favored** (per model) | `vote.player1Probability >= 50 ? player1Name : player2Name` | **UI-DERIVED** | Directionally consistent with the backend's own `>=50` convention (§3), but the label itself has no backend field — there is no `favoredPlayer` in `ModelVote`. |
| **Status** | `vote.weightUsed < 0.01 ? "Excluded" : vote.reliability < 25 ? "Limited" : "Active"` | **UI-DERIVED** | Thresholds (`0.01`, `25`) are invented in the frontend and not exported/defined anywhere in the backend engine. |
| **Availability** (per-model-row) | `vote.weightUsed < 0.01 ? "Unavailable" : "Available"` | **UI-DERIVED — name collision, likely misleading** | See finding below. |
| **Sample** | `vote.reliability >= 75 ? "High" : vote.reliability >= 45 ? "Medium" : "Low"` | **UI-DERIVED — does not read the real sample-size fields that exist** | See finding below. |

### Finding A — "Contribution" does not measure what it claims to
`weightedContribution = player1Probability × weightUsed` (not `(player1Probability − 50) × weightUsed`, and not the model's actual share of the calibrated margin). Consequence: **a model voting at exactly 50% (perfectly neutral — no lean either way) still displays a positive, nonzero "Contribution" number**, proportional only to its weight (e.g. a neutral vote at weight 0.30 displays `Contribution: 15.0`, identical in magnitude to a genuinely decisive 65%-probability vote at half that weight, `0.30 × 65 = 19.5` is not far off either — the two are not visually distinguishable as "neutral" vs. "decisive" the way the label implies). The column's own tooltip, *"Raw probability multiplied by effective weight"* (`PredictionResult.tsx:899`), is an accurate description of the arithmetic — the problem is that this arithmetic is not what "contribution to the pick" means to a reader, and the column header doesn't say "raw probability × weight," it says "Weighted Contribution." Per-model Contribution values in a single match also do not sum to anything meaningful (they don't sum to the calibrated margin, or to 100, or to any other interpretable total) — a reader comparing two models' Contribution numbers side by side has no principled basis for concluding one "contributed more" than the other in the sense of moving the final pick.

### Finding B — per-model "Availability" reuses the near-zero-weight test and collides with a real, different, better-computed "Availability" elsewhere in the same engine
This per-model-row label is **not** the real Availability model (rest days / travel / withdrawal signals, `availability.ts`, correctly excluded from the ensemble per §3, disclosed separately and in full elsewhere in the UI). It is a second, unrelated reuse of the word: `weightUsed < 0.01 ? "Unavailable" : "Available"`. Two consequences: (1) Head-to-Head with a real reliability of 5 (the two players have simply never met — a normal, common, correctly-low-confidence real fact, §4) still shows **"Available"** here because its weight, while small, is rarely literally below 0.01 — so a reader could reasonably but wrongly conclude the underlying data source resolved fine. (2) Conversely, any model legitimately down-weighted to near-zero for a statistically sound reason (not because its data source was missing) gets labeled **"Unavailable,"** which is not what happened. This is a naming collision worth fixing even though neither underlying number is fabricated.

### Finding C — per-model "Sample" does not read the real sample-size fields that already exist in the engine's own output
`Sample: High/Medium/Low` is bucketed purely from `reliability` (itself already a derived composite, not a raw count), using one shared threshold ladder (`>=75`/`>=45`) applied identically to every model regardless of what "reliability" means for that specific model (§4 shows Surface Elo, Serve & Return, Recent Form, and Head-to-Head each compute reliability via four different formulas with different scales and different real-world meanings). Meanwhile, the backend **does** compute and expose genuine, named sample-size fields for at least Surface Elo (`surfaceSampleDepth.player1Sample` / `player2Sample`, real match counts — confirmed present in every sampled record in §8) and Serve & Return (`player1PointLevel.sampleSize` / `player2PointLevel.sampleSize`) — none of which this UI column reads. The displayed "Sample" bucket will often happen to agree with the real sample depth (both tend to be low together), but it is a coincidence of correlated inputs, not a wired connection — a case could exist where reliability is pulled down by something other than sample size (e.g. a thin-sample surface-Elo blend that's nonetheless well-calibrated) while the real sample count is adequate, or vice versa, and the displayed "Sample" label would be wrong in that case without anyone having changed the underlying (correctly-computed) reliability number at all.

### What this section does NOT find
No fabricated *probabilities* were found anywhere in the frontend — `player1Probability`, `weightUsed`, and `reliability` are always read straight from the backend engine's real output, never invented or overridden client-side. The issue identified in this section is entirely about four **derived labels wrapped around** those three real numbers (Contribution, per-model Favored, per-model Availability, per-model Sample, and Status), not about the underlying probabilities themselves being wrong.

## 7. Player Orientation Test

A dedicated regression suite (`swapInvariance.test.ts`) exists specifically to guard against exactly the class of bug this section asks about, and its assertions are real, not decorative:
- Swapping player1/player2 slots produces raw-ensemble probabilities summing to ≈100 and calibrated probabilities summing to ≈100 within 2 percentage points (`swapInvariance.test.ts:229-237`).
- The predicted winner is identical regardless of which slot a player occupies (`:240-243`).
- The predicted winner and the reported margin are driven by the **calibrated** probability, never the raw ensemble probability, across two separate test cases (`:337-350,408-414`) — guarding against a class of bug where an internal number, not the final display number, leaks into a decision.

**A real, historical instance of exactly this class of bug, since fixed:** `predictSetScore` (`index.ts:350-368`) used to branch on `favorsPlayer1` and always print Player 1's set count first — which broke when Player 2 was the actual predicted winner (the score visually looked like the winner lost). The current code's own comment (`index.ts:350-360`) documents this as fixed: `favorsPlayer1` is now unused there, and the winner's own set count is always shown first, regardless of slot. `EngineOutput.predictedWinnerProbability` (`index.ts:136-145`) exists specifically to prevent a related class of bug (a player1-relative number mislabeled as "the favorite's confidence"), and `finalConsistencyCheck.ts`'s Rule 11 (`:239-270`) is a standing automated guard for the Monte Carlo simulator's own probability needing the same treatment.

No model was found (within the files read for this audit — the core five plus availability/dataQuality/fallback modules) reading player1-specific *global* state (e.g. a singleton keyed by the literal string "player1" instead of a match-scoped player ID). This audit did not exhaustively read every remaining module (style matchup, weather, match load recovery) for this specific hazard — flagged as not-yet-checked rather than cleared.

**Classification: VERIFIED, by genuine automated test coverage, with one documented-and-fixed historical exception.**
## 8. Forensic Match Log (26 sampled matches)

Each entry below is a real, persisted prediction record pulled unmodified from this repository's `predictions_backup_2026-07-13T22-51-29-114Z.json` / `predictions_backup_2026-07-13T23-16-23-444Z.json` exports (440 unique matches total, deduplicated by `id`; both files are frozen snapshots from July 13, 2026 -- the closest thing to real forensic exhibits available without live `DATABASE_URL`/`API_TENNIS_KEY` credentials in this session; see §2 Methodology & Access Limitations). Per-model classification follows the code-level findings in §3-§5. `Provenance` codes: **VERIFIED** = raw fact/count from provider data, no transformation; **DERIVED** = a real, documented, code-cited calculation from real inputs; **UNAVAILABLE** = correctly and visibly absent, not silently defaulted; **UI-DERIVED** = computed client-side, not present in any backend field (see §6); **ANOMALY/UNRESOLVED** = a discrepancy this audit found between the record and current code that could not be fully resolved with the access available.

### Match #131 -- M. Dodig vs H. Dellien

**Sample rationale:** ATP tour-level, Specialist ON, near-50/50, HighDisagreement

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=131, `matchIdentityKey`=28615|2980::(no-tournament)::Clay::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-131
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T22:38:16.890Z
- Resolution: actualWinnerId=2980, actualWinnerName=H. Dellien, resolvedAt=2026-07-12T20:35:06.227Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 36.3% | 0.23 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=71, P2 n=93). |
| Serve & Return | 41.7% | 0.218 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 54.2% | 0.23 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 67% | 0.161 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 50% | 0.115 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=1, P2=1); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 3.4% | 0.046 | 20 | DERIVED | Real recorded head-to-head: P1 0 - P2 1. |
| General Model | 48.1% | 0.381 | 73 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Clay) | 51% | 0.619 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Clay applied (blend weight 62%), measured on 85 validation-segment predictions across 255 real historical ATP — Clay matches. |

**Combination outputs:** predictedWinner=H. Dellien | predictedWinnerProbability=50.1% | calibratedProbability=49.9% | dataQuality=73 (Strong) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #233 -- H. S. Callejon vs I. Radulov

**Sample rationale:** ATP tour-level, Specialist ON, strong favorite (Mixed agreement)

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=233, `matchIdentityKey`=38103|50705::(no-tournament)::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-233
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-12T11:52:45.624Z
- Resolution: actualWinnerId=38103, actualWinnerName=I. Radulov, resolvedAt=2026-07-12T22:02:40.678Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 70.6% | 0.234 | 96 | DERIVED | Adequate same-surface sample for both players (P1 n=67, P2 n=8). |
| Serve & Return | 81.8% | 0.219 | 90 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 61.3% | 0.243 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 73.1% | 0.17 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 67.9% | 0.122 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=9, P2=3); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 50% | 0.012 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 63.8% | 0.419 | 69 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Hard) | 97.2% | 0.581 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Hard applied (blend weight 58%), measured on 241 validation-segment predictions across 1067 real historical ATP — Hard matches. |

**Combination outputs:** predictedWinner=H. S. Callejon | predictedWinnerProbability=83.2% | calibratedProbability=83.2% | dataQuality=69 (Strong) | modelAgreement=Mixed | upsetRisk=HIGH | recommendation=MODERATE_LEAN | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #48 -- M. Hodzic vs H-C. Chan

**Sample rationale:** ATP tour-level, Specialist OFF (below current-code Clay-disable / gating), HighDisagreement

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=48, `matchIdentityKey`=147|38680::(no-tournament)::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-48
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T13:31:49.883Z
- Resolution: actualWinnerId=147, actualWinnerName=M. Hodzic, resolvedAt=2026-07-12T20:35:28.717Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 49.5% | 0.03 | 5 | DERIVED | Adequate same-surface sample for both players (P1 n=18, P2 n=0). |
| Serve & Return | 86.2% | 0.072 | 12 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 73.9% | 0.145 | 24 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 35.8% | 0.422 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 29.4% | 0.301 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=4, P2=400); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 50% | 0.03 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 45.5% | 1 | 28 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | No segment specialist for WTA — Hard yet -- only 0 historical match(es) and 0 validation prediction(s) recorded so far (needs at least 150 matches and 30 validation predictions). Using the general model only. |

**Combination outputs:** predictedWinner=H-C. Chan | predictedWinnerProbability=54.5% | calibratedProbability=45.5% | dataQuality=28 (Limited) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #141 -- M. Colmegna vs B. Palicova

**Sample rationale:** WTA tour-level (segmentKey WTA-Hard), Specialist ON -- tournamentLevel field mislabeled ATP250

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=141, `matchIdentityKey`=1348|2280::(no-tournament)::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-141
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T22:55:25.282Z
- Resolution: actualWinnerId=1348, actualWinnerName=M. Colmegna, resolvedAt=2026-07-12T20:35:06.635Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 47.7% | 0.07 | 24 | DERIVED | Adequate same-surface sample for both players (P1 n=2, P2 n=26). |
| Serve & Return | 84.1% | 0.276 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 49% | 0.291 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 44.8% | 0.203 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 43.8% | 0.145 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=4, P2=6); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 50% | 0.015 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 56.6% | 0.472 | 57 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (WTA — Hard) | 56.9% | 0.528 | 100 | DERIVED (genuine blend) | Segment specialist for WTA — Hard applied (blend weight 53%), measured on 251 validation-segment predictions across 1284 real historical WTA — Hard matches. |

**Combination outputs:** predictedWinner=M. Colmegna | predictedWinnerProbability=56.8% | calibratedProbability=56.8% | dataQuality=57 (Acceptable) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #146 -- C. A. Herea vs E. Kazionova

**Sample rationale:** WTA tour-level (segmentKey WTA-Clay) -- but Specialist OFF (Clay disabled) -- Moderate agreement

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=146, `matchIdentityKey`=1985|28104::(no-tournament)::Clay::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-146
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T23:17:30.818Z
- Resolution: actualWinnerId=28104, actualWinnerName=C. A. Herea, resolvedAt=2026-07-12T20:35:06.788Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 61% | 0.25 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=24, P2 n=68). |
| Serve & Return | 67.9% | 0.188 | 75 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 46.9% | 0.25 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 68.8% | 0.175 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 56.2% | 0.125 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=5, P2=3); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 50% | 0.013 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 56.9% | 1 | 67 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | No segment specialist for WTA — Clay yet -- only 137 historical match(es) and 0 validation prediction(s) recorded so far (needs at least 150 matches and 30 validation predictions). Using the general model only. |

**Combination outputs:** predictedWinner=C. A. Herea | predictedWinnerProbability=56.9% | calibratedProbability=56.9% | dataQuality=67 (Strong) | modelAgreement=Moderate | upsetRisk=EXTREME | recommendation=HIGH_RISK | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #87 -- G. Minnen vs K. Volynets

**Sample rationale:** WTA tour-level (segmentKey WTA-Grass) -- Specialist OFF -- Moderate agreement

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Grass | Format: BestOf3
- Source record: `predictions` table id=87, `matchIdentityKey`=2191|2826::(no-tournament)::Grass::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-87
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T16:02:07.033Z
- Resolution: actualWinnerId=2826, actualWinnerName=K. Volynets, resolvedAt=2026-07-12T20:35:08.520Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 59.5% | 0.22 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=22, P2 n=17). |
| Serve & Return | 43.8% | 0.209 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 47.9% | 0.22 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 37.8% | 0.154 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 50% | 0.11 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=2, P2=2); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 51.9% | 0.088 | 40 | DERIVED | Real recorded head-to-head: P1 1 - P2 1. |
| General Model | 52.2% | 1 | 76 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | No segment specialist for WTA — Grass yet -- only 0 historical match(es) and 0 validation prediction(s) recorded so far (needs at least 150 matches and 30 validation predictions). Using the general model only. |

**Combination outputs:** predictedWinner=G. Minnen | predictedWinnerProbability=52.2% | calibratedProbability=52.2% | dataQuality=76 (Strong) | modelAgreement=Moderate | upsetRisk=EXTREME | recommendation=HIGH_RISK | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #65 -- H. Searle vs M. Basing

**Sample rationale:** ATP tour-level (segmentKey ATP-Grass) -- Specialist OFF -- Moderate agreement

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Grass | Format: BestOf3
- Source record: `predictions` table id=65, `matchIdentityKey`=13535|38784::(no-tournament)::Grass::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-65
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T15:18:46.142Z
- Resolution: actualWinnerId=38784, actualWinnerName=H. Searle, resolvedAt=2026-07-12T20:35:16.988Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 68.6% | 0.238 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=22, P2 n=10). |
| Serve & Return | 66.1% | 0.226 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 55.2% | 0.238 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 56.2% | 0.167 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 50% | 0.119 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=2, P2=2); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 50% | 0.012 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 57.4% | 1 | 70 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | No segment specialist for ATP — Grass yet -- only 0 historical match(es) and 0 validation prediction(s) recorded so far (needs at least 150 matches and 30 validation predictions). Using the general model only. |

**Combination outputs:** predictedWinner=H. Searle | predictedWinnerProbability=57.4% | calibratedProbability=57.4% | dataQuality=70 (Strong) | modelAgreement=Moderate | upsetRisk=EXTREME | recommendation=HIGH_RISK | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #388 -- D. Palan vs M. Gonzalez Fernandez

**Sample rationale:** Challenger-labeled event, Specialist ON (ANOMALY -- see forensic note), HighDisagreement

- Tournament: ATP Challenger Pozoblanco | tournamentLevel field: `Challenger` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=388, `matchIdentityKey`=15921|741::atp challenger pozoblanco::Clay::BestOf3, `inputSnapshotHash`=4e6db2359555d7202590ad6f54d7e7a7f5e34ef53cebacf0e9a977e27b01d99b
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T18:11:43.317Z
- Resolution: actualWinnerId=None, actualWinnerName=None, resolvedAt=None


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 51.6% | 0.122 | 28 | DERIVED | Thin same-surface sample for at least one player (P1 n=2, P2 n=29) -- rating blended toward overall (cross-surface) Elo (blend weights P1=0.613, P2=0.008) per the documented exp(-effectiveSampleSize/4) formula. Real match counts, genuinely low, correctly discounted -- NOT a fabricated or defaulted rating. |
| Serve & Return | 58.9% | 0.414 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 48.9% | 0.377 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 62.2% | 0.081 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 50% | 0.006 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 61.2% | 0.387 | 72 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Clay) | 64.2% | 0.613 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Clay applied (blend weight 61%), measured on 85 validation-segment predictions across 255 real historical ATP — Clay matches. *** FORENSIC ANOMALY: tournamentLevel='Challenger' (a Challenger/sub-tour tier) yet specialistApplied=true with segmentKey='ATP-Clay'. Per current segments.ts (CANDIDATE_TOURS=['ATP','WTA'] only; TOUR_LEVEL_TO_GROUP has no 'CHALLENGER' entry; segments.ts:5-7 explicitly states Challenger/ITF matches 'always resolve to the general model'), a genuine Challenger-tour match should resolve segment=null and specialistApplied=false. Could not confirm from available access (no live DB, shallow git history) whether (a) the actual `tour` value threaded into resolveSegment at generation time was 'ATP' rather than 'Challenger' [tournamentLevel and tour are stored as separate DB columns per segments.ts:16-21, and this exported record only exposes tournamentLevel, not tour], (b) segment-resolution logic differed on 2026-07-13, or (c) this is a live tour-classification bug. FLAGGED AS UNRESOLVED / REQUIRES DB-LEVEL FOLLOW-UP, not asserted as confirmed-incorrect.*** |

**Combination outputs:** predictedWinner=D. Palan | predictedWinnerProbability=63% | calibratedProbability=63% | dataQuality=72 (Strong) | modelAgreement=HighDisagreement | upsetRisk=HIGH | recommendation=MODERATE_LEAN | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #457 -- L. Draxl vs N. Arseneault

**Sample rationale:** ITF Mens (M25), Specialist OFF (unsupported tour), Moderate agreement

- Tournament: M25 Laval | tournamentLevel field: `ITF` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=457, `matchIdentityKey`=3696|71261::m25 laval::Hard::BestOf3, `inputSnapshotHash`=6c0782f982c28008fcb254adcddb9fc2f9d8c082290d5c84c7e7c07cdfc92e7b
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:45.304Z
- Resolution: actualWinnerId=3696, actualWinnerName=L. Draxl, resolvedAt=2026-07-13T22:52:45.303Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 58.8% | 0.325 | 99 | DERIVED | Adequate same-surface sample for both players (P1 n=57, P2 n=48). |
| Serve & Return | 56.4% | 0.312 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 51.1% | 0.284 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0.141, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 32.1% | 0.061 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 96.6% | 0.018 | 20 | DERIVED | Real recorded head-to-head: P1 1 - P2 0. |
| General Model | 54.9% | 1 | 93 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=L. Draxl | predictedWinnerProbability=54.9% | calibratedProbability=54.9% | dataQuality=93 (Excellent) | modelAgreement=Moderate | upsetRisk=MODERATE | recommendation=HIGH_RISK | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #458 -- M. Dellavedova vs T. Yamanaka

**Sample rationale:** ITF Mens (M15), Specialist OFF (unsupported tour), HighDisagreement

- Tournament: M15 Tokyo 4 (Japan) | tournamentLevel field: `ITF` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=458, `matchIdentityKey`=1258|13371::m15 tokyo 4 (japan)::Hard::BestOf3, `inputSnapshotHash`=4c26352c969d93ef6a95f46008b635fd7eb010be661ba422298e9f6e9958536e
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:46.072Z
- Resolution: actualWinnerId=1258, actualWinnerName=M. Dellavedova, resolvedAt=2026-07-13T22:52:46.071Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 69.9% | 0.327 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=124, P2 n=76). |
| Serve & Return | 30.9% | 0.311 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 52.5% | 0.284 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 28.6% | 0.061 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 96.6% | 0.017 | 20 | DERIVED | Real recorded head-to-head: P1 1 - P2 0. |
| General Model | 47.5% | 1 | 94 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=T. Yamanaka | predictedWinnerProbability=52.5% | calibratedProbability=47.5% | dataQuality=94 (Excellent) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #479 -- E. Plosnik vs M. Ercan

**Sample rationale:** ITF Womens (W35), Specialist OFF (unsupported tour), HighDisagreement

- Tournament: W35 Don Benito | tournamentLevel field: `ITF` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=479, `matchIdentityKey`=40065|53165::w35 don benito::Hard::BestOf3, `inputSnapshotHash`=2d9d63f48235cb899a292c32231b0c6fba11161196f0a88243ee58d7d448693d
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:54.570Z
- Resolution: actualWinnerId=40065, actualWinnerName=M. Ercan, resolvedAt=2026-07-13T22:52:54.570Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 42.3% | 0.263 | 61 | DERIVED | Adequate same-surface sample for both players (P1 n=6, P2 n=25). |
| Serve & Return | 33.7% | 0.259 | 60 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 46% | 0.374 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 81.1% | 0.081 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 3.4% | 0.023 | 20 | DERIVED | Real recorded head-to-head: P1 0 - P2 1. |
| General Model | 43.7% | 1 | 72 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=M. Ercan | predictedWinnerProbability=56.3% | calibratedProbability=43.7% | dataQuality=72 (Strong) | modelAgreement=HighDisagreement | upsetRisk=MODERATE | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #19 -- C. Alcaraz vs J. Sinner

**Sample rationale:** Grand Slam (Roland Garros), Clay -- Specialist n/a in this snapshot, HighDisagreement

- Tournament: Roland Garros | tournamentLevel field: `GrandSlam` | Surface: Clay | Format: BestOf5
- Source record: `predictions` table id=19, `matchIdentityKey`=2072|2382::roland garros::Clay::BestOf5, `inputSnapshotHash`=legacy-no-snapshot-19
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T10:25:11.875Z
- Resolution: actualWinnerId=None, actualWinnerName=None, resolvedAt=None


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 31.6% | 0.179 | 72 | DERIVED | Adequate same-surface sample for both players (P1 n=6, P2 n=13). |
| Serve & Return | 33.9% | 0.149 | 60 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 28.6% | 0.249 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 94% | 0.174 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 50% | 0.249 | 100 | DERIVED | Real recorded head-to-head: P1 5 - P2 5. |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | specialistApplied=false; no segmentNote present on this record. |

**Combination outputs:** predictedWinner=J. Sinner | predictedWinnerProbability=53% | calibratedProbability=47% | dataQuality=80 (Strong) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=HIGH_RISK | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #540 -- X. Sun vs J. Preston

**Sample rationale:** Grand Slam (Wimbledon), Grass, Specialist OFF, Moderate agreement

- Tournament: Wimbledon | tournamentLevel field: `GrandSlam` | Surface: Grass | Format: BestOf3
- Source record: `predictions` table id=540, `matchIdentityKey`=82564|89244::wimbledon::Grass::BestOf3, `inputSnapshotHash`=44e86503418283352b50decdfba63ff68cfffbe2bc19aad19a39f0af3a0c0e76
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:53:18.798Z
- Resolution: actualWinnerId=82564, actualWinnerName=X. Sun, resolvedAt=2026-07-13T22:53:18.797Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 58.3% | 0.247 | 56 | DERIVED | Adequate same-surface sample for both players (P1 n=6, P2 n=5). |
| Serve & Return | 53.7% | 0.265 | 60 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 58.4% | 0.382 | 100 | DERIVED | Tour-level shares adequate (P1=1, P2=0.846) -- minimal shrinkage applied. |
| Fatigue | 50% | 0.082 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 96.6% | 0.024 | 20 | DERIVED | Real recorded head-to-head: P1 1 - P2 0. |
| General Model | 57.4% | 1 | 71 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=X. Sun | predictedWinnerProbability=57.4% | calibratedProbability=57.4% | dataQuality=71 (Strong) | modelAgreement=Moderate | upsetRisk=LOW | recommendation=HIGH_RISK | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #292 -- L. Wessels vs D. Capecchi

**Sample rationale:** Data quality POOR, Specialist ON, HighDisagreement, materially away from 50%

- Tournament: Bunschoten | tournamentLevel field: `None` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=292, `matchIdentityKey`=1955|1956::bunschoten::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-292
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-12T21:38:44.281Z
- Resolution: actualWinnerId=None, actualWinnerName=None, resolvedAt=None


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 54.4% | 0.037 | 5 | DERIVED | Adequate same-surface sample for both players (P1 n=20, P2 n=0). |
| Serve & Return | 50% | 0.037 | 5 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 69.7% | 0.074 | 10 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 1.5% | 0.519 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 50% | 0.185 | 25 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=1, P2=None); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 96.6% | 0.148 | 20 | DERIVED | Real recorded head-to-head: P1 1 - P2 0. |
| General Model | 43.3% | 0.327 | 18 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Hard) | 31.8% | 0.673 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Hard applied (blend weight 67%), measured on 206 validation-segment predictions across 1107 real historical ATP — Hard matches. |

**Combination outputs:** predictedWinner=D. Capecchi | predictedWinnerProbability=64.4% | calibratedProbability=35.6% | dataQuality=18 (Poor) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=DO_NOT_RECOMMEND | isEliteTier=None | modelConflict=False | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #90 -- A. Panagiotidou vs A. Kulikova

**Sample rationale:** Data quality POOR, Specialist ON, HighDisagreement, strong favorite

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=90, `matchIdentityKey`=105303|458::(no-tournament)::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-90
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T16:08:18.348Z
- Resolution: actualWinnerId=458, actualWinnerName=A. Kulikova, resolvedAt=2026-07-12T20:35:17.364Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 37.3% | 0.042 | 5 | DERIVED | Adequate same-surface sample for both players (P1 n=0, P2 n=63). |
| Serve & Return | 41.7% | 0.042 | 5 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 37.8% | 0.083 | 10 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 95.6% | 0.583 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 50% | 0.208 | 25 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=None, P2=2); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 50% | 0.042 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 69.3% | 0.472 | 20 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (WTA — Hard) | 90.3% | 0.528 | 100 | DERIVED (genuine blend) | Segment specialist for WTA — Hard applied (blend weight 53%), measured on 251 validation-segment predictions across 1284 real historical WTA — Hard matches. |

**Combination outputs:** predictedWinner=A. Panagiotidou | predictedWinnerProbability=80.4% | calibratedProbability=80.4% | dataQuality=20 (Poor) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=DO_NOT_RECOMMEND | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #482 -- C. Robertson vs A. Deckers

**Sample rationale:** Data quality EXCELLENT, ITF Mens, Specialist OFF, near-50, HighDisagreement

- Tournament: M15 Hillcrest 2 | tournamentLevel field: `ITF` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=482, `matchIdentityKey`=10019|51278::m15 hillcrest 2::Hard::BestOf3, `inputSnapshotHash`=988e57a19d0bd1fcdbe67654ae09d018daa9aa443c26adcd643dd903e0031a79
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:55.979Z
- Resolution: actualWinnerId=51278, actualWinnerName=C. Robertson, resolvedAt=2026-07-13T22:52:55.979Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 46.6% | 0.313 | 94 | DERIVED | Adequate same-surface sample for both players (P1 n=23, P2 n=43). |
| Serve & Return | 52.8% | 0.3 | 90 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 51.1% | 0.289 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0.06) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 62.2% | 0.062 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 50.1% | 0.036 | 40 | DERIVED | Real recorded head-to-head: P1 1 - P2 1. |
| General Model | 52.5% | 1 | 91 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=C. Robertson | predictedWinnerProbability=52.5% | calibratedProbability=52.5% | dataQuality=91 (Excellent) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #467 -- C. G. Papoe vs A. Jeran

**Sample rationale:** Model agreement STRONG (consensus), ITF Mens, Specialist OFF

- Tournament: M15 Bucharest 2 | tournamentLevel field: `ITF` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=467, `matchIdentityKey`=54748|67686::m15 bucharest 2::Clay::BestOf3, `inputSnapshotHash`=5b680c2d140c9a73889f97efd188a5cd36406e12e2234b45c08daa80fc118239
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:49.962Z
- Resolution: actualWinnerId=67686, actualWinnerName=C. G. Papoe, resolvedAt=2026-07-13T22:52:49.962Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 55.7% | 0.365 | 98 | DERIVED | Adequate same-surface sample for both players (P1 n=30, P2 n=38). |
| Serve & Return | 55.5% | 0.223 | 60 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 52.9% | 0.323 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 55.2% | 0.069 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 96.6% | 0.02 | 20 | DERIVED | Real recorded head-to-head: P1 1 - P2 0. |
| General Model | 55.5% | 1 | 83 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=C. G. Papoe | predictedWinnerProbability=55.5% | calibratedProbability=55.5% | dataQuality=83 (Strong) | modelAgreement=Strong | upsetRisk=MODERATE | recommendation=HIGH_RISK | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #476 -- D. Pavlou vs A. Karunaratne

**Sample rationale:** Model agreement STRONG (consensus), ITF Womens, Specialist OFF

- Tournament: W15 Kursumlijska Banja 8 | tournamentLevel field: `ITF` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=476, `matchIdentityKey`=13074|28::w15 kursumlijska banja 8::Clay::BestOf3, `inputSnapshotHash`=b9c843d5655fdb7b2ada2916afc0d442d4be9080ce34575d773851694c8c47d6
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:53.297Z
- Resolution: actualWinnerId=13074, actualWinnerName=A. Karunaratne, resolvedAt=2026-07-13T22:52:53.297Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 48.4% | 0.276 | 67 | DERIVED | Adequate same-surface sample for both players (P1 n=11, P2 n=7). |
| Serve & Return | 41.1% | 0.247 | 60 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 48.9% | 0.357 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0.06, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 58.3% | 0.077 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 49.9% | 0.044 | 40 | DERIVED | Real recorded head-to-head: P1 1 - P2 1. |
| General Model | 47.5% | 1 | 74 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=A. Karunaratne | predictedWinnerProbability=52.5% | calibratedProbability=47.5% | dataQuality=74 (Strong) | modelAgreement=Strong | upsetRisk=HIGH | recommendation=HIGH_RISK | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #484 -- J. Duerst vs P. Leykina

**Sample rationale:** HighDisagreement AND near-50% outcome, ITF Womens

- Tournament: W35 Hillcrest | tournamentLevel field: `ITF` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=484, `matchIdentityKey`=2260|5264::w35 hillcrest::Hard::BestOf3, `inputSnapshotHash`=01b80c6301e5fd876cca845b00f55462e45c3b53cf5b0293463ce6135958b5f1
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:52:56.732Z
- Resolution: actualWinnerId=5264, actualWinnerName=P. Leykina, resolvedAt=2026-07-13T22:52:56.731Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 46.6% | 0.355 | 97 | DERIVED | Adequate same-surface sample for both players (P1 n=31, P2 n=29). |
| Serve & Return | 55.5% | 0.22 | 60 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 48.5% | 0.317 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 50% | 0.068 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 3.4% | 0.039 | 40 | DERIVED | Real recorded head-to-head: P1 0 - P2 2. |
| General Model | 52.5% | 1 | 83 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=J. Duerst | predictedWinnerProbability=52.5% | calibratedProbability=52.5% | dataQuality=83 (Strong) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #364 -- M. H. Rehberg vs G. I. Justo

**Sample rationale:** Near-50% edge case (50.1%), ATP tour, Specialist ON

- Tournament: ATP Challenger Cordenons | tournamentLevel field: `ATP250` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=364, `matchIdentityKey`=3604|7249::atp challenger cordenons::Clay::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-364
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T15:25:10.585Z
- Resolution: actualWinnerId=7249, actualWinnerName=G. I. Justo, resolvedAt=2026-07-13T16:51:28.344Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 45.6% | 0.329 | 99 | DERIVED | Adequate same-surface sample for both players (P1 n=33, P2 n=122). |
| Serve & Return | 46.3% | 0.316 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 51.1% | 0.288 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 77.7% | 0.062 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 50% | 0.004 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 47.8% | 0.468 | 93 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Clay) | 52.2% | 0.532 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Clay applied (blend weight 53%), measured on 85 validation-segment predictions across 255 real historical ATP — Clay matches. |

**Combination outputs:** predictedWinner=M. H. Rehberg | predictedWinnerProbability=50.1% | calibratedProbability=50.1% | dataQuality=93 (Excellent) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=True | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #55 -- J. Estevez vs J. Aguilar

**Sample rationale:** Near-50% edge case (50.3%), ATP tour, Specialist ON, Mixed agreement

- Tournament: n/a | tournamentLevel field: `ATP250` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=55, `matchIdentityKey`=38832|54079::(no-tournament)::Clay::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-55
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-11T13:51:47.928Z
- Resolution: actualWinnerId=54079, actualWinnerName=J. Estevez, resolvedAt=2026-07-12T20:35:13.652Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 52.6% | 0.211 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=111, P2 n=79). |
| Serve & Return | 56.2% | 0.2 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 51% | 0.211 | 100 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 37.8% | 0.147 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Availability (rest/travel/injury) | 50% | 0.105 | 50 | DERIVED at generation time / SUPERSEDED | Rest-day category is a real derived fact (daysSinceLastMatch: P1=2, P2=2); travel distance is a genuine haversine calc but null here when venue coverage is missing (not fabricated). This module casts a real, non-default vote (weightUsed>0) in this snapshot, consistent with the 2026-07-13 engine version. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE) fully excludes Availability from the ensemble vote -- treat as historically accurate for its generation date, NOT current live behavior. Also note: no verified pre-match news-only injury/withdrawal feed is connected at all (availability.ts) -- 'Availability' here never means 'confirmed healthy', only 'no retirement/walkover found in the match record'. |
| Head-to-Head | 24.7% | 0.126 | 60 | DERIVED | Real recorded head-to-head: P1 1 - P2 2. |
| General Model | 48.9% | 0.381 | 79 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Clay) | 51.2% | 0.619 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Clay applied (blend weight 62%), measured on 85 validation-segment predictions across 255 real historical ATP — Clay matches. |

**Combination outputs:** predictedWinner=J. Estevez | predictedWinnerProbability=50.3% | calibratedProbability=50.3% | dataQuality=79 (Strong) | modelAgreement=Mixed | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=None | modelConflict=None | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #362 -- E. Winter vs S. Kirchheimer

**Sample rationale:** Elite Tier TRUE, ATP tour, Specialist ON, materially away from 50%

- Tournament: ATP Challenger Granby | tournamentLevel field: `ATP250` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=362, `matchIdentityKey`=3318|3706::atp challenger granby::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-362
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T15:15:53.668Z
- Resolution: actualWinnerId=None, actualWinnerName=None, resolvedAt=None


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 59% | 0.322 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=69, P2 n=63). |
| Serve & Return | 66.3% | 0.305 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 51.5% | 0.279 | 100 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 68.8% | 0.06 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 51.2% | 0.034 | 40 | DERIVED | Real recorded head-to-head: P1 1 - P2 1. |
| General Model | 66.7% | 0.5 | 94 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Hard) | 76.4% | 0.5 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Hard applied (blend weight 50%), measured on 241 validation-segment predictions across 1067 real historical ATP — Hard matches. |

**Combination outputs:** predictedWinner=E. Winter | predictedWinnerProbability=71.6% | calibratedProbability=71.6% | dataQuality=94 (Excellent) | modelAgreement=Moderate | upsetRisk=LOW | recommendation=MODERATE_LEAN | isEliteTier=True | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #386 -- V. Kopriva vs D. Prizmic

**Sample rationale:** Elite Tier TRUE, ATP tour, Specialist ON, strong underdog favored (20%)

- Tournament: ATP Umag | tournamentLevel field: `ATP250` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=386, `matchIdentityKey`=1083|10869::atp umag::Clay::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-386
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T17:57:10.204Z
- Resolution: actualWinnerId=None, actualWinnerName=None, resolvedAt=None


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 28.1% | 0.331 | 100 | DERIVED | Adequate same-surface sample for both players (P1 n=69, P2 n=62). |
| Serve & Return | 36.3% | 0.315 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 47.8% | 0.287 | 100 | DERIVED | Tour-level shares adequate (P1=0.847, P2=0.865) -- minimal shrinkage applied. |
| Fatigue | 50% | 0.062 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 50% | 0.004 | 5 | DERIVED (genuine zero) | No prior meetings on record -- a real, verified absence of history (the normal case for most matchups), reflected as low reliability (~5) and near-zero ensemble weight. This is NOT the same as a missing/fallback 50% vote: the model still casts a real (near-neutral) vote and is weighted down proportionally by the ensemble's reliability x prior formula (ensemble.ts), never silently defaulted. |
| General Model | 29.1% | 0.387 | 94 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist (ATP — Clay) | 14.3% | 0.613 | 100 | DERIVED (genuine blend) | Segment specialist for ATP — Clay applied (blend weight 61%), measured on 85 validation-segment predictions across 255 real historical ATP — Clay matches. |

**Combination outputs:** predictedWinner=D. Prizmic | predictedWinnerProbability=80% | calibratedProbability=20% | dataQuality=94 (Excellent) | modelAgreement=Moderate | upsetRisk=LOW | recommendation=STRONG_RECOMMENDATION | isEliteTier=True | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #495 -- Batin/ Pieleanu vs Andreescu/ Schinteie

**Sample rationale:** RESOLVED -- prediction WRONG (upset), ITF Mens, HighDisagreement

- Tournament: M15 Bucharest 2 | tournamentLevel field: `ITF` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=495, `matchIdentityKey`=62733|92304::m15 bucharest 2::Clay::BestOf3, `inputSnapshotHash`=59140e38e26ed9a76b642d01dc660adaadc1a3eb69d400b61bc695b2fdd9c48d
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:53:00.793Z
- Resolution: actualWinnerId=62733, actualWinnerName=Andreescu/ Schinteie, resolvedAt=2026-07-13T22:53:00.792Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 49% | 0.219 | 39 | DERIVED | Thin same-surface sample for at least one player (P1 n=3, P2 n=18) -- rating blended toward overall (cross-surface) Elo (blend weights P1=0.473, P2=0.028) per the documented exp(-effectiveSampleSize/4) formula. Real match counts, genuinely low, correctly discounted -- NOT a fabricated or defaulted rating. |
| Serve & Return | 57.2% | 0.236 | 42 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 51.5% | 0.409 | 84 | DERIVED | Form backed mostly by sub-tour (Challenger/ITF) matches for at least one player (tourLevelShare P1=0, P2=0) -- score shrunk toward neutral (50) per the 0.35+0.65*share credibility formula. Real, derived, deliberately conservative -- not a fallback. |
| Fatigue | 49% | 0.105 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 3.4% | 0.03 | 20 | DERIVED | Real recorded head-to-head: P1 0 - P2 1. |
| General Model | 52% | 1 | 56 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=Batin/ Pieleanu | predictedWinnerProbability=52% | calibratedProbability=52% | dataQuality=56 (Acceptable) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #311 -- Madagascar W vs Namibia W

**Sample rationale:** Team event (Billie Jean King Cup) -- edge-case tournament type, Specialist OFF

- Tournament: Billie Jean King Cup - Group III Teams | tournamentLevel field: `Other` | Surface: Hard | Format: BestOf3
- Source record: `predictions` table id=311, `matchIdentityKey`=19633|52800::billie jean king cup - group iii teams::Hard::BestOf3, `inputSnapshotHash`=legacy-no-snapshot-311
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T09:08:55.140Z
- Resolution: actualWinnerId=52800, actualWinnerName=Madagascar W, resolvedAt=2026-07-13T15:54:54.313Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 56% | 0.043 | 5 | DERIVED | Thin same-surface sample for at least one player (P1 n=0, P2 n=0) -- rating blended toward overall (cross-surface) Elo (blend weights P1=1, P2=1) per the documented exp(-effectiveSampleSize/4) formula. Real match counts, genuinely low, correctly discounted -- NOT a fabricated or defaulted rating. |
| Serve & Return | 50% | 0.258 | 30 | DERIVED (proxy regime) | Provider point-level stats insufficient (<3 real-sample matches for at least one player) -- module fell back to a set/game-margin proxy per serveReturn.ts's documented MIN_REAL_SAMPLE=3 gate. Real match results, not fabricated, but a materially different (lower-ceiling, reliability capped ~60) calculation path than the real-stats path. |
| Recent Form | 55.6% | 0.447 | 60 | DERIVED | Tour-level shares adequate (P1=None, P2=None) -- minimal shrinkage applied. |
| Fatigue | 50% | 0.16 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 96.6% | 0.092 | 40 | DERIVED | Real recorded head-to-head: P1 2 - P2 0. |
| General Model | 63.1% | 1 | 37 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=Madagascar W | predictedWinnerProbability=63.1% | calibratedProbability=63.1% | dataQuality=37 (Limited) | modelAgreement=HighDisagreement | upsetRisk=MODERATE | recommendation=MODERATE_LEAN | isEliteTier=False | modelConflict=False | consistencyViolations=None

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---

### Match #552 -- Y. Putintseva vs P. Badosa

**Sample rationale:** Missing tournamentLevel (None) edge case, Specialist OFF

- Tournament: Bastad | tournamentLevel field: `None` | Surface: Clay | Format: BestOf3
- Source record: `predictions` table id=552, `matchIdentityKey`=2177|2178::bastad::Clay::BestOf3, `inputSnapshotHash`=4e139a116e493b641c60c04a0b19774560e12ef10d68d7af16b8fcc49020cf7a
- Generation timestamp (`createdAt`, closest available proxy for a pre-match research-lock/cutoff on this live-prediction record type -- see §2): 2026-07-13T22:53:24.018Z
- Resolution: actualWinnerId=2178, actualWinnerName=P. Badosa, resolvedAt=2026-07-13T22:53:24.017Z


| Model | Raw P1 Prob | Effective Weight (backend `weightUsed`) | Reliability | Provenance | Notes |
|---|---|---|---|---|---|
| Surface Elo | 50% | 0.291 | 93 | DERIVED | Adequate same-surface sample for both players (P1 n=25, P2 n=20). |
| Serve & Return | 48.1% | 0.297 | 95 | DERIVED (real-stats regime) | Provider per-match point statistics (service/return points won) available for >=3 matches per player; ratings computed directly from real stats, deepened with point-level inputs when available. |
| Recent Form | 46% | 0.271 | 100 | DERIVED | Tour-level shares adequate (P1=1, P2=1) -- minimal shrinkage applied. |
| Fatigue | 56.2% | 0.058 | 70 | DERIVED at generation time / SUPERSEDED | Fatigue casts a real, non-default vote here (weightUsed>0), consistent with the engine version live on 2026-07-13. Current code (dataQuality.ts EXCLUDED_FROM_ENSEMBLE, citing a '2026-07-13 ablation report') fully excludes Fatigue from the ensemble vote. This snapshot was captured at/near that methodology change -- treat this row as historically accurate for its generation date, NOT representative of current live behavior. |
| Head-to-Head | 13.8% | 0.083 | 100 | DERIVED | Real recorded head-to-head: P1 1 - P2 4. |
| General Model | 45.7% | 1 | 92 | DERIVED | Output of the tie-breaker -> calibration pipeline (index.ts) BEFORE the specialist blend is applied; weightUsed = 1 - specialistWeight when a specialist is applied, else 1 (index.ts:760). |
| Segment Specialist | -- | -- | -- | UNAVAILABLE (excluded, not defaulted) | This match's tour isn't one of Phase 6's candidate specialist segments (ATP/WTA on Hard, Clay, Grass, or IndoorHard) -- using the general model only. |

**Combination outputs:** predictedWinner=P. Badosa | predictedWinnerProbability=54.3% | calibratedProbability=45.7% | dataQuality=92 (Excellent) | modelAgreement=HighDisagreement | upsetRisk=EXTREME | recommendation=NO_STRONG_SIGNAL | isEliteTier=False | modelConflict=False | consistencyViolations=[]

**UI-layer fields (Favored / Contribution / Availability / Sample / Status) for this match, if viewed in the app:** all five are computed client-side from the two backend fields above (`player1Probability`, `weightUsed`) using the formulas in §6 -- classified **UI-DERIVED**, not backend facts. See §6 for the exact formulas and why `Contribution` and `Availability` in particular are potentially misleading as labeled.


---
## 9. Consolidated Classification Summary

| Field / Signal | Classification | Basis |
|---|---|---|
| Surface Elo probability, reliability, sample, blend weight | **DERIVED** | §4.1 — real Elo replay over real match results; formula-driven blending and reliability, cited to `surfaceElo.ts`. |
| Serve & Return probability, reliability (real-stats regime) | **DERIVED** | §4.2 — real per-match provider point statistics. |
| Serve & Return probability, reliability (proxy regime) | **DERIVED** | §4.2 — real set/game margins, correctly capped lower reliability. |
| Recent Form probability, reliability, tour-level shrink | **DERIVED** | §4.3 — real 10-match decayed window over real results. |
| Head-to-Head probability/reliability when no prior meetings | **DERIVED (genuine zero)**, not FALLBACK | §3, §4 — a real, correctly-low-confidence vote; not a synthesized 50/50. |
| Specialist Model (Segment Specialist) blend, when applied | **DERIVED** | §5.4 — genuine partial blend, real weight formula, hard-capped at 0.85. |
| Specialist Model, when unavailable | **UNAVAILABLE** (never DEFAULTED) | §5.2–5.3 — always disclosed via `segmentNote`; weight fully removed via renormalization, never replaced with 50%. |
| General Model probability | **DERIVED** | §5.4 — output of the calibration pipeline prior to the specialist blend. |
| Final calibrated probability / predicted winner | **DERIVED** | §3 — full documented pipeline: raw ensemble → tie-breaker (currently a no-op on the number) → calibration → specialist blend → reliability discount → optional simulator blend → clamp. |
| Ensemble "Effective Weight" (`weightUsed`), when a model appears in `models[]` | **DERIVED** | §3, §6 — real, formula-driven, per-model share of total ensemble weight. |
| "Contribution" (Weighted Contribution) | **UI-DERIVED, mislabeled** | §6 Finding A — real inputs, invented formula, does not measure what its name implies. |
| Per-model "Favored" | **UI-DERIVED** | §6 — computed client-side; directionally consistent with backend `>=50` convention but not itself a backend field. |
| Per-model "Availability" | **UI-DERIVED, name collision** | §6 Finding B — reuses a near-zero-weight test; distinct from, and not to be confused with, the real Availability model. |
| Per-model "Sample" | **UI-DERIVED, disconnected from real sample-size fields** | §6 Finding C — buckets `reliability`, ignores real sample-count fields the backend already computes. |
| Per-model "Status" | **UI-DERIVED** | §6 — arbitrary frontend thresholds, not backend-defined. |
| Fatigue/Availability/Match Load Recovery votes in the 2026-07-13 exhibit records | **DERIVED at generation time / SUPERSEDED** | §1, §3, §8 — real for the engine version that produced them; current code fully excludes these three from the ensemble vote. |
| Match #388 Specialist application to a `Challenger`-level match | **ANOMALY / UNRESOLVED** | §5.1, §8 — contradicts current `segments.ts`'s own documented tour-eligibility rule; could not be conclusively explained with the access available. |
| Player-orientation symmetry (swap invariance) | **VERIFIED** (by automated test), with one documented-and-fixed historical exception | §7. |
| Silent 50%-neutral-vote-on-missing-model | **Not found anywhere in the code read for this audit** | §3, §5.3 — deliberately and explicitly designed against; enforced by renormalization, not a special case. |

No instance of a **FALLBACK** classification (a genuinely fabricated or made-up value standing in for real data, silently) was found for any of the five audited models' core probability/reliability outputs. The closest things to "fallback" behavior found were: the Serve & Return proxy regime (§4.2 — a real, alternate, lower-confidence calculation, not a fabrication) and the Surface Elo opponent-baseline substitution (§4.1 — a real, documented corpus average, not a guess) — both are DERIVED, not FALLBACK, by this audit's definitions, and both are disclosed via warnings/notes rather than hidden.

## 10. Anomalies Requiring Follow-Up (Cannot Be Resolved From This Audit's Access Alone)

1. **Match #388 (and likely other Challenger-tier matches) receiving a Specialist Model blend.** §5.1, §8. Recommended follow-up: query the live `historical_matches`/prediction-input `tour` value (distinct from `tournamentLevel`) for this fixture's player IDs and date, to determine whether the value threaded into `resolveSegment()` at generation time was actually `"ATP"` rather than `"Challenger"` — and if so, whether that reflects a genuine tour misclassification upstream (e.g. in `deriveTour()` / the raw provider field) or a correct-but-confusingly-labeled situation (an ATP-sanctioned Challenger-tier event that the provider itself tags as tour type "ATP").
2. **`fallbackTracking.ts`'s Elo opponent-baseline substitutions are not visible on individual predictions.** §4.1. The tracker is architected for aggregate/run-level auditing (walk-forward, backfill), not per-prediction disclosure. A given match's Surface Elo output does not itself say whether one of its two Elo inputs used the corpus-baseline substitution rather than a real resolved opponent rating. Recommended follow-up: consider surfacing a `usedFallbackForOpponent: boolean` (or similar) on `SurfaceEloResult` if per-prediction disclosure of this specific substitution is desired.
3. **This audit's forensic exhibits (§8) are dated 2026-07-13, at or near several ensemble-inclusion methodology changes** (Fatigue, Availability moving from voting to non-voting). No live database access was available in this session to pull a fresh, current-methodology sample. Recommended follow-up: once DB credentials are available, re-run this audit's Section 8 sampling against live/current predictions to confirm the classifications in §9 still hold under the present `EXCLUDED_FROM_ENSEMBLE` set.
4. This audit read the core five models plus availability/dataQuality/fallback-tracking/disagreement/ensemble/eliteTier/segments modules in full. It did **not** exhaustively read Style Matchup, Weather, Match Load Recovery, or the Monte Carlo simulator's internals line-by-line for the same forensic depth — these did not appear central to the five models named in this audit's scope, but a follow-up pass could extend this same methodology to them.

## 11. Compliance With This Audit's Constraints

Per the assignment: **no model weights were optimized, and no methodology was changed** while producing this report — every file this audit touched was read-only (the only files written are this report itself and its supporting scratch data). Where a number looked undesirable (e.g. the Contribution formula in §6, or the Match #388 anomaly in §10), it is reported as a finding for the team to evaluate, not silently corrected or reasoned away. No values were manufactured to fill a gap in the available data; every "not determinable" in this report is stated as such rather than guessed.
