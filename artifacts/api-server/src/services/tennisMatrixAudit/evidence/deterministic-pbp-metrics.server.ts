import { auditWarehouseDb } from "./postgrestCompat";
import type { MetricFinding, SourceRef } from "./audit-pipeline";
import { evidenceNameMatches, safeEvidenceAliases } from "./evidence-player-alias";
import { metricAllowsObservation } from "./metric-source-family-policy";
import { TASK18B_METRIC_CODES } from "./pbp-score-state-recovery";
import { isBeforeCutoff } from "./temporal-boundary";

// TEMPORAL BOUNDARY (Phase 14). Both entry points below admit a PBP observation only when
// its event_date is STRICTLY BEFORE the audited match's date, via temporal-boundary.ts's
// isBeforeCutoff / a `.lt()` bound. Previously both used an on-or-before comparison
// (`<=` / `.lte()`), and the packet path additionally admitted rows with NO date at all
// (`!r.event_date || ...`). Either shape can feed the audited match's OWN point-by-point
// record back in as "prior" evidence for predicting that same match -- the most direct
// form of leakage available to this pipeline, since a match played on the audited day is
// in the same BSD index the producers read. An undated row cannot be proven to precede
// the match, so it is excluded rather than assumed prior. This tier is shared by every
// POINT_BY_POINT metric (002/003/009/016/018/032/034/053), so the fix applies to all of
// them at once. See truth-engine-temporal-integrity.leakage.test.ts.
const db = auditWarehouseDb as any;
const LEGACY_SUPPORTED = new Set(["016","024","025","033","042","043","044","060"]);
// "034" and "053" added: both are computed by reconstructPbpScoreState (add("034",...)/
// add("053",...)) and, once the matching bsd-*-pbp.server.ts PBP_CODES allowlist gap is
// fixed, do reach this function's packet argument -- but this SUPPORTED gate would still
// have silently dropped them here even after that fix. See docs/audit-task-026-034-053.md.
const SUPPORTED = new Set([...LEGACY_SUPPORTED, "034", "053", ...TASK18B_METRIC_CODES]);

type Row={source_id:string|null;source_name:string|null;source_url:string|null;player_name:string|null;opponent_name:string|null;event_date:string|null;observation_type:string|null;observation_key:string|null;numeric_value:number|null;text_value:string|null;sample_label:string|null};
type PacketObservation={family?:string|null;source?:string|null;url?:string|null;player?:string|null;opponent?:string|null;event_date?:string|null;key?:string|null;value?:any;sample?:string|null;provenance?:any};
const codeOf=(v:unknown)=>{const m=String(v??"").match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(v??"").padStart(3,"0");};

function sourceRefs(rows:Row[]):SourceRef[]{const seen=new Set<string>(),out:SourceRef[]=[];for(const row of rows){if(!row.source_name)continue;const key=`${row.source_name}|${row.source_url??""}`;if(seen.has(key))continue;seen.add(key);out.push({source_name:row.source_name,url:row.source_url,retrieved_at:null});}return out;}
function warehouseSummary(player:string,opponent:string,rows:Row[]){const side=rows.filter(row=>evidenceNameMatches(row.player_name,player,opponent));if(!side.length)return null;const numeric=side.map(row=>Number(row.numeric_value)).filter(Number.isFinite),keys=[...new Set(side.map(row=>String(row.observation_key??"")).filter(Boolean))].slice(0,12),dates=side.map(row=>row.event_date).filter((v):v is string=>Boolean(v)).sort();return{observations:side.length,numeric_observations:numeric.length,avg_numeric_value:numeric.length?numeric.reduce((a,b)=>a+b,0)/numeric.length:null,observed_keys:keys,first_date:dates[0]??null,last_date:dates.at(-1)??null};}
function warehouseText(v:ReturnType<typeof warehouseSummary>){if(!v)return null;return `pbp_observations=${v.observations}; numeric_observations=${v.numeric_observations}; avg_numeric=${v.avg_numeric_value==null?"NA":v.avg_numeric_value.toFixed(4)}; keys=${v.observed_keys.join(",")||"NA"}; window=${v.first_date??"NA"}→${v.last_date??"NA"}`;}
function metricText(rows:PacketObservation[],code:string){const values=rows.map(r=>r.value?.derived?.[code]).filter(Boolean);if(!values.length)return null;const last=values.at(-1);return `reconstructed_matches=${values.length}; treatment=${last.treatment}; output=${JSON.stringify(last.value)}; raw_fields=${last.raw_fields.join(",")}; transformation=${last.transformation}`;}
// Aggregate-only tours (currently WTA Challenger/WTA 125) never populate `value.derived` —
// they retain set/game/point totals but not server-oriented point chronology, so per-metric
// score-state reconstruction is impossible. Each such row marks itself with
// `task18b_raw_fields_available: false`. This is a conservative, capped-at-PARTIAL fallback;
// it must never run for rows that do carry `derived` data (those keep full treatment above).
function aggregateOnlyText(rows:PacketObservation[]){const aggregate=rows.filter(r=>r.value?.task18b_raw_fields_available===false);if(!aggregate.length)return null;const points=aggregate.map(r=>Number(r.value?.total_points)).filter(Number.isFinite),games=aggregate.map(r=>Number(r.value?.total_games)).filter(Number.isFinite);return `point_rows=${aggregate.length}; total_points_observed=${points.length}; total_games_observed=${games.length}; aggregate_only=true`;}

export function deterministicPbpMetricFromPacket(args:{metricCode:unknown;p1:string;p2:string;asOfDate:string;packet:Record<string,unknown>}):MetricFinding|null{
 const code=codeOf(args.metricCode);if(!SUPPORTED.has(code))return null;const entry=args.packet?.[code] as {observations?:PacketObservation[]}|undefined;const rows=Array.isArray(entry?.observations)?entry!.observations!.filter(r=>r?.family==="POINT_BY_POINT"&&isBeforeCutoff(r.event_date,args.asOfDate)):[];if(!rows.length)return null;
 const p1Rows=rows.filter(r=>evidenceNameMatches(r.player,args.p1,args.p2)&&Boolean(r.value?.derived?.[code]));const p2Rows=rows.filter(r=>evidenceNameMatches(r.player,args.p2,args.p1)&&Boolean(r.value?.derived?.[code]));let p1=metricText(p1Rows,code),p2=metricText(p2Rows,code);
 let p1Treatment=p1Rows.at(-1)?.value?.derived?.[code]?.treatment??"UNAVAILABLE",p2Treatment=p2Rows.at(-1)?.value?.derived?.[code]?.treatment??"UNAVAILABLE";
 if(!p1){const agg=aggregateOnlyText(rows.filter(r=>evidenceNameMatches(r.player,args.p1,args.p2)));if(agg){p1=agg;p1Treatment="PARTIAL";}}
 if(!p2){const agg=aggregateOnlyText(rows.filter(r=>evidenceNameMatches(r.player,args.p2,args.p1)));if(agg){p2=agg;p2Treatment="PARTIAL";}}
 if(!p1&&!p2)return null;
 const seen=new Set<string>(),sources:SourceRef[]=[];for(const row of rows){const sourceName=String(row.source??"").trim();if(!sourceName)continue;const url=row.url?String(row.url):null,key=`${sourceName}|${url??""}`;if(seen.has(key))continue;seen.add(key);sources.push({source_name:sourceName,url,retrieved_at:null});}
 const pairComplete=Boolean(p1&&p2);return{metric_code:code,p1_value:p1,p2_value:p2,p1_treatment:p1Treatment,p2_treatment:p2Treatment,differential:null,evidence_family:"POINT_BY_POINT",reliability:pairComplete?90:72,sample:`Task 18B approved tour-scoped PBP through ${args.asOfDate}; p1_matches=${p1Rows.length}; p2_matches=${p2Rows.length}; pair_complete=${pairComplete}`,unavailable_reason:pairComplete?null:"Metric-specific PBP evidence is one-sided or lacks the required raw fields; missing evidence is not synthesized.",sources};
}

export async function deterministicPbpMetric(args:{metricCode:unknown;p1:string;p2:string;asOfDate:string}):Promise<MetricFinding|null>{
 const code=codeOf(args.metricCode);if(!SUPPORTED.has(code))return null;const start=new Date(`${args.asOfDate}T00:00:00Z`);start.setUTCFullYear(start.getUTCFullYear()-2);const p1Aliases=safeEvidenceAliases(args.p1,args.p2),p2Aliases=safeEvidenceAliases(args.p2,args.p1),select="source_id,source_name,source_url,player_name,opponent_name,event_date,observation_type,observation_key,numeric_value,text_value,sample_label";const base=()=>db.from("source_observations").select(select).gte("event_date",start.toISOString().slice(0,10)).lt("event_date",args.asOfDate).in("observation_type",["POINT_BY_POINT","PBP"]).order("event_date",{ascending:false}).limit(1200);const[p1Result,p2Result]=await Promise.all([base().in("player_name",p1Aliases),base().in("player_name",p2Aliases)]);if(p1Result.error&&p2Result.error)return null;const rows=[...((p1Result.error?[]:p1Result.data??[])as Row[]),...((p2Result.error?[]:p2Result.data??[])as Row[])].filter(row=>metricAllowsObservation(code,row));if(!rows.length)return null;const p1=warehouseText(warehouseSummary(args.p1,args.p2,rows)),p2=warehouseText(warehouseSummary(args.p2,args.p1,rows));if(!p1&&!p2)return null;return{metric_code:code,p1_value:p1,p2_value:p2,p1_treatment:p1?"PARTIAL":"UNAVAILABLE",p2_treatment:p2?"PARTIAL":"UNAVAILABLE",differential:null,evidence_family:"POINT_BY_POINT",reliability:75,sample:`warehouse PBP through ${args.asOfDate}; metric-specific raw-field provenance not guaranteed`,unavailable_reason:"Persisted generic PBP remains PARTIAL unless a tour-scoped Task 18B packet proves the metric-specific raw-field contract.",sources:sourceRefs(rows)};
}
