# CLEAN EVALUATION GENERATION PREFLIGHT REPORT

**Status: DESIGN ONLY. No generation job was run. No database was written to, scanned in bulk, or
mutated. No ablation, optimizer, or 3-month replay was run. No production methodology, weights,
calibration, thresholds, or gates were changed.** Based against `main` @ `1394afb`.

## 1. Recommended generation strategy

**Reuse `runShadowPaperTradingReplay` / `shadowReplayJob.ts` exactly as merged — zero code
changes required.** The neutral-order fix (`c551580`, merged into `main`) lives inside
`scoreHistoricalMatch`, the single function every evaluation path already funnels through
(walk-forward, backtest, shadow replay, bridge rescore, the frozen-vs-dynamic-weights script).
Shadow replay already calls `scoreHistoricalMatch` unmodified, so it automatically produces
neutral-order-scored rows with no changes needed to it. It is also the only one of the five
callers that already has: bounded per-day context (no full-corpus preload), cooperative
cancellation, a restart-resistant job lock, append-only checkpoint/resume, and — as of the
memory-ceiling hardening pass — a configurable OOM-avoidance stop. Building a second mechanism
on top of `walkForward.ts` (unbounded corpus preload, no batch labeling, evaluation-only mode
still writes to the OLD `historical_test`/`test` bucket) would be strictly more code and more
risk for no benefit.

Distinguish the new population purely by **`shadowBatchLabel`** under the existing
`runKind = 'paper_trade_shadow'` value (see §7) — no schema change, no new `RunKind` literal, no
new table.

## 2. Exact historical source population

**Table: `historical_matches`** (append-only, leak-proof store — schema:
`lib/db/src/schema/historicalMatches.ts`). Relevant columns for this task: `id`, `player1Id`,
`player2Id`, `winnerId`, `surface`, `matchFormat`, `tournamentName`, `tournamentLevel`, `tour`,
`scheduledStartAt`, `cutoffMinutes`, `cutoffAt`, `cancelled`, `retired`, `walkover`, `provider`.
No reacquisition is needed or recommended — this is the same corpus every existing evaluation path
already reads; nothing about the neutral-order fix requires new source data.

**Known source limitation, not a blocker:** the majority of rows are Sackmann-CSV-sourced
(`provider` reflects the actual ingest source, e.g. the Sackmann backfill sets its own provider
tag) and were ingested with `winner_id → player1_id` (`sackmannBackfill.ts`'s `rowToFixture`,
cited verbatim in the `c551580` fix commit). This is exactly the condition the neutral-order fix
neutralizes at evaluation time — it applies unconditionally in `scoreHistoricalMatch`, regardless
of `provider`, so no source-population filtering by provider is needed or beneficial.

## 3. Eligible date/sample range

Not independently re-verified against a live query in this session (no `DATABASE_URL` available
— same constraint as every prior preflight in this line of work). Best available static evidence,
each explicitly dated and sourced, not treated as current fact:

| Metric | Value | Source | As of |
|---|---|---|---|
| Total `historical_matches` | ~133,000 | `.agents/memory/walkforward-historical-scoring-perf.md` | 2026-07 |
| Sackmann-sourced rows specifically (winner-first at ingestion) | 179,986+ | `c551580` fix commit message | 2026-09-17 |
| ATP / WTA split (one snapshot) | ~9,567 / ~9,115 | `.agents/memory/specialist-tour-column-distinction.md` | undated, older |
| Corpus span | ATP main-draw mirror covers 1968–2024; live backfill continues forward | `sackmannBackfill.ts` header comment | current |

The 179,986+ figure exceeding the ~133K July figure most likely reflects genuine corpus growth
over the intervening ~2 months (continuous incremental backfill, per `runHistoricalBackfillJob.ts`)
plus the two figures measuring different things (all rows vs. Sackmann-only rows) — not
necessarily a contradiction, but not reconciled here either.

**Before authorizing any real run**, one cheap, bounded, read-only query should be run against the
live database (not done here):
```sql
SELECT COUNT(*), MIN(scheduled_start_at), MAX(scheduled_start_at)
FROM historical_matches
WHERE cancelled = false AND winner_id IS NOT NULL
  AND scheduled_start_at BETWEEN '<candidate start>' AND '<candidate end>';
```

## 4. Estimated match count

For the recommended smallest sample (§11, a 2–4 week contiguous window), order-of-magnitude
**~500–2,000 matches**, extrapolated from the ~2,200/month average cited in the prior 3-month
walk-forward readiness report, adjusted for real tennis-calendar seasonality (a Slam/Masters
fortnight is far denser than an off-season week) — not measured. For the larger, ablation-grade
sample Agent 4's own plan already establishes as its working precedent, **n ≈ 4,500**
(`docs/live-ablation-execution-plan.md`, stratified by surface × calendar-year via
`buildRepresentativeSample`), also not re-measured here.

## 5. Exact scoring path

Traced directly from source (not assumed), current as of `main`:

```
shadowReplayJob.startShadowReplayJob()
  → runShadowPaperTradingReplay()            [services/evaluation/shadowReplay.ts]
      for each UTC calendar day in range:
        dayMatches   = SELECT historical_matches WHERE scheduled_start_at BETWEEN dayStart..dayEnd
        directMatches = SELECT historical_matches WHERE scheduled_start_at < dayEnd
                         AND (player1Id IN today's players OR player2Id IN today's players)
        scoringContext = { matchHistory: buildMatchHistoryIndex(directMatches), eloHistory, identityIndex, ... }
        for each match in dayMatches:
          calibrationMapping = getCalibrationMappingAsOf(calibrationHistory, match.cutoffAt)
          scored = await scoreHistoricalMatch(match, scoringContext, calibrationMapping)
            → determineNeutralSlotOrder(match.player1Id, match.player2Id)   ***neutral-order fix***
                -- pure lexicographic comparison; never reads match.winnerId
            → engineP1Matches/engineP2Matches = reconstructPlayerMatchHistory(..., firstId/secondId, match.cutoffAt)
            → runPredictionEngine({ player1: firstId, player2: secondId, ... })   [UNCHANGED engine/methodology]
            → re-orient output back to "P(match.player1Id wins)" via the swap flag
          INSERT evaluation_predictions (runKind='paper_trade_shadow', shadowBatchLabel, ...)
            ON CONFLICT (runKind, historicalMatchId) DO NOTHING
```

**Confirmed: this IS the corrected neutral-order path.** `scoreHistoricalMatch` is called
unmodified by `shadowReplay.ts`; the fix lives entirely inside that one function, so every caller
of it — including this one — gets it automatically. Verified by reading the current
`historicalScoring.ts` on `main` line by line, not inferred from the commit message alone.

## 6. No-look-ahead mechanism

- **`cutoffAt` origin:** frozen once per row at import time as
  `scheduledStartAt − cutoffMinutes` (`historicalMatches.ts` schema comment: "the hard boundary:
  nothing timestamped at or after this instant may appear in this match's pre-match feature
  snapshot"). Never recomputed after insert.
- **Match-history reconstruction:** `reconstructPlayerMatchHistory`/`reconstructHeadToHead` keep
  only rows with `scheduledStartAt < cutoffAt` (strict inequality).
- **Opponent Elo:** `resolveOpponentStrengthFromIndex` takes the latest Elo snapshot strictly
  before the match's own time, per lookup — not a value computed once for the whole run.
- **Calibration:** shadow replay uses `getCalibrationMappingAsOf(calibrationHistory, match.cutoffAt)`
  — the mapping actually active as of THIS match's own cutoff, reconstructed from
  `calibration_models`' full fit history, not today's currently-active model applied uniformly.
  This is already stricter against future-calibration leakage than a single frozen mapping would
  be, and required no change for this task.
- **Rankings:** historical rows never populate `currentRank` on the `PlayerProfile` passed to the
  engine (`minimalProfile()` always sets it `null` for historical rows) — future ranking data
  cannot leak because it is never attached to a historical scoring call in the first place, live
  or otherwise.
- **Winner/outcome:** `match.winnerId` is never read anywhere inside `scoreHistoricalMatch`
  (verified in the current source, not assumed) — the neutral-order fix's own design constraint.
  It is read only afterward, by the caller, purely for post-prediction grading.
- **Neutral ordering itself cannot introduce leakage:** `determineNeutralSlotOrder` is a pure
  function of the two player ids only — no date, no outcome, no engine state — so it cannot vary
  by time and cannot smuggle in future information.

This is not newly designed for this task — it is Agent 7's already-merged, already-tested fix
(`c551580`) plus the pre-existing shadow-replay engine (Task #159/#160). Agent 7's own smoke test
(`historicalScoring.winnerFirstOrdering.test.ts`, 9/9 passing, merged in `1394afb`) directly proves
a future match record appended to either player's history does not change a historical
prediction, run against the current neutral-order code. **Not re-audited here, per instruction.**

## 7. Proposed new batch/run identity

No schema change. Reuse existing columns exactly as designed for this purpose:

| Field | Value | Why |
|---|---|---|
| `run_kind` | `'paper_trade_shadow'` (existing literal, already in the `RunKind` union) | Already structurally isolated from `historical_test`/`paper_trade`/`live` via the unique `(run_kind, historical_match_id)` index and every existing consumer's own segregation (dashboards never merge it in) |
| `segment` | `'live'` (shadow replay's existing convention — not `'test'`) | Deliberately NOT `'test'`, so nothing can accidentally alias it with the old `historical_test`/`segment='test'` population when queried loosely |
| `shadow_batch_label` | `clean-neutral-eval-v1-<start>-to-<end>` (e.g. `clean-neutral-eval-v1-2026-08-01-to-2026-08-14`) | Free-text, already indexed (`evaluation_predictions_shadow_batch_idx`), self-documents both the fix version and the window; deterministic so a resumed run reuses the same label automatically |
| status semantics | `job_runs.status`: `running` → `success`/`cancelled`/`failed`, exactly as built for the memory-ceiling work | Already implemented, needs no new state |

**The existing `run_kind='historical_test' AND segment='test'` population is never read,
written, or referenced by this path at all** — different `run_kind` entirely, so it is
structurally impossible for this to touch it, not merely a convention that could be violated by
mistake.

**Deferred alternative (not recommended, noted for completeness):** a new `RunKind` literal (e.g.
`'historical_test_clean'`) would be a one-line TypeScript union change (the column itself is plain
`text`, no DB-level enum), not a schema migration. This would read more semantically clean than
reusing "shadow" terminology for what is really a walk-forward-style held-out population, but it
is unnecessary work for this preflight's goal and was not pursued, per "do not add schema changes
unless genuinely necessary."

## 8. Expected DB reads/writes

Per the smallest recommended sample (§11, ~14–28 days): reuses exactly the query shape already
documented in the prior run-readiness report, scaled down —

- **Once at start:** 2 bounded queries (`buildPlayerIdentityIndex`), 2 bounded queries
  (`buildEloHistoryIndex`), 3 small-table queries (`getActiveSpecialistSegments`,
  `loadCalibrationHistory`, `getPredictionSettings`).
- **Once per day (×14–28):** 1 date-bounded `historical_matches` select, 1 indexed
  already-claimed lookup, 1 player+date-bounded `historical_matches` select (the largest per-day
  query).
- **Once per scored match (~500–2,000):** 1 `INSERT ... ON CONFLICT DO NOTHING`.
- **Once per day (job wrapper):** 1 `job_runs` heartbeat `UPDATE`.

No bulk reads of the full ~133K–180K-row corpus at any point — this is the entire point of the
per-day bounded design already built and hardened in the prior two passes.

## 9. Memory/resource protections

All already implemented and unit-verified in the prior pass (`fc0927d`, `9767ff2`), unchanged for
this task:
- Bounded per-day context (`CorpusLoadBound`), hoisted one-time identity/Elo builds.
- `maxHeapMB` ceiling (default `DEFAULT_MAX_HEAP_MB = 1400`, env-overridable via
  `SHADOW_REPLAY_MAX_HEAP_MB`), checked before the day loop and at the top of every day.
- A ceiling trip sets `stopReason: "memory_ceiling"`, always `cancelled: true`, and is never
  reported as successful.
- Cooperative cancellation, checked at the same per-day boundary.

Nothing new is required for a 2–4 week window: this range is far smaller than the 3-month range
the ceiling and cancellation mechanisms were built and tested for.

## 10. Resume/checkpoint behavior

Unchanged from the existing design: append-only `INSERT ... ON CONFLICT DO NOTHING` on
`(run_kind, historical_match_id)` means every scored match is durably committed immediately.
Re-issuing the same request (same `shadowBatchLabel`) after any interruption (cancel, memory
ceiling, crash) skips every already-scored match and continues. No new checkpoint table needed.

## 11. Recommended smallest useful initial sample

**A single contiguous 2–4 week window, most recent available (subject to §3's live-count
confirmation), run once under one `shadowBatchLabel`.** This is deliberately smaller than both the
3-month window discussed in prior tasks and Agent 4's n≈4,500 ablation precedent — the goal here
is narrower: confirm whether the previously observed 50%-collapse / near-50 pattern (Agent 4's own
`near50Bands.ts` gives exact/49–51/48–52/47–53 band tallies for free) looks different once the
neutral-order fix is in effect, before committing to a larger run. At an estimated ~500–2,000
matches (§4) this is enough for:
- Accuracy / Brier / log loss / calibration (ECE) — `metrics.ts`/`calibration.ts`, already
  DB-row-generic, no changes needed.
- Near-50 / exact-50 frequency — `near50Bands.ts` (Agent 4's tool), reads `rawProbability`/
  `calibratedProbability` directly off the stored rows.
- Per-model / model-disagreement — `perModelMetrics.ts` (Agent 4's tool), reads
  `feature_snapshot.moduleWeights`/`engine`, present on every row regardless of `run_kind`.
- A first directional read on whether ablation-grade investment (the ~4,500 sample) is warranted.

It is **not** enough, by itself, for surface/tour-stratified breakdowns at meaningful per-cell
sample sizes, or for a claim as strong as Agent 4's existing ablation report — that is what the
larger, later sample (if this one motivates it) is for.

## 12. Estimated Replit cost/resource impact

Not measured (no execution). Qualitatively: one `POST /evaluation/shadow-replay/run-job` call,
background job inside the already-running api-server process (no new process/container), expected
wall-clock on the order of low minutes for ~14–28 day-iterations at the per-day query cost already
profiled in the resource-safety audit (a single busy day measured at ~14% of a full-corpus-scale
load) — an order of magnitude below the 3-month/~90-day case this infrastructure was hardened for.
No external provider calls (this path never calls `apiTennisProvider`/market-odds sources — see
§ "Avoid market odds" below). No optimizer, no ablation, no historical regeneration triggered.

## 13. Blockers / risks

1. **No live database access in this session** — §3's date range and §4's match count are
   estimates, not measurements. Must be confirmed with the single bounded `SELECT COUNT(*)` query
   above before the real run.
2. **Threshold-vs-real-container gap, carried over from the memory-ceiling report:**
   `DEFAULT_MAX_HEAP_MB=1400` is derived from a previously documented crash point, not measured
   against whatever container will actually execute this. Unchanged risk, not newly introduced.
3. **Exact-50 grading artifact (see below) is real but explicitly out of scope to fix here** — the
   new population must simply preserve enough information for Agent 4 to isolate it, not correct
   it.
4. **Calibration-mapping semantics differ slightly between shadow-replay and walk-forward:**
   shadow replay grades with the calibration mapping historically active as of each match's own
   cutoff (Task #160), not one frozen "currently active" mapping applied uniformly the way
   walk-forward's evaluation-only mode does. This is a pre-existing, already-shipped design choice
   of the reused mechanism, not something introduced here — flagged so Agent 4 interprets the
   clean population's numbers correctly relative to any walk-forward-based comparison, not as a
   defect.
5. **No blocker found that would prevent proceeding once (1) is resolved and (2) is accepted or
   retuned.**

### Property 7 — market odds / market sentiment

Confirmed by reading `scoreHistoricalMatch`: `runPredictionEngine` is called with no market-odds
or market-sentiment input in this path (the historical scoring call never resolves an odds
provider). This is unchanged by the neutral-order fix and required no action.

## 14. Exact command/job/configuration for later execution

```
POST /api/evaluation/shadow-replay/run-job
Content-Type: application/json

{
  "startDate": "<confirmed start, YYYY-MM-DD>",
  "endDate": "<confirmed end, YYYY-MM-DD, 2-4 weeks after start>",
  "batchLabel": "clean-neutral-eval-v1-<start>-to-<end>",
  "overwrite": false
}
```

Optional: `"maxHeapMB": <override>` if the default 1400MB needs retuning for the actual target
container (see Blocker 2).

Poll: `GET /api/evaluation/shadow-replay/job-status`
Cancel if needed: `POST /api/evaluation/shadow-replay/cancel-job`

Later analysis reads:
```sql
SELECT * FROM evaluation_predictions
WHERE run_kind = 'paper_trade_shadow' AND shadow_batch_label = 'clean-neutral-eval-v1-...';
```
fed directly into `near50Bands.ts`/`perModelMetrics.ts`/`calibration.ts`'s existing functions —
no new analysis code needed for the initial sample.

## 15. Explicit statement

**No large generation job was executed. No 3-month replay was run. No ablation or optimizer was
run. No historical data was regenerated. No provider calls were made. No database rows were
written, deleted, or modified. The existing `historical_test`/`segment='test'` population was not
read, queried, or touched in any way during this preflight.** All findings above come from static
inspection of the current `main` branch and previously-documented figures, each cited with its
source and date.

---

## Exact-50 tie-break finding (per instruction: documented, not fixed here)

Agent 7's smoke test already demonstrated the specific mechanism: `scoreHistoricalMatch` itself is
genuinely symmetric at an exact tie (`rawProbability === 0.5` exactly for perfectly mirrored
inputs, confirmed in the merged test), but every real caller's shared grading convention
(`rawProbability >= 0.5 ? player1Id : player2Id`, applied to the row's own **stored** slot columns,
which Sackmann ingestion still sets winner-first) resolves an exact tie to that row's own recorded
winner. This is unaffected by the neutral-order fix (which only touches the engine's internal
ordering, not the storage/grading convention) and is explicitly out of scope to fix in this task.

**What the new clean population preserves for Agent 4 to analyze this separately, without any new
code:**
- `raw_probability`/`calibrated_probability` are stored at full precision on every row — an exact
  (or near-exact, via `near50Bands.ts`'s existing `exactTolerance`) 50.0 is directly detectable
  with `classifyNear50()`/`tallyNear50Bands()` (Agent 4's own tool, already merged), which already
  returns `exact50` as an independent boolean separate from overall accuracy.
- `feature_snapshot.engineSlotAssignment` (`{ enginePlayer1Id, enginePlayer2Id, swapped }`, added
  by the same `c551580` fix) is stored on every new row, so Agent 4 can additionally cross-tabulate
  exact-50 cases by whether the engine's internal ordering happened to match or differ from the
  row's stored slot — useful for confirming the artifact is purely a grading-convention effect and
  not a residual ordering effect, without needing to touch production tie-breaking code.
- **Recommendation for Agent 4's later analysis, not implemented here:** report exact-50 rows
  (`near50Bands.tallyNear50Bands(...).exact50`) as their own line item, excluded from or shown
  alongside — not silently folded into — the headline accuracy number, exactly as `near50Bands.ts`
  already structures its output (independent, non-mutually-exclusive booleans).

**Production tie-breaking behavior (`rawProbability >= 0.5 ? player1Id : player2Id` in
`backtestService.ts`/`walkForward.ts`/`shadowReplay.ts`/`bridgeRescore.ts`) was not changed.**
