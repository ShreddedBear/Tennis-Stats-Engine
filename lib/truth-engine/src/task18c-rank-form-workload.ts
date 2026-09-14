import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import type { EvidenceTourFamily } from "./evidence-match-identity";

export type HistoryEntry = [unknown, unknown, unknown, unknown, unknown, unknown, unknown];
export type HistoryLane = Record<string, HistoryEntry[]>;
// Task 20 reconciliation: this file previously also targeted "005", "007", "021", and
// "061". That was based on a stale reading of the catalog since corrected: real 005 is
// "Recent Form" (a normal reconstructable player metric, since built out separately in
// historical-results-recovery.ts) and real 061 ("Final Advanced Tests") is
// UNKNOWN_REQUIRES_REVIEW, not PROCESS_META -- see metric-classification.ts's UNKNOWN
// array, which keeps it in the player denominator pending a human decision on whether to
// split it (two of its three defined sub-items are meta model-robustness re-runs, one is a
// legitimately reconstructable Historical Twin Match Search). Neither 005 nor 061 belongs
// in this file regardless: 005 already has its own dedicated engine, and 061's one
// reconstructable sub-item has no engine yet and is out of this file's scope (rank/form/Elo
// content), not excluded from the player universe. Real 007 ("Common-Opponent Network") has nothing to do with the workload content
// (matches_7/14/30d, days since last match) that was filed under it here; that content is
// an exact match for real code 012 ("Fatigue/Workload"), which deterministic-results-schedule-metrics.server.ts
// already computes correctly and completely, so retargeting it here would only recreate a
// duplicate/shadowing engine rather than add anything. The old "021" branch (overall +
// surface Elo differential) is not real 021 ("Surface & Environmental Context": surface
// transitions, altitude, weather, age curve, etc. -- already correctly served by
// deterministic-environment-metrics.server.ts) at all; "Elo Win Probability: the win
// probability implied purely by the Elo rating differential" is instead an exact bullet
// match for real code 001 ("Surface Strength"), which this file already partially serves,
// so the Elo-differential content was merged into the existing 001 entry rather than
// discarded. See task18c-rank-form-workload.test.ts for the reconciled expectations.
export type HistoryMetricCode = "001";
export type HistoryMetricResult = { p1_value:string; p2_value:string; differential:string|null; treatment:"RECONSTRUCTED"|"PARTIAL"; reliability:number; unavailable_reason:string|null; sample:string; source_names:string[] };
type Match={key:string;date:string;tournament:string;surface:string;round:string;p1:string;p2:string;winner:string;source:string};
type Perspective={date:string;tournament:string;surface:string;round:string;player:string;opponent:string;won:boolean;pre_elo:number;opponent_pre_elo:number;pre_surface_elo:number;opponent_pre_surface_elo:number};
type Replay={overall:Map<string,number>;surface:Map<string,Map<string,number>>;perspectives:Perspective[];source_names:string[]};
const DAY_MS=86_400_000,K=32;
function dateOk(v:unknown){return /^\d{4}-\d{2}-\d{2}$/.test(String(v??"").slice(0,10));}
function daysBefore(date:string,asOf:string){return Math.floor((Date.parse(`${asOf}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`))/DAY_MS);}
function surfaceKey(v:unknown){return String(v??"").trim().toLowerCase();}
function roundOrder(v:string){const x=v.trim().toUpperCase().replace(/[^A-Z0-9]/g,"");const o:Record<string,number>={Q1:1,Q2:2,Q3:3,R128:10,R64:20,R32:30,R16:40,QF:50,SF:60,F:70};return o[x]??35;}
function expected(a:number,b:number){return 1/(1+10**((b-a)/400));}
function update(a:number,b:number,aWon:boolean){const s=aWon?1:0;return [a+K*(s-expected(a,b)),b+K*((1-s)-expected(b,a))] as const;}
function getSurfaceRating(store:Map<string,Map<string,number>>,surface:string,player:string){let bucket=store.get(surface);if(!bucket){bucket=new Map();store.set(surface,bucket);}return{bucket,rating:bucket.get(player)??1500};}
function pct(w:number,t:number){return t?Number((100*w/t).toFixed(1)):null;}
const rounded=(v:number)=>Math.round(v);const unique=(v:string[])=>[...new Set(v.filter(Boolean))].sort();
export function laneMatchesBefore(lane:HistoryLane,asOfDate:string):Match[]{const matches=new Map<string,Match|null>();for(const[playerKey,rows]of Object.entries(lane??{})){const player=normalizeEvidenceIdentity(playerKey);if(!player||!Array.isArray(rows))continue;for(const entry of rows){const[dateRaw,tournamentRaw,surfaceRaw,opponentRaw,wonRaw,roundRaw,sourceRaw]=entry;const date=String(dateRaw??"").slice(0,10);if(!dateOk(date)||date>=asOfDate)continue;const opponent=normalizeEvidenceIdentity(String(opponentRaw??""));if(!opponent||opponent===player||(wonRaw!==0&&wonRaw!==1))continue;const tournament=String(tournamentRaw??"").trim(),surface=surfaceKey(surfaceRaw),round=String(roundRaw??"").trim(),source=String(sourceRaw??"").trim()||"Repository four-tour history";const pair=[player,opponent].sort();const key=[date,normalizeEvidenceIdentity(tournament),surface,normalizeEvidenceIdentity(round),pair[0],pair[1]].join("|");const winner=wonRaw===1?player:opponent;const candidate={key,date,tournament,surface,round,p1:pair[0],p2:pair[1],winner,source};const existing=matches.get(key);if(existing===null)continue;if(existing&&existing.winner!==winner){matches.set(key,null);continue;}if(!existing)matches.set(key,candidate);}}return[...matches.values()].filter((m):m is Match=>Boolean(m)).sort((a,b)=>a.date.localeCompare(b.date)||roundOrder(a.round)-roundOrder(b.round)||a.key.localeCompare(b.key));}
export function replayElo(lane:HistoryLane,asOfDate:string):Replay{const overall=new Map<string,number>(),surface=new Map<string,Map<string,number>>(),perspectives:Perspective[]=[],sources:string[]=[];for(const match of laneMatchesBefore(lane,asOfDate)){const a=overall.get(match.p1)??1500,b=overall.get(match.p2)??1500,aWon=match.winner===match.p1,surfaceName=match.surface||"unknown",sa=getSurfaceRating(surface,surfaceName,match.p1),sb=getSurfaceRating(surface,surfaceName,match.p2),[nextA,nextB]=update(a,b,aWon),[nextSa,nextSb]=update(sa.rating,sb.rating,aWon);overall.set(match.p1,nextA);overall.set(match.p2,nextB);sa.bucket.set(match.p1,nextSa);sb.bucket.set(match.p2,nextSb);perspectives.push({date:match.date,tournament:match.tournament,surface:match.surface,round:match.round,player:match.p1,opponent:match.p2,won:aWon,pre_elo:a,opponent_pre_elo:b,pre_surface_elo:sa.rating,opponent_pre_surface_elo:sb.rating},{date:match.date,tournament:match.tournament,surface:match.surface,round:match.round,player:match.p2,opponent:match.p1,won:!aWon,pre_elo:b,opponent_pre_elo:a,pre_surface_elo:sb.rating,opponent_pre_surface_elo:sa.rating});sources.push(match.source);}return{overall,surface,perspectives,source_names:unique(sources)};}
function playerRows(replay:Replay,player:string){const key=normalizeEvidenceIdentity(player);return replay.perspectives.filter(r=>r.player===key).sort((a,b)=>b.date.localeCompare(a.date));}
function recent(rows:Perspective[],asOf:string,days:number){return rows.filter(r=>{const d=daysBefore(r.date,asOf);return d>0&&d<=days;});}
function surfaceStrengthValue(replay:Replay,rows:Perspective[],asOf:string,player:string,currentSurface:string){const key=normalizeEvidenceIdentity(player),surfaceRows=recent(rows.filter(r=>r.surface===currentSurface),asOf,365);if(!surfaceRows.length)return null;const wins=surfaceRows.filter(r=>r.won).length,rating=replay.surface.get(currentSurface)?.get(key);if(!Number.isFinite(rating))return null;return`surface=${currentSurface}; surface_elo=${rounded(rating!)}; matches_52w=${surfaceRows.length}; wins_52w=${wins}; win_pct_52w=${pct(wins,surfaceRows.length)}`;}
function eloValue(replay:Replay,player:string,currentSurface:string|null){const key=normalizeEvidenceIdentity(player),overall=replay.overall.get(key);if(!Number.isFinite(overall))return null;const surface=currentSurface?replay.surface.get(currentSurface)?.get(key):null;return`overall_elo=${rounded(overall!)}; surface=${currentSurface??"NA"}; surface_elo=${Number.isFinite(surface)?rounded(surface!):"NA"}; k=${K}; initial=1500`;}
export function computeHistoryMetric(args:{code:HistoryMetricCode;p1:string;p2:string;asOfDate:string;family:EvidenceTourFamily;surface?:string|null;lane:HistoryLane}):HistoryMetricResult|null{const replay=replayElo(args.lane,args.asOfDate),p1Rows=playerRows(replay,args.p1),p2Rows=playerRows(replay,args.p2);if(!p1Rows.length||!p2Rows.length)return null;const currentSurface=surfaceKey(args.surface)||null;let p1:string|null=null,p2:string|null=null,differential:string|null=null;const treatment:"RECONSTRUCTED"|"PARTIAL"="RECONSTRUCTED",reliability=86,unavailableReason:string|null=null;let window="strict pre-match chronology",calculation="deterministic K=32 Elo replay";
  const elo1=eloValue(replay,args.p1,currentSurface),elo2=eloValue(replay,args.p2,currentSurface);if(!elo1||!elo2)return null;
  // "Elo Win Probability" (public/seed/metrics.txt #1) is its own named,
  // precisely-defined bullet -- "the win probability implied purely by the
  // Elo rating differential" -- not the raw point delta. The delta alone is
  // a correlated/neighboring statistic for that value, not the value itself
  // (exactly the substitution the HOUSE_RULES firewall in
  // audit-research.server.ts forbids); the standard Elo logistic formula
  // (`expected`, already used above to run the replay) computes the exact
  // named quantity, so report it too rather than leaving the AI/downstream
  // reader to infer a probability from a point spread on their own.
  const a=replay.overall.get(normalizeEvidenceIdentity(args.p1)),b=replay.overall.get(normalizeEvidenceIdentity(args.p2));differential=Number.isFinite(a)&&Number.isFinite(b)?`overall_elo_delta_p1_minus_p2=${rounded(a!-b!)}; elo_win_probability_p1=${(100*expected(a!,b!)).toFixed(1)}%`:null;
  const strength1=currentSurface?surfaceStrengthValue(replay,p1Rows,args.asOfDate,args.p1,currentSurface):null,strength2=currentSurface?surfaceStrengthValue(replay,p2Rows,args.asOfDate,args.p2,currentSurface):null;
  p1=strength1?`${elo1}; ${strength1}`:elo1;p2=strength2?`${elo2}; ${strength2}`:elo2;
  window=currentSurface?"pre-match Elo chronology + trailing 52 weeks surface record":"pre-match Elo chronology";calculation="deterministic K=32 Elo replay + Elo differential"+(strength1&&strength2?" + surface Elo/W-L":"");
  if(!p1||!p2)return null;const sample=[`source_observations=${replay.perspectives.length/2}`,`date_window=${window}`,`players=${args.p1} vs ${args.p2}`,`calculation=${calculation}`,"output=pair-complete",`metric=${args.code}`,`tour=${args.family}`,`match_date=${args.asOfDate}`,"future_leakage=blocked(date<match_date)"].join("; ");return{p1_value:p1,p2_value:p2,differential,treatment,reliability,unavailable_reason:unavailableReason,sample,source_names:replay.source_names};}
