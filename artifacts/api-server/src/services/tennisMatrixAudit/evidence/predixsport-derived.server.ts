import { readFileSync } from "node:fs";
import { isBeforeCutoff } from "./temporal-boundary";

import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";
import { getRuntimeHistoricalStats } from "./runtime-tennis-index.server";

const SOURCE_URL="https://www.kaggle.com/datasets/predixsport/sports-elo-ratings";
const SOURCE_NAME="PredixSport public tennis ratings (CC BY 4.0)";
type Row=Record<string,string>;
let cache:Row[]|null=null;
function norm(v:string){return v.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function toks(v:string){return norm(v).split(" ").filter(Boolean);}
function num(v:string|undefined){const n=Number(v);return Number.isFinite(n)?n:null;}
function parseCsv(text:string){const rows:string[][]=[];let row:string[]=[],cell="",q=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(q&&text[i+1]==='"'){cell+='"';i++;}else q=!q;}else if(ch===","&&!q){row.push(cell);cell="";}else if((ch==="\n"||ch==="\r")&&!q){if(ch==="\r"&&text[i+1]==="\n")i++;row.push(cell);cell="";if(row.some(Boolean))rows.push(row);row=[];}else cell+=ch;}if(cell||row.length){row.push(cell);rows.push(row);}if(!rows.length)return[];const h=rows[0].map(x=>x.trim());return rows.slice(1).map(c=>Object.fromEntries(h.map((k,i)=>[k,(c[i]??"").trim()])));}
function load(){if(cache)return cache;try{return cache=parseCsv(readFileSync(join(process.cwd(),"data/public/predixsport/atp/atp_elo_matches.csv"),"utf8"));}catch{return [];}}
function resolve(rows:Row[],name:string){const n=norm(name),names=[...new Set(rows.map(r=>r.player).filter(Boolean))],exact=names.filter(x=>norm(x)===n);if(exact.length===1)return exact[0];const t=toks(name),last=t[t.length-1];if(!last)return null;const c=names.filter(x=>{const xt=toks(x);if(xt[xt.length-1]!==last)return false;const s=new Set(xt);return t.length===1||t.every(v=>s.has(v));});return c.length===1?c[0]:null;}
function cutoff(context:string){return context.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1]??null;}
function surface(context:string){return context.match(/surface\s+(hard|clay|grass|carpet)/i)?.[1]?.toLowerCase()??null;}
function stat(player:string,key:string,value:number,sample:number,surf:string|null):SourcedStat{return{key,player,value,surface:surf,window:"PRE_MATCH_HISTORY",tour_level:null,sample,origin:"RECONSTRUCTED",sources:[{source_name:SOURCE_NAME,url:SOURCE_URL,retrieved_at:new Date().toISOString()}]};}
function oppElo(all:Row[],opp:string,date:string,surf:string|null){const n=norm(opp),r=all.filter(x=>norm(x.player??"")===n&&(!date||!x.date||x.date<=date)&&(!surf||!x.surface||x.surface.toLowerCase()===surf)).sort((a,b)=>(a.date||"").localeCompare(b.date||""));const z=r[r.length-1];return z?num(z.elo_pre)??num(z.elo_post):null;}
function mean(a:number[]){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function sd(a:number[]){const m=mean(a);return m===null||a.length<2?null:Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));}

export function getDerivedHistoricalStats(player:string,context:string):SourcedStat[]{
 const all=load(),canonical=resolve(all,player);if(!canonical)return getRuntimeHistoricalStats(player,context);const cut=cutoff(context),surf=surface(context);if(!cut)return[];/*Phase 13: unestablished boundary => no admissible evidence.*/const _d=0;void _d;
 const rows=all.filter(r=>r.player===canonical&&(isBeforeCutoff(r.date,cut))).sort((a,b)=>(a.date||"").localeCompare(b.date||""));if(!rows.length)return getRuntimeHistoricalStats(player,context);
 const use=surf?rows.filter(r=>(r.surface??"").toLowerCase()===surf):rows,recent=use.slice(-20),last10=use.slice(-10),out:SourcedStat[]=[];const add=(k:string,v:number|null,n:number)=>{if(v!==null&&Number.isFinite(v))out.push(stat(player,k,v,n,surf));};
 if(cut){const end=Date.parse(`${cut}T00:00:00Z`),start=end-365*86400000,yr=use.filter(r=>{const t=Date.parse(`${r.date}T00:00:00Z`);return Number.isFinite(t)&&t>=start&&t<end;});add("surface_win_pct_52w",yr.length?100*yr.filter(r=>r.won==="1").length/yr.length:null,yr.length);add("surface_matches_52w",yr.length,yr.length);}
 if(last10.length>=6){const p=last10.slice(0,Math.max(1,last10.length-5)),q=last10.slice(-5),wp=(x:Row[])=>100*x.filter(r=>r.won==="1").length/x.length;add("recent_performance_acceleration",wp(q)-wp(p),last10.length);}
 const wins=last10.filter(r=>r.won==="1"),conceded=wins.map(r=>num(r.sets_against)).filter((x):x is number=>x!==null);add("avg_sets_conceded_in_recent_wins",mean(conceded),conceded.length);
 const margins=recent.map(r=>{const sf=num(r.sets_for),sa=num(r.sets_against);return sf!==null&&sa!==null?sf-sa:null;}).filter((x):x is number=>x!==null);
 add("set_margin_mean",mean(margins),margins.length);
 // Metric 011: match-to-match performance variance and an observed recent floor/ceiling
 // range use the same transparent performance measure (set differential), not Elo movement.
 add("performance_variance",sd(margins),margins.length);
 if(margins.length) add("performance_floor_ceiling_set_margin_range",Math.max(...margins)-Math.min(...margins),margins.length);
 const close=recent.filter(r=>{const sf=num(r.sets_for),sa=num(r.sets_against);return sf!==null&&sa!==null&&(sf+sa===3||sf+sa===5);});add("deciding_match_reliance_pct",recent.length?100*close.length/recent.length:null,recent.length);add("close_match_win_pct",close.length?100*close.filter(r=>r.won==="1").length/close.length:null,close.length);
 const deltas=recent.map(r=>{const a=num(r.elo_pre),b=num(r.elo_post);return a!==null&&b!==null?b-a:null;}).filter((x):x is number=>x!==null);if(deltas.length){add("recent_elo_delta_mean",mean(deltas),deltas.length);add("recent_elo_delta_variance",sd(deltas),deltas.length);add("recent_elo_best_delta",Math.max(...deltas),deltas.length);add("recent_elo_worst_delta",Math.min(...deltas),deltas.length);add("floor_ceiling_elo_range",Math.max(...deltas)-Math.min(...deltas),deltas.length);}
 const comparable=recent.filter(r=>{const own=num(r.elo_pre),oe=oppElo(all,r.opponent??"",r.date??"",surf);return own!==null&&oe!==null&&Math.abs(own-oe)<=100;});add("comparable_strength_win_pct",comparable.length?100*comparable.filter(r=>r.won==="1").length/comparable.length:null,comparable.length);
 // Kept for strength-based diagnostics only. This is Elo-strength resistance,
 // NOT the master 011 "lower-ranked opponent" Upset Resistance metric.
 let weakerOpp=0,weakerLoss=0;for(const r of recent){const own=num(r.elo_pre),oe=oppElo(all,r.opponent??"",r.date??"",surf);if(own!==null&&oe!==null&&own-oe>=100){weakerOpp++;if(r.won==="0")weakerLoss++;}}add("upset_resistance_pct",weakerOpp?100*(1-weakerLoss/weakerOpp):null,weakerOpp);
 const comparableStraightWins=comparable.filter(r=>r.won==="1"&&num(r.sets_against)===0).length;add("straight_set_match_win_pct_comparable",comparable.length?100*comparableStraightWins/comparable.length:null,comparable.length);
 if(cut){const end=Date.parse(`${cut}T00:00:00Z`),start=end-14*86400000,q=rows.filter(r=>{const t=Date.parse(`${r.date}T00:00:00Z`);return Number.isFinite(t)&&t>=start&&t<end&&/qual|q[1-3]?/i.test(r.round??"");});add("qualifying_matches_last_14_days",q.length,q.length);}
 return out;
}
