# TEMPORAL INTEGRITY & LEAKAGE REPORT — P2 Package 7

**Scope:** `shreddedbear/tennis-truth-engine-8ecc1270` (the Truth Engine — independent audit/calibration
system) and `shreddedbear/tennis-stats-engine` (the prediction engine, historical backfill, evaluation,
optimizer and paper-trading system). Audit-only: no weights, calibration, or model formulas were
changed. No giant jobs were run — targeted static tracing plus small, already-scoped automated test
files (no full historical replay, no optimizer sweeps).

**Method:** search → inspect → trace → identify → targeted test, per coordination rules. Where an
existing automated test already proves a property, it is cited as evidence rather than re-derived.
Two files (836 and 658 lines) plus the paper-trading/walk-forward/backtest subsystem were delegated to
a read-only sub-agent to stay within targeted-review scope; its findings are folded in below and
independently spot-checked by me at the cited line numbers.

**Classification key:** `VERIFIED SAFE` / `POTENTIAL RISK` / `CONFIRMED LEAKAGE` / `UNVERIFIED`.

---

## 0. Executive summary

Both repos already carry a serious, self-critical temporal-integrity culture: a documented Phase 13
forensic audit in the Truth Engine found and fixed a real fail-open cutoff bug, an adversarial
"append 80 future rows, prove byte-identical output" test exists and still passes, and the Stats
Engine's historical backfill pipeline is transactional, append-only, and defended in depth. On top of
that base, this audit found **two confirmed, previously-undetected defects** in the Stats Engine's
live-ensemble reuse for historical scoring/optimization, and one weaker "in-sample calibration
contamination" risk. None of the three exposes a match's *actual future result* to its own prediction —
none is the maximal "sees the answer" leak the critical test below is designed to catch — but two of
them **do** let wall-clock "today" or an untested strategy silently substitute for the frozen historical
boundary, which corrupts historical evaluation numbers and, for the optimizer, makes its candidate
ranking meaningless. These are exactly the failure class the coordination brief is worried about and
should be prioritized before any further optimizer or calibration work resumes.

| # | Finding | Repo | Classification |
|---|---|---|---|
| 1 | `computeAvailabilityModule` uses `new Date()` instead of the historical `asOfDate` | stats-engine | **CONFIRMED — temporal cutoff violation** |
| 2 | Optimizer writes the same pooled `holdoutMetrics` onto every candidate; candidates are never individually scored | stats-engine | **CONFIRMED — root-cause bug, not leakage per se** |
| 3 | `runEvaluationBacktest` loads a candidate's config but never passes it to the scorer | stats-engine | **CONFIRMED — root-cause bug, not leakage per se** |
| 4 | Ad-hoc backtest applies "currently active" calibration uniformly, can overlap that model's own fitting window | stats-engine | POTENTIAL RISK |
| 5 | Cutoff is parsed from a free-text context string by regex (Truth Engine) | truth-engine | POTENTIAL RISK (fragile, but fails closed) |
| 6 | Nine pre-Phase-12 metric specs have no small-sample guard | truth-engine | POTENTIAL RISK (statistical robustness, not temporal — flagged for the relevant package, see §7) |
| 7 | `audit-pipeline.test.ts` / `audit-engine.test.ts` / two `*.leakage.test.ts` files could not be executed in this sandbox | truth-engine | UNVERIFIED (environment-blocked, not a code finding) |
| Everything else below | | VERIFIED SAFE |

---

## 1. The critical test (insert a future record; the historical prediction must not change)

**This test already exists and already passes, with real data, in the Truth Engine** (`docs/audit-truth-engine-phase13-anti-leakage.md`, "Historical immutability (Phase 3/17)"):

> 80 adversarial future rows were appended to the live source dataset: 40 future losses collapsing one
> player's Elo from ~2350 to 900, 40 future wins for the other, and a brand new shared opponent. A
> 2024-01-01 audit was run before and after. Result: **byte-identical** across all nine measured
> quantities. The dataset was then restored and verified by md5 checksum.

I re-ran the self-contained regression suite that encodes this class of test (does not require a live
DB or Supabase credentials):

```
bun test src/lib/temporal-boundary-producer-leakage.test.ts \
         src/lib/audit-metric-0{20,26,36,38,40,43,44,45,51,52,61,62}-*.leakage.test.ts
→ 27 pass, 0 fail, 63 expect() calls (12 files)

bun test src/lib/truth-engine-calibration.test.ts src/lib/truth-engine-immutability-inversion.test.ts \
         src/lib/truth-engine-decision.test.ts src/lib/truth-engine-decision-record.test.ts \
         src/lib/truth-engine-reproducibility.test.ts src/lib/calibration-control-plane-lockdown.test.ts \
         src/lib/truth-engine-active-metrics.test.ts src/lib/truth-engine-only-25-active-vote.test.ts \
         src/lib/truth-engine-stress-state.test.ts src/lib/deterministic-historical-results-metrics-asymmetry.test.ts \
         src/lib/truth-engine-stage-mapping.test.ts
→ 238 pass, 0 fail, 1529 expect() calls (11 files)
```

Two files (`truth-engine-temporal-integrity.leakage.test.ts`,
`warehouse-first-researcher-temporal-boundary.leakage.test.ts`) could not run in this sandbox
(`Cannot find module '@supabase/supabase-js'` — the package registry is unreachable here, `bun install`
returned HTTP 403 for every dependency). These are marked **UNVERIFIED (environment-blocked)**, not
failing — the error is a missing-module error before any assertion runs, not a broken assertion.
`audit-engine.test.ts` / `audit-pipeline.test.ts` also could not fully run: they use vitest's
`vi.mock(path, async (importOriginal) => ...)` API, which `bun test`'s vitest-compat layer does not
implement (`importOriginal is not a function`) — a test-runner mismatch, not a code defect. 15 of 17
tests in those two files still passed under the partial run.

**Equivalent test in the Stats Engine**, run continuously in CI as `leakage.test.ts`
(`artifacts/api-server/src/services/historicalData/leakage.test.ts`), asserts directly against the
live-populated store rather than a synthetic model — it checks `sourceTimestamp < cutoffAt` for every
stored feature snapshot, `cutoffAt < scheduledStartAt`, no snapshot's source data at/after the match's
own start time, and an exact reconstruction of `matchesPlayed` from independently-computed prior-match
counts. This could not be executed in this sandbox (needs `DATABASE_URL`/Postgres, not available here)
but was read in full; see §4 for the code-level reasoning that backs it.

**Verdict for the literal critical test as stated: VERIFIED SAFE**, on the evidence above, for every
code path that participates in the *raw, cutoff-bound scoring* of a historical match in either repo.
The two CONFIRMED findings in §3 are a different, narrower failure mode — not "a future match result
reaches the prediction," but "today's wall-clock date, or another candidate's config, silently
substitutes for a value that should have come from the historical record" — see below for why that
still matters and how it would show up if you ran this exact test against those two code paths
specifically.

---

## 2. Verify: cutoff enforcement, area by area

### 2.1 Player/ranking/surface history, Elo, recent-form windows — Stats Engine (`historicalData/`)

`VERIFIED SAFE`, strong code-level defense in depth, traced directly:

- `backfill.ts` processes fixtures in strict chronological order; `computeFeatures()`
  (`features.ts:44`) reads only from `PlayerState.history`, which is built by `applyMatchResult()`
  strictly after that match's own snapshot is written, never before.
- Every feature row is filtered a second time at write time
  (`backfill.ts:362`: `.filter(f => f.sourceTimestamp.getTime() < cutoffAt.getTime())`) — "defense in
  depth" per its own comment, independent of `computeFeatures()`'s own correctness.
- The match row and all of its feature snapshots are written in **one transaction**
  (`backfill.ts:372`), specifically to prevent a crash between the two inserts from producing an
  orphaned match with silently-lost features; a fixture-injection test
  (`leakage.test.ts:134-271`) proves this fails loudly (`Data integrity violation`) rather than
  silently.
- Re-running the backfill over an already-imported window does not re-derive features; it recomputes
  the *expected* count from current in-memory state and throws if the persisted count disagrees
  (`backfill.ts:296-329`) — this is the same idempotency mechanism that would catch a corrupted replay.
- `cutoffAt` is frozen onto the match row at import time from that run's own `cutoffMinutes` config, so
  a later change to the default cutoff window can never reinterpret an old row (`docs/audit-phase3.md`
  §2).
- `player1Rank`/`player2Rank` are the provider's own historical per-fixture values, stored as-is
  (`backfill.ts:399-400`); the codebase's only *live* ranking lookup (`rankingVerification.ts`) is an
  explicit admin discrepancy-monitor, documented as not used at prediction time ("Discrepancies here do
  NOT imply an error in the model — the engine uses live-resolved rankings at prediction time, not
  stored ones", `rankingVerification.ts:22-26`) and not called anywhere in the backfill/scoring path.
- **Historical scoring's own reconstruction** (`historicalScoring.ts` / `matchRecordReconstruction.ts`,
  confirmed by the sub-agent's direct trace): `reconstructPlayerMatchHistory` /
  `reconstructHeadToHead` use `if (row.scheduledStartAt.getTime() >= cutoffMs) continue;` (strict), and
  `resolveOpponentStrengthFromIndex` explicitly comments that admitting a same-day-or-later point "could
  leak the outcome of this very match... into its own opponent-strength estimate" and guards against it
  (`opponentStrength.ts:46-74`).

### 2.2 Truth Engine producers (Elo replay, serve/return PBP, common-opponent, recent form)

`VERIFIED SAFE` for the 16 producers that adopted the shared `temporal-boundary.ts` helper
(`auditCutoff`/`isBeforeCutoff`/`isAtOrBeforeCutoff`, strict `<` / fail-closed on missing date) — this
is the module that resulted from the Phase 13 fix (§1). The BSD play-by-play producers
(`bsd-atp-main-pbp.server.ts`, `bsd-wta-main-pbp.server.ts`, `bsd-atp-challenger-pbp.server.ts`) and the
`task18c-rank-form-workload.ts` Elo-replay module use a parallel, independently-correct pattern —
`asOfDate` threaded explicitly as a typed argument, `Boolean(r.date) && r.date < args.asOfDate` (strict,
and safe even without the `Boolean` guard since a JS comparison against `undefined` is always `false`).
`asOfDate` itself is sourced from `match.scheduled_date` at the pipeline's entry point
(`audit-pipeline.ts:661`, comment: *"auditDate is the TYPED temporal boundary: the audited match's own
scheduled_date"*) and threaded through call sites as `asOfDate: match.date`
(`evidence-coverage-runtime-diagnostic.server.ts:170`), not derived from wall-clock time anywhere I
found.

### 2.3 Calibration artifacts

`VERIFIED SAFE`, both repos:

- **Truth Engine** (`calibration-backfill.ts`): "This NEVER selects, computes, or overrides a winner:
  it reads the already-committed deterministic decision... and simply records it alongside the
  now-known real result." `now` (wall-clock) is used only for the *observation's* `created_at`
  timestamp, never for eligibility or for re-deriving the frozen decision. Idempotent
  (`match_id`+`audit_run_id` dedup, backed by a DB partial unique index per the module comment).
  Write access is additionally locked down at the DB layer: `calibration_ledger`,
  `calibration_versions`, `calibration_buckets` are `service_role`-write-only as of
  `20260911104922_calibration_control_plane_lockdown.sql` — a browser/anon path can no longer forge a
  calibration row to "steer future calibrated ranges without touching a decision row," per that
  migration's own comment. 238 passing tests across the calibration/decision-integrity test files
  (§1) back this.
- **Stats Engine** (shadow replay, §2.4) and the calibration-refit job: `runCalibrationRefitJob.ts`
  requires `requireApproval: true` (never auto-activates), enforces a DB-backed 2-hour cooldown read
  from the table itself (restart-resistant, not an in-process flag), and a 500-new-graded-row floor
  before firing at all. `invalidateCalibrationCache()` — the thing that would make a live prediction
  see a new model — is only called once a model actually goes **active**, never when it's merely
  stored pending, so a background refit cannot silently swap what a paper-trading or live-prediction
  read sees mid-flight.

### 2.4 Specialist artifacts / model configuration freeze during evaluation

`VERIFIED SAFE`, Stats Engine, per the sub-agent's direct trace (independently spot-checked):

- `runWalkForwardEvaluation` in evaluation-only mode loads `frozenCalibrationMapping` **once**, up
  front, and reuses it across all folds; the pooled training-mode fit happens once, at the end, not
  interleaved with folds (`walkForward.ts:231-236`).
- `shadowReplay.ts`'s `getCalibrationMappingAsOf` reconstructs, per match, the calibration model that
  was `active` **as of that match's own `cutoffAt`**, from the full fitted-model history — explicitly
  not "whatever is active today." `shadowReplay.test.ts:184-315` is a directly adversarial test: one
  calibration row fitted *before* the test match's cutoff maps everything to 5%, one fitted *after* (the
  "current" one) maps everything to 95%, and the test asserts the replay uses the **before** mapping.
  This is about as strong a proof of artifact-freeze correctness as a unit test can offer.
- Walk-forward's own fold discipline (`walkForward.ts`): each fold is chronologically sorted,
  calibration is fit only from that fold's own (earlier) validation half and applied only to that
  fold's own (later) test half, and accuracy reporting filters to `segment === "test"` — never
  validation rows. `walkForward.test.ts` (414 lines) directly asserts fold/lockedAt/modelVersion
  presence, an append-only re-run guarantee (Task #109: re-running never deletes or rescopes prior
  folds), and that an early-return guard path never writes a calibration model at all (Task #78).

### 2.5 Optimizer configuration, paper trading, historical metrics — see §3 for the two confirmed defects found here.

---

## 3. Confirmed and potential findings — detail

### 3.1 CONFIRMED — `computeAvailabilityModule` uses wall-clock `new Date()` instead of the historical `asOfDate`

**File:** `artifacts/api-server/src/services/predictionEngine/index.ts:390`

```ts
const fatigue = computeFatigueModule(input.player1Matches, input.player2Matches, input.asOfDate);
const matchLoadRecovery = computeMatchLoadRecoveryModule(input.player1Matches, input.player2Matches, input.asOfDate);
const availability = computeAvailabilityModule(input.player1Matches, input.player2Matches, input.tournamentName ?? null, new Date(), input.webResearch ?? null);
```

`fatigue` and `matchLoadRecovery`, on the same line-pair, correctly receive `input.asOfDate`.
`availability` receives `new Date()` — real wall-clock "now" — regardless of what `asOfDate` the caller
supplied. This is the *exact same bug class* the codebase already found and fixed once: a comment three
call-sites away, inside `historicalScoring.ts:161-163`, reads:

> `// 2026-07-14 Fatigue asOfDate fix: measure Fatigue's 3/7/14-day windows against this match's own
> frozen cutoffAt, not today's wall-clock time -- see PredictionEngineInput.asOfDate.`

That fix was applied to Fatigue. It was never applied to its sibling, Availability, which computes the
same shape of feature (days-since-last-match, "within the last 3 weeks" walkover/retirement windows)
the same way. Tracing the actual mechanism (`availability.ts:138-160`):

```ts
daysSinceLastMatch = Math.max(0, Math.round((now.getTime() - lastDate.getTime()) / (24*60*60*1000)));
const cutoff = now.getTime() - RECENT_RETIREMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const recentRetirement = matches.find(m => m.retired && m.result === "L" && new Date(m.date).getTime() >= cutoff) ?? null;
```

`mostRecentMatch()` itself (`availability.ts:108-112`) applies **no cutoff at all** — it picks the
max-date row from whatever array it's handed, trusting the caller to have already bounded it. For
`historicalScoring.ts`'s call path, `player1Matches`/`player2Matches` *are* correctly pre-bounded to
`match.cutoffAt` via `reconstructPlayerMatchHistory` (§2.1), so this specific call site does not leak an
actually-future match's identity into the "most recent match" selection. What it does do:

- **Every** historically-scored match's `daysSinceLastMatch` is computed against **today's real date**,
  not the match's own date — for a match from mid-2024, that is on the order of 500+ days, regardless
  of the true (small) rest gap the player actually had. `restCategory` will spuriously read
  `LongLayoff` for virtually every historically-scored match.
- The "within the last 3 weeks" windows for `recentRetirement`/`recentWalkover` are anchored to
  `today - 21 days`, a window nowhere near the historical match — so these almost never fire for old
  matches, silently suppressing a real signal the model should have had.
- This output is **not decorative**: `index.ts:451` feeds
  `player1Edge: (availability.player1AvailabilityScore - availability.player2AvailabilityScore) / 2`
  into the ensemble as a weighted vote (`MODULE_IMPORTANCE.availability`,
  `ENSEMBLE_WEIGHT_PRIOR.availability`), so it materially moves the final probability produced by
  `historicalScoring.ts`, `walkForward.ts` (via the same engine call), and any optimizer/backtest path
  that scores historical matches through `runPredictionEngine`.
- Consequence for reproducibility specifically: **the same historical match, scored twice on two
  different real-world days with no new data inserted, can produce a different Availability edge and
  therefore a different ensemble output** — not because new information arrived, but purely because
  wall-clock time moved. That is a direct violation of the reproducibility invariant this whole
  codebase otherwise goes out of its way to prove (Truth Engine's "every historical audit must be
  reproducible" principle, §2.4's frozen-artifact evidence). It is also, precisely, a milder sibling of
  the critical test in §1: instead of *inserting* a future record and checking for a changed output,
  simply *waiting* changes the output.

This is not "the model sees the actual future match result" — it does not corrupt accuracy in a
model-breaking way, and live predictions are unaffected (`asOfDate` ≈ `new Date()` there anyway). But
it does mean every walk-forward/backtest/optimizer number that includes the Availability module's vote
is measuring today-relative-to-match-date noise, not the true historical signal, and it should be fixed
with the same one-line change the Fatigue module already received:
`computeAvailabilityModule(input.player1Matches, input.player2Matches, input.tournamentName ?? null, input.asOfDate ?? new Date(), input.webResearch ?? null)`.

### 3.2 CONFIRMED — optimizer's per-candidate `holdoutMetrics` are copied from one shared run, never computed per candidate

**File:** `artifacts/api-server/src/services/evaluation/candidateOptimizer.ts:429-830`, esp. 511-531,
773-779.

`runOptimizerRun` performs exactly one walk-forward evaluation and one pooled calibration fit
(`snapshotCalibration`). It then synthesizes up to 9 structurally distinct `StrategySpec` candidates
(different weights/gates/thresholds/calibration method/specialist routing — lines 222-417) plus retest
seeds, and writes the **same** `snapshotCalibration`-derived numbers onto every accepted draft's
`holdoutMetrics` (`isotonicHoldoutLogLoss`, `plattHoldoutLogLoss`, `holdoutSampleSize`, etc.) without
ever running that candidate's own weights/gates/thresholds through `scoreHistoricalMatch`/
`runPredictionEngine`. `validationStatus: "passed"` is set from generic acceptance checks (fold count,
spec-text novelty/diversity, retest quota) — never from that candidate's actual predictive performance.

This is not itself a temporal-cutoff violation (the underlying walk-forward run that produced
`snapshotCalibration` is correctly cutoff-bound per §2.1/§2.4) — it belongs more to "optimizer
configuration is broken" than "the optimizer saw the future." It is included here because the task
brief specifically named optimizer configuration as an audit area, and because its downstream effect
mimics leakage's practical harm: `optimizerSummary.ts:376-476` ranks `bestNewStrategy`,
`bestByCategory.*`, and the largest accuracy/Brier/log-loss improvements using numbers that are
identical across every candidate in a run — a structurally novel but predictively worthless candidate
can pass every check and be reported as the "best" one, indistinguishable from a genuinely superior
candidate, purely because none of them were actually scored differently.

### 3.3 CONFIRMED — `runEvaluationBacktest` loads a candidate's config but never applies it

**File:** `artifacts/api-server/src/services/evaluation/backtestService.ts:214-225, 306, 326.`

`runEvaluationBacktest(options)` accepts `candidateConfigId`, loads that candidate's `proposedConfig`
into `effectiveConfig`, logs "Backtest running with candidate config," and then calls
`scoreHistoricalMatch(match as any, scoringContext)` with no reference to `effectiveConfig` anywhere
except a boolean truthiness check that only decides whether to print that log line. The scorer always
runs the engine's hard-coded default weights. A user (or the optimizer) backtesting two structurally
different candidates gets back the same production strategy's performance twice, mislabeled by
`candidateConfigId` and persisted that way in `backtestRunsTable.metrics`. Same category as §3.2: not a
temporal leak, but a correctness defect that makes any promotion/comparison decision built on this path
meaningless, and worth fixing before any candidate-comparison work resumes per Coordination Rule 1.

### 3.4 POTENTIAL RISK — ad-hoc backtest can apply a calibration curve that overlaps its own fitting window

**File:** `backtestService.ts:293-299, 330-332.`

`runEvaluationBacktest` loads whichever `calibration_models` row is currently `active` and applies that
one mapping uniformly across the user-requested date range, without checking whether that range
overlaps the model's own fitting window (`walkForward.ts`'s pooled fit uses up to the last
`CALIBRATION_WINDOW_MONTHS = 24` months of validation points). A backtest over, say, "the last 3
months" can be scored with a calibration curve partly fit on outcomes from inside that same window —
in-sample calibration contamination. This is materially weaker than walk-forward's own fold-disciplined
split (§2.4) and than `shadowReplay.ts`'s genuinely point-in-time reconstruction (§2.4), and weaker than
the module's own header comment ("runs the current frozen model/calibration") implies for recent
ranges. Raw win-probabilities remain correctly cutoff-bound; only the *calibration curve's* independence
from the test window is in question. Recommend either restricting ad-hoc backtest windows to end before
the active model's fitting-window start, or routing ad-hoc backtests through `shadowReplay.ts`'s
as-of reconstruction instead of "currently active."

### 3.5 POTENTIAL RISK — Truth Engine cutoff is parsed from a free-text string by regex

**File:** `src/lib/temporal-boundary.ts:31-33`, self-documented as a known limitation in
`docs/audit-truth-engine-phase13-anti-leakage.md` ("Remaining limitations"):

> The cutoff is still parsed from a free-text context string by regex. It now fails closed, but passing
> the match date as a typed value would remove the parsing step entirely.

`auditCutoff()` fails closed (returns `null` → callers correctly treat that as "no admissible evidence"
per the Phase 13 fix), so this is not currently exploitable as a leakage path. It is fragile:
regex-matching a free-text context string is a needless indirection between a typed `scheduled_date`
and the value actually used as the boundary, and any future context-string format change is a single
point of failure for every one of the 16+ producers that depend on it. Recommend threading the typed
match date directly, as the doc itself already recommends, when that refactor is next in scope for
whichever package owns the audit pipeline's call signature.

### 3.6 POTENTIAL RISK, out of this package's scope — small-sample exposure on nine pre-Phase-12 metric specs

`docs/audit-truth-engine-phase13-anti-leakage.md`, "Known exposure NOT fixed" (Phase 19): metrics 001,
005, 011 (and six others with usable-but-unguarded denominators) can let a single-match sample on one
side outweigh a five-match sample on the other, with no sample-size guard, because the producer emits
an ambiguous `SAMPLE=n` shape shared with unrelated statistics. This is a statistical-robustness/data-
quality issue, not a temporal-cutoff issue — the data itself is correctly bounded, just thin. Flagging
as a **dependency** for whichever package owns metric/calibration robustness (likely the "50% Probability
Problem" or "Correlated Evidence" package in the master coordinator's list) rather than duplicating that
audit here, per Coordination Rule 2.

---

## 4. Artifact freeze — explicit verification

Requirement: calibration artifact, specialist artifact, and model configuration must be frozen for the
duration of a historical evaluation.

- **Calibration artifact freeze:** VERIFIED SAFE — §2.3/§2.4 (walk-forward loads once up front;
  shadow-replay reconstructs per-match as-of history rather than reading "active"; refit requires
  approval + cooldown + cache-invalidation only on activation).
- **Specialist artifact / model configuration freeze:** **CONFIRMED gap** for two of the three places
  configuration should be frozen and applied per §3.2/§3.3 — the optimizer's candidate configs and the
  ad-hoc backtest's candidate configs are not actually threaded into scoring, so "freeze" is moot; there
  is nothing frozen because the candidate's own config never reaches the scorer at all. Walk-forward's
  own default-config path (not candidate-config) is itself frozen correctly (§2.4).
- **Paper trading:** VERIFIED SAFE as a *live* system — `paperTrading.ts`'s `now`/`Date.now()` usage is
  correct because paper trading is genuinely live trading against the real clock, not a backtest; there
  is no "future" for it to leak from. `paperTrading.test.ts` directly tests the four lock-boundary cases
  (not-yet-due / within-grace / past-grace-not-started / already-started).

---

## 5. Reconciliation with the task's audit-area checklist

| Audit area | Status |
|---|---|
| Historical scoring | VERIFIED SAFE for raw cutoff-bound scoring (§2.1); CONFIRMED gap for the Availability module specifically (§3.1) |
| Truth Engine | VERIFIED SAFE, extensively self-audited already (§1, §2.2) |
| Specialist artifacts | CONFIRMED gap — optimizer/backtest candidate configs not applied (§3.2, §3.3) |
| Calibration artifacts | VERIFIED SAFE (§2.3, §2.4) |
| Player history | VERIFIED SAFE (§2.1) |
| Ranking history | VERIFIED SAFE — live ranking lookup is admin-only, not in the prediction/backfill path (§2.1) |
| Surface history | VERIFIED SAFE — surface-specific Elo sourced from the same cutoff-bound history (§2.1); the only caveat is a documented surface-vs-overall normalization gap that is a modeling nuance, not a leakage path (Phase 13 doc's "Remaining limitations") |
| Result indexes | VERIFIED SAFE (`matchesPlayed` exact-count leakage test, §1) |
| Optimizer configuration | CONFIRMED bugs (§3.2, §3.3); POTENTIAL RISK on calibration-window overlap (§3.4) |
| Paper trading | VERIFIED SAFE (§4) |
| Historical metrics | VERIFIED SAFE for the metric producers themselves (§2.2); CONFIRMED gap where they flow through the Availability module (§3.1) |

---

## 6. What I did not do (by design, per coordination rules)

- No full historical database replay; no optimizer sweep; no Monte Carlo batch; no calibration refit.
- No code changes to the prediction engine, calibration, or optimizer — this package's mandate is
  audit and evidence, not fixes, and Coordination Rule 8 keeps production methodology frozen until the
  evidence phase is complete. The three CONFIRMED findings above are each a small, targeted, well-
  understood change (one parameter substitution for §3.1; threading an existing variable for §3.2/§3.3)
  that the final coordinator can prioritize into the implementation order.
- `bun install` was attempted once in the Truth Engine repo to unblock two Supabase-dependent test
  files; it failed with HTTP 403 from every package-registry host reachable in this sandbox. This is an
  environment limitation, recorded in §1, not retried further per Coordination Rule 5 (protect
  resources, do not loop on a failing install).
