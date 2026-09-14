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
function cut(ctx:string){return ctx.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1]??null;}
function tournament(ctx:string){return ctx.match(/tournament\s+([^·]+)/i)?.[1]?.trim()??null;}
function round(ctx:string){return ctx.match(/round\s+([^·]+)/i)?.[1]?.trim()??null;}
function level(ctx:string){return ctx.match(/level\s+([^·]+)/i)?.[1]?.trim()??null;}
function stat(p:string,k:string,v:number,n:number):SourcedStat{return{key:k,player:p,value:v,surface:null,window:"PRE_MATCH_HISTORY",tour_level:null,sample:n,origin:"RECONSTRUCTED",sources:[{source_name:SOURCE_NAME,url:SOURCE_URL,retrieved_at:new Date().toISOString()}]};}
// Phase 16 fix: an unestablished boundary or an undated row used to mean "admit this
// row" (`!c||!r.date||r.date<c`), which let post-match/future rows leak in whenever the
// audited match's context carried no parseable date. It now fails closed: no cutoff means
// no admissible evidence at all, matching temporal-boundary.ts's contract. Exported as a
// pure function of `allRows` (not the file-reading `getTournamentContextStats` below) so
// the leakage guarantee is directly unit-testable without touching the filesystem.
export function computeTournamentContextStatsFromRows(allRows:Row[],player:string,context:string):SourcedStat[]{const c=cut(context);if(!c)return[];const tn=tournament(context),rn=round(context),lv=level(context),n=norm(player),rows=allRows.filter(r=>norm(r.player??"")===n&&isBeforeCutoff(r.date,c));if(!rows.length)return[];const out:SourcedStat[]=[];
 const trows=tn?rows.filter(r=>norm(field(r,["tournament","tourney_name","event","event_name"])??"")===norm(tn)):[];if(trows.length){const w=trows.filter(r=>r.won==="1").length;out.push(stat(player,"same_tournament_matches",trows.length,trows.length),stat(player,"same_tournament_win_pct",100*w/trows.length,trows.length));}
 const rrows=rn?rows.filter(r=>norm(field(r,["round","round_name"])??"")===norm(rn)):[];if(rrows.length){const w=rrows.filter(r=>r.won==="1").length;out.push(stat(player,"same_round_matches",rrows.length,rrows.length),stat(player,"same_round_win_pct",100*w/rrows.length,rrows.length));}
 const lrows=lv?rows.filter(r=>norm(field(r,["level","event_level","tourney_level","tour_level"])??"")===norm(lv)):[];if(lrows.length){const w=lrows.filter(r=>r.won==="1").length;out.push(stat(player,"same_level_matches",lrows.length,lrows.length),stat(player,"same_level_win_pct",100*w/lrows.length,lrows.length));}
 const recent=rows.slice(-10),switches=recent.slice(1).reduce((n,r,i)=>{const a=field(recent[i],["tournament","tourney_name","event","event_name"]),b=field(r,["tournament","tourney_name","event","event_name"]);return n+(a&&b&&norm(a)!==norm(b)?1:0);},0);if(recent.length>1)out.push(stat(player,"tournament_switches_last10",switches,recent.length));
 const countries=recent.map(r=>field(r,["country","event_country","tourney_country","location_country"])).filter((x):x is string=>!!x);if(countries.length>1){let changes=0;for(let i=1;i<countries.length;i++)if(norm(countries[i])!==norm(countries[i-1]))changes++;out.push(stat(player,"country_changes_last10",changes,countries.length));}
 return out;}
export function getTournamentContextStats(player:string,context:string):SourcedStat[]{return computeTournamentContextStatsFromRows(rowsFor(player),player,context);}
