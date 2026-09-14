import type { IdentityFinding, MetricFinding, Researcher } from "./audit-pipeline";
import { completionSweepResearcher } from "./completion-sweep-research.server";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";

function norm(v:string|null|undefined){return String(v??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function tokens(v:string){return norm(v).split(" ").filter(Boolean);}
function runtimePlayers():Array<{name:string;tour:"ATP"|"WTA"}>{
  const out:Array<{name:string;tour:"ATP"|"WTA"}>=[];
  const runtimeIndex=loadRuntimeIndex();
  for(const tour of ["ATP","WTA"] as const){const rows=(runtimeIndex as any)?.[tour]??{};for(const value of Object.values(rows) as any[]){if(value?.name)out.push({name:String(value.name),tour});}}
  return out;
}
function resolveRuntimePlayer(input:string){const all=runtimePlayers(),needle=norm(input),exact=all.filter(x=>norm(x.name)===needle);if(exact.length===1)return exact[0];const req=tokens(input),last=req.at(-1);if(!last)return null;const candidates=all.filter(x=>{const t=tokens(x.name);if(t.at(-1)!==last)return false;const set=new Set(t);return req.length===1||req.every(v=>set.has(v));});return candidates.length===1?candidates[0]:null;}

const groups={
  serve:["service_points_won","first_serve","second_serve","ace_rate","double_fault","break_points_saved","hold_pct","service_games_held"],
  ret:["return_points_won","serve_return","break_point_conversion","break_pct","return_games","break_points_created"],
  market:["market","odds","price","implied","devig","de_vig","vig","favorite_probability","underdog_probability"],
  availability:["availability","injury","withdraw","retire","medical","layoff","days_since_last_match","return_after_layoff"],
  point:["point","game","break_state","score_state","first_break","rebreak","consolidation","serve_out","tiebreak"],
  rally:["rally","shot","forehand","backhand","net","drop_shot","direction","serve_plus_1","return_neutralization"],
  level:["same_level","tour_level","level_transition","challenger","itf","atp","wta"],
  environment:["surface","court_speed","indoor","outdoor","temperature","humidity","wind","altitude","roof","weather"],
  scheduling:["days_since_last_match","matches_last_14","matches_last_28","rest","travel","timezone","same_round","round","qualifying","recovery"],
  tournament:["same_tournament","tournament_specific","court_speed","venue","environment"],
};
function containsAny(value:string|null,terms:string[]){const v=norm(value??"");return terms.some(t=>v.includes(norm(t)));}
function semanticRequirement(name:string,body:string|null):keyof typeof groups|null{
  const t=norm(`${name} ${body??""}`);
  if(/market layer|market calibration|odds|implied probability|de vig|devig/.test(t))return"market";
  if(/serve profile|serve efficiency|serve\/return shot level/.test(t))return"serve";
  if(/return profile/.test(t))return"ret";
  if(/availability|injury|withdrawal|fitness/.test(t))return"availability";
  if(/point by point|score state|point to game/.test(t))return"point";
  if(/shot|rally/.test(t))return"rally";
  if(/level\/tour transition|tour-level transition|opponent elo differential/.test(t))return"level";
  if(/surface & environmental context|surface-transition|altitude|court-speed|weather sensitivity|data-source agreement/.test(t))return"environment";
  if(/scheduling\/context|days since last|travel-to-rest|recovery hours|schedule density|qualifier adaptation/.test(t))return"scheduling";
  if(/tournament-specific strength|exact tournament|venue familiarity/.test(t))return"tournament";
  return null;
}
function validSide(value:string|null,required:keyof typeof groups|null){if(!value)return false;if(!required)return true;return containsAny(value,groups[required]);}

const PROTECTED_EXACT_METRICS=new Set(["026","029","031","032","033","051","052","053","054","059"]);
const COMPOSITE_COMPONENTS:Record<string,Array<{name:string;terms:string[]}>>={
  "026":[
    {name:"opening service-game hold",terms:["opening service game hold","first service game hold"]},
    {name:"opening return-game break",terms:["opening return game break","first return game break"]},
    {name:"first four games win differential",terms:["first four games win differential","first 4 games win differential"]},
    {name:"first six games point differential",terms:["first six games point differential","first 6 games point differential"]},
    {name:"early break-conceded frequency",terms:["early break conceded frequency","broken within first","early break conceded"]},
    {name:"time-to-first-break",terms:["time to first break","time-to-first-break"]},
    {name:"set-1 slow-start index",terms:["set 1 slow start index","set-1 slow-start index","slow start index"]},
    {name:"first-set recovery after early break",terms:["first set recovery after early break","recovery after early break"]},
    {name:"early-error rate",terms:["early error rate","opening unforced error rate"]},
    {name:"early first-serve efficiency",terms:["early first serve efficiency","opening first serve efficiency"]},
    {name:"early return pressure",terms:["early return pressure","opening return pressure"]},
    {name:"warm-up dependency index",terms:["warm up dependency index","warm-up dependency index"]},
  ],
  "029":[
    {name:"response after losing a close set",terms:["response after losing a close set","after losing a close set"]},
    {name:"response after blowing set points",terms:["response after blowing set points","after blowing set points","failed set points"]},
    {name:"response after failing to serve out a set",terms:["response after failing to serve out a set","failed to serve out a set"]},
    {name:"response after losing a tiebreak",terms:["response after losing a tiebreak","after losing a tiebreak"]},
    {name:"performance after saving match points",terms:["after saving match points","performance immediately after saving match points"]},
    {name:"performance after wasting match points",terms:["after wasting match points","performance immediately after wasting match points"]},
    {name:"consecutive-error recovery",terms:["consecutive error recovery","consecutive-error recovery"]},
    {name:"break-point resilience after previous BP loss",terms:["break point resilience after previous bp loss","after previous break point loss"]},
    {name:"pressure error differential",terms:["pressure error differential","unforced error rate under pressure"]},
    {name:"front-runner vs comeback profile",terms:["front runner vs comeback profile","front-runner vs comeback profile"]},
    {name:"scoreboard-pressure sensitivity",terms:["scoreboard pressure sensitivity","scoreboard-pressure sensitivity"]},
  ],
  "031":[
    {name:"common-opponent adjusted point differential",terms:["common opponent adjusted point differential","adjusted point differential against shared opponents"]},
    {name:"common-opponent hold differential",terms:["common opponent hold differential","hold differential against shared opponents"]},
    {name:"common-opponent break differential",terms:["common opponent break differential","break differential against shared opponents"]},
    {name:"common-opponent straight-set differential",terms:["common opponent straight set differential","straight set differential against shared opponents"]},
    {name:"common-opponent set-1 differential",terms:["common opponent set 1 differential","first set differential against shared opponents"]},
    {name:"common-opponent 30/60/90-day performance",terms:["common opponent performance within last 30","30 60 90","30/60/90"]},
    {name:"second-degree opponent network",terms:["second degree opponent network","opponents of the players common opponents"]},
    {name:"network Elo strength",terms:["network elo strength","opponent network elo"]},
    {name:"transitive performance score",terms:["transitive performance score"]},
    {name:"loss-quality score",terms:["loss quality score","loss-quality score"]},
    {name:"win-quality score",terms:["win quality score","win-quality score"]},
    {name:"upset-quality score",terms:["upset quality score","upset-quality score"]},
    {name:"bad-loss severity",terms:["bad loss severity","bad-loss severity"]},
    {name:"opponent-strength weighted game differential",terms:["opponent strength weighted game differential","weighted game differential"]},
  ],
  "032":[
    {name:"points-won to games-won conversion",terms:["points won to games won conversion","points-won games-won conversion","points won % games won %"]},
    {name:"return-points-won to break conversion efficiency",terms:["return points won to break conversion efficiency","return-points-won break conversion efficiency"]},
    {name:"service-points-won to hold conversion efficiency",terms:["service points won to hold conversion efficiency","service-points-won hold conversion efficiency"]},
    {name:"expected vs actual games won",terms:["expected vs actual games won"]},
    {name:"expected vs actual sets won",terms:["expected vs actual sets won"]},
    {name:"deuce-game win",terms:["deuce game win","deuce-game win"]},
    {name:"games won from 0-30/15-30",terms:["games won from 0 30","games won from 15 30","0-30/15-30"]},
    {name:"games lost from 30-0/40-15",terms:["games lost from 30 0","games lost from 40 15","30-0/40-15"]},
    {name:"break opportunities per successful break",terms:["break opportunities needed per successful break","break opportunities per successful break"]},
    {name:"hold efficiency relative to serve points",terms:["hold efficiency relative to underlying serve points","hold efficiency relative to serve points"]},
  ],
  "033":[
    {name:"sustainable break score",terms:["sustainable break score"]},
    {name:"sustained return pressure",terms:["sustained return pressure","return pressure"]},
    {name:"opponent donation detail",terms:["opponent donations","double faults","unforced errors"]},
  ],
  "034":[
    {name:"scoreline vs point dominance",terms:["scoreline vs point dominance","scoreline compared with point dominance","scoreline compared to point dominance"]},
    {name:"scoreline vs expected games",terms:["scoreline vs expected games","scoreline compared with expected games","scoreline compared to expected games"]},
    {name:"scoreline vs break opportunities",terms:["scoreline vs break opportunities","scoreline compared with break opportunities","scoreline compared to break opportunities"]},
    {name:"scoreline vs dominance ratio",terms:["scoreline vs dominance ratio","scoreline compared with dominance ratio","scoreline compared to dominance ratio"]},
    {name:"clutch-performance dependency",terms:["clutch performance dependency","clutch dependency","key point dependency","key points dependency"]},
  ],
  "036":[
    {name:"loss favorite status",terms:["loss favorite status","favorite status","pre match favorite","pre match odds"]},
    {name:"loss opponent quality",terms:["loss opponent quality","opponent quality","opponent elo","opponent ranking"]},
    {name:"loss surface",terms:["loss surface","surface"]},
    {name:"loss point differential",terms:["loss point differential","point differential","points won differential"]},
    {name:"loss break differential",terms:["loss break differential","break differential","break point differential"]},
    {name:"loss serve deterioration",terms:["loss serve deterioration","serve deterioration","serve decline"]},
    {name:"loss return deterioration",terms:["loss return deterioration","return deterioration","return decline"]},
    {name:"lost after leading",terms:["lost after leading","lead state","led then lost"]},
    {name:"lost set 1",terms:["lost set 1","lost first set","set 1 loss"]},
    {name:"loss in deciding set",terms:["loss in deciding set","deciding set","final set"]},
    {name:"loss in tiebreak",terms:["loss in tiebreak","tiebreak"]},
    {name:"loss physical problem",terms:["loss physical problem","physical problem","injury","medical timeout"]},
    {name:"loss match length",terms:["loss match length","match length","duration"]},
    {name:"competitive vs blowout loss",terms:["competitive vs blowout","competitive loss","blowout loss"]},
    {name:"bad-loss severity index",terms:["bad loss severity index","bad loss severity"]},
  ],
  "037":[
    {name:"recent scored wins",terms:["recent scored wins","prior scored wins"]},
    {name:"pre-match win probability",terms:["pre match win probability","frozen pre match win probability"]},
    {name:"final score margin",terms:["final score margin","close wins"]},
    {name:"win autopsy category",terms:["win autopsy category","dominant","routine","escape","upset win"]},
  ],
  "038":[
    {name:"hold residual vs opponent norm",terms:["hold residual vs opponent norm","hold residual versus opponent norm","hold compared to opponent norm"]},
    {name:"break residual vs opponent norm",terms:["break residual vs opponent norm","break residual versus opponent norm","break compared to opponent norm"]},
    {name:"total-points residual vs opponent norm",terms:["total points residual vs opponent norm","total points residual versus opponent norm","total points compared to opponent norm"]},
    {name:"games residual vs opponent norm",terms:["games residual vs opponent norm","games residual versus opponent norm","games compared to opponent norm"]},
    {name:"sets residual vs opponent norm",terms:["sets residual vs opponent norm","sets residual versus opponent norm","sets compared to opponent norm"]},
    {name:"dominance-ratio residual vs opponent norm",terms:["dominance ratio residual vs opponent norm","dominance ratio residual versus opponent norm","dominance ratio compared to opponent norm"]},
    {name:"serve-points residual vs opponent norm",terms:["serve points residual vs opponent norm","service points residual vs opponent norm","serve points compared to opponent norm"]},
    {name:"return-points residual vs opponent norm",terms:["return points residual vs opponent norm","return points residual versus opponent norm","return points compared to opponent norm"]},
  ],
  "039":[
    {name:"match-level actual performance",terms:["actual performance","match level performance"]},
    {name:"pre-match expected performance",terms:["pre match expected performance","frozen pre match expectation","expectation frozen before match"]},
    {name:"match-level surprise residual",terms:["performance surprise","actual minus expected","surprise residual"]},
    {name:"rolling last-10 surprise",terms:["rolling performance surprise","last 10 surprise","last ten surprise"]},
  ],
  "040":[
    {name:"serve velocity trend",terms:["serve velocity trend","serve speed trend"]},
    {name:"ace rate trend",terms:["ace rate trend"]},
    {name:"first-serve points won trend",terms:["first serve points won trend"]},
    {name:"second-serve points won trend",terms:["second serve points won trend"]},
    {name:"return points won trend",terms:["return points won trend"]},
    {name:"break opportunities trend",terms:["break opportunities trend","break points generated trend"]},
    {name:"hold vulnerability trend",terms:["hold vulnerability trend","danger score trend","service game danger"]},
    {name:"double-fault trend",terms:["double fault trend"]},
    {name:"match duration trend",terms:["match duration trend"]},
    {name:"three-set dependency trend",terms:["three set dependency trend","three set trend","go the distance"]},
  ],
  "051":[
    {name:"opponent-specific break expectancy",terms:["opponent specific break expectancy"]},
    {name:"opponent-specific hold expectancy",terms:["opponent specific hold expectancy"]},
    {name:"set win expectancy",terms:["set win expectancy"]},
    {name:"expected set-1 winner",terms:["expected set 1 winner","expected set-1 winner"]},
    {name:"expected deciding-set winner",terms:["expected deciding set winner","expected deciding-set winner"]},
    {name:"2-0 conditional probability",terms:["2 0 conditional probability","2-0 conditional probability"]},
    {name:"2-1 conditional probability",terms:["2 1 conditional probability","2-1 conditional probability"]},
    {name:"break-first to 2-0 conversion",terms:["break first to 2 0 conversion","break-first to 2-0 conversion"]},
    {name:"set-1 win to 2-0 conversion",terms:["set 1 win to 2 0 conversion","set-1 win to 2-0 conversion"]},
    {name:"set-1 loss to match-loss probability",terms:["set 1 loss to match loss probability","set-1 loss to match-loss probability"]},
  ],
  "052":[
    {name:"set-score entropy",terms:["set score entropy","set-score entropy"]},
    {name:"game-score entropy",terms:["game score entropy","game-score entropy"]},
    {name:"lead durability index",terms:["lead durability index"]},
    {name:"deficit survivability index",terms:["deficit survivability index"]},
    {name:"double-break creation rate",terms:["double break creation rate","double-break creation rate"]},
    {name:"double-break surrender rate",terms:["double break surrender rate","double-break surrender rate"]},
    {name:"rebreak-window probability",terms:["rebreak window probability","rebreak-window probability"]},
    {name:"break clustering",terms:["break clustering"]},
  ],
  "053":[
    {name:"pressure accumulation score",terms:["pressure accumulation score"]},
    {name:"serve escape dependency",terms:["serve escape dependency"]},
    {name:"clean-hold rate",terms:["clean hold rate","clean-hold rate"]},
    {name:"clean-break rate",terms:["clean break rate","clean-break rate"]},
    {name:"love/15 hold rate",terms:["love 15 hold rate","love/15 hold rate"]},
    {name:"return-game abandonment rate",terms:["return game abandonment rate","return-game abandonment rate"]},
  ],
  "054":[
    {name:"first-strike efficiency",terms:["first strike efficiency","first-strike efficiency"]},
    {name:"neutral-rally efficiency",terms:["neutral rally efficiency","neutral-rally efficiency"]},
    {name:"defense-to-offense conversion",terms:["defense to offense conversion","defense-to-offense conversion"]},
    {name:"attack conversion rate",terms:["attack conversion rate"]},
    {name:"depth-pressure differential",terms:["depth pressure differential","depth-pressure differential"]},
    {name:"baseline territory differential",terms:["baseline territory differential"]},
    {name:"directional vulnerability",terms:["directional vulnerability"]},
    {name:"backhand-under-pressure performance",terms:["backhand under pressure performance","backhand-under-pressure performance"]},
    {name:"forehand-under-pressure performance",terms:["forehand under pressure performance","forehand-under-pressure performance"]},
    {name:"running-forehand effectiveness",terms:["running forehand effectiveness","running-forehand effectiveness"]},
    {name:"running-backhand effectiveness",terms:["running backhand effectiveness","running-backhand effectiveness"]},
    {name:"second-serve return aggression",terms:["second serve return aggression","second-serve return aggression"]},
    {name:"first-ball-after-return effectiveness",terms:["first ball after return effectiveness","first-ball-after-return effectiveness"]},
    {name:"net-approach deterrence",terms:["net approach deterrence","net-approach deterrence"]},
  ],
  "059":[
    {name:"loss path opponent serves through",terms:["loss path opponent serves through","opponent serves through"]},
    {name:"loss path return exposed",terms:["loss path return exposed","return exposed"]},
    {name:"loss path slow start/set-1 loss",terms:["loss path slow start set 1 loss","slow start set 1 loss","slow start/set-1 loss"]},
    {name:"loss path physical decline",terms:["loss path physical decline","physical decline"]},
    {name:"loss path tiebreak variance",terms:["loss path tiebreak variance","tiebreak variance"]},
    {name:"loss path three-set collapse",terms:["loss path three set collapse","three set collapse","three-set collapse"]},
    {name:"loss path other",terms:["loss path other"]},
  ],
};
function familyCode(code:string){const m=String(code).match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(code).padStart(3,"0");}
function componentHits(value:string|null,components:Array<{name:string;terms:string[]}>){return components.filter(c=>containsAny(value,c.terms));}
function playerTagged(value:string|null,expected:string){return Boolean(value)&&norm(value).includes(norm(`PLAYER=${expected}`));}
function sourceTagged(value:string|null,sources:MetricFinding["sources"]){if(!value||!sources?.length)return false;const v=norm(value);return v.includes("source")&&sources.some(s=>s.source_name?.trim()&&v.includes(norm(s.source_name)));}
function sampleTagged(value:string|null){return Boolean(value)&&norm(value).includes("sample");}
function formulaTagged(value:string|null){return Boolean(value)&&norm(value).includes("formula");}
function tagValue(value:string|null,key:string){if(!value)return null;const m=value.match(new RegExp(`${key}\\s*=\\s*([^;]+)`,"i"));return m?.[1]?.trim()??null;}
function validateCompositeSide(value:string|null,treatment:MetricFinding["p1_treatment"],sources:MetricFinding["sources"],components:Array<{name:string;terms:string[]}>,expectedPlayer?:string,strictProvenance=false){
  if(treatment==="UNAVAILABLE"||treatment==="EXCLUDED"||!value)return{value,treatment,missing:[] as string[]};
  const hits=componentHits(value,components),missing=components.filter(c=>!hits.includes(c)).map(c=>c.name),hasSource=Boolean(sources?.length);
  if(strictProvenance){
    const metaMissing:string[]=[];
    if(!expectedPlayer||!playerTagged(value,expectedPlayer))metaMissing.push(`PLAYER=${expectedPlayer??"expected player"}`);
    if(!sourceTagged(value,sources))metaMissing.push("side-specific SOURCE matching persisted source list");
    if(!sampleTagged(value))metaMissing.push("side-specific SAMPLE");
    if(treatment==="RECONSTRUCTED"&&!formulaTagged(value))metaMissing.push("FORMULA for reconstructed evidence");
    if(metaMissing.length)return{value:null,treatment:"UNAVAILABLE" as const,missing:[...missing,...metaMissing]};
  }
  if(treatment==="DIRECT"){
    if(!missing.length&&hasSource)return{value,treatment,missing};
    if(hits.length&&hasSource)return{value,treatment:"PARTIAL" as const,missing};
    return{value:null,treatment:"UNAVAILABLE" as const,missing:missing.length?missing:components.map(c=>c.name)};
  }
  if(treatment==="RECONSTRUCTED"){
    if(!missing.length&&hasSource)return{value,treatment,missing};
    if(hits.length&&hasSource)return{value,treatment:"PARTIAL" as const,missing};
    return{value:null,treatment:"UNAVAILABLE" as const,missing:missing.length?missing:components.map(c=>c.name)};
  }
  if(treatment==="PARTIAL")return hits.length&&hasSource?{value,treatment,missing}:{value:null,treatment:"UNAVAILABLE" as const,missing:components.map(c=>c.name)};
  return{value:null,treatment:"UNAVAILABLE" as const,missing:components.map(c=>c.name)};
}

export function validateMetric(metric:{code:string;name:string;body:string|null},finding:MetricFinding,expected?:{p1:string;p2:string}):MetricFinding{
  const code=familyCode(metric.code),composite=COMPOSITE_COMPONENTS[code],strict=PROTECTED_EXACT_METRICS.has(code)&&Boolean(expected);
  if(composite){
    const p1=validateCompositeSide(finding.p1_value,finding.p1_treatment,finding.sources,composite,expected?.p1,strict),p2=validateCompositeSide(finding.p2_value,finding.p2_treatment,finding.sources,composite,expected?.p2,strict);
    const missing=[...new Set([...(p1.missing??[]),...(p2.missing??[])])];
    const p1Sample=tagValue(p1.value,"SAMPLE"),p2Sample=tagValue(p2.value,"SAMPLE");
    return{
      ...finding,
      p1_value:p1.value,
      p2_value:p2.value,
      p1_treatment:p1.treatment,
      p2_treatment:p2.treatment,
      evidence_family:strict?`EXACT_${code}`:finding.evidence_family,
      sample:strict?`P1:${p1Sample??"UNAVAILABLE"} | P2:${p2Sample??"UNAVAILABLE"}`:finding.sample,
      unavailable_reason:(p1.treatment==="UNAVAILABLE"||p2.treatment==="UNAVAILABLE"||p1.treatment==="PARTIAL"||p2.treatment==="PARTIAL")&&missing.length?`Exact-component guard: unsupported components remain missing (${missing.join(", ")}). No proxy substitution permitted. Side reversal or unverifiable provenance is also not permitted.`:finding.unavailable_reason,
      missing_inputs:missing.length?[...(finding.missing_inputs??[]),...missing]:finding.missing_inputs,
    };
  }
  const req=semanticRequirement(metric.name,metric.body);
  if(!req)return finding;
  const p1ok=validSide(finding.p1_value,req),p2ok=validSide(finding.p2_value,req);
  if(p1ok&&p2ok)return finding;
  return{
    ...finding,
    p1_value:p1ok?finding.p1_value:null,
    p2_value:p2ok?finding.p2_value:null,
    p1_treatment:p1ok?finding.p1_treatment:"UNAVAILABLE",
    p2_treatment:p2ok?finding.p2_treatment:"UNAVAILABLE",
    unavailable_reason:`Semantic evidence guard rejected a reconstruction that did not contain ${req}-specific inputs required by the metric definition.`,
    missing_inputs:[...(finding.missing_inputs??[]),`${req}-specific sourced inputs`],
  };
}
function mergeRuntimeIdentity(base:IdentityFinding,p1:string,p2:string):IdentityFinding{
  const a=resolveRuntimePlayer(p1),b=resolveRuntimePlayer(p2);
  return{
    ...base,
    player1_canonical:base.player1_canonical??a?.name??null,
    player2_canonical:base.player2_canonical??b?.name??null,
    player1_status:base.player1_status==="VERIFIED"||a?"VERIFIED":base.player1_status,
    player2_status:base.player2_status==="VERIFIED"||b?"VERIFIED":base.player2_status,
    unresolved_reason:(base.player1_status==="VERIFIED"||a)&&(base.player2_status==="VERIFIED"||b)?null:base.unresolved_reason,
    sources:[...(base.sources??[]),...(a||b?[{source_name:"Bundled historical player index",url:null,retrieved_at:new Date().toISOString()}]:[])],
  };
}
function protectedInstruction(code:string,p1:string,p2:string){return PROTECTED_EXACT_METRICS.has(code)?`\nSTRICT POST-FIX WIRING RULE: do not use a neighboring statistic or proxy. Every usable side value MUST be self-identifying and self-provenancing in this exact form: PLAYER=<exact player name>; SOURCE=<one actual source_name also present in sources>; SAMPLE=<actual denominator/window, or UNAVAILABLE when the source publishes no sample>; <exact supported metric components>. RECONSTRUCTED additionally requires FORMULA=<formula using only master-permitted inputs>. P1 must use PLAYER=${p1}; P2 must use PLAYER=${p2}. If the player/source/sample mapping cannot be proved, return UNAVAILABLE for that side.`:"";}

export const validatedCompletionResearcher:Researcher={
  ...completionSweepResearcher,
  async identity(input){return mergeRuntimeIdentity(await completionSweepResearcher.identity(input),input.p1,input.p2);},
  async metrics(input){
    const guarded={...input,metrics:input.metrics.map(m=>({...m,body:`${m.body??""}${protectedInstruction(familyCode(String(m.code)),input.p1,input.p2)}`}))};
    const rows=await completionSweepResearcher.metrics(guarded);const defs=new Map(input.metrics.map(m=>[String(m.code),m]));
    return rows.map(row=>{const def=defs.get(String(row.metric_code));return def?validateMetric(def,row,{p1:input.p1,p2:input.p2}):row;});
  },
};