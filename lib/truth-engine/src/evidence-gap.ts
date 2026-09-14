export type RecoveryClass = "RECONSTRUCTABLE" | "SOURCE_REQUIRED" | "SPECIALIZED_DATA" | "PUBLIC_CONTEXT" | "META_DERIVED";

export interface EvidenceRequirement {
  code: string;
  name: string;
  requiredData: string;
  recovery: RecoveryClass;
}

const rows: Array<[string,string,string,RecoveryClass]> = [
["001","Surface Strength","surface-specific results, Elo/rating history, surface sample","RECONSTRUCTABLE"],
["002","Serve Profile","service games/points, first/second serve, aces, double faults, break points saved","SOURCE_REQUIRED"],
["003","Return Profile","return points, first/second-serve return, breaks and break chances","SOURCE_REQUIRED"],
["004","Combined Efficiency","serve/return point rates, hold/break rates, dominance and matchup-specific expected hold/break inputs","RECONSTRUCTABLE"],
["005","Recent Form","last-5/last-10 results, set results, current-surface swing, opponent quality and chronological trend","RECONSTRUCTABLE"],
["006","Opponent-Adjusted Strength of Schedule","recent opponent strength, comparable-strength results, bad-loss rate and common-opponent quality","RECONSTRUCTABLE"],
["007","Common-Opponent Network","shared opponents, dates, surfaces, levels, score/results and opponent strength","RECONSTRUCTABLE"],
["008","Set Profile","set-by-set scores and match results","RECONSTRUCTABLE"],
["009","Comeback/Pressure Behavior","set sequence, tiebreaks and game/break-point histories","SOURCE_REQUIRED"],
["010","Straight-Set / 2–0 Metrics","set scores, opponent quality and simulation inputs","RECONSTRUCTABLE"],
["011","Volatility/Floor","match-level performance history, Elo/form variance, deciding-set/tiebreak reliance","RECONSTRUCTABLE"],
["012","Fatigue/Workload","recent match dates, sets/games/minutes, qualifying, rest and travel","PUBLIC_CONTEXT"],
["013","Availability","injury, withdrawal, retirement, medical-timeout and layoff history","PUBLIC_CONTEXT"],
["014","Ranking Context","current/historical rankings and underlying performance history","PUBLIC_CONTEXT"],
["015","Market Layer","multi-book prices, opening/current/closing odds, no-vig and prediction markets","SOURCE_REQUIRED"],
["016","Point-by-Point & Score-State Metrics","point-by-point logs with score state and serve/return context","SPECIALIZED_DATA"],
["017","Shot & Rally Metrics","charted shots, rally length, direction, winners/errors, net and court position","SPECIALIZED_DATA"],
["018","Momentum & Closing Metrics","break/set/tiebreak sequence and lead/closing histories","SOURCE_REQUIRED"],
["019","Market Calibration","historical player prices and outcomes by implied-probability bucket","SOURCE_REQUIRED"],
["020","Level/Tour Transition","event-level history, opponent Elo gap and previous tournament trajectory","RECONSTRUCTABLE"],
["021","Surface & Environmental Context","surface transitions, court speed, altitude, weather, schedule density and source agreement","PUBLIC_CONTEXT"],
["022","Serve/Return Shot-Level Efficiency","serve+1, return+1, rally state and charted shot outcomes","SPECIALIZED_DATA"],
["023","Matchup-Adjusted Metrics","serve/return splits plus opponent style, handedness and rally/shot compatibility","SOURCE_REQUIRED"],
["024","Hidden Performance Quality","point/game stats, expected-vs-actual conversion and shot-quality inputs","SPECIALIZED_DATA"],
["025","Match Deterioration Metrics","set-by-set serve/return/point/physical trends","SPECIALIZED_DATA"],
["026","Early-Warning / Slow-Start Metrics","opening-game point/game sequence and early serve/return statistics","SPECIALIZED_DATA"],
["027","Opponent Finishing Ability","opponent set/break lead histories and opponent serving-for-match outcomes","RECONSTRUCTABLE"],
["028","Scheduling/Context","rest, recent load, travel, previous finish time, qualifying and round history","PUBLIC_CONTEXT"],
["029","Psychological/Behavioral Proxies","score-state event sequences, pressure errors and closing/recovery histories","SPECIALIZED_DATA"],
["030","Tournament-Specific Strength","exact-event history, venue/court-speed context and tournament-specific results","RECONSTRUCTABLE"],
["031","Extended Opponent-Network Metrics","shared-opponent network, rankings/Elo, scores, games/sets and opponent strength","RECONSTRUCTABLE"],
["032","Point-to-Game Conversion Efficiency","service/return points, games, breaks and deuce/score-state data","SOURCE_REQUIRED"],
["033","Break Quality Differential","break-point sequence plus return pressure and opponent-error detail","SPECIALIZED_DATA"],
["034","Scoreline Deception Index","final scoreline, total points won, expected-games model inputs/output, break opportunities, master Dominance Ratio inputs/output, and point-by-point score-state evidence for clutch dependency","SPECIALIZED_DATA"],
["035","False-Form Detector","observed results plus expected performance from underlying statistics","RECONSTRUCTABLE"],
["036","Loss Autopsy Metrics","chronological recent losses with pre-match favorite status, opponent quality, surface, point and break differentials, within-match serve/return deterioration, lead state, set-1/deciding-set/tiebreak state, verified physical context, match duration and competitiveness inputs for bad-loss severity","SPECIALIZED_DATA"],
["037","Win Autopsy Metrics","recent win scores, opponent quality, dominance and retirement context","RECONSTRUCTABLE"],
["038","Opponent-Adjusted Residual Performance","match-level hold, break, total-points, games, sets, Dominance Ratio, serve-points and return-points performance plus correctly oriented opponent-specific comparison cohorts/norms","SOURCE_REQUIRED"],
["039","Performance Surprise Rating","chronological match-level actual underlying performance plus a reproducible pre-match expected-performance value frozen before each match; last-10 rolling surprise uses only those match-level residuals","RECONSTRUCTABLE"],
["040","Hidden Decline Detector","chronological serve velocity, ace rate, first/second-serve points won, return points won, break opportunities, service-game danger-score/hold-vulnerability, double-fault rate, match duration and three-set dependency histories","SPECIALIZED_DATA"],
["041","Hidden Improvement Detector","chronological opponent-quality-adjusted win/loss record trend plus chronological hold rate, return points won, Dominance Ratio, and break-points-created trends, including losses, in comparable evidence windows","SOURCE_REQUIRED"],
["042","Opponent Win Pathways","completed independent serve/return/form/physical/style evidence families","META_DERIVED"],
["043","Favorite Failure-Mode Score","favorite-role historical losses with pre-match favorite designation, the exact failure conditions observed in those losses (including serve/return and set-state conditions), and today's opponent's sourced ability to reproduce those same conditions","SOURCE_REQUIRED"],
["044","Opponent Upset Compatibility","historical matches where the player was the underdog, verified upset outcomes, and similarity features for today's favorite across Elo, serve style, return quality, surface, ranking, handedness, rally style, price, and tournament level","SOURCE_REQUIRED"],
["045","Favorite Fragility Under Resistance","favorite-role chronological game/score-state histories covering opponent holding the first three service games, missed early break chances, favorite being broken first, first set reaching 4-4, first-set tiebreaks, and the opponent forcing a deciding set","SPECIALIZED_DATA"],
["046","Match-State Elo","chronological results and Elo-style update inputs conditioned separately on winning set 1, losing set 1, deciding-set play, tiebreak-heavy matches, big-server opponents, and strong-returner opponents, with reproducible archetype thresholds","RECONSTRUCTABLE"],
["047","Uncertainty-Adjusted Advantage","metric estimates, samples and confidence/uncertainty model","META_DERIVED"],
["048","Independent-Evidence Count","persisted independent evidence families and overlap/correlation context","META_DERIVED"],
["049","Data Contamination / Circularity Score","source lineage and correlation/overlap metadata","META_DERIVED"],
["050","Robustness Tests","independent model inputs and perturbation rules","META_DERIVED"],
["051","Opponent-Specific Set/Match Probabilities","opponent-specific serve/return expectations plus set/match model","META_DERIVED"],
["052","Entropy & Lead Durability","set/game probability distribution plus break/rebreak/lead histories","SOURCE_REQUIRED"],
["053","Pressure & Clean-Game Metrics","game score sequences including 30-all, deuce and break points","SPECIALIZED_DATA"],
["054","Additional Shot-Level Efficiency","charted rally/shot direction, position and attack/defense outcomes","SPECIALIZED_DATA"],
["055","Trajectory / Rolling Metrics","chronological Elo, hold/break, serve/return, opponent-quality and result history","RECONSTRUCTABLE"],
["056","Data-Integrity Layer","sample sizes and source metadata for each metric","META_DERIVED"],
["057","Evidence Freshness & Confirmation","source timestamps, reliability, sample, surface relevance and family independence","META_DERIVED"],
["058","Stress Tests & Scenario Analysis","completed independent inputs and scenario perturbation rules","META_DERIVED"],
["059","Loss Path Probability","completed independent model inputs and pathway model","META_DERIVED"],
["060","Interaction / Matchup Residuals","serve/return matchup plus point/shot, handedness, pressure and environmental histories","SOURCE_REQUIRED"],
["061","Final Advanced Tests","independent inputs, removal tests and historical comparable-match database","META_DERIVED"],
["062","Motivation / Stakes","ranking points defended, seeding implications and public milestone context","PUBLIC_CONTEXT"],
["063","Team / Support Context","verified coaching, coaching-box and equipment-change reporting","PUBLIC_CONTEXT"],
["064","Draw Context","official draw, entry route, qualifying/lucky-loser status and next-round path","PUBLIC_CONTEXT"],
["065","Physical/Medical (Limited Availability)","credible illness, fitness and return-to-play reporting","PUBLIC_CONTEXT"],
["066","Equipment / Technical","verified racket/string/shoe changes and conditions","PUBLIC_CONTEXT"],
["067","On-Court Behavior / Discipline","code violations, challenge data, breaks and time-violation histories","SOURCE_REQUIRED"],
["068","Streaks / Milestones","chronological results, event appearances and protected-ranking status","RECONSTRUCTABLE"],
["069","Stakes / Career Context","verified retirement/farewell and anti-doping disruption reporting","PUBLIC_CONTEXT"],
["070","Support Team / Prep","verified mental-coach, late-entry and walkover context","PUBLIC_CONTEXT"],
["071","Session / Environment","official roof/session/start-time context","PUBLIC_CONTEXT"],
["072","Matchup Nuance","backhand type, height/reach and junior/ITF meeting history","PUBLIC_CONTEXT"],
["073","Sentiment / Integrity","public statements, social activity and exchange-volume integrity data","PUBLIC_CONTEXT"],
["074","Biomechanics / Physical Detail","charted biomechanics, movement asymmetry and verified equipment specs","SPECIALIZED_DATA"],
["075","Match Format / Rules Context","official event rules, best-of format and deciding-set rules","PUBLIC_CONTEXT"],
["076","Scheduling Micro-Context","official order of play, court assignment and documented practice access","PUBLIC_CONTEXT"],
["077","Season-Long Fatigue Context","season schedule, team events, off-season rest and previous-major workload","RECONSTRUCTABLE"],
["078","Sponsorship / Off-Court Pressure","credible reporting of home-market commercial appearances, sponsor obligations or media obligations during the tournament week, with timing sufficient to establish recovery/preparation impact","PUBLIC_CONTEXT"],
["079","Additional Differentiating Metrics","exact game/point/event logs for coaching visits, post-coaching games, shot-clock violations by set, racket changes, hydration/medical breaks, first point/game, changeovers, odd/even serve games, return position and serve patterns; plus official schedule/entry/walkover/altitude/surface-switch records and credible disciplinary, coach-history or scouting-report evidence for the named submetrics","SOURCE_REQUIRED"],
["080","Common-Opponent & Opponent-Caliber Metrics","shared-opponent results plus opponent ranking/Elo quality","RECONSTRUCTABLE"],
["081","Further Differentiating Metrics","official schedule/result/event-history evidence for ceremonies, featured-court exposure, rain/overnight resumptions, opponent substitutions, weekday/weekend splits, consecutive-day play, prior withdrawals, electronic-line-calling exposure, major-week split and prior-year round; plus credible reporting for backstage conflict, training-base relocation, support-staff turnover, travel friction and home-climate context","PUBLIC_CONTEXT"],
];

export const EVIDENCE_REQUIREMENTS = Object.fromEntries(rows.map(([code,name,requiredData,recovery]) => [code,{code,name,requiredData,recovery}])) as Record<string,EvidenceRequirement>;

const usable = new Set(["DIRECT","RECONSTRUCTED","PARTIAL"]);

export interface GapSide {
  side: "P1" | "P2";
  treatment: string;
  status: string;
  value: unknown;
  reason: string | null;
  providerError: string | null;
}

export interface EvidenceGapItem {
  code: string;
  metricName: string;
  requiredData: string;
  recovery: RecoveryClass;
  side: "P1" | "P2";
  treatment: string;
  classification: "SUPPORTED" | "MAPPING_OR_PROVENANCE" | "RECONSTRUCTABLE" | "SOURCE_REQUIRED" | "SPECIALIZED_DATA" | "PUBLIC_CONTEXT" | "META_DERIVED";
  reason: string;
}

function normCode(value: unknown) {
  const m=String(value??"").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3,"0") : String(value??"").padStart(3,"0");
}

function sideOf(row:any, side:"P1"|"P2"): GapSide {
  const p=side==="P1"?"p1":"p2";
  return {
    side,
    treatment:String(row[`${p}_treatment`]??row[`${p}_status`]??"UNAVAILABLE"),
    status:String(row[`${p}_status`]??row.status??"NOT STARTED"),
    value:row[`${p}_value`],
    reason:(row[`${p}_unavailable_reason`]??row.unavailable_reason??null) as string|null,
    providerError:(row[`${p}_provider_error`]??row.provider_error??null) as string|null,
  };
}

export function buildEvidenceGap(metrics:any[]): EvidenceGapItem[] {
  const out:EvidenceGapItem[]=[];
  for(const row of metrics){
    const code=normCode(row.metric_code);
    const req=EVIDENCE_REQUIREMENTS[code]??{code,name:String(row.metric_name??code),requiredData:"metric-specific source inputs",recovery:"SOURCE_REQUIRED" as RecoveryClass};
    for(const side of ["P1","P2"] as const){
      const s=sideOf(row,side);
      if(usable.has(s.treatment) && s.value!==null && s.value!==undefined && s.value!==""){
        out.push({code,metricName:String(row.metric_name??req.name),requiredData:req.requiredData,recovery:req.recovery,side,treatment:s.treatment,classification:"SUPPORTED",reason:"Usable treatment and persisted value are present."});
        continue;
      }
      if(s.value!==null && s.value!==undefined && s.value!=="" && !usable.has(s.treatment)){
        out.push({code,metricName:String(row.metric_name??req.name),requiredData:req.requiredData,recovery:req.recovery,side,treatment:s.treatment,classification:"MAPPING_OR_PROVENANCE",reason:"A value is persisted but the side is not carrying a usable evidence treatment; inspect provenance/status wiring before researching new data."});
        continue;
      }
      const reason=[s.reason,s.providerError].filter(Boolean).join(" · ") || `Missing required data: ${req.requiredData}`;
      out.push({code,metricName:String(row.metric_name??req.name),requiredData:req.requiredData,recovery:req.recovery,side,treatment:s.treatment,classification:req.recovery,reason});
    }
  }
  return out;
}

export function evidenceGapSummary(items:EvidenceGapItem[]){
  const counts:Record<string,number>={};
  for(const item of items) counts[item.classification]=(counts[item.classification]??0)+1;
  const total=items.length;
  const supported=counts.SUPPORTED??0;
  return {total,supported,unsupported:total-supported,counts,supportedPercent:total?Math.round((supported/total)*1000)/10:0};
}