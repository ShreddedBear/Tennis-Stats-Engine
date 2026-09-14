import type { SourcedStat } from "./reconstruction/engine";
import { getStrengthTrajectoryStats } from "./predixsport-strength.server";
import { getDerivedHistoricalStats } from "./predixsport-derived.server";

/**
 * Ranking-performance context that is safe without an official ranking feed.
 * IMPORTANT: Elo is NOT an ATP/WTA ranking. This module never labels Elo as rank.
 * It reconstructs performance-vs-strength signals only. Official rank/ranking points
 * remain unavailable until a commercially compatible ranking source is connected.
 */
export function getRankingPerformanceStats(player:string,context:string):SourcedStat[]{
  const all=[...getStrengthTrajectoryStats(player,context),...getDerivedHistoricalStats(player,context)];
  const by=new Map(all.map(s=>[s.key,s]));
  const out:SourcedStat[]=[];
  const base=by.get("current_overall_elo")??by.get("current_surface_elo")??null;
  const add=(key:string,value:number|null,sample:number)=>{if(value===null||!Number.isFinite(value)||!base)return;out.push({...base,key,value,sample,origin:"RECONSTRUCTED"});};
  const cur=by.get("current_overall_elo")?.value??null,peak=by.get("career_observed_peak_elo")?.value??null;
  const form20=by.get("overall_recent20_win_pct")?.value??null,comp=by.get("comparable_strength_win_pct")?.value??null;
  const surface52=by.get("surface_win_pct_52w")?.value??null,trend=by.get("elo_change_last20")?.value??null;
  add("strength_vs_peak_pct",cur!==null&&peak&&peak>0?100*cur/peak:null,by.get("current_overall_elo")?.sample??0);
  add("performance_vs_comparable_strength_pct",comp,by.get("comparable_strength_win_pct")?.sample??0);
  add("recent_form_strength_signal",form20!==null&&trend!==null?form20+Math.max(-20,Math.min(20,trend/5)):null,by.get("overall_recent20_win_pct")?.sample??0);
  add("surface_performance_strength_signal",surface52!==null&&cur!==null?surface52+(cur-1500)/50:null,by.get("surface_win_pct_52w")?.sample??0);
  add("favorite_fragility_strength_gap",peak!==null&&cur!==null?peak-cur:null,by.get("career_observed_peak_elo")?.sample??0);
  add("observed_vs_expected_wl_gap_pct",form20!==null&&comp!==null?form20-comp:null,Math.min(by.get("overall_recent20_win_pct")?.sample??0,by.get("comparable_strength_win_pct")?.sample??0));
  return out;
}
