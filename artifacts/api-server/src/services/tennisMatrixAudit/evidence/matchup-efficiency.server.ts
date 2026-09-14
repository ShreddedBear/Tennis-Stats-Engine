import type { SourcedStat } from "./reconstruction/engine";
import { getHistoricalServeReturnStats } from "./datahub-atp-serve-return.server";

function pick(stats:SourcedStat[],key:string){return stats.find(s=>s.key===key)?.value??null;}
function base(stats:SourcedStat[]){return stats[0]??null;}
function statLike(src:SourcedStat,key:string,value:number):SourcedStat{return{...src,key,value,origin:"RECONSTRUCTED"};}

/**
 * Matchup-specific efficiency reconstructed from each player's historical
 * service/return rates. These are simple transparent interaction estimates,
 * not model probabilities and not current-form stats.
 */
export function getMatchupEfficiencyStats(player:string,opponent:string,context:string):SourcedStat[]{
 const p=getHistoricalServeReturnStats(player,context),o=getHistoricalServeReturnStats(opponent,context),src=base(p);if(!src)return[];
 const out:SourcedStat[]=[];
 const pHold=pick(p,"hold_pct"),pBreak=pick(p,"break_pct"),pSPW=pick(p,"service_points_won_pct"),pRPW=pick(p,"return_points_won_pct");
 const oHold=pick(o,"hold_pct"),oBreak=pick(o,"break_pct"),oSPW=pick(o,"service_points_won_pct"),oRPW=pick(o,"return_points_won_pct");
 if(pHold!==null&&oBreak!==null)out.push(statLike(src,"matchup_expected_hold_pct",(pHold+(100-oBreak))/2));
 if(pBreak!==null&&oHold!==null)out.push(statLike(src,"matchup_expected_break_pct",(pBreak+(100-oHold))/2));
 const eh=out.find(s=>s.key==="matchup_expected_hold_pct")?.value??null,eb=out.find(s=>s.key==="matchup_expected_break_pct")?.value??null;
 if(eh!==null&&eb!==null)out.push(statLike(src,"expected_hold_break_differential",eh-eb));
 if(pRPW!==null&&oRPW!==null&&oRPW>0)out.push(statLike(src,"dominance_ratio",pRPW/oRPW));
 if(pSPW!==null&&oRPW!==null)out.push(statLike(src,"serve_vs_opponent_return_edge",pSPW-(100-oRPW)));
 if(pRPW!==null&&oSPW!==null)out.push(statLike(src,"return_vs_opponent_serve_edge",pRPW-(100-oSPW)));
 if(pSPW!==null&&pRPW!==null)out.push(statLike(src,"combined_point_efficiency",pSPW+pRPW-100));
 return out;
}
