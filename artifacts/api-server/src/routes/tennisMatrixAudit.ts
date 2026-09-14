/**
 * Admin-only: Tennis Matrix Audit routes.
 *
 * The Audit is a SEPARATE ENGINE from the AI prediction engine, sharing this
 * application's shell and database but none of its logic. It never produces a
 * probability: it produces a deterministic selection backed by an evidence chain, or an
 * explicit refusal. Nothing in this file reads the predictions table, and nothing in the
 * prediction engine reads the Audit's tables.
 *
 * Every route is a thin transport wrapper. The decisions live in @workspace/truth-engine
 * and the persistence in services/tennisMatrixAudit/auditRepo; this module's only jobs
 * are admin authorisation, input validation and shaping rows for the UI.
 */
import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/adminAuth";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  runPipeline, preparePipelineRun, evaluate, canonicalizeStageRows,
  latestRunsByMatch, activeSlateMatchIds, resolveActiveRun,
  activeMetricReadiness, STAGES,
} from "@workspace/truth-engine";
import { makeDeps } from "../services/tennisMatrixAudit/auditRepo";
import { commitMatchups, extractMatchups, type ExtractedPdf } from "../services/tennisMatrixAudit/ingest";

const router: IRouter = Router();

/** One time-boxed slice of pipeline work per request, so a proxy never times out mid-run. */
const SLICE_BUDGET_MS = 45_000;

function fail(res: Parameters<Parameters<IRouter["get"]>[1]>[1], error: unknown, what: string) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: message }, `[tennis-matrix-audit] ${what} failed`);
  res.status(500).json({ error: message });
}

// --- SLATE -------------------------------------------------------------------------
// The current operational slate: matches with an ACTIVE summary version, each with its
// resolved current run and that run's decision. Both layers matter -- a match whose
// latest run was invalidated (Clear Slate, a rule-version change) has no current run and
// must not show a stale one.
router.get("/api/tennis-matrix-audit/slate", requireAdmin, async (_req, res) => {
  try {
    const [matchRows, runRows, decisionRows, versionRows] = await Promise.all([
      pool.query(`select id, player1_name, player2_name, tournament_name, event_level, round,
                         scheduled_date, surface, indoor, best_of, identity_status, surface_status,
                         actual_winner, result_status, final_score
                    from matches order by scheduled_date nulls last, created_at desc`),
      pool.query(`select id, match_id, run_number, status, independent_winner,
                         independent_decision_committed_at, heartbeat_at
                    from audit_runs`),
      pool.query(`select audit_run_id, final_audit_color, action, audit_complete,
                         completion_percent, gate_report from final_decisions`),
      pool.query(`select match_id, is_active from summary_versions`),
    ]);

    const onSlate = activeSlateMatchIds(versionRows.rows as never);
    const latest = latestRunsByMatch(runRows.rows as never);
    const decisions = new Map((decisionRows.rows as Array<Record<string, unknown>>).map((d) => [String(d["audit_run_id"]), d]));

    const slate = (matchRows.rows as Array<Record<string, unknown>>)
      .filter((match) => onSlate.has(String(match["id"])))
      .map((match) => {
        const run = latest.get(String(match["id"])) as Record<string, unknown> | undefined;
        const decision = run ? decisions.get(String(run["id"])) ?? null : null;
        return {
          match,
          run: run ?? null,
          decision,
          // The persisted decision's own selected player, which is the canonical winner
          // identity. Never parsed back out of the human-readable action string.
          selected_player:
            (decision?.["gate_report"] as { deterministic_decision?: { selected_player?: string | null } } | null)
              ?.deterministic_decision?.selected_player ?? null,
        };
      });

    res.json({ slate, count: slate.length });
  } catch (error) {
    fail(res, error, "slate");
  }
});

// --- MATCH DETAIL ------------------------------------------------------------------
// Everything the match workspace renders, scoped to the CURRENT run: the 16 canonical
// stages in order, all six child-result tables, coverage, and the decision.
router.get("/api/tennis-matrix-audit/match/:matchId", requireAdmin, async (req, res) => {
  try {
    const matchId = String(req.params["matchId"]);
    const match = await pool.query(`select * from matches where id = $1`, [matchId]);
    if (!match.rows.length) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const runs = await pool.query(`select * from audit_runs where match_id = $1 order by run_number desc`, [matchId]);
    const run = resolveActiveRun(runs.rows as never) as Record<string, unknown> | null;
    if (!run) {
      res.json({
        match: match.rows[0], run: null, wasInvalidated: runs.rows.length > 0,
        stages: [], metrics: [], verification: [], disagreement: [], underdog: [], stress: [],
        reconstructions: [], coverage: [], decision: null, report: null, readiness: null,
      });
      return;
    }

    const runId = String(run["id"]);
    const byRun = (table: string) => pool.query(`select * from ${table} where audit_run_id = $1`, [runId]);
    const [stages, metrics, verification, disagreement, underdog, stress, reconstructions, coverage, decision, conflicts] =
      await Promise.all([
        pool.query(`select * from audit_stage_runs where audit_run_id = $1 order by stage_order`, [runId]),
        byRun("metric_results"), byRun("verification_results"), byRun("disagreement_results"),
        byRun("underdog_results"), byRun("stress_results"), byRun("reconstruction_results"),
        byRun("audit_coverage"),
        pool.query(`select * from final_decisions where audit_run_id = $1 limit 1`, [runId]),
        pool.query(`select critical, resolution_status from source_conflicts where audit_run_id = $1`, [runId]),
      ]);

    // The same gate report the pipeline computes, so the UI can never disagree with the
    // engine about colour, coverage or completion -- it renders the engine's own output.
    const report = evaluate({
      match: match.rows[0] as never,
      run: run as never,
      metrics: metrics.rows as never,
      verification: verification.rows as never,
      disagreement: disagreement.rows as never,
      underdog: underdog.rows as never,
      stress: stress.rows as never,
      reconstructions: reconstructions.rows as never,
      conflicts: conflicts.rows as never,
      matrixWp: null,
      stages: (stages.rows as Array<Record<string, unknown>>).map((row) => ({
        stage: String(row["stage"]), status: String(row["status"]),
      })),
    });

    res.json({
      match: match.rows[0],
      run,
      wasInvalidated: false,
      // Exactly one entry per canonical stage, in canonical 1-16 order, whatever order
      // the rows came back in.
      stages: canonicalizeStageRows(stages.rows as never),
      metrics: metrics.rows,
      verification: verification.rows,
      disagreement: disagreement.rows,
      underdog: underdog.rows,
      stress: stress.rows,
      reconstructions: reconstructions.rows,
      coverage: coverage.rows,
      decision: decision.rows[0] ?? null,
      report,
      readiness: activeMetricReadiness(metrics.rows as never),
    });
  } catch (error) {
    fail(res, error, "match detail");
  }
});

// --- RUN / RESUME ------------------------------------------------------------------
// One time-boxed slice. runPipeline persists partial stage progress and takes a lease,
// so calling this repeatedly resumes the same run rather than restarting it or creating
// a duplicate -- which is exactly how the UI drives a long audit to completion.
router.post("/api/tennis-matrix-audit/match/:matchId/run", requireAdmin, async (req, res) => {
  try {
    const matchId = String(req.params["matchId"]);
    const deps = await makeDeps();
    const result = await runPipeline(deps, matchId, { budgetMs: SLICE_BUDGET_MS });
    res.json({
      ok: true,
      runId: result.runId,
      complete: result.complete,
      nextStage: result.nextStage,
      stages: result.stages,
      failures: result.failures,
      leaseHeld: result.leaseHeld ?? false,
      color: result.report?.color ?? null,
      action: result.report?.action ?? null,
      completionPercent: result.report?.completionPercent ?? null,
      auditComplete: result.report?.auditComplete ?? false,
    });
  } catch (error) {
    fail(res, error, "run");
  }
});

router.post("/api/tennis-matrix-audit/match/:matchId/prepare", requireAdmin, async (req, res) => {
  try {
    const deps = await makeDeps();
    const run = await preparePipelineRun(deps, String(req.params["matchId"]));
    res.json({ ok: true, run });
  } catch (error) {
    fail(res, error, "prepare");
  }
});

// --- INGESTION ---------------------------------------------------------------------
// Two steps on purpose: extract shows what was detected and writes nothing; commit
// persists what the user actually reviewed. Match identity (canonical key + reuse search)
// is resolved server-side in commit, so the same real match uploaded twice cannot end up
// as two rows.
router.post("/api/tennis-matrix-audit/ingest/extract", requireAdmin, async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) {
      res.status(400).json({ error: "No files supplied" });
      return;
    }
    const extracted: ExtractedPdf[] = [];
    const failures: Array<{ filename: string; message: string }> = [];
    for (const file of files as Array<{ filename?: string; base64?: string }>) {
      try {
        extracted.push(await extractMatchups(String(file.filename ?? "upload.pdf"), String(file.base64 ?? "")));
      } catch (error) {
        failures.push({ filename: String(file.filename ?? "upload.pdf"), message: error instanceof Error ? error.message : String(error) });
      }
    }
    res.json({ files: extracted, failures });
  } catch (error) {
    fail(res, error, "ingest/extract");
  }
});

router.post("/api/tennis-matrix-audit/ingest/commit", requireAdmin, async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? (req.body.files as ExtractedPdf[]) : [];
    if (!files.length) {
      res.status(400).json({ error: "No reviewed files supplied" });
      return;
    }
    res.json(await commitMatchups(files));
  } catch (error) {
    fail(res, error, "ingest/commit");
  }
});

// --- EXECUTION LOGS ----------------------------------------------------------------
router.get("/api/tennis-matrix-audit/logs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 200)));
    const { rows } = await pool.query(
      `select id, audit_run_id, match_id, stage, status, output, matrix_visible, created_at
         from execution_logs order by created_at desc limit $1`,
      [limit],
    );
    res.json({ logs: rows });
  } catch (error) {
    fail(res, error, "logs");
  }
});

// --- THE ACTIVE METRIC REGISTRY ----------------------------------------------------
// The authoritative 25 and their comparison contract, read straight from the engine so
// this can never drift from what actually grades a match.
router.get("/api/tennis-matrix-audit/metrics", requireAdmin, async (_req, res) => {
  try {
    const { COMPARISON_SPECS, ACTIVE_METRIC_CODES } = await import("@workspace/truth-engine");
    res.json({
      active_codes: ACTIVE_METRIC_CODES,
      count: ACTIVE_METRIC_CODES.length,
      specs: Object.fromEntries(
        Object.entries(COMPARISON_SPECS).map(([code, spec]) => [
          code,
          { label: spec.label, field: spec.field, direction: spec.direction, family: spec.family, materiality: spec.materiality },
        ]),
      ),
      stages: STAGES,
    });
  } catch (error) {
    fail(res, error, "metrics");
  }
});

// --- CLEAR SLATE -------------------------------------------------------------------
// Physical deletion, verified inside the same transaction. Requires an explicit
// confirmation phrase in the body: this destroys every operational audit row.
router.post("/api/tennis-matrix-audit/clear-slate", requireAdmin, async (req, res) => {
  try {
    if (req.body?.confirm !== "CLEAR SLATE") {
      res.status(400).json({ error: "Clear slate confirmation is required" });
      return;
    }
    const { LOCAL_WORKSPACE_ID } = await import("@workspace/truth-engine");
    const { rows } = await pool.query(`select public.clear_operational_slate($1::uuid) as result`, [LOCAL_WORKSPACE_ID]);
    const result = (rows[0] as { result: { after?: Record<string, number> } }).result;
    const survivors = Object.entries(result?.after ?? {}).filter(([, count]) => Number(count) > 0);
    if (survivors.length) {
      res.status(500).json({
        error: `Clear Slate did not fully delete the operational slate: ${survivors.map(([t, c]) => `${t}=${c}`).join(", ")} still present.`,
      });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    fail(res, error, "clear slate");
  }
});

export default router;
