import type { MetricFinding, Researcher } from "./audit-pipeline";
import { metricWiring072076Researcher } from "./metric-wiring-072-076.server";
import { clearPhantomEvidenceMetadata } from "./trusted-internal-evidence";

type Component = { name: string; terms: string[] };

const TARGET = new Set(["078", "079", "081"]);
const PUBLIC_CONTEXT = new Set(["078", "081"]);

const COMPONENTS: Record<string, Component[]> = {
  "078": [
    { name: "home-market commercial appearances", terms: ["home market commercial appearances", "home-market commercial appearances", "commercial appearance"] },
    { name: "sponsor/media obligation timing", terms: ["sponsor obligation", "media obligation", "tournament week", "recovery time", "preparation time"] },
  ],
  "079": [
    { name: "chair-side coaching usage rate", terms: ["chair side coaching usage rate", "chair-side coaching usage rate", "coaching visit"] },
    { name: "post-coaching-visit performance", terms: ["post coaching visit performance", "post-coaching-visit performance", "next game after coaching"] },
    { name: "shot-clock violation rate by set", terms: ["shot clock violation rate by set", "shot-clock violation rate by set"] },
    { name: "racket-change-mid-match frequency", terms: ["racket change mid match frequency", "racket-change-mid-match frequency"] },
    { name: "sleep-schedule disruption", terms: ["sleep schedule disruption", "sleep-schedule disruption", "late night", "early next day"] },
    { name: "hydration-break utilization", terms: ["hydration break utilization", "hydration-break utilization"] },
    { name: "medical-timeout-to-win correlation", terms: ["medical timeout to win correlation", "medical-timeout-to-win correlation"] },
    { name: "first-point-of-match win rate", terms: ["first point of match win rate", "first-point-of-match win rate"] },
    { name: "first-game win rate", terms: ["first game win rate", "first-game win rate"] },
    { name: "changeover recovery rate", terms: ["changeover recovery rate"] },
    { name: "odd-game vs even-game serve performance", terms: ["odd game vs even game serve performance", "odd-game vs even-game serve performance"] },
    { name: "return-game win rate by return position", terms: ["return game win rate by return position", "return-game win rate by return position"] },
    { name: "serve-pattern predictability score", terms: ["serve pattern predictability score", "serve-pattern predictability score"] },
    { name: "opponent-scouting-report public availability", terms: ["opponent scouting report public availability", "opponent-scouting-report public availability"] },
    { name: "post-injury-timeout point-win rate", terms: ["post injury timeout point win rate", "post-injury-timeout point-win rate"] },
    { name: "match-count at current altitude this season", terms: ["match count at current altitude this season", "match-count at current altitude this season"] },
    { name: "consecutive-tournament surface-switching count", terms: ["consecutive tournament surface switching count", "consecutive-tournament surface-switching count"] },
    { name: "first-tournament-back-from-layoff performance", terms: ["first tournament back from layoff performance", "first-tournament-back-from-layoff performance"] },
    { name: "wildcard/entry-status effect", terms: ["wildcard entry status effect", "wildcard/entry-status effect", "entry status"] },
    { name: "draw-seed protection benefit", terms: ["draw seed protection benefit", "draw-seed protection benefit"] },
    { name: "post-walkover-round performance", terms: ["post walkover round performance", "post-walkover-round performance"] },
    { name: "local qualifying-event carryover", terms: ["local qualifying event carryover", "local qualifying-event carryover"] },
    { name: "fine/suspension history recency", terms: ["fine suspension history recency", "fine/suspension history recency"] },
    { name: "coach-opponent history", terms: ["coach opponent history", "coach-opponent history"] },
    { name: "shot-selection variance under lead vs deficit", terms: ["shot selection variance under lead vs deficit", "shot-selection variance under lead vs deficit"] },
  ],
  "081": [
    { name: "locker-room/backstage conflict history", terms: ["locker room backstage conflict history", "locker-room/backstage conflict history", "backstage conflict"] },
    { name: "anthem/opening-ceremony delay effect", terms: ["anthem opening ceremony delay effect", "anthem/opening-ceremony delay effect", "ceremony delay"] },
    { name: "featured/center-court exposure rate", terms: ["featured center court exposure rate", "featured/center-court exposure rate", "center court exposure"] },
    { name: "rain-delay resumption performance", terms: ["rain delay resumption performance", "rain-delay resumption performance"] },
    { name: "overnight-suspension resumption performance", terms: ["overnight suspension resumption performance", "overnight-suspension resumption performance"] },
    { name: "late-opponent-substitution adjustment", terms: ["late opponent substitution adjustment", "late-opponent-substitution adjustment", "lucky loser replacement", "alternate replacement"] },
    { name: "weekday vs weekend performance split", terms: ["weekday vs weekend performance split"] },
    { name: "consecutive-day-play penalty", terms: ["consecutive day play penalty", "consecutive-day-play penalty"] },
    { name: "training-base relocation", terms: ["training base relocation", "training-base relocation"] },
    { name: "prior withdrawal pattern at this event", terms: ["prior withdrawal pattern at this event"] },
    { name: "electronic-line-calling adjustment lag", terms: ["electronic line calling adjustment lag", "electronic-line-calling adjustment lag"] },
    { name: "first-week vs second-week major split", terms: ["first week vs second week major split", "first-week vs second-week major split"] },
    { name: "prior-year round reached at this exact event", terms: ["prior year round reached at this exact event", "prior-year round reached at this exact event"] },
    { name: "support-staff turnover", terms: ["support staff turnover", "support-staff turnover", "stringer", "physio"] },
    { name: "travel-friction reports", terms: ["travel friction reports", "travel-friction reports", "visa issue", "missed connection", "long transit"] },
    { name: "home-climate differential", terms: ["home climate differential", "home-climate differential"] },
  ],
};

const FORMULA_SUBJECT: Record<string, RegExp> = {
  "079": /coaching|shot clock|violation|racket change|late night|early next day|hydration|medical timeout|first point|first game|opening game|changeover|odd game|even game|return position|serve placement|serve direction|serve pattern|scouting report|altitude|elevation|surface switch|layoff|absence|wildcard|protected ranking|qualifying|entry status|seed|draw|walkover|fine|suspension|coach opponent|coach history|lead|deficit|shot selection/i,
  "081": /ceremony|start delay|court assignment|center court|featured court|rain delay|resumption|overnight suspension|opponent substitution|lucky loser|alternate|weekday|weekend|consecutive day|training base|withdrawal|electronic line calling|major week|grand slam week|prior year round|stringer|physio|support staff|visa|transit|missed connection|travel friction|home climate|event climate|temperature|humidity|dryness/i,
};
const FORMULA_DENOMINATOR = /matches?|games?|sets?|points?|events?|opportunities|days?|rounds?|exposures?|visits?|resumptions?|withdrawals?|appearances?|observations?/i;

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
function hasAny(value: string | null, terms: string[]) {
  const v = norm(value);
  return terms.some((term) => v.includes(norm(term)));
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
function allowedFormula(code: string, value: string | null) {
  if (!value || code === "078") return false;
  const formula = tag(value, "FORMULA");
  const rawInputs = tag(value, "INPUTS");
  if (!formula || !rawInputs) return false;
  const inputs = rawInputs.split("|").map((x) => x.trim()).filter(Boolean);
  const subject = FORMULA_SUBJECT[code];
  if (!inputs.length || !subject) return false;
  if (!inputs.some((input) => subject.test(input))) return false;
  if (inputs.some((input) => !subject.test(input) && !FORMULA_DENOMINATOR.test(input))) return false;
  const normalizedFormula = norm(formula);
  if (inputs.some((input) => !normalizedFormula.includes(norm(input)))) return false;
  const forbidden = code === "079"
    ? /surface elo|market odds|sportsbook|sponsor pressure|ranking|age|height|handedness|hold pct|break pct/i
    : /surface elo|serve profile|return profile|market odds|sportsbook|sponsor pressure|ranking|age|height|handedness|ace rate|double fault|hold pct|break pct/i;
  return !forbidden.test(formula) && !forbidden.test(rawInputs);
}
function validateSide(code: string, value: string | null, treatment: MetricFinding["p1_treatment"], sources: MetricFinding["sources"], player: string) {
  if (!value || treatment === "UNAVAILABLE" || treatment === "EXCLUDED") return { value: null, treatment: treatment === "EXCLUDED" ? "EXCLUDED" as const : "UNAVAILABLE" as const, missing: [] as string[] };
  const missing: string[] = [];
  if (tag(value, "PLAYER") !== player) missing.push("exact PLAYER orientation");
  if (!sourceMatches(value, sources, PUBLIC_CONTEXT.has(code))) missing.push("matching admissible SOURCE provenance");
  if (!tag(value, "SAMPLE")) missing.push("SAMPLE/window metadata");
  const components = COMPONENTS[code] ?? [];
  const hits = components.filter((component) => hasAny(value, component.terms));
  if (!hits.length) missing.push("exact master-definition component");
  if (treatment === "RECONSTRUCTED" && !allowedFormula(code, value)) missing.push("explicit formula with enumerated exact permitted INPUTS");
  if (code === "078" && treatment === "RECONSTRUCTED") missing.push("078 factual context cannot be reconstructed from performance proxies");
  if (!hits.length || missing.some((x) => /PLAYER|SOURCE|SAMPLE|formula|cannot be reconstructed/.test(x))) return { value: null, treatment: "UNAVAILABLE" as const, missing };
  if (hits.length < components.length && treatment === "DIRECT") return { value, treatment: "PARTIAL" as const, missing: [...missing, ...components.filter((c) => !hits.includes(c)).map((c) => c.name)] };
  return { value, treatment, missing: [...missing, ...components.filter((c) => !hits.includes(c)).map((c) => c.name)] };
}

export function enforceMetricWiring078081(finding: MetricFinding, players: { p1: string; p2: string }): MetricFinding {
  const code = codeOf(finding.metric_code);
  if (!TARGET.has(code)) return finding;
  const p1 = validateSide(code, finding.p1_value, finding.p1_treatment, finding.sources, players.p1);
  const p2 = validateSide(code, finding.p2_value, finding.p2_treatment, finding.sources, players.p2);
  const missing = [...new Set([...(finding.missing_inputs ?? []), ...p1.missing, ...p2.missing])];
  const referenced = new Set([norm(tag(p1.value, "SOURCE")), norm(tag(p2.value, "SOURCE"))].filter(Boolean));
  return {
    ...finding,
    p1_value: p1.value,
    p2_value: p2.value,
    p1_treatment: p1.treatment,
    p2_treatment: p2.treatment,
    evidence_family: `EXACT_${code}`,
    sample: `P1:${tag(p1.value, "SAMPLE") ?? "UNAVAILABLE"} | P2:${tag(p2.value, "SAMPLE") ?? "UNAVAILABLE"}`,
    sources: (finding.sources ?? []).filter((source) => referenced.has(norm(source.source_name))),
    unavailable_reason: missing.length ? `Metric ${code} exact-wiring guard retained only master-definition evidence. Missing/unsupported: ${missing.join(", ")}.` : finding.unavailable_reason,
    missing_inputs: missing.length ? missing : finding.missing_inputs,
  };
}

function instruction(code: string, p1: string, p2: string) {
  if (!TARGET.has(code)) return "";
  return `\nSTRICT FINAL-METRIC WIRING RULE FOR ${code}: Only exact components in this metric's authoritative definition are admissible. No neighboring statistic, generic context, social chatter, row-order identity, or proxy may satisfy it. Every usable side value MUST include PLAYER=<exact player>; SOURCE=<actual source_name present in sources>; SAMPLE=<actual denominator/window, or UNAVAILABLE when the source has no denominator>. P1 must use PLAYER=${p1}; P2 must use PLAYER=${p2}. RECONSTRUCTED requires INPUTS=<exact raw input 1>|<exact raw input 2>; FORMULA=<explicit calculation using those exact INPUTS>. Every INPUTS item must be a raw field required by the named submetric and must appear in FORMULA; unrelated inputs invalidate reconstruction. Metric 078 is factual public context and must not be RECONSTRUCTED from performance data. PARTIAL is allowed only when one or more exact named subcomponents are sourced; otherwise UNAVAILABLE.`;
}

export const finalMetricWiringResearcher: Researcher = {
  ...metricWiring072076Researcher,
  async metrics(input) {
    const decorated = input.metrics.map((metric) => ({ ...metric, body: `${metric.body ?? ""}${instruction(codeOf(metric.code), input.p1, input.p2)}` }));
    const rows = await metricWiring072076Researcher.metrics({ ...input, metrics: decorated });
    const byCode = new Map(rows.map((row) => [String(row.metric_code), row]));
    return input.metrics.map((metric) => clearPhantomEvidenceMetadata(enforceMetricWiring078081(byCode.get(String(metric.code)) ?? {
      metric_code: metric.code,
      p1_value: null,
      p2_value: null,
      p1_treatment: "UNAVAILABLE",
      p2_treatment: "UNAVAILABLE",
      differential: null,
      evidence_family: null,
      reliability: null,
      sample: null,
      unavailable_reason: "No sourced result survived the final metric wiring guard.",
      missing_inputs: ["exact sourced metric evidence"],
      sources: [],
    }, { p1: input.p1, p2: input.p2 })));
  },
};
