// DETERMINISTIC COMPLETION ENGINE
// Application logic — never AI text — decides completion, gate outcome and color.

import { classifyMetric } from "./metric-classification";
import { FINAL_STAGE, unmetDependencies, type StageStatusRow } from "./audit-stages";

export const DONE_STATES = ["COMPLETE", "UNAVAILABLE", "EXCLUDED", "NO_SOURCE"];

// Task 20/21 reconciliation: a META_OR_NON_PLAYER code's row is initially instantiated
// with treatment/status "EXCLUDED" (see audit-pipeline.ts's isProcessMetaRuleCode), but
// several legitimate downstream meta-analysis writers (meta-derived-evidence.server.ts,
// final-advanced-meta.server.ts) later overwrite that same row's p1_treatment/
// p2_treatment/status once other stages complete -- to PARTIAL/RECONSTRUCTED/COMPLETE,
// never back to EXCLUDED -- so a code could silently re-enter the coverage denominator
// after instantiation despite never carrying player evidence. Deriving exclusion from the
// metric's own code identity here, rather than trusting whatever treatment value a row
// happens to carry, closes that silent-re-entry path for good: no downstream writer can
// ever cause a META_OR_NON_PLAYER code to count toward coverage, regardless of what it sets.
function isProcessMetaCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const match = String(code).match(/(\d{1,3})$/);
  const normalized = match ? match[1].padStart(3, "0") : String(code).padStart(3, "0");
  return classifyMetric(normalized) === "META_OR_NON_PLAYER";
}

// A code with a real, documented determination that no legitimate obtainable/
// reconstructable evidence pathway exists (see PROTECTED_UNAVAILABLE_RECORDS in
// metric-classification.ts) is also excluded from the coverage denominator, the same
// way and for the same silent-re-entry-proof reason as META_OR_NON_PLAYER above -- but
// tracked as its own distinct bucket, never merged into "excluded", so the two remain
// separately auditable. UNKNOWN_REQUIRES_REVIEW codes are deliberately NOT covered here.
// MATRIX_SUMMARY_REQUIRED codes are treated identically HERE, and for the same
// silent-re-entry-proof reason: a code quarantined pending real Tennis Matrix AI
// Summary evidence must contribute no active audit weight, so it is subtracted from
// the coverage denominator by code identity rather than by whatever treatment a row
// happens to carry. It is counted in the same `noSource` bucket for denominator
// purposes only -- the two remain separately auditable through
// metric-classification.ts (MATRIX_SUMMARY_REQUIRED_CODES vs
// PROTECTED_UNAVAILABLE_CODES) and through each row's own distinct
// unavailable_reason, and a quarantine is reversible where a protected determination
// is not.
function isNoSourceMetricCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const match = String(code).match(/(\d{1,3})$/);
  const normalized = match ? match[1].padStart(3, "0") : String(code).padStart(3, "0");
  const classification = classifyMetric(normalized);
  return classification === "PROTECTED_UNAVAILABLE" || classification === "MATRIX_SUMMARY_REQUIRED";
}

export interface Countable {
  status: string;
}

export interface EngineInput {
  match: {
    identity_status: string;
    surface_status: string;
    player1_name: string;
    player2_name: string;
  };
  run: {
    research_lock_at: string | null;
    independent_decision_committed_at: string | null;
    matrix_revealed_at: string | null;
    independent_winner: string | null;
    independent_low: number | null;
    independent_high: number | null;
    calibration_version_id: string | null;
    effective_evidence_count: number;
  };
  metrics: Array<{
    status: string;
    p1_status: string;
    p2_status: string;
    p1_treatment?: string | null;
    p2_treatment?: string | null;
    matrix_derived: boolean;
    evidence_family: string | null;
    metric_name?: string | null;
    metric_code?: string | null;
    p1_value?: string | null;
    p2_value?: string | null;
    sources?: unknown;
  }>;
  verification: Array<{ status: string; outcome: string; severity: string | null }>;
  disagreement: Array<{ status: string; contradiction_severity: string | null }>;
  underdog: Array<{ status: string; classification: string; player_side: string }>;
  stress: Array<{ status: string; test_code: string; outcome: string }>;
  reconstructions: Array<{ status: string }>;
  conflicts: Array<{ critical: boolean; resolution_status: string }>;
  matrixWp: number | null;
  // The actual audit_stage_runs rows for this run (stage + status only).
  // Required, not optional: without this, "auditComplete" could only ever be
  // derived from child-row states (metrics/verification/etc.), which is
  // exactly the double-bookkeeping gap that let the Final Combination Gate
  // (and any check downstream of it) appear complete while audit_stage_runs
  // itself still showed an upstream stage unexecuted. Every caller must
  // supply the real, currently-persisted stage statuses.
  stages: StageStatusRow[];
}

export interface CountPair {
  done: number;
  total: number;
}

export interface GateReport {
  counts: {
    metrics: CountPair;
    p1: CountPair;
    p2: CountPair;
    verification: CountPair;
    disagreement: CountPair;
    underdog: CountPair;
    stress: CountPair;
    reconstructions: CountPair;
    criticalConflicts: CountPair;
  };
  checks: Array<{ key: string; label: string; pass: boolean; detail: string }>;
  completionPercent: number;
  // Row/run-derived substantive completeness (identity resolved, metrics
  // swept, conclusion committed, calibration applied, etc.) -- unchanged
  // meaning from before the 16-stage model. Does NOT by itself guarantee
  // every audit_stage_runs row is persisted COMPLETE; see `stagesComplete`.
  auditComplete: boolean;
  // Every stage STAGE_DEPENDENCIES requires ahead of the Final Combination
  // Gate that is not currently persisted COMPLETE in audit_stage_runs. Empty
  // means every required upstream stage has actually executed and persisted
  // COMPLETE for this audit_run_id -- the execution-state counterpart to
  // `auditComplete`'s row-derived signal. The Final Combination Gate (and
  // only the Final Combination Gate) must require both `auditComplete` and
  // `stagesComplete` before it may report COMPLETE.
  stageGaps: string[];
  stagesComplete: boolean;
  matrixFirewallValid: boolean;
  effectiveEvidenceCount: number;
  coverage: {
    p1: CoverageReport;
    p2: CoverageReport;
    usablePercent: number;
    thresholdPercent: number;
  };
  greenLocked: boolean;
  greenLockReasons: string[];
  color: "DOUBLE GREEN" | "GREEN" | "YELLOW" | "RED / PASS" | "INSUFFICIENT EVIDENCE" | "INCOMPLETE";
  action: string;
}

export interface CoverageReport {
  direct: number;
  reconstructed: number;
  partial: number;
  unavailable: number;
  excluded: number;
  noSource: number;
  total: number;
  usablePercent: number;
  statuses: Array<"DIRECT" | "RECONSTRUCTED" | "PARTIAL" | "UNAVAILABLE" | "EXCLUDED" | "NO_SOURCE">;
}

const pair = (rows: Countable[]): CountPair => ({
  done: rows.filter((r) => DONE_STATES.includes(r.status)).length,
  total: rows.length,
});

const full = (p: CountPair) => p.total > 0 && p.done === p.total;
const COVERAGE_THRESHOLD = 70;

function coverageFor(metrics: EngineInput["metrics"], side: "p1" | "p2"): CoverageReport {
  const statuses = metrics.map((metric) => {
    if (isProcessMetaCode(metric.metric_code)) return "EXCLUDED" as const;
    if (isNoSourceMetricCode(metric.metric_code)) return "NO_SOURCE" as const;
    const treatment = side === "p1" ? (metric.p1_treatment ?? metric.p1_status) : (metric.p2_treatment ?? metric.p2_status);
    const hasEvidenceColumns=Object.prototype.hasOwnProperty.call(metric,`${side}_value`)||Object.prototype.hasOwnProperty.call(metric,"sources");
    const sideValue=side==="p1"?metric.p1_value:metric.p2_value;
    const backed=!hasEvidenceColumns||Boolean(String(sideValue??"").trim()&&Array.isArray(metric.sources)&&metric.sources.some(source=>source&&typeof source==="object"&&String((source as {source_name?:unknown}).source_name??"").trim()));
    const value=["DIRECT","RECONSTRUCTED","PARTIAL"].includes(treatment)&&!backed?"UNAVAILABLE":treatment;
    return ["DIRECT", "RECONSTRUCTED", "PARTIAL", "UNAVAILABLE", "EXCLUDED", "NO_SOURCE"].includes(value)
      ? (value as CoverageReport["statuses"][number])
      : "UNAVAILABLE";
  });
  const count = (status: CoverageReport["statuses"][number]) => statuses.filter((value) => value === status).length;
  const excluded = count("EXCLUDED");
  const noSource = count("NO_SOURCE");
  const denominator = metrics.length - excluded - noSource;
  const usable = count("DIRECT") + count("RECONSTRUCTED") + count("PARTIAL");
  return {
    direct: count("DIRECT"),
    reconstructed: count("RECONSTRUCTED"),
    partial: count("PARTIAL"),
    unavailable: count("UNAVAILABLE"),
    excluded,
    noSource,
    total: metrics.length,
    usablePercent: denominator > 0 ? Number(((usable / denominator) * 100).toFixed(1)) : 0,
    statuses,
  };
}

function explicitEvidenceFamily(metric: EngineInput["metrics"][number]) {
  const family = String(metric.evidence_family ?? "").trim();
  const defaultName = String(metric.metric_name ?? "").trim();
  // Definition instantiation initially stores metric_name in evidence_family as
  // a placeholder. That does not prove independence. Only explicit lineage set
  // by a researcher/reconstructor may enter the independent-family count.
  return family && family !== defaultName ? family : null;
}

export function evaluate(input: EngineInput): GateReport {
  const { match, run } = input;

  const metrics: CountPair = {
    done: input.metrics.filter((m) => DONE_STATES.includes(m.p1_status) && DONE_STATES.includes(m.p2_status)).length,
    total: input.metrics.length,
  };
  const p1: CountPair = {
    done: input.metrics.filter((m) => DONE_STATES.includes(m.p1_status)).length,
    total: input.metrics.length,
  };
  const p2: CountPair = {
    done: input.metrics.filter((m) => DONE_STATES.includes(m.p2_status)).length,
    total: input.metrics.length,
  };
  const verification = pair(input.verification);
  const disagreement = pair(input.disagreement);
  const underdog = pair(input.underdog);
  const stress = pair(input.stress);
  const reconstructions = pair(input.reconstructions);
  const criticalConflicts: CountPair = {
    total: input.conflicts.filter((c) => c.critical).length,
    done: input.conflicts.filter((c) => c.critical && c.resolution_status.startsWith("RESOLVED")).length,
  };

  // Effective independent evidence: collapse correlated families, never count
  // Matrix-derived signals, and ignore placeholder metric-name families.
  const families = new Set<string>();
  input.metrics.forEach((m) => {
    if (m.matrix_derived) return;
    const processed = DONE_STATES.includes(m.p1_status) && DONE_STATES.includes(m.p2_status);
    if (!processed) return;
    const usableTreatment = (t: string | null | undefined) => ["DIRECT", "RECONSTRUCTED", "PARTIAL"].includes(String(t ?? ""));
    if (!usableTreatment(m.p1_treatment) && !usableTreatment(m.p2_treatment)) return;
    const family = explicitEvidenceFamily(m);
    if (family) families.add(family);
  });
  const effectiveEvidenceCount = families.size;
  const p1Coverage = coverageFor(input.metrics, "p1");
  const p2Coverage = coverageFor(input.metrics, "p2");
  const usableCoveragePercent = Number(Math.min(p1Coverage.usablePercent, p2Coverage.usablePercent).toFixed(1));
  const lowCoverage = usableCoveragePercent < COVERAGE_THRESHOLD;

  const firewallValid =
    !run.matrix_revealed_at ||
    (!!run.independent_decision_committed_at &&
      new Date(run.matrix_revealed_at).getTime() >= new Date(run.independent_decision_committed_at).getTime());

  const matrixRemoval = input.stress.filter((s) => s.test_code === "ST01" || s.test_code === "ST02");
  const matrixRemovalSurvived =
    matrixRemoval.length > 0 &&
    matrixRemoval.every((s) => s.status === "COMPLETE" && (s.outcome === "STABLE" || s.outcome === "MOSTLY STABLE"));
  // A stress test only carries a finding when it actually executed. Its `status` is the
  // execution state; `outcome` is only meaningful alongside a COMPLETE status (see
  // STRESS_OUTCOME_NOT_EVALUATED in truth-engine-stage-mapping.ts).
  const stressActuallyEvaluated = input.stress.filter((s) => s.status === "COMPLETE");
  const familyRemoval = input.stress.find((s) => s.test_code === "ST03");
  const familyRemovalSurvived =
    !!familyRemoval && familyRemoval.status === "COMPLETE" && familyRemoval.outcome !== "FAILS";

  const strongUnderdogPathways = input.underdog.filter(
    (u) => u.classification === "STRONG" && u.player_side !== (run.independent_winner ?? ""),
  ).length;
  const unresolvedCritical =
    input.verification.some((v) => v.outcome === "FAIL" && v.severity === "CRITICAL") ||
    input.disagreement.some((d) => d.contradiction_severity === "CRITICAL");

  // The actual dependency-ordered state machine check: every stage
  // STAGE_DEPENDENCIES requires ahead of the Final Combination Gate (i.e.
  // every other stage in the pipeline) must be persisted COMPLETE in
  // audit_stage_runs, independent of whatever the child-row counts below
  // say. Deliberately kept OUT of `checks`/`auditComplete` below: those two
  // intermediate stages (Coverage Persistence, Final Decision) are
  // themselves part of the Final Combination Gate's own dependency prefix,
  // so folding "every stage up to and including the gate's prerequisites is
  // COMPLETE" into `auditComplete` would make it impossible for either of
  // them to ever see itself as done while deciding its OWN completion (it
  // would always be waiting on itself). `auditComplete` therefore stays the
  // original, row/run-derived "is the audit substantively complete" signal;
  // `stagesComplete`/`stageGaps` is the separate, execution-state signal that
  // ONLY the Final Combination Gate stage (never an intermediate stage) may
  // additionally require before completing.
  const stageGaps = unmetDependencies(FINAL_STAGE, input.stages);
  const stagesComplete = stageGaps.length === 0;
  // FINAL DECISION is, structurally, always "the stage currently running" at the one
  // call site that matters for color/greenLockReasons (commitFinalDecision calls this
  // function from inside its own execution, before its own row is written back as
  // COMPLETE) -- so it is never a genuine gap for THAT purpose, only ever a snapshot
  // artifact. `stageGaps`/`stagesComplete` above stay the real, unfiltered signal for
  // finalGate's own completion check, which runs after FINAL DECISION truly has
  // completed and so is unaffected either way.
  const colorRelevantStageGaps = stageGaps.filter((stage) => stage !== "FINAL DECISION");
  const colorStagesComplete = colorRelevantStageGaps.length === 0;

  const checks = [
    { key: "identity", label: "Match identity resolved to a terminal state", pass: ["VERIFIED", "UNVERIFIED", "UNAVAILABLE"].includes(match.identity_status), detail: match.identity_status },
    { key: "surface", label: "Surface verified or unavailable", pass: ["VERIFIED", "UNAVAILABLE"].includes(match.surface_status), detail: match.surface_status },
    { key: "lock", label: "Pre-match research lock set", pass: !!run.research_lock_at, detail: run.research_lock_at ?? "not locked" },
    { key: "conflicts", label: "Critical source conflicts resolved", pass: criticalConflicts.done === criticalConflicts.total, detail: `${criticalConflicts.done}/${criticalConflicts.total}` },
    { key: "p1", label: "Player 1 metric sweep complete", pass: full(p1), detail: `${p1.done}/${p1.total}` },
    { key: "p2", label: "Player 2 metric sweep complete", pass: full(p2), detail: `${p2.done}/${p2.total}` },
    { key: "recon", label: "Reconstructions resolved", pass: reconstructions.total === 0 || full(reconstructions), detail: `${reconstructions.done}/${reconstructions.total}` },
    { key: "verification", label: "Verification Audit complete", pass: full(verification), detail: `${verification.done}/${verification.total}` },
    { key: "disagreement", label: "Disagreement / Trap Audit complete", pass: full(disagreement), detail: `${disagreement.done}/${disagreement.total}` },
    { key: "underdog", label: "Dangerous Underdog Audit complete", pass: full(underdog), detail: `${underdog.done}/${underdog.total}` },
    { key: "stress", label: "Stress / removal tests complete", pass: full(stress), detail: `${stress.done}/${stress.total}` },
    { key: "committed", label: "Independent conclusion committed", pass: !!run.independent_decision_committed_at, detail: run.independent_winner ?? "INSUFFICIENT EVIDENCE" },
    { key: "firewall", label: "Matrix firewall respected", pass: firewallValid, detail: firewallValid ? "VALID" : "VIOLATED" },
    { key: "reveal", label: "Matrix comparison complete", pass: !!run.matrix_revealed_at, detail: run.matrix_revealed_at ?? "not revealed" },
    { key: "calibration", label: "Current calibration applied", pass: !!run.calibration_version_id, detail: run.calibration_version_id ? "COMPLETE" : "INCOMPLETE" },
  ];

  const auditComplete = checks.every((c) => c.pass);
  const completionPercent = Number(((checks.filter((c) => c.pass).length / checks.length) * 100).toFixed(1));

  const greenLockReasons: string[] = [];
  if (!auditComplete) greenLockReasons.push("Required stages incomplete");
  if (!colorStagesComplete) greenLockReasons.push(`Pipeline execution incomplete: ${colorRelevantStageGaps.join(", ")}`);
  if (!firewallValid) greenLockReasons.push("Matrix firewall violated");
  if (!matrixRemovalSurvived) greenLockReasons.push("GREEN LOCKED — Matrix-removal test not survived");
  if (!familyRemovalSurvived) greenLockReasons.push("Strongest-family removal not survived");
  if (!full(underdog)) greenLockReasons.push("Dangerous Underdog audit incomplete");
  if (effectiveEvidenceCount < 3) greenLockReasons.push(`Effective independent evidence families = ${effectiveEvidenceCount} (min 3)`);
  if (lowCoverage) greenLockReasons.push(`Usable metric coverage = ${usableCoveragePercent}% (min ${COVERAGE_THRESHOLD}%)`);
  if (strongUnderdogPathways >= 2) greenLockReasons.push("Multiple STRONG opposing underdog pathways");
  if (unresolvedCritical) greenLockReasons.push("Unresolved CRITICAL contradiction");
  if (input.matrixWp !== null && input.matrixWp <= 55) greenLockReasons.push("No-edge floor: favorite probability ≤55%");

  // color/action are computed from `auditComplete` alone, deliberately NOT from
  // `stagesComplete`. `stagesComplete` asks whether audit_stage_runs shows every
  // stage up to and including FINAL COMBINATION GATE itself persisted COMPLETE --
  // but this function is called from INSIDE the FINAL DECISION stage's own
  // execution (commitFinalDecision, audit-pipeline.ts), before that stage's own
  // row has been written back as COMPLETE. Since STAGE_DEPENDENCIES makes FINAL
  // COMBINATION GATE depend on every prior stage including FINAL DECISION itself,
  // stagesComplete is UNCONDITIONALLY false at that exact moment, for every run,
  // regardless of how complete the actual evidence is -- gating color on it here
  // froze every persisted final_decisions row at color=INCOMPLETE, action=
  // "CONTINUE PROCESSING" forever, even for a fully-executed, 60%-corroborated,
  // stable decision. `stagesComplete`/`stageGaps` remain on the returned report
  // for callers that legitimately need them: finalGate (the stage that actually
  // runs after FINAL DECISION completes, and so sees them accurately) still
  // requires both before letting the pipeline call itself done, and
  // "Pipeline execution incomplete" still surfaces as a YELLOW-lock reason below
  // for the genuine case of an earlier stage's row lagging its own data.
  // color is gated on `!run.independent_winner` alone -- deliberately NOT on
  // `lowCoverage`. `run.independent_winner` (and, identically, the deterministic
  // decision persisted in gate_report.deterministic_decision.selected_player) is
  // the actual Truth Engine authority: it comes from the 25-active-metric family-
  // consolidated, verification/disagreement/underdog/stress-audited, >=60%-
  // directional-support decision. `lowCoverage`/`usableCoveragePercent`, by
  // contrast, is `coverageFor()`'s reading of ALL 81 processing-universe codes --
  // including the 56 the Truth Engine deliberately does not rely on -- and is
  // near-guaranteed to read low for any match, since most of those 56 stay
  // UNAVAILABLE simply because nothing researches them anymore. Gating color on
  // it here let the inactive 56 indirectly veto a decision they never participate
  // in: real case, Mathys Erhard vs Anton Shepp, Truth Engine selected Erhard at
  // 60% directional support while this gate's 81-code coverage read 43.8%, and
  // the persisted color/action came out "INSUFFICIENT EVIDENCE" despite a real
  // winner already existing. Coverage remains fully diagnostic below (reported on
  // `coverage`, and still able to withhold GREEN/DOUBLE GREEN via
  // greenLockReasons) -- it can make a real winner read YELLOW instead of GREEN,
  // but it can never turn one into "no winner".
  let color: GateReport["color"] = "INCOMPLETE";
  if (!auditComplete) {
    color = "INCOMPLETE";
  } else if (!run.independent_winner) {
    color = "INSUFFICIENT EVIDENCE";
  } else if (unresolvedCritical || strongUnderdogPathways >= 2 || !matrixRemovalSurvived || (input.matrixWp !== null && input.matrixWp <= 55)) {
    color = "RED / PASS";
  } else if (greenLockReasons.length > 0) {
    color = "YELLOW";
  } else if (
    effectiveEvidenceCount >= 5 &&
    // "Every stress test came back STABLE" ranges over the tests that ACTUALLY RAN. The rule
    // is unchanged; what changed is that a test which produced no result is no longer counted
    // as a failed one. ST04/ST08/ST09/ST10 cannot be evaluated from the active metric set at
    // all, so including their non-results here made DOUBLE GREEN unreachable for every match
    // in every circumstance -- a rule no evidence could ever satisfy is not a rule. The
    // `length > 0` guard keeps the opposite failure closed: a stress stage where nothing ran
    // cannot vacuously satisfy the requirement.
    stressActuallyEvaluated.length > 0 &&
    stressActuallyEvaluated.every((s) => s.outcome === "STABLE") &&
    strongUnderdogPathways === 0 &&
    !input.underdog.some((u) => u.classification === "UNRESOLVED")
  ) {
    color = "DOUBLE GREEN";
  } else {
    color = "GREEN";
  }

  const action =
    color === "DOUBLE GREEN" || color === "GREEN"
      ? `PLAY — ${run.independent_winner ?? ""}`
      : color === "YELLOW"
        ? "MONITOR / REDUCE"
        : color === "RED / PASS"
          ? "PASS"
          : color === "INSUFFICIENT EVIDENCE"
            ? "INSUFFICIENT EVIDENCE"
          : "CONTINUE PROCESSING";

  return {
    counts: { metrics, p1, p2, verification, disagreement, underdog, stress, reconstructions, criticalConflicts },
    checks,
    completionPercent,
    auditComplete,
    stageGaps,
    stagesComplete,
    matrixFirewallValid: firewallValid,
    effectiveEvidenceCount,
    coverage: { p1: p1Coverage, p2: p2Coverage, usablePercent: usableCoveragePercent, thresholdPercent: COVERAGE_THRESHOLD },
    greenLocked: greenLockReasons.length > 0,
    greenLockReasons,
    color,
    action,
  };
}

export function bucketFor<T extends { wp_min: number; wp_max: number }>(wp: number | null | undefined, buckets: T[]): T | null {
  if (wp === null || wp === undefined) return null;
  return buckets.find((b) => wp >= b.wp_min && wp <= b.wp_max) ?? null;
}

export function winRate(wins: number, graded: number) {
  return graded === 0 ? null : Number(((wins / graded) * 100).toFixed(1));
}
