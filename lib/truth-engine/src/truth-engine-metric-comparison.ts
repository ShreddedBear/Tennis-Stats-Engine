// TRUTH ENGINE — DETERMINISTIC P1 vs P2 METRIC COMPARISON
//
// Why this exists (forensic finding, docs/audit-truth-engine-decision-core.md):
// every decision stage in this pipeline (verification, disagreement, underdog,
// conclusion, stress) delegated entirely to the LLM researcher, with no deterministic
// fallback. Across 405 persisted runs that produced 0 verification findings, 0
// disagreement risks, 0 underdog classifications and 0 independent winners, while the
// stages themselves still reported COMPLETE. Metric execution, by contrast, works and
// has persisted real two-sided evidence (7,713 P1 / 7,342 P2 values).
//
// This module turns that already-computed metric evidence into a comparable, auditable
// P1-vs-P2 signal WITHOUT any AI call and without inventing data.
//
// THREE RULES THIS MODULE ENFORCES ABSOLUTELY:
//
// 1. UNAVAILABLE IS NEVER ZERO. A missing/NA/unparseable value yields status
//    "UNAVAILABLE" and takes no part in the comparison. It is never coerced to 0, which
//    would silently read as "this player scored nothing" and hand the other side a win.
//
// 2. MISSING EVIDENCE NEVER FAVOURS THE OTHER PLAYER. A comparison requires BOTH sides
//    to parse. One-sided evidence is "UNAVAILABLE" (one_sided), never a P1 or P2 lean.
//
// 3. DIRECTION IS EXPLICIT, NEVER INFERRED. Every comparable metric must declare which
//    direction is better in COMPARISON_SPECS below. A metric with no spec is reported
//    NO_COMPARISON_SPEC and excluded from the decision rather than guessed at -- guessing
//    a direction is exactly how a P1/P2 selection silently inverts.

export type ComparisonDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
export type ComparisonFavours = "P1" | "P2" | "NEUTRAL" | "UNAVAILABLE";
export type ComparisonStatus =
  | "COMPARED"
  | "NO_COMPARISON_SPEC"
  | "TREATMENT_NOT_USABLE"
  | "ONE_SIDED_EVIDENCE"
  | "VALUE_NOT_PARSEABLE"
  | "INSUFFICIENT_SAMPLE";

const USABLE_TREATMENTS = new Set(["DIRECT", "RECONSTRUCTED", "PARTIAL"]);

export interface ComparisonSpec {
  /** Keyed field to compare, e.g. "last10_win_pct". null means the whole value is a bare scalar (e.g. metric 001's Elo). */
  field: string | null;
  /**
   * Alternate persisted names for the SAME quantity. Producers have emitted more than one
   * key name for one measurement (e.g. 008 persists "deciding_set_win_pct" in 87 rows and
   * "set3_deciding_set_win_pct" in 1). An alias is only legitimate when it denotes the
   * identical quantity in the identical units and direction -- never a similar-sounding
   * substitute, which would silently change what is being compared.
   */
  fieldAliases?: string[];
  /**
   * Accept a bare scalar value when no keyed field is present. Only legitimate where the
   * bare form is unambiguously the SAME measurement as `field`: metric 001 persists its
   * surface Elo as a bare "1521.13" in 189 rows and as "surface_elo=1429" in 102. It is
   * never set for a metric whose bare scalar has an unknown meaning -- 008/010 persist
   * bare counts of unknown definition, and those stay VALUE_NOT_PARSEABLE by design.
   */
  bareScalarFallback?: boolean;
  /**
   * Denominator field(s) this measurement is computed over, and the smallest denominator
   * worth reading. Live proof this is needed: on run ce9706af metric 018 compared
   * "0% breakbacks" against "100% breakbacks" -- a 100-point gap that cleared any fixed
   * noise floor -- off THREE and TWO attempts respectively. A fixed materiality cannot
   * catch that, because the noise floor is a property of the sample, not of the metric.
   * Below the threshold, or when the denominator is not persisted at all, the comparison
   * is INSUFFICIENT_SAMPLE: never a lean for either side, and never zero.
   * Declared only where the producer actually persists a denominator; the nine specs that
   * predate Phase 12 are deliberately left as they were rather than changed without proof.
   */
  sampleField?: string[];
  minSample?: number;
  /** Optional second field subtracted from `field` (e.g. favourable - unfavourable outcomes). */
  minusField?: string;
  direction: ComparisonDirection;
  /** Independent evidence family. Metrics sharing a family are correlated and must vote ONCE (anti-double-counting). */
  family: string;
  /** Differences at or below this are NEUTRAL — guards against treating noise as a signal. */
  materiality: number;
  label: string;
}

// Only metrics whose comparable quantity and direction are defensible from the metric's
// own definition are listed. This registry is deliberately conservative: an absent code
// is reported NO_COMPARISON_SPEC and contributes nothing, which is honest, rather than
// being assigned a guessed direction. Quarantined codes (MATRIX_SUMMARY_REQUIRED) are
// intentionally absent and must never be added here while quarantined.
export const COMPARISON_SPECS: Record<string, ComparisonSpec> = {
  // Surface-specific Elo rating; the single most decision-relevant strength signal.
  "001": { field: "surface_elo", bareScalarFallback: true, direction: "HIGHER_IS_BETTER", family: "SURFACE_STRENGTH", materiality: 10, label: "Surface Elo" },
  // Recent form: share of the last 10 matches won.
  "005": { field: "last10_win_pct", direction: "HIGHER_IS_BETTER", family: "RECENT_FORM", materiality: 5, label: "Last-10 win %" },
  // Set Profile: deciding-set win rate.
  "008": { field: "set3_deciding_set_win_pct", fieldAliases: ["deciding_set_win_pct"], direction: "HIGHER_IS_BETTER", family: "SET_PROFILE", materiality: 5, label: "Deciding-set win %" },
  // Straight-set control.
  "010": { field: "straight_set_match_win_pct", fieldAliases: ["straight_set_win_pct"], direction: "HIGHER_IS_BETTER", family: "SET_PROFILE", materiality: 5, label: "Straight-set win %" },
  // Volatility/floor: overall match win rate component.
  "011": { field: "match_win_pct", direction: "HIGHER_IS_BETTER", family: "RESULTS_HISTORY", materiality: 5, label: "Match win %" },
  // Common-opponent adjusted set differential (opponent-quality adjusted).
  "031": { field: "opponent_adjusted_set_differential", direction: "HIGHER_IS_BETTER", family: "COMMON_OPPONENT", materiality: 0.15, label: "Opponent-adjusted set differential" },
  // Opponent finishing ability: how reliably a lead is protected.
  "027": { field: "lead_protection_rate_pct", direction: "HIGHER_IS_BETTER", family: "CLOSING_ABILITY", materiality: 5, label: "Lead protection %" },
  // Opponent-specific (H2H-shrunk) win probability.
  "051": { field: "shrunk_win_probability_pct", direction: "HIGHER_IS_BETTER", family: "H2H_PROBABILITY", materiality: 3, label: "Opponent-specific win probability %" },
  // Common-opponent caliber: favourable minus unfavourable divergent outcomes.
  // Deliberately shares COMMON_OPPONENT with 031 -- they read the same shared-opponent
  // pool, so they must not count as two independent pieces of evidence.

  // ---- Phase 12 additions -------------------------------------------------------------
  // Every noise floor below is set from the metric's OWN observed sample size in the live
  // database (median n, then ~1 standard error of the P1-P2 difference of a proportion),
  // not from a round number that felt right. Small-sample metrics therefore carry LARGE
  // floors and will read NEUTRAL unless the gap is genuinely big -- which is the honest
  // outcome, not a weakness.

  // POINT_BY_POINT: 002/003/009/018/032/034/053 are all reconstructed from the SAME
  // point-by-point replay of the same handful of matches -- the database labels every one
  // of them evidence_family=POINT_BY_POINT. They therefore share one family and vote ONCE.
  // If serve and return disagree inside that one sample, the family is conflicted and
  // contributes nothing, which is correct: it is one body of evidence disagreeing with
  // itself, not two independent confirmations.
  // n median 58 service points -> SE ~6.6pp, difference ~9.3pp.
  "002": { field: "service_point_win_pct", sampleField: ["service_points"], minSample: 30, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 10, label: "Service point win %" },
  // n median 54 return points -> SE ~6.8pp, difference ~9.6pp.
  "003": { field: "return_point_win_pct", sampleField: ["return_points"], minSample: 30, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 10, label: "Return point win %" },
  // n median 17 pressure points -> SE ~12pp, difference ~17pp.
  "009": { field: "pressure_win_pct", sampleField: ["pressure_points"], minSample: 15, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 18, label: "Pressure point win %" },
  // n median ~4 breakback opportunities -> SE ~25pp. Almost nothing clears this floor, by design.
  "018": { field: "breakback_rate_pct", sampleField: ["breakback_opportunities"], minSample: 10, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 40, label: "Breakback rate %" },
  // n median ~3 break chances -> SE ~29pp.
  "032": { field: "bp_converted_pct", sampleField: ["break_chances"], minSample: 10, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 40, label: "Break-point conversion %" },
  // Dominance ratio = own return points won % / opponent return points won %; ~1.0-1.3 in
  // practice, so a 0.15 floor is roughly one sampling step rather than a fixed percentage.
  "034": { field: "dominance_ratio", sampleField: ["total_points_played"], minSample: 60, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 0.15, label: "Dominance ratio" },
  // Same pressure-point denominator as 009.
  "053": { field: "pressure_index_pct", sampleField: ["pressure_points"], minSample: 15, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 18, label: "Pressure index %" },

  // Common-opponent win rate. Shares COMMON_OPPONENT with 031/080 -- same shared-opponent
  // pool, so it must not read as a third independent confirmation.
  // n median 11 ranked common-opponent matches -> SE ~15pp, difference ~21pp.
  "007": { field: "win_pct", sampleField: ["ranked_common_opponent_matches"], minSample: 10, direction: "HIGHER_IS_BETTER", family: "COMMON_OPPONENT", materiality: 20, label: "Common-opponent win %" },

  // Psychological response, measured AGAINST THE PLAYER'S OWN BASELINE. Subtracting the
  // baseline is what makes this independent of raw strength: without it the metric would
  // largely restate overall win rate and double-count RESULTS_HISTORY.
  // n median 8 close-set losses -> SE ~18pp on the conditional rate alone.
  "029": { field: "after_close_set_loss_match_win_pct", minusField: "baseline_match_win_rate_pct", sampleField: ["after_close_set_loss_n"], minSample: 8, direction: "HIGHER_IS_BETTER", family: "PSYCH_RESPONSE", materiality: 25, label: "Response after a close set loss, vs own baseline" },

  // Loss quality. 036 = share of losses in which the player was the FAVOURITE
  // (audit-metric-036-loss-autopsy.ts: 100 * favoriteLosses / losses); 006 = share of recent
  // losses to opponents >=100 Elo below (predixsport-recent.server.ts). Losing when you were
  // the stronger player is bad, so both are LOWER_IS_BETTER, and both read the same recent
  // loss list, so they share one family.
  // 036: n median 20 losses -> SE ~11pp, difference ~16pp.
  "036": { field: "favorite_losses_rate_pct", sampleField: ["trailing_losses_used"], minSample: 10, direction: "LOWER_IS_BETTER", family: "LOSS_PROFILE", materiality: 15, label: "Losses as favourite %" },
  // 006: eligible-loss denominator is very small; floor set accordingly.
  "006": { field: "bad_loss_rate_pct", sampleField: ["quality_observed_matches", "eligible_losses_n"], minSample: 5, direction: "LOWER_IS_BETTER", family: "LOSS_PROFILE", materiality: 25, label: "Bad-loss rate %" },

  // Hidden improvement: recent minus earlier mean Elo-adjusted surplus, i.e. actual outcome
  // minus Elo-expected win probability. audit-metric-041 itself defines improvement as
  // recent.mean_elo_adjusted_surplus > earlier.mean_elo_adjusted_surplus, so the direction
  // is the producer's own, not an interpretation of the metric name.
  "041": { field: "recent_elo_adjusted_surplus", minusField: "earlier_elo_adjusted_surplus", direction: "HIGHER_IS_BETTER", family: "IMPROVEMENT_TREND", materiality: 0.1, label: "Elo-adjusted surplus, recent vs earlier" },

  // Elo movement across the last 10 matches. Shares RECENT_FORM with 005 (last-10 win %):
  // both are computed over the same ten-match window and cannot be independent of each other.
  "055": { field: "elo_change_last10", direction: "HIGHER_IS_BETTER", family: "RECENT_FORM", materiality: 20, label: "Elo change over last 10" },

  // ---- Phase 13.5 additions -----------------------------------------------------------
  // Only the four candidates the user's own forensic inventory named as calculable-now-
  // strongest are added here (016, 045, 046, 068). 046 (Match-State Elo) was investigated
  // and deliberately NOT activated -- see docs/audit-truth-engine-phase13.5-evidence-expansion.md.
  // It has two co-equal, differently-scoped bullets (Elo after winning Set 1 vs. Elo after
  // losing Set 1) with no definitional or usage-site basis for picking one over the other,
  // and -- unlike every other spec in this registry -- it persists NO denominator at all
  // (0 of the 60 live usable rows carry any sample/n field for either quantity), so a
  // thin-evidence guard cannot be built for it. Forcing a single-field choice or shipping
  // it unguarded would be exactly the kind of guess this registry exists to refuse.

  // Score-state performance specifically at a break point, from the player's own
  // perspective across whichever role (server saving / returner converting) they held.
  // Shares POINT_BY_POINT with 002/003/009/018/032/034/053 -- the identical replay of the
  // identical matches -- so it can only corroborate or conflict with that family, never
  // cast a second vote. n median 9.5 (58/58 live rows) -> SE(diff) ~23pp.
  "016": { field: "score_state_break_point_win_pct", sampleField: ["score_state_break_point_n"], minSample: 8, direction: "HIGHER_IS_BETTER", family: "POINT_BY_POINT", materiality: 24, label: "Break-point score-state win %" },

  // Deciding-set win rate specifically in matches where the player was the pre-match Elo
  // favourite (audit-metric-045-favorite-fragility.ts: computeFavoriteFragility restricts
  // to favourite-perspective matches only, symmetric per player). This is the metric's own
  // final and highest-stakes named bullet ("Performance When Opponent Forces Set 3"), and
  // it is a conditional refinement of the same "how do you perform in a decider" question
  // 008/010 already ask unconditionally -- sharing SET_PROFILE prevents it reading as a
  // second independent confirmation. n median 8 (51 live rows, min 0) -> SE(diff) ~25pp.
  "045": { field: "forced_deciding_set_win_pct", sampleField: ["forced_deciding_set_n"], minSample: 8, direction: "HIGHER_IS_BETTER", family: "SET_PROFILE", materiality: 25, label: "Deciding-set win % as pre-match favourite" },

  // Current active win/loss streak (signed match count), the metric's own first-listed
  // bullet ("Current Win/Loss Streak Length: the player's active streak entering the
  // match"). Shares RECENT_FORM with 005/055 -- all three read the same recent-results
  // window, so they corroborate or conflict rather than voting independently.
  // The producer (historical-results-recovery.ts) computes the streak over ALL completed
  // history, but that true denominator is never persisted; season_matches IS persisted and
  // is always <= the true denominator (a strict subset), so gating on it can only be overly
  // conservative, never under-conservative -- it cannot let a thin true sample through.
  // Real P1-P2 differential stdev across 162 live paired rows: 4.51 matches.
  "068": { field: "current_streak_signed", sampleField: ["season_matches"], minSample: 5, direction: "HIGHER_IS_BETTER", family: "RECENT_FORM", materiality: 5, label: "Current win/loss streak (signed match count)" },

  "080": { field: "favorable_divergent_outcomes", minusField: "unfavorable_divergent_outcomes", direction: "HIGHER_IS_BETTER", family: "COMMON_OPPONENT", materiality: 1, label: "Common-opponent net divergent outcomes" },
};

export interface ParsedMetricValue {
  scalar: number | null;
  fields: Map<string, string>;
}

/**
 * Parses both persisted shapes seen in metric_results: a bare scalar ("1483.15") and a
 * keyed string ("last10_win_pct=10; trend_direction=DECLINING"). Provenance-prefixed
 * values ("PLAYER=x; SOURCE=y; SAMPLE=5; k=v") parse into the same field map, so a
 * spec'd field is still found inside them.
 */
export function parseMetricValue(raw: string | null | undefined): ParsedMetricValue {
  const text = String(raw ?? "").trim();
  const fields = new Map<string, string>();
  if (!text) return { scalar: null, fields };
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) fields.set(key, value);
  }
  // Reconstructed metrics persist their real numbers inside a JSON payload
  // (`output={"service_point_win_pct":61.1,...}`). Splitting on ";" leaves that object
  // intact because the payload contains no semicolons, so its numeric leaves are merged
  // into the same flat field map. Only finite numbers are merged -- nulls, booleans and
  // nested strings are skipped rather than coerced, so an absent measurement stays absent.
  // A top-level key always wins over a payload key of the same name.
  for (const [key, value] of [...fields.entries()]) {
    if (!value.startsWith("{")) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(value);
    } catch {
      continue; // malformed payload is not evidence; never guessed at
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    for (const [innerKey, innerValue] of Object.entries(payload as Record<string, unknown>)) {
      if (fields.has(innerKey)) continue;
      if (typeof innerValue === "number" && Number.isFinite(innerValue)) {
        fields.set(innerKey, String(innerValue));
      } else if (innerKey === "score_state_performance_json" && typeof innerValue === "string") {
        // The one nested JSON-string leaf this parser looks inside (see the dedicated
        // decode step below); explicitly NOT a general "copy every string leaf" rule --
        // that would let an unrelated payload string masquerade as a numeric field
        // elsewhere in this map. Named narrowly, on purpose.
        fields.set(innerKey, innerValue);
      }
    }
    void key;
  }

  // Phase 13.5 finding: metric 016's score_state_performance_json is a JSON *string*
  // nested one level inside the already-merged payload (the merge loop above only
  // flattens numeric leaves, so a string-valued leaf -- this one -- is left untouched).
  // Blindly flattening every score-state key would manufacture dozens of paper-thin
  // per-state samples (many states have n=1 or n=2 in the live data); only "Break Point"
  // is extracted here -- it is present in 58/58 live usable rows (median n=9.5), it is
  // one of the states the metric's own definition names explicitly, and its own "n"
  // travels with it into a real field so INSUFFICIENT_SAMPLE still applies per row.
  const scoreStateRaw = fields.get("score_state_performance_json");
  if (scoreStateRaw && scoreStateRaw.startsWith("{")) {
    try {
      const states = JSON.parse(scoreStateRaw) as unknown;
      if (states && typeof states === "object" && !Array.isArray(states)) {
        const breakPoint = (states as Record<string, unknown>)["Break Point"];
        if (breakPoint && typeof breakPoint === "object") {
          const { n, win_pct } = breakPoint as Record<string, unknown>;
          if (typeof n === "number" && Number.isFinite(n) && !fields.has("score_state_break_point_n")) fields.set("score_state_break_point_n", String(n));
          if (typeof win_pct === "number" && Number.isFinite(win_pct) && !fields.has("score_state_break_point_win_pct")) fields.set("score_state_break_point_win_pct", String(win_pct));
        }
      }
    } catch {
      // malformed nested payload is not evidence; never guessed at
    }
  }

  // Phase 13.5 finding: metric 068's DOMINANT persisted shape (162/163 live usable rows;
  // historical-results-recovery.ts) encodes the current streak as a letter+magnitude
  // string ("current_streak=W12" / "L3"), not a number. A separate, much rarer producer
  // path (predixsport-recent.server.ts / tennis-data-extended.server.ts; 1/163 live rows)
  // already persists the identical real-world quantity -- signed streak length, positive
  // for an active win streak, negative for an active loss streak -- as a plain number
  // under the key "current_streak_signed". Decoding the letter form into that SAME key
  // (only when not already present, so a genuine top-level value always wins) makes both
  // producers' output comparable under one field name without a fabricated alias list:
  // this is one quantity encoded two ways, not two different quantities that merely sound
  // alike (the 008/010 trap Phase 12 documented).
  const currentStreakRaw = fields.get("current_streak");
  if (currentStreakRaw && !fields.has("current_streak_signed")) {
    const m = /^([WL])(\d+)$/i.exec(currentStreakRaw.trim());
    if (m) {
      const sign = m[1].toUpperCase() === "W" ? 1 : -1;
      fields.set("current_streak_signed", String(sign * Number(m[2])));
    }
  }

  const bare = Number(text);
  return { scalar: Number.isFinite(bare) && text !== "" ? bare : null, fields };
}

/** "NA"/""/non-numeric all yield null -- never 0. */
function numeric(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "NA" || trimmed.toUpperCase() === "NULL") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** First declared name (canonical, then aliases) that carries a numeric value. */
function lookup(parsed: ParsedMetricValue, field: string, aliases: string[] | undefined): number | null {
  for (const name of [field, ...(aliases ?? [])]) {
    const value = numeric(parsed.fields.get(name));
    if (value !== null) return value;
  }
  return null;
}

function extract(spec: ComparisonSpec, parsed: ParsedMetricValue): number | null {
  if (spec.field === null) return parsed.scalar;
  const primary = lookup(parsed, spec.field, spec.fieldAliases) ?? (spec.bareScalarFallback ? parsed.scalar : null);
  if (primary === null) return null;
  if (!spec.minusField) return primary;
  const secondary = lookup(parsed, spec.minusField, undefined);
  if (secondary === null) return null;
  return primary - secondary;
}

export interface MetricComparison {
  metric_code: string;
  label: string | null;
  family: string | null;
  status: ComparisonStatus;
  favours: ComparisonFavours;
  p1_number: number | null;
  p2_number: number | null;
  /** Always oriented as (P1 - P2) in the metric's own units, regardless of direction. */
  differential: number | null;
  /** Positive means "better for P1" after applying direction; sign is decision-facing. */
  advantage_p1: number | null;
  direction: ComparisonDirection | null;
  reason: string;
}

export interface MetricRowForComparison {
  metric_code: string;
  p1_value?: string | null;
  p2_value?: string | null;
  p1_treatment?: string | null;
  p2_treatment?: string | null;
}

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}

/**
 * Compares one persisted metric row. Pure: no DB, no network, no AI. Never throws, and
 * never returns a P1/P2 lean unless BOTH sides carried usable, parseable evidence.
 */
export function compareMetricRow(row: MetricRowForComparison): MetricComparison {
  const code = codeOf(row.metric_code);
  const spec = COMPARISON_SPECS[code];
  const base = { metric_code: code, label: spec?.label ?? null, family: spec?.family ?? null, p1_number: null, p2_number: null, differential: null, advantage_p1: null, direction: spec?.direction ?? null };

  if (!spec) {
    return { ...base, status: "NO_COMPARISON_SPEC", favours: "UNAVAILABLE", reason: `No declared comparable field/direction for metric ${code}; excluded from the decision rather than guessed.` };
  }
  const p1Usable = USABLE_TREATMENTS.has(String(row.p1_treatment ?? ""));
  const p2Usable = USABLE_TREATMENTS.has(String(row.p2_treatment ?? ""));
  if (!p1Usable || !p2Usable) {
    // Explicitly NOT a lean for whichever side happens to be usable.
    return { ...base, status: "TREATMENT_NOT_USABLE", favours: "UNAVAILABLE", reason: `Treatment not usable on ${!p1Usable && !p2Usable ? "both sides" : !p1Usable ? "P1" : "P2"} (p1=${row.p1_treatment ?? "none"}, p2=${row.p2_treatment ?? "none"}); no comparison made and no side credited.` };
  }

  const p1Number = extract(spec, parseMetricValue(row.p1_value));
  const p2Number = extract(spec, parseMetricValue(row.p2_value));
  if (p1Number === null && p2Number === null) {
    return { ...base, status: "VALUE_NOT_PARSEABLE", favours: "UNAVAILABLE", reason: `Neither side carried a parseable "${spec.field ?? "scalar"}" value; treated as UNAVAILABLE, never as zero.` };
  }
  if (p1Number === null || p2Number === null) {
    return { ...base, p1_number: p1Number, p2_number: p2Number, status: "ONE_SIDED_EVIDENCE", favours: "UNAVAILABLE", reason: `Only ${p1Number === null ? "P2" : "P1"} carried a parseable "${spec.field ?? "scalar"}" value. One-sided evidence is never a lean for the side that happens to have it.` };
  }

  if (spec.sampleField && spec.minSample !== undefined) {
    const p1Sample = lookup(parseMetricValue(row.p1_value), spec.sampleField[0], spec.sampleField.slice(1));
    const p2Sample = lookup(parseMetricValue(row.p2_value), spec.sampleField[0], spec.sampleField.slice(1));
    if (p1Sample === null || p2Sample === null || p1Sample < spec.minSample || p2Sample < spec.minSample) {
      const describe = (n: number | null) => (n === null ? "not persisted" : String(n));
      return {
        ...base, p1_number: p1Number, p2_number: p2Number, status: "INSUFFICIENT_SAMPLE", favours: "UNAVAILABLE",
        reason: `"${spec.label}" needs at least ${spec.minSample} ${spec.sampleField[0]} on both sides; P1 has ${describe(p1Sample)} and P2 has ${describe(p2Sample)}. A gap measured over too few attempts is noise, so neither side is credited.`,
      };
    }
  }

  const differential = Number((p1Number - p2Number).toFixed(6));
  const advantageP1 = Number((spec.direction === "HIGHER_IS_BETTER" ? differential : -differential).toFixed(6));
  const favours: ComparisonFavours = Math.abs(differential) <= spec.materiality ? "NEUTRAL" : advantageP1 > 0 ? "P1" : "P2";
  return {
    ...base,
    p1_number: p1Number,
    p2_number: p2Number,
    differential,
    advantage_p1: advantageP1,
    status: "COMPARED",
    favours,
    reason: favours === "NEUTRAL"
      ? `P1 ${p1Number} vs P2 ${p2Number} (${spec.label}); |difference| ${Math.abs(differential)} is within the ${spec.materiality} materiality threshold, so neither side is credited.`
      : `P1 ${p1Number} vs P2 ${p2Number} (${spec.label}, ${spec.direction}); favours ${favours}.`,
  };
}

export function compareMetricRows(rows: MetricRowForComparison[]): MetricComparison[] {
  return rows.map(compareMetricRow);
}
