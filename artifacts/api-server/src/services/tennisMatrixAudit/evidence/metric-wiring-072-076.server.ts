import type { MetricFinding, Researcher } from "./audit-pipeline";
import { protectedMetricWiringResearcher } from "./protected-metric-wiring.server";

type Side = "P1" | "P2";
const TARGET = new Set(["072", "073", "074", "075", "076"]);
const PUBLIC_CONTEXT = new Set(["072", "073", "075", "076"]);

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
function norm(value: unknown) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function tag(value: string | null, key: string) {
  if (!value) return null;
  return value.match(new RegExp(`${key}\\s*=\\s*([^;]+)`, "i"))?.[1]?.trim() ?? null;
}
function sourceMatches(value: string | null, sources: MetricFinding["sources"], publicOnly: boolean) {
  const wanted = norm(tag(value, "SOURCE"));
  if (!wanted) return false;
  return Boolean((sources ?? []).some((source) => {
    if (norm(source.source_name) !== wanted) return false;
    if (!publicOnly) return Boolean(String(source.source_name ?? "").trim());
    return /^https?:\/\//i.test(String(source.url ?? "")) && !/(matrix summary|prediction|assistant|ai generated|model inference)/i.test(String(source.source_name ?? ""));
  }));
}
function validateSide(
  code: string,
  side: Side,
  value: string | null,
  treatment: MetricFinding["p1_treatment"],
  sources: MetricFinding["sources"],
  expectedPlayer: string,
) {
  if (treatment === "EXCLUDED") return { value, treatment, missing: [] as string[] };
  if (!value || treatment === "UNAVAILABLE") return { value: null, treatment: "UNAVAILABLE" as const, missing: [] as string[] };
  const missing: string[] = [];
  if (tag(value, "PLAYER") !== expectedPlayer) missing.push(`${side} exact PLAYER=${expectedPlayer}`);
  if (!sourceMatches(value, sources, PUBLIC_CONTEXT.has(code))) missing.push(`${side} SOURCE matching persisted provenance`);
  if (!tag(value, "SAMPLE")) missing.push(`${side} SAMPLE/window metadata`);
  if (missing.length) return { value: null, treatment: "UNAVAILABLE" as const, missing };
  return { value, treatment, missing };
}
function referencedSources(values: Array<string | null>, sources: MetricFinding["sources"]) {
  const wanted = new Set(values.map((value) => norm(tag(value, "SOURCE"))).filter(Boolean));
  return (sources ?? []).filter((source) => wanted.has(norm(source.source_name)));
}

export function enforceMetricWiring072076(finding: MetricFinding, players: { p1: string; p2: string }): MetricFinding {
  const code = codeOf(finding.metric_code);
  if (!TARGET.has(code)) return finding;
  const p1 = validateSide(code, "P1", finding.p1_value, finding.p1_treatment, finding.sources, players.p1);
  const p2 = validateSide(code, "P2", finding.p2_value, finding.p2_treatment, finding.sources, players.p2);
  const missing = [...new Set([...(finding.missing_inputs ?? []), ...p1.missing, ...p2.missing])];
  const sources = referencedSources([p1.value, p2.value], finding.sources);
  return {
    ...finding,
    p1_value: p1.value,
    p2_value: p2.value,
    p1_treatment: p1.treatment,
    p2_treatment: p2.treatment,
    evidence_family: `EXACT_${code}`,
    sample: `P1:${tag(p1.value, "SAMPLE") ?? "UNAVAILABLE"} | P2:${tag(p2.value, "SAMPLE") ?? "UNAVAILABLE"}`,
    sources,
    unavailable_reason: missing.length
      ? `Metric ${code} side/provenance guard rejected evidence whose player/source/sample lineage could not be proved. Missing/invalid: ${missing.join(", ")}.`
      : finding.unavailable_reason,
    missing_inputs: missing.length ? missing : finding.missing_inputs,
  };
}

function instruction(code: string, p1: string, p2: string) {
  if (!TARGET.has(code)) return "";
  const sourceRule = PUBLIC_CONTEXT.has(code)
    ? " SOURCE must be a real public HTTP(S) source directly supporting that side's exact component."
    : " SOURCE must name the actual imported/local/charted source supporting that side's exact component.";
  return `\nSTRICT SIDE/PROVENANCE RULE FOR ${code}: every usable side value MUST include PLAYER=<exact player>; SOURCE=<one actual source_name also present in sources>; SAMPLE=<actual denominator/window, or UNAVAILABLE if the source has no denominator>. P1 must use PLAYER=${p1}; P2 must use PLAYER=${p2}.${sourceRule} Never rely on row order or a source that belongs only to the opponent. Preserve DIRECT/PARTIAL/UNAVAILABLE/EXCLUDED conservatively; the existing exact-field firewall remains authoritative and may only downgrade evidence.`;
}

export const metricWiring072076Researcher: Researcher = {
  ...protectedMetricWiringResearcher,
  async metrics(input) {
    const decorated = input.metrics.map((metric) => ({
      ...metric,
      body: `${metric.body ?? ""}${instruction(codeOf(metric.code), input.p1, input.p2)}`,
    }));
    const rows = await protectedMetricWiringResearcher.metrics({ ...input, metrics: decorated });
    const byCode = new Map(rows.map((row) => [String(row.metric_code), row]));
    return input.metrics.map((metric) => enforceMetricWiring072076(byCode.get(String(metric.code)) ?? {
      metric_code: metric.code,
      p1_value: null,
      p2_value: null,
      p1_treatment: "UNAVAILABLE",
      p2_treatment: "UNAVAILABLE",
      differential: null,
      evidence_family: null,
      reliability: null,
      sample: null,
      unavailable_reason: "No sourced result survived the 072-076 side/provenance guard.",
      missing_inputs: ["side-specific sourced metric evidence"],
      sources: [],
    }, { p1: input.p1, p2: input.p2 }));
  },
};
