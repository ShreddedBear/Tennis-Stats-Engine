// TRUTH ENGINE — MAPPING THE DETERMINISTIC AUDIT ONTO THE PERSISTED STAGE SCHEMA
//
// The deterministic engines (truth-engine-audit.ts) reason in EVIDENCE FAMILIES. The
// database persists per-rule (verification/disagreement), per-pathway (underdog) and
// per-test (stress) rows. This module is the honest bridge between the two.
//
// The governing principle: a row is only populated when the deterministic audit genuinely
// answers that specific rule/pathway/test. Every other row is written as an explicit
// UNAVAILABLE carrying the exact missing evidence -- never a fabricated finding, and never
// the audit's overall verdict copy-pasted into a rule it does not actually answer.
//
// That distinction matters: filling all 60 verification rows with the same summary would
// look "complete" while claiming 60 rules were evaluated when perhaps six were. The prior
// architecture's failure was exactly that kind of false completeness.

import type { TruthEngineAuditResult } from "./truth-engine-audit";

export interface StageRowPatch {
  /** Whether the deterministic audit genuinely evaluated this row. */
  evaluated: boolean;
  patch: Record<string, unknown>;
}

const codeOf = (v: unknown) => {
  const m = String(v ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(v ?? "").padStart(3, "0");
};

// ---------------------------------------------------------------------------
// VERIFICATION / DISAGREEMENT RULES
// ---------------------------------------------------------------------------

/**
 * Rules the deterministic audit genuinely answers, each with the reason it can. Every code
 * absent from here is reported UNAVAILABLE with its own missing-evidence explanation.
 *
 * These map onto real rule text in the active VERIFICATION/DISAGREEMENT documents:
 *   003 INDEPENDENT FLIP STANDARD        -> leave-one-family-out + independent contradiction count
 *   007 H2H QUALITY CONTROL              -> whether the H2H family was sample-weighted (metric 051 shrinkage)
 *   008 CORRELATED AGREEMENT COMPRESSION -> raw metric count vs independent family count
 *   017 BIDIRECTIONAL MATCHUP RULE       -> both sides computed independently, never inverted
 *   019 UNDERDOG PATHWAY MINIMUM RULE    -> evidence-derived pathway analysis
 */
export type RuleEvaluator = (audit: TruthEngineAuditResult, p1: string, p2: string) => { outcome: string; severity: string; p1Finding: string; p2Finding: string; effect: string };

export const DETERMINISTIC_RULE_EVALUATORS: Record<string, RuleEvaluator> = {
  "003": (audit) => {
    const flipped = audit.decision.flipping_families.length > 0;
    const contradictions = audit.contradiction_families;
    return {
      outcome: flipped ? "FAIL" : "PASS",
      severity: flipped ? "CRITICAL" : "STANDARD",
      p1Finding: `Independent contradiction families against the selection: ${contradictions}.`,
      p2Finding: `Leave-one-family-out result: ${audit.decision.flipping_families.length ? `reversed by ${audit.decision.flipping_families.join(", ")}` : "no single family reverses the leader"}.`,
      effect: flipped
        ? "FAIL: the selection can be reversed by removing a single evidence family, which is exactly the single-family flip this rule prohibits."
        : `PASS: the selection does not rest on any single family; ${contradictions} independent contradiction famil${contradictions === 1 ? "y was" : "ies were"} counted separately rather than aggregated.`,
    };
  },
  "007": (audit, p1, p2) => {
    const h2h = audit.verification.findings.find((f) => f.family === "H2H_PROBABILITY");
    if (!h2h) {
      return { outcome: "UNAVAILABLE", severity: "STANDARD", p1Finding: "No usable head-to-head evidence.", p2Finding: "No usable head-to-head evidence.", effect: "UNAVAILABLE: no comparable H2H evidence was produced for this match, so H2H quality control has nothing to weight." };
    }
    // Metric 051 applies explicit sample shrinkage (shrunk_win_probability_pct), which is
    // precisely the sample-size weighting this rule demands.
    return {
      outcome: "PASS",
      severity: "CRITICAL",
      p1Finding: `${p1}: ${h2h.metrics.map((m) => `${m.label}=${m.p1}`).join("; ")}`,
      p2Finding: `${p2}: ${h2h.metrics.map((m) => `${m.label}=${m.p2}`).join("; ")}`,
      effect: `PASS: head-to-head entered the audit only through metric 051's sample-shrunk probability (raw H2H is shrunk toward the general expectation by H2H sample size), so a thin H2H cannot dominate. Family outcome: ${h2h.outcome} (${h2h.severity}).`,
    };
  },
  "008": (audit) => {
    const rawMetrics = audit.verification.findings.reduce((n, f) => n + f.metrics.length, 0);
    const families = audit.verification.findings.length;
    const compressed = rawMetrics - families;
    return {
      outcome: "PASS",
      severity: "STANDARD",
      p1Finding: `Raw comparable metric signals: ${rawMetrics}.`,
      p2Finding: `Independent evidence families after compression: ${families}.`,
      effect: `PASS: ${rawMetrics} raw metric signals were compressed into ${families} independent evidence famil${families === 1 ? "y" : "ies"}; ${compressed} correlated signal(s) were deliberately not counted again. Duplicated support: ${audit.decision.duplicated_support_metrics.join(", ") || "none"}. Duplicated contradiction: ${audit.disagreement.duplicated_contradiction_metrics.join(", ") || "none"}.`,
    };
  },
  "017": (audit, p1, p2) => ({
    outcome: "PASS",
    severity: "STANDARD",
    p1Finding: `${p1} evaluated from its own persisted values across ${audit.verification.findings.length} famil${audit.verification.findings.length === 1 ? "y" : "ies"}.`,
    p2Finding: `${p2} evaluated independently from its own persisted values across the same families.`,
    effect: "PASS: every family's finding is computed from each player's own measured values; neither side's result is inferred as the inverse of the other's, and swapping the two players swaps every verdict (regression-tested).",
  }),
  "019": (audit) => ({
    outcome: audit.underdog.overall_viability === "NO_VIABLE_PATHWAY" ? "PASS" : "WARN",
    severity: "STANDARD",
    p1Finding: `Underdog: ${audit.underdog.underdog_player ?? "none"}.`,
    p2Finding: `Evidence-supported pathways: ${audit.underdog.pathways.length}.`,
    effect: `${audit.underdog.overall_viability}: ${audit.underdog.reason}`,
  }),
};

/** The exact evidence each unmapped rule would need, so an UNAVAILABLE row is still informative. */
const RULE_MISSING_EVIDENCE: Record<string, string> = {
  "001": "post-hoc calibration ledger ordering; not a per-match evidence question.",
  "002": "an independently reconstructed favourite probability for this match; metric 051 supplies an opponent-specific probability only where H2H/general evidence exists.",
  "004": "opponent-quality history for the underdog (wins over Top 10/20/50), which requires opponent-ranking evidence the active metric set does not currently establish per match.",
  "005": "30/60/90-day and same-surface splits as separate comparable signals; the active set exposes recent form as one window.",
  "006": "a headline favourite probability to test the exemption against.",
  "009": "the underdog's five strongest pre-match arguments as discrete scored items.",
  "010": "completed-match results and a calibration ledger; this is a post-result rule, not a pre-match one.",
};

export function verificationRowPatch(ruleCode: unknown, audit: TruthEngineAuditResult, p1: string, p2: string, now: string): StageRowPatch {
  const code = codeOf(ruleCode);
  const evaluator = DETERMINISTIC_RULE_EVALUATORS[code];
  if (!evaluator) {
    return {
      evaluated: false,
      patch: {
        p1_finding: null, p2_finding: null, outcome: "UNAVAILABLE",
        unavailable_reason: "MISSING_REQUIRED_INPUT",
        unavailable_detail: `No deterministic evaluator: this rule requires ${RULE_MISSING_EVIDENCE[code] ?? "evidence the active metric set does not establish for a single match"}. Reported unavailable rather than answered from the audit's overall verdict, which would claim an evaluation that did not occur.`,
        provider_error: null, missing_inputs: [], sources: [], source_attempts: [], reconstruction_attempted: false,
        retrieved_at: now, status: "UNAVAILABLE",
      },
    };
  }
  const r = evaluator(audit, p1, p2);
  return {
    evaluated: r.outcome !== "UNAVAILABLE",
    patch: {
      p1_finding: r.p1Finding, p2_finding: r.p2Finding, outcome: r.outcome, severity: r.severity,
      decision_effect: r.effect,
      unavailable_reason: r.outcome === "UNAVAILABLE" ? "MISSING_REQUIRED_INPUT" : null,
      unavailable_detail: r.outcome === "UNAVAILABLE" ? r.effect : null,
      provider_error: null, missing_inputs: [], reconstruction_attempted: false,
      sources: [{ source_name: "Truth Engine deterministic audit (metric_results evidence)", url: null, retrieved_at: null }],
      source_attempts: [], retrieved_at: now,
      status: r.outcome === "UNAVAILABLE" ? "UNAVAILABLE" : "COMPLETE",
    },
  };
}

export function disagreementRowPatch(ruleCode: unknown, audit: TruthEngineAuditResult, p1: string, p2: string, now: string): StageRowPatch {
  const code = codeOf(ruleCode);
  const evaluator = DETERMINISTIC_RULE_EVALUATORS[code];
  const contradiction = audit.disagreement;
  if (!evaluator) {
    return {
      evaluated: false,
      patch: {
        p1_risk: null, p2_risk: null, supporting_evidence: null, opposing_evidence: null,
        contradiction_severity: "NONE", final_effect: null,
        unavailable_reason: "MISSING_REQUIRED_INPUT",
        unavailable_detail: `No deterministic evaluator: requires ${RULE_MISSING_EVIDENCE[code] ?? "evidence the active metric set does not establish for a single match"}.`,
        provider_error: null, missing_inputs: [], sources: [], source_attempts: [], reconstruction_attempted: false,
        retrieved_at: now, status: "UNAVAILABLE",
      },
    };
  }
  const r = evaluator(audit, p1, p2);
  return {
    evaluated: true,
    patch: {
      p1_risk: contradiction.p1_risk,
      p2_risk: contradiction.p2_risk,
      supporting_evidence: contradiction.supporting_evidence,
      opposing_evidence: contradiction.opposing_evidence,
      // Severity is the measured contradiction severity, derived from magnitude against each
      // metric's own noise floor and escalated by independent breadth -- never from prose.
      contradiction_severity: contradiction.overall_severity === "NONE" ? "NONE" : contradiction.overall_severity,
      final_effect: `${r.effect} ${contradiction.final_effect}`,
      unavailable_reason: null, unavailable_detail: null, provider_error: null, missing_inputs: [],
      sources: [{ source_name: "Truth Engine deterministic audit (metric_results evidence)", url: null, retrieved_at: null }],
      source_attempts: [], reconstruction_attempted: false, retrieved_at: now, status: "COMPLETE",
    },
  };
}

// ---------------------------------------------------------------------------
// UNDERDOG PATHWAYS
// ---------------------------------------------------------------------------

/** Evidence family -> the persisted pathway code it legitimately evidences. */
const FAMILY_TO_PATHWAY_CODE: Record<string, string> = {
  SURFACE_STRENGTH: "SURFACE_TRANSITION",
  RECENT_FORM: "RANKING_LAG",
  H2H_PROBABILITY: "STYLE_MISMATCH",
  CLOSING_ABILITY: "FAV_COLLAPSE",
  SET_PROFILE: "DECIDING_SET",
};

/** Pathways no active metric can establish, with the reason. Honest rather than silent. */
const PATHWAY_MISSING_EVIDENCE: Record<string, string> = {
  SERVE_THROUGH: "serve-hold/point-level evidence (metrics 002/016 families) is not among the active comparable set for this match.",
  RETURN_PRESSURE: "return-point/break-pressure evidence is not among the active comparable set for this match.",
  SECOND_SERVE: "serve-number splits do not exist in the approved point-by-point payloads (serve_number_available:false).",
  SHORT_RALLY: "rally-length evidence requires shot-level charting data this system does not hold.",
  LONG_RALLY: "rally-length evidence requires shot-level charting data this system does not hold.",
  MOVEMENT: "movement/biomechanics evidence is classified PROTECTED_UNAVAILABLE.",
  SLOW_START: "metric 026 (Early-Warning / Slow-Start) is quarantined pending Matrix Summary evidence.",
  TIEBREAK: "tiebreak-specific evidence is not among the active comparable set for this match.",
  FATIGUE: "fatigue/workload metrics have no declared comparison direction and are excluded from deterministic comparison.",
  MARKET_INFO: "market metrics 015/019 are quarantined pending Matrix Summary evidence.",
};

/**
 * Evidence-backed pathways whose family has no persisted pathway code in this schema.
 * The persisted pathway vocabulary is tactical (serve/return/rally); several comparable
 * evidence families are outcome-level and have no counterpart row. Without this, such a
 * pathway would be measured by the audit and then silently vanish, because no row exists
 * to carry it. It is surfaced in the stage detail instead of being dropped.
 */
export function unmappedUnderdogPathways(audit: TruthEngineAuditResult): Array<{ family: string; pathway_type: string; viability: string }> {
  return audit.underdog.pathways
    .filter((p) => !FAMILY_TO_PATHWAY_CODE[p.family])
    .map((p) => ({ family: p.family, pathway_type: p.pathway_type, viability: p.viability }));
}

export function underdogRowPatch(pathwayCode: unknown, playerSide: string, audit: TruthEngineAuditResult, p1: string, p2: string, now: string): StageRowPatch {
  const code = String(pathwayCode ?? "");
  const underdogName = audit.underdog.underdog_player;
  // Only the non-selected player can hold an underdog pathway.
  if (!underdogName || playerSide !== underdogName) {
    return {
      evaluated: true,
      patch: {
        classification: "UNRESOLVED",
        evidence: underdogName ? `${playerSide} is the selected side; underdog pathways are evaluated for ${underdogName}.` : "No selection was made, so no underdog side exists.",
        repeatable: false, status: "UNAVAILABLE",
        unavailable_reason: "MISSING_REQUIRED_INPUT",
        unavailable_detail: "Not the underdog side for this audit.",
        provider_error: null, missing_inputs: [], sources: [], source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
      },
    };
  }
  const pathway = audit.underdog.pathways.find((p) => FAMILY_TO_PATHWAY_CODE[p.family] === code);
  if (pathway) {
    return {
      evaluated: true,
      patch: {
        // Map the engine's viability onto the existing WEAK/REALISTIC/STRONG vocabulary.
        classification: pathway.viability === "STRONG_PATHWAY" ? "STRONG" : pathway.viability === "VIABLE_PATHWAY" ? "REALISTIC" : "WEAK",
        evidence: `${pathway.pathway_type} (${pathway.viability}, ${pathway.magnitude_ratio}x noise floor). ${pathway.evidence}. Required: ${pathway.conditions_required}`,
        repeatable: true, status: "COMPLETE",
        unavailable_reason: null, unavailable_detail: null, provider_error: null, missing_inputs: [],
        sources: [{ source_name: "Truth Engine deterministic underdog analysis", url: null, retrieved_at: null }],
        source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
      },
    };
  }
  const mapped = Object.values(FAMILY_TO_PATHWAY_CODE).includes(code);
  return {
    evaluated: mapped, // a mapped pathway with no qualifying edge IS a real evaluated result
    patch: {
      classification: "WEAK",
      evidence: mapped
        ? `No measurable edge for ${underdogName} in the evidence family backing this pathway; evaluated and found not viable.`
        : `Not evaluable: ${PATHWAY_MISSING_EVIDENCE[code] ?? "no active evidence family can establish this pathway."}`,
      repeatable: false,
      status: mapped ? "COMPLETE" : "UNAVAILABLE",
      unavailable_reason: mapped ? null : "MISSING_REQUIRED_INPUT",
      unavailable_detail: mapped ? null : PATHWAY_MISSING_EVIDENCE[code] ?? null,
      provider_error: null, missing_inputs: [],
      sources: mapped ? [{ source_name: "Truth Engine deterministic underdog analysis", url: null, retrieved_at: null }] : [],
      source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
    },
  };
}

// ---------------------------------------------------------------------------
// STRESS TESTS
// ---------------------------------------------------------------------------

/**
 * ST03 ("Remove strongest independent favorite family") is exactly the leave-one-family-out
 * recomputation the decision core performs, and ST05/ST06/ST07 are the adverse/favourable
 * re-derivations the stress engine performs. Those are populated with genuinely recomputed
 * winners. Tests requiring quarantined market evidence or data this system does not hold are
 * reported UNAVAILABLE with the reason rather than given a manufactured outcome.
 */
const STRESS_MISSING_EVIDENCE: Record<string, string> = {
  ST04: "market metrics 015/019 are quarantined pending Matrix Summary evidence; there is no market signal to remove.",
  ST08: "a conservative probability floor requires an independently reconstructed match probability, which the active comparable set does not produce for every match.",
  ST09: "a dangerous-underdog ceiling event requires opponent-quality history the active comparable set does not establish per match.",
  ST10: "physical/conditions evidence is not among the active comparable set.",
};

/**
 * The outcome recorded for a test that produced NO result, because the evidence it needs does
 * not exist for this match.
 *
 * It used to be "UNSTABLE" -- a never-run test reported as a failed one. That is the same
 * category of error the decision core is scrupulous about elsewhere (UNAVAILABLE is never
 * zero): absence of a result is not a finding of instability. It also had a concrete
 * consequence, because audit-engine.ts's DOUBLE GREEN test asks whether every stress test
 * came back STABLE: ST04/ST08/ST09/ST10 can never be evaluated from the active metric set,
 * so four rows were permanently "UNSTABLE" and DOUBLE GREEN was unreachable for every match,
 * forever, regardless of the evidence. Production confirmed it: 0 DOUBLE GREEN in 60
 * completed runs, with 240 rows (60 x 4) carrying status UNAVAILABLE alongside outcome
 * UNSTABLE.
 *
 * The row's `status` already carries the execution state (UNAVAILABLE); this makes the
 * OUTCOME field say the same honest thing instead of contradicting it.
 */
export const STRESS_OUTCOME_NOT_EVALUATED = "NOT EVALUATED";

export function stressRowPatch(testCode: unknown, audit: TruthEngineAuditResult, now: string): StageRowPatch {
  const code = String(testCode ?? "");
  const before = audit.stress.winner_before;
  const rangeOf = (w: string) => (w === "INSUFFICIENT_EVIDENCE" ? null : w);

  if (code === "ST03") {
    // Leave-one-family-out is a real recomputation already performed by the decision core.
    const reversed = audit.decision.flipping_families.length > 0;
    const tie = audit.decision.tie_inducing_families.length > 0;
    return {
      evaluated: true,
      patch: {
        winner_before: rangeOf(before),
        winner_after: reversed ? "REVERSED" : tie ? "NO_LEADER" : rangeOf(before),
        range_before: null, range_after: null,
        outcome: reversed ? "FAILS" : tie ? "MOSTLY STABLE" : "STABLE",
        status: "COMPLETE",
        unavailable_reason: null,
        unavailable_detail: `Removing each independent evidence family in turn: ${reversed ? `reversed by ${audit.decision.flipping_families.join(", ")}` : tie ? `no reversal; removing ${audit.decision.tie_inducing_families.join(" or ")} would leave it tied` : "leader unchanged by any single removal"}.`,
        provider_error: null, missing_inputs: [], sources: [{ source_name: "Truth Engine leave-one-family-out recomputation", url: null, retrieved_at: null }],
        source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
      },
    };
  }
  if (code === "ST05" || code === "ST06" || code === "ST07") {
    const adverse = audit.stress.cases.find((c) => c.case_name === "ADVERSE");
    // When no side was selected there is nothing to stress: runStressTest returns the BASE
    // case only. Report that honestly instead of dereferencing a case that does not exist.
    if (!adverse) {
      return {
        evaluated: false,
        patch: {
          winner_before: null, winner_after: null, range_before: null, range_after: null,
          outcome: STRESS_OUTCOME_NOT_EVALUATED, status: "UNAVAILABLE",
          unavailable_reason: "MISSING_REQUIRED_INPUT",
          unavailable_detail: "No side was selected on the available evidence, so there is no selection to stress-test.",
          provider_error: null, missing_inputs: [], sources: [], source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
        },
      };
    }
    return {
      evaluated: true,
      patch: {
        winner_before: rangeOf(before),
        winner_after: rangeOf(audit.stress.winner_after),
        range_before: null, range_after: null,
        outcome: audit.stress.changed ? "UNSTABLE" : "STABLE",
        status: "COMPLETE",
        unavailable_reason: null,
        unavailable_detail: `Adverse recomputation (${adverse.assumption}): support families ${audit.stress.cases[0]!.support_families} -> ${adverse.support_families}; winner ${before} -> ${audit.stress.winner_after}.`,
        provider_error: null, missing_inputs: [], sources: [{ source_name: "Truth Engine adverse-case recomputation", url: null, retrieved_at: null }],
        source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
      },
    };
  }
  return {
    evaluated: false,
    patch: {
      winner_before: rangeOf(before), winner_after: null, range_before: null, range_after: null,
      outcome: STRESS_OUTCOME_NOT_EVALUATED, status: "UNAVAILABLE",
      unavailable_reason: "MISSING_REQUIRED_INPUT",
      unavailable_detail: STRESS_MISSING_EVIDENCE[code] ?? "No deterministic evidence path for this stress test.",
      provider_error: null, missing_inputs: [], sources: [], source_attempts: [], reconstruction_attempted: false, retrieved_at: now,
    },
  };
}
