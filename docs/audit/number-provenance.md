# Number Provenance — Phase 0 Audit

**Scope:** every headline accuracy/log-loss/Brier/ECE figure quoted anywhere in `Tennis-Stats-Engine`'s code or `docs/`.
**Coverage caveat**: 21 of ~31 top-level docs were fully read before this research agent was asked to wrap up under a rate-limit constraint. **Unread**: `docs/EXECUTION-GUIDE-STAGES-1-2.md`, `audit-bulk-match-paste-player-resolution.md`, `audit-fatigue-redesign-investigation.md`, `audit-fatigue-window-logic-investigation.md`, `audit-four-area-investigation.md`, `audit-market-consensus-ablation.md`, `audit-matchloadrecovery-live-revalidation.md`, `audit-walkforward-backfill-2024.md`, `incident-runbook.md`, `phase10-14-audit-report.md`, `phase8-performance-notes.md`, `portal2-business-legal-defaults-2026-07-25.md`, `task77-elo-opponent-resolution-rebuild.md`, and all 80+ files under `.agents/memory/` (listed only, not individually read — several look numeric: `market-odds-ablation-results.md`, `parlay-calibration-findings.md`, `walkforward-historical-scoring-perf.md`, `confidence-discount-verification.md`, `calibration-*.md`). **Treat this document as a strong first pass, not exhaustive.** Recommend a follow-up sweep of the unread list — especially the fatigue/matchLoadRecovery/market-odds docs, which `audit-prediction-accuracy-complete.md` cites for specific accuracy claims this pass could not independently verify.

**Verifiability key**: no live DB access this session. **VERIFIABLE-BUT-NOT-RUN** = the doc shows its SQL/script and the underlying tables/scripts exist in-repo; re-runnable once DB access is granted. **UNVERIFIABLE** = asserted with no query, script, or reproducible method shown. Nothing in this document is marked VERIFIABLE-IN-REPO in the strong sense (independently re-run and reproduced) — this pass read documents, it did not execute anything against a database.

---

## Top-level contradictions (read this section first)

### Contradiction A — Recent Form / Fatigue / H2H / Availability ablation deltas are wildly inconsistent across docs claiming the same source

`docs/audit-recent-form-phase1.md:226-231,279` (2026-07-25), attributed only to *"2026-07-13 walk-forward"* with **no SQL/script shown**, claims: Recent Form leave-one-out delta **+3.2%**; Fatigue **-0.1%**; Head-to-Head **-0.4%**; Availability **-1.7%**. `docs/STAGE1-TASK61-Consolidated-Audit.md:30` repeats "+3.2%" as if independently confirmed.

This **directly contradicts three other documents citing the same nominal source** (Task #116, n=18,281, run 2026-07-13):
- `docs/audit-task162-findings-report.md:96-109` — Recent Form removal impact **+0.3pt** (not +3.2 — off by ~10×); Availability removal impact **+0.1pt** (not -1.7% — off by ~17×); Fatigue **+0.1pt**; H2H **0.0pt**.
- `docs/audit-phase45-availability-revalidation.md:58-77` — the actual primary source for the Availability number, full 18,281-match corpus: *"including Availability costs -0.1pt overall accuracy"* — matches task162's +0.1pt, not phase1's -1.7%.
- `docs/audit-prediction-accuracy-complete.md:569-573,633` — again cites the same 2026-07-13/n=18,281 study, reports +0.1pp for Availability.

**Three independent documents agree the Availability effect is ~0.1pp; only `audit-recent-form-phase1.md` claims 1.7pp, and its Recent Form number is ~10× every other citation of "the same" study, with no query cited.** **Assessment: UNVERIFIABLE as stated, contradicted by three other documents citing the same source.** Do not cite these four figures anywhere without this flag.

### Contradiction B — `audit-serve-return-phase3.md`'s "Tour + Surface Breakdown" table appears copy-pasted from the wrong module

`docs/audit-serve-return-phase3.md:215-237` presents as **Serve & Return's own** per-tour accuracy: ATP 60.32% (N=1,727), WTA 59.87% (N=1,642), Challenger 58.63% (N=5,736), ITF 61.57% (N=13,317).

These exact Ns and 3 of 4 percentages are **identical** to `docs/recent-form-specialists-serve-return-validation.md:57-60` — which is explicitly **Recent Form's** own "Breakdown by Tour" table, not S&R's (that table's ATP value is 58.02%, not 60.32%). The ATP figure used in phase3.md (60.32%) instead exactly matches Recent Form's **overall standalone accuracy** across the full n=22,689 corpus (`recent-form-specialists-serve-return-validation.md:34`) — unrelated to any single tour.

**Assessment**: three of four numbers in this table are actually Recent Form's numbers; the fourth has no traceable source as an S&R statistic. **UNVERIFIABLE as an S&R claim — flag as a likely copy/paste error**, in a document whose top-line conclusion ("S&R is correctly calibrated, no code changes needed") partly rests on this table. (The ECE-by-tour table in the same doc — ITF 0.0314, WTA 0.0306, ATP 0.0233, Challenger 0.0180 — correctly matches the true S&R-labeled ECE table elsewhere and is fine.)

### Contradiction C — "specialist_models is empty, walk-forward never run" (2026-07-25) directly contradicts a populated, real-accuracy state shown in docs from a week earlier

`docs/audit-specialist-models-phase2.md` (git-committed 2026-07-24) states flatly, with SQL shown returning 0: *"specialist_models table is empty... no walk-forward evaluation has completed yet."* `docs/STAGE1-TASK61-Consolidated-Audit.md` (same commit) repeats this verbatim — while its **own** line 31 says "22,689+ test predictions" for the same sprint. **Self-contradictory within one document.**

Both are flatly contradicted by docs committed **6 days earlier**: `docs/validation-sprint2.md:352-362` (2026-07-18) lists 5 active specialist segments with real computed accuracy (ATP-Hard 58.8% n=908, ATP-Clay 53.0% n=136, ATP-IndoorHard 68.0% n=290, WTA-Hard 57.9% n=1,174, WTA-IndoorHard 71.7% n=46); `docs/recent-form-specialists-serve-return-validation.md:325-335` (2026-07-18) states *"specialist_models was already populated from a prior training-mode walk-forward run"* and lists the same 5 segments; both docs also show tens of thousands of `evaluation_predictions`/`historical_test` rows already existing.

**Likely explanation**: `docs/audit-task162-findings-report.md:57` documents that `walkForward.test.ts` "unconditionally wipes and regenerates `evaluation_runs` and all `historical_test` rows every time it runs" (open bug, Task #135) — so the DB could genuinely have been reset between 07-18 and 07-24. **But `audit-specialist-models-phase2.md` never mentions this known wiping behavior or reconciles the contradiction** — it reads as if walk-forward had literally never been run, which is demonstrably false at some earlier point in the repo's own history.

**Assessment**: this is exactly the "closure doc doesn't match reality" pattern the working agreement warns about — a later "closure" audit (2026-07-24) asserts a system state inconsistent with what other documents in the same repo already showed existed on 2026-07-18, without acknowledging the discrepancy. **No strict doc-predates-code-commit instance was found in the git-date check performed** (see below), but this is the closest concrete analog: a doc's own claim is inconsistent with earlier, still-valid evidence in the same repository.

### Contradiction D — ATP-Hard/ATP-Clay specialist accuracy jumps implausibly between two dated snapshots, unexplained

`docs/validation-sprint2.md:355-356` (2026-07-18): ATP-Hard accuracy **58.8%** (n=908); ATP-Clay **53.0%** (n=136).
`docs/audit-task183-specialist-cascade-exclusion-bias.md:197-198` (2026-08-10, "2026-08-08 walk-forward run"): ATP-Hard **92.3%** (n=18,064); ATP-Clay **87.3%** (n=12,583).

Corpus size did grow substantially (908→18,064) and two real interventions occurred in between (Task #182 `constrainSpecialistKnotsToGeneral` blend fix, Task #184 curve refit — both documented, see `model-lineage.md` §4), so *some* change is expected. But a 58.8%→92.3% and 53.0%→87.3% jump is very large, the accompanying log-loss figures in the later doc (0.2461, 0.3444) are unusually low relative to every other accuracy number in the corpus (which cluster 55-67%), and **no document explicitly reconciles the magnitude of this jump**. `docs/audit-task184-specialist-curve-refit.md:55-64` (same day, 2026-08-10) shows a slightly different weight for the same segments — e.g. ATP-IndoorHard weight 0.700 there vs 0.850 in task183, a notable same-day cross-doc inconsistency, likely because the two docs snapshot a moving target at slightly different times.

**Assessment: UNVERIFIABLE without DB access.** Flag as needing direct re-verification (re-run the SQL in `audit-task183-specialist-cascade-exclusion-bias.md` §7) before trusting as a current headline figure — it looks anomalous next to everything else in the repo.

### Additional flagged tensions (not full contradictions, but worth stating explicitly in any downstream summary)

- **Calibration direction at the 80%+ confidence band flips between reports over time**: `validation-sprint2.md:85-91` (2026-07-18, n=291) found the 80+ band **overconfident** by 10.86pp; the same doc later (:376-377, post-Task#53-fix) still overconfident but improved to 9.4pp; `audit-task162-findings-report.md:153-159` (2026-07-15) also calls 70%+ "historically overconfident." By contrast `audit-prediction-accuracy-complete.md:420-426` (2026-08-07, n=3,023, much larger sample) finds the 80+ band **underconfident** by -6.8pp — the opposite direction. Likely explained by intervening calibration refits and a much larger sample, not an error — but the direction genuinely reversed and any summary must state which snapshot it's citing, never "the model is overconfident/underconfident" unqualified.
- **DQ-tier accuracy inversion is far starker on live data than on the test segment**: `audit-live-verification-121.md:89-95` (live `predictions` table) shows Poor DQ 96.9% (n=487) vs Excellent DQ 62.7% (n=1,414) — a 34pp gap. `audit-prediction-accuracy-complete.md:222-226` (test segment, much larger n) shows a milder, non-monotone pattern ranging 59.6%-64.6% — ~5pp range. Both are real findings from different segments; conflating them as "the same inversion" would overstate the test-segment finding or understate the live one.
- **S&R proxy-vs-real split numbers differ by corpus size, same day**: `module-audit-recent-form-snr.md:100-101` (n=8,865 corpus): proxy 66.8% vs real 60.7%. `recent-form-specialists-serve-return-validation.md:213-214` (same day, expanded n=22,689 corpus): proxy 64.42% vs real 58.86%. Not a contradiction (corpus grew same-day), but a reader skimming headlines would see two different "S&R proxy vs real" splits for supposedly the same finding — always state the n alongside the percentage.
- **Form/Elo conflict gate's estimated accuracy gain is inconsistent by an order of magnitude**: `audit-recent-form-phase1.md:183-186` claims "+1.3pp gain by gating Form" for the same 163-row cohort that `module-audit-recent-form-snr.md:75` estimates at "+0.2pp overall accuracy." Likely a cohort-vs-corpus-denominator confusion, but stated as flatly different headline numbers in two docs.

**Doc-predates-code check performed**: `git log --follow --diff-filter=A` was run on the key synthesis docs and cross-checked against `git log` on the source files they claim to verify. **No clean case was found where a doc's own commit date is literally earlier than the code change it claims to verify**, among the files checked. Contradiction C is the closest analog found — chronologically *later* than the data it should have been able to see, but describing an inconsistent state. This check was not completed systematically across the unread doc list (see coverage caveat above).

---

## Per-document number inventory (condensed)

### `docs/audit-prediction-accuracy-complete.md` (2026-08-07) — the most current/authoritative master doc
- **Overall test-segment accuracy: 62.8%**, n=52,456, segment=test, date range 2021-06-01→2026-08-01. VERIFIABLE-BUT-NOT-RUN.
- Validation segment (reference): n=74,968, 63.9%.
- Tie-break: no-TB 66.8% (n=36,682) vs TB-applied 53.5% (n=15,737), test segment.
- DQ-tier accuracy (test segment): Excellent 62.5% (n=19,755), Strong 64.2% (n=15,411), Acceptable 63.3% (n=5,930), Limited 64.6% (n=3,734), Poor 59.6% (n=7,624) — non-monotone, flagged in-doc.
- modelAgreement accuracy: Mixed 72.3% (n=1,952), Moderate 72.1% (n=4,244), Strong 66.3% (n=27,135), HighDisagreement 54.8% (n=19,088).
- specialist_applied accuracy: false 64.0% (n=32,378) vs true 60.9% (n=20,041); by surface Clay -7.0pp, Grass -4.1pp, Hard -1.2pp when specialist applied. **Note**: this is a different specialist-evaluation methodology than the `specialist_models` validation-accuracy figures in `validation-sprint2.md`/`audit-task183` — two different "specialist accuracy" concepts, easily confused if quoted out of context.
- Calibration-gap by band (test segment): 80+ n=3,023, gap -6.8pp (underconfident) — see flagged tension above.
- Elite tier accuracy: true 70.5% (n=7,104) vs false 61.6% (n=45,315).
- Fallback rate/accuracy figures — see `silent-fallbacks.md` for full treatment; this doc's 60.8%/63.3% clean-vs-fallback split (test segment) differs in scope from `audit-live-verification-121.md`'s 60.4%/63.7% (all segments pooled) — same direction, different scope, not a contradiction but must be labeled by segment.
- Cites `audit-fatigue-window-logic-investigation.md` (unread this pass) for "conditional accuracy when Fatigue fires: 54.9%, n=7,321" and `audit-matchloadrecovery-live-revalidation.md` (unread) for "removing MLR: 0.0pp, n=4,001" — **both UNVERIFIABLE by this pass directly; flag for follow-up read.**

### `docs/audit-live-verification-121.md` (2026-08-07)
- Fallback rate: 195,987 total rows, 140,819 fallback rows, **71.9%**. (This is the figure `silent-fallbacks.md` §0 flags as measuring only 3 narrow conditions.)
- DQ-tier accuracy (live `predictions` table): Poor 96.9% (n=487) vs Excellent 62.7% (n=1,414) — the starker version of the DQ inversion (see flagged tensions above).
- Segment counts: validation 89,379; test 63,602; live 43,006 (total 195,987).

### `docs/module-audit-recent-form-snr.md` (2026-07-18, n=8,865)
- Form-Elo conflict: ensemble-follows-Form n=163, accuracy **45.4%** (below coin flip); ensemble-follows-Elo n=60, accuracy **56.7%**. **This figure is consistently and correctly reused** across `audit-recent-form-phase1.md`, `audit-prediction-accuracy-complete.md`, `STAGE1-TASK61` — unlike the fabricated ablation deltas in Contradiction A, this one is reproduced consistently.
- S&R proxy 66.8% (n=5,524) vs real-stats 60.7% (n=3,341) — widely and correctly re-cited elsewhere.
- 13pp gap between avg calibrated confidence (51.27%) and actual accuracy (64.5%); Platt calibration ECE 0.0179 on test set — matches `validation-sprint2.md`'s own figures exactly (same underlying n=8,865 corpus, consistent).

### `docs/recent-form-specialists-serve-return-validation.md` (2026-07-18, n=22,689) — most granular RF/S&R source
- RF standalone: n=22,689, accuracy **60.32%**, log-loss 0.6840, Brier 0.2454, ECE 0.0854. (Source of the numbers misattributed to S&R in Contradiction B.)
- RF by tour: ITF 61.57% (n=13,317), Challenger 58.63% (n=5,736), ATP 58.02% (n=1,727), WTA 59.87% (n=1,642), Junior 46.75% (n=169, below 50%, flagged in-doc).
- 8 specialist candidate segments with hist-match/validation counts and accuracy/weight for the 5 active ones — the 2026-07-18 baseline for Contradiction D.
- Stage-2 table shows specialists **underperforming** the general model on 3 of 5 segments at this snapshot (ATP-Hard 58.8% specialist vs 63.2% general; ATP-Clay 53.0% vs 62.0%) — a data point distinct from the later Task #183/#184 story where specialists appear to dominate (92.3%). Worth flagging as "specialists sometimes underperformed the general model early on, before the Task #182/#184 fixes."

### `docs/audit-serve-return-margin-padding-fix.md` (2026-07-14) — genuinely re-runnable
- Overall accuracy: 57.79% (old/buggy) vs 57.78% (new/fixed), n≈9,200-9,300. Named, existing script: `src/scripts/analyzeServeReturnMarginFix.ts`. **Best candidate in the whole doc set for an actual re-run** once DB access is available.

### `docs/audit-task76-tour-level-credibility.md` (2026-07-13)
- Corpus mean Elo by tournament level → `CORPUS_BASELINE_ELO=1520` (this is the constant cited directly in `feature-trace.md` §1 and `model-lineage.md`).
- 4-fold walk-forward before/after tour-credibility fix: avg before 57.8%/0.676/0.241 vs after 57.65%/0.683/0.245 — doc's own conclusion "essentially unchanged," consistent framing.

### `docs/audit-task162-findings-report.md` (2026-07-15)
- Overall accuracy (historical_test, validation segment — no test-segment rows existed yet at this date): **61.5%**, n=3,987 accuracy-eligible.
- Per-module ablation table (Task #116, n=18,281; Task #157, n=4,000) — **this is the "true" source for the numbers Contradiction A misquotes.**
- Tie-break by deciding step (pre-removal cascade): not-applied n=2,478 acc 66.7%; S&R-decided n=1,374 acc 53.7%; Elo-decided n=120 acc 46.7% (below coin flip); RecentForm-decided n=7 acc 42.9%; Fatigue-decided n=3 acc 0.0%. **These exact numbers are reused verbatim and consistently in `audit-prediction-accuracy-complete.md`** — good cross-doc consistency, this is the source data underlying the -13.34pp tie-break cascade finding referenced in `model-lineage.md` §9.
- Calibration band table: 70%+ called "historically overconfident" at this date — see flagged tensions above for the later reversal.

### `docs/audit-task183-specialist-cascade-exclusion-bias.md` (2026-08-10) and `docs/audit-task184-specialist-curve-refit.md` (2026-08-10)
- Specialist metrics post-Task#182 fix: ATP-Clay 87.3% (n=12,583), ATP-Grass 85.8% (n=5,030), ATP-Hard 92.3% (n=18,064), ATP-IndoorHard 64.0% (n=386), WTA-Clay 68.1% (n=6,199), WTA-Grass 66.0% (n=3,304), WTA-Hard 74.4% (n=9,408), WTA-IndoorHard 60.3% (n=58). **This is Contradiction D — flag for direct re-verification before trusting.**
- Calibration model id=712, validationSampleSize=84,885 — the pooled/general-model sample size, distinct from any one segment's n.

### `docs/validation-sprint2.md` (2026-07-18) — earliest full validation report, foundational for many later citations
- Walk-forward fold-0: **Test n=8,865, accuracy 64.5%**, Brier 0.2233, LL 0.6392, ECE 0.0179. **This is the anchor figure that `module-audit-recent-form-snr.md` and much of the July audit chain build on.**
- Calibration-bucket table: 80+% n=291, gap +10.86pp (overconfident) — see flagged tensions above.
- Task #53 specialist segments: **primary source for Contradiction D's "before" numbers.**
- Three shadow-replay batches show accuracy trending: historical (2020-2025-04) 58.20%; Jan-2026 61.86%; Apr-Jul-2026 62.37% — all below the walk-forward-test 64.5% figure by -6.3pp/-2.6pp/-2.1pp respectively. **This gap between walk-forward-test accuracy and live/shadow-replay accuracy is itself worth flagging**: the headline 64.5% (and later 62.8%) test-segment figures may overstate what live traffic actually sees.

### `docs/task56-incremental-validation-report.md` (2026-07-13)
- An earlier specialist-weight snapshot (5 days before `validation-sprint2.md`) with different n's — consistent with rapid corpus growth, not a contradiction, just another point in a fast-moving timeline.
- Elite tier backtest: **real Elite n=0** at this date (structural — segment was null in historical scoring at the time).

### Docs with no accuracy numbers
`replit.md` (project overview only); `audit-phase1.md`, `audit-phase2.md`, `audit-phase3.md`, `audit-phase4-availability.md`, `audit-task22-player-coverage.md` (pre-backtesting-era architecture/data-provider audits, 2026-07-11) — `audit-phase3.md` does have non-accuracy verification counts worth noting: 8/8 leakage tests passing, idempotency check (0 new inserts on re-run of an already-imported window). VERIFIABLE-IN-REPO in principle (`pnpm --filter @workspace/api-server run test:leakage` exists per `replit.md`) — this is the one check in the whole document set that could be re-run directly without DB access to production data.

---

## Recommendations

1. **The current headline baseline** is `docs/audit-prediction-accuracy-complete.md` + `docs/audit-live-verification-121.md` (both 2026-08-07): **62.8% test-segment accuracy, n=52,456, date range 2021-06-01→2026-08-01.** Any accuracy figure quoted going forward should be this one, explicitly labeled with its segment/n/date-range — not any of the July-era figures (64.5%, 61.5%, etc.), which are superseded and were measured on different, smaller, differently-calibrated corpora.
2. **Do not cite** `audit-recent-form-phase1.md`'s four ablation-delta bullets (+3.2%/-0.1%/-0.4%/-1.7%) as fact anywhere without flagging Contradiction A.
3. **Do not cite** `audit-serve-return-phase3.md`'s "Tour + Surface Breakdown" table as an S&R-specific statistic — it is very likely mislabeled Recent Form data (Contradiction B).
4. **Explicitly resolve Contradiction C** before Phase 1: ask directly whether the 2026-07-25 "specialist_models empty" finding reflects the known `walkForward.test.ts` data-wiping bug (Task #135, still open per `audit-task162-findings-report.md`) or a genuine error in the 2026-07-24 audit batch. This determines whether any of that batch's other conclusions can be trusted.
5. **Re-verify Contradiction D** (the 58.8%→92.3% ATP-Hard specialist jump) against the live DB before treating it as a current figure — it is anomalous relative to every other accuracy number in the corpus.
6. Before finalizing any Phase 1 decision that depends on a specific number in this document, **run the underlying SQL/script against the live DB** — nothing here has been independently reproduced this session; every figure is a secondhand report of a prior query result.
7. Follow up on the unread doc list, especially `audit-fatigue-*`, `audit-matchloadrecovery-live-revalidation.md`, `audit-market-consensus-ablation.md`, and `task77-elo-opponent-resolution-rebuild.md`, which `audit-prediction-accuracy-complete.md` cites for claims this pass could not independently verify.
