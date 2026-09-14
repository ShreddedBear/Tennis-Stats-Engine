import { readFileSync } from "node:fs";
import { isBeforeCutoff } from "./temporal-boundary";

import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";

const SOURCE_URL="https://www.kaggle.com/datasets/predixsport/sports-elo-ratings";
const SOURCE_NAME="PredixSport public tennis ratings (CC BY 4.0)";
type Row=Record<string,string>;
let cache:Row[]|null=null;

function norm(v:string){return v.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function tokens(v:string){return norm(v).split(" ").filter(Boolean);}
function num(v:string|undefined){const n=Number(v);return Number.isFinite(n)?n:null;}
function parseCsv(text:string){const rows:string[][]=[];let row:string[]=[],cell="",q=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(q&&text[i+1]==='"'){cell+='"';i++;}else q=!q;}else if(ch===","&&!q){row.push(cell);cell="";}else if((ch==="\n"||ch==="\r")&&!q){if(ch==="\r"&&text[i+1]==="\n")i++;row.push(cell);cell="";if(row.some(Boolean))rows.push(row);row=[];}else cell+=ch;}if(cell||row.length){row.push(cell);rows.push(row);}if(!rows.length)return[];const h=rows[0].map(x=>x.trim());return rows.slice(1).map(c=>Object.fromEntries(h.map((k,i)=>[k,(c[i]??"").trim()])));}
function load(){if(cache)return cache;try{return cache=parseCsv(readFileSync(join(process.cwd(),"data/public/predixsport/atp/atp_elo_matches.csv"),"utf8"));}catch{return [];}}
function resolve(rows:Row[],name:string){const n=norm(name),names=[...new Set(rows.map(r=>r.player).filter(Boolean))];const exact=names.filter(x=>norm(x)===n);if(exact.length===1)return exact[0];const t=tokens(name),last=t[t.length-1];if(!last)return null;const c=names.filter(x=>{const xt=tokens(x);if(xt[xt.length-1]!==last)return false;const s=new Set(xt);return t.length===1||t.every(v=>s.has(v));});return c.length===1?c[0]:null;}
function cutoff(context:string){return context.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1]??null;}
function surface(context:string){return context.match(/surface\s+(hard|clay|grass|carpet)/i)?.[1]?.toLowerCase()??null;}
function stat(player:string,key:string,value:number,sample:number,surfaceValue:string|null):SourcedStat{return{key,player,value,surface:surfaceValue,window:"PRE_MATCH_HISTORY",tour_level:null,sample,origin:"RECONSTRUCTED",sources:[{source_name:SOURCE_NAME,url:SOURCE_URL,retrieved_at:new Date().toISOString()}]};}
function winPct(rows:Row[]){return rows.length?100*rows.filter(r=>r.won==="1").length/rows.length:null;}
function setPct(rows:Row[]){const sw=rows.reduce((s,r)=>s+(num(r.sets_for)??0),0),sl=rows.reduce((s,r)=>s+(num(r.sets_against)??0),0);return sw+sl?100*sw/(sw+sl):null;}
function straightPct(rows:Row[]){const wins=rows.filter(r=>r.won==="1");return wins.length?100*wins.filter(r=>num(r.sets_against)===0).length/wins.length:null;}
function withinDays(rows:Row[],cut:string|null,days:number){if(!cut)return[];const end=Date.parse(`${cut}T00:00:00Z`),start=end-days*86400000;return rows.filter(r=>{const t=Date.parse(`${r.date}T00:00:00Z`);return Number.isFinite(t)&&t>=start&&t<end;});}
function latestOpponentElo(all:Row[],opponent:string,date:string,surf:string|null){const n=norm(opponent);const candidates=all.filter(r=>norm(r.player??"")===n&&(!date||!r.date||r.date<=date)&&(!surf||!r.surface||r.surface.toLowerCase()===surf)).sort((a,b)=>(a.date||"").localeCompare(b.date||""));const r=candidates[candidates.length-1];return r?num(r.elo_pre)??num(r.elo_post):null;}

export function getRecentReconstruction(player:string,context:string):SourcedStat[]{
 const all=load(),canonical=resolve(all,player);if(!canonical)return[];const cut=cutoff(context),surf=surface(context);if(!cut)return[];/*Phase 13: unestablished boundary => no admissible evidence.*/const _r=0;void _r;const rows=all.filter(r=>r.player===canonical&&(isBeforeCutoff(r.date,cut))).sort((a,b)=>(a.date||"").localeCompare(b.date||""));if(!rows.length)return[];
 const last10=rows.slice(-10),last5=rows.slice(-5),last3=rows.slice(-3),surfaceRecent=surf?rows.filter(r=>(r.surface??"").toLowerCase()===surf).slice(-10):last10;const d7=withinDays(rows,cut,7),d14=withinDays(rows,cut,14),d28=withinDays(rows,cut,28),d60=withinDays(rows,cut,60),d90=withinDays(rows,cut,90);const out:SourcedStat[]=[];
 const add=(key:string,v:number|null,sample:number)=>{if(v!==null&&Number.isFinite(v))out.push(stat(player,key,v,sample,surf));};
 add("last5_win_pct",winPct(last5),last5.length);add("last10_win_pct",winPct(last10),last10.length);add("last5_set_win_pct",setPct(last5),last5.length);add("last10_set_win_pct",setPct(last10),last10.length);add("recent_straight_set_control_pct",straightPct(last10),last10.length);add("current_surface_recent_win_pct",winPct(surfaceRecent),surfaceRecent.length);add("win_pct_60d",winPct(d60),d60.length);add("win_pct_90d",winPct(d90),d90.length);
 const firstHalf=last10.slice(0,Math.floor(last10.length/2)),secondHalf=last10.slice(Math.floor(last10.length/2));const a=winPct(firstHalf),b=winPct(secondHalf);add("recent_form_trend",a!==null&&b!==null?b-a:null,last10.length);
 const recentElos=last10.map(r=>num(r.elo_post)??num(r.elo_pre)).filter((x):x is number=>x!==null);if(recentElos.length>=2)add("surface_elo_trend",recentElos[recentElos.length-1]-recentElos[0],recentElos.length);
 const current=recentElos[recentElos.length-1]??null,peak=rows.flatMap(r=>[num(r.elo_pre),num(r.elo_post)].filter((x):x is number=>x!==null));if(current!==null&&peak.length)add("peak_vs_current_elo_gap",Math.max(...peak)-current,rows.length);
 add("matches_last_7_days",d7.length,d7.length);add("matches_last_14_days",d14.length,d14.length);add("matches_last_28_days",d28.length,d28.length);add("sets_last_14_days",d14.reduce((s,r)=>s+(num(r.sets_for)??0)+(num(r.sets_against)??0),0),d14.length);add("three_setters_last_14_days",d14.filter(r=>(num(r.sets_for)??0)+(num(r.sets_against)??0)===3).length,d14.length);
 if(cut&&rows.length){const last=rows[rows.length-1]?.date;if(last){const rest=(Date.parse(`${cut}T00:00:00Z`)-Date.parse(`${last}T00:00:00Z`))/86400000;add("rest_days",rest,1);}}
 const oq=last10.map(r=>latestOpponentElo(all,r.opponent??"",r.date??"",surf)).filter((x):x is number=>x!==null);if(oq.length)add("recent_opponent_avg_elo",oq.reduce((s,x)=>s+x,0)/oq.length,oq.length);const winOq=last10.filter(r=>r.won==="1").map(r=>latestOpponentElo(all,r.opponent??"",r.date??"",surf)).filter((x):x is number=>x!==null);if(winOq.length)add("best_recent_win_opponent_elo",Math.max(...winOq),winOq.length);
 const ownCurrent=current; if(ownCurrent!==null){let bad=0,eligible=0;for(const r of last10.filter(r=>r.won==="0")){const oe=latestOpponentElo(all,r.opponent??"",r.date??"",surf);if(oe!==null){eligible++;if(oe<=ownCurrent-100)bad++;}}if(eligible)add("bad_loss_rate_pct",100*bad/eligible,eligible);}
 const seq=rows.map(r=>r.won).filter(x=>x==="0"||x==="1");if(seq.length){const last=seq[seq.length-1],sign=last==="1"?1:-1;let streak=0;for(let i=seq.length-1;i>=0&&seq[i]===last;i--)streak++;add("current_streak_signed",sign*streak,seq.length);let best=0,run=0;for(const x of seq){if(x==="1"){run++;best=Math.max(best,run);}else run=0;}add("longest_win_streak_observed",best,seq.length);}
 return out;
}
