import type { SourcedStat } from "./reconstruction/engine";
import { getHistoricalServeReturnStats } from "./datahub-atp-serve-return.server";
import { getHistoricalScoreProfileStats } from "./datahub-atp-score-profile.server";

function pick(stats:SourcedStat[],key:string){return stats.find(s=>s.key===key)?.value??null;}
function src(stats:SourcedStat[]){return stats[0]??null;}
function statLike(base:SourcedStat,key:string,value:number):SourcedStat{return{...base,key,value,origin:"RECONSTRUCTED"};}
function clamp(v:number,min=0,max=100){return Math.max(min,Math.min(max,v));}

/**
 * Builds transparent statistical tendencies from observed serve/return/score data.
 * These are NOT subjective labels such as "aggressive baseliner" or "counterpuncher".
 * They are numeric proxies used only when the underlying statistics exist.
 */
export function getStyleProfileStats(player:string,context:string):SourcedStat[]{
  const sr=getHistoricalServeReturnStats(player,context), sp=getHistoricalScoreProfileStats(player,context), base=src(sr)??src(sp); if(!base)return[];
  const out:SourcedStat[]=[];
  const ace=pick(sr,"ace_rate_pct"), df=pick(sr,"double_fault_rate_pct"), hold=pick(sr,"hold_pct"), brk=pick(sr,"break_pct"), spw=pick(sr,"service_points_won_pct"), rpw=pick(sr,"return_points_won_pct"), tb=pick(sp,"tiebreak_win_pct"), dec=pick(sp,"historical_deciding_set_win_pct");
  if(ace!==null&&df!==null)out.push(statLike(base,"serve_aggression_proxy",clamp(50+2.5*(ace-df))));
  if(hold!==null&&brk!==null)out.push(statLike(base,"serve_reliance_proxy",clamp(50+(hold-(100-brk)))));
  if(rpw!==null&&brk!==null)out.push(statLike(base,"return_pressure_proxy",clamp((rpw+brk))));
  if(spw!==null&&rpw!==null)out.push(statLike(base,"balanced_efficiency_proxy",clamp(50+2*(spw+rpw-100))));
  if(tb!==null&&dec!==null)out.push(statLike(base,"close_match_resilience_proxy",clamp((tb+dec)/2)));
  return out;
}

/**
 * Pairwise style interaction derived from each player's numeric proxies.
 * Positive values mean this player's statistical profile is better positioned
 * relative to the opponent on the available dimensions; it is not a win probability.
 */
export function getStyleMatchupStats(player:string,opponent:string,context:string):SourcedStat[]{
  const a=getStyleProfileStats(player,context), b=getStyleProfileStats(opponent,context), base=src(a); if(!base)return[];
  const out:SourcedStat[]=[];
  const ap=(k:string)=>pick(a,k), bp=(k:string)=>pick(b,k);
  const serve=ap("serve_aggression_proxy"), oppReturn=bp("return_pressure_proxy"); if(serve!==null&&oppReturn!==null)out.push(statLike(base,"style_serve_vs_return_edge",serve-oppReturn));
  const ret=ap("return_pressure_proxy"), oppServe=bp("serve_aggression_proxy"); if(ret!==null&&oppServe!==null)out.push(statLike(base,"style_return_vs_serve_edge",ret-oppServe));
  const bal=ap("balanced_efficiency_proxy"), obal=bp("balanced_efficiency_proxy"); if(bal!==null&&obal!==null)out.push(statLike(base,"style_balance_edge",bal-obal));
  const res=ap("close_match_resilience_proxy"), ores=bp("close_match_resilience_proxy"); if(res!==null&&ores!==null)out.push(statLike(base,"style_resilience_edge",res-ores));
  return out;
}
