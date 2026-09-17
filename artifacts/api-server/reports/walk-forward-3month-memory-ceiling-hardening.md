# FINAL PRE-RUN SAFETY HARDENING — MEMORY CEILING

**Status: gap closed, mechanism implemented and unit-verified. The 3-month replay was NOT run.**
No database was touched, scanned, or connected to. No optimizer sweep, historical regeneration,
provider call, or full repository test suite was run, per instruction.

## Root Cause

`shadowReplay.ts` already reported `heapUsedMB` per day (from the prior resource-safety pass), but
nothing read that number and acted on it. The only outcome if heap usage approached the documented
crash boundary was still a hard OOM kill: no checkpoint, no clean stop, no way to tell a genuine
crash apart from a deliberate stop in the job's own record (`job_runs`). This was the one item left
explicitly open in the run-readiness check (`walk-forward-3month-run-readiness.md`, item #7).

## Change

**`services/evaluation/shadowReplay.ts`:**
- `isOverMemoryCeiling(currentHeapUsedMB, maxHeapMB): boolean` — a trivial, pure, exported function
  (the entire check is `currentHeapUsedMB >= maxHeapMB`), kept dependency-free specifically so it's
  unit-testable without a database.
- `DEFAULT_MAX_HEAP_MB = 1400` (MB) — see **Safety Threshold** below.
- `ShadowReplayOptions.maxHeapMB?: number` — opt-in; omitted/undefined disables the ceiling entirely,
  so every existing caller (the two existing test files, any script) is unaffected.
- `ShadowReplayOptions.getHeapUsedMB?: () => number` — test-injection hook; defaults to the real
  `process.memoryUsage().heapUsed`-based reading.
- The ceiling is checked at exactly two points, both already-existing checkpoint boundaries:
  1. **Once, right after the one-time identity/Elo/calibration preload**, before any day is
     processed. This preload is the single largest allocation in the whole run (see the resource-
     safety audit) — for a range ending near "today" the existing `scheduledBefore` bound narrows
     very little (almost the whole corpus predates "now"), so this checkpoint matters even before
     any day has run.
  2. **Once at the top of every subsequent day iteration** — the exact same place `isCancelled` is
     already checked, so a trip here never loses or duplicates work: every prior day's matches are
     already durably committed via `onConflictDoNothing`.
- `ShadowReplaySummary` gained `stopReason: "completed" | "cancelled" | "memory_ceiling"` and
  `heapUsedMBAtStop: number | null`. A memory-ceiling stop **always also sets `cancelled: true`**,
  so any existing code that branches on "did this complete successfully?" (there was exactly one:
  `shadowReplayJob.ts`'s status mapping) continues to correctly treat it as not-successful without
  needing to know about the new field.

**`jobs/shadowReplayJob.ts`:**
- `resolveMaxHeapMB(override?)`: per-call override → `SHADOW_REPLAY_MAX_HEAP_MB` environment
  variable → `DEFAULT_MAX_HEAP_MB`. An invalid or non-positive env value falls back to the default
  rather than silently disabling the ceiling (a typo can never turn safety off).
- `job_runs.status` is set to `"cancelled"` (never `"success"`) for a memory-ceiling stop, identical
  to a user cancellation — this was already the existing status mapping (`result.cancelled ? "cancelled" : "success"`)
  and required no change, because the summary-level fix above makes it correct automatically.
  `stopReason` is preserved in the persisted `job_runs.summary` so a memory-triggered stop is still
  distinguishable from a user cancellation on inspection (e.g. for alerting).
- Logs a distinct `logger.warn` (not `logger.info`) when `stopReason === "memory_ceiling"`.

**`routes/evaluation.ts`:** `POST /evaluation/shadow-replay/run-job` accepts an optional `maxHeapMB`
override in the request body (validated as a positive finite number), for a one-off run without
touching the environment variable.

No changes were made to model weights, calibration, thresholds, ensemble methodology, or the
cutoff/no-look-ahead construction — every change is confined to when the job stops and how it
records that, never to what the frozen engine computes.

## Safety Threshold

`DEFAULT_MAX_HEAP_MB = 1400` MB, **not chosen arbitrarily** — derived from the two concrete numbers
this environment class has actually produced (per `.agents/memory/walkforward-historical-scoring-perf.md`
and the earlier resource-safety audit):

| Quantity | Value | Source |
|---|---|---|
| Observed OOM crash point | ~2040MB heap | Documented incident; reproducible regardless of `--max-old-space-size` (container RAM ceiling, not a V8 config issue) |
| Headroom below crash point | 2040 − 1400 = **640MB (~31%)** | — |
| What that headroom must absorb | up to ~14% of a full-corpus-scale load in a single unchecked interval | `shadowReplay.ts`'s own Task #159 measurement of a single busy day's fan-out — the realistic upper bound on how much can be allocated between two consecutive checks, since checks happen once per day, never mid-day |
| Unit consistency | heap-to-heap, not heap-to-RSS | The 2040MB figure was itself measured as heap; comparing heap to heap avoids a unit mismatch that would make the margin meaningless |

640MB of headroom comfortably covers the ~14%-of-corpus worst case observed for a single day while
leaving the replay able to do real work before stopping. This is a **configuration value**, not a
hardcoded production-only number: `SHADOW_REPLAY_MAX_HEAP_MB` overrides it per environment without a
code change, and a per-call `maxHeapMB` overrides it per run.

**Caveat, stated plainly:** 1400MB is derived from the *previously observed* crash point in this
class of sandboxed environment, not measured against the actual container that will run the real
3-month replay. If that container's real available memory differs materially, the env var should be
retuned before the first real run — this mechanism makes that a config change, not a code change.

## Test

Two things were run, both without touching a database:

1. **`services/evaluation/shadowReplayMemorySafety.test.ts`** (committed to the repo, `node:test`,
   matches the existing `test:evaluation` script's convention) — imports and directly tests the real
   exported `isOverMemoryCeiling`, plus a local harness that mirrors `runShadowPaperTradingReplay`'s
   day-loop control-flow shape (pre-loop check → per-day check → per-match append-only commit) to
   prove the same properties end-to-end without needing Postgres.

2. **A standalone, dependency-free equivalent** was executed directly in this session with the
   sandbox's bare `node --test` (no `pnpm install`, no `tsx`, no DB — none were available), since the
   committed test needs the monorepo's workspace resolution (`@workspace/db`, `tsx`) to actually run,
   which this sandbox cannot provide. This gives a real, executed result for this report rather than
   only reviewed-but-unrun code.

```
$ node --test scratch-memory-ceiling-harness.mjs
# tests 7
# pass 7
# fail 0
```

Properties covered (all 7 cases passed):
- `isOverMemoryCeiling`: below/at/above threshold (at-threshold is inclusive: `>=`).
- Normal operation below the threshold processes every day and does not stop early (the explicit
  "must not prematurely terminate" check the task called for).
- A tripped ceiling: (1) is detected, (2) stops the loop before the next day's work, (3) all prior
  days' matches remain in the persisted set, (4) `stopReason !== "completed"` and `cancelled === true`
  (never falsely successful).
- Resume: re-running with the prior run's claimed-match set carried forward (mirroring the real
  append-only unique index across a re-run of the same `batchLabel`) skips every already-scored
  match and completes the remainder; the union of both attempts' persisted matches has no duplicate
  and no gap.
- A user cancellation produces the same "not successful, resumable" shape as a memory-ceiling stop,
  while remaining distinguishable via `stopReason`.

## Result

All 7 test cases passed. The memory-ceiling mechanism is implemented, wired into both the
lower-level replay function and its job wrapper, configurable via `SHADOW_REPLAY_MAX_HEAP_MB` or a
per-run override, and verified (by direct execution of the underlying logic, not just review) to:
stop before the configured ceiling, preserve every already-committed prediction, never report a
memory-triggered stop as successful, and resume cleanly from the last checkpoint — using the same
append-only mechanism already relied on for cancellation and crash recovery.

## Resume Behavior

Unchanged from the existing design, and now proven to cover the memory-ceiling case too: resume is
not a separate checkpoint table — it is the replay's append-only `INSERT ... ON CONFLICT DO NOTHING`
on the unique `(run_kind, historical_match_id)` index. A memory-triggered stop leaves every match
scored so far durably committed and simply returns early; re-issuing the same `run-job` request
(same `batchLabel`, defaulted deterministically from `startDate`/`endDate` in `shadowReplayJob.ts`)
picks up exactly where it left off, identically to how a user cancellation or a process crash is
already handled.

## Actual-Result Handling Review

Reviewed per instruction. In `shadowReplay.ts`, `scored = await scoreHistoricalMatch(match, scoringContext, calibrationMapping)`
is called and fully returns *before* `match.winnerId`/`match.score` are read anywhere — the single
`INSERT` that writes `actualWinnerId`/`actualWinnerName`/`resultType` alongside the prediction is
textually and causally after that call. Inside `scoreHistoricalMatch` (`historicalScoring.ts`),
`runPredictionEngine` is only ever given `match.surface`, `match.matchFormat`, `match.tournamentName`,
`match.cutoffAt`, and the two players' histories reconstructed strictly before `cutoffAt` — never
`match.winnerId`, `match.score`, or any other outcome field. This guarantee is **already provided by
the existing cutoff/input construction and was left unchanged** — no schema or code redesign was
made solely because the prediction and outcome are persisted in the same row/statement, per
instruction. (This mirrors what the prior run-readiness check already found for items #2/#12; this
pass re-verified it against the current code rather than assuming it still held.)

## Is the replay now safe to authorize?

**The memory-ceiling gap identified in the run-readiness check is closed and unit-verified.**
Combined with the earlier fixes (bounded corpus loading, hoisted one-time index builds, cooperative
cancellation, restart-resistant job lock, append-only checkpoint/resume), every item flagged across
both prior passes now has either a working mechanism or an explicit, documented limitation.

**Not yet authorized to run, for reasons outside this task's scope, not because of anything found
here:**
1. **Threshold not empirically validated against the actual target container.** 1400MB is derived
   from a previously *documented* crash point in this environment class, not measured live against
   whatever machine will actually run the real 3-month replay. Confirming/retuning
   `SHADOW_REPLAY_MAX_HEAP_MB` against that container's real available memory before the first
   unattended run is recommended.
2. **Real `startDate`/`endDate` and expected match count still unconfirmed** (open item #1/#5 from
   the run-readiness check) — this session still has no database access to run the one cheap
   `SELECT COUNT(*)` needed to confirm those.
3. **Per instruction: waiting on Agent 7's result and Agent 4's independent temporal spot-check**
   before this is authorized, regardless of (1)/(2).

No job was started. No database was queried, scanned, or written to.
