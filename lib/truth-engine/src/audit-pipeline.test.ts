// End-to-end regression test for the Run Audit pipeline.
//
// It drives the real orchestrator with an in-memory data layer and a
// deterministic researcher, standing in for "PDF uploaded -> Run Audit ->
// Final Combination Gate". It FAILS if any audited section ends up 0/0,
// which is the exact defect this pipeline was written to fix.
import { describe, expect, it, vi } from "vitest";
import { claimRetrievalForExecutingSideOnly, metricPairPatch, metricRowsForSideExecution, pass2WriteBackPatch, preserveSettledOppositeSide, preserveUsableCurrentSide, runPipeline, preparePipelineRun, enforceStageDependencies, STAGES, type ChildTable, type PipelineDeps, type Researcher, type RunRow, type Stage } from "./audit-pipeline";
import { compareMetricRows } from "./truth-engine-metric-comparison";
import type { TruthEngineDecisionRecord } from "./truth-engine-decision-record";
import { classifyMetricActivation, classifySideActivation, DENOMINATOR_EXCUSED_STATUSES } from "./metric-activation-status";
import { unmetDependencies, canonicalizeStageRows, INVALIDATED_RUN_STATUS } from "./audit-stages";
import { dispatchAuditBatch } from "./audit-batch";
import { STRESS_TESTS, UNDERDOG_PATHWAYS } from "./constants";
import { MATRIX_SUMMARY_REQUIRED_CODES, META_OR_NON_PLAYER_CODES } from "./metric-classification";
import { ACTIVE_METRIC_CODES } from "./truth-engine-active-metrics";

// Code 070 ("Support Team / Prep") is a genuine LEGITIMATE_PLAYER_METRIC in the real
// canonical registry (metric-classification.ts) -- distinct from and never overlapping
// any real PROTECTED_UNAVAILABLE code. To test the instantiation-time NO_SOURCE wiring
// itself, mock classifyMetric to treat code 070 as PROTECTED_UNAVAILABLE for this test
// file only.
vi.mock("./metric-classification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metric-classification")>();
  return {
    ...actual,
    classifyMetric: (code: string | null | undefined) => {
      const match = String(code ?? "").match(/(\d{1,3})$/);
      const normalized = match ? match[1].padStart(3, "0") : String(code ?? "").padStart(3, "0");
      if (normalized === "070") return "PROTECTED_UNAVAILABLE";
      return actual.classifyMetric(normalized);
    },
  };
});

const MATCH_ID = "11111111-1111-1111-1111-111111111111";
const NOW = "2026-04-12T00:00:00.000Z";
const P1 = "Carlos Alcaraz";
const P2 = "Jannik Sinner";

const DEF_COUNTS = { METRICS: 81, VERIFICATION: 60, DISAGREEMENT: 70 } as const;
// The Truth Engine execution universe is the 25 active codes (ACTIVE_METRIC_CODES)
// plus two narrow, documented exceptions kept instantiated for real downstream
// writers -- see instantiate()'s comment in audit-pipeline.ts. Every OTHER code in
// the 81-code registry (including every genuinely PROTECTED_UNAVAILABLE/quarantined
// one) now gets zero metric_results rows at all, not even a settled NO_SOURCE/
// EXCLUDED placeholder. Derived from the live registry, not hardcoded, so a
// reclassification updates every test that depends on this count with it.
const TRUTH_ENGINE_NON_ACTIVE_EXECUTION_EXCEPTIONS = new Set(["042"]);
const EXPECTED_INSTANTIATED_METRIC_COUNT = new Set([
  ...ACTIVE_METRIC_CODES,
  ...META_OR_NON_PLAYER_CODES,
  ...TRUTH_ENGINE_NON_ACTIVE_EXECUTION_EXCEPTIONS,
]).size;

function defsFor(kind: keyof typeof DEF_COUNTS) {
  const prefix = kind === "METRICS" ? "M" : kind === "VERIFICATION" ? "V" : "D";
  return Array.from({ length: DEF_COUNTS[kind] }, (_, i) => ({
    id: `${prefix}-${i}`,
    rule_code: `${prefix}${String(i + 1).padStart(2, "0")}`,
    rule_name: `${kind} definition ${i + 1}`,
    body: `body ${i + 1}`,
    severity: i % 7 === 0 ? "CRITICAL" : "STANDARD",
    blocking: i % 7 === 0,
  }));
}

const researcher: Researcher = {
  async identity({ p1, p2 }) {
    return {
      player1_canonical: p1,
      player2_canonical: p2,
      player1_status: "VERIFIED",
      player2_status: "VERIFIED",
      tournament: "Test Masters",
      event_level: "ATP 1000",
      round: "QF",
      scheduled_date: "2026-04-12",
      surface: "Hard",
      indoor: false,
      best_of: 3,
      surface_status: "VERIFIED",
      unresolved_reason: null,
      sources: [{ source_name: "atptour.com", url: "https://example.test/match", retrieved_at: null }],
      conflicts: [],
    };
  },
  async metrics({ metrics }) {
    // Realistic, comparable evidence for the metrics the deterministic decision core has a
    // declared comparison spec for (truth-engine-metric-comparison.ts). Without this the
    // fixture emitted bare unlabelled scalars ("50"/"48"), which the decision core correctly
    // refuses to interpret -- so this end-to-end test would only ever have proved that the
    // mock researcher echoed a winner, never that a winner is genuinely DERIVED from
    // evidence. These values give P1 an honest lead across three independent families.
    // Every one of the 25 active COMPARISON_SPECS codes gets a real, spec-matching
    // field=value pair here -- not just the three this fixture originally covered.
    // metricPairPatch now refuses a value that doesn't carry its metric's declared
    // comparison field (see truth-engine-metric-comparison.ts's COMPARISON_SPECS), so a
    // bare placeholder like "52" for one of these codes would be (correctly) downgraded
    // to UNAVAILABLE, which would make this fixture model a broken producer rather than a
    // working one. The 56 inactive codes keep the original bare-placeholder scheme below
    // since they have no declared spec to satisfy.
    const COMPARABLE: Record<string, [string, string]> = {
      "001": ["1900", "1500"], // SURFACE_STRENGTH -> P1
      "002": ["service_point_win_pct=65; service_points=80", "service_point_win_pct=55; service_points=75"],
      "003": ["return_point_win_pct=45; return_points=80", "return_point_win_pct=38; return_points=70"],
      "005": ["last10_win_pct=80", "last10_win_pct=30"], // RECENT_FORM -> P1
      "006": ["bad_loss_rate_pct=10; quality_observed_matches=20", "bad_loss_rate_pct=30; quality_observed_matches=20"],
      "007": ["win_pct=60; ranked_common_opponent_matches=15", "win_pct=40; ranked_common_opponent_matches=15"],
      "008": ["set3_deciding_set_win_pct=70", "set3_deciding_set_win_pct=30"],
      "009": ["pressure_win_pct=65; pressure_points=20", "pressure_win_pct=45; pressure_points=20"],
      "010": ["straight_set_match_win_pct=80", "straight_set_match_win_pct=40"],
      "011": ["match_win_pct=60", "match_win_pct=40"],
      "016": ["score_state_break_point_win_pct=55; score_state_break_point_n=12", "score_state_break_point_win_pct=45; score_state_break_point_n=12"],
      "018": ["breakback_rate_pct=30; breakback_opportunities=12", "breakback_rate_pct=10; breakback_opportunities=12"],
      "027": ["lead_protection_rate_pct=90", "lead_protection_rate_pct=40"], // CLOSING_ABILITY -> P1
      "029": ["after_close_set_loss_match_win_pct=50; baseline_match_win_rate_pct=55; after_close_set_loss_n=10", "after_close_set_loss_match_win_pct=20; baseline_match_win_rate_pct=55; after_close_set_loss_n=10"],
      "031": ["opponent_adjusted_set_differential=0.5", "opponent_adjusted_set_differential=-0.2"],
      "032": ["bp_converted_pct=45; break_chances=12", "bp_converted_pct=35; break_chances=12"],
      "034": ["dominance_ratio=1.1; total_points_played=100", "dominance_ratio=0.9; total_points_played=100"],
      "036": ["favorite_losses_rate_pct=10; trailing_losses_used=15", "favorite_losses_rate_pct=30; trailing_losses_used=15"],
      "041": ["recent_elo_adjusted_surplus=0.3; earlier_elo_adjusted_surplus=0.1", "recent_elo_adjusted_surplus=0.1; earlier_elo_adjusted_surplus=0.2"],
      "045": ["forced_deciding_set_win_pct=60; forced_deciding_set_n=10", "forced_deciding_set_win_pct=40; forced_deciding_set_n=10"],
      "051": ["shrunk_win_probability_pct=60", "shrunk_win_probability_pct=40"],
      "053": ["pressure_index_pct=55; pressure_points=20", "pressure_index_pct=45; pressure_points=20"],
      "055": ["elo_change_last10=15", "elo_change_last10=5"],
      "068": ["current_streak_signed=3; season_matches=10", "current_streak_signed=-2; season_matches=10"],
      "080": ["favorable_divergent_outcomes=10; unfavorable_divergent_outcomes=4", "favorable_divergent_outcomes=4; unfavorable_divergent_outcomes=8"],
    };
    return metrics.map((m, i) => {
      const normalized = String(m.code).match(/(\d{1,3})$/)?.[1]?.padStart(3, "0") ?? "";
      const comparable = COMPARABLE[normalized];
      return {
      metric_code: m.code,
      p1_value: comparable ? comparable[0] : `${50 + i}`,
      p2_value: comparable ? comparable[1] : `${48 + i}`,
      p1_treatment: "DIRECT" as const,
      p2_treatment: i % 9 === 0 ? ("RECONSTRUCTED" as const) : ("DIRECT" as const),
      differential: "+2",
      evidence_family: `FAM${i % 8}`,
      reliability: 0.85,
      sample: "last 12 matches",
      unavailable_reason: null,
      sources: [{ source_name: "tennisabstract.com", url: "https://example.test/stat", retrieved_at: null }],
      };
    });
  },
  async rules({ rules }) {
    return rules.map((r, i) => ({
      rule_code: r.code,
      p1_finding: "no issue found",
      p2_finding: "no issue found",
      outcome: i % 11 === 0 ? ("WARN" as const) : ("PASS" as const),
      severity: (r.severity === "CRITICAL" ? "CRITICAL" : "STANDARD") as "CRITICAL" | "STANDARD",
      decision_effect: "none",
      contradiction_severity: i % 11 === 0 ? ("MINOR" as const) : ("NONE" as const),
      supporting_evidence: "independent evidence",
      opposing_evidence: null,
      final_effect: "no change",
      sources: [{ source_name: "atptour.com", url: "https://example.test/rule", retrieved_at: null }],
    }));
  },
  async underdog({ pathways }) {
    return pathways.map((p, i) => ({
      pathway_code: p.code,
      player_side: P2,
      classification: i % 5 === 0 ? ("REALISTIC" as const) : ("WEAK" as const),
      evidence: "pre-match evidence",
      repeatable: i % 5 === 0,
      unavailable_reason: null,
    }));
  },
  async conclusion() {
    return { winner: P1, low: 58, high: 66, rationale: "independent evidence lean", insufficient_reason: null };
  },
  async stress({ tests }) {
    return tests.map((t) => ({
      test_code: t.code,
      winner_after: P1,
      range_after: "57-65",
      outcome: "STABLE" as const,
      note: "conclusion holds",
    }));
  },
};

function makeMemoryDeps(): { deps: PipelineDeps; tables: Record<string, Array<Record<string, unknown>>>; stages: Map<string, Record<string, unknown>> } {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    metric_results: [],
    verification_results: [],
    disagreement_results: [],
    underdog_results: [],
    stress_results: [],
    // The dossier-reconstruction pass genuinely inserts here whenever a catalogued
    // statistic is extracted (audit-pipeline.ts's executeMetrics). Absent from this
    // fixture, that insert crashed the P1 stage instead of exercising the path.
    reconstruction_results: [],
  };
  const stages = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const match: Record<string, unknown> = {
    id: MATCH_ID,
    player1_name: P1,
    player2_name: P2,
    tournament_name: null,
    event_level: null,
    round: null,
    scheduled_date: null,
    surface: null,
    indoor: null,
    best_of: null,
    identity_status: "UNVERIFIED",
    surface_status: "UNVERIFIED",
    match_status: "PENDING",
  };
  let run: RunRow | null = null;
  let decisionId: string | null = null;
  const decisions: Array<Record<string, unknown>> = [];

  const deps: PipelineDeps = {
    now: () => new Date("2026-04-11T10:00:00Z"),
    research: researcher,
    async getMatch() {
      return match as never;
    },
    async updateMatch(_id, patch) {
      Object.assign(match, patch);
    },
    async getParsedFields() {
      return { matrix_predicted_winner: P1, matrix_wp: "62" };
    },
    async getActiveVersionId(docType) {
      return `v-${docType}`;
    },
    async getRules(versionId) {
      const kind = versionId.replace("v-", "") as keyof typeof DEF_COUNTS;
      return DEF_COUNTS[kind] ? (defsFor(kind) as never) : [];
    },
    async getLatestRun() {
      return run;
    },
    async createRun(row) {
      run = {
        id: "run-1",
        run_number: 1,
        status: "RUNNING",
        research_lock_at: null,
        independent_decision_committed_at: null,
        matrix_revealed_at: null,
        independent_winner: null,
        independent_low: null,
        independent_high: null,
        calibrated_low: null,
        calibrated_high: null,
        calibration_version_id: null,
        effective_evidence_count: 0,
        metrics_version_id: null,
        verification_version_id: null,
        disagreement_version_id: null,
        ...(row as object),
      } as RunRow;
      return run;
    },
    async updateRun(_id, patch) {
      if (run) run = { ...run, ...(patch as object) } as RunRow;
    },
    async list(table: ChildTable) {
      return tables[table]!.map((r) => ({ ...r }));
    },
    async insert(table: ChildTable, rows) {
      for (const r of rows) {
        seq += 1;
        tables[table]!.push({ id: `${table}-${seq}`, ...r });
      }
    },
    async update(table: ChildTable, id, patch) {
      const row = tables[table]!.find((r) => r["id"] === id);
      if (!row) throw new Error(`row ${id} missing in ${table}`);
      Object.assign(row, patch);
    },
    async getStages() {
      return Array.from(stages.values()) as never;
    },
    async setStage(_runId, _matchId, stage, patch) {
      stages.set(stage, {
        stage,
        status: "PENDING",
        attempts: 0,
        error_message: null,
        done_count: 0,
        total_count: 0,
        ...(stages.get(stage) ?? {}),
        ...patch,
      });
    },
    async saveIdentityRecords() {},
    async saveSnapshots() {},
    async saveConflicts() {},
    async getCalibration() {
      return {
        version: { id: "cal-1", label: "CAL v1", version_number: 1 },
        buckets: [
          { bucket_code: "50-59", wp_min: 50, wp_max: 59.99, wins: 20, graded: 34 },
          { bucket_code: "60-69", wp_min: 60, wp_max: 69.99, wins: 41, graded: 60 },
          { bucket_code: "70-79", wp_min: 70, wp_max: 79.99, wins: 33, graded: 42 },
        ],
      };
    },
    async getDecisionId() {
      return decisionId;
    },
    async saveDecision(_runId, existingId, payload) {
      if (existingId) {
        const row = decisions.find((d) => d["id"] === existingId);
        Object.assign(row!, payload);
      } else {
        decisionId = "decision-1";
        decisions.push({ id: decisionId, ...payload });
      }
    },
    async getConflicts() {
      return [];
    },
    async getReconstructions() {
      return tables["metric_results"]!.filter((m) => m["treatment"] === "RECONSTRUCTED").map(() => ({ status: "COMPLETE" }));
    },
    async saveCoverage() {},
    async saveCoverageRates() {},
    async log() {},
  };

  return { deps, tables, stages };
}

// makeMemoryDeps above is single-run only (createRun hardcodes id "run-1",
// list()/getStages() ignore the runId argument entirely) -- fine for every
// existing test, since none of them ever create a second run in the same
// deps instance, but it can't prove cross-run isolation because it has no
// notion of more than one run. makeMultiRunMemoryDeps is a separate,
// properly run-scoped mock -- every table row and stage record is keyed by
// the SAME audit_run_id the real repository scopes by -- built
// specifically for the Clear Slate regression test below, without touching
// (or risking) the ~15 existing tests that rely on makeMemoryDeps's shape.
function makeMultiRunMemoryDeps(): {
  deps: PipelineDeps;
  runsById: Map<string, RunRow>;
  stagesByRun: Map<string, Map<string, Record<string, unknown>>>;
  tablesByRun: Map<string, Record<ChildTable, Array<Record<string, unknown>>>>;
} {
  const match: Record<string, unknown> = {
    id: MATCH_ID,
    player1_name: P1,
    player2_name: P2,
    tournament_name: null,
    event_level: null,
    round: null,
    scheduled_date: null,
    surface: null,
    indoor: null,
    best_of: null,
    identity_status: "UNVERIFIED",
    surface_status: "UNVERIFIED",
    match_status: "PENDING",
  };
  let runSeq = 0, rowSeq = 0;
  const runsById = new Map<string, RunRow>();
  const stagesByRun = new Map<string, Map<string, Record<string, unknown>>>();
  const tablesByRun = new Map<string, Record<ChildTable, Array<Record<string, unknown>>>>();
  const decisionsByRun = new Map<string, Record<string, unknown>>();

  const emptyTables = (): Record<ChildTable, Array<Record<string, unknown>>> => ({
    metric_results: [],
    reconstruction_results: [],
    verification_results: [],
    disagreement_results: [],
    underdog_results: [],
    stress_results: [],
  });
  const tablesFor = (runId: string) => {
    let t = tablesByRun.get(runId);
    if (!t) { t = emptyTables(); tablesByRun.set(runId, t); }
    return t;
  };
  const stagesFor = (runId: string) => {
    let m = stagesByRun.get(runId);
    if (!m) { m = new Map(); stagesByRun.set(runId, m); }
    return m;
  };

  const deps: PipelineDeps = {
    now: () => new Date("2026-04-11T10:00:00Z"),
    research: researcher,
    async getMatch() { return match as never; },
    async updateMatch(_id, patch) { Object.assign(match, patch); },
    async getParsedFields() { return { matrix_predicted_winner: P1, matrix_wp: "62" }; },
    async getActiveVersionId(docType) { return `v-${docType}`; },
    async getRules(versionId) {
      const kind = versionId.replace("v-", "") as keyof typeof DEF_COUNTS;
      return DEF_COUNTS[kind] ? (defsFor(kind) as never) : [];
    },
    async getLatestRun() {
      const all = [...runsById.values()];
      if (!all.length) return null;
      return all.reduce((a, b) => (a.run_number > b.run_number ? a : b));
    },
    async createRun(row) {
      runSeq += 1;
      const newRun: RunRow = {
        id: `run-${runSeq}`,
        run_number: 1,
        status: "RUNNING",
        research_lock_at: null,
        independent_decision_committed_at: null,
        matrix_revealed_at: null,
        independent_winner: null,
        independent_low: null,
        independent_high: null,
        calibrated_low: null,
        calibrated_high: null,
        calibration_version_id: null,
        effective_evidence_count: 0,
        metrics_version_id: null,
        verification_version_id: null,
        disagreement_version_id: null,
        ...(row as object),
      } as RunRow;
      runsById.set(newRun.id, newRun);
      return newRun;
    },
    async updateRun(id, patch) {
      const existing = runsById.get(id);
      if (existing) runsById.set(id, { ...existing, ...(patch as object) } as RunRow);
    },
    async list(table, runId) { return tablesFor(runId)[table].map((r) => ({ ...r })); },
    async insert(table, rows) {
      for (const r of rows) {
        rowSeq += 1;
        const runId = String(r["audit_run_id"]);
        tablesFor(runId)[table].push({ id: `${table}-${rowSeq}`, ...r });
      }
    },
    async update(table, id, patch) {
      for (const t of tablesByRun.values()) {
        const row = t[table].find((r) => r["id"] === id);
        if (row) { Object.assign(row, patch); return; }
      }
      throw new Error(`row ${id} missing in ${table}`);
    },
    async getStages(runId) { return Array.from(stagesFor(runId).values()) as never; },
    async setStage(runId, _matchId, stage, patch) {
      const m = stagesFor(runId);
      m.set(stage, {
        stage,
        status: "PENDING",
        attempts: 0,
        error_message: null,
        done_count: 0,
        total_count: 0,
        ...(m.get(stage) ?? {}),
        ...patch,
      });
    },
    async saveIdentityRecords() {},
    async saveSnapshots() {},
    async saveConflicts() {},
    async getCalibration() {
      return {
        version: { id: "cal-1", label: "CAL v1", version_number: 1 },
        buckets: [
          { bucket_code: "50-59", wp_min: 50, wp_max: 59.99, wins: 20, graded: 34 },
          { bucket_code: "60-69", wp_min: 60, wp_max: 69.99, wins: 41, graded: 60 },
          { bucket_code: "70-79", wp_min: 70, wp_max: 79.99, wins: 33, graded: 42 },
        ],
      };
    },
    async getDecisionId(runId) { return (decisionsByRun.get(runId)?.["id"] as string) ?? null; },
    async saveDecision(runId, existingId, payload) {
      if (existingId) {
        const row = decisionsByRun.get(runId);
        if (row) Object.assign(row, payload);
      } else {
        decisionsByRun.set(runId, { id: `decision-${runId}`, audit_run_id: runId, ...payload });
      }
    },
    async getConflicts() { return []; },
    async getReconstructions(runId) {
      return tablesFor(runId).metric_results.filter((m) => m["treatment"] === "RECONSTRUCTED").map(() => ({ status: "COMPLETE" }));
    },
    async saveCoverage() {},
    async saveCoverageRates() {},
    async log() {},
  };

  return { deps, runsById, stagesByRun, tablesByRun };
}

describe("Run Audit pipeline", () => {
  it("keeps mixed-availability diagnostics on the unavailable side only", () => {
    const patch = metricPairPatch({
      metric_code: "001", p1_value: "72", p2_value: null,
      p1_treatment: "DIRECT", p2_treatment: "UNAVAILABLE",
      differential: null, evidence_family: "RANKING", reliability: .9, sample: "current",
      unavailable_reason: null, p2_unavailable_reason: "Player 2 ranking was not found.",
      sources: [{ source_name: "official rankings" }],
    }, null, "2026-04-11T10:00:00Z");
    expect(patch.p1_unavailable_reason).toBeNull();
    expect(patch.p2_unavailable_reason).toBe("PLAYER_NOT_FOUND");
    expect(patch.unavailable_detail).toBe("P1: usable | P2: Player 2 ranking was not found.");
  });

  // Live-DB finding (Erhard/Shepp, run ffb59d1d-...): metric 008 ("Deciding-set win %")
  // persisted a bare "11"/"2" under a self-claimed DIRECT treatment -- a raw count from
  // the wrong field (deciding_sets_won or similar), never the labelled
  // set3_deciding_set_win_pct/deciding_set_win_pct percentage COMPARISON_SPECS requires.
  // metricPairPatch must refuse to let that masquerade as usable evidence.
  it("downgrades a value that doesn't carry its metric's declared comparison field to UNAVAILABLE", () => {
    const patch = metricPairPatch({
      metric_code: "008", p1_value: "11", p2_value: "2",
      p1_treatment: "DIRECT", p2_treatment: "DIRECT",
      differential: null, evidence_family: "SET_PROFILE", reliability: .8, sample: "11 matches",
      unavailable_reason: null,
      sources: [{ source_name: "PredixSport public tennis ratings (CC BY 4.0)" }],
    }, null, "2026-09-05T05:35:31.017Z");
    expect(patch.p1_value).toBeNull();
    expect(patch.p2_value).toBeNull();
    expect(patch.p1_treatment).toBe("UNAVAILABLE");
    expect(patch.p2_treatment).toBe("UNAVAILABLE");
    expect(patch.p1_unavailable_reason).toBe("MISSING_REQUIRED_INPUT");
  });

  it("keeps a value that carries its metric's declared field (by alias) usable", () => {
    const patch = metricPairPatch({
      metric_code: "008", p1_value: "deciding_set_win_pct=66.67; deciding_matches_played=3", p2_value: "deciding_set_win_pct=0; deciding_matches_played=1",
      p1_treatment: "PARTIAL", p2_treatment: "PARTIAL",
      differential: null, evidence_family: "SET_PROFILE", reliability: .85, sample: "3 matches | 1 matches",
      unavailable_reason: null,
      sources: [{ source_name: "PredixSport public tennis ratings (CC BY 4.0)" }],
    }, null, "2026-09-05T05:35:31.017Z");
    expect(patch.p1_value).toBe("deciding_set_win_pct=66.67; deciding_matches_played=3");
    expect(patch.p2_value).toBe("deciding_set_win_pct=0; deciding_matches_played=1");
    expect(patch.p1_treatment).toBe("PARTIAL");
    expect(patch.p2_treatment).toBe("PARTIAL");
  });

  it("still accepts metric 001's bare-scalar Elo (an approved bareScalarFallback)", () => {
    const patch = metricPairPatch({
      metric_code: "001", p1_value: "1521.75", p2_value: "1487.74",
      p1_treatment: "DIRECT", p2_treatment: "DIRECT",
      differential: null, evidence_family: "SURFACE_STRENGTH", reliability: .9, sample: null,
      unavailable_reason: null,
      sources: [{ source_name: "PredixSport public tennis ratings (CC BY 4.0)" }],
    }, null, "2026-09-05T05:35:17.626Z");
    expect(patch.p1_value).toBe("1521.75");
    expect(patch.p2_value).toBe("1487.74");
    expect(patch.p1_treatment).toBe("DIRECT");
    expect(patch.p2_treatment).toBe("DIRECT");
  });

  it("does not validate against a comparison spec for a code outside the 25 active metrics", () => {
    // Code 099 has no COMPARISON_SPECS entry -- the 56 inactive metrics' own producer
    // output must be left exactly as before; this check only applies to the 25 active codes.
    const patch = metricPairPatch({
      metric_code: "099", p1_value: "some_unrelated_field=42", p2_value: "some_unrelated_field=7",
      p1_treatment: "DIRECT", p2_treatment: "DIRECT",
      differential: null, evidence_family: null, reliability: null, sample: null,
      unavailable_reason: null, sources: [],
    }, null, "2026-09-05T05:35:31.017Z");
    expect(patch.p1_value).toBe("some_unrelated_field=42");
    expect(patch.p2_value).toBe("some_unrelated_field=7");
    expect(patch.p1_treatment).toBe("DIRECT");
    expect(patch.p2_treatment).toBe("DIRECT");
  });

  it("does not overwrite a settled opposite side when resuming a legacy one-sided run", () => {
    const patch = preserveSettledOppositeSide(metricPairPatch(undefined, "provider timeout", "2026-04-11T10:00:00Z"), {
      p1_status: "COMPLETE", p1_value: "72", p1_treatment: "DIRECT",
      p2_status: "NOT STARTED",
    }, "p2");
    expect(patch).not.toHaveProperty("p1_value");
    expect(patch).not.toHaveProperty("p1_treatment");
    expect(patch).not.toHaveProperty("p1_unavailable_reason");
    expect(patch.p2_status).toBe("UNAVAILABLE");
    expect(patch.status).toBe("COMPLETE");
  });

  it("persists both independently oriented metric sides from one paired research pass", async () => {
    const { deps, tables } = makeMemoryDeps();
    const metrics = vi.fn(researcher.metrics);
    deps.research = { ...researcher, metrics };

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });

    expect(result.complete).toBe(true);
    const executed = tables.metric_results.filter(row => !["EXCLUDED", "NO_SOURCE"].includes(String(row["p1_status"]))).length;
    expect(metrics).toHaveBeenCalledTimes(Math.ceil(executed / 15) * 2);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ researchSide: "p1", researchPlayer: P1, researchOpponent: P2 }));
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ researchSide: "p2", researchPlayer: P2, researchOpponent: P1 }));
    for (const row of tables.metric_results) {
      if (row["p1_status"] === "EXCLUDED" || row["p1_status"] === "NO_SOURCE") continue;
      expect(row["p1_value"]).not.toBeNull();
      expect(row["p2_value"]).not.toBeNull();
      expect(row["p1_status"]).toBe("COMPLETE");
      expect(row["p2_status"]).toBe("COMPLETE");
    }
  });

  it("still runs each player's reconstruction pass after paired research settles both statuses", async () => {
    const { deps } = makeMemoryDeps();
    const extractStats = vi.fn(async ({ player }: { player: string }) => [{
      key: "surface_strength", value: player === P1 ? 71 : 69, player,
      origin: "RECONSTRUCTED" as const, surface: null, window: null,
      sources: [{ source_name: "paired history" }],
    }]);
    deps.research = { ...researcher, extractStats };

    await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });

    expect(extractStats).toHaveBeenCalledWith(expect.objectContaining({ player: P1 }));
    expect(extractStats).toHaveBeenCalledWith(expect.objectContaining({ player: P2 }));
  });

  it("independently executes P2 source selection for metrics 002 and 003 after P1 settles P2", async () => {
    const { deps, tables } = makeMemoryDeps();
    const calls: Array<{ side: string | undefined; player: string | undefined; opponent: string | undefined; codes: string[] }> = [];
    deps.research = {
      ...researcher,
      async metrics(input) {
        calls.push({
          side: input.researchSide,
          player: input.researchPlayer,
          opponent: input.researchOpponent,
          codes: input.metrics.map(metric => metric.code),
        });
        // Real, spec-matching field names (service_point_win_pct for 002,
        // return_point_win_pct for 003 -- see COMPARISON_SPECS) with a real numeric value,
        // so this fixture models a genuine producer answer, not a placeholder metricPairPatch
        // would now (correctly) reject as not carrying the field the Truth Engine comparison
        // requires.
        const spec: Record<string, { field: string; p1: number; p2: number }> = {
          M02: { field: "service_point_win_pct", p1: 65, p2: 45 },
          M03: { field: "return_point_win_pct", p1: 55, p2: 35 },
        };
        return input.metrics.map(metric => {
          const targeted = spec[metric.code];
          if (input.researchSide === "p1") {
            return {
              metric_code: metric.code,
              p1_value: targeted ? `${targeted.field}=${targeted.p1}` : null,
              p2_value: null,
              p1_treatment: targeted ? "DIRECT" as const : "UNAVAILABLE" as const,
              p2_treatment: "UNAVAILABLE" as const,
              differential: null,
              evidence_family: targeted ? "PBP_SCORE_STATE" : null,
              reliability: targeted ? .9 : null,
              sample: targeted ? "P1-oriented history" : null,
              unavailable_reason: "P2 not found by P1-oriented selection",
              sources: targeted ? [{ source_name: "p1-oriented-pbp" }] : [],
            };
          }
          return {
            metric_code: metric.code,
            p1_value: null,
            p2_value: targeted ? `${targeted.field}=${targeted.p2}` : null,
            p1_treatment: "UNAVAILABLE" as const,
            p2_treatment: targeted ? "DIRECT" as const : "UNAVAILABLE" as const,
            differential: null,
            evidence_family: targeted ? "PBP_SCORE_STATE" : null,
            reliability: targeted ? .88 : null,
            sample: targeted ? "P2-oriented history" : null,
            unavailable_reason: targeted ? null : "No source found",
            sources: targeted ? [{ source_name: "p2-oriented-pbp" }] : [],
          };
        });
      },
    };

    await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });

    const expected: Record<string, { field: string; p1: number; p2: number }> = {
      M02: { field: "service_point_win_pct", p1: 65, p2: 45 },
      M03: { field: "return_point_win_pct", p1: 55, p2: 35 },
    };
    for (const code of ["M02", "M03"]) {
      expect(calls.some(call => call.side === "p1" && call.player === P1 && call.opponent === P2 && call.codes.includes(code))).toBe(true);
      expect(calls.some(call => call.side === "p2" && call.player === P2 && call.opponent === P1 && call.codes.includes(code))).toBe(true);
      const row = tables.metric_results.find(metric => metric.metric_code === code)!;
      expect(row.p1_value).toBe(`${expected[code].field}=${expected[code].p1}`);
      expect(row.p2_value).toBe(`${expected[code].field}=${expected[code].p2}`);
      expect(row.p1_treatment).toBe("DIRECT");
      expect(row.p2_treatment).toBe("DIRECT");
      expect(row.p1_unavailable_reason).toBeNull();
      expect(row.p2_unavailable_reason).toBeNull();
      expect(row.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_name: "p1-oriented-pbp" }),
        expect.objectContaining({ source_name: "p2-oriented-pbp" }),
      ]));
    }
  });

  // ---- RESUME SYMMETRY ---------------------------------------------------------------
  // The P2 stage used to resume from a POSITIONAL cursor -- slice(done_count) into a sorted
  // array -- while P1 resumed from persisted per-row state. Position is not identity: any
  // change in the row set or its ordering between two slices moves the window and skips P2
  // rows for good. These tests pin the replacement's order-independence.
  //
  // Scope note: a read-only production check found 1,500 of 1,500 active metric-sides had
  // p2_retrieved_at strictly later than p1_retrieved_at, so the cursor demonstrably skipped
  // nothing in those 60 runs -- the 97-vs-25 one-sided gap the gap audit measured has a
  // different, producer-coverage cause. What is fixed here is the fragility and the
  // provenance falsehood, not that gap.
  const P1_PASS = "2026-04-12T10:00:00.000Z";
  const P2_PASS = "2026-04-12T11:00:00.000Z";
  /**
   * A row as it looks after each stage of the real write sequence.
   *
   * The P1 stage writes P2's VALUE from the paired finding but no longer stamps
   * p2_retrieved_at (claimRetrievalForExecutingSideOnly), so `${side}_retrieved_at` means
   * exactly "researched with this side as the subject". That is a presence check, not a
   * timestamp comparison -- an earlier draft compared the two stamps and would have broken
   * whenever both writes landed in the same millisecond.
   */
  const rowAfter = (id: string, phase: "fresh" | "p1" | "p2") => ({
    id, metric_code: `M9${id.padStart(2, "0")}`,
    p1_status: phase === "fresh" ? "NOT STARTED" : "COMPLETE",
    p2_status: phase === "fresh" ? "NOT STARTED" : "COMPLETE",
    p1_retrieved_at: phase === "fresh" ? null : P1_PASS,
    p2_retrieved_at: phase === "p2" ? P2_PASS : null,
  });
  const pendingIds = (rows: Array<Record<string, unknown>>, side: "p1" | "p2") =>
    metricRowsForSideExecution(rows, side).pending.map((row) => String(row["id"])).sort();

  it("P1 interrupted then resumed picks up exactly the untreated rows", () => {
    const rows = [rowAfter("01", "p1"), rowAfter("02", "fresh"), rowAfter("03", "p1"), rowAfter("04", "fresh")];
    expect(pendingIds(rows, "p1")).toEqual(["02", "04"]);
  });

  it("P2 interrupted then resumed picks up exactly the rows not yet researched with P2 as the subject", () => {
    // 01/03 already got their own P2-oriented pass; 02/04 still hold only what P1's paired
    // pass left on them, which is not P2's independently obtained evidence.
    const rows = [rowAfter("01", "p2"), rowAfter("02", "p1"), rowAfter("03", "p2"), rowAfter("04", "p1")];
    expect(pendingIds(rows, "p2")).toEqual(["02", "04"]);
  });

  it("both sides interrupted resume independently and without interfering", () => {
    const rows = [rowAfter("01", "p2"), rowAfter("02", "p1"), rowAfter("03", "fresh")];
    expect(pendingIds(rows, "p1")).toEqual(["03"]);
    expect(pendingIds(rows, "p2")).toEqual(["02", "03"]);
  });

  it("resume is driven by row identity, not array position -- reordering skips nothing", () => {
    // THE REGRESSION. The positional cursor read slice(done_count) off a sorted array, so a
    // different ordering (or a changed row count) between slices moved the window and
    // silently dropped rows. Identity-based resume returns the same set either way.
    const rows = [rowAfter("01", "p2"), rowAfter("02", "p1"), rowAfter("03", "p2"), rowAfter("04", "p1")];
    expect(pendingIds([...rows].reverse(), "p2")).toEqual(pendingIds(rows, "p2"));
    expect(pendingIds(rows, "p2")).toEqual(["02", "04"]);
    // ...and a row appearing mid-stage does not push another out of the window.
    expect(pendingIds([...rows, rowAfter("05", "fresh")], "p2")).toEqual(["02", "04", "05"]);
  });

  it("repeated resume is idempotent and never re-offers an already-treated row", () => {
    const rows = [rowAfter("01", "p2"), rowAfter("02", "p2")];
    for (let resume = 0; resume < 3; resume++) {
      expect(pendingIds(rows, "p1")).toEqual([]);
      expect(pendingIds(rows, "p2")).toEqual([]);
    }
  });

  it("a fully fresh run offers every row to BOTH sides -- no side starts already 'done'", () => {
    const rows = [rowAfter("01", "fresh"), rowAfter("02", "fresh"), rowAfter("03", "fresh")];
    expect(pendingIds(rows, "p1")).toEqual(["01", "02", "03"]);
    expect(pendingIds(rows, "p2")).toEqual(["01", "02", "03"]);
  });

  it("a settled EXCLUDED/NO_SOURCE side is withheld from research identically on both sides", () => {
    const settled = (side: "p1" | "p2", status: string) => ({
      ...rowAfter("07", "fresh"), [`${side}_status`]: status,
    });
    for (const status of ["EXCLUDED", "NO_SOURCE"]) {
      expect(pendingIds([settled("p1", status)], "p1")).toEqual([]);
      expect(pendingIds([settled("p2", status)], "p2")).toEqual([]);
    }
  });

  it("preserving a better prior value still records that the side was re-attempted", () => {
    // Without this the P2 marker could never advance for a row whose independent retry
    // found nothing, and the stage would re-research it on every single resume.
    const row = { p2_value: "shrunk_win_probability_pct=68", p2_treatment: "DIRECT", p2_status: "COMPLETE", p2_retrieved_at: null };
    const patch = preserveUsableCurrentSide({ p2_value: null, p2_treatment: "UNAVAILABLE", p2_retrieved_at: P2_PASS }, row, "p2");
    expect(patch["p2_value"]).toBeUndefined();      // the good value is kept
    expect(patch["p2_retrieved_at"]).toBe(P2_PASS); // the attempt is still recorded
  });

  it("a P1-oriented pass never claims to have retrieved P2's side (and vice versa)", () => {
    // The paired finding legitimately carries both players' values, but only one side was
    // actually researched. Stamping the other side's retrieval is what erased the P2 stage's
    // only record of its own work and forced the positional cursor.
    const p1Pass = claimRetrievalForExecutingSideOnly({ p1_value: "a", p2_value: "b", p1_retrieved_at: P1_PASS, p2_retrieved_at: P1_PASS }, "p1");
    expect(p1Pass["p1_retrieved_at"]).toBe(P1_PASS);
    expect(p1Pass["p2_retrieved_at"]).toBeUndefined();
    expect(p1Pass["p2_value"]).toBe("b"); // the value still lands; only the claim is withheld
    const p2Pass = claimRetrievalForExecutingSideOnly({ p1_value: "a", p2_value: "b", p1_retrieved_at: P2_PASS, p2_retrieved_at: P2_PASS }, "p2");
    expect(p2Pass["p2_retrieved_at"]).toBe(P2_PASS);
    expect(p2Pass["p1_retrieved_at"]).toBeUndefined();
  });

  it("keeps prior usable P2 evidence when its independent retry genuinely finds no source", () => {
    const row = { p2_value: "68%", p2_treatment: "DIRECT", p2_status: "COMPLETE" };
    const failed = metricPairPatch({
      metric_code: "M02",
      p1_value: null,
      p2_value: null,
      p1_treatment: "UNAVAILABLE",
      p2_treatment: "UNAVAILABLE",
      differential: null,
      evidence_family: null,
      reliability: null,
      sample: null,
      unavailable_reason: "No P2 source found",
      sources: [],
    }, null, "2026-08-30T00:00:00.000Z");
    const preserved = preserveUsableCurrentSide(failed, row, "p2");
    expect(preserved.p2_value).toBeUndefined();
    expect(preserved.p2_treatment).toBeUndefined();
    expect(preserved.p2_unavailable_reason).toBeUndefined();
    expect(preserved.status).toBe("COMPLETE");
  });

  it("leaves P2 unavailable when both independent orientations find no P2 evidence", async () => {
    const { deps, tables } = makeMemoryDeps();
    deps.research = {
      ...researcher,
      async metrics(input) {
        return input.metrics.map(metric => ({
          metric_code: metric.code,
          p1_value: input.researchSide === "p1" && metric.code === "M02" ? "service_point_win_pct=74" : null,
          p2_value: null,
          p1_treatment: input.researchSide === "p1" && metric.code === "M02" ? "DIRECT" as const : "UNAVAILABLE" as const,
          p2_treatment: "UNAVAILABLE" as const,
          differential: null,
          evidence_family: metric.code === "M02" ? "PBP_SCORE_STATE" : null,
          reliability: metric.code === "M02" ? .9 : null,
          sample: metric.code === "M02" ? "P1-only history" : null,
          unavailable_reason: "No P2 source found",
          sources: metric.code === "M02" ? [{ source_name: "p1-only-pbp" }] : [],
        }));
      },
    };
    await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });
    const row = tables.metric_results.find(metric => metric.metric_code === "M02")!;
    expect(row.p1_value).toBe("service_point_win_pct=74");
    expect(row.p1_treatment).toBe("DIRECT");
    expect(row.p2_value).toBeNull();
    expect(row.p2_treatment).toBe("UNAVAILABLE");
    expect(row.p2_unavailable_reason).toBe("NO_SOURCE_FOUND");
  });

  it("retries a transient PROVIDER_TIMEOUT failure and succeeds on a second attempt, bounded and logged", async () => {
    const { deps, tables } = makeMemoryDeps();
    let attempts = 0;
    const logCalls: Array<Record<string, unknown>> = [];
    deps.log = async (entry) => { logCalls.push(entry); };
    deps.research = {
      ...researcher,
      async metrics(input) {
        return input.metrics.map(metric => {
          if (metric.code !== "M02" || input.researchSide !== "p1") {
            return {
              metric_code: metric.code, p1_value: "50", p2_value: "48",
              p1_treatment: "DIRECT" as const, p2_treatment: "DIRECT" as const,
              differential: null, evidence_family: "FAM", reliability: .85, sample: "s",
              unavailable_reason: null, sources: [],
            };
          }
          attempts += 1;
          if (attempts === 1) {
            return {
              metric_code: metric.code, p1_value: null, p2_value: null,
              p1_treatment: "UNAVAILABLE" as const, p2_treatment: "UNAVAILABLE" as const,
              differential: null, evidence_family: null, reliability: null, sample: null,
              unavailable_reason: "Provider request timed out after 20000ms", sources: [],
            };
          }
          return {
            metric_code: metric.code, p1_value: "service_point_win_pct=74", p2_value: null,
            p1_treatment: "DIRECT" as const, p2_treatment: "UNAVAILABLE" as const,
            differential: null, evidence_family: "PBP_SCORE_STATE", reliability: .9, sample: "s",
            unavailable_reason: null, sources: [{ source_name: "retry-source" }],
          };
        });
      },
    };
    await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });
    const row = tables.metric_results.find(metric => metric.metric_code === "M02")!;
    // Retried the SAME metric through the SAME producer path -- never a different metric,
    // never a relaxed field -- and succeeded on the second attempt.
    expect(row.p1_treatment).toBe("DIRECT");
    expect(row.p1_value).toBe("service_point_win_pct=74");
    expect(attempts).toBe(2); // exactly one retry, not the full bounded budget wasted
    expect(logCalls.some(entry => entry.status === "RETRYING" && (entry.output as { retried_codes?: string[] } | undefined)?.retried_codes?.includes("M02"))).toBe(true);
  });

  it("bounds retries: a persistently timing-out metric stops after a fixed number of attempts instead of looping indefinitely", async () => {
    const { deps, tables } = makeMemoryDeps();
    let attempts = 0;
    deps.research = {
      ...researcher,
      async metrics(input) {
        return input.metrics.map(metric => {
          if (metric.code !== "M02" || input.researchSide !== "p1") {
            return {
              metric_code: metric.code, p1_value: "50", p2_value: "48",
              p1_treatment: "DIRECT" as const, p2_treatment: "DIRECT" as const,
              differential: null, evidence_family: "FAM", reliability: .85, sample: "s",
              unavailable_reason: null, sources: [],
            };
          }
          attempts += 1;
          return {
            metric_code: metric.code, p1_value: null, p2_value: null,
            p1_treatment: "UNAVAILABLE" as const, p2_treatment: "UNAVAILABLE" as const,
            differential: null, evidence_family: null, reliability: null, sample: null,
            unavailable_reason: "Provider request timed out after 20000ms", sources: [],
          };
        });
      },
    };
    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });
    expect(result.complete).toBe(true); // the audit still reaches completion
    // 1 initial attempt + at most 2 bounded retries = 3 total, never unbounded.
    expect(attempts).toBe(3);
    const row = tables.metric_results.find(metric => metric.metric_code === "M02")!;
    expect(row.p1_treatment).toBe("UNAVAILABLE");
    expect(row.p1_unavailable_reason).toBe("PROVIDER_TIMEOUT");
  });

  it("keeps every required denominator when all research providers fail", async () => {
    const { deps, tables, stages } = makeMemoryDeps();
    const failure = async () => {
      throw new Error("Research provider credits exhausted (402)");
    };
    deps.research = {
      ...researcher,
      identity: failure,
      metrics: failure,
      rules: failure,
      underdog: failure,
      conclusion: failure,
      stress: failure,
    };

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(result.complete).toBe(true);
    expect(result.report?.color).toBe("INSUFFICIENT EVIDENCE");
    expect(result.report?.counts.metrics.total).toBe(EXPECTED_INSTANTIATED_METRIC_COUNT);
    expect(result.report?.counts.verification.total).toBe(DEF_COUNTS.VERIFICATION);
    expect(result.report?.counts.disagreement.total).toBe(DEF_COUNTS.DISAGREEMENT);
    expect(result.report?.counts.underdog.total).toBe(UNDERDOG_PATHWAYS.length * 2);
    expect(result.report?.counts.stress.total).toBe(STRESS_TESTS.length);
    expect(result.report?.counts.p1.total).toBe(EXPECTED_INSTANTIATED_METRIC_COUNT);
    expect(result.report?.counts.p2.total).toBe(EXPECTED_INSTANTIATED_METRIC_COUNT);
    expect(tables["metric_results"]!.every((row) => ["UNAVAILABLE", "EXCLUDED", "NO_SOURCE"].includes(String(row["p1_status"]))))
      .toBe(true);
    expect(tables["metric_results"]!.every((row) => ["UNAVAILABLE", "EXCLUDED", "NO_SOURCE"].includes(String(row["p2_status"]))))
      .toBe(true);
    expect(Array.from(stages.values()).every((row) => row["status"] === "COMPLETE")).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // ACCEPTANCE: the full deterministic audit chain must actually PERSIST, not just run.
  // This is the end-to-end proof that a match produces an auditable winner derived from
  // evidence -- with verification, disagreement, underdog and stress rows genuinely
  // populated, and the LLM unable to supply or overturn the winner.
  // ---------------------------------------------------------------------------
  it("persists a complete deterministic audit chain ending in an evidence-derived winner", async () => {
    const { deps, tables } = makeMemoryDeps();
    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    // 1. VERIFICATION: rules the deterministic audit answers are genuinely populated.
    const verification = tables["verification_results"]!;
    const evaluatedVerification = verification.filter((r) => r["outcome"] !== "UNAVAILABLE" && r["p1_finding"] && r["p2_finding"]);
    expect(evaluatedVerification.length).toBeGreaterThan(0);
    for (const row of evaluatedVerification) {
      expect(String(row["p1_finding"])).not.toEqual(String(row["p2_finding"])); // both sides computed, not copied
      expect(row["decision_effect"]).toBeTruthy();
    }
    // Rules it cannot answer stay explicitly unavailable WITH the missing evidence named.
    const unavailableVerification = verification.filter((r) => r["outcome"] === "UNAVAILABLE");
    // Two legitimate unavailable shapes: no deterministic evaluator exists for the rule, or
    // an evaluator ran and found the required evidence absent for THIS match. Both must say why.
    for (const row of unavailableVerification) {
      expect(String(row["unavailable_detail"] ?? "").length).toBeGreaterThan(20);
      expect(String(row["unavailable_detail"] ?? "")).toMatch(/requires|not a per-match|no comparable|UNAVAILABLE:/);
    }

    // 2. DISAGREEMENT: risk is populated for BOTH sides and severity is evidence-derived.
    const disagreement = tables["disagreement_results"]!.filter((r) => r["status"] === "COMPLETE");
    expect(disagreement.length).toBeGreaterThan(0);
    for (const row of disagreement) {
      expect(row["p1_risk"]).toBeTruthy();
      expect(row["p2_risk"]).toBeTruthy();
      expect(["NONE", "MINOR", "MODERATE", "MAJOR", "CRITICAL"]).toContain(String(row["contradiction_severity"]));
    }

    // 3. UNDERDOG: pathways are classified, and the old hardcoded fallback string is gone.
    const underdog = tables["underdog_results"]!;
    expect(underdog.every((r) => String(r["evidence"] ?? "") !== "Retrieval attempted; no admissible pre-match evidence located.")).toBe(true);
    expect(underdog.filter((r) => r["status"] === "COMPLETE").length).toBeGreaterThan(0);

    // 4. STRESS: winner_after is genuinely recomputed and persisted (previously always null).
    const stress = tables["stress_results"]!;
    const st03 = stress.find((r) => r["test_code"] === "ST03")!;
    expect(st03["status"]).toBe("COMPLETE");
    expect(st03["winner_after"]).toBeTruthy();
    expect(String(st03["unavailable_detail"] ?? "")).toMatch(/Removing each independent evidence family/);
    const recomputed = stress.filter((r) => ["ST05", "ST06", "ST07"].includes(String(r["test_code"])));
    for (const row of recomputed) {
      expect(row["status"]).toBe("COMPLETE");
      expect(row["winner_after"]).toBeTruthy();
      expect(String(row["unavailable_detail"] ?? "")).toMatch(/Adverse recomputation/);
    }
    // Stress tests with no admissible evidence are honest, not manufactured.
    const st04 = stress.find((r) => r["test_code"] === "ST04")!;
    expect(st04["status"]).toBe("UNAVAILABLE");
    expect(String(st04["unavailable_detail"])).toMatch(/quarantined/);

    // 5. FINAL: the run carries an independently derived winner (0 across all 405 historical runs).
    const run = await deps.getLatestRun(MATCH_ID);
    expect(run?.independent_winner).toBe(P1); // P1 leads three independent families in this fixture
    expect(run?.effective_evidence_count).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("the provider cannot supply or overturn the audit winner", async () => {
    // Every provider fails EXCEPT metrics: the winner must still be produced, proving it is
    // derived from metric evidence rather than obtained from the conclusion provider.
    const { deps } = makeMemoryDeps();
    const failure = async () => { throw new Error("provider down"); };
    deps.research = { ...researcher, rules: failure, underdog: failure, conclusion: failure, stress: failure };
    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });
    const run = await deps.getLatestRun(MATCH_ID);
    expect(run?.independent_winner).toBe(P1);

    // And a provider that insists on the OTHER player cannot change the outcome.
    const { deps: deps2 } = makeMemoryDeps();
    deps2.research = { ...researcher, async conclusion() { return { winner: P2, low: 90, high: 95, rationale: "provider insists on P2", insufficient_reason: null }; } };
    await runPipeline(deps2, MATCH_ID, { budgetMs: 120_000 });
    const run2 = await deps2.getLatestRun(MATCH_ID);
    expect(run2?.independent_winner).toBe(P1);
  }, 60_000);

  it("executes every stage and leaves no section at 0/0", async () => {
    const { deps, tables, stages } = makeMemoryDeps();

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    // Every stage must have executed and recorded a per-stage diagnostic.
    for (const stage of STAGES) {
      const row = stages.get(stage);
      expect(row, `stage ${stage} never executed`).toBeTruthy();
      expect(row!["status"], `stage ${stage} did not complete: ${String(row!["error_message"])}`).toBe("COMPLETE");
    }

    // Real denominators, and no section may be 0/0.
    const sections: Array<[ChildTable, number]> = [
      ["metric_results", EXPECTED_INSTANTIATED_METRIC_COUNT],
      ["verification_results", DEF_COUNTS.VERIFICATION],
      ["disagreement_results", DEF_COUNTS.DISAGREEMENT],
      ["underdog_results", UNDERDOG_PATHWAYS.length * 2],
      ["stress_results", STRESS_TESTS.length],
    ];
    for (const [table, expected] of sections) {
      expect(tables[table]!.length, `${table} instantiated 0 rows (0/0 defect)`).toBeGreaterThan(0);
      expect(tables[table]!.length, `${table} denominator wrong`).toBe(expected);
      const executed = tables[table]!.filter((r) => ["COMPLETE", "UNAVAILABLE", "EXCLUDED", "NO_SOURCE"].includes(String(r["status"])));
      expect(executed.length, `${table} has unexecuted rows`).toBe(expected);
    }

    // Matrix firewall: the independent conclusion precedes the reveal.
    const run = await deps.getLatestRun(MATCH_ID);
    expect(run?.independent_winner).toBe(P1);
    expect(run?.independent_decision_committed_at).toBeTruthy();
    expect(run?.matrix_revealed_at).toBeTruthy();
    expect(new Date(run!.independent_decision_committed_at!).getTime()).toBeLessThanOrEqual(
      new Date(run!.matrix_revealed_at!).getTime(),
    );

    // Calibration and the final gate ran.
    expect(run?.calibration_version_id).toBe("cal-1");
    expect(result.report).not.toBeNull();
    expect(result.report!.completionPercent).toBeGreaterThan(0);
    expect(result.complete).toBe(true);
  }, 60_000);

  // Regression: production's metric_results.p1_treatment/p2_treatment columns are
  // `not null` with a check constraint restricted to a fixed allow-list. instantiate()
  // once inserted `null` for any not-yet-researched row (the placeholder before
  // executeMetrics ever runs), which is legal against this in-memory fake but violates
  // the real not-null constraint and rejects the whole batch insert -- surfacing as
  // Definition Instantiation permanently stuck (see the DB error this test file's
  // sibling migration 20260829091200_allow_no_source_treatment.sql documents). Every
  // instantiated row must carry a real, allow-listed treatment value on both sides at
  // all times, before any research has run.
  it("never instantiates a metric row with a null or non-allow-listed treatment value", async () => {
    const ALLOWED = new Set(["DIRECT", "RECONSTRUCTED", "PARTIAL", "UNAVAILABLE", "EXCLUDED", "NO_SOURCE"]);
    const { deps, tables } = makeMemoryDeps();

    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    for (const row of tables["metric_results"]!) {
      expect(row["p1_treatment"], `metric ${row["metric_code"]} p1_treatment must not be null`).not.toBeNull();
      expect(row["p2_treatment"], `metric ${row["metric_code"]} p2_treatment must not be null`).not.toBeNull();
      expect(ALLOWED.has(String(row["p1_treatment"])), `metric ${row["metric_code"]} p1_treatment "${row["p1_treatment"]}" not allow-listed`).toBe(true);
      expect(ALLOWED.has(String(row["p2_treatment"])), `metric ${row["metric_code"]} p2_treatment "${row["p2_treatment"]}" not allow-listed`).toBe(true);
    }
  }, 60_000);

  it("dispatches every prepared match when concurrency is 4", async () => {
    const matchIds = Array.from({ length: 12 }, (_, i) => `match-${i + 1}`);
    const seen: string[] = [];
    const running = new Set<string>();
    const maxRunning = { value: 0 };

    await dispatchAuditBatch({
      matches: matchIds.map((matchId) => ({ matchId })),
      concurrency: 4,
      budgetMs: 5_000,
    }, async (match) => {
      const matchId = match.matchId;
      running.add(matchId);
      maxRunning.value = Math.max(maxRunning.value, running.size);
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(matchId);
      running.delete(matchId);
      return { matchId };
    });

    expect(seen).toHaveLength(12);
    expect(seen).toEqual(matchIds);
    expect(maxRunning.value).toBeLessThanOrEqual(4);
  }, 30_000);

  it("reclaims an expired RUNNING audit by refreshing the lease before resuming", async () => {
    const staleLockBefore = new Date("2026-04-10T00:00:00Z");
    const now = new Date("2026-04-11T12:00:00Z");
    let currentRun: RunRow = {
      id: "run-expired",
      match_id: MATCH_ID,
      run_number: 9,
      status: "RUNNING",
      research_lock_at: staleLockBefore.toISOString(),
      independent_decision_committed_at: null,
      matrix_revealed_at: null,
      independent_winner: null,
      independent_low: null,
      independent_high: null,
      calibrated_low: null,
      calibrated_high: null,
      calibration_version_id: null,
      effective_evidence_count: 0,
      metrics_version_id: null,
      verification_version_id: null,
      disagreement_version_id: null,
    };

    const { deps } = makeMemoryDeps();
    deps.now = () => now;
    deps.getLatestRun = async () => currentRun;
    deps.updateRun = async (_id, patch) => {
      currentRun = { ...currentRun, ...(patch as object) } as RunRow;
    };

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(result.runId).toBe("run-expired");
    expect(currentRun.research_lock_at).toBe(now.toISOString());
    expect(["RUNNING", "COMPLETE"]).toContain(currentRun.status);
    expect(result.complete).toBe(true);
  }, 60_000);

  it("is idempotent: a second run adds no duplicate records", async () => {
    const { deps, tables } = makeMemoryDeps();
    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });
    const before = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });
    const after = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    expect(after).toEqual(before);
  }, 60_000);

  // Truth Engine execution-universe guardrail (fix-all task): the pipeline must
  // instantiate, and send to research, ONLY the 25 ACTIVE_METRIC_CODES plus the two
  // documented exceptions kept for real downstream writers ("042" for Dangerous
  // Underdog's opponent-win-pathways enrichment, and the 7 META_OR_NON_PLAYER codes
  // for meta-derived-evidence.server.ts's composite writer). Every other code in the
  // 81-code registry -- including every PROTECTED_UNAVAILABLE/MATRIX_SUMMARY_REQUIRED
  // one, and every ordinary LEGITIMATE_PLAYER_METRIC that simply isn't one of the 25 --
  // must get ZERO metric_results rows and ZERO research calls. Not a settled
  // EXCLUDED/NO_SOURCE placeholder row: no row at all. A regression here means either
  // a code was reclassified/activated without updating this test, or the exclusion
  // wiring in instantiate() broke.
  //
  // Only "48","49","50","56","57","58","59" are META_OR_NON_PLAYER under the canonical
  // registry, and are the one category of non-active code still instantiated (as
  // EXCLUDED, never researched -- unchanged behavior). "04"/"05"/"06" are real player
  // metrics (Combined Efficiency/Recent Form/Opponent Quality) that are NOT among the
  // 25 active codes, so -- unlike before this task -- they now get no row at all.
  it("instantiates only the 25 active codes plus the two documented exceptions; every other registry code gets zero rows and zero research calls", async () => {
    const META_SUFFIXES = ["48", "49", "50", "56", "57", "58", "59"];
    const seenByResearch = new Set<string>();
    const { deps, tables } = makeMemoryDeps();
    deps.research = {
      ...researcher,
      async metrics({ metrics }) {
        for (const m of metrics) seenByResearch.add(m.code);
        return researcher.metrics({ metrics } as never);
      },
    };

    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    const metricRows = tables["metric_results"]!;
    expect(metricRows).toHaveLength(EXPECTED_INSTANTIATED_METRIC_COUNT);
    const metaCodes = META_SUFFIXES.map((suffix) => `M${suffix}`);
    expect(metaCodes).toHaveLength(7);

    for (const code of metaCodes) {
      const row = metricRows.find((r) => r["metric_code"] === code);
      expect(row, `metric ${code} was not instantiated`).toBeTruthy();
      expect(row!["status"], `metric ${code} status`).toBe("EXCLUDED");
      expect(row!["p1_status"], `metric ${code} p1_status`).toBe("EXCLUDED");
      expect(row!["p2_status"], `metric ${code} p2_status`).toBe("EXCLUDED");
      expect(seenByResearch.has(code), `metric ${code} was sent to the research provider`).toBe(false);
    }

    // "042" ("Opponent Win Pathways") is itself classified MATRIX_SUMMARY_REQUIRED in
    // the real registry -- quarantined pending real Tennis Matrix AI Summary evidence,
    // exactly like the other 14 quarantined codes. It is kept instantiated (unlike
    // those 14) purely because opponent-win-pathways-meta.server.ts needs the row to
    // exist as a write target for a value it derives from the Dangerous Underdog
    // stage, not from research -- so it must NEVER be sent to research either.
    const code042 = `M${"042".replace(/^0/, "")}`;
    const row042 = metricRows.find((r) => r["metric_code"] === code042);
    expect(row042, `metric ${code042} was not instantiated`).toBeTruthy();
    expect(row042!["status"], `metric ${code042} status`).toBe("NO_SOURCE");
    expect(seenByResearch.has(code042), `metric ${code042} was sent to the research provider`).toBe(false);

    // Every remaining instantiated row must be exactly the 25 active codes, and every
    // one of THOSE must have been sent to research (none of the 25 are META/NO_SOURCE-
    // classified).
    const expectedPlayerCodes = new Set(ACTIVE_METRIC_CODES.map((code) => `M${code.replace(/^0/, "")}`));
    const playerCodes = metricRows.map((r) => String(r["metric_code"])).filter((c) => !metaCodes.includes(c) && c !== code042);
    expect(new Set(playerCodes)).toEqual(expectedPlayerCodes);
    for (const code of playerCodes) expect(seenByResearch.has(code), `player metric ${code} was never sent to research`).toBe(true);

    // Codes genuinely classified PROTECTED_UNAVAILABLE (017, 054, 063, 065, 066, 067,
    // 069, 072, 073, 074, 076, 078, 079, 081), every OTHER MATRIX_SUMMARY_REQUIRED
    // quarantine code besides "042", and an ordinary non-active LEGITIMATE_PLAYER_METRIC
    // code (e.g. "04", Combined Efficiency) must all be completely absent -- no row,
    // never researched.
    const realProtectedUnavailableCodes = ["017", "054", "063", "065", "066", "067", "069", "072", "073", "074", "076", "078", "079", "081"].map((suffix) => `M${suffix.replace(/^0/, "")}`);
    const otherQuarantinedCodes = [...MATRIX_SUMMARY_REQUIRED_CODES].filter((code) => code !== "042").map((code) => `M${code.replace(/^0/, "")}`);
    for (const code of [...realProtectedUnavailableCodes, ...otherQuarantinedCodes, "M04"]) {
      expect(metricRows.some((r) => r["metric_code"] === code), `${code} should not have been instantiated`).toBe(false);
      expect(seenByResearch.has(code), `${code} should never have reached research`).toBe(false);
    }
  }, 60_000);

  // Denominator-eligibility audit, requested directly: a code with a documented
  // NO_SOURCE determination that is NOT one of the 25 active codes must now get zero
  // rows at all -- the strongest form of exclusion, stronger than the pre-fix-all
  // behavior (settled NO_SOURCE placeholder). A real META_OR_NON_PLAYER code, by
  // contrast, is a documented exception and keeps instantiating EXCLUDED, unchanged.
  // classifyMetric is mocked above to treat "M70" (real code 070) as PROTECTED_UNAVAILABLE.
  // "M59" (real code 059, "Loss Path Probability") is used here as the real
  // META_OR_NON_PLAYER reference code -- it is genuinely excluded under the canonical
  // registry, unlike "M61" (061 is a resolved LEGITIMATE_PLAYER_METRIC -- see
  // docs/audit-task-047-061-classification-decisions.md -- not excluded, and also not
  // active, so it too now instantiates no row).
  it("a non-active NO_SOURCE code gets no row at all, while a real META_OR_NON_PLAYER code still stays EXCLUDED", async () => {
    const seenByResearch = new Set<string>();
    const { deps, tables } = makeMemoryDeps();
    deps.research = {
      ...researcher,
      async metrics({ metrics }) {
        for (const m of metrics) seenByResearch.add(m.code);
        return researcher.metrics({ metrics } as never);
      },
    };

    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    const metricRows = tables["metric_results"]!;
    expect(metricRows.some((r) => r["metric_code"] === "M70"), "metric M70 should not have been instantiated").toBe(false);
    expect(seenByResearch.has("M70"), "metric M70 was sent to the research provider").toBe(false);
    expect(metricRows.some((r) => r["metric_code"] === "M61"), "metric M61 (not active) should not have been instantiated").toBe(false);

    const metaRow = metricRows.find((r) => r["metric_code"] === "M59");
    expect(metaRow!["status"]).toBe("EXCLUDED");
    expect(metaRow!["unavailable_reason"]).toBe("PROCESS_META_NOT_PLAYER_EVIDENCE");
  }, 60_000);

  // Regression: a stage failure whose own FAILED-status DB write also throws (e.g. a
  // database client that is misconfigured or transiently unreachable while the pipeline
  // is trying to record the error) must not escape runPipeline as an unhandled
  // rejection that loses the stage attribution. Previously this surfaced only as a
  // generic top-level "PIPELINE" failure with no indication of which stage or run was
  // affected, which is indistinguishable from the stage silently never getting marked
  // FAILED (the observed "stuck at RUNNING 0/0 forever" symptom) from the caller's
  // point of view. runPipeline must resolve normally and attribute the failure to the
  // actual stage, with nextStage pointing at it so a resumed run retries the right
  // stage instead of restarting blind.
  it("attributes a failure to the real stage when the error-path status write itself throws, instead of an unhandled rejection", async () => {
    const { deps } = makeMemoryDeps();
    deps.getRules = async () => {
      throw new Error("boom: rule_documents read failed");
    };
    const realSetStage = deps.setStage.bind(deps);
    deps.setStage = async (runId, matchId, stage, patch) => {
      if (stage === "DEFINITION INSTANTIATION" && patch["status"] === "FAILED") {
        throw new Error("boom: could not write FAILED status (client misconfigured)");
      }
      return realSetStage(runId, matchId, stage, patch);
    };

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]!.stage).toBe("DEFINITION INSTANTIATION");
    expect(result.failures[0]!.message).toContain("could not persist FAILED status");
    expect(result.nextStage).toBe("DEFINITION INSTANTIATION");
  }, 60_000);

  it("does not execute provider work when another driver owns the persisted run lease", async()=>{
    const{deps,tables}=makeMemoryDeps();
    let providerCalls=0;
    deps.acquireRunLease=async()=>false;
    deps.research={...researcher,async metrics(input){providerCalls++;return researcher.metrics(input);}};

    const result=await runPipeline(deps,MATCH_ID,{budgetMs:120_000});

    expect(result.leaseHeld).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(tables.metric_results).toHaveLength(0);
  });

  it("uses wide bounded metric batches instead of repeating five-metric provider calls", async()=>{
    const{deps}=makeMemoryDeps();
    const batchSizes:number[]=[];
    deps.research={...researcher,async metrics(input){batchSizes.push(input.metrics.length);return researcher.metrics(input);}};

    const result=await runPipeline(deps,MATCH_ID,{budgetMs:120_000});

    expect(result.complete).toBe(true);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(15);
    expect(batchSizes.some(size=>size===15)).toBe(true);
    expect(batchSizes.length).toBeLessThanOrEqual(12);
  },60_000);

  it("renews and releases the run lease while persisting stage progress",async()=>{
    const{deps}=makeMemoryDeps();
    let renewals=0,releases=0;
    deps.acquireRunLease=async()=>true;
    deps.renewRunLease=async()=>{renewals++;return true;};
    deps.releaseRunLease=async()=>{releases++;};

    const result=await runPipeline(deps,MATCH_ID,{budgetMs:120_000});

    expect(result.complete).toBe(true);
    expect(renewals).toBeGreaterThan(0);
    expect(releases).toBe(1);
  },60_000);
});

// ----------------------------------------------------------------------------
// Regression suite for the dependency-ordered state machine: a downstream
// stage must not report COMPLETE merely because its own function ran -- it
// must prove every required upstream stage already persisted COMPLETE.
// enforceStageDependencies/unmetDependencies are pure functions, so these
// tests exercise the actual write-gating logic directly rather than trying
// to contrive a scenario through the full pipeline (which, by the loop's own
// strictly sequential design, can never itself reach an out-of-order state --
// these guards are what make that an enforced invariant rather than an
// incidental property of today's loop shape).
// ----------------------------------------------------------------------------
describe("Stage dependency gate: enforceStageDependencies / unmetDependencies", () => {
  const complete = (...names: Stage[]) => names.map((stage) => ({ stage, status: "COMPLETE" }));

  it("allows a stage to complete once every required upstream stage is COMPLETE", () => {
    const rows = complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION", "MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION");
    const guard = enforceStageDependencies("P1 METRIC EXECUTION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(false);
    expect(guard.patch["status"]).toBe("COMPLETE");
    expect(guard.missing).toEqual([]);
  });

  it("a fresh audit starts with Match Ingestion / PDF Extraction and cannot skip ahead", () => {
    const guard = enforceStageDependencies("MATCH IDENTITY VERIFICATION", { status: "COMPLETE" }, []);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["MATCH INGESTION / PDF EXTRACTION"]);
  });

  it("Match Identity Verification cannot report COMPLETE before Match Ingestion / PDF Extraction", () => {
    const guard = enforceStageDependencies("MATCH IDENTITY VERIFICATION", { status: "COMPLETE" }, []);
    expect(guard.blocked).toBe(true);
    expect(guard.patch["status"]).toBe("BLOCKED");
    expect(guard.missing).toEqual(["MATCH INGESTION / PDF EXTRACTION"]);
  });

  it("Match Context Resolution cannot report COMPLETE before Match Identity Verification", () => {
    const rows = complete("MATCH INGESTION / PDF EXTRACTION");
    const guard = enforceStageDependencies("MATCH CONTEXT RESOLUTION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["MATCH IDENTITY VERIFICATION"]);
  });

  it("P1 cannot report COMPLETE before ingestion/identity/context/definition instantiation are COMPLETE", () => {
    const guard = enforceStageDependencies("P1 METRIC EXECUTION", { status: "COMPLETE" }, complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION"));
    expect(guard.blocked).toBe(true);
    expect(guard.patch["status"]).toBe("BLOCKED");
    expect(guard.patch["error_code"]).toBe("UPSTREAM_DEPENDENCY_INCOMPLETE");
    expect(guard.missing).toEqual(["MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION"]);
  });

  it("P2 cannot report COMPLETE while P1 (or anything before it) is not COMPLETE", () => {
    const rows = complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION", "MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION");
    const guard = enforceStageDependencies("P2 METRIC EXECUTION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["P1 METRIC EXECUTION"]);
  });

  it("Verification Audit cannot complete before P1/P2 metric execution", () => {
    const rows = complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION", "MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION", "P1 METRIC EXECUTION");
    const guard = enforceStageDependencies("VERIFICATION AUDIT", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["P2 METRIC EXECUTION"]);
  });

  it("Disagreement, Dangerous Underdog and Stress/Removal cannot complete before Verification Audit", () => {
    const rows = complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION", "MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION", "P1 METRIC EXECUTION", "P2 METRIC EXECUTION");
    for (const stage of ["DISAGREEMENT / TRAP AUDIT", "DANGEROUS UNDERDOG AUDIT", "STRESS / REMOVAL TESTS"] as const) {
      const guard = enforceStageDependencies(stage, { status: "COMPLETE" }, rows);
      expect(guard.blocked, `${stage} must be blocked without VERIFICATION AUDIT`).toBe(true);
      expect(guard.missing).toContain("VERIFICATION AUDIT");
    }
  });

  it("Independent Conclusion cannot complete before verification, disagreement, underdog and stress are all COMPLETE", () => {
    const rows = complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION", "MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION", "P1 METRIC EXECUTION", "P2 METRIC EXECUTION", "VERIFICATION AUDIT", "DISAGREEMENT / TRAP AUDIT", "DANGEROUS UNDERDOG AUDIT");
    const guard = enforceStageDependencies("INDEPENDENT CONCLUSION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["STRESS / REMOVAL TESTS"]);
  });

  it("Current Calibration cannot complete before the independent conclusion is committed and the matrix is revealed", () => {
    const rows = complete(...STAGES.slice(0, STAGES.indexOf("MATRIX REVEAL AND COMPARISON")));
    const guard = enforceStageDependencies("CURRENT CALIBRATION APPLICATION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["MATRIX REVEAL AND COMPARISON"]);
  });

  it("Coverage Persistence / Evidence Validation cannot complete before Current Calibration", () => {
    const rows = complete(...STAGES.slice(0, STAGES.indexOf("CURRENT CALIBRATION APPLICATION")));
    const guard = enforceStageDependencies("COVERAGE PERSISTENCE / EVIDENCE VALIDATION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["CURRENT CALIBRATION APPLICATION"]);
  });

  it("Final Decision cannot complete before Coverage Persistence / Evidence Validation", () => {
    const rows = complete(...STAGES.slice(0, STAGES.indexOf("COVERAGE PERSISTENCE / EVIDENCE VALIDATION")));
    const guard = enforceStageDependencies("FINAL DECISION", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["COVERAGE PERSISTENCE / EVIDENCE VALIDATION"]);
  });

  it("Final Combination Gate cannot complete before Final Decision (its immediate prerequisite)", () => {
    const rows = complete(...STAGES.slice(0, STAGES.length - 2));
    const guard = enforceStageDependencies("FINAL COMBINATION GATE", { status: "COMPLETE" }, rows);
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(["FINAL DECISION"]);
  });

  it("Final Combination Gate cannot complete while P1/P2/verification/disagreement/underdog/stress/conclusion/calibration/coverage/final-decision are missing, not just the immediate predecessor", () => {
    // Only the very first stage is done -- everything else, including P1/P2
    // required metrics, is missing.
    const guard = enforceStageDependencies("FINAL COMBINATION GATE", { status: "COMPLETE" }, complete("MATCH INGESTION / PDF EXTRACTION"));
    expect(guard.blocked).toBe(true);
    expect(guard.missing).toEqual(STAGES.slice(1, STAGES.length - 1));
    expect(guard.missing).toEqual(expect.arrayContaining(["P1 METRIC EXECUTION", "P2 METRIC EXECUTION", "VERIFICATION AUDIT", "DANGEROUS UNDERDOG AUDIT", "STRESS / REMOVAL TESTS", "INDEPENDENT CONCLUSION", "CURRENT CALIBRATION APPLICATION", "COVERAGE PERSISTENCE / EVIDENCE VALIDATION", "FINAL DECISION"]));
  });

  it("a FAILED or BLOCKED prerequisite blocks every stage that transitively depends on it, not just the immediate next one", () => {
    const rows = [...complete("MATCH INGESTION / PDF EXTRACTION", "MATCH IDENTITY VERIFICATION", "MATCH CONTEXT RESOLUTION", "DEFINITION INSTANTIATION"), { stage: "P1 METRIC EXECUTION", status: "FAILED" }];
    const dependents = STAGES.slice(STAGES.indexOf("P2 METRIC EXECUTION"));
    for (const stage of dependents) {
      const guard = enforceStageDependencies(stage, { status: "COMPLETE" }, rows);
      expect(guard.blocked, `${stage} must stay blocked while P1 METRIC EXECUTION is FAILED`).toBe(true);
      expect(guard.missing).toContain("P1 METRIC EXECUTION");
    }
  });

  it("never rewrites a non-COMPLETE status write (RUNNING/BLOCKED/FAILED pass through untouched, regardless of dependency state)", () => {
    const guard = enforceStageDependencies("FINAL COMBINATION GATE", { status: "RUNNING", done_count: 3 }, []);
    expect(guard.blocked).toBe(false);
    expect(guard.patch).toEqual({ status: "RUNNING", done_count: 3 });
  });

  it("re-running a stage that is already validly COMPLETE does not create a false duplicate completion record: repeated calls are idempotent", () => {
    const rows = complete(...STAGES);
    const first = enforceStageDependencies("FINAL COMBINATION GATE", { status: "COMPLETE" }, rows);
    const second = enforceStageDependencies("FINAL COMBINATION GATE", { status: "COMPLETE" }, rows);
    expect(first).toEqual(second);
    expect(first.blocked).toBe(false);
  });
});

describe("Stage dependency gate: enforced through the real pipeline (runPipeline)", () => {
  it("a failed/incomplete prerequisite (missing rule definitions at Definition Instantiation) blocks every dependent stage -- none of them are even attempted", async () => {
    const { deps, stages } = makeMemoryDeps();
    const realGetActiveVersionId = deps.getActiveVersionId.bind(deps);
    deps.getActiveVersionId = async (docType) => (docType === "METRICS" ? null : realGetActiveVersionId(docType));

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(result.complete).toBe(false);
    expect(stages.get("DEFINITION INSTANTIATION")?.["status"]).toBe("FAILED");
    // P1 through Final Combination Gate must never even be attempted -- no
    // audit_stage_runs row at all, not a row left dangling in some other status.
    for (const stage of STAGES.slice(STAGES.indexOf("P1 METRIC EXECUTION"))) {
      expect(stages.has(stage), `stage ${stage} should never have been touched`).toBe(false);
    }
  }, 60_000);

  it("a failed attempt does not create a second visible canonical diagnostic: a retry updates/reuses the same audit_run_id+stage record", async () => {
    const { deps, stages } = makeMemoryDeps();
    let calibrationCalls = 0;
    const realGetCalibration = deps.getCalibration.bind(deps);
    deps.getCalibration = async (versionId) => {
      calibrationCalls++;
      // First attempt: no active calibration version -> CURRENT CALIBRATION
      // APPLICATION returns FAILED. Every subsequent attempt (the retry):
      // the real, working calibration.
      if (calibrationCalls === 1) return { version: null, buckets: [] };
      return realGetCalibration(versionId);
    };

    const first = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });
    expect(first.complete).toBe(false);
    expect(stages.get("CURRENT CALIBRATION APPLICATION")?.["status"]).toBe("FAILED");
    expect(stages.get("CURRENT CALIBRATION APPLICATION")?.["attempts"]).toBe(1);
    // Exactly one audit_stage_runs record exists per (audit_run_id, stage) --
    // this in-memory map is keyed by stage name, mirroring the real table's
    // UNIQUE (audit_run_id, stage) constraint -- so a second row for the
    // same stage is structurally impossible, not merely absent by luck. The
    // loop stopped at CURRENT CALIBRATION APPLICATION (the failure), so only
    // stages up to and including it have a record yet.
    const stageCountAfterFailure = stages.size;
    expect(stageCountAfterFailure).toBe(STAGES.indexOf("CURRENT CALIBRATION APPLICATION") + 1);

    const second = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(second.complete).toBe(true);
    // The calibration stage's SAME record was updated in place -- still one
    // entry for it, now COMPLETE, with attempts incremented, never a second
    // row -- while the run also legitimately reaches every remaining stage
    // for the first time, growing to the full canonical 16.
    expect(stages.size).toBe(STAGES.length);
    expect(stages.get("CURRENT CALIBRATION APPLICATION")?.["status"]).toBe("COMPLETE");
    expect(stages.get("CURRENT CALIBRATION APPLICATION")?.["attempts"]).toBe(2);
    expect(stages.get("CURRENT CALIBRATION APPLICATION")?.["error_message"]).toBeNull();

    // Rendering this run's canonical diagnostics still yields exactly one
    // entry per stage, all 16, none omitted, none duplicated -- the failed
    // attempt is invisible in the canonical view once the retry succeeds.
    const canonical = canonicalizeStageRows(Array.from(stages.values()).map((row) => ({ stage: String(row["stage"]), status: String(row["status"]) })));
    expect(canonical).toHaveLength(STAGES.length);
    expect(new Set(canonical.map((c) => c.stage)).size).toBe(STAGES.length);
    expect(canonical.every((c) => c.row?.status === "COMPLETE")).toBe(true);
  }, 60_000);

  it("on a fully successful run, every stage's persisted status satisfies the dependency graph end to end -- no downstream COMPLETE while an upstream required stage is not", async () => {
    const { deps, stages } = makeMemoryDeps();

    const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(result.complete).toBe(true);
    const rows = Array.from(stages.values()).map((row) => ({ stage: String(row["stage"]), status: String(row["status"]) }));
    for (const stage of STAGES) {
      const gaps = unmetDependencies(stage, rows);
      expect(gaps, `stage ${stage} has unmet upstream dependencies: ${gaps.join(", ")}`).toEqual([]);
    }
    // In particular, the Final Combination Gate specifically must not be
    // COMPLETE while any required upstream stage is not.
    expect(unmetDependencies("FINAL COMBINATION GATE", rows)).toEqual([]);
    expect(stages.get("FINAL COMBINATION GATE")?.["status"]).toBe("COMPLETE");
  }, 60_000);

  it("re-running a completed pipeline does not re-invoke the research provider or write duplicate stage rows (no false duplicate completion records)", async () => {
    const { deps, stages, tables } = makeMemoryDeps();
    let calls = 0;
    const countedResearcher: Researcher = {
      ...researcher,
      async identity(input) { calls++; return researcher.identity(input); },
      async metrics(input) { calls++; return researcher.metrics(input); },
      async rules(input) { calls++; return researcher.rules(input); },
      async underdog(input) { calls++; return researcher.underdog(input); },
      async conclusion(input) { calls++; return researcher.conclusion(input); },
      async stress(input) { calls++; return researcher.stress(input); },
    };
    deps.research = countedResearcher;

    await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });
    expect(calls).toBeGreaterThan(0);
    const afterFirstRun = calls;
    const stageRowCount = stages.size;
    const tableCounts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));

    const second = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });

    expect(second.complete).toBe(true);
    expect(calls, "a fully complete run must not re-invoke the research provider").toBe(afterFirstRun);
    expect(stages.size, "no duplicate audit_stage_runs rows for any stage").toBe(stageRowCount);
    expect(stages.size).toBe(STAGES.length);
    for (const [table, count] of Object.entries(tableCounts)) {
      expect(tables[table]!.length, `${table} must not have grown on a no-op re-run`).toBe(count);
    }
  }, 60_000);

  it("obeys the dependency order independently for many matches, each producing exactly one canonical 16-stage diagnostic chain (stand-in for a fresh cleared-slate 50-match audit; the live end-to-end run is verified separately)", async () => {
    const MATCH_COUNT = 8;
    for (let i = 0; i < MATCH_COUNT; i++) {
      const { deps, stages } = makeMemoryDeps();
      const result = await runPipeline(deps, `match-${i}`, { budgetMs: 120_000 });
      expect(result.complete, `match ${i} did not complete`).toBe(true);
      const rows = Array.from(stages.values()).map((row) => ({ stage: String(row["stage"]), status: String(row["status"]) }));
      for (const stage of STAGES) {
        expect(unmetDependencies(stage, rows), `match ${i} stage ${stage} has unmet dependencies`).toEqual([]);
      }
      expect(stages.get("FINAL COMBINATION GATE")?.["status"]).toBe("COMPLETE");
      // Exactly one canonical diagnostic chain per match/run: 16 stages, no
      // duplicates, no gaps, every one persisted COMPLETE.
      expect(stages.size, `match ${i} has ${stages.size} stage records, expected exactly ${STAGES.length}`).toBe(STAGES.length);
      const canonical = canonicalizeStageRows(rows);
      expect(canonical, `match ${i} canonical diagnostics`).toHaveLength(STAGES.length);
      expect(canonical.every((c) => c.row?.status === "COMPLETE"), `match ${i} every canonical stage COMPLETE`).toBe(true);
    }
  }, 120_000);
});

// ----------------------------------------------------------------------------
// Clear Slate regression test.
//
// Clear Slate is now a hard, physical delete (public.clear_operational_slate(),
// see the migration and reset-slate.functions.ts): matches, audit_runs and every
// CASCADE-linked child row are gone, not invalidated in place. The pipeline
// itself implements none of that -- deletion is a database/data-layer concern --
// so what this level can and must prove is the other half of the contract: a
// match that has been physically removed can never be resumed, and nothing in
// the pipeline recreates it. PipelineDeps has no operation that creates a
// match (only `createRun`, which requires a match to already exist -- matches
// are created exclusively by upload.tsx); this test proves the runtime
// behavior matches that structural guarantee.
// ----------------------------------------------------------------------------
describe("Clear Slate: a deleted match cannot be resumed or resurrected", () => {
  it("K. a match removed mid-run aborts safely: no stage past the deletion point is ever marked complete, and nothing is recreated", async () => {
    const { deps, tables, stages } = makeMemoryDeps();
    let deleted = false;
    const raceDeps: PipelineDeps = {
      ...deps,
      async getMatch(matchId) { return deleted ? null : deps.getMatch(matchId); },
      async setStage(runId, matchId, stage, patch) {
        if (deleted) throw new Error('insert or update on table "audit_stage_runs" violates foreign key constraint "audit_stage_runs_match_id_fkey"');
        const result = await deps.setStage(runId, matchId, stage, patch);
        // Simulate Clear Slate's DELETE committing the instant P1 METRIC
        // EXECUTION finishes -- the worker is still "in flight" for every
        // stage after this one.
        if (stage === "P1 METRIC EXECUTION" && patch["status"] === "COMPLETE") deleted = true;
        return result;
      },
    };

    // The per-stage catch absorbs the write failure for every stage after
    // the deletion point -- but buildReport's own getMatch check at the end
    // of runPipeline then finds the match gone too, so the call surfaces
    // that as a thrown error rather than a false "success". Either way
    // nothing is silently recreated, which is the actual safety property.
    await expect(runPipeline(raceDeps, MATCH_ID, { budgetMs: 120_000 })).rejects.toThrow(/match\/run missing/i);

    // Nothing past P1 was ever marked complete, and no further stage was
    // ever actually processed.
    expect(stages.get("P1 METRIC EXECUTION")?.["status"]).toBe("COMPLETE");
    for (const stage of ["P2 METRIC EXECUTION", "VERIFICATION AUDIT", "FINAL DECISION", "FINAL COMBINATION GATE"] as const) {
      expect(stages.get(stage)?.["status"], stage).not.toBe("COMPLETE");
    }
    // instantiate() seeds every verification/disagreement row up front (as
    // "NOT STARTED" placeholders) well before P1 even starts, so their mere
    // presence proves nothing about whether they were processed -- what
    // must hold is that none of them ever advanced past that placeholder,
    // since VERIFICATION AUDIT/DISAGREEMENT never got to run.
    expect(tables["verification_results"]!.every((r) => r["status"] === "NOT STARTED")).toBe(true);
    expect(tables["disagreement_results"]!.every((r) => r["status"] === "NOT STARTED")).toBe(true);

    // A subsequent call for the same matchId -- a retry, a second tab, a
    // stale background job -- must refuse outright now that the match is
    // truly gone, never silently recreate it.
    await expect(runPipeline(raceDeps, MATCH_ID, { budgetMs: 120_000 })).rejects.toThrow(/not found/i);
    await expect(preparePipelineRun(raceDeps, MATCH_ID)).rejects.toThrow(/not found/i);
  }, 60_000);
});

// ----------------------------------------------------------------------------
// Run-number monotonicity across an INVALIDATED-BUT-NOT-DELETED run -- a
// separate guarantee from Clear Slate, which now hard-deletes the match
// entirely (see above) and so leaves no invalidated row for a future run to
// ever collide with. This still matters for the other, unrelated source of
// INVALIDATED_RUN_STATUS: a rule-document version change marks a still-live
// match's latest run stale in place, so it gets re-run under the new rules
// without the match itself being touched.
//
// ensureRun's new-run branch computes run_number as
// `(existing?.run_number ?? 0) + 1` from the raw latest audit_runs row --
// active or invalidated -- so it is always strictly greater than any
// run_number this match has ever had, and NEVER resets to 1 once a prior
// run exists. That monotonicity is not cosmetic: audit_runs carries a live
// UNIQUE(match_id, run_number) index in production, a rule-version change
// invalidates a run but never deletes its row, and a reset-to-1 scheme was
// found to collide with that still-present old row on the very next audit
// for every match ever revisited this way. A genuinely fresh match (no
// prior runs at all) still starts at RUN 1.
// ----------------------------------------------------------------------------
describe("Run-number monotonicity across an invalidated (not deleted) run", () => {
  it("fresh slate (no prior audit runs at all) -> new audit -> RUN 1", async () => {
    const { deps, runsById } = makeMultiRunMemoryDeps();
    const prepared = await preparePipelineRun(deps, MATCH_ID);
    expect(prepared.run_number).toBe(1);
    expect(runsById.get(prepared.id)!.run_number).toBe(1);
  });

  it("rule-document version change invalidates a run -> new audit -> run_number keeps climbing past every prior invalidated run, never colliding with one", async () => {
    const { deps, runsById } = makeMultiRunMemoryDeps();

    // Simulate several rule-version-change cycles: run to completion,
    // invalidate in place (the match itself is never touched or deleted),
    // repeat. Six prior invalidated runs must yield RUN 7 for the next
    // genuinely new audit -- a reset to RUN 1 here would try to insert a
    // duplicate (match_id, run_number) row against the still-live unique
    // constraint, since invalidation never deletes the old rows.
    let lastRunId: string | null = null;
    for (let cycle = 0; cycle < 6; cycle++) {
      const result = await runPipeline(deps, MATCH_ID, { budgetMs: 120_000 });
      expect(result.complete).toBe(true);
      lastRunId = result.runId;
      expect(runsById.get(lastRunId)!.run_number).toBe(cycle + 1);
      await deps.updateRun(lastRunId, { status: INVALIDATED_RUN_STATUS, lease_owner: null, lease_expires_at: null });
    }

    const prepared = await preparePipelineRun(deps, MATCH_ID);
    expect(prepared.id).not.toBe(lastRunId);
    expect(prepared.run_number).toBe(7);
    expect(runsById.get(prepared.id)!.run_number).toBe(7);

    // Every one of the six prior run_numbers is still occupied by an
    // invalidated (not deleted) row -- the new run's number must be disjoint
    // from all of them, reproducing the exact constraint the production
    // UNIQUE(match_id, run_number) index enforces.
    const allRunNumbers = [...runsById.values()].filter((r: any) => r.match_id === MATCH_ID).map((r: any) => r.run_number);
    expect(new Set(allRunNumbers).size).toBe(allRunNumbers.length);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// PASS-2 WRITE-BACK: a family stat may never masquerade as a different metric
// ---------------------------------------------------------------------------
//
// executeMetrics' dossier-reconstruction pass routes catalogued atomic stats
// back onto metric_results rows by evidence FAMILY. A family is a group of
// related statistics, not one measurement, so the previous "first stat in the
// family wins" rule wrote whichever member the producer happened to emit first
// as that metric's value, under a usable treatment, bypassing the field
// contract every pass-1 write already has to satisfy. Production shows the
// result: 57 of 60 metric-008 rows and 57 of 60 metric-010 rows carrying a
// BARE COUNT (0..915, 0..280) under treatment DIRECT, for two metrics whose
// declared quantity is a percentage.
describe("pass-2 dossier write-back is bound to each metric's declared field", () => {
  const CTX = { p1Name: P1, p2Name: P2, retrievedAt: "2026-04-12T00:00:00.000Z" };
  const statFor = (player: string) => (key: string, value: number, origin: "DIRECT" | "RECONSTRUCTED" = "RECONSTRUCTED") => ({
    key, value, player, origin, surface: null, window: null,
    sources: [{ source_name: `dossier reconstruction (${player})` }],
  }) as never;
  const p1Stat = statFor(P1);
  const p2Stat = statFor(P2);

  it("refuses a same-family stat that is not the metric's declared quantity (008 is a percentage, not a count)", () => {
    // Catalogue family "008" holds sets_played/sets_won/set_win_pct; Truth Engine
    // metric 008 means "deciding-set win %". A raw count is not that measurement.
    const families = new Map([["008", [p1Stat("sets_played", 915), p1Stat("sets_won", 259)]]]);
    const patch = pass2WriteBackPatch({ id: "r1", metric_code: "M08", p1_treatment: "UNAVAILABLE", p1_value: null }, "p1", families, CTX);
    expect(patch).toBeNull();
  });

  it("accepts 008's declared percentage when the dossier genuinely carries it", () => {
    const families = new Map([["008", [p1Stat("sets_played", 915), p1Stat("deciding_set_win_pct", 64.5)]]]);
    const patch = pass2WriteBackPatch({ id: "r1b", metric_code: "M08", p1_treatment: "UNAVAILABLE", p1_value: null }, "p1", families, CTX);
    expect(patch!["p1_value"]).toBe("deciding_set_win_pct=64.5");
    const [comparison] = compareMetricRows([{ metric_code: "008", p1_value: String(patch!["p1_value"]), p2_value: "deciding_set_win_pct=40", p1_treatment: "RECONSTRUCTED", p2_treatment: "DIRECT" }]);
    expect(comparison.status).toBe("COMPARED");
    expect(comparison.p1_number).toBe(64.5);
  });

  it("writes 010's declared percentage in keyed form, so the comparison layer can actually read it", () => {
    // straight_set_win_pct IS metric 010's declared fieldAlias. Persisting it keyed
    // (rather than as a bare number) is what lets COMPARISON_SPECS resolve it without
    // relying on a bareScalarFallback 010 deliberately withholds.
    const families = new Map([["010", [p2Stat("matches_won", 41), p2Stat("straight_set_win_pct", 63.2)]]]);
    const patch = pass2WriteBackPatch({ id: "r2", metric_code: "M10", p2_treatment: "UNAVAILABLE", p2_value: null }, "p2", families, CTX);
    expect(patch).not.toBeNull();
    expect(patch!["p2_value"]).toBe("straight_set_win_pct=63.2");
    expect(patch!["p2_treatment"]).toBe("RECONSTRUCTED");
    const [comparison] = compareMetricRows([{ metric_code: "010", p1_value: "straight_set_win_pct=80", p2_value: String(patch!["p2_value"]), p1_treatment: "DIRECT", p2_treatment: "RECONSTRUCTED" }]);
    expect(comparison.status).toBe("COMPARED");
    expect(comparison.p2_number).toBe(63.2);
  });

  it("refuses 010's raw count even though it shares the metric's own family", () => {
    const families = new Map([["010", [p2Stat("matches_won", 280)]]]);
    expect(pass2WriteBackPatch({ id: "r2b", metric_code: "M10", p2_treatment: "UNAVAILABLE", p2_value: null }, "p2", families, CTX)).toBeNull();
  });

  it("selects the declared field regardless of the order the producer emitted the family in", () => {
    const forwards = new Map([["001", [p1Stat("surface_elo", 1830), p1Stat("surface_win_pct", 64)]]]);
    const backwards = new Map([["001", [p1Stat("surface_win_pct", 64), p1Stat("surface_elo", 1830)]]]);
    const row = { id: "r3", metric_code: "M01", p1_treatment: "UNAVAILABLE", p1_value: null };
    const a = pass2WriteBackPatch(row, "p1", forwards, CTX);
    const b = pass2WriteBackPatch(row, "p1", backwards, CTX);
    expect(a!["p1_value"]).toBe("surface_elo=1830");
    expect(b!["p1_value"]).toBe(a!["p1_value"]);
  });

  it("never overwrites a side that already carries usable evidence with a less authoritative value", () => {
    const families = new Map([["001", [p1Stat("surface_elo", 1200)]]]);
    const patch = pass2WriteBackPatch({ id: "r4", metric_code: "M01", p1_treatment: "DIRECT", p1_value: "surface_elo=1900" }, "p1", families, CTX);
    expect(patch).toBeNull();
  });

  // ---- P1/P2 CROSS-CONTAMINATION -----------------------------------------------------
  // Every SourcedStat names the player it was extracted for; that name must resolve to the
  // side being written. Production showed 44 of 45 metric-001 rows attributing P1's number
  // to P2's source, so this is the exact axis that failed.
  it("refuses to populate P2 from a stat extracted for P1", () => {
    const families = new Map([["001", [p1Stat("surface_elo", 1830)]]]);
    expect(pass2WriteBackPatch({ id: "x1", metric_code: "M01", p2_treatment: "UNAVAILABLE", p2_value: null }, "p2", families, CTX)).toBeNull();
  });

  it("refuses to populate P1 from a stat extracted for P2", () => {
    const families = new Map([["001", [p2Stat("surface_elo", 1490)]]]);
    expect(pass2WriteBackPatch({ id: "x2", metric_code: "M01", p1_treatment: "UNAVAILABLE", p1_value: null }, "p1", families, CTX)).toBeNull();
  });

  it("picks each side's own stat when the family carries both players", () => {
    const families = new Map([["001", [p2Stat("surface_elo", 1490), p1Stat("surface_elo", 1830)]]]);
    const p1Patch = pass2WriteBackPatch({ id: "x3", metric_code: "M01", p1_treatment: "UNAVAILABLE", p1_value: null }, "p1", families, CTX);
    const p2Patch = pass2WriteBackPatch({ id: "x3", metric_code: "M01", p2_treatment: "UNAVAILABLE", p2_value: null }, "p2", families, CTX);
    expect(p1Patch!["p1_value"]).toBe("surface_elo=1830");
    expect(p2Patch!["p2_value"]).toBe("surface_elo=1490");
  });

  it("refuses the write when the stat's player cannot be attributed to one side without guessing", () => {
    // Two players sharing a surname: matchSideForName returns null rather than picking one.
    const ambiguous = { p1Name: "Alex Zverev", p2Name: "Mischa Zverev", retrievedAt: CTX.retrievedAt };
    const families = new Map([["001", [statFor("Zverev")("surface_elo", 1830)]]]);
    expect(pass2WriteBackPatch({ id: "x4", metric_code: "M01", p1_treatment: "UNAVAILABLE", p1_value: null }, "p1", families, ambiguous)).toBeNull();
  });

  // ---- PROVENANCE ---------------------------------------------------------------------
  it("merges the row's existing sources and stamps its own with the side they belong to", () => {
    const families = new Map([["001", [p2Stat("surface_elo", 1490)]]]);
    const patch = pass2WriteBackPatch(
      { id: "r5", metric_code: "M01", p2_treatment: "UNAVAILABLE", p2_value: null, sources: [{ source_name: "P1 side source", url: "https://example.test/p1", player_side: "P1" }] },
      "p2", families, CTX,
    );
    const sources = patch!["sources"] as Array<{ source_name: string; player_side?: string }>;
    // P1's provenance survives, P2's is added, and each says which side it describes.
    expect(sources).toEqual([
      { source_name: "P1 side source", url: "https://example.test/p1", player_side: "P1" },
      { source_name: `dossier reconstruction (${P2})`, player_side: "P2" },
    ]);
  });

  // ---- TERMINAL STATES ----------------------------------------------------------------
  it("never resurrects a settled EXCLUDED/NO_SOURCE row for a code the Truth Engine cannot grade", () => {
    // 042 is quarantined and 048 is META_OR_NON_PLAYER: both are instantiated settled and
    // must never be handed player evidence by any path, including this one.
    const families = new Map([["042", [p1Stat("win_pct", 60)]], ["048", [p1Stat("win_pct", 60)]]]);
    for (const code of ["M42", "M48"]) {
      expect(pass2WriteBackPatch({ id: code, metric_code: code, p1_treatment: "EXCLUDED", p1_value: null }, "p1", families, CTX)).toBeNull();
    }
  });

  it("never resurrects a terminal EXCLUDED/NO_SOURCE side even on an active, gradeable code", () => {
    // Independent of the registry: the terminal state itself is the barrier, so a future
    // reclassification cannot quietly reopen this path.
    const families = new Map([["001", [p1Stat("surface_elo", 1830)]]]);
    for (const terminal of ["EXCLUDED", "NO_SOURCE"]) {
      expect(pass2WriteBackPatch({ id: "t1", metric_code: "M01", p1_status: terminal, p1_treatment: "UNAVAILABLE", p1_value: null }, "p1", families, CTX)).toBeNull();
      expect(pass2WriteBackPatch({ id: "t2", metric_code: "M01", p1_status: "NOT STARTED", p1_treatment: terminal, p1_value: null }, "p1", families, CTX)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// WORKER RESTART MUST NOT PRODUCE P1/P2 ASYMMETRY
// ---------------------------------------------------------------------------
//
// The end-to-end counterpart to the resume-semantics unit tests above. A run is driven in
// deliberately tiny slices so the metric-execution stages time out PARTIAL and resume many
// times -- the worker-restart shape -- and both players must come out having been researched
// identically. Note this suite passes against the OLD positional cursor too: with a stable
// row set and ordering the cursor arithmetic is correct, which is exactly why the defect is
// a latent fragility rather than something the fixture reproduces. The order-independence
// unit test above is what actually distinguishes the two implementations.
describe("interrupted-and-resumed runs treat both players identically", () => {
  /** Drives the pipeline in small slices until it completes, recording every research call. */
  async function driveInSlices(budgetMs: number) {
    const { deps, tables } = makeMemoryDeps();
    const calls: Array<{ side: string; code: string }> = [];
    deps.research = {
      ...researcher,
      async metrics(input) {
        for (const metric of input.metrics) calls.push({ side: String(input.researchSide), code: String(metric.code) });
        // Real latency, so the stage deadline genuinely trips BETWEEN batches rather than
        // the whole stage fitting inside one slice. With METRIC_BATCH=15 this makes each
        // metric-execution stage go PARTIAL part-way through and resume -- the shape a
        // worker restart produces.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return researcher.metrics(input);
      },
    };
    let slices = 1;
    let result = await runPipeline(deps, MATCH_ID, { budgetMs });
    while (!result.complete && slices < 80) {
      result = await runPipeline(deps, MATCH_ID, { budgetMs });
      slices += 1;
    }
    return { deps, tables, calls, result, slices };
  }

  it("researches every eligible metric for BOTH sides across many interrupted slices", async () => {
    const { tables, calls, result, slices } = await driveInSlices(40);
    expect(result.complete).toBe(true);
    expect(slices, "the run must actually have been interrupted, or this proves nothing").toBeGreaterThan(1);

    const researchable = tables["metric_results"]!
      .filter((row) => !["EXCLUDED", "NO_SOURCE"].includes(String(row["p1_status"])) && !["EXCLUDED", "NO_SOURCE"].includes(String(row["p2_status"])))
      .map((row) => String(row["metric_code"]));
    const seen = (side: string) => new Set(calls.filter((call) => call.side === side).map((call) => call.code));
    const p1Seen = seen("p1");
    const p2Seen = seen("p2");

    // THE INVARIANT. Not "P2 got a similar number" -- exactly the same set of codes.
    expect([...p2Seen].sort()).toEqual([...p1Seen].sort());
    for (const code of researchable) {
      expect(p1Seen.has(code), `${code} was never researched for P1`).toBe(true);
      expect(p2Seen.has(code), `${code} was never researched for P2`).toBe(true);
    }
  }, 60_000);

  it("leaves no side-asymmetric evidence gap once the interrupted run settles", async () => {
    const { tables, result } = await driveInSlices(40);
    expect(result.complete).toBe(true);
    const usable = (row: Record<string, unknown>, side: "p1" | "p2") =>
      ["DIRECT", "RECONSTRUCTED", "PARTIAL"].includes(String(row[`${side}_treatment`])) && String(row[`${side}_value`] ?? "").trim() !== "";
    const oneSided = tables["metric_results"]!.filter((row) => usable(row, "p1") !== usable(row, "p2"));
    expect(oneSided.map((row) => String(row["metric_code"]))).toEqual([]);
  }, 60_000);

  it("is idempotent: re-driving a settled run researches nothing further", async () => {
    const { deps, calls, result } = await driveInSlices(300_000);
    expect(result.complete).toBe(true);
    const before = calls.length;
    for (let again = 0; again < 3; again++) await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });
    expect(calls.length).toBe(before);
  }, 60_000);

  it("a resumed slice never overwrites the other player's already-settled evidence", async () => {
    const { tables } = await driveInSlices(40);
    for (const row of tables["metric_results"]!) {
      if (["EXCLUDED", "NO_SOURCE"].includes(String(row["p1_status"]))) continue;
      // Each side ends carrying its own value, not a copy of the other's.
      if (String(row["p1_value"] ?? "") && String(row["p2_value"] ?? "")) {
        expect(String(row["p1_status"])).not.toBe("NOT STARTED");
        expect(String(row["p2_status"])).not.toBe("NOT STARTED");
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// DENOMINATOR ELIGIBILITY: only a producer's own evidenced absence may excuse
// ---------------------------------------------------------------------------
//
// metric-activation-status.ts is a correct classifier, but it can only be as right as the
// reason the pipeline persists for it. Two fallbacks in metricPairPatch used to collapse
// onto NO_SOURCE_FOUND -- which reads as SOURCE_EMPTY, one of the three denominator-excused
// statuses -- for cases that proved nothing: a provider error, and a producer that returned
// nothing and said nothing. These tests pin the persisted reason at the boundary where it is
// actually decided.
describe("metricPairPatch persists a reason that only excuses a genuinely evidenced absence", () => {
  const finding = (over: Partial<Parameters<typeof metricPairPatch>[0] & object> = {}) => ({
    metric_code: "011", p1_value: null, p2_value: null,
    p1_treatment: "UNAVAILABLE" as const, p2_treatment: "UNAVAILABLE" as const,
    differential: null, evidence_family: null, reliability: null, sample: null,
    unavailable_reason: null, sources: [], ...over,
  });
  const classify = (patch: Record<string, unknown>, side: "p1" | "p2") =>
    classifySideActivation({ executed: true, treatment: String(patch[`${side}_treatment`]), value: patch[`${side}_value`] as string | null, reason: patch[`${side}_unavailable_reason`] as string });

  it("a producer's own evidenced absence still excuses the metric", () => {
    const patch = metricPairPatch(finding({ unavailable_reason: "No source carried this metric." }), null, NOW);
    expect(patch["p1_unavailable_reason"]).toBe("NO_SOURCE_FOUND");
    expect(classify(patch, "p1")).toBe("SOURCE_EMPTY");
    expect(DENOMINATOR_EXCUSED_STATUSES.has(classify(patch, "p1"))).toBe(true);
  });

  it("an insufficient-sample answer still excuses the metric", () => {
    const patch = metricPairPatch(finding({ unavailable_reason: "Only 2 matches in the window; sample too small." }), null, NOW);
    expect(classify(patch, "p1")).toBe("INSUFFICIENT_SAMPLE");
    expect(DENOMINATOR_EXCUSED_STATUSES.has(classify(patch, "p1"))).toBe(true);
  });

  it("a provider failure cannot silently leave the denominator", () => {
    // Previously: providerError -> generic placeholder text -> unavailableReason() default
    // -> NO_SOURCE_FOUND -> SOURCE_EMPTY -> excused. A provider that errored never
    // established that the source is empty.
    const patch = metricPairPatch(finding(), "socket hang up while calling the research provider", NOW);
    expect(patch["p1_unavailable_reason"]).toBe("PRODUCER_FAILED_WITHOUT_REASON");
    expect(classify(patch, "p1")).toBe("PRODUCER_FAILURE");
    expect(DENOMINATOR_EXCUSED_STATUSES.has(classify(patch, "p1"))).toBe(false);
  });

  it("a classifiable provider failure keeps its specific reason and still stays in the denominator", () => {
    const patch = metricPairPatch(finding(), "401 Unauthorized: bad api key", NOW);
    expect(patch["p1_unavailable_reason"]).toBe("PROVIDER_AUTH_FAILED");
    expect(classify(patch, "p1")).toBe("PRODUCER_FAILURE");
    expect(DENOMINATOR_EXCUSED_STATUSES.has(classify(patch, "p1"))).toBe(false);
  });

  it("a metric with no unavailable reason at all is not automatically excused", () => {
    const patch = metricPairPatch(finding(), null, NOW);
    expect(patch["p1_unavailable_reason"]).toBe("PRODUCER_FAILED_WITHOUT_REASON");
    expect(classify(patch, "p1")).toBe("PRODUCER_FAILURE");
    expect(DENOMINATOR_EXCUSED_STATUSES.has(classify(patch, "p1"))).toBe(false);
  });

  it("classifies P1 and P2 independently from their own per-side reasons", () => {
    const patch = metricPairPatch(
      finding({ p1_unavailable_reason: "No source carried this metric.", p2_unavailable_reason: "Parser could not read the provider payload." }),
      null, NOW,
    );
    expect(classify(patch, "p1")).toBe("SOURCE_EMPTY");
    expect(classify(patch, "p2")).toBe("PARSE_FAILURE");
    // One excused side and one broken side keeps the metric IN the denominator.
    expect(classifyMetricActivation("011",
      { executed: true, treatment: "UNAVAILABLE", value: null, reason: patch["p1_unavailable_reason"] as string },
      { executed: true, treatment: "UNAVAILABLE", value: null, reason: patch["p2_unavailable_reason"] as string },
    ).countsTowardDenominator).toBe(true);
  });

  it("a field-contract miss is reported as such rather than as an empty source", () => {
    // The producer DID return a value; it just wasn't the metric's declared quantity.
    const patch = metricPairPatch(finding({ p1_value: "aces=7", p1_treatment: "DIRECT" }), null, NOW);
    expect(patch["p1_value"]).toBeNull();
    expect(patch["p1_treatment"]).toBe("UNAVAILABLE");
    expect(DENOMINATOR_EXCUSED_STATUSES.has(classify(patch, "p1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END: an evidenced absence must reach the decision record as one
// ---------------------------------------------------------------------------
describe("the persisted decision record classifies missing evidence from its real reason", () => {
  it("records an evidenced SOURCE_EMPTY absence as such, and drops it from the per-match denominator", async () => {
    const { deps, tables } = makeMemoryDeps();
    const saved: Array<Record<string, unknown>> = [];
    const baseSave = deps.saveDecision.bind(deps);
    deps.saveDecision = async (runId, existingId, payload) => { saved.push(payload); return baseSave(runId, existingId, payload); };

    // Metric 011 comes back with a real, evidenced "the source holds nothing" answer on
    // BOTH sides -- the one shape metric-activation-status.ts may legitimately excuse from
    // this match's denominator. A garbage same-family stat is also offered to the
    // reconstruction pass, which must not turn that absence into fabricated evidence.
    const baseMetrics = researcher.metrics.bind(researcher);
    deps.research = {
      ...researcher,
      async metrics(input) {
        return (await baseMetrics(input)).map((finding) =>
          String(finding.metric_code).match(/(\d{1,3})$/)?.[1]?.padStart(3, "0") === "011"
            ? { ...finding, p1_value: null, p2_value: null, p1_treatment: "UNAVAILABLE" as const, p2_treatment: "UNAVAILABLE" as const, unavailable_reason: "No source carried this metric." }
            : finding,
        );
      },
      async extractStats({ player }) {
        return [{ key: "matches_played", value: 41, player, origin: "RECONSTRUCTED" as const, surface: null, window: null, sources: [{ source_name: "dossier" }] }];
      },
    };

    await runPipeline(deps, MATCH_ID, { budgetMs: 300_000 });

    const row = tables["metric_results"]!.find((r) => String(r["metric_code"]) === "M11")!;
    expect(row["p1_value"]).toBeNull();
    expect(row["p1_treatment"]).toBe("UNAVAILABLE");
    expect(row["p1_unavailable_reason"]).toBe("NO_SOURCE_FOUND");

    const record = saved.at(-1)!["gate_report"] as { deterministic_decision: TruthEngineDecisionRecord };
    const activation = record.deterministic_decision.metric_activation.find((entry) => entry.code === "011")!;
    // Before this fix the reason columns never reached the classifier, so every
    // unusable side -- however honestly it failed -- was filed PRODUCER_FAILURE and the
    // "dynamic" denominator could never differ from the fixed 25 for any match.
    expect(activation.p1_status).toBe("SOURCE_EMPTY");
    expect(activation.p2_status).toBe("SOURCE_EMPTY");
    expect(activation.counts_toward_denominator).toBe(false);
    expect(record.deterministic_decision.evidence_coverage_eligible).toBeLessThan(record.deterministic_decision.evidence_coverage_expected);
  }, 60_000);
});
