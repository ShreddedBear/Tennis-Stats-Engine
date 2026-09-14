// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — the Postgres implementation of PipelineDeps.
//
// This is the ONE module that knows where the Audit's data lives. The frozen
// engine (@workspace/truth-engine) reaches the database only through the
// PipelineDeps interface it defines, so replacing the standalone app's hosted-
// platform client with this workspace's own pool is the whole of the data-layer
// migration: not a single decision rule, threshold, metric definition or stage
// changes because of it.
//
// Written against the same column names the engine already reads and writes, so
// the row objects handed to it are shape-identical to the ones it saw before.
// Drizzle is used for the schema and the pool; the queries themselves are mostly
// plain SQL because the engine's contract is row-shaped, not model-shaped, and
// hand-written SQL keeps the mapping visible rather than hidden behind a builder.
// ----------------------------------------------------------------------------
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ChildTable, PipelineDeps, RunRow, Stage } from "@workspace/truth-engine";
import { LOCAL_WORKSPACE_ID, STAGES } from "@workspace/truth-engine";
import { db, pool } from "@workspace/db";
import {
  auditCoverage, calibrationBuckets, calibrationVersions, executionLogs, finalDecisions,
  matchIdentityRecords, matches, metricCoverageRates, metricResults, parsedSummaryFields,
  reconstructionResults, ruleDocuments, rules as rulesTable, sourceConflicts, summaryVersions,
} from "@workspace/db";
import { auditResearcher } from "./researcher";

const OWNER = LOCAL_WORKSPACE_ID;

/**
 * The six per-run child tables the pipeline reads and writes generically, as an explicit
 * allow-list. It is a name set rather than a table map because these go through the
 * row-shaped SQL helpers below (the engine's contract is real column names, not Drizzle
 * models) -- and because it doubles as the guard that `table` can only ever be one of
 * these six, whatever a caller passes.
 */
const CHILD_TABLES = new Set<ChildTable>([
  "metric_results",
  "reconstruction_results",
  "verification_results",
  "disagreement_results",
  "underdog_results",
  "stress_results",
]);

/**
 * The engine passes and expects snake_case row objects (it reads `row["p1_status"]`),
 * while Drizzle models are camelCase. Rather than maintaining two spellings of 537
 * columns, every generic child-table read and write goes through raw SQL against the
 * real column names -- which is also what makes the engine's `Record<string, unknown>`
 * contract literally true rather than approximately true.
 */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Refusing unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

async function selectRows(table: string, where: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(`select * from ${quoteIdent(table)} where ${where}`, params);
  return result.rows as Array<Record<string, unknown>>;
}

export async function makeDeps(): Promise<PipelineDeps> {
  const user_id = OWNER;

  return {
    now: () => new Date(),
    research: auditResearcher,

    async getMatch(matchId) {
      const rows = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
      const row = rows[0];
      if (!row) return null;
      // Returned in the engine's own spelling; it reads these keys directly.
      return {
        id: row.id,
        player1_name: row.player1Name,
        player2_name: row.player2Name,
        tournament_name: row.tournamentName,
        event_level: row.eventLevel,
        round: row.round,
        scheduled_date: row.scheduledDate,
        surface: row.surface,
        indoor: row.indoor,
        best_of: row.bestOf,
        identity_status: row.identityStatus,
        surface_status: row.surfaceStatus,
        actual_winner: row.actualWinner,
      } as never;
    },

    async updateMatch(matchId, patch) {
      await updateByColumns("matches", "id", matchId, patch);
    },

    async getParsedFields(matchId) {
      const versions = await db
        .select({ id: summaryVersions.id })
        .from(summaryVersions)
        .where(and(eq(summaryVersions.matchId, matchId), eq(summaryVersions.isActive, true)))
        .limit(1);
      const version = versions[0];
      if (!version) return {};
      const fields = await db
        .select({
          key: parsedSummaryFields.fieldKey,
          normalized: parsedSummaryFields.normalizedValue,
          raw: parsedSummaryFields.rawValue,
        })
        .from(parsedSummaryFields)
        .where(eq(parsedSummaryFields.summaryVersionId, version.id));
      const out: Record<string, string> = {};
      for (const field of fields) {
        const value = field.normalized ?? field.raw;
        if (value) out[field.key] = value;
      }
      return out;
    },

    async getActiveVersionId(docType) {
      const rows = await db
        .select({ activeVersionId: ruleDocuments.activeVersionId })
        .from(ruleDocuments)
        .where(eq(ruleDocuments.docType, docType))
        .limit(1);
      return rows[0]?.activeVersionId ?? null;
    },

    async getRules(versionId) {
      const rows = await db
        .select({
          id: rulesTable.id,
          rule_code: rulesTable.ruleCode,
          rule_name: rulesTable.ruleName,
          body: rulesTable.body,
          severity: rulesTable.severity,
          blocking: rulesTable.blocking,
        })
        .from(rulesTable)
        .where(eq(rulesTable.versionId, versionId))
        .orderBy(asc(rulesTable.ruleCode));
      return rows as never;
    },

    async getLatestRun(matchId) {
      const rows = await selectRows("audit_runs", "match_id = $1 order by run_number desc limit 1", [matchId]);
      return (rows[0] as unknown as RunRow | undefined) ?? null;
    },

    async createRun(row) {
      const inserted = await insertReturning("audit_runs", { ...row, user_id });
      if (!inserted) throw new Error("Could not create audit run");
      return inserted as unknown as RunRow;
    },

    async updateRun(runId, patch) {
      await updateByColumns("audit_runs", "id", runId, patch);
    },

    // --- Run leasing. Concurrency control lives in SQL (lib/db/src/sql/tennis-matrix-
    // audit.sql) exactly as before, so "did I win the lease" stays a single atomic
    // statement rather than a read-then-write this layer could lose a race on.
    async acquireRunLease(runId, owner, leaseMs) {
      return callLeaseFn("claim_audit_run", runId, owner, leaseMs);
    },
    async renewRunLease(runId, owner, leaseMs) {
      return callLeaseFn("renew_audit_run_lease", runId, owner, leaseMs);
    },
    async releaseRunLease(runId, owner) {
      await pool.query(`select public.release_audit_run_lease($1::uuid, $2::text)`, [runId, owner]);
    },

    async list(table: ChildTable, runId) {
      return selectRows(tableNameFor(table), "audit_run_id = $1", [runId]);
    },

    async insert(table: ChildTable, rows) {
      if (!rows.length) return;
      for (let i = 0; i < rows.length; i += 200) {
        await insertMany(tableNameFor(table), rows.slice(i, i + 200).map((r) => ({ ...r, user_id })));
      }
    },

    async update(table: ChildTable, id, patch) {
      await updateByColumns(tableNameFor(table), "id", id, patch);
    },

    async getStages(runId) {
      const rows = await selectRows(
        "audit_stage_runs",
        "audit_run_id = $1",
        [runId],
      );
      return rows as never;
    },

    async setStage(runId, matchId, stage: Stage, patch) {
      const heartbeat_at = patch["heartbeat_at"] ?? new Date().toISOString();
      await upsertStage({
        audit_run_id: runId,
        match_id: matchId,
        stage,
        stage_order: STAGES.indexOf(stage),
        user_id,
        heartbeat_at,
        ...patch,
      });
    },

    async saveIdentityRecords(matchId, rows) {
      if (!rows.length) return;
      const fields = rows.map((r) => String(r["field"]));
      await db
        .delete(matchIdentityRecords)
        .where(and(eq(matchIdentityRecords.matchId, matchId), inArray(matchIdentityRecords.field, fields)));
      await insertMany("match_identity_records", rows.map((r) => ({ ...r, match_id: matchId, user_id })));
    },

    async saveSnapshots(runId, rows) {
      if (!rows.length) return;
      await insertMany("source_snapshots", rows.map((r) => ({ ...r, audit_run_id: runId, user_id })));
    },

    async saveConflicts(runId, rows) {
      if (!rows.length) return;
      await insertMany("source_conflicts", rows.map((r) => ({ ...r, audit_run_id: runId, user_id })));
    },

    async getCalibration(versionId) {
      const versionRows = versionId
        ? await db.select().from(calibrationVersions).where(eq(calibrationVersions.id, versionId)).limit(1)
        : await db
            .select()
            .from(calibrationVersions)
            .where(eq(calibrationVersions.isActive, true))
            .orderBy(desc(calibrationVersions.versionNumber))
            .limit(1);
      const version = versionRows[0];
      if (!version) return { version: null, buckets: [] };
      const buckets = await db
        .select({
          bucket_code: calibrationBuckets.bucketCode,
          wp_min: calibrationBuckets.wpMin,
          wp_max: calibrationBuckets.wpMax,
          wins: calibrationBuckets.wins,
          graded: calibrationBuckets.graded,
        })
        .from(calibrationBuckets)
        .where(eq(calibrationBuckets.calibrationVersionId, version.id))
        .orderBy(asc(calibrationBuckets.wpMin));
      return {
        version: { id: version.id, label: version.label, version_number: Number(version.versionNumber) },
        buckets: buckets.map((b) => ({
          bucket_code: b.bucket_code,
          wp_min: Number(b.wp_min),
          wp_max: Number(b.wp_max),
          wins: Number(b.wins),
          graded: Number(b.graded),
        })),
      };
    },

    async getDecisionId(runId) {
      const rows = await db
        .select({ id: finalDecisions.id })
        .from(finalDecisions)
        .where(eq(finalDecisions.auditRunId, runId))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    // The decision row keeps the same split the Audit already used: the columns the
    // schema actually has, plus everything else folded into gate_report. The
    // deterministic_decision record the engine builds rides inside gate_report, which
    // is what result capture and any future calibration read `selected_player` from.
    async saveDecision(runId, existingId, payload) {
      const extras = {
        final_recommendation: payload["final_recommendation"] ?? null,
        independent_winner: payload["independent_winner"] ?? null,
        independent_range: payload["independent_range"] ?? null,
        calibrated_range: payload["calibrated_range"] ?? null,
        calibration_version_id: payload["calibration_version_id"] ?? null,
        calibration_wins: payload["calibration_wins"] ?? null,
        calibration_graded: payload["calibration_graded"] ?? null,
        green_locked: payload["green_locked"] ?? null,
        green_lock_reasons: payload["green_lock_reasons"] ?? [],
      };
      const persisted: Record<string, unknown> = {
        audit_run_id: runId,
        final_audit_color: payload["final_audit_color"] ?? null,
        final_selection: payload["final_selection"] ?? payload["final_recommendation"] ?? null,
        action: payload["action"] ?? payload["final_recommendation"] ?? null,
        gate_report: {
          ...extras,
          ...(payload["gate_report"] && typeof payload["gate_report"] === "object"
            ? (payload["gate_report"] as Record<string, unknown>)
            : {}),
        },
        completion_percent: payload["completion_percent"] ?? 0,
        audit_complete: payload["audit_complete"] ?? true,
        matrix_firewall_valid: payload["matrix_firewall_valid"] ?? false,
        calibration_bucket: payload["calibration_bucket"] ?? null,
        verified_win_rate: payload["verified_win_rate"] ?? null,
      };
      if (existingId) await updateByColumns("final_decisions", "id", existingId, persisted);
      else await insertMany("final_decisions", [{ ...persisted, user_id }]);
    },

    async getConflicts(runId) {
      const rows = await db
        .select({ critical: sourceConflicts.critical, resolution_status: sourceConflicts.resolutionStatus })
        .from(sourceConflicts)
        .where(eq(sourceConflicts.auditRunId, runId));
      return rows as never;
    },

    async getReconstructions(runId) {
      const rows = await db
        .select({ status: reconstructionResults.status })
        .from(reconstructionResults)
        .where(eq(reconstructionResults.auditRunId, runId));
      return rows as never;
    },

    async saveCoverage(runId, rows) {
      const mapped = rows.map((row) => ({
        audit_run_id: row["audit_run_id"] ?? runId,
        player_side: row["player_side"],
        direct_count: row["direct_count"] ?? row["direct"] ?? 0,
        reconstructed_count: row["reconstructed_count"] ?? row["reconstructed"] ?? 0,
        partial_count: row["partial_count"] ?? row["partial"] ?? 0,
        unavailable_count: row["unavailable_count"] ?? row["unavailable"] ?? 0,
        excluded_count: row["excluded_count"] ?? row["excluded"] ?? 0,
        total_count: row["total_count"] ?? row["total"] ?? 0,
        usable_coverage_percent: row["usable_coverage_percent"] ?? row["usablePercent"] ?? 0,
        execution_completion_percent: row["execution_completion_percent"] ?? row["executionPercent"] ?? 0,
        recorded_at: row["recorded_at"] ?? new Date().toISOString(),
        user_id,
      }));
      await upsertMany("audit_coverage", mapped, ["audit_run_id", "player_side"]);
    },

    async saveCoverageRates(runId, rows) {
      let sourceRows = rows.filter((row) => typeof row["metric_code"] === "string" && String(row["metric_code"]).trim() !== "");
      if (!sourceRows.length) {
        const metrics = await db
          .select({
            metric_code: metricResults.metricCode,
            metric_name: metricResults.metricName,
            p1_treatment: metricResults.p1Treatment,
            p2_treatment: metricResults.p2Treatment,
          })
          .from(metricResults)
          .where(eq(metricResults.auditRunId, runId));
        const usable = (t: unknown) => ["DIRECT", "RECONSTRUCTED", "PARTIAL"].includes(String(t ?? ""));
        sourceRows = metrics.flatMap((metric) => {
          const code = String(metric.metric_code ?? "").trim();
          if (!code) return [];
          return [
            { metric_code: code, metric_name: metric.metric_name ?? code, player_side: "P1", treatment: metric.p1_treatment ?? "UNAVAILABLE", usable: usable(metric.p1_treatment) },
            { metric_code: code, metric_name: metric.metric_name ?? code, player_side: "P2", treatment: metric.p2_treatment ?? "UNAVAILABLE", usable: usable(metric.p2_treatment) },
          ];
        });
      }
      if (!sourceRows.length) return;

      const registryRows = [
        ...new Map(
          sourceRows.map((row) => [
            String(row["metric_code"]),
            {
              metric_code: String(row["metric_code"]),
              metric_name: String(row["metric_name"] ?? row["metric_code"]),
              lifecycle_status: "ACTIVE",
              tour_eligibility: [] as string[],
            },
          ]),
        ).values(),
      ];
      await upsertMany("metric_registry", registryRows, ["metric_code"]);

      const now = new Date().toISOString();
      const coverageRows = sourceRows.map((row) => ({
        metric_code: String(row["metric_code"]),
        player_side: row["player_side"],
        treatment: row["treatment"] ?? "UNAVAILABLE",
        usable: Boolean(row["usable"]),
        recorded_at: row["recorded_at"] ?? now,
        audit_run_id: runId,
        user_id,
      }));
      await upsertMany("metric_coverage_rates", coverageRows, ["metric_code", "player_side", "audit_run_id"]);
    },

    // The closing invariant: the Final Decision stage refuses to report success unless
    // coverage, per-metric rates and the decision row are all genuinely on disk for this
    // run, in the counts the gate computed. Kept verbatim in intent -- an integration is
    // exactly the wrong moment to relax a persistence check.
    async verifyFinalPersistence(runId, expectedMetricSides, expectedAuditComplete) {
      const [coverage, rates, decision] = await Promise.all([
        db.select({ player_side: auditCoverage.playerSide }).from(auditCoverage).where(eq(auditCoverage.auditRunId, runId)),
        db.select({ metric_code: metricCoverageRates.metricCode }).from(metricCoverageRates).where(eq(metricCoverageRates.auditRunId, runId)),
        db.select({ id: finalDecisions.id, audit_complete: finalDecisions.auditComplete }).from(finalDecisions).where(eq(finalDecisions.auditRunId, runId)).limit(1),
      ]);
      if (coverage.length !== 2) {
        throw new Error(`Final persistence invariant failed: expected 2 audit coverage rows, found ${coverage.length}.`);
      }
      if (rates.length !== expectedMetricSides) {
        throw new Error(`Final persistence invariant failed: expected ${expectedMetricSides} metric coverage rows, found ${rates.length}.`);
      }
      if (!decision[0]) {
        throw new Error("Final persistence invariant failed (final_decisions): missing row");
      }
      if (Boolean(decision[0].audit_complete) !== expectedAuditComplete) {
        throw new Error("Final persistence invariant failed: decision completion flag does not match the deterministic gate.");
      }
    },

    async log(entry) {
      await db.insert(executionLogs).values({
        userId: user_id,
        auditRunId: (entry["audit_run_id"] as string) ?? null,
        matchId: (entry["match_id"] as string) ?? null,
        stage: String(entry["stage"]),
        status: String(entry["status"]),
        output: (entry["output"] ?? null) as never,
        matrixVisible: Boolean(entry["matrix_visible"]),
      } as never);
    },
  };
}

// ----------------------------------------------------------------------------
// Row-shaped SQL helpers.
//
// The engine's contract is `Record<string, unknown>` keyed by real column names, so
// these take exactly that and build parameterised statements from it. Every identifier
// is validated against a strict pattern before interpolation (quoteIdent) and every
// value is bound, never inlined -- the keys come from the engine's own patches rather
// than from user input, but a data layer that interpolates identifiers should prove it
// cannot be made to interpolate anything else.
// ----------------------------------------------------------------------------

function tableNameFor(table: ChildTable): string {
  if (!CHILD_TABLES.has(table)) throw new Error(`Unknown child table: ${table}`);
  return table;
}

async function insertMany(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cols = columns.map(quoteIdent).join(", ");
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((c) => {
      params.push(normalize(row[c]));
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await pool.query(`insert into ${quoteIdent(table)} (${cols}) values ${tuples.join(", ")}`, params);
}

async function insertReturning(table: string, row: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const columns = Object.keys(row);
  const params = columns.map((c) => normalize(row[c]));
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `insert into ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) values (${placeholders}) returning *`,
    params,
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function updateByColumns(table: string, keyColumn: string, keyValue: string, patch: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(patch);
  if (!columns.length) return;
  const params: unknown[] = [];
  const assignments = columns.map((c) => {
    params.push(normalize(patch[c]));
    return `${quoteIdent(c)} = $${params.length}`;
  });
  params.push(keyValue);
  await pool.query(
    `update ${quoteIdent(table)} set ${assignments.join(", ")} where ${quoteIdent(keyColumn)} = $${params.length}`,
    params,
  );
}

async function upsertMany(table: string, rows: Array<Record<string, unknown>>, conflictColumns: string[]): Promise<void> {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((c) => {
      params.push(normalize(row[c]));
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const updates = columns
    .filter((c) => !conflictColumns.includes(c))
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
  const onConflict = updates.length
    ? `on conflict (${conflictColumns.map(quoteIdent).join(", ")}) do update set ${updates.join(", ")}`
    : `on conflict (${conflictColumns.map(quoteIdent).join(", ")}) do nothing`;
  await pool.query(
    `insert into ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) values ${tuples.join(", ")} ${onConflict}`,
    params,
  );
}

/** audit_stage_runs is upserted on its (audit_run_id, stage) unique key on every write. */
async function upsertStage(row: Record<string, unknown>): Promise<void> {
  await upsertMany("audit_stage_runs", [row], ["audit_run_id", "stage"]);
}

async function callLeaseFn(fn: "claim_audit_run" | "renew_audit_run_lease", runId: string, owner: string, leaseMs: number): Promise<boolean> {
  const seconds = Math.ceil(leaseMs / 1000);
  const result = await pool.query(`select public.${fn}($1::uuid, $2::text, $3::integer) as claimed`, [runId, owner, seconds]);
  return (result.rows[0] as { claimed: boolean } | undefined)?.claimed === true;
}

/**
 * jsonb columns receive objects/arrays; everything else passes through. `undefined` is
 * normalised to null so an omitted key clears rather than throwing -- the engine builds
 * patches by spreading, and a deleted key means "leave as null", never "leave as-is".
 */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}
