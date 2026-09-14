import type { MetricFinding, Treatment } from "./audit-pipeline";

export interface MetricCertificationPolicy {
  code: string;
  name: string;
  permittedRawInputs: string[];
  exactInputMarkers: RegExp[];
  reconstructionGroups: RegExp[][];
  forbiddenProxyOnly: RegExp[];
  requireCompleteForFullTreatment?: boolean;
  allowReconstructed?: boolean;
  rejectForbiddenFields?: boolean;
}

function codeOf(value: string) {
  const m = String(value).match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value).padStart(3, "0");
}

export const CERTIFIED_METRIC_POLICIES: Record<string, MetricCertificationPolicy> = {
  "012": {
    code: "012",
    name: "Fatigue/Workload",
    permittedRawInputs: [
      "pre-match recent match dates",
      "completed-match duration/minutes",
      "set and game counts from completed recent matches",
      "completed match format / deciding-set count",
      "documented match finish time",
      "upcoming-match scheduled time for rest-hours calculation",
      "qualifying-round participation/results",
      "documented tournament locations / coordinates",
      "documented event time-zone offsets",
    ],
    exactInputMarkers: [
      /matches?_last_7_days|matches? in 7 days|past week/i,
      /minutes?(_on_court)?|actual minutes|duration/i,
      /sets?(_last_| played)|games?(_last_| played)/i,
      /three[_ -]?setters?|went the distance/i,
      /late finish/i,
      /rest[_ -]?hours?/i,
      /qualifying/i,
      /travel(_km| distance)?|time[_ -]?zone/i,
    ],
    reconstructionGroups: [
      [/matches?_last_7_days|matches? in 7 days|past week/i],
      [/minutes?(_on_court)?|actual minutes|duration/i],
      [/sets?(_last_| played)|games?(_last_| played)/i],
      [/three[_ -]?setters?|went the distance/i],
      [/late finish/i],
      [/rest[_ -]?hours?/i],
      [/qualifying/i],
      [/travel(_km| distance)?|time[_ -]?zone/i],
    ],
    forbiddenProxyOnly: [/\belo\b/i, /\branking\b/i, /generic recent form/i],
  },
  "019": {
    code: "019",
    name: "Market Calibration",
    permittedRawInputs: [
      "historical pre-match player prices/odds",
      "bookmaker or prediction-market implied probabilities",
      "explicit no-vig transformation where required",
      "historical match outcomes",
      "a reproducible implied-probability bucket definition",
      "bucket sample size / wins / graded outcomes",
    ],
    exactInputMarkers: [/historical.*(odds|price)|implied[_ -]?probab|no[_ -]?vig/i, /bucket/i, /outcomes?|wins?|losses?|graded/i, /calibrat/i],
    reconstructionGroups: [
      [/(historical.*(odds|price))|implied[_ -]?probab|no[_ -]?vig/i],
      [/bucket/i],
      [/outcomes?|wins?|losses?|graded/i],
    ],
    forbiddenProxyOnly: [/current odds only/i, /model probability only/i, /\belo\b/i, /\branking\b/i],
  },
  "022": {
    code: "022",
    name: "Serve/Return Shot-Level Efficiency",
    permittedRawInputs: ["charted serve+1 outcomes", "charted return+1 outcomes", "rally-state labels", "shot-level outcomes tied to player and score context"],
    exactInputMarkers: [/serve\s*\+?\s*1|serve[_ -]?plus[_ -]?1/i, /return\s*\+?\s*1|return[_ -]?plus[_ -]?1/i, /rally[_ -]?state/i, /charted.*shot|shot[_ -]?outcome/i],
    reconstructionGroups: [[/serve\s*\+?\s*1|serve[_ -]?plus[_ -]?1/i], [/return\s*\+?\s*1|return[_ -]?plus[_ -]?1/i], [/rally[_ -]?state/i], [/charted.*shot|shot[_ -]?outcome/i]],
    forbiddenProxyOnly: [/hold %|hold_pct/i, /break %|break_pct/i, /ace rate/i, /return points won/i],
  },
  "024": {
    code: "024",
    name: "Hidden Performance Quality",
    permittedRawInputs: ["point-level or game-level performance observations", "expected conversion values", "actual conversion values", "charted shot-quality inputs where the submetric requires them"],
    exactInputMarkers: [/point[_ -]?level|game[_ -]?level|points? won|games? won/i, /expected/i, /actual|conversion/i, /shot[_ -]?quality|charted shot/i],
    reconstructionGroups: [[/point[_ -]?level|game[_ -]?level|points? won|games? won/i], [/expected/i], [/actual|conversion/i], [/shot[_ -]?quality|charted shot/i]],
    forbiddenProxyOnly: [/scoreline only/i, /\belo\b/i, /\branking\b/i, /win loss record only/i],
  },
  "025": {
    code: "025",
    name: "Match Deterioration Metrics",
    permittedRawInputs: ["chronological set-by-set observations", "set-level serve performance", "set-level return performance", "set-level point performance", "documented/observed physical trend evidence when required"],
    exactInputMarkers: [/set[_ -]?by[_ -]?set|set\s*[123]/i, /serve/i, /return/i, /points?/i, /physical|movement|medical/i],
    reconstructionGroups: [[/set[_ -]?by[_ -]?set|set\s*[123]/i], [/serve/i], [/return/i], [/points?/i], [/physical|movement|medical/i]],
    forbiddenProxyOnly: [/final score only/i, /season average only/i, /\belo\b/i, /\branking\b/i],
  },
  "072": {
    code: "072",
    name: "Matchup Nuance",
    permittedRawInputs: [
      "verified one-handed/two-handed backhand type",
      "opponent dominant shot pattern needed for the backhand matchup interaction",
      "verified height/reach/wingspan observations for the matchup differential",
      "documented junior/ITF-era head-to-head meetings and results",
    ],
    exactInputMarkers: [/one[- ]handed|two[- ]handed|backhand type|backhand matchup/i, /reach|wingspan|height differential/i, /junior.*(head|meeting|h2h)|ITF.*(head|meeting|h2h)|junior\/ITF/i],
    reconstructionGroups: [
      [/one[- ]handed|two[- ]handed|backhand type|backhand matchup/i],
      [/dominant shot pattern|forehand pattern|backhand pattern|shot pattern/i],
      [/reach|wingspan|height differential/i],
      [/junior.*(head|meeting|h2h)|ITF.*(head|meeting|h2h)|junior\/ITF/i],
    ],
    forbiddenProxyOnly: [/generic style|style score|\branking\b|\belo\b|career h2h only|height alone|weather|market odds|fatigue/i],
    requireCompleteForFullTreatment: true,
    allowReconstructed: false,
    rejectForbiddenFields: true,
  },
  "073": {
    code: "073",
    name: "Sentiment / Integrity",
    permittedRawInputs: [
      "attributable pre-match player public statements/interviews/press conferences",
      "documented player social-media engagement/activity observations with a reproducible anomaly basis",
      "named betting-exchange matched-volume data tied to the match",
    ],
    exactInputMarkers: [/public statement|interview|press conference|player statement/i, /social[- ]media.*(engagement|activity|anomal)|engagement anomal/i, /betting exchange.*(matched volume|volume spike)|matched[- ]volume/i],
    reconstructionGroups: [
      [/public statement|interview|press conference|player statement/i],
      [/social[- ]media.*(engagement|activity|anomal)|engagement anomal/i],
      [/betting exchange.*(matched volume|volume spike)|matched[- ]volume/i],
    ],
    forbiddenProxyOnly: [/fans? think|fan chatter|rumou?r|generic sentiment|sportsbook odds|line movement|injury speculation|social chatter|surface elo|serve profile|weather/i],
    requireCompleteForFullTreatment: true,
    allowReconstructed: false,
    rejectForbiddenFields: true,
  },
  "074": {
    code: "074",
    name: "Biomechanics / Physical Detail",
    permittedRawInputs: [
      "charted serve-toss placement observations sufficient to measure consistency",
      "verified racket head size/string pattern/stiffness plus opponent spin/power interaction evidence",
      "charted/documented directional movement asymmetry attributable to a past injury",
      "verified recent grip-size or grip-style changes",
    ],
    exactInputMarkers: [/serve toss.*(consisten|variab|placement)|toss placement/i, /racket.*(head size|string pattern|stiffness)|head size|racket specs/i, /movement asymmetry|directional court coverage|favors? .*leg|favors? .*side/i, /grip[- ]size|grip style|grip adjustment/i],
    reconstructionGroups: [
      [/serve toss.*(consisten|variab|placement)|toss placement/i],
      [/racket.*(head size|string pattern|stiffness)|head size|racket specs/i],
      [/spin|power style|opponent interaction|against this opponent/i],
      [/movement asymmetry|directional court coverage|favors? .*leg|favors? .*side/i],
      [/grip[- ]size|grip style|grip adjustment/i],
    ],
    forbiddenProxyOnly: [/injury history only|generic injury|height|wingspan|serve speed|ace rate|hold %|generic movement|fitness report|\branking\b|market|weather/i],
    requireCompleteForFullTreatment: true,
    allowReconstructed: false,
    rejectForbiddenFields: true,
  },
  "075": {
    code: "075",
    name: "Match Format / Rules Context",
    permittedRawInputs: [
      "official deciding-set tiebreak rule for the event",
      "best-of-3/best-of-5 format plus player-specific historical format adjustment evidence",
      "actual challenge/review count remaining at the relevant in-match stage when admissible",
    ],
    exactInputMarkers: [/deciding[- ]set.*(tiebreak|breaker)|10[- ]point breaker|7[- ]point breaker|advantage set/i, /best[- ]of[- ]?[35]|bo[35].*(adjust|split|profile)|format adjustment/i, /challenge.*remaining|review.*remaining|hawk[- ]eye.*remaining/i],
    reconstructionGroups: [
      [/deciding[- ]set.*(tiebreak|breaker)|10[- ]point breaker|7[- ]point breaker|advantage set/i],
      [/best[- ]of[- ]?[35]|bo[35]/i],
      [/adjust|split|profile|historical/i],
      [/challenge.*remaining|review.*remaining|hawk[- ]eye.*remaining/i],
    ],
    forbiddenProxyOnly: [/event level|surface|roof|order of play|court assignment|practice access|weather|travel|fatigue/i],
    requireCompleteForFullTreatment: true,
    allowReconstructed: false,
    rejectForbiddenFields: true,
  },
  "076": {
    code: "076",
    name: "Scheduling Micro-Context",
    permittedRawInputs: [
      "official order-of-play position / first-on / not-before time",
      "official outer-court versus stadium/show-court assignment",
      "documented official practice-court access or hitting-time evidence before the match",
    ],
    exactInputMarkers: [/match order|order of play|first on court|not before/i, /outer court|stadium court|show court|court assignment/i, /practice[- ]court access|official hitting time|practice access/i],
    reconstructionGroups: [
      [/match order|order of play|first on court|not before/i],
      [/outer court|stadium court|show court|court assignment/i],
      [/practice[- ]court access|official hitting time|practice access/i],
    ],
    forbiddenProxyOnly: [/rest hours|days since last match|travel|time zone|weather|wind|roof|generic fatigue|schedule density|best-of|deciding-set tiebreak/i],
    requireCompleteForFullTreatment: true,
    allowReconstructed: false,
    rejectForbiddenFields: true,
  },
};

function textOf(finding: MetricFinding, side: "P1" | "P2") {
  return String(side === "P1" ? finding.p1_value ?? "" : finding.p2_value ?? "");
}
function treatmentOf(finding: MetricFinding, side: "P1" | "P2") {
  return side === "P1" ? finding.p1_treatment : finding.p2_treatment;
}
function hasSource(finding: MetricFinding) {
  return (finding.sources ?? []).some((s) => Boolean(String(s.source_name ?? "").trim()));
}
function hasExactInput(policy: MetricCertificationPolicy, text: string) {
  return policy.exactInputMarkers.some((r) => r.test(text));
}
function reconstructionComplete(policy: MetricCertificationPolicy, text: string) {
  if (!policy.reconstructionGroups.length) return true;
  return policy.reconstructionGroups.every((group) => group.some((r) => r.test(text)));
}
function hasForbiddenField(policy: MetricCertificationPolicy, text: string) {
  return policy.forbiddenProxyOnly.some((r) => r.test(text));
}
function proxyOnly(policy: MetricCertificationPolicy, text: string) {
  return hasForbiddenField(policy, text) && !reconstructionComplete(policy, text);
}

function validateSide(
  policy: MetricCertificationPolicy,
  finding: MetricFinding,
  side: "P1" | "P2",
): { value: string | null; treatment: Treatment; reason: string | null } {
  const value = side === "P1" ? finding.p1_value : finding.p2_value;
  const treatment = treatmentOf(finding, side);
  if (treatment === "EXCLUDED") return { value, treatment, reason: null };
  if (value === null || value === undefined || value === "") return { value: null, treatment: "UNAVAILABLE", reason: "No persisted metric value for this player side." };
  const text = textOf(finding, side);
  if (!hasSource(finding)) return { value: null, treatment: "UNAVAILABLE", reason: "Usable evidence lacked persisted named-source provenance." };
  if (policy.rejectForbiddenFields && hasForbiddenField(policy, text)) return { value: null, treatment: "UNAVAILABLE", reason: `Cross-wired/forbidden fields were mixed into metric ${policy.code}; the side is rejected rather than counting unrelated evidence.` };
  if (proxyOnly(policy, text)) return { value: null, treatment: "UNAVAILABLE", reason: `Only proxy/cross-wired evidence was present for metric ${policy.code}; exact permitted inputs were absent.` };
  if (!hasExactInput(policy, text)) return { value: null, treatment: "UNAVAILABLE", reason: `Value did not expose any exact permitted raw input for metric ${policy.code}.` };
  const complete = reconstructionComplete(policy, text);
  if (treatment === "RECONSTRUCTED" && policy.allowReconstructed === false) {
    return { value, treatment: "PARTIAL", reason: `Metric ${policy.code} has no approved deterministic reconstruction formula; sourced exact components may remain PARTIAL but cannot be promoted to RECONSTRUCTED.` };
  }
  if ((treatment === "RECONSTRUCTED" || (policy.requireCompleteForFullTreatment && treatment === "DIRECT")) && !complete) {
    return { value, treatment: "PARTIAL", reason: `The broad metric ${policy.code} was only partly satisfied; exact supported components are retained as PARTIAL, never promoted to full DIRECT/RECONSTRUCTED treatment.` };
  }
  return { value, treatment, reason: null };
}

/**
 * Conservative post-validation for the sequentially certified metric families.
 * It never upgrades evidence. It may only preserve or downgrade a provider/local
 * finding when provenance, semantic inputs, or reconstruction completeness fail.
 */
export function certifyMetricFinding(finding: MetricFinding): MetricFinding {
  const code = codeOf(finding.metric_code);
  const policy = CERTIFIED_METRIC_POLICIES[code];
  if (!policy) return finding;
  const p1 = validateSide(policy, finding, "P1");
  const p2 = validateSide(policy, finding, "P2");
  const reasons = [p1.reason, p2.reason].filter(Boolean) as string[];
  return {
    ...finding,
    p1_value: p1.value,
    p2_value: p2.value,
    p1_treatment: p1.treatment,
    p2_treatment: p2.treatment,
    unavailable_reason: reasons.length ? reasons.join(" | ") : finding.unavailable_reason,
    missing_inputs: reasons.length ? [...new Set([...(finding.missing_inputs ?? []), ...reasons])] : finding.missing_inputs,
  };
}

export function certifiedMetricPromptSuffix(code: string) {
  const policy = CERTIFIED_METRIC_POLICIES[codeOf(code)];
  if (!policy) return "";
  return `\nCERTIFIED INPUT FIREWALL ${policy.code} ${policy.name}: permitted raw inputs are ONLY: ${policy.permittedRawInputs.join("; ")}. Do not use ranking, Elo, generic form, neighboring serve/return aggregates, scoreline-only evidence, or current-market-only evidence unless the master definition explicitly names that field. P1 must describe P1 and P2 must describe P2; never swap own-player and opponent evidence. If only some exact components exist, use PARTIAL. RECONSTRUCTED requires every component of the exact definition/formula and a reproducible calculation.`;
}
