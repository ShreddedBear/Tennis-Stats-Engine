export type ObservationFamily =
  | "RESULTS_SCHEDULE"
  | "RANKING"
  | "MARKET"
  | "ENVIRONMENT"
  | "POINT_BY_POINT"
  | "RULES_CONTEXT";

export type MetricSourcePolicy = { metric_code:string; allowed_families:ObservationFamily[]; sufficient_families:ObservationFamily[]; support_only_families?:ObservationFamily[] };

// Task 13 source-family applicability, reconciled with Task 17 for Tasks 18A-18C, and
// again against the canonical registry in metric-classification.ts (Task 20/21).
// Applicability never awards coverage by itself; metric-specific recovery must
// still prove pair-complete raw evidence and preserve treatment.
//
// META_OR_NON_PLAYER and PROTECTED_UNAVAILABLE codes (see metric-classification.ts) are
// never given a family here -- there is nothing for RESULTS_SCHEDULE/RANKING/MARKET/
// ENVIRONMENT/POINT_BY_POINT/RULES_CONTEXT evidence to "satisfy" for them, since they
// either aren't player facts at all or have no admissible evidence source anywhere in
// this system.
// "047" and "061" RESOLVED (docs/audit-task-047-061-classification-decisions.md):
// both were previously UNKNOWN_REQUIRES_REVIEW and left with whatever family eligibility
// their genuinely-reconstructable sub-component already had before classification review.
// Both now have real, wired engines (audit-metric-047-uncertainty-adjusted-advantage.ts,
// audit-metric-061-historical-twin-match-search.ts), both built entirely from the same
// four-tour static history index every RESULTS_SCHEDULE-family module in this set already
// reads -- 047 added here (see MARKET_METRICS/RANKING_METRICS below for the pre-decision
// memberships this replaces); 061 was already a member and needs no change.
const RESULTS_SCHEDULE_METRICS=new Set(["001","002","003","005","006","007","008","009","010","011","012","013","018","020","021","022","023","024","025","026","027","028","029","030","031","034","035","036","037","038","041","043","044","045","046","047","049","050","051","052","053","054","055","056","058","061","064","068","071","076","077","080","081"]);
// "029" added: audit-metric-029-psychological-response-proxy.ts computes its close-set-
// loss-then-next-set/match win-rate response entirely from repository-results-
// history.server.ts's set_scores-bearing rows (the same RESULTS_SCHEDULE-level static
// four-tour history source #027's finishing-ability engine already reads and is already
// listed here for) -- not from any point-by-point/PBP source, so it belongs in this set,
// not PBP_METRICS. Previously had no family membership at all (an oversight from before
// the module was wired live -- see deterministic-batch4-favorite-underdog-patterns.server.ts's
// sibling wiring doc for the reconnection pattern this follows).
// "043"/"044" added: verified against evidence-gap.ts and public/seed/metrics.txt --
// 043 ("Favorite Failure-Mode Score") is keyed to what happened in the player's own
// past favorite-role LOSSES (pre-match favorite designation, set-state failure
// conditions) cross-referenced against the opponent's own past underdog-role WIN
// history -- both are chronological historical-match content, RESULTS_SCHEDULE-level
// data, computed by audit-metric-043-favorite-failure-mode.ts /
// audit-metric-044-opponent-upset-compatibility.ts (wired via
// deterministic-batch4-favorite-underdog-patterns.server.ts) from the same static
// four-tour history index #036/#046 already use. Deliberately NOT added to
// PBP_METRICS for the same reason #036 above stays out of it -- neither module reads
// the generic warehouse-level PBP path.
// "036" ("Loss Autopsy Metrics") added: verified against public/seed/metrics.txt --
// every bullet is keyed to what happened in specific past *losses* (favorite status,
// opponent quality, surface, point/break differential, physical problem, match length),
// which is RESULTS_SCHEDULE-level historical-match data. (It is deliberately NOT also
// added to PBP_METRICS -- see the note there.)
// "059" ("Loss Path Probability") removed: it is META_OR_NON_PLAYER (see
// metric-classification.ts) -- every bullet is framed around why "the pick" loses, not
// a player fact, so it must never receive ANY family eligibility.
// "069" ("Stakes / Career Context" -- retirement-tour/farewell-run effects, anti-doping
// testing disruption) was previously listed here and in PBP_METRICS, inherited from a
// pre-Task-17 catalog that assigned code 069 to a different, ranking/PBP-appropriate
// metric ("Dominance Ratio"). Neither ranking observations nor PBP can legitimately
// establish this metric's actual subject matter -- it requires genuine public
// retirement/anti-doping reporting, which protected-metric-wiring.server.ts already
// requires and validates for it (NON_RECONSTRUCTABLE_CONTEXT_CODES), and which
// metric-classification.ts now classifies PROTECTED_UNAVAILABLE. Removed per the
// Task 20 reconciliation; see metric-source-family-policy.test.ts.
// "047" removed: pre-decision placeholder membership (see the RESULTS_SCHEDULE_METRICS
// note above) -- 047's real engine (audit-metric-047-uncertainty-adjusted-advantage.ts)
// reads only the four-tour static history index (via metric #027's finishing-ability
// engine), never a ranking snapshot.
const RANKING_METRICS=new Set(["013","014","020","023","038","055","058","062","068","080"]);
// "039" and "057" removed from MARKET: verified against public/seed/metrics.txt --
// 039 ("Performance Surprise Rating") compares actual performance to a pre-match
// *expected* performance baseline (Elo/form-derived), never a market price; 057
// ("Evidence Freshness & Confirmation") is META_OR_NON_PLAYER and must never receive
// ANY family eligibility, market or otherwise. Neither bullet in either code's real
// definition names odds, implied probability, or any market-derived quantity.
// "047" removed for the same reason as the RANKING_METRICS note above: its real engine
// never reads a market/odds observation.
const MARKET_METRICS=new Set(["015","019","043","044","073"]);
// "021" ("Surface & Environmental Context") was previously excluded here under a
// pre-Task-17 assumption that code 021 was "Elo Delta" (a chronological-results metric
// that weather would only contaminate). The real definition explicitly names weather
// sensitivity and altitude as in-scope components, and deterministic-environment-metrics.server.ts
// already computes and targets this exact code — it was simply never allowed through this
// policy. RESULTS_SCHEDULE remains the only *sufficient* family for 021 (see below); this
// only makes ENVIRONMENT support-only, so it can enrich but never single-handedly promote a 021
// finding to DIRECT/RECONSTRUCTED. See metric-classification.ts and
// metric-source-family-policy.test.ts.
const ENVIRONMENT_METRICS=new Set(["001","021","030","060","071","075"]);
// "026"/"027"/"036"/"038"/"039"/"040"(UPDATE below)/"059"/"079" were previously listed here, inherited
// from the same pre-Task-17 catalog drift as code 069 above. Their real definitions are,
// respectively: 026 "Early-Warning / Slow-Start Metrics" -- UPDATE (docs/audit-task-026-034-053.md):
// 026 now HAS a real, dedicated engine (deriveOpeningWindowProfile's first-N-games-scoped
// replay in pbp-score-state-recovery.ts, plus audit-metric-026-early-warning-slow-start.ts's
// cross-match slow-start-recovery aggregation, wired via deterministic-batch3-early-warning.
// server.ts) -- the prior "does not yet build" note is stale and corrected here. 026 still
// deliberately stays OUT of this PBP_METRICS set, though, for a narrower reason than before:
// that dedicated engine is reached through its own wired tier in warehouse-first-
// researcher.server.ts, never through the generic warehouse-level PBP path this set gates
// (deterministicPbpMetric in deterministic-pbp-metrics.server.ts, which only ever produces a
// generic "some point-by-point observations exist" summary from persisted rows, with nothing
// opening-game-specific in it) -- listing 026 here would let that unrelated generic path
// award false PARTIAL credit toward a metric it cannot actually inform, exactly the failure
// mode this comment already warns about for the other codes below. 027 "Opponent Finishing
// Ability" and 036 "Loss Autopsy Metrics"
// (both keyed off historical match *results*, e.g. lead protection, favorite status,
// loss surface -- RESULTS_SCHEDULE territory, not point chronology), 038
// "Opponent-Adjusted Residual Performance" (needs cross-player population norms), 039
// "Performance Surprise Rating" (needs a pre-match expectation/model output, not point
// data), 059 "Loss Path Probability" (META_OR_NON_PLAYER -- gets no family
// at all), and 079 "Additional Differentiating Metrics" (coaching-visit and shot-clock
// events -- not point-by-point score state). pbp-score-state-recovery.ts already does
// not target any of these (see its TASK18B_METRIC_CODES comment); leaving them here
// would let the generic warehouse-level PBP path (deterministicPbpMetric) award false
// PARTIAL credit toward metrics PBP evidence cannot actually inform. See
// metric-classification.ts and metric-source-family-policy.test.ts.
//
// UPDATE (docs/audit-task-038-040-062.md): "040" IS now added below, unlike the codes
// above it in this comment. The reasoning that kept it out ("single-match PBP cannot
// supply a cross-match trend") is still true of the generic warehouse-level PBP path this
// set gates -- that reasoning never changes here, same as 026's own correction above -- but
// audit-metric-040-hidden-decline-detector.ts now supplies exactly that missing cross-match
// trend through its OWN dedicated tier (deterministic-batch6-residual-decline-stakes.
// server.ts), never through this generic path. "040" is added to PBP_METRICS purely so
// `policyForMetric("040").allowed_families` correctly reports POINT_BY_POINT as a real
// eligible family for this metric (it IS one, now) -- metricAllowsObservation/family-policy
// checks elsewhere in the pipeline would otherwise incorrectly treat 040 as having no
// eligible family at all, even though its dedicated tier does not itself consult this
// function. Serve velocity remains entirely absent from every source in this repository and
// stays excluded from the metric's own output regardless of this family-eligibility change.
const PBP_METRICS=new Set(["002","003","004","008","009","010","011","016","018","022","024","025","031","032","033","034","037","040","041","042","043","044","045","046","051","052","053","054","060","070","071"]);
const RULES_METRICS=new Set(["020","064","075","076"]);

function codeOf(value:unknown){const m=String(value??"").match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(value??"").padStart(3,"0");}
export function policyForMetric(metricCode:unknown):MetricSourcePolicy{
 const code=codeOf(metricCode),allowed=new Set<ObservationFamily>(),sufficient=new Set<ObservationFamily>(),supportOnly=new Set<ObservationFamily>();
 if(RESULTS_SCHEDULE_METRICS.has(code))allowed.add("RESULTS_SCHEDULE");if(RANKING_METRICS.has(code))allowed.add("RANKING");if(MARKET_METRICS.has(code))allowed.add("MARKET");if(ENVIRONMENT_METRICS.has(code))allowed.add("ENVIRONMENT");if(PBP_METRICS.has(code))allowed.add("POINT_BY_POINT");if(RULES_METRICS.has(code))allowed.add("RULES_CONTEXT");
 if(["015","019"].includes(code))sufficient.add("MARKET");if(code==="021")sufficient.add("RESULTS_SCHEDULE");if(["014","062"].includes(code))sufficient.add("RANKING");
 for(const family of allowed)if(!sufficient.has(family))supportOnly.add(family);
 return{metric_code:code,allowed_families:[...allowed],sufficient_families:[...sufficient],support_only_families:[...supportOnly]};
}
export function observationFamily(row:{source_id?:string|null;observation_type?:string|null;observation_key?:string|null}):ObservationFamily|null{
 const source=String(row.source_id??"").toLowerCase(),type=String(row.observation_type??"").toUpperCase(),key=String(row.observation_key??"").toLowerCase();
 const resultSources=new Set(["atp","wta","atp_challenger","wta_challenger","wta_125","tennisdata_wta_challenger","production_wta_125"]);
 if(resultSources.has(source)&&["MATCH_RESULT_OR_SCHEDULE","TOURNAMENT_SCHEDULE"].includes(type))return"RESULTS_SCHEDULE";
 if(type==="RANKING"||key.includes("ranking")||key.includes("rank_points"))return"RANKING";
 if(source==="odds_api"||type==="MARKET"||key.includes("decimal_odds"))return"MARKET";
 if(source==="open_meteo"||type==="ENVIRONMENT")return"ENVIRONMENT";
 if(type==="POINT_BY_POINT"||type==="PBP")return"POINT_BY_POINT";
 if(type==="RULES"||type==="RULES_CONTEXT")return"RULES_CONTEXT";
 return null;
}
export function assertObservationFamily(row:{source_id?:string|null;observation_type?:string|null;observation_key?:string|null},expected:ObservationFamily){const actual=observationFamily(row);if(actual!==expected)throw new Error(`Observation family mismatch: expected ${expected}, got ${actual??"UNKNOWN"}`);return row;}
export function metricAllowsObservation(metricCode:unknown,row:{source_id?:string|null;observation_type?:string|null;observation_key?:string|null}){const family=observationFamily(row);return Boolean(family&&policyForMetric(metricCode).allowed_families.includes(family));}
