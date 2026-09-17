# 3-MONTH WALK-FORWARD REPLAY — RUN READINESS CHECK

**Status: PREPARED, NOT EXECUTED.** No HTTP endpoint was called, no job was started, and no
database was touched to produce this document — it is a static read of the code committed on
`claude/walk-forward-3month-validation-sriftc` (commit `80a662b`). Execution is gated on Agent 7's
pass, per instruction.

Vehicle: `runShadowPaperTradingReplay` (`services/evaluation/shadowReplay.ts`), supervised by
`shadowReplayJob.ts`, triggered via `POST /evaluation/shadow-replay/run-job`. This is the mechanism
the resource-safety audit fixed and recommended — not `walkForward.ts`, which still does an
unbounded full-corpus preload and was left untouched (see the audit report).

## 1. Start date / end date

**Not hardcoded anywhere** — both are required request parameters
(`StartShadowReplayJobOptions.startDate` / `.endDate`, validated as `YYYY-MM-DD` by the route's
`DATE_ONLY_RE` check). Nothing will run without them being supplied explicitly at trigger time.

Recommended values (pending Agent 7 / operator confirmation of actual data coverage — this session
has no DB access to confirm the corpus's real max date): a 3-calendar-month window ending on the
most recent date with confirmed graded results, e.g. `2026-06-01` → `2026-08-31`. Whoever triggers
the run should confirm the corpus actually has graded (non-null `winnerId`) matches through the
chosen `endDate` before launching — this doc does not verify that, since it required a live query.

## 2. Prediction cutoff behavior

Per-match, not per-run. Every `historical_matches` row already carries its own frozen `cutoffAt`
(`scheduledStartAt - cutoffMinutes`, set once at backfill/import time — see
`historicalMatches.ts` schema comment). `scoreHistoricalMatch` reconstructs each player's match
history via `reconstructPlayerMatchHistory(index, playerId, match.cutoffAt)`, which only returns
rows with `scheduledStartAt < cutoffAt` (strict inequality). This is unchanged by this session's
work — no cutoff logic was touched, per the Freeze requirement.

**Important nuance, confirmed by reading the code, not assumed:** because these are already-decided
historical matches loaded from the DB, the full row (including `winnerId`) is already in the
in-memory `match` object handed to `scoreHistoricalMatch`. No-look-ahead is enforced by *what the
engine consumes*, not by physically withholding the field: `runPredictionEngine` is only given
`match.surface`, `match.matchFormat`, `match.tournamentName`, `match.cutoffAt`, and the two players'
pre-cutoff match histories/head-to-head — never `match.winnerId`, `match.score`, or any other
outcome field. Verified by reading `historicalScoring.ts`'s `scoreHistoricalMatch` line by line: the
outcome fields are read into the `evaluation_predictions` row (`actualWinnerId`, `resultType`, etc.)
only in `shadowReplay.ts`, textually *after* `scored = await scoreHistoricalMatch(...)` has already
returned. There is no code path where the outcome reaches the ensemble's inputs.

## 3. Batch size

**One calendar UTC day per iteration.** Not configurable via any option today (no `chunkDays`
parameter exists). For a 3-month window this means ~90 iterations of the day loop. Within a day,
matches are scored strictly sequentially, one `INSERT ... RETURNING` per match (no batched insert).

## 4. Checkpoint frequency

**Every calendar day that contains at least one match.** After each such day, `onProgress` fires and
`shadowReplayJob.ts` writes a heartbeat to `job_runs.summary` (`lastDayProcessed`, `insertedSoFar`,
`daysSimulatedSoFar`, `heapUsedMB`, `heartbeatAt`). The durable "checkpoint" that actually matters
for resume is per-match, not per-day: every scored match commits immediately via
`INSERT ... ON CONFLICT DO NOTHING` against the unique `(runKind, historicalMatchId)` index, so the
real resume granularity is one match, not one day — a crash mid-day loses at most that day's
not-yet-inserted matches, all of which are cheap to redo.

## 5. Expected match count

**Not measured — no DB access in this session to run the count.** Rough order-of-magnitude only:
`shadowReplay.ts`'s own comment states the corpus spans 2021–2026 (~5 years) and the audit's cited
memory note puts total `historical_matches` at ~133K rows, averaging roughly ~2,200/month —
tennis has a real seasonal calendar (Slams/Masters vs. off-season), so a specific 3-month window
could plausibly range from a few thousand to ~8,000+ matches depending which months are chosen.

**Before launching, the operator should run one cheap, indexed, read-only query** (no context
building, no job start) to get the real number for the exact chosen window:
```sql
SELECT COUNT(*) FROM historical_matches
WHERE cancelled = false
  AND scheduled_start_at BETWEEN '<startDate>T00:00:00Z' AND '<endDate>T23:59:59Z';
```
This uses `historical_matches_scheduled_start_idx` and is safe to run standalone — it is not part
of the job and does not need to wait for Agent 7.

## 6. Database queries (per run)

Once, at run start (before the day loop):
- `buildPlayerIdentityIndex({scheduledBefore: rangeEnd})` — 2 queries over `historical_matches`
  (narrow 3-column projection), bounded by date.
- `buildEloHistoryIndex(identityIndex, {scheduledBefore: rangeEnd})` — 1 query over
  `historical_matches` (narrow projection) + 1 query over `match_feature_snapshots` filtered to
  `featureName='eloOverall'` — both bounded by date (this is the fix from the resource-safety pass;
  previously the second of these ran unbounded, once per day).
- `getActiveSpecialistSegments()`, `loadCalibrationHistory()`, `getPredictionSettings()` — 3 small
  queries, unbounded but over small tables (`specialist_models`, `calibration_models`,
  `prediction_settings`).

Once per calendar day with matches (~90x for a 3-month window):
- `SELECT * FROM historical_matches WHERE cancelled=false AND scheduled_start_at BETWEEN <dayStart> AND <dayEnd>` —
  indexed on `scheduled_start_at`.
- `SELECT historical_match_id FROM evaluation_predictions WHERE run_kind='paper_trade_shadow' AND historical_match_id IN (...)` —
  indexed via the unique `(run_kind, historical_match_id)` index.
- `SELECT * FROM historical_matches WHERE scheduled_start_at < <dayEnd> AND (player1_id IN (...) OR player2_id IN (...))` —
  the largest per-day query; uses the `historical_matches_p1_surface_date_idx` /
  `_p2_surface_date_idx` indexes via their leading `player_id` column (no surface predicate here,
  so it's a leading-column bitmap scan, not a fully covering index — acceptable, not a dedicated
  single-column index).

Once per scored match:
- `INSERT INTO evaluation_predictions (...) ON CONFLICT DO NOTHING RETURNING id` — one round trip,
  not batched.

Once per day (job wrapper, not the replay function itself):
- `UPDATE job_runs SET summary = {...} WHERE id = <jobRunId>` — the heartbeat write.

## 7. Memory limits

**Bounded by design, but not actively enforced by a hard ceiling — this is a real gap to flag, not
a solved item.** What exists: per-day context (`dayMatches`, `directMatches`, `scoringContext`)
falls out of scope every iteration (nothing day-scoped survives past that day), and the two
whole-run-lifetime structures (`identityIndex`, `eloHistory`) are now bounded by `scheduledBefore`
instead of loading the full corpus. `heapUsedMB()` is computed and reported every day via
`onProgress`/`job_runs.summary.heapUsedMB`, so a memory trend is visible while running.

What does **not** exist: no code path reads `heapUsedMB()` and aborts if it crosses a threshold.
If the container's real memory ceiling were hit anyway (e.g. an unexpectedly high-cardinality day),
the process would still hard-crash rather than checkpoint-and-stop gracefully. Given the per-day
design should stay well under the full-corpus OOM point that caused the original incident, this is
a lower-severity gap than the one that caused the prior crash, but it is not yet closed. Recommend
either accepting this risk explicitly for the first 3-month run (with someone watching
`job-status`/logs), or adding an enforced ceiling (e.g. abort-and-checkpoint above ~1.2GB heap)
before running unattended.

## 8. Cancellation

Implemented and wired: `ShadowReplayOptions.isCancelled` is polled once per calendar day, at the
top of the loop, before that day's queries run. `shadowReplayJob.ts` exposes this as
`requestShadowReplayCancellation()` / `POST /evaluation/shadow-replay/cancel-job`. A cancel request
takes effect at the *next* day boundary (i.e., up to one day's worth of matches may still be scored
and inserted after cancellation is requested) — this is a same-day-granularity cancellation, not
instant. `ShadowReplaySummary.cancelled` and `.lastDayProcessed` report where it actually stopped.

## 9. Resume behavior

No separate checkpoint table drives resume — it comes from the replay's append-only design:
every scored match is committed with `ON CONFLICT DO NOTHING` on the unique
`(run_kind, historical_match_id)` index, and each day's loop pre-checks which of that day's matches
are `alreadyClaimed` before scoring. Re-running the **same** `batchLabel` over the **same or
overlapping** date range after a crash/cancel skips every already-scored match and only scores what
remains. `shadowReplayJob.ts` makes this automatic by default: `batchLabel` defaults to
`walk-forward-replay-<startDate>-to-<endDate>` (deterministic from the two dates), so re-issuing the
identical `run-job` request after an interruption resumes the same batch rather than starting a
disjoint one. This has NOT been exercised against a real interrupted run in this session (no DB).

## 10. Output location

`evaluation_predictions` table, `run_kind = 'paper_trade_shadow'`, `shadow_batch_label = '<batchLabel>'`.
Never mixed into `historical_test` (walk-forward's bucket) or `paper_trade`/`live` (real-time
evidence) — enforced by the unique index being scoped to `run_kind`, and by every report/dashboard
consumer treating `paper_trade_shadow` as its own disclosed-as-simulated bucket
(`GET /evaluation/shadow-replay/dashboard`, never folded into `GET /evaluation/dashboard`).
Job status/progress (not prediction data) additionally lands in `job_runs` where
`job_name = 'shadow-replay'`.

## 11. Snapshot schema

Confirmed unchanged from the prior audit — no schema work was needed, the existing
`evaluation_predictions` columns plus `featureSnapshot` JSONB already cover every requested field:

| Requested field | Column / path |
|---|---|
| Match ID | `historical_match_id` |
| Prediction timestamp | `locked_at` |
| Cutoff timestamp | `cutoff_at` |
| Player 1 / Player 2 | `player1_id`/`player1_name`, `player2_id`/`player2_name` |
| Surface / tournament | `surface`, `tournament_name`, `tournament_level` |
| Each model's prediction, availability, sample, reliability, effective weight, contribution | `feature_snapshot.moduleWeights` (`ModuleTrace[]`) |
| Ensemble probability | `raw_probability`, `calibrated_probability` |
| Final prediction | `predicted_winner_id`/`predicted_winner_name` |
| Data quality | `feature_snapshot.dataQuality`, `feature_snapshot.isEliteTier` |
| Upset-risk information | `upset_risk_tier` |
| Actual result | `actual_winner_id`/`actual_winner_name`, `result_type` |
| Provenance | `model_version`, `shadow_batch_label`, `strategy_id`/`strategy_version`/`strategy_fingerprint` |

## 12. Actual-result reveal timing

Per match, not per day/run: the actual result is written into the SAME insert as the prediction
(`actualWinnerId: match.winnerId`, etc., in the single `INSERT` in `shadowReplay.ts`) — there is no
separate later "reveal" write. The no-look-ahead guarantee is not "the result is revealed later
in wall-clock time" (this is a same-process historical replay, not a paced real-time simulation);
it is "the result is provably never read as an input to the prediction" — see item #2 above for the
line-by-line confirmation of that.

---

## Open items before this should actually be run

1. **Confirm real `startDate`/`endDate`** against actual data coverage (item #1/#5) — needs a live
   `SELECT COUNT(*)`/`MAX(scheduled_start_at)` query this session cannot run.
2. **Decide on the memory-ceiling gap** (item #7) — accept the risk for a supervised first run, or
   add an enforced abort-and-checkpoint threshold first.
3. **Agent 7's pass** — per instruction, this run stays unexecuted until that gate clears.

No code was changed to produce this document. No job was started. No database was queried or
written.
