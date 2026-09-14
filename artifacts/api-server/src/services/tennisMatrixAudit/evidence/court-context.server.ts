import type { SourcedStat } from "./reconstruction/engine";

const CONTEXT_SOURCE="Uploaded match context / verified identity context";
function source(){return[{source_name:CONTEXT_SOURCE,url:"local://match-context",retrieved_at:new Date().toISOString()}];}
function stat(player:string,key:string,value:number,window="MATCH_CONTEXT"):SourcedStat{return{key,player,value,surface:null,window,tour_level:null,sample:1,origin:"RECONSTRUCTED",sources:source()};}
function token(ctx:string,label:string){const m=ctx.match(new RegExp(`${label}\\s+([^·]+)`,`i`));return m?.[1]?.trim()??null;}
function normalized(v:string|null){return(v??"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
export function getCourtContextStats(player:string,context:string):SourcedStat[]{const out:SourcedStat[]=[];const surface=normalized(token(context,"surface"));const indoorRaw=normalized(token(context,"indoor"));const courtSpeedRaw=normalized(token(context,"court(?:_| )?speed"));
 if(surface){if(/hard/.test(surface))out.push(stat(player,"match_surface_hard",1));else if(/clay/.test(surface))out.push(stat(player,"match_surface_clay",1));else if(/grass/.test(surface))out.push(stat(player,"match_surface_grass",1));else if(/carpet/.test(surface))out.push(stat(player,"match_surface_carpet",1));}
 if(indoorRaw){if(/^(true|yes|indoor|1)$/.test(indoorRaw))out.push(stat(player,"match_indoor",1));else if(/^(false|no|outdoor|0)$/.test(indoorRaw))out.push(stat(player,"match_indoor",0));}
 if(courtSpeedRaw){const n=Number(courtSpeedRaw);if(Number.isFinite(n)&&n>=0&&n<=100)out.push(stat(player,"verified_court_speed_index",n));else if(/very slow/.test(courtSpeedRaw))out.push(stat(player,"verified_court_speed_band",1));else if(/slow/.test(courtSpeedRaw))out.push(stat(player,"verified_court_speed_band",2));else if(/medium|neutral/.test(courtSpeedRaw))out.push(stat(player,"verified_court_speed_band",3));else if(/very fast/.test(courtSpeedRaw))out.push(stat(player,"verified_court_speed_band",5));else if(/fast/.test(courtSpeedRaw))out.push(stat(player,"verified_court_speed_band",4));}
 return out;}
