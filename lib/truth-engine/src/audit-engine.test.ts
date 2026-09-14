import { describe, expect, it, vi } from "vitest";
import { evaluate, type EngineInput } from "./audit-engine";
import { STAGES } from "./audit-stages";

// To test the NO_SOURCE mechanism itself (distinct bucket, excluded from the
// denominator, immune to the same silent-re-entry pattern as META_OR_NON_PLAYER)
// without depending on which real codes are PROTECTED_UNAVAILABLE, mock classifyMetric
// to treat one specific code ("999", not a real catalog code) as PROTECTED_UNAVAILABLE
// for this test file only.
vi.mock("./metric-classification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metric-classification")>();
  return { ...actual, classifyMetric: (code: string | null | undefined) => (code === "999" ? "PROTECTED_UNAVAILABLE" : actual.classifyMetric(String(code ?? ""))) };
});

const baseRun: EngineInput["run"] = {
  research_lock_at: null,
  independent_decision_committed_at: null,
  matrix_revealed_at: null,
  independent_winner: null,
  independent_low: null,
  independent_high: null,
  calibration_version_id: null,
  effective_evidence_count: 0,
};
const baseMatch: EngineInput["match"] = {
  identity_status: "VERIFIED",
  surface_status: "VERIFIED",
  player1_name: "Alpha",
  player2_name: "Beta",
};

// All 13 pipeline stages persisted COMPLETE -- the default fixture for tests
// that are exercising coverage/treatment math, not the stage-dependency gate
// itself (that gate has its own dedicated describe block below).
const ALL_STAGES_COMPLETE: EngineInput["stages"] = STAGES.map((stage) => ({ stage, status: "COMPLETE" }));

function input(metrics: EngineInput["metrics"]): EngineInput {
  return {
    match: baseMatch,
    run: baseRun,
    metrics,
    verification: [],
    disagreement: [],
    underdog: [],
    stress: [],
    reconstructions: [],
    conflicts: [],
    matrixWp: null,
    stages: ALL_STAGES_COMPLETE,
  };
}

describe("audit-engine coverage: META_OR_NON_PLAYER silent-re-entry guard", () => {
  // Task 20/21 reconciliation, regression test: real code "057" ("Evidence Freshness &
  // Confirmation") is META_OR_NON_PLAYER and must never count toward the player-evidence
  // coverage denominator (Decision 1). meta-derived-evidence.server.ts legitimately
  // writes a descriptive meta-analysis value into this same row and, in doing so, also
  // overwrites p1_treatment/p2_treatment/status away from "EXCLUDED" (to PARTIAL/
  // COMPLETE) -- this is exactly the kind of silent re-entry Decision 1 asked to be
  // guarded against. coverageFor() must derive exclusion from the metric's own code
  // identity (classifyMetric), not from whatever treatment a downstream writer
  // happens to have set, so this can never slip back into the denominator.
  it("keeps a META_OR_NON_PLAYER code excluded even after a downstream writer overwrites its treatment away from EXCLUDED", () => {
    const metrics: EngineInput["metrics"] = [
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false, evidence_family: "RESULTS_SCHEDULE", metric_name: "Set Profile", metric_code: "008" },
      { status: "UNAVAILABLE", p1_status: "UNAVAILABLE", p2_status: "UNAVAILABLE", p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE", matrix_derived: false, evidence_family: null, metric_name: "Common-Opponent Network", metric_code: "007" },
      // Simulates meta-derived-evidence.server.ts's post-instantiate write: p1/p2
      // treatment flipped to PARTIAL and status flipped to COMPLETE for a META_OR_NON_PLAYER
      // code that was originally instantiated as EXCLUDED.
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL", matrix_derived: false, evidence_family: null, metric_name: "Evidence Freshness & Confirmation", metric_code: "057" },
    ];
    const report = evaluate(input(metrics));
    expect(report.coverage.p1.excluded).toBe(1);
    expect(report.coverage.p1.total).toBe(3);
    // Denominator is 2 (008 + 007), not 3; only 008 is usable -> 50%, not the ~66.7%
    // a silently re-entered 057 (as PARTIAL) would produce.
    expect(report.coverage.p1.usablePercent).toBe(50);
    expect(report.coverage.p1.statuses).toEqual(["DIRECT", "UNAVAILABLE", "EXCLUDED"]);
    expect(report.coverage.p2.statuses).toEqual(["DIRECT", "UNAVAILABLE", "EXCLUDED"]);
  });

  it("still counts a real LEGITIMATE_PLAYER_METRIC code as its actual treatment, never as EXCLUDED", () => {
    const metrics: EngineInput["metrics"] = [
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED", matrix_derived: false, evidence_family: "POINT_BY_POINT", metric_name: "Momentum & Closing Metrics", metric_code: "018" },
    ];
    const report = evaluate(input(metrics));
    expect(report.coverage.p1.excluded).toBe(0);
    expect(report.coverage.p1.reconstructed).toBe(1);
    expect(report.coverage.p1.usablePercent).toBe(100);
  });

  it("treats a row with no metric_code exactly as before (backward compatible)", () => {
    const metrics: EngineInput["metrics"] = [
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false, evidence_family: "MARKET", metric_name: "legacy row" },
    ];
    const report = evaluate(input(metrics));
    expect(report.coverage.p1.excluded).toBe(0);
    expect(report.coverage.p1.direct).toBe(1);
  });
});

describe("audit-engine coverage: NO_SOURCE denominator-eligibility bucket", () => {
  // Denominator-eligibility audit, requested directly: a code with a documented
  // determination that no legitimate evidence pathway exists is excluded from the
  // coverage denominator like META_OR_NON_PLAYER, but tracked as its own distinct bucket --
  // never merged into "excluded" -- so the two stay separately auditable. classifyMetric
  // is mocked above to treat code "999" as PROTECTED_UNAVAILABLE for this test file only.
  it("excludes a NO_SOURCE code from the denominator as its own bucket, distinct from EXCLUDED", () => {
    const metrics: EngineInput["metrics"] = [
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false, evidence_family: "RESULTS_SCHEDULE", metric_name: "Set Profile", metric_code: "008" },
      { status: "UNAVAILABLE", p1_status: "UNAVAILABLE", p2_status: "UNAVAILABLE", p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE", matrix_derived: false, evidence_family: null, metric_name: "Common-Opponent Network", metric_code: "007" },
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL", matrix_derived: false, evidence_family: null, metric_name: "mocked no-source code", metric_code: "999" },
    ];
    const report = evaluate(input(metrics));
    expect(report.coverage.p1.excluded).toBe(0);
    expect(report.coverage.p1.noSource).toBe(1);
    expect(report.coverage.p1.total).toBe(3);
    // Denominator is 2 (008 + 007), not 3; only 008 is usable -> 50%.
    expect(report.coverage.p1.usablePercent).toBe(50);
    expect(report.coverage.p1.statuses).toEqual(["DIRECT", "UNAVAILABLE", "NO_SOURCE"]);
  });

  it("keeps a NO_SOURCE code out of the denominator even after a downstream writer overwrites its treatment (same silent-re-entry guard as META_OR_NON_PLAYER)", () => {
    const metrics: EngineInput["metrics"] = [
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "RECONSTRUCTED", p2_treatment: "RECONSTRUCTED", matrix_derived: false, evidence_family: "POINT_BY_POINT", metric_name: "real code", metric_code: "018" },
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false, evidence_family: null, metric_name: "mocked no-source code, overwritten downstream", metric_code: "999" },
    ];
    const report = evaluate(input(metrics));
    expect(report.coverage.p1.noSource).toBe(1);
    expect(report.coverage.p1.excluded).toBe(0);
    // Denominator is 1 (018 only) -> 100%, not the 100% two-usable-of-two would also
    // give, so also check total/reconstructed directly to prove 999 didn't just get counted.
    expect(report.coverage.p1.total).toBe(2);
    expect(report.coverage.p1.reconstructed).toBe(1);
  });

  it("both META_OR_NON_PLAYER and NO_SOURCE can coexist and are both excluded, distinctly counted", () => {
    const metrics: EngineInput["metrics"] = [
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false, evidence_family: "RESULTS_SCHEDULE", metric_name: "Set Profile", metric_code: "008" },
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL", matrix_derived: false, evidence_family: null, metric_name: "Evidence Freshness & Confirmation", metric_code: "057" },
      { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "PARTIAL", p2_treatment: "PARTIAL", matrix_derived: false, evidence_family: null, metric_name: "mocked no-source code", metric_code: "999" },
    ];
    const report = evaluate(input(metrics));
    expect(report.coverage.p1.excluded).toBe(1);
    expect(report.coverage.p1.noSource).toBe(1);
    expect(report.coverage.p1.total).toBe(3);
    expect(report.coverage.p1.usablePercent).toBe(100);
  });
});

describe("audit-engine terminal identity outcomes", () => {
  it("completes an UNVERIFIED identity audit as insufficient evidence instead of blocking the final gate", () => {
    const report = evaluate({
      match: { ...baseMatch, identity_status: "UNVERIFIED" },
      run: {
        ...baseRun,
        research_lock_at: "2026-08-30T03:30:00.000Z",
        independent_decision_committed_at: "2026-08-30T03:31:00.000Z",
        matrix_revealed_at: "2026-08-30T03:32:00.000Z",
        calibration_version_id: "calibration-v1",
      },
      metrics: [
        {
          status: "UNAVAILABLE",
          p1_status: "UNAVAILABLE",
          p2_status: "UNAVAILABLE",
          p1_treatment: "UNAVAILABLE",
          p2_treatment: "UNAVAILABLE",
          matrix_derived: false,
          evidence_family: null,
          metric_name: "Unavailable metric",
          metric_code: "007",
          p1_value: null,
          p2_value: null,
          sources: [],
        },
      ],
      verification: [{ status: "COMPLETE", outcome: "UNAVAILABLE", severity: "STANDARD" }],
      disagreement: [{ status: "COMPLETE", contradiction_severity: "NONE" }],
      underdog: [{ status: "COMPLETE", classification: "UNRESOLVED", player_side: "Alpha" }],
      stress: [{ status: "COMPLETE", test_code: "ST01", outcome: "STABLE" }],
      reconstructions: [],
      conflicts: [],
      matrixWp: null,
      stages: ALL_STAGES_COMPLETE,
    });

    expect(report.auditComplete).toBe(true);
    expect(report.completionPercent).toBe(100);
    expect(report.color).toBe("INSUFFICIENT EVIDENCE");
    expect(report.checks.find((check) => check.key === "identity")).toMatchObject({
      pass: true,
      detail: "UNVERIFIED",
    });
  });
});

describe("audit-engine: Final Combination Gate stage-dependency gate", () => {
  // Regression coverage for the audit pipeline's dependency-ordered state
  // machine. Two separate signals now compose gate completion:
  //   - `auditComplete`: the original row/run-derived "is the audit
  //     substantively complete" signal (identity resolved, metrics swept,
  //     conclusion committed, calibration applied, etc.) -- unaffected by
  //     `stages`, since Coverage Persistence and Final Decision are
  //     themselves part of the Final Combination Gate's own dependency
  //     prefix and can never be complete while THEY are being evaluated.
  //   - `stagesComplete`/`stageGaps`: whether every audit_stage_runs row this
  //     run needs is ACTUALLY persisted COMPLETE, independent of what the
  //     child-row counts say. This is what closes the double-bookkeeping gap
  //     that let the gate appear complete while audit_stage_runs still
  //     showed an upstream stage unexecuted.
  // The Final Combination Gate stage in audit-pipeline.ts requires BOTH.
  const fullRows = (): EngineInput["metrics"] => [
    { status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE", p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false, evidence_family: "FAM", metric_name: "m", metric_code: "008" },
  ];
  const fullCommitted = (metrics: EngineInput["metrics"], stages: EngineInput["stages"]): EngineInput => ({
    match: baseMatch,
    run: { ...baseRun, research_lock_at: "2026-08-30T03:30:00.000Z", independent_decision_committed_at: "2026-08-30T03:31:00.000Z", matrix_revealed_at: "2026-08-30T03:32:00.000Z", calibration_version_id: "cal-1" },
    metrics,
    verification: [{ status: "COMPLETE", outcome: "PASS", severity: "STANDARD" }],
    disagreement: [{ status: "COMPLETE", contradiction_severity: "NONE" }],
    underdog: [{ status: "COMPLETE", classification: "WEAK", player_side: "Beta" }],
    stress: [{ status: "COMPLETE", test_code: "ST01", outcome: "STABLE" }],
    reconstructions: [],
    conflicts: [],
    matrixWp: null,
    stages,
  });

  it("keeps stagesComplete false when every child-row check passes but a required stage is not persisted COMPLETE", () => {
    // All row-level data looks fully done (auditComplete stays true, its own
    // row/run-derived signal), but P1/P2 METRIC EXECUTION never actually
    // persisted COMPLETE in audit_stage_runs (e.g. the row-level writes
    // landed but the process died before the stage's own terminal write) --
    // this must not let the gate read stagesComplete as true.
    const staleStages = ALL_STAGES_COMPLETE.filter((s) => s.stage !== "P1 METRIC EXECUTION" && s.stage !== "P2 METRIC EXECUTION").concat([
      { stage: "P1 METRIC EXECUTION", status: "RUNNING" },
      { stage: "P2 METRIC EXECUTION", status: "RUNNING" },
    ]);
    const report = evaluate(fullCommitted(fullRows(), staleStages));
    expect(report.auditComplete).toBe(true);
    expect(report.stagesComplete).toBe(false);
    expect(report.stageGaps).toEqual(expect.arrayContaining(["P1 METRIC EXECUTION", "P2 METRIC EXECUTION"]));
  });

  it("reports stagesComplete true only once every stage (excluding the gate itself) is persisted COMPLETE", () => {
    const stages = ALL_STAGES_COMPLETE.filter((s) => s.stage !== "FINAL COMBINATION GATE");
    const report = evaluate(fullCommitted(fullRows(), stages));
    expect(report.auditComplete).toBe(true);
    expect(report.stagesComplete).toBe(true);
    expect(report.stageGaps).toEqual([]);
  });

  it("blocks stagesComplete when a single early stage (identity) never persisted COMPLETE, even though everything else is COMPLETE", () => {
    const stages = ALL_STAGES_COMPLETE.map((s) => (s.stage === "MATCH IDENTITY VERIFICATION" ? { ...s, status: "NOT STARTED" } : s));
    const report = evaluate(fullCommitted(fullRows(), stages));
    expect(report.stagesComplete).toBe(false);
    expect(report.stageGaps).toContain("MATCH IDENTITY VERIFICATION");
  });

  it("treats a missing stage row the same as an incomplete one", () => {
    const stages = ALL_STAGES_COMPLETE.filter((s) => s.stage !== "STRESS / REMOVAL TESTS");
    const report = evaluate(fullCommitted(fullRows(), stages));
    expect(report.stagesComplete).toBe(false);
    expect(report.stageGaps).toContain("STRESS / REMOVAL TESTS");
  });

  it("Final Combination Gate cannot complete if Coverage Persistence / Evidence Validation is incomplete", () => {
    const stages = ALL_STAGES_COMPLETE.filter((s) => s.stage !== "COVERAGE PERSISTENCE / EVIDENCE VALIDATION");
    const report = evaluate(fullCommitted(fullRows(), stages));
    expect(report.stagesComplete).toBe(false);
    expect(report.stageGaps).toContain("COVERAGE PERSISTENCE / EVIDENCE VALIDATION");
  });

  it("Final Combination Gate cannot complete if Final Decision is incomplete", () => {
    const stages = ALL_STAGES_COMPLETE.filter((s) => s.stage !== "FINAL DECISION");
    const report = evaluate(fullCommitted(fullRows(), stages));
    expect(report.stagesComplete).toBe(false);
    expect(report.stageGaps).toContain("FINAL DECISION");
  });

  // Regression: commitFinalDecision (the FINAL DECISION stage itself, audit-pipeline.ts)
  // calls buildReport() -> evaluate() from INSIDE its own execution, before its own
  // audit_stage_runs row is written back as COMPLETE -- so at that exact call site,
  // "FINAL DECISION" always appears RUNNING, exactly like the fixture above. Because
  // STAGE_DEPENDENCIES makes FINAL COMBINATION GATE depend on every other stage
  // including FINAL DECISION, stagesComplete is UNCONDITIONALLY false there for every
  // run, no matter how complete the evidence actually is. Gating color on stagesComplete
  // (as this used to) froze every persisted final_decisions row at
  // color="INCOMPLETE"/action="CONTINUE PROCESSING" forever, even for a fully-executed,
  // corroborated, stable decision -- which is exactly the shape of this fixture.
  it("still reports a real color from complete evidence even though FINAL DECISION's own row has not yet persisted COMPLETE (commitFinalDecision's own call site)", () => {
    const stages = ALL_STAGES_COMPLETE.filter((s) => s.stage !== "FINAL DECISION").concat([{ stage: "FINAL DECISION", status: "RUNNING" }]);
    const withWinner = fullCommitted(fullRows(), stages);
    const report = evaluate({ ...withWinner, run: { ...withWinner.run, independent_winner: "Alpha", effective_evidence_count: 5 } });
    expect(report.auditComplete).toBe(true);
    expect(report.stagesComplete).toBe(false); // still accurately false -- unaffected, still finalGate's real signal
    expect(report.stageGaps).toContain("FINAL DECISION"); // unaffected: the raw signal still sees it
    expect(report.color).not.toBe("INCOMPLETE");
    expect(report.action).not.toBe("CONTINUE PROCESSING");
    // FINAL DECISION's own not-yet-persisted row must not itself count as a
    // green-lock reason either -- only a genuinely different stage lagging would.
    expect(report.greenLockReasons.some((r) => r.includes("FINAL DECISION"))).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// The 81-code coverage gate must never veto a valid Truth Engine winner.
//
// coverageFor() measures usable evidence across the FULL 81-code processing
// universe -- including the 56 codes the Truth Engine's own active registry
// (truth-engine-active-metrics.ts) does not rely on. Real case: Mathys Erhard
// vs Anton Shepp -- the Truth Engine (25 active metrics, family-consolidated,
// verification/disagreement/underdog/stress-audited) selected Erhard at 60%
// directional support, while this gate's 81-code coverage read 43.8% (most of
// the 56 unused codes sit UNAVAILABLE simply because nothing researches them
// anymore) -- and the persisted color/action came out "INSUFFICIENT EVIDENCE",
// silently discarding a real winner. `run.independent_winner` (identical to
// gate_report.deterministic_decision.selected_player) IS the Truth Engine's
// authority; `lowCoverage` no longer participates in whether color can name a
// winner -- it can still hold a real winner at YELLOW instead of GREEN
// (greenLockReasons), but it can never turn one into "no winner".
// ----------------------------------------------------------------------------
describe("audit-engine: the 81-code coverage gate cannot veto a valid Truth Engine winner", () => {
  const cleanVerification: EngineInput["verification"] = [{ status: "COMPLETE", outcome: "PASS", severity: "STANDARD" }];
  const cleanDisagreement: EngineInput["disagreement"] = [{ status: "COMPLETE", contradiction_severity: "NONE" }];
  const cleanUnderdog = (winner: string, loser: string): EngineInput["underdog"] => [
    { status: "COMPLETE", classification: "WEAK", player_side: loser },
    { status: "COMPLETE", classification: "WEAK", player_side: winner },
  ];
  const cleanStress: EngineInput["stress"] = [
    { status: "COMPLETE", test_code: "ST01", outcome: "STABLE" },
    { status: "COMPLETE", test_code: "ST02", outcome: "STABLE" },
    { status: "COMPLETE", test_code: "ST03", outcome: "STABLE" },
  ];
  // commitConclusion (audit-pipeline.ts) always stamps independent_decision_committed_at
  // once the INDEPENDENT CONCLUSION stage runs -- including the refusal case, where
  // independent_winner stays null but the conclusion was still genuinely reached. Tying
  // these to whether a winner exists would fabricate a different, unreal "INCOMPLETE"
  // failure mode for the refusal fixtures below.
  const committedRun = (winner: string | null, overrides: Partial<EngineInput["run"]> = {}): EngineInput["run"] => ({
    ...baseRun,
    research_lock_at: "2026-09-05T05:00:00.000Z",
    independent_decision_committed_at: "2026-09-05T05:38:12.000Z",
    matrix_revealed_at: "2026-09-05T05:38:13.000Z",
    independent_winner: winner,
    calibration_version_id: "cal-1",
    effective_evidence_count: 5,
    ...overrides,
  });

  /**
   * `usableCount` metrics get real DIRECT evidence (backed by a value and a source);
   * the rest of `totalCount` sit UNAVAILABLE, exactly like the 56 codes the Truth
   * Engine's active registry does not rely on -- this is what drives
   * usableCoveragePercent down to whatever the caller wants (e.g. 43.8%-like) without
   * touching auditComplete (p1/p2 sweep only requires a DONE_STATES status, which
   * UNAVAILABLE already satisfies).
   */
  function metricsWithCoverage(usableCount: number, totalCount: number): EngineInput["metrics"] {
    const rows: EngineInput["metrics"] = [];
    for (let i = 0; i < totalCount; i++) {
      // isProcessMetaCode/isNoSourceMetricCode (audit-engine.ts) strip any non-digit
      // prefix down to the trailing 1-3 digits before classifying -- "T001" normalizes
      // right back to "001" and hits the real registry anyway. Codes in the 200s fall
      // outside both the real 001-081 catalog and this file's "999" mock, so
      // classifyMetric misses and defaults to LEGITIMATE_PLAYER_METRIC
      // (metric-classification.ts) -- none of these can be EXCLUDED/NO_SOURCE, so the
      // coverage denominator is exactly `totalCount` and usableCount/totalCount is the
      // real, predictable usablePercent.
      const code = String(200 + i).padStart(3, "0");
      const usable = i < usableCount;
      rows.push({
        status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE",
        p1_treatment: usable ? "DIRECT" : "UNAVAILABLE", p2_treatment: usable ? "DIRECT" : "UNAVAILABLE",
        matrix_derived: false, evidence_family: usable ? `FAMILY_${i}` : null, metric_name: `metric ${code}`, metric_code: code,
        p1_value: usable ? "10" : null, p2_value: usable ? "5" : null,
        sources: usable ? [{ source_name: "Tour Stats" }] : [],
      });
    }
    return rows;
  }

  function fixture(args: { winner: string | null; usableCount: number; totalCount: number; disagreement?: EngineInput["disagreement"]; loser?: string; runOverrides?: Partial<EngineInput["run"]> }): EngineInput {
    const loser = args.loser ?? (args.winner === "Alpha" ? "Beta" : "Alpha");
    return {
      match: baseMatch,
      run: committedRun(args.winner, args.runOverrides),
      metrics: metricsWithCoverage(args.usableCount, args.totalCount),
      verification: cleanVerification,
      disagreement: args.disagreement ?? cleanDisagreement,
      underdog: args.winner ? cleanUnderdog(args.winner, loser) : cleanUnderdog("Alpha", "Beta"),
      stress: cleanStress,
      reconstructions: [],
      conflicts: [],
      matrixWp: null,
      stages: ALL_STAGES_COMPLETE,
    };
  }

  // The persisted "committed" check detail is `run.independent_winner` verbatim
  // (see the checks array above) -- the reliable, color-independent way to read
  // back the actual Truth Engine winner regardless of what color/action say.
  // `action` only ever names the winner for GREEN/DOUBLE GREEN by pre-existing,
  // untouched design (YELLOW/RED/INSUFFICIENT EVIDENCE never did, before or
  // after this fix) -- these tests must not mistake that pre-existing convention
  // for a suppression bug of their own.
  const winnerDetail = (report: ReturnType<typeof evaluate>) => report.checks.find((c) => c.key === "committed")?.detail;

  it("1. a valid P1 selection is not suppressed by low coverage across the inactive 56", () => {
    // 5 of 81 usable -> 6.2%, far below the 70% threshold -- reproduces the real shape.
    const report = evaluate(fixture({ winner: "Alpha", usableCount: 5, totalCount: 81 }));
    expect(report.coverage.usablePercent).toBeLessThan(70);
    expect(report.color).not.toBe("INSUFFICIENT EVIDENCE");
    expect(report.color).not.toBe("INCOMPLETE");
    expect(winnerDetail(report)).toBe("Alpha");
  });

  it("2. a valid P2 selection is not suppressed by low coverage across the inactive 56", () => {
    const report = evaluate(fixture({ winner: "Beta", usableCount: 5, totalCount: 81 }));
    expect(report.coverage.usablePercent).toBeLessThan(70);
    expect(report.color).not.toBe("INSUFFICIENT EVIDENCE");
    expect(winnerDetail(report)).toBe("Beta");
  });

  it("3. strong active evidence with poor inactive-universe coverage still returns the deterministic winner", () => {
    // 25 of 81 usable (the entire active registry usable, none of the other 56)
    // -> well under the 70% threshold, so this legitimately reads YELLOW (coverage
    // may still hold a real winner short of GREEN) -- never INSUFFICIENT EVIDENCE.
    const report = evaluate(fixture({ winner: "Alpha", usableCount: 25, totalCount: 81 }));
    expect(report.coverage.usablePercent).toBeCloseTo((25 / 81) * 100, 1);
    expect(report.color).toBe("YELLOW");
    expect(winnerDetail(report)).toBe("Alpha");
  });

  it("4. 25/25 (100% of the active set) does not itself manufacture a winner when the Truth Engine produced none", () => {
    const report = evaluate(fixture({ winner: null, usableCount: 25, totalCount: 25 }));
    expect(report.coverage.usablePercent).toBe(100);
    expect(report.color).toBe("INSUFFICIENT EVIDENCE");
    expect(report.action).toBe("INSUFFICIENT EVIDENCE");
  });

  it("5. fewer than 25 usable active metrics can still produce a winner when the Truth Engine's own rules already established one", () => {
    // Only 10 of 81 usable, well under a full active set, yet a winner exists.
    const report = evaluate(fixture({ winner: "Alpha", usableCount: 10, totalCount: 81 }));
    expect(report.color).not.toBe("INSUFFICIENT EVIDENCE");
    expect(winnerDetail(report)).toBe("Alpha");
  });

  it("6. evidence coverage remains a diagnostic value, distinct from and never overwriting the winner", () => {
    const low = evaluate(fixture({ winner: "Alpha", usableCount: 3, totalCount: 81 }));
    const high = evaluate(fixture({ winner: "Alpha", usableCount: 25, totalCount: 81 }));
    expect(low.coverage.usablePercent).toBeLessThan(high.coverage.usablePercent);
    // Coverage moved (diagnostic); the winner did not (authoritative), in either fixture.
    expect(winnerDetail(low)).toBe("Alpha");
    expect(winnerDetail(high)).toBe("Alpha");
    expect(low.color).not.toBe("INSUFFICIENT EVIDENCE");
    expect(high.color).not.toBe("INSUFFICIENT EVIDENCE");
  });

  it("7/8. the 56 inactive metrics can neither vote for nor veto either player", () => {
    // Vary ONLY the inactive/unusable metric rows (the ones beyond the first 25); the
    // winner and the color must not move, because nothing about evaluate()'s color
    // path reads them for anything but the coverage diagnostic.
    const withNoiseA = fixture({ winner: "Alpha", usableCount: 25, totalCount: 81 });
    const withNoiseB = { ...withNoiseA, metrics: metricsWithCoverage(25, 81).map((m, i) => (i >= 25 ? { ...m, p1_treatment: "PARTIAL" as const, p2_treatment: "UNAVAILABLE" as const } : m)) };
    const a = evaluate(withNoiseA);
    const b = evaluate(withNoiseB);
    expect(winnerDetail(a)).toBe(winnerDetail(b));
    expect(a.color).toBe(b.color);
  });

  it("9. the 81-code completion percentage cannot overwrite selected_player", () => {
    const lowCompletion = evaluate(fixture({ winner: "Alpha", usableCount: 2, totalCount: 81 }));
    const highCompletion = evaluate(fixture({ winner: "Alpha", usableCount: 60, totalCount: 81 }));
    expect(lowCompletion.coverage.usablePercent).toBeLessThan(highCompletion.coverage.usablePercent);
    expect(winnerDetail(lowCompletion)).toBe("Alpha");
    expect(winnerDetail(highCompletion)).toBe("Alpha");
    expect(lowCompletion.color).not.toBe("INSUFFICIENT EVIDENCE");
    // 60 of 81 = 74.1%, above the 70% threshold -- coverage is good enough here that
    // nothing else holds it back, so this one reaches a real "PLAY" color.
    expect(["GREEN", "DOUBLE GREEN"]).toContain(highCompletion.color);
    expect(highCompletion.action).toBe("PLAY — Alpha");
  });

  it("11. verification/disagreement/underdog/stress still execute exactly as before and can still block GREEN with a real winner present", () => {
    // A CRITICAL disagreement is a genuine Truth Engine audit finding (part of the
    // decision path itself, not the coverage gate) -- it must still hold color at
    // RED/PASS even though a winner exists and coverage is irrelevant here.
    const report = evaluate(fixture({
      winner: "Alpha", usableCount: 25, totalCount: 81,
      disagreement: [{ status: "COMPLETE", contradiction_severity: "CRITICAL" }],
    }));
    expect(report.color).toBe("RED / PASS");
    expect(report.action).toBe("PASS");
    // The winner is untouched even though the color is not a "play" color --
    // it is still readable from run.independent_winner, unaffected by this gate.
    expect(report.checks.find((c) => c.key === "committed")?.detail).toBe("Alpha");
  });

  it("13. P1/P2 inversion stays symmetric under low coverage", () => {
    const forward = evaluate(fixture({ winner: "Alpha", usableCount: 5, totalCount: 81 }));
    const inverted = evaluate({
      ...fixture({ winner: "Beta", usableCount: 5, totalCount: 81 }),
      match: { ...baseMatch, player1_name: "Beta", player2_name: "Alpha" },
    });
    expect(forward.color).toBe(inverted.color);
    expect(forward.color).not.toBe("INSUFFICIENT EVIDENCE");
    expect(winnerDetail(forward)).toBe("Alpha");
    expect(winnerDetail(inverted)).toBe("Beta");
  });

  it("14. a genuine Truth Engine refusal (no winner) still produces INSUFFICIENT EVIDENCE, coverage notwithstanding", () => {
    const lowCoverageNoWinner = evaluate(fixture({ winner: null, usableCount: 5, totalCount: 81 }));
    const highCoverageNoWinner = evaluate(fixture({ winner: null, usableCount: 25, totalCount: 25 }));
    expect(lowCoverageNoWinner.color).toBe("INSUFFICIENT EVIDENCE");
    expect(highCoverageNoWinner.color).toBe("INSUFFICIENT EVIDENCE");
  });

  it("15. a legacy coverage value in the exact real shape (~43.8%) cannot convert a valid selection into INSUFFICIENT EVIDENCE", () => {
    // 35 of 80 non-excluded codes usable ~= 43.75%, reproducing the real
    // Erhard/Shepp run's coverage almost exactly.
    const report = evaluate(fixture({ winner: "Mathys Erhard", usableCount: 35, totalCount: 80, loser: "Anton Shepp" }));
    expect(report.coverage.usablePercent).toBeCloseTo(43.8, 0);
    expect(report.color).not.toBe("INSUFFICIENT EVIDENCE");
    expect(report.color).not.toBe("INCOMPLETE");
    expect(winnerDetail(report)).toBe("Mathys Erhard");
  });
});

// ---------------------------------------------------------------------------
// A STRESS TEST THAT NEVER RAN IS NOT A FAILED ONE
// ---------------------------------------------------------------------------
//
// ST04/ST08/ST09/ST10 need evidence the active metric set cannot produce, so
// truth-engine-stage-mapping.ts writes them status UNAVAILABLE. Their OUTCOME used to be
// written "UNSTABLE" as well -- a never-run test recorded as an instability finding. Because
// DOUBLE GREEN asks whether every stress test came back STABLE, those four permanent
// "UNSTABLE" rows made DOUBLE GREEN unreachable for every match in every circumstance.
// Production: 0 DOUBLE GREEN across 60 completed runs, with 240 such rows.
describe("audit-engine: not-run stress tests are not counted as instability", () => {
  const doubleGreenReady = (stress: EngineInput["stress"]): EngineInput => ({
    ...input([]),
    run: {
      ...baseRun,
      research_lock_at: "2026-04-12T09:00:00.000Z",
      independent_decision_committed_at: "2026-04-12T09:30:00.000Z",
      matrix_revealed_at: "2026-04-12T09:31:00.000Z",
      calibration_version_id: "cal-1",
      independent_winner: "Alpha",
      effective_evidence_count: 6,
    },
    // Six independent families with two-sided usable evidence: enough for DOUBLE GREEN's
    // effectiveEvidenceCount >= 5, and 100% coverage so no green-lock fires.
    metrics: Array.from({ length: 6 }, (_, i) => ({
      status: "COMPLETE", p1_status: "COMPLETE", p2_status: "COMPLETE",
      p1_treatment: "DIRECT", p2_treatment: "DIRECT", matrix_derived: false,
      evidence_family: `FAMILY_${i}`, metric_name: `Metric ${i}`, metric_code: `00${i + 1}`,
      p1_value: "1", p2_value: "1", sources: [{ source_name: "s" }],
    })),
    verification: [{ status: "COMPLETE", outcome: "PASS", severity: "STANDARD" }],
    disagreement: [{ status: "COMPLETE", contradiction_severity: "NONE" }],
    underdog: [{ status: "COMPLETE", classification: "WEAK", player_side: "Beta" }],
    stress,
  });
  const evaluated = (test_code: string, outcome: string) => ({ status: "COMPLETE", test_code, outcome });
  const neverRan = (test_code: string) => ({ status: "UNAVAILABLE", test_code, outcome: "NOT EVALUATED" });
  const ALL_EVALUATED_STABLE = ["ST01", "ST02", "ST03", "ST05", "ST06", "ST07"].map((code) => evaluated(code, "STABLE"));
  const NEVER_RAN = ["ST04", "ST08", "ST09", "ST10"].map(neverRan);

  it("DOUBLE GREEN is structurally reachable once its existing rules are genuinely satisfied", () => {
    const report = evaluate(doubleGreenReady([...ALL_EVALUATED_STABLE, ...NEVER_RAN]));
    expect(report.greenLockReasons).toEqual([]);
    expect(report.color).toBe("DOUBLE GREEN");
  });

  it("an actually-unstable test still withholds DOUBLE GREEN", () => {
    const report = evaluate(doubleGreenReady([
      ...ALL_EVALUATED_STABLE.slice(1), evaluated("ST01", "UNSTABLE"), ...NEVER_RAN,
    ]));
    expect(report.color).not.toBe("DOUBLE GREEN");
  });

  it("a MOSTLY STABLE executed test still withholds DOUBLE GREEN, exactly as before", () => {
    const report = evaluate(doubleGreenReady([
      ...ALL_EVALUATED_STABLE.slice(1), evaluated("ST01", "MOSTLY STABLE"), ...NEVER_RAN,
    ]));
    expect(report.color).not.toBe("DOUBLE GREEN");
  });

  it("a stress stage where NOTHING ran cannot vacuously earn DOUBLE GREEN", () => {
    const report = evaluate(doubleGreenReady(["ST01", "ST02", "ST03"].map(neverRan)));
    expect(report.color).not.toBe("DOUBLE GREEN");
    // ST01/ST02 never produced a matrix-removal result, so that lock still fires.
    expect(report.greenLockReasons.join(" ")).toContain("Matrix-removal test not survived");
  });

  it("the matrix-removal and strongest-family locks still require a genuinely COMPLETE result", () => {
    // Unchanged behaviour: these two already required status COMPLETE, and a not-run row
    // must not satisfy either of them.
    const report = evaluate(doubleGreenReady([neverRan("ST01"), neverRan("ST02"), neverRan("ST03"), ...NEVER_RAN]));
    const reasons = report.greenLockReasons.join(" ");
    expect(reasons).toContain("Matrix-removal test not survived");
    expect(reasons).toContain("Strongest-family removal not survived");
  });
});
