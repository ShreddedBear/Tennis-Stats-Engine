import { canonicalizeStageRows, type RunStatusRow, type StageStatusRow } from "./audit-stages";

// Shared pipeline-execution progress math, used by both the Upload page
// (while actively driving new runs) and the Active Slate page (while
// displaying/resuming existing runs). "Execution" here means how much of the
// 16-stage canonical pipeline has run for ONE audit_run_id — distinct from
// "Evidence %", which measures how much of the evidence is usable
// (DIRECT/RECONSTRUCTED/PARTIAL).
//
// Callers MUST pass only audit_stage_runs rows for a single, current
// audit_run_id (never rows merged across matches or across a match's prior
// runs) -- see audit-stages.ts's STAGES/STAGE_DEPENDENCIES, the single
// canonical source every stage name here is drawn from. Passing unscoped or
// multi-run rows is exactly what produces a stuck-looking "0%" next to
// diagnostics that show completed stages: this module has no way to tell a
// stale prior run's rows apart from the current run's once they're merged.
// activeRunExecutionPercent below does that scoping itself, using the same
// resolveActiveRun/canonicalizeStageRows audit-stages.ts already defines as
// the canonical current-run resolution, so callers don't have to get it
// right by hand each time.
export interface StageProgressRow { stage?: string; status: string; done_count: number | null; total_count: number | null; }

// Keep in sync with STAGES.length in audit-stages.ts (guarded by
// audit-progress.test.ts). Duplicated as a plain constant, rather than
// importing STAGES from audit-stages.ts, so this small client-bundled
// module doesn't pull in that file's much larger dependency graph -- but the
// guard test fails immediately if the two ever drift.
const TOTAL_PIPELINE_STAGES = 16;

// Each of the 16 pipeline stages is worth an equal 1/16 share of "Execution",
// regardless of how many items that stage internally processes (2 identity
// checks vs. 80 metrics). A stage not yet reached (no row, or a row still at
// total_count=0 before its own item count is known -- e.g. "DEFINITION
// INSTANTIATION 0/0 RUNNING" right after it starts) contributes exactly 0,
// never a share it hasn't earned. Earlier code additionally excluded any row
// with total_count<=0 from BOTH the numerator and the denominator, which
// silently shrank the denominator to just the tiny handful of early stages
// that already had a known total -- inflating "Execution" to ~100% while
// most of the pipeline, including the very stage that had stalled, had not
// even started.
function stageFraction(row: StageProgressRow): number {
  if (row.status === "COMPLETE") return 1;
  const total = Number(row.total_count) || 0;
  if (row.status === "RUNNING" && total > 0) {
    return Math.min(Math.max((Number(row.done_count) || 0) / total, 0), 1);
  }
  return 0;
}

// Collapses to at most one row per stage name before scoring, so a caller
// that (against the contract above) hands in rows with a duplicate stage --
// e.g. a retry/attempt history row, or an accidental cross-run merge -- can
// never count that stage's progress more than once. When a stage name
// repeats, the further-along row wins (COMPLETE beats RUNNING beats
// anything else; among ties, the higher done_count wins), never a naive
// last-one-wins or first-one-wins pick.
function dedupeByStage(rows: StageProgressRow[]): StageProgressRow[] {
  const rank = (row: StageProgressRow) => (row.status === "COMPLETE" ? 2 : row.status === "RUNNING" ? 1 : 0);
  const byStage = new Map<string, StageProgressRow>();
  let anonymousIndex = 0;
  for (const row of rows) {
    const key = row.stage ?? `__row_${anonymousIndex++}`;
    const existing = byStage.get(key);
    if (!existing || rank(row) > rank(existing) || (rank(row) === rank(existing) && (Number(row.done_count) || 0) > (Number(existing.done_count) || 0))) {
      byStage.set(key, row);
    }
  }
  return [...byStage.values()];
}

export function computeExecutionPercent(rows: StageProgressRow[], blockedStatus?: string): number {
  const sum = dedupeByStage(rows).reduce((acc, row) => acc + stageFraction(row), 0);
  const pct = Math.round((Math.min(sum, TOTAL_PIPELINE_STAGES) / TOTAL_PIPELINE_STAGES) * 100);
  return blockedStatus === "BLOCKED" ? Math.min(pct, 99) : pct;
}

// Aggregates execution percent across many runs at once (one number for the
// whole batch), used by Upload while several matches are being driven together.
// Each Map entry MUST already be scoped to one audit_run_id.
export function computeBatchExecutionPercent(rowsByRunId: Map<string, StageProgressRow[]>): number {
  if (!rowsByRunId.size) return 0;
  let sum = 0;
  for (const rows of rowsByRunId.values()) for (const row of dedupeByStage(rows)) sum += stageFraction(row);
  const totalStages = rowsByRunId.size * TOTAL_PIPELINE_STAGES;
  return Math.round((Math.min(sum, totalStages) / totalStages) * 100);
}

export interface ActiveRunRow extends RunStatusRow {
  id: string;
  match_id: string;
}

export interface ScopedStageRow extends StageStatusRow {
  audit_run_id: string;
  done_count: number | null;
  total_count: number | null;
}

// THE single canonical "Active Slate Execution %" calculation. Every UI
// surface that shows an execution percentage for a match (today: only
// slate.tsx -- match.$matchId.tsx shows the 16-stage diagnostic list itself
// via canonicalizeStageRows but no percentage, and upload.tsx's batch
// progress is already scoped to run ids it just created) must call this
// function rather than hand-rolling its own resolve-run + scope + canonicalize
// + score sequence, so there is exactly one definition of "current run" and
// exactly one way its progress is computed.
//
// `run` must already be resolved via resolveActiveRun (never re-derived
// here, per audit-stages.ts's single canonical definition of "the active
// run"). Passing null (no active run -- a fresh match, or the latest run was
// just invalidated by Clear Slate or a rule-version change) returns 0: there
// is nothing to report progress on. `stageRows` may span this match's entire
// run history, including invalidated/completed prior runs and even other
// matches' rows -- this function filters to exactly `run.id` itself via
// canonicalizeStageRows' contract, so a caller can never accidentally
// aggregate across runs by forgetting to pre-filter, and duplicate rows for
// the same canonical stage (retry/attempt history, or an accidental
// cross-run merge) can never inflate the score past what canonicalizeStageRows
// already collapses them to.
export function activeRunExecutionPercent(run: ActiveRunRow | null, stageRows: readonly ScopedStageRow[]): number {
  if (!run) return 0;
  const scoped = stageRows.filter((row) => row.audit_run_id === run.id);
  const canonical = canonicalizeStageRows(scoped);
  return computeExecutionPercent(
    canonical.map(({ stage, row }) => ({
      stage,
      status: row?.status ?? "PENDING",
      done_count: row?.done_count ?? 0,
      total_count: row?.total_count ?? 0,
    })),
    run.status,
  );
}
