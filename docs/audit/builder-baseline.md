# Parlay Builder — Standalone Baseline Audit (Phase 0)

**Scope:** `computeBuilderScore` / `builderScoringService.ts` only. Read-only audit — no code
changed. Prepared as engine3/audit Phase 0, item 1.

**Session constraint, stated up front:** this session has no `DATABASE_URL` and no route to the
production ("helium host") Postgres instance the scripts below assume. `psql` and a local
Postgres 16 cluster exist on this machine but the cluster is **down** and, even running, would be
an empty local install — not the production `parlay_leg_outcomes` / `builder_decision_log` data.
**I did not start it, and I did not fabricate numbers to fill the gap.** Every figure below is
either (a) quoted from a script/doc already committed to the repo, with the query it came from
shown so it can be re-run against the real database, or (b) explicitly marked as missing. Nothing
here should be treated as independently re-verified by me — that requires DB access that does not
exist in this session, and is the single biggest open item at the end of this document.

---

## 1. The number I was asked to confirm does not exist in this repo

The brief asks me to confirm the segment behind "the parlay combo figure of 72.86% (n=16,836)"
before it is quoted anywhere. I searched the full text of both attached repositories
(`grep -rn "72.86"` and `grep -rn "16,836\|16836"`, no path restriction) and found:

- **`16,836` / `16836` appears nowhere in the codebase, docs, or scripts.**
- `72.86` appears in exactly one place: `artifacts/api-server/docs/audit-task172-step2-reversal-check.md`,
  line 83 — the calibrated output for the **Prediction Engine's** isotonic calibration model at
  `x=0.66` (raw probability bucket), n=**1,638**, **not 16,836**. That number belongs to the
  Prediction Engine's calibration audit (model id=712, `evaluation_predictions`, validation
  segment). It has nothing to do with the Parlay Builder, with a KEEP/BORDERLINE/REMOVE decision,
  or with a multi-leg parlay combo probability.
- The only "parlay combo" script in the repo, `auditParlayComboTestSegment.ts`, tests a
  **Prediction-Engine-only** filter ("High Data Quality ≥ 65 AND upset_risk_tier = 'LOW'") against
  `evaluation_predictions.segment IN ('validation','test')`. Its own stated original claim is
  **64.3% accuracy, n=311** (validation segment, early corpus) — not 72.86%/16,836 either. The
  script was never run in a way that left output in the repo (no captured log, no doc citing its
  result), so I cannot even tell you what it currently reports without DB access.

**Finding:** the 72.86%/n=16,836 figure cannot be traced to any script, doc, or table in this
repository. It does not match either of the two "72.86%" or "combo" artifacts that do exist. Per
the standing rule that an unlabelled number is unverified, this figure should not be quoted
anywhere until someone produces the query that generates it — I could not find one to run.

---

## 2. Does a standalone accuracy-by-decision-tier query already exist? Yes.

`computeBuilderAccuracyByDecision()` (`builderScoringService.ts:2202`) is a real, currently-wired
function — not a one-off script — that reads `builder_decision_log` and reports:

```sql
SELECT builder_decision,
  COUNT(*) FILTER (WHERE included_in_accuracy = true) AS picked,
  COUNT(*) FILTER (WHERE included_in_accuracy = true
                     AND builder_picked_player_id = actual_winner_id) AS correct
FROM builder_decision_log
WHERE actual_winner_id IS NOT NULL
GROUP BY builder_decision
```

served at `GET /admin/parlay/builder-accuracy`. This is the right shape for the headline
deliverable — per-tier (KEEP/BORDERLINE/REMOVE) accuracy — and it already carries a documented
minimum-sample gate (`MIN_SAMPLE_FOR_TIER_COMPARISON = 50`, `builderScoringService.ts:2187`) before
`invariantMet` is evaluated. **I could not execute it** (no DB). Running it, with the date range of
the underlying rows, is the single fastest way to get a real, citable number and should be the
first thing done once DB access exists.

There is a second, coarser query, `computeBuilderAccuracyStats()` (`builderScoringService.ts:2066`),
serving the same route, which pools all decisions into one coverage/accuracy figure and applies a
`COVERAGE_WARNING` label below 30% coverage — worth noting because it means the infrastructure
already treats "not enough graded rows yet" as a first-class, surfaced state rather than silently
reporting a number. That is good practice and should be preserved in whatever baseline reporting
comes out of this audit.

---

## 3. What the repo's own prior analysis claims (unverified by me — flagged accordingly)

`.agents/memory/parlay-calibration-findings.md` documents several backfill runs. Restating with
explicit segment/n/date labels **as claimed in that file**, not as verified here:

| Run | Segment | n | Date | KEEP win-rate | BORDERLINE win-rate | REMOVE win-rate |
|---|---|---|---|---|---|---|
| Edge-weighted agreement (Aug 2026) | `parlay_leg_outcomes`, all rows w/ `actual_winner_id IS NOT NULL` (mixed backfill + live, not split out) | 11,499 | not stated in the file | 66.7% (n=4,345) | 55.7% (n=6,790) | 55.8% (n=364) |
| Isolated weight-change comparison, Step 5b | same table, "both arms scored from stored factor_scores" | 9,978 | not stated | 67.3–67.4% | 54.9–55.1% | 56.3% |

These are **not train/validation/test segments** in the sense the governance rules require. They
are "all graded rows in the table at the time the script ran," which — per the backfill mechanism
documented below — is closer to a single in-sample corpus than an out-of-sample test. I am not
treating these as the standing baseline; I'm reporting them because they're the only concrete
numbers in the repo, and flagging exactly how they fall short of "labelled, out-of-sample."

---

## 4. The methodological problem with every number above: `selectedPlayerId` is never independent of the Prediction Engine in the backfill corpus

This is the most important finding in this document, and it is visible directly in code, not in a
doc that might be stale.

`POST /admin/parlay/backfill` (`adminParlay.ts:895`) is the only way `parlay_leg_outcomes` and
`builder_decision_log` get bulk-populated with graded (`actual_winner_id IS NOT NULL`) rows. Its
selection logic (`adminParlay.ts:950-957`):

```ts
// Use the model's predicted winner as the selected player (calibrated_probability > 50 → player1 wins).
const modelPicksP1 = (match.calibrated_probability ?? 50) > 50;
const selectedPlayerId   = modelPicksP1 ? match.player1_id   : match.player2_id;
```

Every single backfill row asks the Builder to validate **the Prediction Engine's own pick.** There
is no row anywhere in `parlay_leg_outcomes` (backfill-sourced) where `selectedPlayerId` disagrees
with the Prediction Engine's `calibrated_probability > 50` side. `.agents/memory/` confirms this is
deliberate ("Always use the model-predicted winner... as the selectedPlayerId").

Consequences for every backfill-derived number above:

- **KEEP/BORDERLINE/REMOVE win rates measure "how often was the Prediction Engine's own pick
  correct, conditioned on how the Builder graded it" — not "how often does the Builder correctly
  validate an arbitrary user's pick."** Those are different questions. The task description says
  this engine's job is to validate "the user's own pick," but the entire graded corpus was built by
  feeding it the model's pick as if it were the user's pick.
- Because the Prediction Engine's directional accuracy is already ~60-62% (per the same memory
  file) and both engines draw on overlapping real-world signal (rankings, surface record, form),
  the Builder's ability to separate KEEP from REMOVE on this corpus is partly just re-detecting
  "is this a case where the Prediction Engine's calibrated_probability was close to 50 vs.
  confidently high" — which correlates with PE accuracy for reasons that have nothing to do with
  the Builder's own independent evidence.
- **There is currently no backfill data — and therefore no accuracy number, verified or claimed —
  for the case that matters most for a validation engine: a user selecting the player the
  Prediction Engine does NOT favor.** That is exactly the scenario where an independent validator
  is supposed to earn its keep (catching a bad contrarian pick, or correctly clearing one). The
  repo has zero measured evidence either way for it.

`.agents/memory/parlay-calibration-findings.md`'s own isolated-weight-effect table (Step 5b) is
methodologically sound *for what it tests* — it's a same-input, weights-only A/B on stored
`factor_scores`, and the leakage check documented there (80/20 chronological split, `train`/`heldOut`
computed from `train` only) is real and I did not find a hole in it by reading
`auditParlayFactorWeights.ts` directly. But it inherits the selection-bias problem above, because
every row it operates on is a `selectedPlayerId == PredictionEngine.pick` row. "The reweighting
contributed +0.0pp" is a credible finding about the weights; it says nothing about whether the
engine adds value on a real, independent user pick.

**This is a P0/P1-adjacent finding for a document titled "baseline":** none of the win-rate numbers
that exist in this repo today are a clean standalone baseline in the sense the task asked for. They
are a baseline for "Builder validating the Prediction Engine's own output," which is closer to
what `computeCrossEngineAgreement`'s two offline scripts do (see `docs/audit/cross-engine-truth.md`)
than to the Builder's stated purpose.

---

## 5. What a clean baseline requires that does not currently exist

To answer the brief's actual question — "on historical legs, how often did KEEP win, how often did
REMOVE lose, how often did BORDERLINE go either way, segmented by tour/surface/leg-count, with a
real train/validation/test split" — the following are missing, not approximated:

1. **Backfill rows where `selectedPlayerId` is independent of the Prediction Engine's pick.**
   Nothing in `adminParlay.ts`'s backfill route supports this today; it would need a second backfill
   mode (e.g. sample `selectedPlayerId` uniformly between `player1_id`/`player2_id`, or specifically
   oversample the contrarian side) so the Builder is tested on genuinely independent selections,
   not just re-grading the Prediction Engine.
2. **A named train/validation/test split with dates, on the `parlay_leg_outcomes` /
   `builder_decision_log` tables specifically.** The `evaluation_predictions` table has a `segment`
   column (`'validation'`/`'test'`) used throughout the Prediction Engine's own audits
   (`auditParlayComboTestSegment.ts` uses it directly). Neither `parlay_leg_outcomes` nor
   `builder_decision_log` has an equivalent column per `ensureEvaluationSchema.ts` — I grepped the
   schema block for both tables and found no `segment`/`fold_id` column on either. Every builder
   accuracy number that exists today is effectively "in-sample, whatever's in the table," with no
   mechanical way to hold out a test slice the way the Prediction Engine does.
3. **Tour/surface/leg-count breakdowns.** `computeBuilderAccuracyByDecision()` groups only by
   `builder_decision`. `surface` and `tournament_name` are stored on `parlay_leg_outcomes` (columns
   confirmed in `ensureEvaluationSchema.ts`) but there is no existing query joining those onto
   `builder_decision_log`'s accuracy computation, and no leg-count field exists anywhere (parlay
   leg-count is a property of a *session*, not a *leg*, and `parlay_builder_sessions.legs` is a
   JSONB blob, not queryable per-count without a session join that isn't written).
4. **DB access**, to run `computeBuilderAccuracyByDecision()` and get the one number that already
   has correct plumbing (item 2 above), and to determine how many of the 11,499–39,000 rows cited
   in memory docs are actually graded (`actual_winner_id IS NOT NULL`) versus pending.

## 6. Recommendation (no code changes made — for Phase 1 planning only)

The fastest legitimate path to a real, labelled baseline is: (a) get DB access and run the
already-existing `GET /admin/parlay/builder-accuracy`, reporting its `byDecision` output with the
row-count and an honest caveat that 100% of the corpus is `selectedPlayerId == PredictionEngine.pick`
rows (segment = "backfill, PE-aligned picks only, in-sample" — not test); (b) treat that number as
provisional and clearly labelled as such; (c) prioritize adding an independent-selection backfill
mode so a genuine out-of-sample, PE-independent baseline can be built, since without it this engine's
core claim to independence is untested. This sequencing question is for Phase 1, not decided here.
