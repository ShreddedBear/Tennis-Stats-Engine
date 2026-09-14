import { auditWarehouseDb } from "./postgrestCompat";
import type { MetricFinding, SourceRef } from "./audit-pipeline";
import { metricAllowsObservation } from "./metric-source-family-policy";

const db=auditWarehouseDb as any;

type Row={source_id:string|null;source_name:string|null;source_url:string|null;observation_type:string|null;observation_key:string|null;text_value:string|null;event_date:string|null;};

function sources(rows:Row[]):SourceRef[]{const seen=new Set<string>();const out:SourceRef[]=[];for(const r of rows){if(!r.source_name)continue;const k=`${r.source_name}|${r.source_url??""}`;if(seen.has(k))continue;seen.add(k);out.push({source_name:r.source_name,url:r.source_url,retrieved_at:null});}return out;}

export async function deterministicRulesContextMetric(args:{metricCode:string;p1:string;p2:string;asOfDate:string;context?:string|null}):Promise<MetricFinding|null>{
  const code=String(args.metricCode).match(/(\d{1,3})$/)?.[1]?.padStart(3,"0")??String(args.metricCode).padStart(3,"0");
  if(code!=="075")return null;
  const {data,error}=await db.from("source_observations").select("source_id,source_name,source_url,observation_type,observation_key,text_value,event_date").lte("event_date",args.asOfDate).order("event_date",{ascending:false}).limit(300);
  if(error)return null;
  const rows=((data??[]) as Row[]).filter(r=>metricAllowsObservation(code,r));
  if(!rows.length)return null;
  const keys=[...new Set(rows.map(r=>r.observation_key).filter(Boolean))];
  const context=String(args.context??"");
  const bestOf=context.match(/best of\s+(\d)/i)?.[1]??"NA";
  const indoor=/\bindoor\b/i.test(context)?"indoor":/\boutdoor\b/i.test(context)?"outdoor":"NA";
  const value=`best_of=${bestOf}; setting=${indoor}; objective_rule_components=${keys.join(",")}`;
  return {metric_code:"075",p1_value:value,p2_value:value,p1_treatment:"PARTIAL",p2_treatment:"PARTIAL",differential:null,evidence_family:"RULES_CONTEXT",reliability:85,sample:`official rules context through ${args.asOfDate}`,unavailable_reason:null,sources:sources(rows)};
}
