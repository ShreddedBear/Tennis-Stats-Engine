import { asc, and, eq, gte, lte, lt, inArray, or } from "drizzle-orm";
import { db, evaluationPredictionsTable, calibrationModelsTable, historicalMatchesTable, type HistoricalMatchRow, type CalibrationKnotJson } from "@workspace/db";
import { logger } from "../../lib/logger";
import { scoreHistoricalMatch, type HistoricalScoringContext } from "./historicalScoring";
import { getPredictionSettings } from "./settle";
import { getActiveSpecialistSegments } from "./specialistWeights";
import { buildMatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { buildEloHistoryIndex } from "../predictionEngine/opponentStrength";
import { buildPlayerIdentityIndex } from "../tennisData/playerIdentity";
import { HISTORICAL_MODEL_VERSION, type ResultType, type RetirementRule } from "./types";
import { defaultPredictionMode, derivePredictionStrategyIdentity } from "./strategyIdentity";

/** Approximate resident heap, for periodic resource-safety logging (see `ShadowReplayOptions.onProgress`). */
function heapUsedMB(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
}

/**
 * Memory safety ceiling (final pre-run hardening pass, 2026-09).
 *
 * ## Root cause this closes
 *
 * The prior walk-forward OOM incident (see `.agents/memory/walkforward-historical-scoring-perf.md`
 * and the resource-safety audit report) crashed the Node process consistently at ~2040MB heap in
 * this class of environment, regardless of `--max-old-space-size` -- a container RAM ceiling
 * (measured ~2.7-3.3GB total, shared with other workflows), not a V8 configuration problem. This
 * replay engine (`shadowReplay.ts`) was already redesigned to stay well under that by construction
 * (bounded per-day context, hoisted one-time index builds -- see the resource-safety audit), but
 * until now nothing actually WATCHED heap usage and stopped before reaching that boundary: if the
 * corpus grows, a single unusually "busy" day is bigger than expected, or the environment's
 * available memory shrinks (more concurrent workflows), the only outcome was still a hard OOM kill
 * with no checkpoint, no clean stop, and no distinction from a genuine crash in the job's own record.
 *
 * ## Why this threshold
 *
 * `DEFAULT_MAX_HEAP_MB` (1400MB) is chosen relative to the two real numbers this environment class
 * has actually produced, not picked arbitrarily:
 *   - The observed crash point is ~2040MB heap.
 *   - 1400MB leaves ~640MB (~31%) of headroom below that observed crash point.
 * That headroom has to absorb whatever allocation can happen BETWEEN two consecutive checks (this
 * function is checked once before the day loop starts and once per day thereafter, never
 * mid-day) -- `shadowReplay.ts`'s own Task #159 comment measured a single busy day's fan-out at up
 * to ~14% of a full-corpus-scale load, which is the realistic upper bound on how much a single
 * unchecked interval could add. 640MB of headroom comfortably covers that, plus normal V8/Node
 * overhead variance, while still leaving the replay able to do meaningful work before stopping.
 * This is intentionally a heap-based check (not RSS): the ~2040MB figure was itself measured as
 * heap, so comparing heap-to-heap avoids introducing a unit mismatch.
 *
 * ## Configuration
 *
 * Prefer the `SHADOW_REPLAY_MAX_HEAP_MB` environment variable (read once in `shadowReplayJob.ts`,
 * the job wrapper that owns operational configuration) over hardcoding a single production value
 * here -- this lets the ceiling be tuned per-environment (e.g. lower on a smaller container, higher
 * once the real available memory for a given deployment is known) without a code change. Direct
 * callers of `runShadowPaperTradingReplay` (tests, scripts) can also pass `maxHeapMB` explicitly.
 * `options.maxHeapMB` undefined/omitted disables the ceiling entirely (matches every other optional
 * safety hook in this file -- opt-in, never a surprise behavior change for an existing caller).
 *
 * ## Releasing large structures on a stop
 *
 * `identityIndex`/`eloHistory`/`calibrationHistory` and the day-scoped `dayMatches`/
 * `directMatches`/`scoringContext` are all plain local `const`/`let` bindings inside
 * `runShadowPaperTradingReplay`'s own function scope -- nothing stores a reference to them anywhere
 * outside that call. Stopping (via `return`/`break`, both used below) drops the last reference to
 * all of them the moment the function returns, making them immediately eligible for normal V8
 * garbage collection; no explicit `= null` or manual free is needed or would change that. Forcing an
 * immediate collection (`global.gc()`) was deliberately not added: it requires `--expose-gc`, isn't
 * available by default in the target environment, and V8 already reclaims unreferenced memory under
 * its own pressure-driven schedule -- adding a forced-GC dependency here would be a larger, less
 * portable change than this safety fix calls for.
 */
export const DEFAULT_MAX_HEAP_MB = 1400;

/** Pure, dependency-free threshold check -- kept trivial and exported so it's unit-testable without a database. */
export function isOverMemoryCeiling(currentHeapUsedMB: number, maxHeapMB: number): boolean {
  return currentHeapUsedMB >= maxHeapMB;
}

/**
 * Shadow-mode replay (see the task spec): a faster-but-honestly-labeled alternative to waiting
 * for real live paper-trading to slowly accumulate graded fixtures one real match at a time.
 *
 * This reuses the exact same leak-proof point-in-time scoring path walk-forward uses
 * (`scoreHistoricalMatch`, bounded by each match's own frozen `cutoffAt`) but differs from
 * walk-forward in three deliberate ways that matter for what this evidence honestly means:
 *
 *  1. It writes to its own `runKind: 'paper_trade_shadow'` bucket -- never `historical_test`
 *     (walk-forward's fold-fit/out-of-sample bucket) and never `paper_trade`/`live` (genuinely
 *     real-time evidence). Nothing here is ever merged into either of those in any report.
 *  2. It is APPEND-ONLY by construction: the shared `(runKind, historicalMatchId)` unique index
 *     means a given historical match can only ever hold ONE shadow-replay row, ever, no matter
 *     how many times or under how many batch labels a replay is invoked. A second replay over an
 *     overlapping date range simply skips matches an earlier batch already claimed -- it can
 *     never duplicate or silently rescored them. Explicit `overwrite: true` on an EXACT existing
 *     `batchLabel` is the only way to replace a batch's own rows, and it deletes ONLY rows with
 *     that exact `(runKind, shadowBatchLabel)` pair -- it can never touch another batch, and it
 *     can never touch `paper_trade`/`historical_test` rows (different `runKind` entirely).
 *  3. It grades using whichever calibration mapping was ACTUALLY ACTIVE as of each individual
 *     match's own `cutoffAt` (Task #160) -- not a mapping fit from this same run's own data, and
 *     not today's currently-active mapping applied uniformly across the whole range. See
 *     `getCalibrationMappingAsOf` below and `historicalScoring.ts`'s doc on
 *     `activeCalibrationOverride`. This is what makes the result a genuine simulation of "what
 *     would live paper trading have produced on that date", rather than an in-sample backtest
 *     number OR "what today's model would say about the past".
 *
 * HONEST CAVEAT (also surfaced in the dashboard copy, not just here): this is still not a full
 * substitute for genuinely-live validation. It replays historical matches through the SAME engine
 * version being evaluated today, and the calibration-mapping history it reconstructs is only as
 * fine-grained as how often walk-forward has actually refit `calibration_models` -- unlike real
 * paper trading, it cannot tell you how the model would have behaved under conditions that were
 * truly unknown at decision time (e.g. segment-specialist fits available today did not exist on
 * those historical dates). Treat it as fast, leakage-safe, directional evidence for
 * confidence/tier claims -- never as equivalent to a genuinely-live-graded sample.
 */

export interface ShadowReplayOptions {
  /** Inclusive UTC calendar date (YYYY-MM-DD) to start replaying from. */
  startDate: string;
  /** Inclusive UTC calendar date (YYYY-MM-DD) to replay through. */
  endDate: string;
  /** Identifies this replay invocation/group; distinct batches never collide or overwrite each other. */
  batchLabel: string;
  /**
   * When true, first deletes ONLY this exact batch's own existing `paper_trade_shadow` rows
   * (matched on `runKind='paper_trade_shadow' AND shadowBatchLabel=batchLabel`), then replays the
   * requested range fresh under the same label. Default false (pure append). Never deletes any
   * other batch's rows, and never touches `paper_trade`/`historical_test` rows regardless of
   * this flag.
   */
  overwrite?: boolean;
  /**
   * Cooperative cancellation hook, polled once per calendar day (a natural checkpoint boundary --
   * every day already commits its own rows via `onConflictDoNothing` before this is checked, so
   * stopping here never loses or duplicates work on resume). Return true to stop after the current
   * day finishes; the summary is returned with `cancelled: true` rather than throwing, matching
   * `backtestService.ts`'s cooperative-cancellation contract.
   */
  isCancelled?: () => Promise<boolean> | boolean;
  /**
   * Per-day progress callback for job-status polling and the resource-safety report. Called once
   * per calendar day that contained at least one match (empty days are skipped before this fires,
   * same as every other per-day step), after that day's matches have been scored and inserted.
   */
  onProgress?: (info: {
    day: string;
    matchesInDay: number;
    insertedSoFar: number;
    daysSimulatedSoFar: number;
    heapUsedMB: number;
  }) => Promise<void> | void;
  /**
   * Memory safety ceiling in MB, checked (a) once right after the one-time identity/Elo/calibration
   * preload, before any day is processed, and (b) once at the top of every subsequent day iteration
   * -- the same checkpoint boundary `isCancelled` uses, so a trip never loses or duplicates work.
   * Omitted/undefined disables the ceiling (existing callers are unaffected). See
   * `DEFAULT_MAX_HEAP_MB`'s doc for why 1400 is the recommended default and how to configure it.
   */
  maxHeapMB?: number;
  /** Test-only override for the heap reading. Defaults to the real `process.memoryUsage().heapUsed`. */
  getHeapUsedMB?: () => number;
}

export interface ShadowReplaySummary {
  batchLabel: string;
  startDate: string;
  endDate: string;
  overwrite: boolean;
  /** Rows deleted because `overwrite: true` and this exact batch already had rows. 0 otherwise. */
  deletedExistingBatchRows: number;
  /** Real, non-cancelled historical matches whose scheduledStartAt fell within the requested range. */
  matchesInRange: number;
  /** Newly written this run. */
  inserted: number;
  /** Matches in range already claimed by a DIFFERENT shadow batch (or, without overwrite, by this same batch from an earlier run) -- append-only skip, never a duplicate or a silent rescoring. */
  skippedAlreadyClaimed: number;
  /** scoreHistoricalMatch returned null (no prior history for one/both players, or surface/format unresolved) -- never inserted, never a fabricated guess. */
  skippedInsufficientData: number;
  /** Distinct UTC calendar days actually walked while pacing this replay. */
  daysSimulated: number;
  /**
   * True when the run stopped before reaching `endDate` for ANY reason other than completing
   * normally -- user cancellation OR the memory ceiling tripping. Kept as a single boolean (rather
   * than only exposing `stopReason`) so existing consumers that branch on "did this finish
   * normally?" (e.g. `shadowReplayJob.ts`'s success/cancelled status mapping) keep working
   * unchanged for the new memory-ceiling case: an early stop is never reported as a successful
   * completion, whichever of the two reasons caused it.
   */
  cancelled: boolean;
  /**
   * Why the run ended. `"memory_ceiling"` is distinct from `"cancelled"` (user-requested) even
   * though both set `cancelled: true` above -- callers that need to tell an operator-requested
   * cancellation apart from a safety stop (e.g. for alerting) should read this field, not `cancelled`.
   */
  stopReason: "completed" | "cancelled" | "memory_ceiling";
  /** Last UTC calendar day (YYYY-MM-DD) fully processed before stopping/finishing -- the resume point. */
  lastDayProcessed: string | null;
  /** heapUsedMB at the moment the memory ceiling tripped. Null unless stopReason === "memory_ceiling". */
  heapUsedMBAtStop: number | null;
}

function classifyResult(match: Pick<HistoricalMatchRow, "winnerId" | "retired" | "walkover" | "cancelled">): ResultType {
  if (match.cancelled) return "cancelled";
  if (match.walkover) return "walkover";
  if (match.retired) return "retired";
  return "normal";
}

function parseUtcDateBoundary(dateStr: string, endOfDay: boolean): Date {
  const d = new Date(`${dateStr}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
  return d;
}

interface CalibrationHistoryEntry {
  fittedAt: Date;
  mapping: CalibrationKnotJson[];
}

/**
 * Task #160: the WHOLE fitted-calibration history, ordered oldest-first, loaded ONCE per replay
 * run. `walkForward.ts` never deletes a superseded row -- it flips the old row's `active` to
 * false and inserts a new `active: true` row with a fresh `fittedAt` -- so this table's own rows
 * already ARE a durable timeline of "which mapping was live from its own fittedAt until the next
 * row's fittedAt superseded it". This reconstructs that timeline directly from the rows
 * themselves rather than trusting the CURRENT `active` flag (which only ever describes right
 * now), so a replayed match gets the mapping that was genuinely in force on ITS OWN date.
 */
async function loadCalibrationHistory(): Promise<CalibrationHistoryEntry[]> {
  const rows = await db
    .select({ fittedAt: calibrationModelsTable.fittedAt, mapping: calibrationModelsTable.mapping })
    .from(calibrationModelsTable)
    .orderBy(asc(calibrationModelsTable.fittedAt));
  return rows;
}

/**
 * The mapping that was active as of `asOf` -- i.e. the LATEST history entry whose `fittedAt` is
 * at or before `asOf`. Returns null when `asOf` predates the very first calibration fit (no
 * mapping existed yet at that point in real history -- honestly absent, never backfilled with a
 * later mapping that didn't exist yet). `history` must already be sorted ascending by `fittedAt`
 * (see `loadCalibrationHistory`); binary search keeps this cheap even though it's called once per
 * scored match.
 */
function getCalibrationMappingAsOf(history: CalibrationHistoryEntry[], asOf: Date): CalibrationKnotJson[] | null {
  const asOfMs = asOf.getTime();
  let lo = 0;
  let hi = history.length - 1;
  let result: CalibrationKnotJson[] | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].fittedAt.getTime() <= asOfMs) {
      result = history[mid].mapping;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export async function runShadowPaperTradingReplay(options: ShadowReplayOptions): Promise<ShadowReplaySummary> {
  const { startDate, endDate, batchLabel, overwrite = false, isCancelled, onProgress, maxHeapMB } = options;
  const getHeapUsedMB = options.getHeapUsedMB ?? heapUsedMB;
  if (!batchLabel.trim()) throw new Error("batchLabel is required and cannot be blank");
  const rangeStart = parseUtcDateBoundary(startDate, false);
  const rangeEnd = parseUtcDateBoundary(endDate, true);
  if (rangeEnd.getTime() < rangeStart.getTime()) throw new Error("endDate must be on or after startDate");

  const settings = await getPredictionSettings();

  let deletedExistingBatchRows = 0;
  if (overwrite) {
    const deleted = await db
      .delete(evaluationPredictionsTable)
      .where(and(eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"), eq(evaluationPredictionsTable.shadowBatchLabel, batchLabel)))
      .returning({ id: evaluationPredictionsTable.id });
    deletedExistingBatchRows = deleted.length;
  }

  const summary: ShadowReplaySummary = {
    batchLabel,
    startDate,
    endDate,
    overwrite,
    deletedExistingBatchRows,
    matchesInRange: 0,
    inserted: 0,
    skippedAlreadyClaimed: 0,
    skippedInsufficientData: 0,
    daysSimulated: 0,
    cancelled: false,
    stopReason: "completed",
    lastDayProcessed: null,
    heapUsedMBAtStop: null,
  };

  /** Marks `summary` as a safety stop (never "successful") and fires one final progress/heartbeat. */
  const stopForMemoryCeiling = async (heapMB: number): Promise<void> => {
    logger.warn(
      { batchLabel, heapUsedMB: heapMB, maxHeapMB, lastDayProcessed: summary.lastDayProcessed },
      "Shadow-replay: memory ceiling reached -- stopping cleanly before OOM risk. Job is NOT marked successful; resume by re-running the same batchLabel.",
    );
    summary.cancelled = true;
    summary.stopReason = "memory_ceiling";
    summary.heapUsedMBAtStop = heapMB;
    if (onProgress) {
      await onProgress({
        day: summary.lastDayProcessed ?? startDate,
        matchesInDay: 0,
        insertedSoFar: summary.inserted,
        daysSimulatedSoFar: summary.daysSimulated,
        heapUsedMB: heapMB,
      });
    }
  };

  // Task #159 rework: unlike walk-forward (which genuinely scores the WHOLE corpus every run, so
  // a full-corpus preload is unavoidable there), a shadow-replay batch only ever scores a bounded
  // date range -- but this corpus's match graph is highly connected (a real check found a single
  // ACTIVE MONTH's players' own combined histories already cover ~78% of the whole 130K+ row
  // corpus), so scoping history-reconstruction queries by "every player touched anywhere in the
  // requested range" does NOT bound memory for realistic (week/month-scale) batches -- it still
  // approaches a full-corpus load. What DOES stay bounded regardless of how long the requested
  // range is: processing ONE UTC calendar day at a time, each with its OWN small scoped context
  // (that day's matches' players, their direct histories, and those histories' own opponents'
  // Elo) that is built, used, and discarded before moving to the next day. A single day's fan-out
  // was measured at ~14% of the full corpus on a busy day -- comparable to walk-forward's own
  // per-fold cost, not a full-corpus spike -- and peak memory never grows with the requested
  // range's length, only with how busy any ONE day in it is.
  //
  // Resource-safety fix (3-month walk-forward validation task): `identityIndex` and `eloHistory`
  // depend only on the corpus up to `rangeEnd` and on nothing that changes mid-run (no writes to
  // historical_matches/match_feature_snapshots happen during a replay), so both are built ONCE
  // here, exactly like `calibrationHistory` below -- never per-day. Previously `buildEloHistoryIndex`
  // was called INSIDE the day loop, which re-ran its full `match_feature_snapshots` eloOverall scan
  // (the single largest query in either builder, ~229K rows at current corpus scale) once per
  // calendar day in the requested range -- for a 3-month/~90-day replay that meant ~90 redundant
  // full-table scans instead of 1. Both builders also now take a `scheduledBefore: rangeEnd` bound
  // (see `CorpusLoadBound`'s doc) so they never load rows the replay could not use anyway.
  const corpusBound = { scheduledBefore: rangeEnd };
  const identityIndex = await buildPlayerIdentityIndex(corpusBound);
  const eloHistory = await buildEloHistoryIndex(identityIndex, corpusBound);
  const previousSpecialistRows = await getActiveSpecialistSegments();
  const specialistRowsBySegmentKey = new Map(previousSpecialistRows.map((row) => [row.segmentKey, row]));
  // Task #160: the full fitted-calibration timeline, loaded ONCE for this whole run -- each
  // match below looks up the entry that was actually in force as of ITS OWN cutoffAt, rather
  // than one mapping applied uniformly across the whole replayed range. See this file's top doc
  // and `getCalibrationMappingAsOf`'s doc for why this is honest to do here but NOT circular.
  const calibrationHistory = await loadCalibrationHistory();
  const retirementRule = settings.retirementRule as RetirementRule;

  // Memory-ceiling check #1: right after the one-time identity/Elo/calibration preload, before any
  // day is processed. This preload is the single largest allocation in the whole run (see
  // `isOverMemoryCeiling`'s doc) -- for a range ending near "today" the `scheduledBefore` bound
  // above narrows very little (almost the whole corpus predates "now"), so this checkpoint matters
  // even when zero days have been scored yet. No day has run, so there is nothing to checkpoint
  // beyond the summary itself -- the job is simply refused before it does any scoring.
  if (maxHeapMB !== undefined) {
    const preLoopHeapMB = getHeapUsedMB();
    if (isOverMemoryCeiling(preLoopHeapMB, maxHeapMB)) {
      await stopForMemoryCeiling(preLoopHeapMB);
      return summary;
    }
  }

  for (let dayStart = new Date(rangeStart); dayStart.getTime() <= rangeEnd.getTime(); dayStart.setUTCDate(dayStart.getUTCDate() + 1)) {
    if (isCancelled && (await isCancelled())) {
      summary.cancelled = true;
      summary.stopReason = "cancelled";
      break;
    }

    // Memory-ceiling check #2: top of every day iteration, before that day's (potentially large)
    // `directMatches` context is built -- same checkpoint boundary as cancellation, so a trip here
    // never loses or duplicates work: every prior day's matches are already durably committed.
    if (maxHeapMB !== undefined) {
      const currentHeapMB = getHeapUsedMB();
      if (isOverMemoryCeiling(currentHeapMB, maxHeapMB)) {
        await stopForMemoryCeiling(currentHeapMB);
        break;
      }
    }

    const dayEnd = new Date(Math.min(new Date(dayStart).setUTCHours(23, 59, 59, 999), rangeEnd.getTime()));

    const dayMatches = await db
      .select()
      .from(historicalMatchesTable)
      .where(and(eq(historicalMatchesTable.cancelled, false), gte(historicalMatchesTable.scheduledStartAt, dayStart), lte(historicalMatchesTable.scheduledStartAt, dayEnd)))
      .orderBy(asc(historicalMatchesTable.scheduledStartAt), asc(historicalMatchesTable.id));

    if (dayMatches.length === 0) continue;
    summary.matchesInRange += dayMatches.length;
    summary.daysSimulated += 1;

    // Already-claimed matches (this or any other batch) -- append-only skip, checked up front in
    // one query rather than per-match, then re-checked at insert time via onConflictDoNothing for
    // safety against concurrent replay invocations.
    const existingClaims = await db
      .select({ historicalMatchId: evaluationPredictionsTable.historicalMatchId })
      .from(evaluationPredictionsTable)
      .where(
        and(
          eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"),
          inArray(
            evaluationPredictionsTable.historicalMatchId,
            dayMatches.map((m) => m.id),
          ),
        ),
      );
    const alreadyClaimed = new Set(existingClaims.map((r) => r.historicalMatchId));

    // Reconstructing each of TODAY's matches' own two players' PRIOR history (and their
    // head-to-head) only ever needs matches where one of THOSE two players took part AND that
    // happened strictly before this batch's cutoffs -- every scoring call filters by its own
    // exact `cutoffAt` regardless, so a match scheduled on or after `dayEnd` can never be picked
    // up by ANY of today's lookups. Pushing that upper bound into the query too (not just the
    // player filter) matters in practice: this corpus spans 2021-2026, so for an ACTIVE player,
    // roughly half their career sits on either side of any given day, and loading the "after"
    // half is pure wasted memory for a replay that will never score anything back in time.
    const targetPlayerIds = [...new Set(dayMatches.flatMap((m) => [m.player1Id, m.player2Id]))];
    const directMatches = await db
      .select()
      .from(historicalMatchesTable)
      .where(
        and(
          lt(historicalMatchesTable.scheduledStartAt, dayEnd),
          or(inArray(historicalMatchesTable.player1Id, targetPlayerIds), inArray(historicalMatchesTable.player2Id, targetPlayerIds)),
        ),
      );

    const scoringContext: HistoricalScoringContext = {
      matchHistory: buildMatchHistoryIndex(directMatches),
      eloHistory,
      identityIndex,
      specialistRowsBySegmentKey,
      // Shadow replay is point-in-time historical evaluation: suppress the segment specialist
      // so its today's-DB calibration doesn't override the per-match historical general
      // calibration resolved by `getCalibrationMappingAsOf`. See HistoricalScoringContext for
      // the full rationale. This is set unconditionally (not gated on whether a calibration
      // override was resolved for a given match) so specialist behaviour is consistent across
      // the entire replay run regardless of calibration history coverage.
      isPointInTimeReplay: true,
    };

    for (const match of dayMatches) {
      if (alreadyClaimed.has(match.id)) {
        summary.skippedAlreadyClaimed += 1;
        continue;
      }

      const resultType = classifyResult(match);
      const isVoid = resultType === "walkover" || resultType === "cancelled";

      const calibrationMapping = getCalibrationMappingAsOf(calibrationHistory, match.cutoffAt);
      const scored = await scoreHistoricalMatch(match, scoringContext, calibrationMapping);
      if (!scored) {
        summary.skippedInsufficientData += 1;
        continue;
      }

      const favorsPlayer1 = scored.calibratedProbability >= 0.5;
      const predictedWinnerId = favorsPlayer1 ? match.player1Id : match.player2Id;
      const includedInAccuracy = !isVoid && (resultType === "normal" || retirementRule === "included");

      const inserted = await db
        .insert(evaluationPredictionsTable)
        .values({
          predictionMode: defaultPredictionMode("paper_trade_shadow"),
          strategyId: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("paper_trade_shadow"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: new Date() }).strategyId,
          strategyVersion: derivePredictionStrategyIdentity({ predictionMode: defaultPredictionMode("paper_trade_shadow"), modelVersion: HISTORICAL_MODEL_VERSION, createdAt: new Date() }).strategyVersion,
          strategyFingerprint: HISTORICAL_MODEL_VERSION,
          optimizerRunId: null,
          calibrationVersion: null,
          competitiveBalanceVersion: null,
          evidenceReliabilityVersion: null,
          runKind: "paper_trade_shadow",
          segment: "live",
          dataSegment: "live",
          shadowBatchLabel: batchLabel,
          historicalMatchId: match.id,
          player1Id: match.player1Id,
          player1Name: match.player1Name,
          player2Id: match.player2Id,
          player2Name: match.player2Name,
          surface: match.surface,
          matchFormat: match.matchFormat,
          tournamentLevel: match.tournamentLevel,
          tournamentName: match.tournamentName,
          scheduledStartAt: match.scheduledStartAt,
          cutoffAt: match.cutoffAt,
          lockedAt: new Date(),
          modelVersion: HISTORICAL_MODEL_VERSION,
          featureSnapshot: scored.snapshot,
          modelAgreement: scored.modelAgreement,
          upsetRiskTier: scored.upsetRiskTier,
          usedFallback: scored.usedFallback,
          fallbackSources: scored.fallbackSources,
          rawProbability: scored.rawProbability * 100,
          calibratedProbability: scored.calibratedProbability * 100,
          predictedWinnerId,
          predictedWinnerName: predictedWinnerId === match.player1Id ? match.player1Name : match.player2Name,
          status: isVoid ? "void" : "graded",
          actualWinnerId: match.winnerId,
          actualWinnerName: match.winnerId ? (match.winnerId === match.player1Id ? match.player1Name : match.player2Name) : null,
          resultType,
          includedInAccuracy,
          gradedAt: new Date(),
        })
        .onConflictDoNothing({ target: [evaluationPredictionsTable.runKind, evaluationPredictionsTable.historicalMatchId] })
        .returning({ id: evaluationPredictionsTable.id });

      if (inserted.length > 0) {
        summary.inserted += 1;
      } else {
        // Lost a race against a concurrent replay invocation claiming the same match between the
        // upfront check and this insert -- treat exactly like a pre-existing claim, never an error.
        summary.skippedAlreadyClaimed += 1;
      }
    }

    const dayLabel = dayStart.toISOString().slice(0, 10);
    summary.lastDayProcessed = dayLabel;
    if (onProgress) {
      await onProgress({
        day: dayLabel,
        matchesInDay: dayMatches.length,
        insertedSoFar: summary.inserted,
        daysSimulatedSoFar: summary.daysSimulated,
        heapUsedMB: getHeapUsedMB(),
      });
    }
    // `dayMatches`/`directMatches`/`scoringContext` fall out of scope here -- nothing from one
    // day's scoped context is retained once the next day's iteration begins.
  }

  logger.info(
    {
      batchLabel,
      startDate,
      endDate,
      overwrite,
      matchesInRange: summary.matchesInRange,
      inserted: summary.inserted,
      skippedAlreadyClaimed: summary.skippedAlreadyClaimed,
      skippedInsufficientData: summary.skippedInsufficientData,
      daysSimulated: summary.daysSimulated,
      cancelled: summary.cancelled,
      stopReason: summary.stopReason,
      lastDayProcessed: summary.lastDayProcessed,
      heapUsedMBAtStop: summary.heapUsedMBAtStop,
    },
    summary.stopReason === "memory_ceiling"
      ? "Shadow paper-trading replay batch stopped (memory ceiling)"
      : summary.cancelled
        ? "Shadow paper-trading replay batch stopped (cancelled)"
        : "Shadow paper-trading replay batch completed",
  );

  return summary;
}

export interface ShadowReplayBatchSummary {
  batchLabel: string;
  n: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  earliestLockedAt: string | null;
  latestLockedAt: string | null;
}

/** Lists every distinct shadow-replay batch currently on record, most recently touched first. */
export async function listShadowReplayBatches(): Promise<ShadowReplayBatchSummary[]> {
  const rows = await db
    .select({
      shadowBatchLabel: evaluationPredictionsTable.shadowBatchLabel,
      scheduledStartAt: evaluationPredictionsTable.scheduledStartAt,
      lockedAt: evaluationPredictionsTable.lockedAt,
    })
    .from(evaluationPredictionsTable)
    .where(eq(evaluationPredictionsTable.runKind, "paper_trade_shadow"));

  const byBatch = new Map<string, { scheduledStarts: number[]; lockedAts: number[] }>();
  for (const row of rows) {
    const label = row.shadowBatchLabel ?? "(unlabeled)";
    if (!byBatch.has(label)) byBatch.set(label, { scheduledStarts: [], lockedAts: [] });
    const bucket = byBatch.get(label)!;
    bucket.scheduledStarts.push(row.scheduledStartAt.getTime());
    bucket.lockedAts.push(row.lockedAt.getTime());
  }

  return [...byBatch.entries()]
    .map(([batchLabel, bucket]) => ({
      batchLabel,
      n: bucket.scheduledStarts.length,
      dateRangeStart: bucket.scheduledStarts.length ? new Date(Math.min(...bucket.scheduledStarts)).toISOString() : null,
      dateRangeEnd: bucket.scheduledStarts.length ? new Date(Math.max(...bucket.scheduledStarts)).toISOString() : null,
      earliestLockedAt: bucket.lockedAts.length ? new Date(Math.min(...bucket.lockedAts)).toISOString() : null,
      latestLockedAt: bucket.lockedAts.length ? new Date(Math.max(...bucket.lockedAts)).toISOString() : null,
    }))
    .sort((a, b) => (b.latestLockedAt ?? "").localeCompare(a.latestLockedAt ?? ""));
}
