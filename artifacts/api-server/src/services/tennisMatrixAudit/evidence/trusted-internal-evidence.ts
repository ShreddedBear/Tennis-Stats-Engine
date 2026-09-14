// ============================================================================
// TRUSTED INTERNAL EVIDENCE ADAPTER
//
// Sits between legitimate local / imported / deterministically reconstructed
// MetricFinding production and the strict certification guards.
//
// It NEVER weakens a validator. It only lets evidence that ALREADY carries
// structured, side-specific provenance express that provenance in the tagged
// form the certified guards require:
//
//   PLAYER=<exact side player>; SOURCE=<actual source_name>; SAMPLE=<actual
//   side denominator>[; INPUTS=<a>|<b>; FORMULA=<explicit calculation>]; <value>
//
// Hard invariants:
//  * PLAYER comes from the producing call site, which knows the side. It is
//    never inferred from row order after the fact.
//  * SOURCE must already exist in that side's own persisted source list (and,
//    when supplied, in the finding's persisted sources). Sources are never
//    invented and the opposite side's sources cannot support a side.
//  * SAMPLE must be that side's own sample. The opposite side's sample or a
//    generic row sample is never reused; a missing side sample is a rejection.
//    Exact zero-event observations over an explicitly named fixed time window
//    are preserved as window evidence rather than misread as missing data.
//  * FORMULA/INPUTS are emitted only for reconstructions produced by an
//    approved deterministic spec or an explicitly documented local formula.
//    Without that provenance the value is downgraded, never fabricated.
//  * Treatments are only ever preserved or downgraded. Metadata never turns
//    UNAVAILABLE into DIRECT/RECONSTRUCTED.
// ============================================================================

import type { MetricFinding, SourceRef, Treatment } from "./audit-pipeline";
import { RECONSTRUCTION_SPECS } from "./reconstruction/specs";

const APPROVED_SPEC_IDS = new Set(RECONSTRUCTION_SPECS.map((s) => s.id));
const FIXED_WINDOW_ZERO_EVENT_KEYS = [
  "matches_last_7_days",
  "matches_last_14_days",
  "matches_last_28_days",
  "sets_last_14_days",
  "three_setters_last_14_days",
  "qualifying_matches_last_14_days",
] as const;

export interface TrustedFormulaProvenance {
  /** Approved deterministic reconstruction spec id, when the value came from one. */
  spec_id?: string | null;
  /** Explicit documented calculation. */
  formula: string;
  /** Exact raw inputs used by that calculation. */
  inputs: string[];
}

export interface TrustedSideEvidence {
  /** The player this value was produced FOR, supplied by the producer. */
  player: string;
  /** Plain structured value, e.g. "set1_win_pct=54.10; set2_win_pct=51.00". */
  value: string | null;
  /** Treatment claimed by the producer. Never upgraded here. */
  treatment: Treatment;
  /** This side's own denominator / window. */
  sample: string | number | null;
  /** Sources that support THIS side. */
  sources: SourceRef[];
  formula?: TrustedFormulaProvenance | null;
}

export interface NormalizedSide {
  value: string | null;
  treatment: Treatment;
  sample: string | null;
  sources: SourceRef[];
  missing: string[];
}

const normName = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function samePlayer(a: string, b: string) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(" ").filter(Boolean).sort().join(" ");
  const ys = y.split(" ").filter(Boolean).sort().join(" ");
  return xs === ys;
}

function pickSource(evidence: TrustedSideEvidence, persisted?: SourceRef[]): SourceRef | null {
  const persistedNames = persisted ? new Set(persisted.map((s) => normName(s.source_name))) : null;
  for (const source of evidence.sources ?? []) {
    const name = String(source?.source_name ?? "").trim();
    if (!name) continue;
    if (persistedNames && !persistedNames.has(normName(name))) continue;
    return source;
  }
  return null;
}

function isFixedWindowZeroEventObservation(value: string | null): boolean {
  if (!value) return false;
  return FIXED_WINDOW_ZERO_EVENT_KEYS.some((key) =>
    new RegExp(`(?:^|;\\s*)${key}\\s*=\\s*0(?:\\.0+)?(?=\\s*;|$)`, "i").test(value),
  );
}

/**
 * Normalize one side of already-produced internal evidence into the tagged
 * form the certified guards require. Returns an UNAVAILABLE side (with the
 * precise missing input) whenever the provenance cannot be proved.
 */
export function normalizeTrustedSide(
  side: "P1" | "P2",
  expectedPlayer: string,
  evidence: TrustedSideEvidence | null | undefined,
  persistedSources?: SourceRef[],
): NormalizedSide {
  const reject = (missing: string[]): NormalizedSide => ({
    value: null,
    treatment: "UNAVAILABLE",
    sample: null,
    sources: [],
    missing,
  });

  if (!evidence || !evidence.value || !String(evidence.value).trim()) return reject([]);
  if (evidence.treatment === "UNAVAILABLE" || evidence.treatment === "EXCLUDED") {
    return { value: null, treatment: evidence.treatment, sample: null, sources: [], missing: [] };
  }
  if (!samePlayer(evidence.player, expectedPlayer)) {
    return reject([`${side} exact PLAYER=${expectedPlayer}`]);
  }

  const source = pickSource(evidence, persistedSources);
  if (!source) return reject([`${side} SOURCE matching persisted provenance`]);

  const rawSample = evidence.sample === null || evidence.sample === undefined || String(evidence.sample).trim() === ""
    ? null
    : String(evidence.sample).trim();
  if (!rawSample) return reject([`${side} actual side-specific SAMPLE denominator`]);

  // A numeric zero usually means there was no denominator and must remain a
  // rejection. The narrow exception is an exact count over a fixed named
  // pre-match window: e.g. matches_last_7_days=0 is a real observation that
  // the player played zero matches in that window, not an absence of data.
  // Preserve that truth as window metadata instead of inventing a denominator.
  const sample = rawSample === "0"
    ? (isFixedWindowZeroEventObservation(evidence.value) ? "FIXED_WINDOW_ZERO_EVENT" : null)
    : rawSample;
  if (!sample) return reject([`${side} actual side-specific SAMPLE denominator`]);

  let treatment = evidence.treatment;
  const missing: string[] = [];
  let formulaTag = "";
  if (treatment === "RECONSTRUCTED") {
    const provenance = evidence.formula;
    const approved =
      !!provenance &&
      !!String(provenance.formula ?? "").trim() &&
      Array.isArray(provenance.inputs) &&
      provenance.inputs.length > 0 &&
      (!provenance.spec_id || APPROVED_SPEC_IDS.has(provenance.spec_id));
    if (!approved) {
      // No approved formula provenance: downgrade, never fabricate one.
      treatment = "PARTIAL";
      missing.push(`${side} approved deterministic reconstruction formula provenance`);
    } else {
      formulaTag = `; INPUTS=${provenance!.inputs.join("|")}; FORMULA=${provenance!.formula}`;
    }
  }

  const value = `PLAYER=${expectedPlayer}; SOURCE=${String(source.source_name).trim()}; SAMPLE=${sample}${formulaTag}; ${String(evidence.value).trim()}`;
  // Every source retained here belongs to THIS side (and, when a persisted list
  // was supplied, is already present in it). The tagged SOURCE is listed first.
  const persistedNames = persistedSources ? new Set(persistedSources.map((s) => normName(s.source_name))) : null;
  const sideSources = (evidence.sources ?? []).filter(
    (s) => String(s?.source_name ?? "").trim() && (!persistedNames || persistedNames.has(normName(s.source_name))),
  );
  const ordered = [source, ...sideSources.filter((s) => s !== source)];
  return { value, treatment, sample, sources: ordered, missing };
}

export interface TrustedFindingInput {
  metric_code: string;
  p1: TrustedSideEvidence | null;
  p2: TrustedSideEvidence | null;
  players: { p1: string; p2: string };
  evidence_family: string | null;
  reliability: number | null;
  unavailable_reason: string | null;
  missing_inputs?: string[];
  differential?: string | null;
  /** Extra persisted sources the sides must be drawn from, when applicable. */
  persistedSources?: SourceRef[];
}

/**
 * Build a MetricFinding from side-scoped trusted internal evidence. Only the
 * sources actually referenced by a surviving side are persisted, so an
 * unrelated row source can never support a side.
 */
export function buildTrustedInternalFinding(input: TrustedFindingInput): MetricFinding {
  const p1 = normalizeTrustedSide("P1", input.players.p1, input.p1, input.persistedSources);
  const p2 = normalizeTrustedSide("P2", input.players.p2, input.p2, input.persistedSources);
  const anyUsable = p1.value !== null || p2.value !== null;
  const sources = [...p1.sources, ...p2.sources].filter(
    (s, i, a) => a.findIndex((z) => normName(z.source_name) === normName(s.source_name) && (z.url ?? null) === (s.url ?? null)) === i,
  );
  const missing = [...new Set([...(input.missing_inputs ?? []), ...p1.missing, ...p2.missing])];
  return {
    metric_code: input.metric_code,
    p1_value: p1.value,
    p2_value: p2.value,
    p1_treatment: p1.treatment,
    p2_treatment: p2.treatment,
    differential: input.differential ?? null,
    evidence_family: anyUsable ? input.evidence_family : null,
    reliability: anyUsable ? input.reliability : null,
    sample: anyUsable ? `P1:${p1.sample ?? "UNAVAILABLE"} | P2:${p2.sample ?? "UNAVAILABLE"}` : null,
    unavailable_reason: anyUsable
      ? input.unavailable_reason
      : missing.length
        ? `Trusted internal evidence adapter could not prove side/provenance lineage: ${missing.join(", ")}.`
        : input.unavailable_reason,
    missing_inputs: missing.length ? missing : input.missing_inputs,
    sources,
  };
}

/**
 * Truthful residue: a finding where no side survived certification must not
 * keep a sample/reliability/source that implies evidence exists. This never
 * changes a treatment and never counts anything as evidence.
 */
export function clearPhantomEvidenceMetadata(finding: MetricFinding): MetricFinding {
  const usable = (value: string | null, treatment: Treatment) =>
    value !== null && treatment !== "UNAVAILABLE" && treatment !== "EXCLUDED";
  if (usable(finding.p1_value, finding.p1_treatment) || usable(finding.p2_value, finding.p2_treatment)) return finding;
  if (finding.sample === null && finding.reliability === null && (finding.sources ?? []).length === 0) return finding;
  return { ...finding, sample: null, reliability: null, sources: [] };
}
