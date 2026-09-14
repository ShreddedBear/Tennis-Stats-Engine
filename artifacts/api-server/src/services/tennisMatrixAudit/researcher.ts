// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — the evidence-acquisition seam.
//
// `Researcher` is the second half of the engine's dependency injection: PipelineDeps
// supplies persistence, this supplies evidence. The frozen engine calls it for match
// identity, match context, and per-metric P1/P2 values, and then does all of its own
// deterministic work (comparison, family consolidation, verification, disagreement,
// underdog, stress, decision) on whatever comes back. Nothing here decides anything.
//
// STATUS OF THE MOVE. The Audit's evidence layer is a chain of producers --
// warehouse-first, then a completion sweep, then the hybrid local/AI researcher --
// sitting on ~66 modules and several external provider integrations. Those are being
// carried over as their own tranche. What is wired today is the WAREHOUSE tier: the
// producers that read evidence already persisted in this database
// (metric_evidence_store, source_observations), which is the tier the deterministic
// metrics are computed from and the one that needs no provider credentials.
//
// Everything not yet wired reports an explicit, machine-readable unavailability rather
// than a silent blank. That distinction is load-bearing in this engine: metric-
// activation-status.ts reads the reason to decide whether a metric is legitimately
// absent for a match (and may leave the per-match denominator) or is a pipeline gap
// that must stay counted as a miss. NOT_YET_PORTED is deliberately shaped as the
// latter -- it is a real miss, and the coverage numbers will say so, rather than
// quietly flattering themselves while the provider tranche is outstanding.
// ----------------------------------------------------------------------------
import type {
  ConclusionFinding, EvidenceDigest, IdentityFinding, MetricFinding, Researcher,
  RuleFinding, StressFinding, UnderdogFinding,
} from "@workspace/truth-engine";
import { pool } from "@workspace/db";

/**
 * Evidence already persisted in this database for one player, keyed by metric code.
 * This is the warehouse tier: values a producer wrote earlier, read back by
 * (metric, player, as-of date) exactly as the Audit's warehouse-first researcher did.
 */
async function warehouseEvidence(
  player: string,
  asOfDate: string | null,
  codes: string[],
): Promise<Map<string, { value: string; treatment: string; reliability: number | null; sample: string | null; family: string | null; sources: unknown }>> {
  const found = new Map<string, { value: string; treatment: string; reliability: number | null; sample: string | null; family: string | null; sources: unknown }>();
  if (!codes.length || !player.trim()) return found;
  const { rows } = await pool.query(
    `select distinct on (metric_code)
            metric_code, value_text, treatment, reliability, sample_label, evidence_family, sources
       from metric_evidence_store
      where lower(player_name) = lower($1)
        and metric_code = any($2::text[])
        and ($3::date is null or as_of_date <= $3::date)
        and coalesce(value_text, '') <> ''
      order by metric_code, as_of_date desc`,
    [player, codes, asOfDate],
  );
  for (const row of rows as Array<Record<string, unknown>>) {
    found.set(String(row["metric_code"]), {
      value: String(row["value_text"]),
      treatment: String(row["treatment"] ?? "DIRECT"),
      reliability: row["reliability"] === null || row["reliability"] === undefined ? null : Number(row["reliability"]),
      sample: (row["sample_label"] as string | null) ?? null,
      family: (row["evidence_family"] as string | null) ?? null,
      sources: row["sources"] ?? [],
    });
  }
  return found;
}

/** The reason a metric carries when its producer has not been carried over yet. */
const NOT_YET_PORTED =
  "No evidence producer for this metric is wired in this deployment yet (the Audit's provider tier is still being carried over). This is a pipeline gap, not a finding that no data exists.";

export const auditResearcher: Researcher = {
  // Identity and context are resolved from what ingestion already parsed off the
  // uploaded summary. The engine treats an unverified identity as a real state and
  // records it, so reporting UNVERIFIED here is a legitimate outcome rather than a
  // failure -- what it must never do is claim VERIFIED without a source.
  async identity({ p1, p2, hints }) {
    const finding: IdentityFinding = {
      player1_canonical: p1,
      player2_canonical: p2,
      player1_status: "UNVERIFIED",
      player2_status: "UNVERIFIED",
      tournament: hints["tournament"] ?? null,
      event_level: hints["event_level"] ?? null,
      round: hints["round"] ?? null,
      scheduled_date: hints["scheduled_date"] ?? null,
      surface: hints["surface"] ?? null,
      indoor: null,
      best_of: null,
      surface_status: hints["surface"] ? "UNVERIFIED" : "UNVERIFIED",
      unresolved_reason:
        "Identity verification against an external tennis source is part of the provider tier, which is not wired in this deployment yet. Names and context are retained exactly as ingestion parsed them.",
      sources: [],
      conflicts: [],
    };
    return finding;
  },

  async metrics({ metrics, researchPlayer, auditDate }) {
    const codes = metrics.map((m) => String(m.code));
    const player = String(researchPlayer ?? "");
    const evidence = await warehouseEvidence(player, auditDate ?? null, codes);

    return metrics.map((metric): MetricFinding => {
      const hit = evidence.get(String(metric.code));
      if (!hit) {
        return {
          metric_code: metric.code,
          p1_value: null, p2_value: null,
          p1_treatment: "UNAVAILABLE", p2_treatment: "UNAVAILABLE",
          differential: null, evidence_family: null, reliability: null, sample: null,
          unavailable_reason: NOT_YET_PORTED,
          missing_inputs: ["evidence producer"],
          sources: [],
        };
      }
      // The pipeline calls this once per side with researchSide/researchPlayer set, and
      // its orientation step keeps only the executing side's fields -- so writing the
      // value into both here is correct and is what the Audit already did.
      const treatment = (["DIRECT", "RECONSTRUCTED", "PARTIAL"].includes(hit.treatment)
        ? hit.treatment
        : "DIRECT") as MetricFinding["p1_treatment"];
      return {
        metric_code: metric.code,
        p1_value: hit.value, p2_value: hit.value,
        p1_treatment: treatment, p2_treatment: treatment,
        differential: null,
        evidence_family: hit.family,
        reliability: hit.reliability,
        sample: hit.sample,
        unavailable_reason: null,
        sources: Array.isArray(hit.sources) ? (hit.sources as MetricFinding["sources"]) : [],
      };
    });
  },

  // The four audit layers below are computed DETERMINISTICALLY by the engine itself
  // (truth-engine-audit.ts + truth-engine-stage-mapping.ts) from the persisted metric
  // evidence; the pipeline only consults a provider for supplementary narrative and
  // can never let it supply, override or overturn a selected side. Returning nothing
  // here is therefore the correct, non-lossy behaviour, not a stub of a decision path.
  async rules({ rules }): Promise<RuleFinding[]> {
    return rules.map((rule) => ({
      rule_code: rule.code,
      p1_finding: null, p2_finding: null,
      outcome: "UNAVAILABLE",
      severity: null, decision_effect: null, contradiction_severity: null,
      supporting_evidence: null, opposing_evidence: null, final_effect: null,
      unavailable_reason: "Evaluated deterministically from persisted metric evidence; no provider narrative in this deployment.",
      sources: [],
    }));
  },

  async underdog({ pathways, player_side }): Promise<UnderdogFinding[]> {
    return pathways.map((pathway) => ({
      pathway_code: pathway.code,
      player_side,
      classification: "UNRESOLVED",
      evidence: null,
      repeatable: false,
      unavailable_reason: "Classified deterministically from measured evidence-family edges; no provider narrative in this deployment.",
    }));
  },

  async stress({ tests }): Promise<StressFinding[]> {
    return tests.map((test) => ({
      test_code: test.code,
      winner_after: null, range_after: null,
      outcome: "STABLE",
      note: null,
      unavailable_reason: "Recomputed deterministically by the stress engine; no provider narrative in this deployment.",
    }));
  },

  async conclusion(): Promise<ConclusionFinding> {
    // The deterministic conclusion is authoritative for the winner. The provider path
    // exists only to add rationale prose and, by contract, can never name a side.
    return {
      winner: null, low: null, high: null, rationale: null,
      insufficient_reason: "The independent conclusion is derived deterministically from the persisted metric evidence.",
    };
  },
};

export type { EvidenceDigest };
