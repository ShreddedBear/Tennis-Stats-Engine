/**
 * Shared identifier for the shadow-replay job's `job_runs` rows. Kept in its own module for the
 * same reason as `calibrationRefitJobName.ts`/`paperTradingJobName.ts`: importing it from a route
 * (to check for a stale lock or list run history) must not pull the job's own module (which holds
 * in-process singleton state) into anything that shouldn't share it.
 */
export const SHADOW_REPLAY_JOB_NAME = "shadow-replay";
