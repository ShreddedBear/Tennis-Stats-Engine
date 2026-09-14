// ----------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for the Run Audit pipeline's stage order and the
// dependency graph derived from it. This is the CANONICAL 16-stage model:
// exactly one visible diagnostic entry per stage, per audit_run_id, always
// rendered in this fixed 1-16 order regardless of database row order,
// insertion time, or retry/attempt history.
//
// Required order: match ingestion/PDF extraction -> identity verification ->
// context verification -> definition instantiation -> P1 metric execution ->
// P2 metric execution -> verification audit -> disagreement/trap audit ->
// dangerous underdog audit -> stress/removal tests -> independent conclusion
// -> matrix reveal/combination -> current calibration -> coverage
// persistence/evidence validation -> final decision -> final combination
// gate.
//
// This is a strictly linear pipeline: every stage depends on every stage
// before it in STAGES, not just its immediate predecessor. STAGE_DEPENDENCIES
// captures that full ordered prefix per stage so both the execution loop
// (audit-pipeline.ts), the completion engine (audit-engine.ts), the
// persistence layer (audit-repo.server.ts) and the UI all prove "every
// required upstream dependency completed successfully" from the same
// definition -- none of them can drift from the others about what "done"
// means for a given stage, or about display order.
//
// Deliberately dependency-free (no imports) so audit-pipeline.ts,
// audit-engine.ts and UI route files can all import it without creating a
// cycle or pulling in server-only code.
// ----------------------------------------------------------------------------

export const STAGES = [
  "MATCH INGESTION / PDF EXTRACTION",
  "MATCH IDENTITY VERIFICATION",
  "MATCH CONTEXT RESOLUTION",
  "DEFINITION INSTANTIATION",
  "P1 METRIC EXECUTION",
  "P2 METRIC EXECUTION",
  "VERIFICATION AUDIT",
  "DISAGREEMENT / TRAP AUDIT",
  "DANGEROUS UNDERDOG AUDIT",
  "STRESS / REMOVAL TESTS",
  "INDEPENDENT CONCLUSION",
  // Kept as "...COMPARISON" (not "...COMBINATION") to match every existing
  // persisted audit_stage_runs row and in-flight run -- renaming this string
  // would silently orphan live data and any run already past this stage.
  "MATRIX REVEAL AND COMPARISON",
  "CURRENT CALIBRATION APPLICATION",
  "COVERAGE PERSISTENCE / EVIDENCE VALIDATION",
  "FINAL DECISION",
  "FINAL COMBINATION GATE",
] as const;

export type Stage = (typeof STAGES)[number];

export const FINAL_STAGE: Stage = STAGES[STAGES.length - 1];

// ----------------------------------------------------------------------------
// ACTIVE-RUN RESOLUTION: the single source of truth for "does this match
// currently have an active audit run", used by Clear Slate (reset-slate.
// functions.ts), rule-version invalidation (bootstrap.ts), run creation
// (audit-pipeline.ts's ensureRun), and every UI surface that shows a run's
// diagnostics/report/progress (match.$matchId.tsx, slate.tsx).
//
// An audit_runs row is marked INVALIDATED_RUN_STATUS when it has been
// superseded -- by Clear Slate or by a rule-document version change -- and
// must never again be treated as "the current run" for a match: not for
// display (its diagnostics, report, coverage, execution % must not render as
// if they were live), and not for driving (the pipeline must never resume
// or complete an invalidated run). Its historical child rows are preserved
// on purpose -- only its status changes -- but every read path that answers
// "what is the active run for this match" must resolve straight through it
// to null, exactly as if no run existed yet, until a genuinely new
// audit_run_id is created. This is a state-resolution rule, not a per-page
// UI filter: it lives here so the backend and every UI surface apply it
// identically, from the same definition.
// ----------------------------------------------------------------------------
export const INVALIDATED_RUN_STATUS = "INVALIDATED — RERUN REQUIRED";

export interface RunStatusRow {
  status: string;
  run_number: number;
}

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return !!status && status !== INVALIDATED_RUN_STATUS;
}

// Given every audit_runs row known for a match (any order), returns the one
// that is genuinely the current active run, or null if the most recent run
// was invalidated (Clear Slate, or a rule-version change) and no fresh run
// has started yet. Never falls back to an older run when the latest one is
// invalidated -- that would resurrect stale state instead of presenting a
// clean slate.
export function resolveActiveRun<T extends RunStatusRow>(runs: readonly T[]): T | null {
  if (!runs.length) return null;
  const latest = [...runs].sort((a, b) => b.run_number - a.run_number)[0]!;
  return isActiveRunStatus(latest.status) ? latest : null;
}

// stage -> every stage that must already be COMPLETE before this stage may
// start or be persisted as COMPLETE. Computed once from STAGES' own order so
// there is exactly one place that encodes "what comes before what".
export const STAGE_DEPENDENCIES: Readonly<Record<Stage, readonly Stage[]>> = Object.freeze(
  Object.fromEntries(STAGES.map((stage, index) => [stage, Object.freeze(STAGES.slice(0, index))])) as Record<
    Stage,
    readonly Stage[]
  >,
);

// Structural, not the full StageRow -- both audit-pipeline.ts's StageRow and
// audit-repo.server.ts's raw Supabase rows already satisfy this shape.
export interface StageStatusRow {
  stage: string;
  status: string;
}

// Returns every upstream stage STAGE_DEPENDENCIES requires for `stage` that
// is not currently COMPLETE in `rows`. Empty result = every required
// upstream dependency has successfully completed.
export function unmetDependencies(stage: Stage, rows: readonly StageStatusRow[]): Stage[] {
  const byStage = new Map(rows.map((row) => [row.stage, row.status]));
  return STAGE_DEPENDENCIES[stage].filter((dep) => byStage.get(dep) !== "COMPLETE");
}

// Normalizes arbitrary audit_stage_runs-shaped rows into exactly one entry
// per canonical stage, in canonical 1-16 order -- never database insertion
// order, updated_at, attempt number, or whichever row happened to return
// first. Rows MUST already be scoped to a single audit_run_id by the caller;
// this function has no way to tell a stale prior run's row for a stage apart
// from the current run's, so it does not attempt cross-run scoping itself.
//
// If a stage name repeats in `rows` (defense in depth only -- the DB's
// (audit_run_id, stage) unique constraint should make this impossible for a
// properly-scoped query), the further-along row wins: COMPLETE beats
// RUNNING/PARTIAL beats BLOCKED/FAILED beats anything else/PENDING. A stage
// with no row at all yet renders as `row: null` (PENDING/not started) rather
// than being omitted, so the canonical list always has exactly 16 entries.
export function canonicalizeStageRows<T extends StageStatusRow>(rows: readonly T[]): Array<{ stage: Stage; row: T | null }> {
  const rank = (status: string) => (status === "COMPLETE" ? 3 : status === "RUNNING" || status === "PARTIAL" ? 2 : status === "BLOCKED" || status === "FAILED" ? 1 : 0);
  const byStage = new Map<string, T>();
  for (const row of rows) {
    const existing = byStage.get(row.stage);
    if (!existing || rank(row.status) > rank(existing.status)) byStage.set(row.stage, row);
  }
  return STAGES.map((stage) => ({ stage, row: byStage.get(stage) ?? null }));
}
