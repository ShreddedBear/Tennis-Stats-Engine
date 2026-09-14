import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { policyForMetric } from "./metric-source-family-policy";
import { reconstructPbpScoreState, TASK18B_METRIC_CODES, type PbpSide } from "./pbp-score-state-recovery";
import { canonicalApprovedPbpIdentity, claimUniqueApprovedPbp } from "./pbp-evidence-firewall";

const BASE="https://sports.bzzoiro.com/tennis/api/v2",COVERAGE_START="2024-01-01";
// "034" and "053" added: both were already computed by reconstructPbpScoreState (see that
// file's add("034",...)/add("053",...) calls) but silently dropped from every packet built
// here because this allowlist never named them -- a wiring gap, not a data gap. See
// docs/audit-task-026-034-053.md.
const PBP_CODES=new Set(["016","024","025","033","034","042","043","044","053","060",...TASK18B_METRIC_CODES]);
type MetricLike={code:string;name:string};
type IndexRow={match_id?:string|number|null;date?:string|null;players?:string[];tournament?:string|null;circuit?:string|null;category?:string|null;surface?:string|null;structurally_present?:boolean};
const norm=(v:unknown)=>String(v??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const codeOf=(v:unknown)=>{const m=String(v??"").match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(v??"").padStart(3,"0");};
function explicitContext(c:string|null|undefined){const s=norm(c);if(!s||/(^| )wta( |$)/.test(s)||["challenger","itf","futures","utr","satellite","exhibition"].some(x=>s.includes(x)))return false;return/(^| )atp( |$)/.test(s)||["masters 1000","grand slam","next gen finals","atp finals"].some(x=>s.includes(x));}
function strictRow(r:IndexRow){const blob=norm(`${r.category??""} ${r.tournament??""}`);return String(r.circuit??"").toUpperCase()==="ATP"&&r.structurally_present===true&&!["challenger","wta","itf","futures","utr","satellite","exhibition"].some(x=>blob.includes(x));}
async function loadIndex(year:number):Promise<IndexRow[]>{try{const p=JSON.parse(await readFile(join(process.cwd(),"data","audit","bsd-atp-main-pbp-history",String(year),"results.json"),"utf8"));return Array.isArray(p)?p:[];}catch{return[];}}
async function fetchPbp(id:string|number){const token=process.env.BSD_TENNIS_API_KEY;if(!token)return null;try{const r=await fetch(`${BASE}/matches/${encodeURIComponent(String(id))}/point-by-point/`,{headers:{Authorization:`Token ${token}`,"User-Agent":"tennis-truth-engine-task18b-atp-main/1.0"},signal:AbortSignal.timeout(12000)});if(!r.ok)return null;const p=await r.json();return p&&typeof p==="object"&&(p as any).available===true?p:null;}catch{return null;}}
async function fetchCandidatePbp(rows:IndexRow[],concurrency=6){
 const out:Array<{row:IndexRow;payload:any}>=[];
 for(let offset=0;offset<rows.length;offset+=concurrency){
  const chunk=rows.slice(offset,offset+concurrency);
  out.push(...await Promise.all(chunk.map(async row=>({row,payload:row.match_id==null?null:await fetchPbp(row.match_id)}))));
 }
 return out;
}
function candidates(rows:IndexRow[],p1:string,p2:string){const sorted=[...rows].sort((a,b)=>String(b.date??"").localeCompare(String(a.date??""))),seen=new Set<string>();return[...sorted.filter(r=>(r.players??[]).map(norm).includes(p1)).slice(0,12),...sorted.filter(r=>(r.players??[]).map(norm).includes(p2)).slice(0,12)].filter(r=>{const k=String(r.match_id??"");if(!k||seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>String(b.date??"").localeCompare(String(a.date??"")));}

type ObservationStatus={eligible:boolean;reason:string;matches_used:number;rejected_pbp:number;coverage_start:string;source:string};
// buildBsdAtpMainPbpContext runs once per metric BATCH (~17 batches per side for 81
// metrics), but the expensive part -- finding candidate historical matches and
// fetching their point-by-point payloads from the live BSD API -- depends only on
// (p1, p2, asOfDate, context), never on which metrics a given batch happens to ask
// for. Without this cache, every batch redid the same ~15-24 live HTTP fetches from
// scratch; memoizing for the process lifetime (keyed on those inputs, not metrics)
// collapses that to one real computation per side per match. Caching the in-flight
// Promise (not just its resolution) also collapses concurrent callers.
const observationCache=new Map<string,Promise<{status:ObservationStatus;observations:any[]}>>();
async function computeObservations(args:{p1:string;p2:string;asOfDate:string;context?:string|null}):Promise<{status:ObservationStatus;observations:any[]}>{
 const key=`${norm(args.p1)}|${norm(args.p2)}|${args.asOfDate}|${args.context??""}`;
 const cached=observationCache.get(key);if(cached)return cached;
 const promise=(async():Promise<{status:ObservationStatus;observations:any[]}>=>{
  const status:ObservationStatus={eligible:false,reason:"",matches_used:0,rejected_pbp:0,coverage_start:COVERAGE_START,source:"BSD/Bzzoiro ATP Main PBP"};
  if(!explicitContext(args.context)){status.reason="Fail-closed tour guard: context is not explicitly ATP Main.";return{status,observations:[]};}
  if(args.asOfDate<COVERAGE_START){status.reason="Outside confirmed BSD ATP Main PBP coverage boundary.";return{status,observations:[]};}
  status.eligible=true;const end=Math.min(new Date().getUTCFullYear(),Number(args.asOfDate.slice(0,4))||new Date().getUTCFullYear());const indexes=(await Promise.all(Array.from({length:Math.max(0,end-2024+1)},(_,i)=>loadIndex(2024+i)))).flat();const p1n=norm(args.p1),p2n=norm(args.p2);const eligible=indexes.filter(r=>strictRow(r)&&Boolean(r.date)&&String(r.date).slice(0,10)<args.asOfDate&&(r.players??[]).map(norm).some(n=>n===p1n||n===p2n));
  const observations:any[]=[],seenMatchIds=new Set<string>(),seenCanonicalKeys=new Set<string>();
  // Claiming (uniqueness/dedup) stays a synchronous pass over candidates in order,
  // identical to the prior sequential loop's ordering; only the network fetch and
  // its processing run concurrently across claimed rows.
  const claimed:Array<{row:IndexRow;names:string[];identity:NonNullable<ReturnType<typeof canonicalApprovedPbpIdentity>>}>=[];
  for(const row of candidates(eligible,p1n,p2n)){
   if(!Array.isArray(row.players)||row.players.length!==2)continue;const names=row.players.map(v=>String(v??""));const identity=canonicalApprovedPbpIdentity({tour:"ATP_MAIN",player1:names[0],player2:names[1],tournament:row.tournament,date:row.date,eventLevel:row.category});
   if(!claimUniqueApprovedPbp({matchId:row.match_id,identity,seenMatchIds,seenCanonicalKeys})){status.rejected_pbp++;continue;}
   claimed.push({row,names,identity:identity!});
  }
  await Promise.all(claimed.map(async({row,names,identity})=>{
   const payload=await fetchPbp(row.match_id!);if(!payload)return;const recovery=reconstructPbpScoreState(payload);if(!recovery.valid){status.rejected_pbp++;return;}
   for(const target of[args.p1,args.p2]){const idx=names.findIndex(n=>norm(n)===norm(target));if(idx<0)continue;const side:PbpSide=idx===0?"player1":"player2",derived=recovery.derived[side];if(!Object.keys(derived).length)continue;observations.push({family:"POINT_BY_POINT",source:"BSD/Bzzoiro ATP Main PBP",url:`${BASE}/matches/${row.match_id}/point-by-point/`,player:target,opponent:names[idx===0?1:0],tournament:row.tournament??null,event_date:String(row.date).slice(0,10),surface:row.surface??null,key:"task18b_approved_pbp_score_state",value:{match_id:row.match_id,totalPoints:recovery.point_count,gamesObserved:recovery.game_count,derived,field_support:recovery.field_support},sample:`${recovery.point_count} parsed points; ${recovery.game_count} complete games`,provenance:{tour:"ATP_MAIN",match_id:String(row.match_id),canonical_match_key:identity.key,player_orientation:side,approved_only:true,approval_source:"BSD ATP Main historical structural PBP audit",raw_pbp_ref:`${BASE}/matches/${row.match_id}/point-by-point/`,parsed_point_state:true,transformation:"pbp-score-state-recovery",duplicate_match_guard:true,one_match_one_pbp:true}});status.matches_used++;}
  }));
  status.reason=observations.length?"Approved ATP Main PBP reconstructed through canonical match identity where metric-specific raw fields are satisfied.":"No matching approved ATP Main PBP satisfied Task 18B field requirements.";
  return{status,observations};
 })();
 observationCache.set(key,promise);
 promise.catch(()=>observationCache.delete(key));
 return promise;
}

export async function buildBsdAtpMainPbpContext(args:{metrics:MetricLike[];p1:string;p2:string;asOfDate:string;context?:string|null}){
 const status={eligible:false,reason:"",matches_used:0,rejected_pbp:0,coverage_start:COVERAGE_START,source:"BSD/Bzzoiro ATP Main PBP"};
 if(!explicitContext(args.context)){status.reason="Fail-closed tour guard: context is not explicitly ATP Main.";return{packet:{} as Record<string,unknown>,status};}
 if(args.asOfDate<COVERAGE_START){status.reason="Outside confirmed BSD ATP Main PBP coverage boundary.";return{packet:{} as Record<string,unknown>,status};}
 if(!args.metrics.some(metric=>PBP_CODES.has(codeOf(metric.code)))){status.reason="No requested metric uses the approved ATP Main PBP family.";return{packet:{} as Record<string,unknown>,status};}
 const{status:computedStatus,observations}=await computeObservations(args);
 const packet:Record<string,unknown>={};for(const metric of args.metrics){const code=codeOf(metric.code),codeRows=observations.filter(o=>Boolean(o.value?.derived?.[code]));if(!PBP_CODES.has(code)||!codeRows.length)continue;const p=policyForMetric(code);packet[code]={metric_name:metric.name,allowed_families:[...new Set([...p.allowed_families,"POINT_BY_POINT"])],sufficient_families:[...new Set([...p.sufficient_families,"POINT_BY_POINT"])],support_only_families:(p.support_only_families??[]).filter(x=>x!=="POINT_BY_POINT"),observed_families:["POINT_BY_POINT"],direct_satisfaction_allowed:false,observations:codeRows.slice(0,80),tour_guard:"STRICT_ATP_MAIN_ONLY",evidence_treatment:"RECONSTRUCTED_OR_TASK17_PARTIAL_ONLY"};}
 return{packet,status:{...computedStatus}};
}
