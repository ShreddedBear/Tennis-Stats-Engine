import type { MetricFinding, Researcher } from "./audit-pipeline";
import { completionSweepResearcher } from "./completion-sweep-research.server";
import { validatedCompletionResearcher } from "./validated-completion-research.server";

type Component = { name: string; terms: string[]; reconstructedOnly?: boolean };

const POST_FIX_CODES = new Set(["060", "062", "063", "064", "065", "066", "067", "069", "070", "071"]);
const PUBLIC_CONTEXT_CODES = new Set(["062", "063", "064", "065", "066", "069", "070", "071"]);
const NON_RECONSTRUCTABLE_CONTEXT_CODES = new Set(["063", "065", "069", "070"]);

const PROTECTED_COMPONENTS: Record<string, Component[]> = {
  "041": [
    { name: "opponent-quality-adjusted record trend", terms: ["opponent quality adjusted record trend", "opponent-quality-adjusted record trend"] },
    { name: "hold-rate trend", terms: ["hold rate trend", "hold-rate trend", "hold rate improving", "hold improvement"] },
    { name: "return-points-won trend", terms: ["return points won trend", "return-points-won trend", "return points won improving", "return improvement"] },
    { name: "Dominance Ratio trend", terms: ["dominance ratio trend", "dominance ratio improving", "dominance ratio improvement"] },
    { name: "break-points-created trend", terms: ["break points created trend", "break-points-created trend", "break points created improving", "break point creation trend"] },
    { name: "loss-inclusive chronology", terms: ["including losses", "despite losses", "loss-inclusive", "losses included", "while the win loss record lags"] },
  ],
  "043": [
    { name: "favorite-role designation", terms: ["current favorite", "pre match favorite", "pre-match favorite", "favorite role", "favored player"] },
    { name: "favorite-role historical losses", terms: ["historical losses", "favorite losses", "losses as favorite", "favorite-role historical losses"] },
    { name: "documented favorite failure-mode condition", terms: ["failure mode profile", "failure-mode profile", "failure condition", "low first serve", "first serve failure", "serve deterioration", "opponent return points won", "return pressure", "third set", "deciding set", "set state", "set-state"] },
    { name: "today's opponent compatibility", terms: ["today s opponent", "today's opponent", "opponent compatibility", "opponent can reproduce", "opponent can create"] },
  ],
  "044": [
    { name: "underdog-role history", terms: ["current underdog", "underdog role", "as underdog", "historical underdog"] },
    { name: "verified upset outcomes", terms: ["upset wins", "upset outcomes", "verified upset", "favorites beaten"] },
    { name: "favorite Elo similarity", terms: ["elo"] },
    { name: "favorite serve-style similarity", terms: ["serve style", "serving style"] },
    { name: "favorite return-quality similarity", terms: ["return quality", "return strength"] },
    { name: "surface similarity", terms: ["surface", "court surface"] },
    { name: "ranking similarity", terms: ["ranking"] },
    { name: "handedness similarity", terms: ["handedness", "left handed", "right handed", "left-handed", "right-handed"] },
    { name: "rally-style similarity", terms: ["rally style", "rally profile"] },
    { name: "price similarity", terms: ["price", "odds", "implied probability"] },
    { name: "tournament-level similarity", terms: ["tournament level", "event level", "tour level"] },
    { name: "today's favorite orientation", terms: ["today s favorite", "today's favorite", "current favorite"] },
  ],
  "045": [
    { name: "favorite-role designation", terms: ["current favorite", "pre match favorite", "pre-match favorite", "favorite role", "favored player"] },
    { name: "opponent holds first three service games", terms: ["opponent holds first 3 service games", "opponent holds first three service games", "first three service games"] },
    { name: "failed early break chances", terms: ["failing early break chances", "failed early break chances", "missed early break points", "missed early break chances"] },
    { name: "favorite broken first", terms: ["losing first break", "broken first", "favorite being broken first"] },
    { name: "first set reaches 4-4", terms: ["set reaches 4 4", "set reaches 4-4", "first set reaches 4 4", "first set reaches 4-4"] },
    { name: "first-set tiebreak", terms: ["set reaches a tiebreak", "first set tiebreak", "first-set tiebreak"] },
    { name: "opponent forces deciding set", terms: ["opponent forces set 3", "opponent forces a deciding set", "pushed to a deciding set", "forces deciding set"] },
  ],
  "046": [
    { name: "Elo after winning set 1", terms: ["elo after winning set 1", "elo after winning the first set"] },
    { name: "Elo after losing set 1", terms: ["elo after losing set 1", "elo after losing the first set"] },
    { name: "Elo in deciding sets", terms: ["elo in deciding sets", "deciding set elo", "deciding-set elo"] },
    { name: "Elo in tiebreak-heavy matches", terms: ["elo in tiebreak heavy matches", "elo in tiebreak-heavy matches", "tiebreak heavy elo"] },
    { name: "Elo against big servers", terms: ["elo against big servers", "big server elo", "big-server elo"] },
    { name: "Elo against strong returners", terms: ["elo against strong returners", "strong returner elo", "strong-returner elo"] },
    { name: "big-server threshold", terms: ["big server threshold", "big-server threshold", "big server definition"], reconstructedOnly: true },
    { name: "strong-returner threshold", terms: ["strong returner threshold", "strong-returner threshold", "strong returner definition"], reconstructedOnly: true },
  ],
  "060": [
    { name: "serve-return interaction residual", terms: ["serve return interaction residual", "serve–return interaction residual"] },
    { name: "opponent-adjusted shot tolerance", terms: ["opponent adjusted shot tolerance", "opponent-adjusted shot tolerance"] },
    { name: "neutral-point win rate", terms: ["neutral point win rate", "neutral-point win rate"] },
    { name: "first-strike dependency", terms: ["first strike dependency", "first-strike dependency"] },
    { name: "serve dependency index", terms: ["serve dependency index"] },
    { name: "return dependency index", terms: ["return dependency index"] },
    { name: "primary-weapon reliability", terms: ["primary weapon reliability", "primary-weapon reliability"] },
    { name: "plan-b effectiveness", terms: ["plan b effectiveness", "plan-b effectiveness"] },
    { name: "matchup adaptability", terms: ["matchup adaptability"] },
    { name: "in-match adjustment score", terms: ["in match adjustment score", "in-match adjustment score"] },
    { name: "opponent adjustment resistance", terms: ["opponent adjustment resistance"] },
    { name: "scouting exposure penalty", terms: ["scouting exposure penalty"] },
    { name: "rematch adjustment", terms: ["rematch adjustment"] },
    { name: "revenge/rematch tactical differential", terms: ["revenge rematch tactical differential", "revenge/rematch tactical differential"] },
    { name: "lefty-adjusted serve/return differential", terms: ["lefty adjusted serve return differential", "lefty-adjusted serve/return differential"] },
    { name: "handedness interaction by serve direction", terms: ["handedness interaction by serve direction"] },
    { name: "ad-court vs deuce-court effectiveness", terms: ["ad court vs deuce court effectiveness", "ad-court vs deuce-court effectiveness"] },
    { name: "break-point serve-location effectiveness", terms: ["break point serve location effectiveness", "break-point serve-location effectiveness"] },
    { name: "break-point return-position effectiveness", terms: ["break point return position effectiveness", "break-point return-position effectiveness"] },
    { name: "set-point performance differential", terms: ["set point performance differential", "set-point performance differential"] },
    { name: "match-point creation rate", terms: ["match point creation rate", "match-point creation rate"] },
    { name: "match-point exposure rate", terms: ["match point exposure rate", "match-point exposure rate"] },
    { name: "multiple-bp survival", terms: ["multiple bp survival", "multiple-bp survival"] },
    { name: "multiple-bp conversion", terms: ["multiple bp conversion", "multiple-bp conversion"] },
    { name: "extended-deuce endurance", terms: ["extended deuce endurance", "extended-deuce endurance"] },
    { name: "long-game aftermath", terms: ["long game aftermath", "long-game aftermath"] },
    { name: "break-before-changeover effect", terms: ["break before changeover effect", "break-before-changeover effect"] },
    { name: "end-of-set serve deterioration", terms: ["end of set serve deterioration", "end-of-set serve deterioration"] },
    { name: "end-of-set return elevation", terms: ["end of set return elevation", "end-of-set return elevation"] },
    { name: "tiebreak entry quality", terms: ["tiebreak entry quality"] },
    { name: "tiebreak serve-order adjustment", terms: ["tiebreak serve order adjustment", "tiebreak serve-order adjustment"] },
    { name: "mini-break recovery rate", terms: ["mini break recovery rate", "mini-break recovery rate"] },
    { name: "mini-break consolidation rate", terms: ["mini break consolidation rate", "mini-break consolidation rate"] },
    { name: "tiebreak point-differential quality", terms: ["tiebreak point differential quality", "tiebreak point-differential quality"] },
    { name: "third-set first-break importance", terms: ["third set first break importance", "third-set first-break importance"] },
    { name: "decider physical resilience", terms: ["decider physical resilience"] },
    { name: "long-match resilience", terms: ["long match resilience", "long-match resilience"] },
    { name: "physical cliff probability", terms: ["physical cliff probability"] },
    { name: "recovery efficiency", terms: ["recovery efficiency"] },
    { name: "accumulated workload debt", terms: ["accumulated workload debt"] },
    { name: "travel recovery efficiency", terms: ["travel recovery efficiency"] },
    { name: "circadian mismatch", terms: ["circadian mismatch"] },
    { name: "heat-duration interaction", terms: ["heat duration interaction", "heat-duration interaction"] },
    { name: "wind serve penalty", terms: ["wind serve penalty"] },
    { name: "humidity endurance penalty", terms: ["humidity endurance penalty"] },
    { name: "altitude serve amplification", terms: ["altitude serve amplification"] },
    { name: "court-speed elasticity", terms: ["court speed elasticity", "court-speed elasticity"] },
    { name: "surface-speed crossover", terms: ["surface speed crossover", "surface-speed crossover"] },
    { name: "ball degradation sensitivity", terms: ["ball degradation sensitivity"] },
    { name: "new-ball serve boost", terms: ["new ball serve boost", "new-ball serve boost"] },
    { name: "tournament adaptation slope", terms: ["tournament adaptation slope"] },
    { name: "venue familiarity value", terms: ["venue familiarity value"] },
    { name: "time-of-day split", terms: ["time of day split", "time-of-day split"] },
    { name: "round-adjusted pressure", terms: ["round adjusted pressure", "round-adjusted pressure"] },
    { name: "favorite-pressure elasticity", terms: ["favorite pressure elasticity", "favorite-pressure elasticity"] },
    { name: "underdog freedom effect", terms: ["underdog freedom effect"] },
    { name: "price-specific miscalibration", terms: ["price specific miscalibration", "price-specific miscalibration"] },
    { name: "closing-line value history", terms: ["closing line value history", "closing-line value history"] },
    { name: "market disagreement dispersion", terms: ["market disagreement dispersion"] },
    { name: "sharp-vs-recreational book divergence", terms: ["sharp vs recreational book divergence", "sharp-vs-recreational book divergence"] },
    { name: "late-line acceleration", terms: ["late line acceleration", "late-line acceleration"] },
  ],
  "062": [
    { name: "points-defending pressure", terms: ["points defending pressure", "points-defending pressure", "ranking points defended", "ranking points protecting"] },
    { name: "seeding/bye implications", terms: ["seeding bye implications", "seeding/bye implications", "seeding implications", "bye implications"] },
    { name: "prize-money/status milestones", terms: ["prize money status milestones", "prize-money/status milestones", "career high ranking", "top 100 cutoff", "top 50 cutoff", "direct entry cutoff"] },
  ],
  "063": [
    { name: "coaching changes", terms: ["coaching changes", "coach change", "new coach"] },
    { name: "coaching-box presence", terms: ["coaching box presence", "coaching-box presence", "coach present courtside", "coach courtside"] },
    { name: "equipment changes", terms: ["equipment changes", "recent racket change", "recent string setup change", "recent shoe sponsor change"] },
  ],
  "064": [
    { name: "qualifying/lucky-loser fatigue", terms: ["qualifying lucky loser fatigue", "qualifying/lucky-loser fatigue", "lucky loser status", "qualifying status", "qualifying workload"] },
    { name: "draw path difficulty beyond this match", terms: ["draw path difficulty beyond this match", "next round path", "potential later round opponent"] },
  ],
  "065": [
    { name: "off-season/pre-season training reports", terms: ["off season training reports", "off-season training reports", "pre season training reports", "pre-season training reports", "fitness camp", "body composition"] },
    { name: "illness reports", terms: ["illness reports", "documented illness", "flu", "stomach bug"] },
  ],
  "066": [
    { name: "racket/string setup changes", terms: ["racket string setup changes", "racket/string setup changes", "string tension change", "racket model change", "grip size change"] },
    { name: "shoe/traction changes", terms: ["shoe traction changes", "shoe/traction changes", "new shoe sponsor", "new shoe model", "traction change"] },
    { name: "string-tension weather adjustment", terms: ["string tension weather adjustment", "string-tension weather adjustment", "adjusts string tension", "altitude string tension", "humidity string tension"] },
  ],
  "067": [
    { name: "code-violation history", terms: ["code violation history", "code-violation history", "racket abuse", "verbal warning"] },
    { name: "challenge/Hawk-Eye success rate", terms: ["challenge hawk eye success rate", "challenge/hawk-eye success rate", "challenge success rate", "hawk eye success rate"] },
    { name: "bathroom/medical-break patterns", terms: ["bathroom medical break patterns", "bathroom/medical-break patterns", "bathroom break pattern", "medical break pattern"] },
    { name: "on-court time-violation rate", terms: ["on court time violation rate", "on-court time-violation rate", "time violation rate", "slow play warning"] },
  ],
  "069": [
    { name: "retirement-tour/farewell-run effects", terms: ["retirement tour farewell run effects", "retirement-tour/farewell-run effects", "farewell run", "publicly nearing retirement"] },
    { name: "anti-doping testing disruption", terms: ["anti doping testing disruption", "anti-doping testing disruption", "out of competition testing", "out-of-competition testing"] },
  ],
  "070": [
    { name: "sports-psychologist presence", terms: ["sports psychologist presence", "sports-psychologist presence", "mental game coach", "mental-game coach"] },
    { name: "short-notice draw entry", terms: ["short notice draw entry", "short-notice draw entry", "lucky loser", "late alternate", "late-alternate"] },
    { name: "walkover-into-round effect", terms: ["walkover into round effect", "walkover-into-round effect", "previous round was a walkover", "previous-round walkover"] },
  ],
  "071": [
    { name: "roof-open vs roof-closed split", terms: ["roof open vs roof closed split", "roof-open vs roof-closed split", "roof open", "roof closed"] },
    { name: "fixed start-time vs not-before uncertainty", terms: ["fixed start time vs not before uncertainty", "fixed start-time vs not-before uncertainty", "not before", "not-before", "start time uncertainty"] },
  ],
};

function familyCode(code: string) {
  const m = String(code).match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(code).padStart(3, "0");
}
function norm(v: string | null) {
  return String(v ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function containsAny(value: string | null, terms: string[]) {
  const v = norm(value);
  return terms.some((term) => v.includes(norm(term)));
}
function tagValue(value: string | null, key: string) {
  if (!value) return null;
  const match = value.match(new RegExp(`${key}\\s*=\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? null;
}
function sourceForValue(value: string | null, sources: MetricFinding["sources"], needsPublic: boolean) {
  const sourceTag = tagValue(value, "SOURCE");
  if (!sourceTag) return null;
  return (sources ?? []).find((source) => {
    if (norm(source.source_name ?? "") !== norm(sourceTag)) return false;
    if (!needsPublic) return Boolean(String(source.source_name ?? "").trim());
    const name = norm(source.source_name ?? "");
    const url = String(source.url ?? "");
    return /^https?:\/\//i.test(url) && Boolean(name) && !/(model|inference|ai generated|assistant|matrix summary|prediction)/.test(name);
  }) ?? null;
}
function hasUsableSource(sources: MetricFinding["sources"]) {
  return Boolean(sources?.some((s) => Boolean(String(s.source_name ?? "").trim())));
}
function hasSupportablePublicSource(sources: MetricFinding["sources"]) {
  return Boolean(sources?.some((s) => {
    const name = norm(s.source_name ?? "");
    const url = String(s.url ?? "");
    return /^https?:\/\//i.test(url) && Boolean(name) && !/(model|inference|ai generated|assistant|matrix summary|prediction)/.test(name);
  }));
}
function formulaUsesForbiddenInput(code: string, value: string | null) {
  if (!value) return false;
  const formula = tagValue(value, "FORMULA");
  if (!formula) return false;
  const t = norm(formula);
  const forbidden: Record<string, string[]> = {
    "060": ["sponsorship obligation", "media obligation", "code violation", "sports psychologist"],
    "062": ["serve", "return", "weather", "travel", "fatigue", "odds", "market", "elo", "recent form"],
    "064": ["serve", "return", "weather", "travel", "timezone", "odds", "market", "elo", "ranking"],
    "066": ["coach", "sponsorship obligation", "media obligation", "market", "odds", "elo", "code violation", "sports psychologist"],
    "067": ["elo", "ranking", "market", "odds", "weather", "surface elo", "hold pct", "break pct", "recent form"],
    "071": ["market", "odds", "elo", "ranking", "injury", "fatigue", "travel", "serve profile", "return profile"],
  };
  return (forbidden[code] ?? []).some((term) => t.includes(norm(term)));
}

function validateSide(
  code: string,
  value: string | null,
  treatment: MetricFinding["p1_treatment"],
  sources: MetricFinding["sources"],
  components: Component[],
  expectedPlayer?: string,
) {
  const strict = POST_FIX_CODES.has(code) && Boolean(expectedPlayer);
  if (treatment === "UNAVAILABLE" || treatment === "EXCLUDED") return { value: strict ? null : value, treatment, missing: [] as string[] };
  const needsPublic = PUBLIC_CONTEXT_CODES.has(code);
  const sourceOk = strict ? Boolean(sourceForValue(value, sources, needsPublic)) : (needsPublic ? hasSupportablePublicSource(sources) : hasUsableSource(sources));
  const required = components.filter((c) => !c.reconstructedOnly || treatment === "RECONSTRUCTED");
  const metaMissing: string[] = [];
  if (strict) {
    if (!value || norm(tagValue(value, "PLAYER")) !== norm(expectedPlayer ?? "")) metaMissing.push(`PLAYER=${expectedPlayer ?? "expected player"}`);
    if (!tagValue(value, "SOURCE") || !sourceOk) metaMissing.push(needsPublic ? "side-specific SOURCE matching a supportable public URL" : "side-specific SOURCE matching persisted provenance");
    if (!tagValue(value, "SAMPLE")) metaMissing.push("side-specific SAMPLE");
    if (treatment === "RECONSTRUCTED" && !tagValue(value, "FORMULA")) metaMissing.push("FORMULA for reconstructed evidence");
    if (treatment === "RECONSTRUCTED" && NON_RECONSTRUCTABLE_CONTEXT_CODES.has(code)) metaMissing.push("DIRECT public reporting required; this metric is not reconstructable");
    if (treatment === "RECONSTRUCTED" && formulaUsesForbiddenInput(code, value)) metaMissing.push("FORMULA uses an input outside the authoritative metric definition");
  }
  if (!value || !sourceOk) {
    return { value: null, treatment: "UNAVAILABLE" as const, missing: [...required.map((c) => c.name), ...metaMissing] };
  }
  const hits = required.filter((c) => containsAny(value, c.terms));
  const missing = [...required.filter((c) => !hits.includes(c)).map((c) => c.name), ...metaMissing];
  if (strict && metaMissing.length) return { value: null, treatment: "UNAVAILABLE" as const, missing };
  if (!missing.length) return { value, treatment, missing };
  if (hits.length) return { value, treatment: "PARTIAL" as const, missing };
  return { value: null, treatment: "UNAVAILABLE" as const, missing };
}

function referencedSources(values: Array<string | null>, sources: MetricFinding["sources"], needsPublic: boolean) {
  const wanted = new Set(values.map((value) => norm(tagValue(value, "SOURCE"))).filter(Boolean));
  return (sources ?? []).filter((source) => {
    if (!wanted.has(norm(source.source_name ?? ""))) return false;
    if (!needsPublic) return true;
    const name = norm(source.source_name ?? "");
    const url = String(source.url ?? "");
    return /^https?:\/\//i.test(url) && Boolean(name) && !/(model|inference|ai generated|assistant|matrix summary|prediction)/.test(name);
  });
}

export function validateProtectedMetricWiring(finding: MetricFinding, expected?: { p1: string; p2: string }): MetricFinding {
  const code = familyCode(finding.metric_code);
  const components = PROTECTED_COMPONENTS[code];
  if (!components) return finding;
  const p1 = validateSide(code, finding.p1_value, finding.p1_treatment, finding.sources, components, expected?.p1);
  const p2 = validateSide(code, finding.p2_value, finding.p2_treatment, finding.sources, components, expected?.p2);
  const missing = [...new Set([...(p1.missing ?? []), ...(p2.missing ?? [])])];
  const strict = POST_FIX_CODES.has(code) && Boolean(expected);
  const sources = strict ? referencedSources([p1.value, p2.value], finding.sources, PUBLIC_CONTEXT_CODES.has(code)) : finding.sources;
  const p1Sample = strict ? tagValue(p1.value, "SAMPLE") : null;
  const p2Sample = strict ? tagValue(p2.value, "SAMPLE") : null;
  return {
    ...finding,
    p1_value: p1.value,
    p2_value: p2.value,
    p1_treatment: p1.treatment,
    p2_treatment: p2.treatment,
    evidence_family: strict ? `EXACT_${code}` : finding.evidence_family,
    sample: strict ? `P1:${p1Sample ?? "UNAVAILABLE"} | P2:${p2Sample ?? "UNAVAILABLE"}` : finding.sample,
    sources,
    unavailable_reason: missing.length
      ? `Protected metric wiring guard: only exact master-definition components are admissible for ${code}; unsupported components remain missing (${missing.join(", ")}). No proxy substitution, side reversal, unrelated provenance, or out-of-definition formula input permitted.`
      : finding.unavailable_reason,
    missing_inputs: missing.length ? [...new Set([...(finding.missing_inputs ?? []), ...missing])] : finding.missing_inputs,
  };
}

function postFixInstruction(code: string, p1: string, p2: string) {
  if (!POST_FIX_CODES.has(code)) return "";
  const contextRule = PUBLIC_CONTEXT_CODES.has(code)
    ? " SOURCE must be a real public HTTP(S) source that directly supports the tagged component."
    : " SOURCE must name the actual persisted source supporting the tagged component.";
  const reconstructionRule = NON_RECONSTRUCTABLE_CONTEXT_CODES.has(code)
    ? " This metric is factual public context and may not be labeled RECONSTRUCTED; use DIRECT/PARTIAL/UNAVAILABLE as appropriate."
    : " RECONSTRUCTED additionally requires FORMULA=<explicit calculation using only inputs permitted by the authoritative master definition>.";
  return `\nSTRICT FIVE-METRIC POST-FIX RULE: no neighboring statistic, generic proxy, row-order identity, or unrelated source may satisfy this metric. Every usable side value MUST use: PLAYER=<exact player name>; SOURCE=<one actual source_name also present in sources>; SAMPLE=<actual denominator/window, or UNAVAILABLE if the source publishes no denominator>; <exact supported master-definition component(s)>. P1 must use PLAYER=${p1}; P2 must use PLAYER=${p2}.${contextRule}${reconstructionRule} If any mapping cannot be proved, return PARTIAL only for exact supported components; otherwise return UNAVAILABLE.`;
}

export const protectedMetricWiringResearcher: Researcher = {
  ...validatedCompletionResearcher,
  async metrics(input) {
    const target = input.metrics.filter((metric) => POST_FIX_CODES.has(familyCode(metric.code)));
    const other = input.metrics.filter((metric) => !POST_FIX_CODES.has(familyCode(metric.code)));
    const rows: MetricFinding[] = [];
    if (other.length) rows.push(...await validatedCompletionResearcher.metrics({ ...input, metrics: other }));
    if (target.length) {
      const guardedTarget = target.map((metric) => ({
        ...metric,
        body: `${metric.body ?? ""}${postFixInstruction(familyCode(metric.code), input.p1, input.p2)}`,
      }));
      rows.push(...await completionSweepResearcher.metrics({ ...input, metrics: guardedTarget }));
    }
    const byCode = new Map(rows.map((row) => [String(row.metric_code), row]));
    return input.metrics.map((metric) => {
      const row = byCode.get(String(metric.code)) ?? {
        metric_code: metric.code,
        p1_value: null,
        p2_value: null,
        p1_treatment: "UNAVAILABLE" as const,
        p2_treatment: "UNAVAILABLE" as const,
        differential: null,
        evidence_family: null,
        reliability: null,
        sample: null,
        unavailable_reason: "No finding returned for requested metric.",
        sources: [],
      };
      return POST_FIX_CODES.has(familyCode(metric.code))
        ? validateProtectedMetricWiring(row, { p1: input.p1, p2: input.p2 })
        : validateProtectedMetricWiring(row);
    });
  },
};
