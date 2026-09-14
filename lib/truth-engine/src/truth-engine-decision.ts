// TRUTH ENGINE — DETERMINISTIC FINAL SELECTION
//
// Turns per-metric P1/P2 comparisons (truth-engine-metric-comparison.ts) into a
// defensible selection, or an explicit refusal. Pure: no DB, no network, no AI.
//
// This is deliberately NOT "the player with the most metrics wins":
//
//  * ANTI-DOUBLE-COUNTING. Correlated metrics are grouped into evidence FAMILIES and a
//    family votes exactly ONCE. Five agreeing metrics drawn from the same shared-opponent
//    pool are one piece of independent evidence, not five. A family whose own members
//    disagree is INTERNALLY_CONFLICTED and votes for nobody.
//
//  * INDEPENDENT SUPPORT AND INDEPENDENT CONTRADICTION are counted separately, so "one
//    dissent" cannot silently cancel a broad, genuinely independent consensus, and a
//    narrow consensus cannot bury a strong contradiction.
//
//  * LEAVE-ONE-FAMILY-OUT (LOFO) STABILITY is a real recomputation: the selection is
//    re-derived with each family removed in turn. If removing any single family flips the
//    leader, the result is FRAGILE and cannot be reported as a strong selection. This is
//    the stress test actually recalculating a decision input, not relabelling one.
//
//  * REFUSAL IS A FIRST-CLASS OUTCOME. Insufficient independent families, a tie, or a
//    contradiction that outweighs support all yield INSUFFICIENT_EVIDENCE with the reason
//    stated. Certainty is never forced.
//
// UNAVAILABLE comparisons are simply absent from every count. They are never zero, never
// neutral-in-favour-of-anyone, and never evidence for the side that does have data.

import type { ComparisonFavours, MetricComparison } from "./truth-engine-metric-comparison";
import { isActiveMetricCode } from "./truth-engine-active-metrics";

export type FamilyVote = "P1" | "P2" | "NEUTRAL" | "INTERNALLY_CONFLICTED";
export type SelectionOutcome = "P1" | "P2" | "INSUFFICIENT_EVIDENCE";
export type SelectionStability = "ROBUST" | "STABLE" | "FRAGILE" | "NOT_APPLICABLE";

/** A family must contain at least this many usable comparisons to vote at all. */
export const MIN_COMPARISONS_PER_FAMILY = 1;
/**
 * Corroboration reference level, NOT a gate.
 *
 * This was previously a hard refusal: a leader supported by fewer than two independent
 * families could never be selected. The product rule is now a threshold on the evidence
 * share (EVIDENCE_SELECTION_THRESHOLD below), so a single-family lead is selectable when
 * the directional evidence clears it. The constant is retained because "how many
 * independent families corroborate this" is still worth reporting, and it now annotates
 * the decision (`corroborated`) instead of blocking it.
 */
export const MIN_INDEPENDENT_SUPPORT_FAMILIES = 2;

/**
 * The product's minimum selection threshold: 60% of the DIRECTIONAL evidence must favour
 * one player before that player is selected.
 *
 * "Directional" means families that actually expressed an opinion — those voting for a
 * player, plus INTERNALLY_CONFLICTED families (which contain genuine opposing evidence and
 * therefore count against the leader's share). NEUTRAL families are excluded from the
 * ratio: a family that measured both players and found no material difference is evidence
 * of parity, not evidence for or against either side, so it can neither raise nor lower
 * one player's share of the directional evidence. They are still reported.
 *
 * UNAVAILABLE never enters this calculation at any point. A metric with no usable evidence
 * forms no comparison, joins no family, and is absent from both numerator and denominator —
 * it is never treated as evidence against the player who lacks it.
 */
export const EVIDENCE_SELECTION_THRESHOLD = 60;

export interface FamilyEvidence {
  family: string;
  vote: FamilyVote;
  supporting_metrics: string[];
  opposing_metrics: string[];
  neutral_metrics: string[];
  /** Every compared metric in this family, for the evidence chain. */
  comparisons: MetricComparison[];
}

export interface TruthEngineDecision {
  outcome: SelectionOutcome;
  /** Resolved player name for the selected side, when a side was selected. */
  selected_player: string | null;
  stability: SelectionStability;
  /**
   * Share of the DIRECTIONAL evidence favouring the leader, 0-100. Denominator is
   * supporting + contradicting + internally-conflicted families; NEUTRAL families and
   * UNAVAILABLE metrics are excluded. This is the quantity the 60% product threshold is
   * applied to, and it is reported for refusals too so a near-miss is visible.
   */
  evidence_percent: number;
  /** Families that expressed a direction -- the denominator of evidence_percent. */
  directional_families: number;
  /** True when at least MIN_INDEPENDENT_SUPPORT_FAMILIES independent families agree. */
  corroborated: boolean;
  /** Families voting for the winning side (each counted once). */
  independent_support_families: string[];
  /** Families voting for the losing side -- genuine independent contradictions. */
  independent_contradiction_families: string[];
  neutral_families: string[];
  conflicted_families: string[];
  /**
   * Families whose removal REVERSES the leader (the other player then leads). A true
   * reversal means the call is contradicted, not merely thin -> the selection is refused.
   */
  flipping_families: string[];
  /**
   * Families whose removal leaves no leader at all (a tie) without reversing it. This is
   * thin evidence, not contradicted evidence, and is reported rather than treated as a
   * reversal -- conflating the two would make any 2-1 family lead permanently unselectable.
   */
  tie_inducing_families: string[];
  /** Metrics that could not be compared at all, with the reason each was excluded. */
  unavailable: Array<{ metric_code: string; status: string; reason: string }>;
  /** Duplicated (same-family) support that was deliberately NOT counted again. */
  duplicated_support_metrics: string[];
  duplicated_contradiction_metrics: string[];
  families: FamilyEvidence[];
  reason: string;
  evidence_chain: string[];
}

function voteFor(comparisons: MetricComparison[]): { vote: FamilyVote; supporting: string[]; opposing: string[]; neutral: string[] } {
  const p1 = comparisons.filter((c) => c.favours === "P1").map((c) => c.metric_code);
  const p2 = comparisons.filter((c) => c.favours === "P2").map((c) => c.metric_code);
  const neutral = comparisons.filter((c) => c.favours === "NEUTRAL").map((c) => c.metric_code);
  if (p1.length && p2.length) return { vote: "INTERNALLY_CONFLICTED", supporting: p1, opposing: p2, neutral };
  if (p1.length) return { vote: "P1", supporting: p1, opposing: [], neutral };
  if (p2.length) return { vote: "P2", supporting: p2, opposing: [], neutral };
  return { vote: "NEUTRAL", supporting: [], opposing: [], neutral };
}

function buildFamilies(comparisons: MetricComparison[]): FamilyEvidence[] {
  const byFamily = new Map<string, MetricComparison[]>();
  for (const c of comparisons) {
    if (c.status !== "COMPARED" || !c.family) continue;
    byFamily.set(c.family, [...(byFamily.get(c.family) ?? []), c]);
  }
  return [...byFamily.entries()]
    .filter(([, rows]) => rows.length >= MIN_COMPARISONS_PER_FAMILY)
    .map(([family, rows]) => {
      const { vote, supporting, opposing, neutral } = voteFor(rows);
      return { family, vote, supporting_metrics: supporting, opposing_metrics: opposing, neutral_metrics: neutral, comparisons: rows };
    })
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** Leader from family votes alone. Each family counts once, regardless of how many metrics it holds. */
function leaderOf(families: FamilyEvidence[]): { leader: "P1" | "P2" | null; p1: number; p2: number } {
  const p1 = families.filter((f) => f.vote === "P1").length;
  const p2 = families.filter((f) => f.vote === "P2").length;
  if (p1 === p2) return { leader: null, p1, p2 };
  return { leader: p1 > p2 ? "P1" : "P2", p1, p2 };
}

export interface DecisionInput {
  comparisons: MetricComparison[];
  p1Name: string;
  p2Name: string;
}

export function decideTruthEngineSelection({ comparisons, p1Name, p2Name }: DecisionInput): TruthEngineDecision {
  // Defense in depth: in the real pipeline every MetricComparison[] passed here already
  // came from compareMetricRows, which can structurally never mark an inactive (no-spec)
  // code "COMPARED" (see truth-engine-metric-comparison.ts). This second, independent
  // filter on the FAMILIES input means that guarantee doesn't rest on every future caller
  // routing through compareMetricRows correctly -- an inactive code can never become voting
  // evidence here even if handed a forged/malformed comparison that claims to be
  // "COMPARED". `unavailable` deliberately still lists every excluded code, active or not
  // (with its real reason, NO_COMPARISON_SPEC for an inactive one) -- that diagnostic
  // transparency is what proves an inactive code was seen and correctly excluded, not
  // silently dropped.
  const families = buildFamilies(comparisons.filter((c) => isActiveMetricCode(c.metric_code)));
  const unavailable = comparisons
    .filter((c) => c.status !== "COMPARED")
    .map((c) => ({ metric_code: c.metric_code, status: c.status, reason: c.reason }));

  // Same-family agreement beyond the first metric is duplicated, not independent.
  const duplicatedSupport: string[] = [];
  const duplicatedContradiction: string[] = [];

  const base = leaderOf(families);
  const neutralFamilies = families.filter((f) => f.vote === "NEUTRAL").map((f) => f.family);
  const conflictedFamilies = families.filter((f) => f.vote === "INTERNALLY_CONFLICTED").map((f) => f.family);

  // Share of the directional evidence held by `support`. Conflicted families sit in the
  // denominator because they contain real opposing evidence; NEUTRAL families sit outside
  // it entirely because they favour nobody. With no directional family at all the share is
  // 0, never an undefined division dressed up as a number.
  const evidenceShare = (support: string[], contra: string[]) => {
    const directional = support.length + contra.length + conflictedFamilies.length;
    return {
      directional,
      percent: directional > 0 ? Number(((support.length / directional) * 100).toFixed(1)) : 0,
    };
  };

  const shell = (outcome: SelectionOutcome, reason: string, stability: SelectionStability, support: string[] = [], contra: string[] = [], flipping: string[] = [], tieInducing: string[] = []): TruthEngineDecision => ({
    outcome,
    selected_player: outcome === "P1" ? p1Name : outcome === "P2" ? p2Name : null,
    stability,
    evidence_percent: evidenceShare(support, contra).percent,
    directional_families: evidenceShare(support, contra).directional,
    corroborated: support.length >= MIN_INDEPENDENT_SUPPORT_FAMILIES,
    independent_support_families: support,
    independent_contradiction_families: contra,
    neutral_families: neutralFamilies,
    conflicted_families: conflictedFamilies,
    flipping_families: flipping,
    tie_inducing_families: tieInducing,
    unavailable,
    duplicated_support_metrics: duplicatedSupport,
    duplicated_contradiction_metrics: duplicatedContradiction,
    families,
    reason,
    evidence_chain: families.map((f) => `${f.family}: ${f.vote}${f.supporting_metrics.length ? ` (from ${f.supporting_metrics.join(", ")})` : ""}${f.opposing_metrics.length ? ` vs ${f.opposing_metrics.join(", ")}` : ""}`),
  });

  if (!families.length) {
    return shell("INSUFFICIENT_EVIDENCE", `No metric produced a usable two-sided comparison (${unavailable.length} metric(s) unavailable). The Truth Engine cannot select a side and does not guess.`, "NOT_APPLICABLE");
  }
  if (!base.leader) {
    // A tie is genuinely 50/50 of the directional evidence, so report it as such rather
    // than as 0% -- passing the two sides' families through gives the share its real value
    // and makes a tied refusal legible next to a below-threshold one.
    const p1Families = families.filter((f) => f.vote === "P1").map((f) => f.family);
    const p2Families = families.filter((f) => f.vote === "P2").map((f) => f.family);
    return shell(
      "INSUFFICIENT_EVIDENCE",
      `Independent evidence families are tied (${base.p1} for ${p1Name} vs ${base.p2} for ${p2Name}). Neither side reaches the ${EVIDENCE_SELECTION_THRESHOLD}% selection threshold. No side is selected.`,
      "NOT_APPLICABLE",
      p1Families,
      p2Families,
    );
  }

  const leader = base.leader;
  const support = families.filter((f) => f.vote === leader);
  const contra = families.filter((f) => f.vote !== leader && f.vote !== "NEUTRAL" && f.vote !== "INTERNALLY_CONFLICTED");
  const supportNames = support.map((f) => f.family);
  const contraNames = contra.map((f) => f.family);

  for (const f of support) duplicatedSupport.push(...f.supporting_metrics.slice(1));
  for (const f of contra) duplicatedContradiction.push(...f.supporting_metrics.slice(1));

  // THE PRODUCT THRESHOLD. A leader is selected when it holds at least
  // EVIDENCE_SELECTION_THRESHOLD of the directional evidence. This replaces the previous
  // hard "at least two independent families" refusal, which blocked selections the product
  // wants made; corroboration is now reported (`corroborated`) rather than enforced.
  //
  // Every other protection is deliberately untouched and still runs AFTER this point:
  // metrics only reach a family after clearing their own sample and materiality floors in
  // COMPARISON_SPECS, correlated metrics are still collapsed to one vote per family, a
  // family whose own members disagree still poisons itself to INTERNALLY_CONFLICTED and
  // drags this percentage down, and leave-one-family-out below can still refuse a lead
  // that a single family reverses.
  const { percent: evidencePercent, directional } = evidenceShare(supportNames, contraNames);
  if (evidencePercent < EVIDENCE_SELECTION_THRESHOLD) {
    return shell(
      "INSUFFICIENT_EVIDENCE",
      `${leader === "P1" ? p1Name : p2Name} holds ${evidencePercent}% of the directional evidence (${supportNames.length} supporting famil${supportNames.length === 1 ? "y" : "ies"} of ${directional} directional: ${supportNames.join(", ") || "none"}${contraNames.length ? ` against ${contraNames.join(", ")}` : ""}${conflictedFamilies.length ? `, with ${conflictedFamilies.join(", ")} internally conflicted` : ""}), below the ${EVIDENCE_SELECTION_THRESHOLD}% selection threshold. No side is selected.`,
      "NOT_APPLICABLE",
      supportNames,
      contraNames,
    );
  }

  // LEAVE-ONE-FAMILY-OUT: genuinely re-derive the leader with each family removed, and
  // distinguish a REVERSAL (the other player leads -> the call is contradicted) from a
  // TIE (no leader -> the call is merely thin). Treating both as "flip" would make any
  // 2-1 family lead permanently unselectable, which would misreport thin evidence as
  // contradicted evidence.
  const flipping: string[] = [];
  const tieInducing: string[] = [];
  for (const f of families) {
    const { leader: without } = leaderOf(families.filter((other) => other.family !== f.family));
    if (without && without !== leader) flipping.push(f.family);
    else if (!without) tieInducing.push(f.family);
  }

  const selectedName = leader === "P1" ? p1Name : p2Name;

  if (flipping.length) {
    return shell(
      "INSUFFICIENT_EVIDENCE",
      `${selectedName} leads ${supportNames.length}-${contraNames.length} on independent families, but the lead does not survive leave-one-family-out: removing ${flipping.join(" or ")} REVERSES the leader. A selection that a single family can invert is reported as insufficient rather than asserted.`,
      "FRAGILE",
      supportNames,
      contraNames,
      flipping,
      tieInducing,
    );
  }

  // No single removal can hand the match to the other player. ROBUST additionally
  // requires no independent contradiction and no removal that even ties it.
  const stability: SelectionStability = contraNames.length === 0 && tieInducing.length === 0 ? "ROBUST" : "STABLE";

  return shell(
    leader,
    `${selectedName} holds ${evidencePercent}% of the directional evidence, at or above the ${EVIDENCE_SELECTION_THRESHOLD}% selection threshold: supported by ${supportNames.length} independent evidence famil${supportNames.length === 1 ? "y" : "ies"} (${supportNames.join(", ")})${contraNames.length ? ` against ${contraNames.length} independent contradiction${contraNames.length === 1 ? "" : "s"} (${contraNames.join(", ")})` : " with no independent contradiction"}${conflictedFamilies.length ? `, with ${conflictedFamilies.join(", ")} internally conflicted` : ""}; no single family's removal reverses the leader${tieInducing.length ? `, though removing ${tieInducing.join(" or ")} would leave it tied` : ""}.${supportNames.length < MIN_INDEPENDENT_SUPPORT_FAMILIES ? ` NOTE: this selection rests on a single evidence family, so it is uncorroborated by an independent second family.` : ""}${duplicatedSupport.length ? ` ${duplicatedSupport.length} same-family agreeing metric(s) were deliberately not counted again.` : ""}`,
    stability,
    supportNames,
    contraNames,
    flipping,
    tieInducing,
  );
}
