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
  latestRunsByMatch, activeSlateMatchIds, activeRunIds, resolveActiveRun, currentAuditRows,
  activeMetricReadiness, winRate, STAGES,
} from "@workspace/truth-engine";
import { makeDeps } from "../services/tennisMatrixAudit/auditRepo";
import { commitMatchups, extractMatchups, type ExtractedPdf } from "../services/tennisMatrixAudit/ingest";
import { readBoard } from "../services/tennisMatrixAudit/board";
import { bootstrapAuditDefinitions } from "../services/tennisMatrixAudit/bootstrap";
import {
  gradeResult, matrixCalibrationInputs, readCalibration, readCalibrationHistory,
} from "../services/tennisMatrixAudit/calibration";

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

// --- MASTER RANKED BOARD -----------------------------------------------------------
// Audit colour first, verified win rate second. Never the Matrix's stated probability.
router.get("/api/tennis-matrix-audit/board", requireAdmin, async (_req, res) => {
  try {
    res.json({ rows: await readBoard() });
  } catch (error) {
    fail(res, error, "board");
  }
});

// --- CALIBRATION -------------------------------------------------------------------
router.get("/api/tennis-matrix-audit/calibration", requireAdmin, async (req, res) => {
  try {
    res.json(await readCalibration(Number(req.query["limit"] ?? 100)));
  } catch (error) {
    fail(res, error, "calibration");
  }
});

router.get("/api/tennis-matrix-audit/calibration/history", requireAdmin, async (req, res) => {
  try {
    res.json(await readCalibrationHistory(Number(req.query["limit"] ?? 40)));
  } catch (error) {
    fail(res, error, "calibration history");
  }
});

// Prefills only the PREDICTION half of the grading form. The actual winner and result type
// are never inferred: they are the thing being graded.
router.get("/api/tennis-matrix-audit/calibration/prefill/:matchId", requireAdmin, async (req, res) => {
  try {
    const prefill = await matrixCalibrationInputs(String(req.params["matchId"]));
    if (!prefill) {
      res.status(404).json({ error: "No match found for that id, or it has no parsed summary yet" });
      return;
    }
    res.json(prefill);
  } catch (error) {
    fail(res, error, "calibration prefill");
  }
});

router.post("/api/tennis-matrix-audit/calibration/grade", requireAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = String(body["matchLabel"] ?? "").trim();
    if (!label) {
      res.status(400).json({ error: "A match label is required to grade a result" });
      return;
    }
    const wp = body["matrixWp"];
    const result = await gradeResult({
      matchId: body["matchId"] ? String(body["matchId"]) : null,
      matchLabel: label,
      tournament: body["tournament"] ? String(body["tournament"]) : null,
      surface: body["surface"] ? String(body["surface"]) : null,
      matchDate: body["matchDate"] ? String(body["matchDate"]) : null,
      matrixPredictedWinner: body["matrixPredictedWinner"] ? String(body["matrixPredictedWinner"]) : null,
      matrixWp: wp === null || wp === undefined || wp === "" || Number.isNaN(Number(wp)) ? null : Number(wp),
      resultType: String(body["resultType"] ?? "WIN"),
      actualWinner: body["actualWinner"] ? String(body["actualWinner"]) : null,
      note: body["note"] ? String(body["note"]) : null,
    });
    res.json(result);
  } catch (error) {
    fail(res, error, "calibration grade");
  }
});

// --- SOURCES & CONFLICTS -----------------------------------------------------------
// Conflicting values are never silently averaged: both are kept and the conflict is a row.
router.get("/api/tennis-matrix-audit/sources", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 200)));
    const [snapshots, conflicts] = await Promise.all([
      pool.query(
        `select id, match_id, source_name, data_key, raw_value, normalized_value, reliability, retrieved_at
           from source_snapshots order by retrieved_at desc limit $1`,
        [limit],
      ),
      pool.query(
        `select id, match_id, data_key, values, selected_value, critical, resolution_status, created_at
           from source_conflicts order by created_at desc limit $1`,
        [limit],
      ),
    ]);
    res.json({ snapshots: snapshots.rows, conflicts: conflicts.rows });
  } catch (error) {
    fail(res, error, "sources");
  }
});

router.post("/api/tennis-matrix-audit/sources/conflict/:id", requireAdmin, async (req, res) => {
  try {
    const resolution = String((req.body ?? {})["resolution"] ?? "");
    // A conflict is resolved by a person choosing, or declared unresolvable. There is no
    // third state that quietly lets a blocked match through.
    if (!["RESOLVED", "UNRESOLVABLE"].includes(resolution)) {
      res.status(400).json({ error: "Resolution must be RESOLVED or UNRESOLVABLE" });
      return;
    }
    const { rowCount } = await pool.query(`update source_conflicts set resolution_status = $1 where id = $2`, [
      resolution,
      String(req.params["id"]),
    ]);
    if (!rowCount) {
      res.status(404).json({ error: "Conflict not found" });
      return;
    }
    res.json({ ok: true, resolution });
  } catch (error) {
    fail(res, error, "resolve conflict");
  }
});

// --- DASHBOARD ---------------------------------------------------------------------
// Slate health at a glance: how much of the slate has been audited, how the completed
// audits distributed across the colours, and which calibration record is in force. Scoped
// to the active slate and current runs, like every other operational view.
router.get("/api/tennis-matrix-audit/dashboard", requireAdmin, async (_req, res) => {
  try {
    const [matches, runs, decisions, versions, uploads, calibration] = await Promise.all([
      pool.query(`select id, identity_status, surface_status, result_status from matches`),
      pool.query(`select id, match_id, run_number, status, independent_decision_committed_at, heartbeat_at from audit_runs`),
      pool.query(`select audit_run_id, final_audit_color, audit_complete from final_decisions`),
      pool.query(`select match_id, upload_id, is_active from summary_versions`),
      pool.query(`select count(*)::int as n from summary_uploads`),
      pool.query(`select * from calibration_versions where is_active = true limit 1`),
    ]);

    const onSlate = activeSlateMatchIds(versions.rows as never);
    const slateMatches = (matches.rows as Array<Record<string, unknown>>).filter((m) => onSlate.has(String(m["id"])));
    const current = currentAuditRows(slateMatches as never, runs.rows as never, decisions.rows as never);

    const completed = current.filter((entry) => (entry.decision as unknown as Record<string, unknown> | null)?.["audit_complete"]);
    const colorCounts: Record<string, number> = {};
    for (const entry of completed) {
      const color = String((entry.decision as unknown as Record<string, unknown>)["final_audit_color"] ?? "UNKNOWN");
      colorCounts[color] = (colorCounts[color] ?? 0) + 1;
    }

    const activeCalibration = (calibration.rows[0] as Record<string, unknown> | undefined) ?? null;
    const buckets = activeCalibration
      ? await pool.query(`select bucket_code, wins, graded from calibration_buckets
                           where calibration_version_id = $1 order by wp_min`, [activeCalibration["id"]])
      : { rows: [] as Array<Record<string, unknown>> };

    res.json({
      slate: {
        matches: slateMatches.length,
        withRun: current.filter((entry) => entry.run).length,
        completed: completed.length,
        // A match on the slate with no current run has simply not been audited yet -- it is
        // not a failure, and it must not be counted as one.
        notRun: current.filter((entry) => !entry.run).length,
        uploads: Number((uploads.rows[0] as { n: number }).n),
      },
      colors: colorCounts,
      calibration: activeCalibration
        ? {
            label: activeCalibration["label"],
            masterSequence: Number(activeCalibration["master_sequence_count"]),
            gradedSample: Number(activeCalibration["graded_sample_count"]),
            buckets: (buckets.rows as Array<Record<string, unknown>>).map((b) => ({
              bucket_code: String(b["bucket_code"]),
              wins: Number(b["wins"]),
              graded: Number(b["graded"]),
              win_rate: winRate(Number(b["wins"]), Number(b["graded"])),
            })),
          }
        : null,
    });
  } catch (error) {
    fail(res, error, "dashboard");
  }
});

// --- RUN HISTORY -------------------------------------------------------------------
// Every run this match has had, current and superseded. Invalidated runs are real history
// and are never deleted -- a past verdict was genuinely reached under the rules of the day,
// and hiding it would make the record look cleaner than it was.
router.get("/api/tennis-matrix-audit/match/:matchId/runs", requireAdmin, async (req, res) => {
  try {
    const matchId = String(req.params["matchId"]);
    const runs = await pool.query(
      `select id, run_number, status, stale_reason, independent_winner, effective_evidence_count,
              independent_decision_committed_at, created_at, heartbeat_at
         from audit_runs where match_id = $1 order by run_number desc`,
      [matchId],
    );
    const ids = (runs.rows as Array<{ id: string }>).map((row) => row.id);
    const decisions = ids.length
      ? await pool.query(
          `select audit_run_id, final_audit_color, action, audit_complete, completion_percent, gate_report
             from final_decisions where audit_run_id = any($1::uuid[])`,
          [ids],
        )
      : { rows: [] as Array<Record<string, unknown>> };

    const byRun = new Map(
      (decisions.rows as Array<Record<string, unknown>>).map((d) => [String(d["audit_run_id"]), d]),
    );
    const active = resolveActiveRun(runs.rows as never) as Record<string, unknown> | null;

    res.json({
      runs: (runs.rows as Array<Record<string, unknown>>).map((run) => {
        const decision = byRun.get(String(run["id"])) ?? null;
        return {
          ...run,
          isCurrent: active !== null && String(active["id"]) === String(run["id"]),
          decision,
          selected_player:
            (decision?.["gate_report"] as { deterministic_decision?: { selected_player?: string | null } } | null)
              ?.deterministic_decision?.selected_player ?? null,
        };
      }),
    });
  } catch (error) {
    fail(res, error, "run history");
  }
});

// --- READINESS ---------------------------------------------------------------------
// What the Audit needs before it can produce a selection rather than a refusal. This
// exists because all three failure modes look identical from the slate -- every match
// refuses with INSUFFICIENT EVIDENCE -- and the reason is never the match.
router.get("/api/tennis-matrix-audit/readiness", requireAdmin, async (_req, res) => {
  try {
    const [documents, index, sources] = await Promise.all([
      pool.query(
        `select d.doc_type, v.activation_status, v.parsed_rules, v.expected_rules
           from rule_documents d left join rule_document_versions v on v.id = d.active_version_id`,
      ),
      pool.query(`select player_count, match_count, generated_at from audit_runtime_index
                   order by generated_at desc limit 1`),
      pool.query(`select count(*)::int as n from source_definitions`),
    ]);

    const byType = new Map(
      (documents.rows as Array<Record<string, unknown>>).map((row) => [String(row["doc_type"]), row]),
    );
    const required = ["METRICS", "VERIFICATION", "DISAGREEMENT"];
    const missingDefinitions = required.filter((type) => byType.get(type)?.["activation_status"] !== "READY");

    const indexRow = index.rows[0] as Record<string, unknown> | undefined;
    const players = Number(indexRow?.["player_count"] ?? 0);

    res.json({
      // Without an active rule set the pipeline stops at DEFINITION INSTANTIATION.
      definitions: {
        ready: missingDefinitions.length === 0,
        missing: missingDefinitions,
        documents: required.map((type) => ({
          docType: type,
          status: String(byType.get(type)?.["activation_status"] ?? "NOT LOADED"),
          parsed: Number(byType.get(type)?.["parsed_rules"] ?? 0),
          expected: Number(byType.get(type)?.["expected_rules"] ?? 0),
        })),
      },
      sources: { ready: Number((sources.rows[0] as { n: number }).n) > 0, count: Number((sources.rows[0] as { n: number }).n) },
      // Without the local index, the ~24 producers that read it have no data to compute from.
      runtimeIndex: {
        ready: players > 0,
        players,
        matches: Number(indexRow?.["match_count"] ?? 0),
        generatedAt: indexRow?.["generated_at"] ?? null,
      },
      // Without a provider key the live research tier fails for every metric, and every
      // match refuses. Only whether a key is PRESENT is reported -- never the key.
      researchProvider: {
        ready: Boolean(process.env["OPENAI_API_KEY"] ?? process.env["RESEARCH_FALLBACK_API_KEY"]),
        variable: "OPENAI_API_KEY",
      },
    });
  } catch (error) {
    fail(res, error, "readiness");
  }
});

// --- DEFINITION BOOTSTRAP ----------------------------------------------------------
// Seeds the rule documents, source registry and calibration baseline the Audit cannot run
// without. Idempotent: every step is skipped when its table already has rows, so this never
// rolls a calibration that has since been graded back to the baseline.
router.post("/api/tennis-matrix-audit/bootstrap", requireAdmin, async (_req, res) => {
  try {
    res.json(await bootstrapAuditDefinitions());
  } catch (error) {
    fail(res, error, "bootstrap");
  }
});

// --- RULE KNOWLEDGE BASE -----------------------------------------------------------
// Every run clones the ACTIVE rule set, so past runs stay reproducible against the rules
// they actually ran under.
router.get("/api/tennis-matrix-audit/rules", requireAdmin, async (_req, res) => {
  try {
    const [documents, versions, rules] = await Promise.all([
      pool.query(`select * from rule_documents order by doc_type`),
      pool.query(`select * from rule_document_versions order by version_number`),
      pool.query(`select * from rules order by rule_code`),
    ]);
    res.json({ documents: documents.rows, versions: versions.rows, rules: rules.rows });
  } catch (error) {
    fail(res, error, "rules");
  }
});

// --- EXECUTION LOGS ----------------------------------------------------------------
// Scoped to current runs by default. Cleared matches and invalidated runs are real history
// and are never deleted, but they must not read as current operational output -- so the
// full view is opt-in rather than the default.
router.get("/api/tennis-matrix-audit/logs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 200)));
    const scope = req.query["scope"] === "all" ? "all" : "active";
    const [logs, runs, versions] = await Promise.all([
      pool.query(
        `select id, audit_run_id, match_id, stage, status, output, matrix_visible, created_at
           from execution_logs order by created_at desc limit $1`,
        [limit],
      ),
      pool.query(`select id, match_id, run_number, status, independent_decision_committed_at, heartbeat_at from audit_runs`),
      pool.query(`select match_id, is_active from summary_versions`),
    ]);

    const active = activeRunIds(runs.rows as never, activeSlateMatchIds(versions.rows as never));
    const rows = (logs.rows as Array<Record<string, unknown>>).filter(
      (row) => scope === "all" || (row["audit_run_id"] !== null && active.has(String(row["audit_run_id"]))),
    );
    res.json({ logs: rows, scope, total: logs.rows.length });
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
