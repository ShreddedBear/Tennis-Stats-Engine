import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { policyForMetric } from "./metric-source-family-policy";
import { TASK18B_METRIC_CODES } from "./pbp-score-state-recovery";
import { canonicalApprovedPbpIdentity, claimUniqueApprovedPbp, isApprovedWtaChallengerPbpRow } from "./pbp-evidence-firewall";

const COVERAGE_START="2025-01-01";
const APPROVED_INDEX=join(process.cwd(),"data","metrics","pbp","wta_challenger","approved-index.jsonl");
const LEGACY_PBP_CODES=new Set(["016","024","025","033","042","043","044","060"]);
// "034" and "053" (and 026's within-match opening-window detector) are deliberately NOT
// added here, verified against this file's own row shape rather than assumed: every
// observation this file builds carries only aggregate set_scores/match_winner_slot/
// total_games/total_points/breaks (task18b_raw_fields_available:false,
// server_oriented_point_chronology_preserved:false above) -- there is no per-game
// server/point-winner sequence in the APPROVED_INDEX rows at all, so reconstructPbpScoreState
// (and its 034/053/opening-window sibling) is never even called in this file, unlike the
// other three bsd-*-pbp.server.ts lanes. Crediting 034/053 here would mean pointing at a
// packet with no derived[code] to satisfy them -- structurally impossible, not merely
// unimplemented. This WTA Challenger lane genuinely has NOT_ENOUGH_DATA for 026/034/053
// until BSD starts retaining server-oriented point chronology for it. See
// docs/audit-task-026-034-053.md.

type MetricLike={code:string;name:string};
type ApprovedRow={tour?:string;year?:number;match_id?:string|number;date?:string;tournament?:string;player1?:string;player2?:string;metrics?:{set_scores?:Array<[number,number]>;match_winner_slot?:string;total_games?:number;total_points?:number;breaks?:number};status?:string};
const norm=(v:unknown)=>String(v??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();const codeOf=(v:unknown)=>{const m=String(v??"").match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(v??"").padStart(3,"0");};
function explicitContext(c:string|null|undefined){const s=norm(c);if(!s||["atp","itf","futures","utr","satellite","exhibition"].some(x=>s.includes(x)))return false;return s.includes("wta 125")||s.includes("wta125")||s.includes("125k")||s.includes("wta challenger");}
async function loadApprovedIndex():Promise<ApprovedRow[]>{try{const raw=await readFile(APPROVED_INDEX,"utf8");return raw.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as ApprovedRow).filter(isApprovedWtaChallengerPbpRow);}catch{return[];}}

export async function buildBsdWtaChallengerPbpContext(args:{metrics:MetricLike[];p1:string;p2:string;asOfDate:string;context?:string|null}){
 const status={eligible:false,reason:"",matches_used:0,approved_records_available:0,rejected_pbp:0,quarantined_records_included:0,coverage_start:COVERAGE_START,source:"BSD/Bzzoiro WTA Challenger approved PBP index"};if(!explicitContext(args.context)){status.reason="Fail-closed tour guard: context is not explicitly WTA Challenger/WTA 125.";return{packet:{} as Record<string,unknown>,status};}if(args.asOfDate<COVERAGE_START){status.reason="Outside confirmed BSD WTA Challenger/WTA 125 PBP coverage boundary.";return{packet:{} as Record<string,unknown>,status};}status.eligible=true;
 const approved=await loadApprovedIndex();status.approved_records_available=approved.length;const p1n=norm(args.p1),p2n=norm(args.p2),seenMatchIds=new Set<string>(),seenCanonicalKeys=new Set<string>();const rows=approved.filter(row=>{const d=String(row.date??"").slice(0,10);if(!d||d>=args.asOfDate)return false;const a=norm(row.player1),b=norm(row.player2);return a===p1n||b===p1n||a===p2n||b===p2n;}).sort((a,b)=>String(b.date??"").localeCompare(String(a.date??""))).slice(0,40);
 const observations:any[]=[];for(const row of rows){const player1=String(row.player1??""),player2=String(row.player2??"");const identity=canonicalApprovedPbpIdentity({tour:"WTA_CHALLENGER",player1,player2,tournament:row.tournament,date:row.date,eventLevel:"WTA 125"});if(!claimUniqueApprovedPbp({matchId:row.match_id,identity,seenMatchIds,seenCanonicalKeys})){status.rejected_pbp++;continue;}const m=row.metrics??{};const names=[player1,player2];for(const target of[args.p1,args.p2]){const idx=names.findIndex(n=>norm(n)===norm(target));if(idx<0)continue;observations.push({family:"POINT_BY_POINT",source:"BSD/Bzzoiro WTA Challenger approved PBP index",url:null,player:target,opponent:names[idx===0?1:0],tournament:row.tournament??null,event_date:String(row.date??"").slice(0,10),key:"bsd_wta_challenger_approved_pbp_aggregate_only",value:{match_id:row.match_id??null,set_scores:m.set_scores??null,match_winner_slot:m.match_winner_slot??null,total_games:m.total_games??null,total_points:m.total_points??null,breaks:m.breaks??null,task18b_raw_fields_available:false},sample:`${m.total_points??"NA"} aggregate points; ${m.total_games??"NA"} games; ${m.breaks??"NA"} total breaks`,provenance:{tour:"WTA_CHALLENGER",match_id:String(row.match_id),canonical_match_key:identity!.key,player_orientation:idx===0?"player1":"player2",approved_only:true,approval_source:"APPROVED_WTA_CHALLENGER_PBP",structural_validation:true,match_identity_validation:true,duplicate_protection:true,one_match_one_pbp:true,quarantined_records_reintroduced:false,server_oriented_point_chronology_preserved:false}});}}status.matches_used=observations.length;
 const packet:Record<string,unknown>={};for(const metric of args.metrics){const code=codeOf(metric.code);if(TASK18B_METRIC_CODES.has(code))continue;if(!LEGACY_PBP_CODES.has(code)||!observations.length)continue;const p=policyForMetric(code);if(!p.allowed_families.includes("POINT_BY_POINT"))continue;packet[code]={metric_name:metric.name,allowed_families:p.allowed_families,sufficient_families:p.sufficient_families,support_only_families:p.support_only_families??[],observed_families:["POINT_BY_POINT"],direct_satisfaction_allowed:false,observations:observations.slice(0,80),tour_guard:"STRICT_WTA_CHALLENGER_WTA125_ONLY",evidence_treatment:"AGGREGATE_ONLY_NO_TASK18B_SCORE_STATE_CREDIT"};}
 status.reason=observations.length?"Approved WTA Challenger/WTA 125 aggregate PBP rows validated through canonical match identity; Task 18B score-state cells remain unavailable because server-oriented raw point chronology is not retained.":"No approved WTA Challenger/WTA 125 PBP observations matched these players.";return{packet,status};
}
