import type { ConclusionFinding, Researcher, RuleFinding, StressFinding, UnderdogFinding } from "./audit-pipeline";
import { hybridResearcher } from "./hybrid-audit-research.server";

function providerFailure(error: unknown) {
  const m = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /402|credit|quota|429|rate limit|timeout|provider|api key|auth|fetch|not configured|all research providers failed/.test(m);
}

function usableMetrics(evidence: Parameters<Researcher["rules"]>[0]["evidence"]) {
  return evidence.metrics.filter((m) => m.p1 !== null || m.p2 !== null);
}

/**
 * A provider outage must never turn partial metric availability into PASS.
 * Rules that require semantic/falsification reasoning stay explicitly unavailable
 * unless the real rule researcher executes them. This preserves honest coverage.
 */
function localRules(input: Parameters<Researcher["rules"]>[0]): RuleFinding[] {
  const usable = usableMetrics(input.evidence);
  return input.rules.map((rule) => ({
    rule_code: rule.code,
    p1_finding: null,
    p2_finding: null,
    outcome: "UNAVAILABLE",
    severity: rule.severity === "CRITICAL" ? "CRITICAL" : "STANDARD",
    decision_effect: null,
    contradiction_severity: "NONE",
    supporting_evidence: usable.length ? `Independent evidence preserved (${usable.length} usable metric rows), but this rule was not semantically executed.` : null,
    opposing_evidence: null,
    final_effect: null,
    unavailable_reason: "RESEARCH_PROVIDER_UNAVAILABLE",
    missing_inputs: ["semantic rule execution"],
    sources: [],
  }));
}

/** No invented WEAK classification: an unexecuted pathway is unresolved. */
function localUnderdog(input: Parameters<Researcher["underdog"]>[0]): UnderdogFinding[] {
  const usable = input.evidence.metrics.filter((m) => m.p1 !== null || m.p2 !== null);
  return input.pathways.map((p) => ({
    pathway_code: p.code,
    player_side: input.player_side,
    classification: "UNRESOLVED",
    evidence: usable.length ? `${usable.length} independent metric rows were preserved, but pathway-specific reasoning was not executed.` : null,
    repeatable: false,
    unavailable_reason: "RESEARCH_PROVIDER_UNAVAILABLE",
    missing_inputs: ["pathway-specific semantic execution"],
    sources: [],
  }));
}

/** Stress tests cannot be called stable merely because an earlier winner exists. */
function localStress(input: Parameters<Researcher["stress"]>[0]): StressFinding[] {
  return input.tests.map((t) => ({
    test_code: t.code,
    winner_after: null,
    range_after: null,
    outcome: "UNAVAILABLE" as unknown as StressFinding["outcome"],
    note: "Stress test not executed because the semantic research provider was unavailable; no stability result was fabricated.",
    unavailable_reason: "RESEARCH_PROVIDER_UNAVAILABLE",
    missing_inputs: ["stress-test execution"],
    sources: [],
  }));
}

function localConclusion(input: Parameters<Researcher["conclusion"]>[0]): ConclusionFinding {
  const metrics = input.evidence.metrics.filter((m) => m.p1 !== null && m.p2 !== null);
  if (!metrics.length) return { winner: null, low: null, high: null, rationale: null, insufficient_reason: "No symmetric independent metric evidence was available." };
  return {
    winner: null,
    low: null,
    high: null,
    rationale: `${metrics.length} symmetric independent metric rows were preserved, but no deterministic conclusion scorer is available for provider-outage mode.`,
    insufficient_reason: "RESEARCH_PROVIDER_UNAVAILABLE",
  };
}

export const resilientResearcher: Researcher = {
  ...hybridResearcher,
  async rules(input) { try { return await hybridResearcher.rules(input); } catch (e) { if (!providerFailure(e)) throw e; return localRules(input); } },
  async underdog(input) { try { return await hybridResearcher.underdog(input); } catch (e) { if (!providerFailure(e)) throw e; return localUnderdog(input); } },
  async conclusion(input) { try { return await hybridResearcher.conclusion(input); } catch (e) { if (!providerFailure(e)) throw e; return localConclusion(input); } },
  async stress(input) { try { return await hybridResearcher.stress(input); } catch (e) { if (!providerFailure(e)) throw e; return localStress(input); } },
};
