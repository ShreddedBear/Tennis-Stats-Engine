import { auditWarehouseDb } from "./postgrestCompat";
import type { MetricFinding, SourceRef } from "./audit-pipeline";
import { sameTournamentHistory } from "./tournament-history-reconstruction";
import { evidenceNameMatches, safeEvidenceAliases } from "./evidence-player-alias";
import { metricAllowsObservation } from "./metric-source-family-policy";
import { inferRepositoryMatchContext, repositoryResultsRows } from "./repository-results-history.server";
import { deterministicHistoricalResultsMetric } from "./deterministic-historical-results-metrics.server";
import { TASK18A_HISTORICAL_RESULTS_CODES } from "./historical-results-recovery";
import { certifyMetricFinding } from "./metric-certification";
import {
  buildCanonicalEvidenceMatchIdentity,
  classifyEvidenceTourFamily,
  evidenceDateCompatible,
  evidenceTourCompatible,
  normalizeEvidenceRound,
  normalizeEvidenceTournament,
  type EvidenceTourFamily,
} from "./evidence-match-identity";

const db = auditWarehouseDb as any;
const SCHEDULE_SUPPORTED = new Set(["012", "028", "030", "064", "071", "076", "077", "081"]);
const HISTORICAL_SUPPORTED = new Set<string>(TASK18A_HISTORICAL_RESULTS_CODES);

type Observation = {id?: string;source_id: string | null;source_name: string | null;source_url: string | null;player_name: string | null;opponent_name: string | null;tournament: string | null;event_date: string | null;surface: string | null;observation_type: string | null;observation_key: string | null;text_value: string | null;sample_label: string | null;raw_payload?: unknown;provenance?: unknown;};
type MatchHistoryRow = {id: string;canonical_key: string | null;player1_name: string;player2_name: string;player1_id: string | null;player2_id: string | null;tournament_name: string | null;event_level: string | null;round: string | null;scheduled_date: string | null;scheduled_local_at: string | null;scheduled_utc_at: string | null;};
type ScheduleContextKind = "DIRECT_EVENT_SCHEDULE" | "MATCH_HISTORY_SCHEDULE_CONTEXT" | "UNAVAILABLE";
type PlayerComponents = { matches_14d:number;matches_30d:number;matches_52w:number;days_since_last_match:number|null;distinct_tournaments_30d:number;same_tournament_matches_5y:number;same_tournament_wins_5y:number;qualifying_matches_14d:number;scheduled_current_event_rows:number;match_history_schedule_rows:number;schedule_context_kind:ScheduleContextKind; };

function codeOf(value: unknown) { const m=String(value??"").match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(value??"").padStart(3,"0"); }
function daysBetween(a:string,b:string){return Math.floor((new Date(`${b}T00:00:00Z`).getTime()-new Date(`${a}T00:00:00Z`).getTime())/86_400_000);}
function parseText(row:Observation){if(!row.text_value)return{} as Record<string,unknown>;try{return JSON.parse(row.text_value) as Record<string,unknown>;}catch{return{};}}
function isMatch(row:Observation){return row.observation_key==="match_record"&&!!row.event_date&&!!row.player_name;}
function sources(rows:Observation[]):SourceRef[]{const seen=new Set<string>();const out:SourceRef[]=[];for(const row of rows){if(!row.source_name)continue;const key=`${row.source_name}|${row.source_url??""}`;if(seen.has(key))continue;seen.add(key);out.push({source_name:row.source_name,url:row.source_url,retrieved_at:null});}return out;}
function stringifyHint(value:unknown){if(typeof value==="string")return value;if(value==null)return"";try{return JSON.stringify(value);}catch{return String(value);}}
function observationTourFamily(row:Observation){return classifyEvidenceTourFamily(row.sample_label,row.tournament,row.source_id,row.source_name,row.observation_type,row.observation_key,row.text_value,stringifyHint(row.raw_payload),stringifyHint(row.provenance));}
function inferExpectedFamily(args:{tourFamily?:EvidenceTourFamily|null;tour?:string|null;eventLevel?:string|null;tournament?:string|null;context?:string|null},rows:Observation[],p1:string,p2:string){const explicit=args.tourFamily??classifyEvidenceTourFamily(args.tour,args.eventLevel,args.tournament,args.context);if(explicit)return explicit;const families=new Set<EvidenceTourFamily>();for(const row of rows){if(!evidenceNameMatches(row.player_name,p1,p2)&&!evidenceNameMatches(row.player_name,p2,p1))continue;const family=observationTourFamily(row);if(family)families.add(family);}return families.size===1?[...families][0]:null;}
function sameTournament(a:string|null,b:string|null|undefined){if(!b)return true;const left=normalizeEvidenceTournament(a),right=normalizeEvidenceTournament(b);return!!left&&!!right&&left===right;}
function directScheduleRows(rows:Observation[],tournament:string|null|undefined,expectedFamily:EvidenceTourFamily|null){if(!expectedFamily)return[];return rows.filter(row=>row.observation_key==="event_schedule"&&sameTournament(row.tournament,tournament)&&evidenceTourCompatible(expectedFamily,observationTourFamily(row)));}
function matchHistoryDate(row:MatchHistoryRow){return row.scheduled_date??row.scheduled_local_at?.slice(0,10)??row.scheduled_utc_at?.slice(0,10)??null;}
function matchHistoryFamily(row:MatchHistoryRow){return classifyEvidenceTourFamily(row.event_level,row.tournament_name,row.canonical_key);}
function currentEventHistoryRows(rows:MatchHistoryRow[],args:{p1:string;p2:string;asOfDate:string;tournament?:string|null;round?:string|null},expectedFamily:EvidenceTourFamily|null){if(!expectedFamily)return[];const event=normalizeEvidenceTournament(args.tournament),round=normalizeEvidenceRound(args.round);return rows.filter(row=>{const pair=(evidenceNameMatches(row.player1_name,args.p1,args.p2)&&evidenceNameMatches(row.player2_name,args.p2,args.p1))||(evidenceNameMatches(row.player1_name,args.p2,args.p1)&&evidenceNameMatches(row.player2_name,args.p1,args.p2));if(!pair||!evidenceTourCompatible(expectedFamily,matchHistoryFamily(row)))return false;const rowEvent=normalizeEvidenceTournament(row.tournament_name);if(event&&rowEvent&&event!==rowEvent)return false;if(!evidenceDateCompatible(args.asOfDate,matchHistoryDate(row)))return false;const rowRound=normalizeEvidenceRound(row.round);if(round&&rowRound&&round!==rowRound)return false;return true;});}
function uniqueCurrentEventHistoryRows(rows:MatchHistoryRow[],args:{p1:string;p2:string;asOfDate:string;tournament?:string|null;round?:string|null},expectedFamily:EvidenceTourFamily|null){const candidates=currentEventHistoryRows(rows,args,expectedFamily);return candidates.length===1?candidates:[];}
function componentsFor(player:string,opponent:string,rows:Observation[],asOfDate:string,tournament:string|null,expectedFamily:EvidenceTourFamily|null,historyRows:MatchHistoryRow[],round?:string|null):PlayerComponents{const playerRows=rows.filter(r=>evidenceNameMatches(r.player_name,player,opponent)&&isMatch(r)&&evidenceTourCompatible(expectedFamily,observationTourFamily(r)));const recent=(days:number)=>playerRows.filter(r=>r.event_date&&daysBetween(r.event_date,asOfDate)>=0&&daysBetween(r.event_date,asOfDate)<=days);const r14=recent(14),r30=recent(30),r52w=recent(364),dates=playerRows.map(r=>r.event_date!).sort().reverse(),last=dates[0]??null;const sameTournamentRows=tournament?playerRows.filter(r=>sameTournament(r.tournament,tournament)&&r.event_date&&daysBetween(r.event_date,asOfDate)<=365*5):[];let sameTournamentWins=0;for(const row of sameTournamentRows){const payload=parseText(row);if(evidenceNameMatches(String(payload.winner??""),player,opponent))sameTournamentWins+=1;}const qualifying=r14.filter(r=>/qual/i.test(String(r.sample_label??parseText(r).round??"")));const direct=directScheduleRows(rows,tournament,expectedFamily),history=uniqueCurrentEventHistoryRows(historyRows,{p1:player,p2:opponent,asOfDate,tournament,round},expectedFamily);const kind:ScheduleContextKind=direct.length?"DIRECT_EVENT_SCHEDULE":history.length===1?"MATCH_HISTORY_SCHEDULE_CONTEXT":"UNAVAILABLE";return{matches_14d:r14.length,matches_30d:r30.length,matches_52w:r52w.length,days_since_last_match:last?daysBetween(last,asOfDate):null,distinct_tournaments_30d:new Set(r30.map(r=>normalizeEvidenceTournament(r.tournament)).filter(Boolean)).size,same_tournament_matches_5y:sameTournamentRows.length,same_tournament_wins_5y:sameTournamentWins,qualifying_matches_14d:qualifying.length,scheduled_current_event_rows:direct.length,match_history_schedule_rows:history.length,schedule_context_kind:kind};}
// Metric 030 only. The warehouse-derived counts this producer computes are 0/0 for most
// players (134 of 208 live rows), because source_observations does not hold historical
// per-tournament results. The generated runtime index does, so the counts are reconstructed
// from it and the WAREHOUSE COUNT IS STILL REPORTED alongside, never overwritten -- the two
// are separate provenance and a reader can see which one carried the evidence.
//
// A rate is emitted, not just raw counts: `same_tournament_matches_5y` and
// `same_tournament_wins_5y` alone give a comparison layer no denominator-safe quantity, and
// 0 wins from 0 matches is not 0% -- it is unknown. win_pct is therefore NA unless the
// player actually has matches at the event. Only the 030 string changes; every other code
// sharing this producer (012/028/064/071/076/077/081) is untouched.
function value030(c:PlayerComponents,player:string,tournament:string|null,asOfDate:string){
  const reconstructed=sameTournamentHistory(player,tournament,asOfDate);
  const matches=Math.max(c.same_tournament_matches_5y,reconstructed.matches);
  const wins=reconstructed.matches>=c.same_tournament_matches_5y?reconstructed.wins:c.same_tournament_wins_5y;
  const pct=matches>0?Number(((100*wins)/matches).toFixed(2)):null;
  return `same_tournament_matches_5y=${matches}; same_tournament_wins_5y=${wins}; same_tournament_win_pct=${pct??"NA"}; warehouse_matches_5y=${c.same_tournament_matches_5y}; reconstructed_matches_5y=${reconstructed.matches}`;
}
function valueFor(code:string,c:PlayerComponents,player:string,tournament:string|null,asOfDate:string){switch(code){case"012":case"077":return`matches_14d=${c.matches_14d}; matches_30d=${c.matches_30d}; matches_52w=${c.matches_52w}; days_since_last_match=${c.days_since_last_match??"NA"}`;case"028":return`matches_30d=${c.matches_30d}; distinct_tournaments_30d=${c.distinct_tournaments_30d}; days_since_last_match=${c.days_since_last_match??"NA"}`;case"030":return value030(c,player,tournament,asOfDate);case"064":return`qualifying_matches_14d=${c.qualifying_matches_14d}; current_event_schedule_rows=${c.scheduled_current_event_rows}; match_history_schedule_rows=${c.match_history_schedule_rows}; schedule_context=${c.schedule_context_kind}`;case"071":return`days_since_last_match=${c.days_since_last_match??"NA"}; current_event_schedule_rows=${c.scheduled_current_event_rows}; match_history_schedule_rows=${c.match_history_schedule_rows}; schedule_context=${c.schedule_context_kind}`;case"076":return`matches_14d=${c.matches_14d}; qualifying_matches_14d=${c.qualifying_matches_14d}; days_since_last_match=${c.days_since_last_match??"NA"}`;case"081":return`matches_30d=${c.matches_30d}; distinct_tournaments_30d=${c.distinct_tournaments_30d}; qualifying_matches_14d=${c.qualifying_matches_14d}`;default:return null;}}
async function playerObservationRows(p1:string,p2:string,start:string,asOfDate:string,select:string){const aliases=[...new Set([...safeEvidenceAliases(p1,p2),...safeEvidenceAliases(p2,p1)])];const results=await Promise.all(aliases.map(alias=>db.from("source_observations").select(select).gte("event_date",start).lte("event_date",asOfDate).ilike("player_name",`%${alias}%`).order("event_date",{ascending:false}).limit(2500)));if(results.some(result=>result.error))return null;const dedup=new Map<string,Observation>();for(const result of results)for(const row of(result.data??[])as Observation[]){const key=String(row.id??[row.source_id,row.player_name,row.opponent_name,row.tournament,row.event_date,row.observation_key,row.text_value].join("|"));dedup.set(key,row);}return[...dedup.values()];}

export async function deterministicResultsScheduleMetric(args:{metricCode:string;p1:string;p2:string;asOfDate:string;tournament?:string|null;round?:string|null;tour?:string|null;tourFamily?:EvidenceTourFamily|null;eventLevel?:string|null;context?:string|null;}):Promise<MetricFinding|null>{
  const code=codeOf(args.metricCode);
  if(HISTORICAL_SUPPORTED.has(code))return deterministicHistoricalResultsMetric({...args,metricCode:code});
  if(!SCHEDULE_SUPPORTED.has(code))return null;
  const start=new Date(`${args.asOfDate}T00:00:00Z`);start.setUTCFullYear(start.getUTCFullYear()-5);const startDate=start.toISOString().slice(0,10);
  const select="id,source_id,source_name,source_url,player_name,opponent_name,tournament,event_date,surface,observation_type,observation_key,text_value,sample_label,raw_payload,provenance";
  const aliases=[...new Set([...safeEvidenceAliases(args.p1,args.p2),...safeEvidenceAliases(args.p2,args.p1)])];
  const historySelect="id,canonical_key,player1_name,player2_name,player1_id,player2_id,tournament_name,event_level,round,scheduled_date,scheduled_local_at,scheduled_utc_at";
  const[playerRowsResult,sharedResult,historyResult]=await Promise.all([playerObservationRows(args.p1,args.p2,startDate,args.asOfDate,select),db.from("source_observations").select(select).gte("event_date",startDate).lte("event_date",args.asOfDate).is("player_name",null).order("event_date",{ascending:false}).limit(2000),db.from("matches").select(historySelect).in("player1_name",aliases).in("player2_name",aliases).order("created_at",{ascending:false}).limit(2000)]);
  if(!playerRowsResult||sharedResult.error||historyResult.error)return null;
  let rows=([...playerRowsResult,...(sharedResult.data??[])]as Observation[]).filter(row=>metricAllowsObservation(code,row));
  const repositoryContext=inferRepositoryMatchContext({p1:args.p1,p2:args.p2,asOfDate:args.asOfDate,tournament:args.tournament});
  const expectedFamily=inferExpectedFamily({...args,context:args.context??repositoryContext},rows,args.p1,args.p2)??classifyEvidenceTourFamily(repositoryContext);
  const historyRows=(historyResult.data??[])as MatchHistoryRow[];
  if(!expectedFamily)return null;
  rows.push(...repositoryResultsRows(args.p1,expectedFamily,args.asOfDate),...repositoryResultsRows(args.p2,expectedFamily,args.asOfDate));
  const seen=new Set<string>();rows=rows.filter(row=>{const key=[row.source_id,row.player_name,row.opponent_name,row.tournament,row.event_date,row.observation_key,row.text_value].join("|");if(seen.has(key))return false;seen.add(key);return true;});
  const playerRows=rows.filter(r=>(evidenceNameMatches(r.player_name,args.p1,args.p2)||evidenceNameMatches(r.player_name,args.p2,args.p1))&&evidenceTourCompatible(expectedFamily,observationTourFamily(r)));
  const currentHistory=currentEventHistoryRows(historyRows,{p1:args.p1,p2:args.p2,asOfDate:args.asOfDate,tournament:args.tournament,round:args.round},expectedFamily);if(currentHistory.length>1)return null;if(!playerRows.length&&!currentHistory.length)return null;
  const uniqueHistory=currentHistory.length===1?currentHistory[0]:null;const canonicalMatch=buildCanonicalEvidenceMatchIdentity({player1StableId:uniqueHistory?.player1_id,player2StableId:uniqueHistory?.player2_id,player1Name:args.p1,player2Name:args.p2,tournament:args.tournament??uniqueHistory?.tournament_name,date:args.asOfDate,round:args.round??uniqueHistory?.round,tour:expectedFamily,eventLevel:args.eventLevel??uniqueHistory?.event_level});
  const c1=componentsFor(args.p1,args.p2,rows,args.asOfDate,args.tournament??null,expectedFamily,historyRows,args.round),c2=componentsFor(args.p2,args.p1,rows,args.asOfDate,args.tournament??null,expectedFamily,historyRows,args.round),p1=valueFor(code,c1,args.p1,args.tournament??null,args.asOfDate),p2=valueFor(code,c2,args.p2,args.tournament??null,args.asOfDate);if(!p1||!p2)return null;
  // certifyMetricFinding (the same conservative, tested, never-upgrades-only-
  // downgrades safety net applied in deterministic-market-metrics.server.ts --
  // see docs/metric-audit-019-market-calibration.md) is required here too: for
  // code 012 (Fatigue/Workload), valueFor's "matches_Nd=...; days_since_last_
  // match=..." text has no exact-component marker the registered 012 policy
  // requires (matches-in-7-days, minutes, sets/games, three-setters, late
  // finish, rest-hours, qualifying, or travel/timezone) -- it's exactly the
  // bare match-count/date proxy metric-certification.test.ts's "rejects a
  // 28-day/date-only proxy" case already proves must be UNAVAILABLE, not
  // PARTIAL. Without this, that proxy counted as usable evidence on the live
  // per-request path (this function feeds warehouse-first-researcher.server.ts
  // directly). Codes without a registered policy pass through unchanged.
  return certifyMetricFinding({metric_code:code,p1_value:p1,p2_value:p2,p1_treatment:"PARTIAL",p2_treatment:"PARTIAL",differential:null,evidence_family:"RESULTS_SCHEDULE",reliability:80,sample:`deterministic four-tour warehouse/repository components through ${args.asOfDate}; tour_family=${expectedFamily}; match_identity=${canonicalMatch.key}`,unavailable_reason:null,sources:sources(rows)});
}
