/**
 * Async job wrapper for the shadow-replay no-look-ahead historical replay
 * (`runShadowPaperTradingReplay` in `services/evaluation/shadowReplay.ts`).
 *
 * Same fire-and-poll rationale as `walkForwardJob.ts`/`ablationJob.ts`: a multi-week/month replay
 * takes far longer than any HTTP proxy timeout, so a route starts this in the background and the
 * client polls `getShadowReplayJobStatus()`.
 *
 * What this adds beyond the existing in-process-only job pattern (walk-forward/ablation), written
 * specifically for the 3-month no-look-ahead walk-forward validation task's resource-safety
 * requirements:
 *
 *  - A safety cap on how long a single requested range may be (`MAX_REPLAY_DAYS_WITHOUT_OVERRIDE`)
 *    -- "do not launch a giant unrestricted historical job" is enforced in code, not just policy.
 *  - A restart-resistant lock: a `job_runs` row is inserted with `finishedAt: null` at job start
 *    and updated with a heartbeat after every calendar day processed. A second start request finds
 *    that row and refuses to run concurrently with it UNLESS the heartbeat has gone stale (no
 *    update in `STALE_LOCK_MS`), which means the owning process crashed -- in that case the stale
 *    row is marked failed and a fresh run starts. This survives an api-server restart, unlike the
 *    plain in-process singleton flag `walkForwardJob.ts`/`ablationJob.ts` use alone.
 *  - Checkpoint/resume comes from `shadowReplay.ts`'s own append-only design: a deterministic
 *    `batchLabel` derived from the requested date range means re-running the SAME window (e.g.
 *    after a crash, or via the stale-lock recovery above) safely skips every match a previous
 *    attempt already scored (`onConflictDoNothing` on `(runKind, historicalMatchId)`) and picks up
 *    exactly where it left off -- there is no separate checkpoint table to keep in sync.
 *  - Cooperative cancellation: `requestShadowReplayCancellation()` sets a flag polled once per
 *    calendar day (see `ShadowReplayOptions.isCancelled`), so a cancel request stops the run at the
 *    next day boundary rather than needing to kill the process.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, jobRunsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { runShadowPaperTradingReplay, type ShadowReplaySummary } from "../services/evaluation/shadowReplay";
import { SHADOW_REPLAY_JOB_NAME } from "./shadowReplayJobName";

export { SHADOW_REPLAY_JOB_NAME };

/**
 * Safety cap (~3.3 months): a single job invocation spanning more days than this is refused
 * unless the caller explicitly passes `allowExtendedRange: true`. Matches the task's explicit
 * instruction to start with a bounded 3-month window rather than an unrestricted historical run.
 */
export const MAX_REPLAY_DAYS_WITHOUT_OVERRIDE = 100;

/** A running job_runs row with no heartbeat update in this long is treated as crashed, not busy. */
const STALE_LOCK_MS = 10 * 60_000;

interface RunningJobFields {
  startedAt: string;
  batchLabel: string;
  startDate: string;
  endDate: string;
  lastDayProcessed: string | null;
  insertedSoFar: number;
  daysSimulatedSoFar: number;
  heapUsedMB: number | null;
  cancelRequested: boolean;
}

export type ShadowReplayJobStatus =
  | { state: "idle" }
  | ({ state: "running" } & RunningJobFields)
  | { state: "done"; startedAt: string; finishedAt: string; batchLabel: string; result: ShadowReplaySummary }
  | { state: "error"; startedAt: string; finishedAt: string; batchLabel: string; error: string };

let currentJob: ShadowReplayJobStatus = { state: "idle" };
let cancelRequested = false;
let currentJobRunId: number | null = null;

export function getShadowReplayJobStatus(): ShadowReplayJobStatus {
  return currentJob;
}

/** Requests cooperative cancellation of the in-process run. No-op (with a reason) if none is running. */
export function requestShadowReplayCancellation(): { ok: boolean; reason?: string } {
  if (currentJob.state !== "running") {
    return { ok: false, reason: "No shadow-replay job is currently running in this process." };
  }
  cancelRequested = true;
  currentJob = { ...currentJob, cancelRequested: true };
  return { ok: true };
}

export interface StartShadowReplayJobOptions {
  startDate: string;
  endDate: string;
  /**
   * Defaults to a deterministic label derived from the date range so re-triggering the SAME
   * window (e.g. after a crash) resumes the same batch instead of starting a disjoint one.
   */
  batchLabel?: string;
  overwrite?: boolean;
  /** Required to start a run spanning more than MAX_REPLAY_DAYS_WITHOUT_OVERRIDE days. */
  allowExtendedRange?: boolean;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

function defaultBatchLabel(startDate: string, endDate: string): string {
  return `walk-forward-replay-${startDate}-to-${endDate}`;
}

export async function startShadowReplayJob(
  opts: StartShadowReplayJobOptions,
): Promise<{ started: boolean; reason?: string; batchLabel?: string }> {
  if (currentJob.state === "running") {
    return { started: false, reason: "A shadow-replay job is already in progress in this process." };
  }

  const rangeDays = daysBetween(opts.startDate, opts.endDate);
  if (rangeDays <= 0) {
    return { started: false, reason: "endDate must be on or after startDate." };
  }
  if (rangeDays > MAX_REPLAY_DAYS_WITHOUT_OVERRIDE && !opts.allowExtendedRange) {
    return {
      started: false,
      reason:
        `Requested range is ${rangeDays} days, above the ${MAX_REPLAY_DAYS_WITHOUT_OVERRIDE}-day safety cap (~3 months). ` +
        "Do not launch an unrestricted historical job -- start with a 3-month window, review the resource-safety report, " +
        "then pass allowExtendedRange:true only once a longer window is genuinely justified.",
    };
  }

  const batchLabel = opts.batchLabel?.trim() || defaultBatchLabel(opts.startDate, opts.endDate);

  // Restart-resistant lock check: a `job_runs` row for this job with finishedAt still null means
  // either a genuinely in-flight run (possibly in a different process/replica than this one, so
  // the in-process `currentJob.state` check above cannot see it) or a crashed one that never got
  // to write its terminal status. The heartbeat in `summary.heartbeatAt` disambiguates the two.
  const [existingLock] = await db
    .select()
    .from(jobRunsTable)
    .where(and(eq(jobRunsTable.jobName, SHADOW_REPLAY_JOB_NAME), isNull(jobRunsTable.finishedAt)))
    .orderBy(desc(jobRunsTable.startedAt))
    .limit(1);

  if (existingLock) {
    const existingSummary = existingLock.summary as { batchLabel?: string; heartbeatAt?: string } | null;
    const lastBeatMs = existingSummary?.heartbeatAt ? new Date(existingSummary.heartbeatAt).getTime() : existingLock.startedAt.getTime();
    const staleForMs = Date.now() - lastBeatMs;
    if (staleForMs < STALE_LOCK_MS) {
      return {
        started: false,
        reason:
          `A shadow-replay job (batch "${existingSummary?.batchLabel ?? "unknown"}") already holds the lock and last reported ` +
          `progress ${Math.round(staleForMs / 1000)}s ago. Refusing to start a second run to avoid overlapping full-corpus preloads.`,
      };
    }
    logger.warn(
      { staleLockJobRunId: existingLock.id, staleForMs },
      "shadow-replay: superseding a stale job_runs lock (no heartbeat in over 10 minutes -- treating the owning process as crashed)",
    );
    await db
      .update(jobRunsTable)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: "Superseded: no heartbeat received, treated as crashed" })
      .where(eq(jobRunsTable.id, existingLock.id));
  }

  const startedAt = new Date();
  const [lockRow] = await db
    .insert(jobRunsTable)
    .values({
      jobName: SHADOW_REPLAY_JOB_NAME,
      startedAt,
      finishedAt: null,
      status: "running",
      attempts: 1,
      summary: { batchLabel, startDate: opts.startDate, endDate: opts.endDate, heartbeatAt: startedAt.toISOString() },
      errorMessage: null,
    })
    .returning({ id: jobRunsTable.id });

  currentJobRunId = lockRow.id;
  cancelRequested = false;
  currentJob = {
    state: "running",
    startedAt: startedAt.toISOString(),
    batchLabel,
    startDate: opts.startDate,
    endDate: opts.endDate,
    lastDayProcessed: null,
    insertedSoFar: 0,
    daysSimulatedSoFar: 0,
    heapUsedMB: null,
    cancelRequested: false,
  };

  // Intentionally not awaited -- runs in the background inside this long-lived server process.
  void runJob(startedAt, batchLabel, opts);

  return { started: true, batchLabel };
}

async function runJob(startedAt: Date, batchLabel: string, opts: StartShadowReplayJobOptions): Promise<void> {
  const jobRunId = currentJobRunId;
  try {
    const result = await runShadowPaperTradingReplay({
      startDate: opts.startDate,
      endDate: opts.endDate,
      batchLabel,
      overwrite: opts.overwrite ?? false,
      isCancelled: () => cancelRequested,
      onProgress: async (info) => {
        if (currentJob.state === "running") {
          currentJob = {
            ...currentJob,
            lastDayProcessed: info.day,
            insertedSoFar: info.insertedSoFar,
            daysSimulatedSoFar: info.daysSimulatedSoFar,
            heapUsedMB: info.heapUsedMB,
          };
        }
        if (jobRunId !== null) {
          await db
            .update(jobRunsTable)
            .set({
              summary: {
                batchLabel,
                startDate: opts.startDate,
                endDate: opts.endDate,
                heartbeatAt: new Date().toISOString(),
                lastDayProcessed: info.day,
                insertedSoFar: info.insertedSoFar,
                daysSimulatedSoFar: info.daysSimulatedSoFar,
                heapUsedMB: info.heapUsedMB,
              },
            })
            .where(eq(jobRunsTable.id, jobRunId));
        }
      },
    });

    const finishedAt = new Date();
    currentJob = { state: "done", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), batchLabel, result };
    if (jobRunId !== null) {
      await db
        .update(jobRunsTable)
        .set({ status: result.cancelled ? "cancelled" : "success", finishedAt, summary: { batchLabel, ...result } })
        .where(eq(jobRunsTable.id, jobRunId));
    }
    logger.info({ batchLabel, ...result }, result.cancelled ? "Shadow-replay job cancelled cooperatively" : "Shadow-replay job completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    currentJob = { state: "error", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), batchLabel, error: message };
    if (jobRunId !== null) {
      await db.update(jobRunsTable).set({ status: "failed", finishedAt, errorMessage: message }).where(eq(jobRunsTable.id, jobRunId));
    }
    logger.error({ err, batchLabel }, "Shadow-replay job failed");
  } finally {
    currentJobRunId = null;
    cancelRequested = false;
  }
}
