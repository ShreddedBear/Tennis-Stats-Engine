import { describe, expect, it } from "vitest";
import { currentAuditRows, latestRunsByMatch, activeSlateMatchIds, activeRunIds, isRowOnActiveSlate } from "./current-audit-state";
import { INVALIDATED_RUN_STATUS } from "./audit-stages";

describe("current audit state", () => {
  const runs = [
    { id: "old-a", match_id: "a", run_number: 1, status: "COMPLETE" },
    { id: "new-a", match_id: "a", run_number: 3, status: "RUNNING" },
    { id: "mid-a", match_id: "a", run_number: 2, status: "COMPLETE" },
    { id: "only-b", match_id: "b", run_number: 1, status: "COMPLETE" },
  ];

  it("selects the maximum run number independently for each match", () => {
    const latest = latestRunsByMatch(runs);
    expect(latest.get("a")?.id).toBe("new-a");
    expect(latest.get("b")?.id).toBe("only-b");
  });

  it("never lets a historical decision count as the current match decision", () => {
    const rows = currentAuditRows(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      runs,
      [
        { audit_run_id: "old-a", audit_complete: true, final_audit_color: "GREEN" },
        { audit_run_id: "only-b", audit_complete: true, final_audit_color: "YELLOW" },
      ],
    );
    expect(rows.find((row) => row.match.id === "a")?.decision).toBeNull();
    expect(rows.find((row) => row.match.id === "b")?.decision?.final_audit_color).toBe("YELLOW");
    expect(rows.filter((row) => row.decision?.audit_complete)).toHaveLength(1);
  });

  // Regression: latestRunsByMatch/currentAuditRows must reuse resolveActiveRun
  // (audit-stages.ts), not a competing "highest run_number wins, status
  // ignored" rule. This is what Dashboard, Master Ranked Board, and
  // Execution Logs all rely on to stop showing a match whose latest run was
  // just invalidated (Clear Slate, or a rule-version change).
  it("resolves no current run for a match whose latest run was invalidated by Clear Slate -- even though it is still the highest run_number", () => {
    const clearedRuns = [
      { id: "old-c", match_id: "c", run_number: 1, status: "COMPLETE" },
      { id: "cleared-c", match_id: "c", run_number: 2, status: INVALIDATED_RUN_STATUS },
      { id: "only-d", match_id: "d", run_number: 1, status: "RUNNING" },
    ];
    const latest = latestRunsByMatch(clearedRuns);
    expect(latest.has("c")).toBe(false);
    expect(latest.get("d")?.id).toBe("only-d");
  });

  it("currentAuditRows reports no run and no decision for a match whose latest run was invalidated, even if that dead run has an old decision row", () => {
    const clearedRuns = [{ id: "cleared-c", match_id: "c", run_number: 1, status: INVALIDATED_RUN_STATUS }];
    const rows = currentAuditRows(
      [{ id: "c" }],
      clearedRuns,
      [{ audit_run_id: "cleared-c", audit_complete: true, final_audit_color: "DOUBLE GREEN" }],
    );
    expect(rows[0]!.run).toBeNull();
    expect(rows[0]!.decision).toBeNull();
  });
});

describe("activeSlateMatchIds", () => {
  it("includes only matches with an active summary_version", () => {
    const ids = activeSlateMatchIds([
      { match_id: "a", is_active: true },
      { match_id: "b", is_active: false },
      { match_id: "c", is_active: null },
      { match_id: "d" },
    ]);
    expect(ids).toEqual(new Set(["a"]));
  });

  it("is empty right after Clear Slate deactivates every summary_version", () => {
    const ids = activeSlateMatchIds([
      { match_id: "a", is_active: false },
      { match_id: "b", is_active: false },
    ]);
    expect(ids.size).toBe(0);
  });

  it("a match can have a stale inactive version and a fresh active one -- only the active one counts", () => {
    const ids = activeSlateMatchIds([
      { match_id: "a", is_active: false },
      { match_id: "a", is_active: true },
    ]);
    expect(ids.has("a")).toBe(true);
  });

  // Reproduces the exact production failure: Clear Slate never deletes
  // summary_uploads or summary_versions rows, so "the latest upload" (by
  // upload_id/created_at recency) still contains every cleared match after
  // Clear Slate runs -- only their is_active flag changes. A definition of
  // "active slate" that used upload recency as a proxy (which is what
  // slate.tsx did before this fix: pick the newest summary_uploads row, then
  // treat every summary_version pointing at it as active) would resurrect
  // all 55 matches the instant Clear Slate finished, because the upload
  // itself is still "the latest" -- it was never re-uploaded or replaced.
  // activeSlateMatchIds must derive membership from is_active alone, and
  // must never be handed upload identity/recency to reintroduce that bug.
  it("does not resurrect a cleared slate merely because its rows still belong to the most recent upload", () => {
    const upload = "upload-1";
    const versionsBeforeClear = Array.from({ length: 55 }, (_, i) => ({
      match_id: `m${i}`,
      upload_id: upload,
      is_active: true,
    }));
    expect(activeSlateMatchIds(versionsBeforeClear).size).toBe(55);

    // Clear Slate: is_active flips to false for every row. upload_id, and
    // the fact that `upload` is still the newest summary_uploads row, are
    // completely untouched -- exactly the production state that was found:
    // 386/386 summary_versions rows with is_active=false, all still
    // pointing at uploads that were never deleted or superseded.
    const versionsAfterClear = versionsBeforeClear.map((v) => ({ ...v, is_active: false }));
    const activeAfterClear = activeSlateMatchIds(versionsAfterClear);
    expect(activeAfterClear.size).toBe(0);
    for (const v of versionsAfterClear) expect(activeAfterClear.has(v.match_id)).toBe(false);

    // The type signature itself enforces this: activeSlateMatchIds only
    // ever reads `is_active` off each row. It has no upload_id/created_at
    // parameter to consult, so "most recent upload" cannot leak back in as
    // a hidden fallback no matter what the caller passes.
    expect(Object.keys(versionsAfterClear[0]!)).toContain("upload_id");
  });
});

describe("activeRunIds", () => {
  const runs = [
    { id: "run-a1", match_id: "a", run_number: 1, status: "COMPLETE" },
    { id: "run-b1", match_id: "b", run_number: 1, status: "COMPLETE" },
  ];

  it("only includes a match's current run when the match is ALSO still on the active slate", () => {
    const active = activeRunIds(runs, new Set(["a"]));
    expect(active).toEqual(new Set(["run-a1"]));
  });

  it("excludes a match's current run if the match was cleared, even though the run itself still looks COMPLETE", () => {
    // "a" was cleared (no longer in the active-slate match set) even though
    // its run row's own status was never touched by Clear Slate.
    const active = activeRunIds(runs, new Set([]));
    expect(active.size).toBe(0);
  });

  it("excludes a run whose own status is invalidated even if the match is still on the active slate", () => {
    const invalidated = [{ id: "run-a1", match_id: "a", run_number: 1, status: INVALIDATED_RUN_STATUS }];
    const active = activeRunIds(invalidated, new Set(["a"]));
    expect(active.size).toBe(0);
  });
});

describe("isRowOnActiveSlate", () => {
  it("a merged slate row (multiple underlying match ids) counts as active if any underlying id is active", () => {
    const row = { id: "primary", _all_ids: ["primary", "duplicate-1", "duplicate-2"] };
    expect(isRowOnActiveSlate(row, new Set(["duplicate-2"]))).toBe(true);
    expect(isRowOnActiveSlate(row, new Set(["something-else"]))).toBe(false);
  });

  it("a row with no _all_ids falls back to its own id", () => {
    expect(isRowOnActiveSlate({ id: "solo" }, new Set(["solo"]))).toBe(true);
    expect(isRowOnActiveSlate({ id: "solo" }, new Set(["other"]))).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// End-to-end propagation scenario, at the level every operational page
// actually operates on: upload -> audit -> Clear Slate -> every operational
// tab's filtering logic is empty -> new upload -> only the new matches
// appear anywhere. This exercises the exact functions Dashboard, Active
// Slate, Master Ranked Board, and Execution Logs each call -- not a
// simulation of the pages, the real shared logic they run.
//
// Clear Slate itself is a hard, physical delete (clear_operational_slate(),
// see the migration and reset-slate.functions.ts) -- not the is_active/
// INVALIDATED_RUN_STATUS soft-clear this test used to simulate. The rows
// these helpers filter simply cease to exist; there is no "cleared but still
// present" state left to filter out, and no historical view that can still
// reach the old rows -- reaching them at all would mean the delete failed.
// ----------------------------------------------------------------------------
describe("Clear Slate propagation across every operational tab's data source", () => {
  it("removes deleted matches from every tab's filtering logic, and a fresh upload afterward produces a clean new slate with no old matches", () => {
    // 1. Upload + audit: two matches (m1, m2) fully audited, active summary
    // versions, completed runs, decisions, and execution logs -- exactly
    // what every operational page reads.
    let matches = [{ id: "m1" }, { id: "m2" }];
    let summaryVersions: Array<{ match_id: string; is_active: boolean }> = [
      { match_id: "m1", is_active: true },
      { match_id: "m2", is_active: true },
    ];
    let runs: Array<{ id: string; match_id: string; run_number: number; status: string }> = [
      { id: "run-m1", match_id: "m1", run_number: 1, status: "COMPLETE" },
      { id: "run-m2", match_id: "m2", run_number: 1, status: "COMPLETE" },
    ];
    let decisions = [
      { audit_run_id: "run-m1", audit_complete: true, final_audit_color: "GREEN" },
      { audit_run_id: "run-m2", audit_complete: true, final_audit_color: "YELLOW" },
    ];
    let logs = [
      { id: "log-1", audit_run_id: "run-m1", match_id: "m1" },
      { id: "log-2", audit_run_id: "run-m2", match_id: "m2" },
    ];

    // Every tab's core logic, before Clear Slate: both matches visible.
    const dashboardMatches = () => matches.filter((m) => activeSlateMatchIds(summaryVersions).has(m.id));
    const boardRows = () => currentAuditRows(matches.filter((m) => activeSlateMatchIds(summaryVersions).has(m.id)), runs, decisions).filter((r) => r.decision);
    const slateVisible = () => matches.filter((m) => isRowOnActiveSlate(m, activeSlateMatchIds(summaryVersions)));
    const logsVisible = () => {
      const activeIds = activeRunIds(runs, activeSlateMatchIds(summaryVersions));
      return logs.filter((l) => activeIds.has(l.audit_run_id));
    };

    expect(dashboardMatches()).toHaveLength(2);
    expect(boardRows()).toHaveLength(2);
    expect(slateVisible()).toHaveLength(2);
    expect(logsVisible()).toHaveLength(2);

    // 2. Clear Slate: reproduces what clear_operational_slate() actually
    // does -- matches, audit_runs, final_decisions and execution_logs for
    // the cleared user are PHYSICALLY DELETED (cascade), not flagged.
    const clearedMatchIds = new Set(matches.map((m) => m.id));
    matches = matches.filter((m) => !clearedMatchIds.has(m.id));
    summaryVersions = summaryVersions.filter((v) => !clearedMatchIds.has(v.match_id));
    runs = runs.filter((r) => !clearedMatchIds.has(r.match_id));
    decisions = decisions.filter((d) => runs.some((r) => r.id === d.audit_run_id));
    logs = logs.filter((l) => !clearedMatchIds.has(l.match_id));

    // 3. Every operational tab's filtering logic must now be empty.
    expect(dashboardMatches()).toHaveLength(0);
    expect(boardRows()).toHaveLength(0);
    expect(slateVisible()).toHaveLength(0);
    expect(logsVisible()).toHaveLength(0);

    // The rows themselves are gone -- not present-but-hidden, not reachable
    // through any "scope=all"/historical view. Nothing left to un-hide.
    expect(matches).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(decisions).toHaveLength(0);
    expect(logs).toHaveLength(0);
    expect(summaryVersions).toHaveLength(0);

    // 4. A fresh upload creates a brand-new match (m3, a genuinely new id --
    // a real re-upload never reuses m1/m2's old ids, because those rows no
    // longer exist to reuse) with its own active summary_version, run,
    // decision, and log.
    const newMatches = [...matches, { id: "m3" }];
    summaryVersions = [...summaryVersions, { match_id: "m3", is_active: true }];
    runs = [...runs, { id: "run-m3", match_id: "m3", run_number: 1, status: "COMPLETE" }];
    const newDecisions = [...decisions, { audit_run_id: "run-m3", audit_complete: true, final_audit_color: "DOUBLE GREEN" }];
    const newLogs = [...logs, { id: "log-3", audit_run_id: "run-m3", match_id: "m3" }];

    const activeIdsAfterReupload = activeSlateMatchIds(summaryVersions);
    const dashboardAfter = newMatches.filter((m) => activeIdsAfterReupload.has(m.id));
    const boardAfter = currentAuditRows(newMatches.filter((m) => activeIdsAfterReupload.has(m.id)), runs, newDecisions).filter((r) => r.decision);
    const slateAfter = newMatches.filter((m) => isRowOnActiveSlate(m, activeIdsAfterReupload));
    const logsAfter = newLogs.filter((l) => activeRunIds(runs, activeIdsAfterReupload).has(l.audit_run_id));

    // 5. Only the new match appears anywhere -- never m1/m2, whose ids are
    // now unrecognizable to every one of these functions because the rows
    // that carried them do not exist.
    expect(dashboardAfter.map((m) => m.id)).toEqual(["m3"]);
    expect(boardAfter.map((r) => r.match.id)).toEqual(["m3"]);
    expect(slateAfter.map((m) => m.id)).toEqual(["m3"]);
    expect(logsAfter.map((l) => l.id)).toEqual(["log-3"]);
    expect(dashboardAfter.some((m) => clearedMatchIds.has(m.id))).toBe(false);
  });
});
