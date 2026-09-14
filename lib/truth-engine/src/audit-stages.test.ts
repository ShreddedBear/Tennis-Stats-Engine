import { describe, expect, it } from "vitest";
import { STAGES, STAGE_DEPENDENCIES, FINAL_STAGE, unmetDependencies, canonicalizeStageRows, type Stage } from "./audit-stages";

describe("audit-stages: canonical model shape", () => {
  it("has exactly the 16 authoritative canonical stages, in the authoritative order", () => {
    expect(STAGES).toEqual([
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
      "MATRIX REVEAL AND COMPARISON",
      "CURRENT CALIBRATION APPLICATION",
      "COVERAGE PERSISTENCE / EVIDENCE VALIDATION",
      "FINAL DECISION",
      "FINAL COMBINATION GATE",
    ]);
    expect(STAGES.length).toBe(16);
  });

  it("FINAL_STAGE is Final Combination Gate, and it is the last stage", () => {
    expect(FINAL_STAGE).toBe("FINAL COMBINATION GATE");
    expect(STAGES[STAGES.length - 1]).toBe(FINAL_STAGE);
  });

  it("every stage's dependency set is exactly the ordered prefix before it -- a strictly linear chain", () => {
    STAGES.forEach((stage, index) => {
      expect(STAGE_DEPENDENCIES[stage]).toEqual(STAGES.slice(0, index));
    });
    expect(STAGE_DEPENDENCIES["MATCH INGESTION / PDF EXTRACTION"]).toEqual([]);
    expect(STAGE_DEPENDENCIES["FINAL COMBINATION GATE"]).toHaveLength(15);
  });
});

describe("audit-stages: canonicalizeStageRows", () => {
  const row = (stage: Stage, status: string, extra: Record<string, unknown> = {}) => ({ stage, status, ...extra });

  it("renders in canonical 1-16 order regardless of the input array's order", () => {
    const shuffled = [
      row("FINAL COMBINATION GATE", "PENDING"),
      row("P1 METRIC EXECUTION", "COMPLETE"),
      row("MATCH INGESTION / PDF EXTRACTION", "COMPLETE"),
      row("STRESS / REMOVAL TESTS", "RUNNING"),
      row("MATCH IDENTITY VERIFICATION", "COMPLETE"),
    ];
    const result = canonicalizeStageRows(shuffled);
    expect(result.map((r) => r.stage)).toEqual(STAGES);
  });

  it("a stage with no row yet renders as PENDING (row: null), never omitted -- always exactly 16 entries", () => {
    const result = canonicalizeStageRows([row("MATCH INGESTION / PDF EXTRACTION", "COMPLETE")]);
    expect(result).toHaveLength(16);
    expect(result[0]).toEqual({ stage: "MATCH INGESTION / PDF EXTRACTION", row: expect.objectContaining({ status: "COMPLETE" }) });
    expect(result[1]).toEqual({ stage: "MATCH IDENTITY VERIFICATION", row: null });
  });

  it("collapses multiple records for the same stage name into exactly one canonical entry (defense in depth against a duplicate/retry row)", () => {
    const rows = [
      row("P1 METRIC EXECUTION", "RUNNING", { done_count: 21, total_count: 81, attempts: 1 }),
      row("P1 METRIC EXECUTION", "COMPLETE", { done_count: 81, total_count: 81, attempts: 3 }),
    ];
    const result = canonicalizeStageRows(rows);
    const p1Entries = result.filter((r) => r.stage === "P1 METRIC EXECUTION");
    expect(p1Entries).toHaveLength(1);
    expect(p1Entries[0]!.row).toMatchObject({ status: "COMPLETE", attempts: 3 });
  });

  it("a failed attempt followed by a successful retry renders as one COMPLETE entry, not a FAILED entry and a COMPLETE entry", () => {
    const rows = [
      row("VERIFICATION AUDIT", "FAILED", { attempts: 1, error_message: "provider timeout" }),
      row("VERIFICATION AUDIT", "COMPLETE", { attempts: 2 }),
    ];
    const result = canonicalizeStageRows(rows);
    const entries = result.filter((r) => r.stage === "VERIFICATION AUDIT");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.row).toMatchObject({ status: "COMPLETE", attempts: 2 });
  });

  it("COMPLETE always outranks RUNNING/PARTIAL, which always outrank BLOCKED/FAILED, which always outrank anything else, regardless of array order", () => {
    const complete = row("STRESS / REMOVAL TESTS", "COMPLETE");
    const running = row("STRESS / REMOVAL TESTS", "RUNNING");
    const blocked = row("STRESS / REMOVAL TESTS", "BLOCKED");
    expect(canonicalizeStageRows([running, complete, blocked]).find((r) => r.stage === "STRESS / REMOVAL TESTS")!.row).toBe(complete);
    expect(canonicalizeStageRows([blocked, running]).find((r) => r.stage === "STRESS / REMOVAL TESTS")!.row).toBe(running);
  });

  it("run isolation: rows already scoped to one audit_run_id never surface another run's stage state -- the caller's filter is what enforces this", () => {
    // Simulates the exact shape of a real audit_stage_runs table: many rows
    // across multiple runs for the same match. The UI (match.$matchId.tsx,
    // slate.tsx) MUST filter to `audit_run_id === currentRunId` before ever
    // calling canonicalizeStageRows -- this test proves that once that
    // filter is applied, a stale prior run's COMPLETE rows cannot leak into
    // the current run's (still-incomplete) canonical view.
    const allRowsAcrossRuns = [
      { audit_run_id: "run-old", stage: "FINAL COMBINATION GATE", status: "COMPLETE" },
      { audit_run_id: "run-old", stage: "P1 METRIC EXECUTION", status: "COMPLETE" },
      { audit_run_id: "run-current", stage: "P1 METRIC EXECUTION", status: "RUNNING" },
      { audit_run_id: "run-current", stage: "MATCH INGESTION / PDF EXTRACTION", status: "COMPLETE" },
      { audit_run_id: "run-current", stage: "MATCH IDENTITY VERIFICATION", status: "COMPLETE" },
    ];
    const currentRunRows = allRowsAcrossRuns.filter((r) => r.audit_run_id === "run-current");
    const result = canonicalizeStageRows(currentRunRows);
    expect(result.find((r) => r.stage === "FINAL COMBINATION GATE")!.row).toBeNull();
    expect(result.find((r) => r.stage === "P1 METRIC EXECUTION")!.row).toMatchObject({ status: "RUNNING" });
  });
});

describe("audit-stages: unmetDependencies", () => {
  it("returns every unmet dependency, not just the first one found", () => {
    expect(unmetDependencies("VERIFICATION AUDIT", [])).toEqual(STAGE_DEPENDENCIES["VERIFICATION AUDIT"]);
  });

  it("returns empty once every dependency is COMPLETE", () => {
    const rows = STAGE_DEPENDENCIES["VERIFICATION AUDIT"].map((stage) => ({ stage, status: "COMPLETE" }));
    expect(unmetDependencies("VERIFICATION AUDIT", rows)).toEqual([]);
  });

  it("a stage with any non-COMPLETE status (RUNNING/BLOCKED/FAILED/PENDING) still counts as unmet", () => {
    const rows: Array<{ stage: Stage; status: string }> = [
      { stage: "MATCH INGESTION / PDF EXTRACTION", status: "COMPLETE" },
      { stage: "MATCH IDENTITY VERIFICATION", status: "COMPLETE" },
      { stage: "MATCH CONTEXT RESOLUTION", status: "RUNNING" },
    ];
    expect(unmetDependencies("DEFINITION INSTANTIATION", rows)).toEqual(["MATCH CONTEXT RESOLUTION"]);
  });
});
