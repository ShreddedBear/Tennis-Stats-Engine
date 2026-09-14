// REAL-RESULT CAPTURE & RESOLUTION -- the path from a finished audit run to a graded
// observation, orchestrated through injected dependencies so the whole flow can be driven
// in memory by tests exactly the way the audit pipeline is.
//
//   completed run -> its match -> a verified final result -> matches.actual_winner
//     -> compare the engine's selected player against that winner -> WIN/LOSS, but ONLY
//        when the result is genuinely known.
//
// What this deliberately does not do:
//   * It never invents a result. The only thing that can populate a winner is `lookupResult`,
//     backed by real recorded match history -- never the prediction, never an LLM.
//   * It never lets evidence coverage, the active-metric registry or evidence support touch
//     the grade. Grading happens entirely inside resolvePredictionOutcome, which cannot see
//     any of them.
//   * It never produces a probability. A resolved observation is a WIN or a LOSS; turning a
//     population of those into calibrated probabilities is a later, separate job.

import { matchResultIsFinal, mergeCapturedResult, resolvePredictionOutcome, type CapturedResult, type PredictionResolution } from "./match-result-resolution";

export interface CaptureMatchRow {
  id: string;
  player1_name: string;
  player2_name: string;
  tournament_name: string | null;
  scheduled_date: string | null;
  surface: string | null;
  actual_winner: string | null;
  result_status: string | null;
  final_score: string | null;
}

export interface CaptureRunRow {
  id: string;
  match_id: string;
  run_number: number;
  independent_winner: string | null;
}

export interface CaptureDecisionRow {
  audit_run_id: string;
  gate_report: unknown;
}

export interface CaptureGradeRow {
  id: string;
  match_id: string;
  audit_run_id: string | null;
}

export interface ResultCaptureDeps {
  now(): Date;
  /** Every match the capture pass may consider. */
  listMatches(): Promise<CaptureMatchRow[]>;
  updateMatch(matchId: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * The ONLY source of a real result. Returns null whenever the source cannot establish one,
   * which leaves the match open -- there is no fallback that guesses.
   */
  lookupResult(match: CaptureMatchRow): Promise<CapturedResult | null>;
  /** Runs that reached a committed final decision. */
  listDecidedRuns(): Promise<CaptureRunRow[]>;
  listDecisions(): Promise<CaptureDecisionRow[]>;
  listGrades(): Promise<CaptureGradeRow[]>;
  saveGrade(existingId: string | null, row: Record<string, unknown>): Promise<void>;
  log?(entry: Record<string, unknown>): Promise<void>;
}

export interface ResultCaptureSummary {
  matches_inspected: number;
  results_captured: number;
  matches_with_final_result: number;
  matches_unresolved: number;
  runs_inspected: number;
  observations_resolved: number;
  observations_open: number;
  wins: number;
  losses: number;
  open_reasons: Record<string, number>;
}

/**
 * The engine's prediction for a run. The decision record persisted at FINAL DECISION is
 * authoritative; audit_runs.independent_winner is the same deterministic value and covers
 * runs decided before that record existed. Note what is NOT consulted:
 * final_decisions.final_selection holds an ACTION (the recommendation), not a player, and
 * reading it as one would grade the wrong thing.
 */
export function selectedPlayerForRun(run: CaptureRunRow, decision: CaptureDecisionRow | undefined): string | null {
  const report = decision?.gate_report;
  if (report && typeof report === "object") {
    const record = (report as Record<string, unknown>)["deterministic_decision"];
    if (record && typeof record === "object") {
      const selected = (record as Record<string, unknown>)["selected_player"];
      if (typeof selected === "string" && selected.trim()) return selected.trim();
      // An explicit null selected_player is a real refusal, not missing data: the engine
      // declined to name a player. Fall through to nothing rather than to the older column.
      if (selected === null) return null;
    }
  }
  return String(run.independent_winner ?? "").trim() || null;
}

export async function captureAndResolveResults(deps: ResultCaptureDeps): Promise<ResultCaptureSummary> {
  const now = deps.now();
  const matches = await deps.listMatches();
  const summary: ResultCaptureSummary = {
    matches_inspected: matches.length, results_captured: 0, matches_with_final_result: 0,
    matches_unresolved: 0, runs_inspected: 0, observations_resolved: 0, observations_open: 0,
    wins: 0, losses: 0, open_reasons: {},
  };

  // PASS 1 -- capture. Ask the result source about every match that does not already hold a
  // winner, and write only what it actually returns.
  const byId = new Map<string, CaptureMatchRow>();
  for (const match of matches) {
    byId.set(match.id, match);
    if (String(match.actual_winner ?? "").trim()) continue;
    let found: CapturedResult | null = null;
    try {
      found = await deps.lookupResult(match);
    } catch (error) {
      await deps.log?.({ match_id: match.id, stage: "RESULT CAPTURE", status: "ERROR", output: { message: String(error) } });
      continue;
    }
    if (!found) continue;
    const patch = mergeCapturedResult(match, found, { now });
    if (!patch) continue;
    await deps.updateMatch(match.id, patch);
    byId.set(match.id, { ...match, ...(patch as Partial<CaptureMatchRow>) });
    summary.results_captured += 1;
    await deps.log?.({ match_id: match.id, stage: "RESULT CAPTURE", status: "COMPLETE", output: patch });
  }

  // PASS 2 -- resolve. Every decided run is graded against its own match's result. A run
  // whose match has no final result is not skipped silently: it is recorded as an OPEN
  // observation with the reason, so "unresolved" is always visible rather than absent.
  const runs = await deps.listDecidedRuns();
  const decisions = new Map((await deps.listDecisions()).map((d) => [d.audit_run_id, d]));
  const grades = new Map((await deps.listGrades()).map((g) => [`${g.match_id}|${g.audit_run_id ?? ""}`, g.id]));
  summary.runs_inspected = runs.length;

  for (const run of runs) {
    const match = byId.get(run.match_id);
    if (!match) continue;
    const selected = selectedPlayerForRun(run, decisions.get(run.id));
    const selection = resolvePredictionOutcome(selected, match);
    const independent = resolvePredictionOutcome(run.independent_winner, match);

    if (selection.resolved) {
      summary.observations_resolved += 1;
      if (selection.status === "WIN") summary.wins += 1; else summary.losses += 1;
    } else {
      summary.observations_open += 1;
      const reason = selection.reason ?? "unspecified";
      summary.open_reasons[reason] = (summary.open_reasons[reason] ?? 0) + 1;
    }

    const existingId = grades.get(`${match.id}|${run.id}`) ?? null;
    await deps.saveGrade(existingId, gradeRowFor({ match, run, selected, selection, independent, now }));
  }

  for (const match of byId.values()) {
    // Counted from the merged view, so a match resolved during PASS 1 counts as resolved here.
    if (matchResultIsFinal(match)) summary.matches_with_final_result += 1;
    else summary.matches_unresolved += 1;
  }
  return summary;
}

/**
 * The persisted observation. It carries the two names being compared and the verdict, and
 * nothing derived from evidence: no coverage, no metric count, no support percentage, no
 * probability. `counted_in_matrix_calibration` stays false because the Tennis Matrix
 * calibration is a separate population keyed on matrix_wp -- an engine result must never be
 * folded into it.
 */
function gradeRowFor(args: {
  match: CaptureMatchRow;
  run: CaptureRunRow;
  selected: string | null;
  selection: PredictionResolution;
  independent: PredictionResolution;
  now: Date;
}): Record<string, unknown> {
  const { match, run, selected, selection, independent, now } = args;
  return {
    match_id: match.id,
    audit_run_id: run.id,
    actual_winner: match.actual_winner ?? null,
    result_type: selection.result_type,
    final_selection: selected,
    final_selection_result: selection.resolved ? selection.status : "NOT GRADED",
    independent_winner: run.independent_winner ?? null,
    independent_audit_result: independent.resolved ? independent.status : "NOT GRADED",
    matrix_predicted_winner: null,
    matrix_wp: null,
    matrix_prediction_result: "NOT GRADED",
    counted_in_matrix_calibration: false,
    correction_pattern: "UNCLASSIFIED",
    note: selection.reason,
    graded_at: now.toISOString(),
  };
}

/** The resolved population: the only rows a future calibration layer may learn from. */
export function isResolvedGrade(row: Record<string, unknown>) {
  const status = String(row["final_selection_result"] ?? "");
  return (status === "WIN" || status === "LOSS") && Boolean(String(row["actual_winner"] ?? "").trim());
}
