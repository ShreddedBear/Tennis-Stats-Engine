import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  captureAndResolveResults, isResolvedGrade, selectedPlayerForRun,
  type CaptureMatchRow, type ResultCaptureDeps,
} from "./match-result-capture";
import {
  matchResultIsFinal, matchSideForName, mergeCapturedResult, resolvePredictionOutcome,
} from "./match-result-resolution";
import { resultStatusFromHistory } from "./match-result-resolution";
import { ACTIVE_METRIC_CODES } from "./truth-engine-active-metrics";

// A prediction wins because the player it named won. Nothing else may enter that judgement:
// not how much evidence was usable, not how many metrics are active, not how the surviving
// evidence was distributed. These tests pin that, and pin the other half of the contract --
// an unknown result is OPEN, never a loss.

const P1 = "Gonzalo Bueno", P2 = "Joao Lucas Reis Da Silva";

function match(overrides: Partial<CaptureMatchRow> = {}): CaptureMatchRow {
  return {
    id: "m1", player1_name: P1, player2_name: P2, tournament_name: "ATP Challenger Como",
    scheduled_date: "2026-08-31", surface: "Clay",
    actual_winner: null, result_status: "UNKNOWN", final_score: null, ...overrides,
  };
}

/** A decision record shaped like the one FINAL DECISION persists, with tunable diagnostics. */
function decisionRecord(selected: string | null, diagnostics: Record<string, unknown> = {}) {
  return {
    schema_version: 1, outcome: selected ? "P1" : "INSUFFICIENT_EVIDENCE", selected_player: selected,
    evidence_support_percent: 75, directional_families: 4, corroborated: true,
    evidence_coverage_usable: 4, evidence_coverage_expected: ACTIVE_METRIC_CODES.length,
    evidence_coverage_percent: 16, actual_winner: null, decision_correct: null, ...diagnostics,
  };
}

type Harness = { deps: ResultCaptureDeps; matches: CaptureMatchRow[]; grades: Array<Record<string, unknown> & { id: string }>; updates: Array<[string, Record<string, unknown>]> };

function harness(options: {
  matches?: CaptureMatchRow[];
  selected?: string | null;
  independentWinner?: string | null;
  diagnostics?: Record<string, unknown>;
  lookup?: (m: CaptureMatchRow) => { actual_winner: string | null; result_status: string | null; final_score?: string | null } | null;
} = {}): Harness {
  const matches = options.matches ?? [match()];
  const selected = options.selected === undefined ? P1 : options.selected;
  const grades: Array<Record<string, unknown> & { id: string }> = [];
  const updates: Array<[string, Record<string, unknown>]> = [];
  const deps: ResultCaptureDeps = {
    now: () => new Date("2026-09-04T00:00:00Z"),
    async listMatches() { return matches; },
    async updateMatch(id, patch) {
      updates.push([id, patch]);
      const row = matches.find((m) => m.id === id)!;
      Object.assign(row, patch);
    },
    async lookupResult(m) { return options.lookup ? options.lookup(m) : null; },
    async listDecidedRuns() { return matches.map((m, i) => ({ id: `run${i}`, match_id: m.id, run_number: 1, independent_winner: options.independentWinner === undefined ? selected : options.independentWinner })); },
    async listDecisions() { return matches.map((_, i) => ({ audit_run_id: `run${i}`, gate_report: { deterministic_decision: decisionRecord(selected, options.diagnostics) } })); },
    async listGrades() { return grades.map((g) => ({ id: g.id, match_id: String(g["match_id"]), audit_run_id: String(g["audit_run_id"]) })); },
    async saveGrade(existingId, row) {
      if (existingId) { Object.assign(grades.find((g) => g.id === existingId)!, row); return; }
      grades.push({ id: `g${grades.length}`, ...row });
    },
  };
  return { deps, matches, grades, updates };
}

describe("an unknown result is open, never a loss", () => {
  it("A. a null actual winner leaves the observation unresolved", async () => {
    const h = harness();
    const summary = await captureAndResolveResults(h.deps);
    expect(summary.observations_resolved).toBe(0);
    expect(summary.losses).toBe(0);
    expect(summary.observations_open).toBe(1);
    expect(h.grades[0]["final_selection_result"]).toBe("NOT GRADED");
    expect(isResolvedGrade(h.grades[0])).toBe(false);
  });

  it("F. postponed, cancelled, abandoned and walkover can never become a loss", async () => {
    for (const status of ["POSTPONED", "CANCELLED", "ABANDONED", "WALKOVER", "SCHEDULED", "IN_PROGRESS"]) {
      // Note the winner IS named here -- a walkover even names a real one. Status alone
      // must keep it out.
      const h = harness({ matches: [match({ actual_winner: P2, result_status: status })] });
      const summary = await captureAndResolveResults(h.deps);
      expect(summary.losses, status).toBe(0);
      expect(summary.observations_resolved, status).toBe(0);
      expect(String(h.grades[0]["note"]), status).toContain(status);
    }
  });

  it("L. only a played, finished result enters the resolved population", async () => {
    expect(matchResultIsFinal(match({ actual_winner: P1, result_status: "FINAL" }))).toBe(true);
    expect(matchResultIsFinal(match({ actual_winner: P1, result_status: "RETIRED" }))).toBe(true);
    expect(matchResultIsFinal(match({ actual_winner: P1, result_status: "WALKOVER" }))).toBe(false);
    expect(matchResultIsFinal(match({ actual_winner: null, result_status: "FINAL" }))).toBe(false);
    // A winner who is not one of the two players cannot finalize the match either.
    expect(matchResultIsFinal(match({ actual_winner: "Novak Djokovic", result_status: "FINAL" }))).toBe(false);
  });

  it("a run that selected nobody stays unresolved even against a known result", async () => {
    const h = harness({ selected: null, independentWinner: null, matches: [match({ actual_winner: P1, result_status: "FINAL" })] });
    const summary = await captureAndResolveResults(h.deps);
    expect(summary.observations_resolved).toBe(0);
    expect(summary.matches_with_final_result).toBe(1);
    expect(String(h.grades[0]["note"])).toContain("selected no player");
  });
});

describe("grading is a comparison of two names", () => {
  it("B/C/D/E. each selection/result pairing produces the right verdict", async () => {
    const cases: Array<[string, string, "WIN" | "LOSS"]> = [
      [P1, P1, "WIN"], [P1, P2, "LOSS"], [P2, P2, "WIN"], [P2, P1, "LOSS"],
    ];
    for (const [selected, actual, expected] of cases) {
      const h = harness({ selected, matches: [match({ actual_winner: actual, result_status: "FINAL" })] });
      const summary = await captureAndResolveResults(h.deps);
      expect(h.grades[0]["final_selection_result"], `${selected}/${actual}`).toBe(expected);
      expect(summary.wins).toBe(expected === "WIN" ? 1 : 0);
      expect(summary.losses).toBe(expected === "LOSS" ? 1 : 0);
      expect(isResolvedGrade(h.grades[0])).toBe(true);
    }
  });

  it("K. swapping which player is P1 inverts nothing about the verdict", async () => {
    const forward = harness({ selected: P1, matches: [match({ actual_winner: P1, result_status: "FINAL" })] });
    const inverted = harness({ selected: P1, matches: [match({ player1_name: P2, player2_name: P1, actual_winner: P1, result_status: "FINAL" })] });
    await captureAndResolveResults(forward.deps);
    await captureAndResolveResults(inverted.deps);
    // Same selection, same real winner, opposite slots -> still a WIN.
    expect(forward.grades[0]["final_selection_result"]).toBe("WIN");
    expect(inverted.grades[0]["final_selection_result"]).toBe("WIN");
    // And selecting the other player inverts the verdict from either orientation.
    for (const slots of [{}, { player1_name: P2, player2_name: P1 }]) {
      const h = harness({ selected: P2, matches: [match({ ...slots, actual_winner: P1, result_status: "FINAL" })] });
      await captureAndResolveResults(h.deps);
      expect(h.grades[0]["final_selection_result"]).toBe("LOSS");
    }
  });

  it("a surname-only result grades against the full selected name, but never across players", () => {
    expect(resolvePredictionOutcome(P1, match({ actual_winner: "Bueno", result_status: "FINAL" })).status).toBe("WIN");
    expect(resolvePredictionOutcome(P1, match({ actual_winner: "Reis Da Silva", result_status: "FINAL" })).status).toBe("LOSS");
    // A name that could be either player resolves to neither.
    expect(matchSideForName("Bueno", match({ player1_name: "Gonzalo Bueno", player2_name: "Ignacio Bueno" }))).toBeNull();
    expect(resolvePredictionOutcome("Bueno", match({ player1_name: "Gonzalo Bueno", player2_name: "Ignacio Bueno", actual_winner: "Gonzalo Bueno", result_status: "FINAL" })).status).toBe("UNRESOLVED");
  });

  it("retirements grade as real results, in the vocabulary the ledger already uses", () => {
    expect(resolvePredictionOutcome(P1, match({ actual_winner: P1, result_status: "RETIRED" })).result_type).toBe("RETIREMENT WIN");
    expect(resolvePredictionOutcome(P2, match({ actual_winner: P1, result_status: "RETIRED" })).result_type).toBe("RETIREMENT LOSS");
  });
});

describe("a recorded result is never destroyed", () => {
  it("G. a null, blank or absent capture leaves an existing winner intact", () => {
    const held = { actual_winner: P1, result_status: "FINAL", final_score: "6-4 6-3" };
    for (const incoming of [{ actual_winner: null, result_status: "FINAL" }, { actual_winner: "  ", result_status: "FINAL" }, { actual_winner: null, result_status: null }]) {
      expect(mergeCapturedResult(held, incoming)).toBeNull();
    }
    // Nor does a DIFFERENT winner overwrite it: that is a conflict to look at, not to resolve.
    expect(mergeCapturedResult(held, { actual_winner: P2, result_status: "FINAL" })).toBeNull();
    expect(mergeCapturedResult(held, { actual_winner: P2, result_status: "FINAL" }, { allowOverwrite: true })).toMatchObject({ actual_winner: P2 });
    // And an OPEN match is not "written blank" either -- a source that found nothing must
    // leave result_status/result_recorded_at untouched rather than stamping an empty result.
    const open = { actual_winner: null, result_status: "UNKNOWN", final_score: null };
    for (const incoming of [{ actual_winner: null, result_status: "FINAL" }, { actual_winner: "   ", result_status: "FINAL" }, { actual_winner: null, result_status: null }]) {
      expect(mergeCapturedResult(open, incoming)).toBeNull();
    }
  });

  it("a source that found nothing writes nothing and leaves the match open", async () => {
    const h = harness({ lookup: () => ({ actual_winner: null, result_status: "FINAL" }) });
    const summary = await captureAndResolveResults(h.deps);
    expect(h.updates).toEqual([]);
    expect(summary.results_captured).toBe(0);
    expect(summary.matches_unresolved).toBe(1);
    expect(h.matches[0].result_status).toBe("UNKNOWN");
  });

  it("the capture pass never writes to a match that already holds a result", async () => {
    const h = harness({
      matches: [match({ actual_winner: P1, result_status: "FINAL" })],
      lookup: () => ({ actual_winner: P2, result_status: "FINAL" }),
    });
    await captureAndResolveResults(h.deps);
    expect(h.updates).toEqual([]);
    expect(h.matches[0].actual_winner).toBe(P1);
  });

  it("captures a result onto an open match and grades it in the same pass", async () => {
    const h = harness({ lookup: () => ({ actual_winner: P2, result_status: "FINAL", final_score: "6-4 6-3" }) });
    const summary = await captureAndResolveResults(h.deps);
    expect(summary.results_captured).toBe(1);
    expect(h.updates[0][1]).toMatchObject({ actual_winner: P2, result_status: "FINAL", final_score: "6-4 6-3" });
    expect(h.updates[0][1]["result_recorded_at"]).toBe("2026-09-04T00:00:00.000Z");
    expect(h.grades[0]["final_selection_result"]).toBe("LOSS");
    expect(summary.matches_with_final_result).toBe(1);
    expect(summary.matches_unresolved).toBe(0);
  });

  it("re-running updates the existing grade rather than duplicating the observation", async () => {
    const h = harness({ matches: [match({ actual_winner: P1, result_status: "FINAL" })] });
    await captureAndResolveResults(h.deps);
    await captureAndResolveResults(h.deps);
    expect(h.grades).toHaveLength(1);
    expect(h.grades[0]["final_selection_result"]).toBe("WIN");
  });
});

/** Comments explain what a module must NOT do, and name those things; code is the claim. */
function codeOf(path: string) {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("evidence never enters the verdict", () => {
  const resolution = codeOf("src/match-result-resolution.ts");
  const capture = codeOf("src/match-result-capture.ts");

  it("H/I/J. the resolution primitives never reference coverage, the active registry or probability", () => {
    // The grading module cannot even name these things, so no future edit can quietly wire
    // one in without this failing.
    for (const forbidden of ["coverage", "ACTIVE_METRIC", "activeMetricReadiness", "evidence_support", "evidence_percent", "probability", "win_probability", "bucketFor"]) {
      expect(resolution, forbidden).not.toContain(forbidden);
    }
    // The orchestrator may READ a decision record, but only ever for selected_player.
    expect(capture).toContain('"selected_player"');
    for (const forbidden of ["evidence_coverage", "evidence_support_percent", "activeMetricReadiness", "bucketFor", "probability"]) {
      expect(capture, forbidden).not.toContain(forbidden);
    }
    // resolvePredictionOutcome's signature admits nothing but names and status.
    expect(resolution).toContain("resolvePredictionOutcome(\n  selectedPlayer: string | null | undefined,\n  facts: MatchResultFacts,\n)");
  });

  it("H. wildly different evidence coverage grades identically", async () => {
    const verdicts = new Set<string>();
    for (const coverage of [{ evidence_coverage_usable: 1, evidence_coverage_percent: 4 }, { evidence_coverage_usable: 25, evidence_coverage_percent: 100 }]) {
      const h = harness({ diagnostics: coverage, matches: [match({ actual_winner: P2, result_status: "FINAL" })] });
      await captureAndResolveResults(h.deps);
      verdicts.add(String(h.grades[0]["final_selection_result"]));
    }
    expect([...verdicts]).toEqual(["LOSS"]);
  });

  it("I. the active-metric denominator is not the calibration denominator", async () => {
    // Two matches, one graded and one open. The resolved population is 1 -- it is counted
    // from observations, and has nothing to do with how many metrics are active.
    const h = harness({
      matches: [match({ id: "a", actual_winner: P1, result_status: "FINAL" }), match({ id: "b" })],
    });
    const summary = await captureAndResolveResults(h.deps);
    expect(summary.observations_resolved).toBe(1);
    expect(summary.observations_open).toBe(1);
    expect(summary.observations_resolved + summary.observations_open).toBe(2);
    expect(summary.observations_resolved).not.toBe(ACTIVE_METRIC_CODES.length);
    expect(h.grades.filter(isResolvedGrade)).toHaveLength(1);
  });

  it("J. evidence support is not carried into the observation as a probability", async () => {
    const h = harness({ diagnostics: { evidence_support_percent: 92 }, matches: [match({ actual_winner: P1, result_status: "FINAL" })] });
    await captureAndResolveResults(h.deps);
    const row = h.grades[0];
    // The grade holds names and verdicts only. No numeric confidence of any kind survives
    // into it -- in particular matrix_wp, the one probability column, stays null.
    expect(row["matrix_wp"]).toBeNull();
    expect(row["counted_in_matrix_calibration"]).toBe(false);
    expect(row["matrix_prediction_result"]).toBe("NOT GRADED");
    expect(Object.entries(row).filter(([, v]) => typeof v === "number")).toEqual([]);
    expect(JSON.stringify(row)).not.toContain("92");
  });

  it("M. inactive metrics cannot change the resolved population", async () => {
    // Same decision, same real winner; the second run's record claims coverage that includes
    // metrics outside the active registry. The observation is identical either way.
    const plain = harness({ matches: [match({ actual_winner: P1, result_status: "FINAL" })] });
    const inflated = harness({
      diagnostics: { evidence_coverage_usable: 81, evidence_coverage_expected: 81, evidence_coverage_percent: 100 },
      matches: [match({ actual_winner: P1, result_status: "FINAL" })],
    });
    await captureAndResolveResults(plain.deps);
    const inflatedSummary = await captureAndResolveResults(inflated.deps);
    expect(inflatedSummary.observations_resolved).toBe(1);
    const strip = (row: Record<string, unknown>) => ({ ...row, id: undefined });
    expect(strip(inflated.grades[0])).toEqual(strip(plain.grades[0]));
  });
});

describe("the engine's prediction is read from the right field", () => {
  it("prefers the persisted decision record over the older run column", () => {
    expect(selectedPlayerForRun({ id: "r", match_id: "m", run_number: 1, independent_winner: P2 }, { audit_run_id: "r", gate_report: { deterministic_decision: { selected_player: P1 } } })).toBe(P1);
  });

  it("treats an explicit refusal as a refusal instead of falling back", () => {
    expect(selectedPlayerForRun({ id: "r", match_id: "m", run_number: 1, independent_winner: P2 }, { audit_run_id: "r", gate_report: { deterministic_decision: { selected_player: null } } })).toBeNull();
  });

  it("falls back to independent_winner for runs decided before the record existed", () => {
    expect(selectedPlayerForRun({ id: "r", match_id: "m", run_number: 1, independent_winner: P2 }, undefined)).toBe(P2);
  });

  it("never reads final_decisions.final_selection, which holds an action and not a player", () => {
    const capture = codeOf("src/match-result-capture.ts");
    expect(capture).not.toMatch(/decision(\?)?\.final_selection/);
    expect(capture).not.toContain('["final_selection"]');
  });
});

describe("the result source reads real recorded history", () => {
  it("classifies scorelines that name a winner without a played match", () => {
    expect(resultStatusFromHistory({ raw_score: "6-4 6-3" })).toBe("FINAL");
    expect(resultStatusFromHistory({ raw_score: "6-4 2-1 ret." })).toBe("RETIRED");
    expect(resultStatusFromHistory({ raw_score: "w/o" })).toBe("WALKOVER");
    expect(resultStatusFromHistory({ raw_score: "def." })).toBe("WALKOVER");
    expect(resultStatusFromHistory({ status: "FINISHED" })).toBe("FINAL");
    expect(resultStatusFromHistory({ status: "CANCELED" })).toBe("CANCELLED");
    // A row with nothing recorded is still a played result: it only exists because a match
    // was completed. An unrecognised status is not, and stays open.
    expect(resultStatusFromHistory(undefined)).toBe("FINAL");
    expect(resultStatusFromHistory({ status: "SOMETHING NEW" })).toBeNull();
  });

  it("the audited match's own result stays out of every evidence path", () => {
    // This reader returns the result of the very match being predicted. It is admissible
    // only after the fact; a metric or research module importing it would be a leak.
    // The reader that returns the audited match's own result lives in the server package
    // (@workspace/audit-server), which owns data access; its guard travels with it there.
    // What this package can and must still prove is the half that matters most: no module
    // inside the frozen engine imports the result-capture path at all.
    for (const consumer of [
      "src/audit-pipeline.ts",
      "src/truth-engine-decision.ts", "src/truth-engine-audit.ts",
      "src/truth-engine-metric-comparison.ts", "src/truth-engine-decision-record.ts",
    ]) {
      expect(codeOf(consumer), consumer).not.toContain("match-result-capture");
    }
  });
});

// NOTE: the "end to end, against the real result store" suite that used to close this file
// travels with the data-access layer, not the engine. It imports repositoryFinalResult from
// the result store to prove the live chain actually closes, and that reader lives in
// @workspace/audit-server. It is re-established there, against the monorepo's own store, so
// the guarantee is kept rather than quietly dropped in the move.
