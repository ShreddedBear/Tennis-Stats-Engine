import type { SourcedStat } from "./reconstruction/engine";

const SOURCE_NAME="Uploaded match context / verified weather context";
function sources(){return[{source_name:SOURCE_NAME,url:"local://match-context",retrieved_at:new Date().toISOString()}];}
function stat(player:string,key:string,value:number):SourcedStat{return{key,player,value,surface:null,window:"MATCH_CONTEXT",tour_level:null,sample:1,origin:"RECONSTRUCTED",sources:sources()};}
function token(ctx:string,label:string){const m=ctx.match(new RegExp(`(?:^|·|\\s)${label}\\s+([^·]+)`,`i`));return m?.[1]?.trim()??null;}
function number(v:string|null){if(!v)return null;const m=v.match(/-?\d+(?:\.\d+)?/);if(!m)return null;const n=Number(m[0]);return Number.isFinite(n)?n:null;}
function fahrenheitToCelsius(f:number){return(f-32)*5/9;}
function mphToKph(m:number){return m*1.609344;}
export function getWeatherContextStats(player:string,context:string):SourcedStat[]{const out:SourcedStat[]=[];
 const tempRaw=token(context,"(?:temperature|temp)");let temp=number(tempRaw);if(temp!==null){if(/°?f\b|fahrenheit/i.test(tempRaw??""))temp=fahrenheitToCelsius(temp);if(temp>=-30&&temp<=60)out.push(stat(player,"match_temperature_c",temp));}
 const humidity=number(token(context,"humidity"));if(humidity!==null&&humidity>=0&&humidity<=100)out.push(stat(player,"match_humidity_pct",humidity));
 const windRaw=token(context,"(?:wind|wind_speed)");let wind=number(windRaw);if(wind!==null){if(/mph/i.test(windRaw??""))wind=mphToKph(wind);if(wind>=0&&wind<=250)out.push(stat(player,"match_wind_kph",wind));}
 const altitudeRaw=token(context,"(?:altitude|elevation)");let altitude=number(altitudeRaw);if(altitude!==null){if(/\bft\b|feet/i.test(altitudeRaw??""))altitude*=0.3048;if(altitude>=-500&&altitude<=9000)out.push(stat(player,"match_altitude_m",altitude));}
 const roof=(token(context,"roof")??"").toLowerCase();if(/closed/.test(roof))out.push(stat(player,"match_roof_closed",1));else if(/open/.test(roof))out.push(stat(player,"match_roof_closed",0));
 return out;}
