import { readFileSync } from "node:fs";
import { isBeforeCutoff } from "./temporal-boundary";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";

import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";

const SOURCE_URL="https://www.kaggle.com/datasets/predixsport/sports-elo-ratings";
const SOURCE_NAME="PredixSport public tennis ratings (CC BY 4.0)";
type Row=Record<string,string>;
let atpCache:Row[]|null=null,wtaCache:Row[]|null=null;
function norm(v:string){return v.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function parse(text:string){const rows:string[][]=[];let r:string[]=[],c="",q=false;for(let i=0;i<text.length;i++){const x=text[i];if(x==='"'){if(q&&text[i+1]==='"'){c+='"';i++;}else q=!q;}else if(x===","&&!q){r.push(c);c="";}else if((x==='\n'||x==='\r')&&!q){if(x==='\r'&&text[i+1]==='\n')i++;r.push(c);c="";if(r.some(Boolean))rows.push(r);r=[];}else c+=x;}if(c||r.length){r.push(c);rows.push(r);}if(!rows.length)return[];const h=rows[0].map(x=>x.trim());return rows.slice(1).map(a=>Object.fromEntries(h.map((k,i)=>[k,(a[i]??"").trim()])));}
function load(kind:"ATP"|"WTA"){try{if(kind==="ATP"){if(atpCache)return atpCache;return atpCache=parse(readFileSync(join(process.cwd(),"data/public/predixsport/atp/atp_elo_matches.csv"),"utf8"));}if(wtaCache)return wtaCache;return wtaCache=parse(readFileSync(join(process.cwd(),"data/public/predixsport/wta/wta_elo_ratings.csv"),"utf8"));}catch{return[];}}
function cutoff(ctx:string){return ctx.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1]??null;}
function stat(player:string,key:string,value:number,sample:number):SourcedStat{return{key,player,value,surface:null,window:"PRE_MATCH_HISTORY",tour_level:null,sample,origin:"RECONSTRUCTED",sources:[{source_name:SOURCE_NAME,url:SOURCE_URL,retrieved_at:new Date().toISOString()}]};}
// PHASE 2 producer fix -- metric 013's directional field was structurally impossible for
// every WTA player.
//
// The two PredixSport sources are not the same kind of file. ATP reads atp_elo_matches.csv
// (season,date,player,opponent,tournament,surface,tournament_type,WON,sets_for,...), a
// match-results file. WTA reads wta_elo_ratings.csv (season,date,player,tournament,surface,
// elo), a ratings TIMELINE with no won column and no opponent -- and no WTA matches file
// exists in that directory at all. computeAvailabilityStatsFromRows only emits
// return_after_layoff_win_pct when post-layoff rows carry won="0"/"1", so WTA players could
// produce layoff COUNTS but never the one field that says whether a layoff actually hurt
// them. That is exactly the "only a subset of rows carry the directional field" split seen
// live: every high-sample WTA player (Pegula 380, Bucsa 224, Navarro 192, Parks 179) is
// missing it while ATP players have it.
//
// The missing information already exists in this repo: the generated runtime index carries
// per-player chronological match history WITH win/loss, for all four lanes, as
// [date, tournament, surface, opponent, won, round, source]. So this reconstructs the WTA
// rows from data already held rather than introducing a new external source. ATP is
// untouched -- its CSV already carries won, and is still preferred whenever it has rows.
// The index's lanes do not agree on a name format: ATP keys are full names
// ("andres artunedo martinavarro") while WTA keys are surname-plus-initial ("pegula j",
// "navarro e", "suarez navarro c"). The shared evidence-player-alias matcher does not
// bridge those two forms (verified: evidenceNameMatches("pegula j","Jessica Pegula") is
// false), so a plain normalized comparison silently found nothing for every WTA player --
// which is why the first cut of this fix still produced no directional field for Pegula,
// Bucsa, Navarro or Parks.
//
// Deliberately kept local rather than added to evidence-player-alias: that module is
// depended on by the 25 active comparison metrics, and loosening name matching there could
// silently change their evidence. The rule here is strict -- the full surname must match
// exactly and the initial must match the given name's first letter -- so "navarro e"
// matches Emma Navarro but neither "navarro m f" nor any unrelated player.
function matchesAbbreviatedKey(indexKey:string,player:string){
  const keyTokens=norm(indexKey).split(" ").filter(Boolean),nameTokens=norm(player).split(" ").filter(Boolean);
  if(keyTokens.length<2||nameTokens.length<2)return false;
  const initial=keyTokens[keyTokens.length-1];
  if(initial.length!==1)return false;                       // not the abbreviated form
  const surname=keyTokens.slice(0,-1).join(" ");
  const givenInitial=nameTokens[0][0];
  return surname===nameTokens.slice(1).join(" ")&&initial===givenInitial;
}
function indexHistoryRows(player:string):Row[]{
  const key=norm(player); const out:Row[]=[];
  const history=loadRuntimeIndex().matchHistory as Record<string,Record<string,unknown[]>>;
  for(const lane of Object.keys(history??{})){
    for(const[playerKey,entries]of Object.entries(history[lane]??{})){
      if((norm(playerKey)!==key&&!matchesAbbreviatedKey(playerKey,player))||!Array.isArray(entries))continue;
      for(const entry of entries){
        if(!Array.isArray(entry))continue;
        const[dateRaw,tournamentRaw,surfaceRaw,opponentRaw,wonRaw]=entry as unknown[];
        const date=String(dateRaw??"").slice(0,10);
        // Only rows whose outcome is explicitly recorded as 0/1 are usable; an unknown
        // outcome is skipped rather than assumed a loss.
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||(wonRaw!==0&&wonRaw!==1))continue;
        out.push({date,player,opponent:String(opponentRaw??""),tournament:String(tournamentRaw??""),surface:String(surfaceRaw??""),won:String(wonRaw)});
      }
    }
  }
  // De-duplicate a player appearing in more than one lane on the same date/opponent.
  const seen=new Set<string>();
  return out.filter(r=>{const k=`${r.date}|${norm(r.opponent??"")}`;if(seen.has(k))return false;seen.add(k);return true;})
            .sort((a,b)=>(a.date||"").localeCompare(b.date||""));
}
function playerRows(player:string){const n=norm(player),atp=load("ATP").filter(r=>norm(r.player??"")===n);if(atp.length)return atp;const wta=load("WTA").filter(r=>norm(r.player??"")===n);
  // The WTA ratings file has no `won`, so it can never yield the directional field. Prefer
  // the index reconstruction when it actually covers this player; fall back to the ratings
  // rows (gap/layoff evidence only) when it does not, rather than losing that evidence too.
  if(!wta.some(r=>r.won==="0"||r.won==="1")){const reconstructed=indexHistoryRows(player);if(reconstructed.length)return reconstructed;}
  return wta;}
function dateMs(s:string){const t=Date.parse(`${s}T00:00:00Z`);return Number.isFinite(t)?t:null;}
// A gap between a player's last match of one calendar year and their first
// match of the next is the routine off-season break every tour player takes
// -- not an "Availability" signal (injury/withdrawal/retirement/medical
// timeout). Counting it as a "layoff" would flag essentially every player as
// having a 60-90+ day layoff every single season, which silently defeats the
// whole point of this metric (see docs/metric-audit-013-availability.md and
// the equivalent, already-fixed conflation for metric 077's off-season rest
// length in tennis-data-extended.server.ts). Only a gap that does NOT span a
// year boundary is counted here as an observed mid-season layoff.
function crossesCalendarYearBoundary(earlierDate:string,laterDate:string){return earlierDate.slice(0,4)!==laterDate.slice(0,4);}
export function computeAvailabilityStatsFromRows(rows:Row[],player:string,c:string|null):SourcedStat[]{if(!c)return[];/*Phase 13: unestablished boundary => no admissible evidence.*/rows=[...rows].filter(r=>isBeforeCutoff(r.date,c)).sort((a,b)=>(a.date||"").localeCompare(b.date||""));if(!rows.length||!c)return[];const out:SourcedStat[]=[],end=dateMs(c),last=rows[rows.length-1],lastMs=last?.date?dateMs(last.date):null;if(end!==null&&lastMs!==null)out.push(stat(player,"days_since_last_match",Math.max(0,(end-lastMs)/86400000),1));let longest=0,recentGap=0,gapsOver30=0,gapsOver60=0,gapsOver90=0,inSeasonGaps=0;for(let i=1;i<rows.length;i++){const a=dateMs(rows[i-1].date??""),b=dateMs(rows[i].date??"");if(a===null||b===null)continue;const d=(b-a)/86400000;recentGap=d;const offseason=crossesCalendarYearBoundary(rows[i-1].date??"",rows[i].date??"");if(offseason)continue;inSeasonGaps++;longest=Math.max(longest,d);if(d>=30)gapsOver30++;if(d>=60)gapsOver60++;if(d>=90)gapsOver90++;}out.push(stat(player,"longest_observed_layoff_days",longest,inSeasonGaps),stat(player,"recent_inter_match_gap_days",recentGap,Math.max(0,rows.length-1)),stat(player,"observed_layoffs_30d_plus",gapsOver30,inSeasonGaps),stat(player,"observed_layoffs_60d_plus",gapsOver60,inSeasonGaps),stat(player,"observed_layoffs_90d_plus",gapsOver90,inSeasonGaps));const returnMatches:Row[]=[];for(let i=1;i<rows.length;i++){const a=dateMs(rows[i-1].date??""),b=dateMs(rows[i].date??"");if(a===null||b===null)continue;if(crossesCalendarYearBoundary(rows[i-1].date??"",rows[i].date??""))continue;if((b-a)/86400000>=45)returnMatches.push(...rows.slice(i,Math.min(i+3,rows.length)));}const usable=returnMatches.filter(r=>r.won==="0"||r.won==="1");if(usable.length)out.push(stat(player,"return_after_layoff_win_pct",100*usable.filter(r=>r.won==="1").length/usable.length,usable.length));return out;}
export function getAvailabilityHistoryStats(player:string,context:string):SourcedStat[]{return computeAvailabilityStatsFromRows(playerRows(player),player,cutoff(context));}
