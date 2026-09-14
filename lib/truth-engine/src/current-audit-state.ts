import { resolveActiveRun, type RunStatusRow } from "./audit-stages";

export type AuditRunRef = RunStatusRow & {
  id: string;
  match_id: string;
};

export type AuditDecisionRef = {
  audit_run_id: string;
  audit_complete: boolean;
};

// The ONE canonical "what is this match's current run" resolver, used by
// every operational page (Dashboard, Active Slate, Master Ranked Board,
// Execution Logs). Delegates to resolveActiveRun (audit-stages.ts) per
// match, rather than a competing "highest run_number wins" rule: a match
// whose latest run was invalidated (Clear Slate, or a rule-version change)
// has no current run here either, exactly as resolveActiveRun defines it
// everywhere else in the app. A match with no runs at all, or whose only
// runs are all invalidated, is simply absent from the returned map.
export function latestRunsByMatch<T extends AuditRunRef>(runs: T[]) {
  const byMatch = new Map<string, T[]>();
  for (const run of runs) {
    const list = byMatch.get(run.match_id);
    if (list) list.push(run);
    else byMatch.set(run.match_id, [run]);
  }
  const latest = new Map<string, T>();
  for (const [matchId, matchRuns] of byMatch) {
    const active = resolveActiveRun(matchRuns);
    if (active) latest.set(matchId, active);
  }
  return latest;
}

export function currentAuditRows<
  M extends { id: string },
  R extends AuditRunRef,
  D extends AuditDecisionRef,
>(matches: M[], runs: R[], decisions: D[]) {
  const latest = latestRunsByMatch(runs);
  const decisionsByRun = new Map(decisions.map((decision) => [decision.audit_run_id, decision]));
  return matches.map((match) => {
    const run = latest.get(match.id) ?? null;
    return {
      match,
      run,
      decision: run ? decisionsByRun.get(run.id) ?? null : null,
    };
  });
}

// ----------------------------------------------------------------------------
// ACTIVE SLATE MEMBERSHIP: the other half of "is this match part of the
// current operational slate", alongside the run-level resolveActiveRun
// above. A match is on the active slate iff it currently has an ACTIVE
// summary_version -- exactly what upload.tsx sets on ingestion and Clear
// Slate (reset-slate.functions.ts) turns off for every match it clears. This
// is match-level (does the match belong on the slate at all), independent
// of and prior to the run-level question (does its current run still count
// as live) that resolveActiveRun/latestRunsByMatch answer.
//
// Every operational page (Dashboard, Active Slate, Master Ranked Board,
// Execution Logs) must filter to this set before displaying anything as
// "current" -- reusing this one function, not re-deriving membership from
// upload recency, match creation order, or any other proxy.
// ----------------------------------------------------------------------------
export interface SummaryVersionRef {
  match_id: string;
  is_active?: boolean | null;
}

export function activeSlateMatchIds(summaryVersions: readonly SummaryVersionRef[]): Set<string> {
  return new Set(summaryVersions.filter((v) => v.is_active === true).map((v) => v.match_id));
}

// Combines both layers into the set of audit_run_id values that are
// genuinely current: the run must be its match's resolved active run AND
// that match must still be on the active slate. This is what Execution Logs
// (and anything else scoping by audit_run_id rather than by match) should
// filter to for its default/operational view.
export function activeRunIds<T extends AuditRunRef>(runs: T[], activeMatchIds: ReadonlySet<string>): Set<string> {
  const latest = latestRunsByMatch(runs);
  const ids = new Set<string>();
  for (const [matchId, run] of latest) {
    if (activeMatchIds.has(matchId)) ids.add(run.id);
  }
  return ids;
}

// Slate rows may represent several near-duplicate `matches` rows merged
// into one (see slate.tsx's mergeGroup, keyed by `_all_ids`). A merged row
// counts as on the active slate if ANY of the underlying match ids does.
export interface SlateRowRef {
  id: string;
  _all_ids?: string[];
}

export function isRowOnActiveSlate(row: SlateRowRef, activeMatchIds: ReadonlySet<string>): boolean {
  const ids = row._all_ids ?? [row.id];
  return ids.some((id) => activeMatchIds.has(id));
}
