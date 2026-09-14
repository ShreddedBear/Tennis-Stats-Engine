import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";
import { isBeforeCutoff } from "./temporal-boundary";

const SOURCE_URL="https://www.kaggle.com/datasets/predixsport/sports-elo-ratings";
const SOURCE_NAME="PredixSport public tennis ratings (CC BY 4.0)";
type Row=Record<string,string>;let atp:Row[]|null=null,wta:Row[]|null=null;
function norm(v:string){return v.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function parse(text:string){const rows:string[][]=[];let r:string[]=[],c="",q=false;for(let i=0;i<text.length;i++){const x=text[i];if(x==='"'){if(q&&text[i+1]==='"'){c+='"';i++;}else q=!q;}else if(x===","&&!q){r.push(c);c="";}else if((x==='\n'||x==='\r')&&!q){if(x==='\r'&&text[i+1]==='\n')i++;r.push(c);c="";if(r.some(Boolean))rows.push(r);r=[];}else c+=x;}if(c||r.length){r.push(c);rows.push(r);}if(!rows.length)return[];const h=rows[0].map(x=>x.trim());return rows.slice(1).map(a=>Object.fromEntries(h.map((k,i)=>[k,(a[i]??"").trim()])));}
function load(kind:"ATP"|"WTA"){try{if(kind==="ATP"){if(atp)return atp;return atp=parse(readFileSync(join(process.cwd(),"data/public/predixsport/atp/atp_elo_matches.csv"),"utf8"));}if(wta)return wta;return wta=parse(readFileSync(join(process.cwd(),"data/public/predixsport/wta/wta_elo_ratings.csv"),"utf8"));}catch{return[];}}
function rowsFor(player:string){const n=norm(player),a=load("ATP").filter(r=>norm(r.player??"")===n);return a.length?a:load("WTA").filter(r=>norm(r.player??"")===n);}
function field(r:Row,names:string[]){for(const k of names){const hit=Object.keys(r).find(x=>norm(x)===norm(k));if(hit&&r[hit])return r[hit];}return null;}
function num(v:string|null){const n=Number(v);return Number.isFinite(n)?n:null;}
function cut(ctx:string){return ctx.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1]??null;}
function rad(x:number){return x*Math.PI/180;}function km(a:number,b:number,c:number,d:number){const R=6371,dl=rad(c-a),dn=rad(d-b),q=Math.sin(dl/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(q));}
function stat(p:string,k:string,v:number,n:number):SourcedStat{return{key:k,player:p,value:v,surface:null,window:"PRE_MATCH_HISTORY",tour_level:null,sample:n,origin:"RECONSTRUCTED",sources:[{source_name:SOURCE_NAME,url:SOURCE_URL,retrieved_at:new Date().toISOString()}]};}
// Phase 16 fix: same fail-open pattern as tournament-context.server.ts
// (`!c||!r.date||r.date<c`) -- no cutoff or no row date used to admit the row instead of
// excluding it. Now fails closed: no cutoff means no admissible evidence. Exported as a
// pure function of `allRows` (not the file-reading `getTravelBurdenStats` below) so the
// leakage guarantee is directly unit-testable without touching the filesystem.
export function computeTravelBurdenStatsFromRows(allRows:Row[],player:string,context:string):SourcedStat[]{const c=cut(context);if(!c)return[];const n=norm(player),rows=allRows.filter(r=>norm(r.player??"")===n&&isBeforeCutoff(r.date,c)).sort((a,b)=>(a.date||"").localeCompare(b.date||""));if(rows.length<2)return[];const recent=rows.slice(-10),out:SourcedStat[]=[];let total=0,legs=0,long=0;for(let i=1;i<recent.length;i++){const a=recent[i-1],b=recent[i],aLat=num(field(a,["lat","latitude","event_latitude","tourney_latitude"])),aLon=num(field(a,["lon","lng","longitude","event_longitude","tourney_longitude"])),bLat=num(field(b,["lat","latitude","event_latitude","tourney_latitude"])),bLon=num(field(b,["lon","lng","longitude","event_longitude","tourney_longitude"]));if(aLat===null||aLon===null||bLat===null||bLon===null)continue;const d=km(aLat,aLon,bLat,bLon);total+=d;legs++;if(d>=3000)long++;}if(legs){out.push(stat(player,"observed_travel_km_last10",total,legs),stat(player,"avg_observed_travel_km_per_move",total/legs,legs),stat(player,"long_haul_moves_3000km_plus_last10",long,legs));}
 const tz=recent.map(r=>num(field(r,["timezone_offset","utc_offset","event_utc_offset","timezone_offset_hours"]))).filter((x):x is number=>x!==null);if(tz.length>1){let shift=0,max=0;for(let i=1;i<tz.length;i++){const d=Math.abs(tz[i]-tz[i-1]);shift+=d;max=Math.max(max,d);}out.push(stat(player,"observed_timezone_shift_hours_last10",shift,tz.length-1),stat(player,"max_observed_timezone_shift_hours_last10",max,tz.length-1));}
 return out;}
export function getTravelBurdenStats(player:string,context:string):SourcedStat[]{return computeTravelBurdenStatsFromRows(rowsFor(player),player,context);}
