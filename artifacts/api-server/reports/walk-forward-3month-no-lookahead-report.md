# 3-MONTH NO-LOOK-AHEAD WALK-FORWARD REPORT

## Status: mechanism built and audited; not yet executed against real data

This session (a sandboxed Claude Code environment attached to the `tennis-stats-engine` GitHub
repository) has **no `DATABASE_URL`** and no reachable Postgres instance — there is no live copy of
`historical_matches` / `match_feature_snapshots` to score against. Producing the metrics this
report template asks for (accuracy, Brier score, log loss, calibration, etc.) requires actually
running the replay against the real ~133K-row historical corpus, which can only happen in an
environment with database access — this app's Replit deployment, per `replit.md` and the
`.agents/memory/` notes referencing Replit Scheduled Deployments and workflow restarts.

Rather than fabricate numbers, this report documents: (1) why running the *previous* mechanism for
3 months live would have been unsafe (the point of the resource-safety audit), (2) exactly what was
built and fixed so the run can now be launched safely, and (3) the precise command and expected
output shape so the real run can be executed and this report filled in with genuine numbers.

## Why no run was attempted here

The task is explicit: **"Do NOT launch a giant unrestricted historical job."** Before this session's
fixes (see the companion RESOURCE SAFETY REPORT), the only two candidate mechanisms were unsafe for
a 3-month window even if a database *had* been available:

- `walkForward.ts` (`runWalkForwardEvaluation` with `startDate`/`endDate`) preloads the **entire**
  historical corpus (~133K matches, ~229K Elo feature rows) regardless of how narrow the requested
  window is — this is the exact mechanism `.agents/memory/walkforward-historical-scoring-perf.md`
  documents crashing at ~2GB heap in this same class of sandboxed environment.
- `shadowReplay.ts` is architecturally the right tool (day-paced, bounded per-day context,
  append-only/resumable) but had a bug that rebuilt its ~229K-row Elo index from scratch on every
  one of the ~90 days in a 3-month range — not an OOM risk by itself, but enough redundant I/O to
  make a 3-month run impractically slow and a real resource-safety concern in its own right.

Both are now fixed (bounded corpus loading; the Elo-index rebuild hoisted out of the day loop) and
`shadowReplay.ts` now has a job wrapper with a restart-resistant lock, a 100-day safety cap,
cooperative cancellation, and live progress/memory reporting. See the RESOURCE SAFETY REPORT for
the full diff-level account.

## How to actually run it (once pointed at a real database)

```
POST /api/evaluation/shadow-replay/run-job
{ "startDate": "<3 months ago, YYYY-MM-DD>", "endDate": "<today, YYYY-MM-DD>" }
```

This uses the currently-active (frozen) calibration mapping as of each match's own `cutoffAt` — see
`shadowReplay.ts`'s top-of-file doc — and writes one row per scored match to `evaluation_predictions`
with `runKind = 'paper_trade_shadow'`, tagged with a deterministic `shadowBatchLabel`. No weights,
formulas, calibration, thresholds, Specialist gates, or ensemble methodology are touched — this is
strictly a frozen, no-look-ahead grading pass, exactly matching the task's Freeze requirement.

Poll `GET /api/evaluation/shadow-replay/job-status` for progress; the finished job's `result` field
is a `ShadowReplaySummary`. Aggregate metrics for the batch are then computed from
`evaluation_predictions WHERE run_kind = 'paper_trade_shadow' AND shadow_batch_label = '<label>'`
using the same `computeSegmentMetrics`/`computeCalibrationBuckets` helpers `backtestService.ts` and
the dashboard already use (`services/evaluation/metrics.ts`) — no new metrics code was needed for
this, since the existing evidence pipeline already reads this exact table/runKind pattern (shadow
replay is a pre-existing, shipped feature; only its resource safety for a 3-month span was in
question).

## Per-match snapshot: already satisfied by the existing schema — confirmed present, not newly built

The task's per-match snapshot field list maps directly onto columns and JSONB that
`evaluation_predictions` already carries on every `paper_trade_shadow` row (this was verified by
reading the schema and the insert in `shadowReplay.ts`, not assumed):

| Requested field | Where it already lives |
|---|---|
| Match ID | `historicalMatchId` |
| Prediction timestamp | `lockedAt` |
| Cutoff timestamp | `cutoffAt` |
| Player 1 / Player 2 | `player1Id`/`player1Name`, `player2Id`/`player2Name` |
| Surface / tournament | `surface`, `tournamentName`, `tournamentLevel` |
| Each model prediction, model availability, sample, reliability, effective weight, contribution | `featureSnapshot.moduleWeights` (`ModuleTrace[]` — per-module `weightUsed`/reliability/importance/raw edge/probability contribution; see `types.ts`'s `LiveFeatureSnapshot` doc) |
| Ensemble probability | `rawProbability`, `calibratedProbability` |
| Final prediction | `predictedWinnerId`/`predictedWinnerName` |
| Data quality | `featureSnapshot.dataQuality`, `featureSnapshot.isEliteTier` |
| Upset-risk information | `upsetRiskTier` |
| Actual result | `actualWinnerId`/`actualWinnerName`, `resultType` |
| Provenance | `modelVersion` (`HISTORICAL_MODEL_VERSION`), `shadowBatchLabel`, `strategyId`/`strategyVersion`/`strategyFingerprint` |

No schema or snapshot-shape changes were needed for this task — the gap was entirely in *how safely
the corpus is loaded to produce these rows over a 3-month span*, not in what each row records.

## Report sections requiring a real run (not fabricated here)

Once a real 3-month batch has been run per the command above, fill in from
`evaluation_predictions`/`computeSegmentMetrics` output:

- Total matches / gradeable matches / skipped (`skippedAlreadyClaimed`) / missing-data
  (`skippedInsufficientData`) — all already counted directly in `ShadowReplaySummary`.
- Accuracy, Brier score, log loss, calibration buckets, probability distribution, exact/near-50%
  frequency — via `computeSegmentMetrics`/`computeCalibrationBuckets` filtered to the batch.
- Model availability / disagreement — from `featureSnapshot.moduleWeights` and
  `featureSnapshot.engine.modelAgreement` aggregated across the batch.
- Surface / tour breakdown — group by `surface`/`tour` (join back to `historical_matches` for tour,
  which isn't denormalized onto `evaluation_predictions`).
- Chronological performance — `evaluation_predictions.scheduledStartAt` is already indexed; bucket
  by week/month within the batch.

## Recommendation

Run the job above in the environment with real database access (do not attempt it from a sandbox
with no `DATABASE_URL`, since there is nothing to score). Start with the 3-month window as
instructed; if `matchesInRange`/`inserted` from the resulting `ShadowReplaySummary` indicate too
thin a sample (e.g. well under the few-hundred-graded-row floor the rest of this codebase already
uses as a reliability floor — see `MIN_ELIGIBLE_FOR_TRAINING = 500` in `walkForward.ts` for the
precedent), report that explicitly before considering `allowExtendedRange: true` for a 6-month
window, per the task's own instruction.
