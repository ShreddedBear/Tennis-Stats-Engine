// ----------------------------------------------------------------------------
// AUDIT EXECUTION PIPELINE (pure orchestration — dependency injected)
//
// This module owns the end-to-end Run Audit execution:
//   identity -> context -> definition instantiation -> P1/P2 metric execution
//   -> verification -> disagreement -> dangerous underdog -> stress/removal
//   -> independent conclusion -> matrix reveal/comparison -> calibration -> gate
//
// It never touches Supabase or the AI provider directly; both arrive through
// `PipelineDeps`, which is what makes the regression test possible.
//
// MATRIX FIREWALL: no stage before CONCLUSION receives Matrix fields. The
// researcher is only handed matrix data at the MATRIX_COMPARISON stage.
// ----------------------------------------------------------------------------

import { evaluate, type EngineInput, type GateReport } from "./audit-engine";
import { STRESS_TESTS, UNDERDOG_PATHWAYS } from "./constants";
import { reconstruct, type SourcedStat } from "./reconstruction/engine";
import { familyOf } from "./reconstruction/stat-catalog";
import { classifyMetric } from "./metric-classification";
import { buildCalibrationSnapshot } from "./calibration-snapshot";
import { compareMetricRows, COMPARISON_SPECS, parseMetricValue } from "./truth-engine-metric-comparison";
import { decideTruthEngineSelection } from "./truth-engine-decision";
import { runTruthEngineAudit } from "./truth-engine-audit";
import { buildDecisionRecord } from "./truth-engine-decision-record";
import { matchSideForName } from "./match-result-resolution";
import { verificationRowPatch, disagreementRowPatch, underdogRowPatch, stressRowPatch, unmappedUnderdogPathways } from "./truth-engine-stage-mapping";
import { isActiveMetricCode, normalizeMetricCode } from "./truth-engine-active-metrics";
import { STAGES, STAGE_DEPENDENCIES, unmetDependencies, isActiveRunStatus, INVALIDATED_RUN_STATUS, type Stage } from "./audit-stages";
export { STAGES, STAGE_DEPENDENCIES, unmetDependencies, isActiveRunStatus, resolveActiveRun, INVALIDATED_RUN_STATUS, type Stage } from "./audit-stages";

// Task 20/21 canonical classification reconciliation: codes classified
// META_OR_NON_PLAYER in the canonical registry (public/seed/metrics.txt, see
// metric-classification.ts) describe how to test/calibrate the model's OWN
// predictions, not a player-level fact — there is no "player 1's value vs player 2's
// value" for them. They are instantiated as EXCLUDED (an existing, first-party
// treatment already subtracted from the coverage denominator in audit-engine.ts's
// coverageFor(), and already skipped by executeMetrics()'s `pending` filter) rather
// than deleted, so the rule definition itself is preserved for governance/documentation
// while no recovery engine is ever asked to produce player evidence for it.
function isProcessMetaRuleCode(ruleCode: string): boolean {
  return classifyMetric(ruleCode) === "META_OR_NON_PLAYER";
}

// A code with a real, documented determination that no legitimate obtainable/
// reconstructable evidence pathway exists (see PROTECTED_UNAVAILABLE_RECORDS in
// metric-classification.ts) is instantiated NO_SOURCE, distinct from and never merged
// with META_OR_NON_PLAYER's EXCLUDED, and likewise never asked for player evidence.
// UNKNOWN_REQUIRES_REVIEW codes (061, 047) are deliberately NOT NO_SOURCE -- they stay
// in the ordinary scoring path since the burden of proof for exclusion is not met.
// MATRIX_SUMMARY_REQUIRED codes (see metric-classification.ts) are quarantined from the
// ACTIVE pipeline pending real Tennis Matrix AI Summary evidence in the Truth Engine.
// They deliberately reuse this exact same settled-at-instantiation path rather than a
// second competing status system: row status NO_SOURCE, treatment UNAVAILABLE, never
// handed to a researcher, never blocking. What differs is only the recorded REASON (see
// instantiate() below), so a quarantine is never reported as "no legitimate pathway
// exists" and stays reversible.
function isNoSourceRuleCode(ruleCode: string): boolean {
  const classification = classifyMetric(ruleCode);
  return classification === "PROTECTED_UNAVAILABLE" || classification === "MATRIX_SUMMARY_REQUIRED";
}

function isMatrixSummaryQuarantinedRuleCode(ruleCode: string): boolean {
  return classifyMetric(ruleCode) === "MATRIX_SUMMARY_REQUIRED";
}

export const TREATMENTS=["DIRECT","RECONSTRUCTED","PARTIAL","UNAVAILABLE","EXCLUDED","NO_SOURCE"] as const;
export type Treatment=(typeof TREATMENTS)[number];

export interface SourceRef{source_name:string;url?:string|null;retrieved_at?:string|null;}
export interface IdentityFinding{player1_canonical:string|null;player2_canonical:string|null;player1_status:"VERIFIED"|"UNVERIFIED"|"CONFLICT";player2_status:"VERIFIED"|"UNVERIFIED"|"CONFLICT";tournament:string|null;event_level:string|null;round:string|null;scheduled_date:string|null;surface:string|null;indoor:boolean|null;best_of:number|null;surface_status:"VERIFIED"|"UNVERIFIED"|"CONFLICT";unresolved_reason:string|null;sources:SourceRef[];conflicts:Array<{field:string;values:string[];note:string|null}>;}
export interface MetricFinding{metric_code:string;p1_value:string|null;p2_value:string|null;p1_treatment:Treatment;p2_treatment:Treatment;differential:string|null;evidence_family:string|null;reliability:number|null;sample:string|null;unavailable_reason:string|null;p1_unavailable_reason?:string|null;p2_unavailable_reason?:string|null;provider_error?:string|null;missing_inputs?:string[];sources:SourceRef[];}
export interface RuleFinding{rule_code:string;p1_finding:string|null;p2_finding:string|null;outcome:"PASS"|"WARN"|"FAIL"|"UNAVAILABLE";severity:"STANDARD"|"CRITICAL"|null;decision_effect:string|null;contradiction_severity:"NONE"|"MINOR"|"MATERIAL"|"CRITICAL"|null;supporting_evidence:string|null;opposing_evidence:string|null;final_effect:string|null;unavailable_reason?:string|null;provider_error?:string|null;missing_inputs?:string[];sources:SourceRef[];}
export interface UnderdogFinding{pathway_code:string;player_side:string;classification:"UNRESOLVED"|"WEAK"|"REALISTIC"|"STRONG";evidence:string|null;repeatable:boolean;unavailable_reason:string|null;missing_inputs?:string[];sources?:SourceRef[];}
export interface StressFinding{test_code:string;winner_after:string|null;range_after:string|null;outcome:"STABLE"|"MOSTLY STABLE"|"UNSTABLE"|"FAILS";note:string|null;unavailable_reason?:string|null;missing_inputs?:string[];sources?:SourceRef[];}
export interface ConclusionFinding{winner:string|null;low:number|null;high:number|null;rationale:string|null;insufficient_reason:string|null;}
export interface EvidenceDigest{p1:string;p2:string;context:string;metrics:Array<{code:string;name:string;p1:string|null;p2:string|null;family:string|null}>;}
export interface Researcher{identity(input:{p1:string;p2:string;hints:Record<string,string|null>}):Promise<IdentityFinding>;dossier?(input:{player:string;opponent:string;context:string}):Promise<string>;extractStats?(input:{player:string;opponent?:string;dossier:string;context:string}):Promise<SourcedStat[]>;metrics(input:{p1:string;p2:string;context:string;auditDate?:string|null;dossier?:string;researchSide?:"p1"|"p2";researchPlayer?:string;researchOpponent?:string;metrics:Array<{code:string;name:string;body:string|null}>}):Promise<MetricFinding[]>;rules(input:{kind:"VERIFICATION"|"DISAGREEMENT";evidence:EvidenceDigest;rules:Array<{code:string;name:string;body:string|null;severity:string}>}):Promise<RuleFinding[]>;underdog(input:{evidence:EvidenceDigest;pathways:Array<{code:string;name:string}>;player_side:string;opponent:string}):Promise<UnderdogFinding[]>;conclusion(input:{evidence:EvidenceDigest;verificationSummary:string;disagreementSummary:string;underdogSummary:string}):Promise<ConclusionFinding>;stress(input:{evidence:EvidenceDigest;conclusion:ConclusionFinding;tests:Array<{code:string;name:string}>}):Promise<StressFinding[]>;}
export interface MatchRow{id:string;player1_name:string;player2_name:string;tournament_name:string|null;event_level:string|null;round:string|null;scheduled_date:string|null;surface:string|null;indoor:boolean|null;best_of:number|null;identity_status:string;surface_status:string;}
export interface RunRow{id:string;match_id:string;run_number:number;status:string;research_lock_at:string|null;independent_decision_committed_at:string|null;matrix_revealed_at:string|null;independent_winner:string|null;independent_low:number|null;independent_high:number|null;calibrated_low:number|null;calibrated_high:number|null;calibration_version_id:string|null;effective_evidence_count:number;metrics_version_id:string|null;verification_version_id:string|null;disagreement_version_id:string|null;lease_owner?:string|null;lease_expires_at?:string|null;heartbeat_at?:string|null;}
export interface RuleDef{id:string;rule_code:string;rule_name:string;body:string|null;severity:string;blocking:boolean;}
export interface StageRow{stage:string;status:string;attempts:number;error_message:string|null;done_count:number;total_count:number;}
export type ChildTable="metric_results"|"reconstruction_results"|"verification_results"|"disagreement_results"|"underdog_results"|"stress_results";
export interface PipelineDeps{now():Date;research:Researcher;getMatch(matchId:string):Promise<MatchRow|null>;updateMatch(matchId:string,patch:Record<string,unknown>):Promise<void>;getParsedFields(matchId:string):Promise<Record<string,string>>;getActiveVersionId(docType:string):Promise<string|null>;getRules(versionId:string):Promise<RuleDef[]>;getLatestRun(matchId:string):Promise<RunRow|null>;createRun(row:Partial<RunRow>&{match_id:string;run_number:number}):Promise<RunRow>;updateRun(runId:string,patch:Record<string,unknown>):Promise<void>;acquireRunLease?(runId:string,owner:string,leaseMs:number):Promise<boolean>;renewRunLease?(runId:string,owner:string,leaseMs:number):Promise<boolean>;releaseRunLease?(runId:string,owner:string):Promise<void>;list(table:ChildTable,runId:string):Promise<Array<Record<string,unknown>>>;insert(table:ChildTable,rows:Array<Record<string,unknown>>):Promise<void>;update(table:ChildTable,id:string,patch:Record<string,unknown>):Promise<void>;getStages(runId:string):Promise<StageRow[]>;setStage(runId:string,matchId:string,stage:Stage,patch:Record<string,unknown>):Promise<void>;saveIdentityRecords(matchId:string,rows:Array<Record<string,unknown>>):Promise<void>;saveSnapshots(runId:string,rows:Array<Record<string,unknown>>):Promise<void>;saveConflicts(runId:string,rows:Array<Record<string,unknown>>):Promise<void>;getCalibration(versionId?:string|null):Promise<{version:{id:string;label:string;version_number:number}|null;buckets:Array<{bucket_code:string;wp_min:number;wp_max:number;wins:number;graded:number}>}>;getDecisionId(runId:string):Promise<string|null>;saveDecision(runId:string,existingId:string|null,payload:Record<string,unknown>):Promise<void>;getConflicts(runId:string):Promise<Array<{critical:boolean;resolution_status:string}>>;getReconstructions(runId:string):Promise<Array<{status:string;player_side?:string;metric_code?:string}>>;saveCoverage(runId:string,rows:Array<Record<string,unknown>>):Promise<void>;saveCoverageRates(runId:string,rows:Array<Record<string,unknown>>):Promise<void>;verifyFinalPersistence?(runId:string,expectedMetricSides:number,expectedAuditComplete:boolean):Promise<void>;log(entry:Record<string,unknown>):Promise<void>;}
export interface PipelineResult{runId:string;complete:boolean;nextStage:Stage|null;stages:Array<{stage:Stage;status:string;detail:string}>;report:GateReport|null;failures:Array<{stage:Stage;message:string}>;leaseHeld?:boolean;}

const METRIC_BATCH=15,RULE_BATCH=20,DEFAULT_BUDGET_MS=45_000,RESEARCH_LOCK_TTL_MS=30*60_000;
const s=(v:unknown)=>(v===null||v===undefined?null:String(v));
function lockExpired(lockAt:string|null,now:Date):boolean{if(!lockAt)return false;const lockMs=new Date(lockAt).getTime();if(Number.isNaN(lockMs))return false;return now.getTime()-lockMs>RESEARCH_LOCK_TTL_MS;}
function providerReason(error:unknown):string{const m=error instanceof Error?error.message.toLowerCase():String(error??"").toLowerCase();if(m.includes("timeout")||m.includes("timed out"))return"PROVIDER_TIMEOUT";if(m.includes("401")||m.includes("403")||m.includes("auth")||m.includes("api key"))return"PROVIDER_AUTH_FAILED";if(m.includes("429")||m.includes("rate limit"))return"API_RATE_LIMIT";if(m.includes("402")||m.includes("credit")||m.includes("quota"))return"PROVIDER_CREDITS";if(m.includes("player")&&m.includes("not found"))return"PLAYER_NOT_FOUND";if(m.includes("match")&&m.includes("not found"))return"MATCH_NOT_FOUND";if(m.includes("surface"))return"SURFACE_DATA_NOT_FOUND";if(m.includes("parse")||m.includes("json"))return"PARSING_FAILED";return"PRODUCER_FAILED_WITHOUT_REASON";}
function errorDetail(error:unknown){return error instanceof Error?error.message.slice(0,800):error?String(error).slice(0,800):null;}
function digestFrom(match:MatchRow,metrics:Array<Record<string,unknown>>):EvidenceDigest{return{p1:match.player1_name,p2:match.player2_name,context:[match.tournament_name&&`tournament ${match.tournament_name}`,match.event_level&&`level ${match.event_level}`,match.round&&`round ${match.round}`,match.scheduled_date&&`date ${match.scheduled_date}`,match.surface&&`surface ${match.surface}`,match.indoor===null||match.indoor===undefined?null:match.indoor?"indoor":"outdoor",match.best_of&&`best of ${match.best_of}`].filter(Boolean).join(" · "),metrics:metrics.filter(m=>m["p1_value"]||m["p2_value"]).map(m=>({code:String(m["metric_code"]),name:String(m["metric_name"]),p1:s(m["p1_value"]),p2:s(m["p2_value"]),family:s(m["evidence_family"])}))};}
const treatmentToStatus=(t:Treatment)=>t==="UNAVAILABLE"?"UNAVAILABLE":t==="EXCLUDED"?"EXCLUDED":"COMPLETE";

// ----------------------------------------------------------------------------
// DEPENDENCY GATE: the single choke point every audit_stage_runs write with
// status "COMPLETE" must pass through, in every code path (the execution
// loop below, and any future writer). A downstream stage must not become
// COMPLETE merely because its own stage function ran -- it must prove every
// required upstream stage (per STAGE_DEPENDENCIES, audit-stages.ts) is
// ALREADY persisted COMPLETE in the same run. If not, the attempted
// completion is downgraded to BLOCKED with an UPSTREAM_DEPENDENCY_INCOMPLETE
// error instead of being written as COMPLETE.
// ----------------------------------------------------------------------------
export interface StageDependencyGuard{patch:Record<string,unknown>;blocked:boolean;missing:Stage[]}
export function enforceStageDependencies(stage:Stage,patch:Record<string,unknown>,rows:readonly{stage:string;status:string}[]):StageDependencyGuard{
  if(patch["status"]!=="COMPLETE")return{patch,blocked:false,missing:[]};
  const missing=unmetDependencies(stage,rows);
  if(!missing.length)return{patch,blocked:false,missing:[]};
  return{
    patch:{...patch,status:"BLOCKED",finished_at:null,error_code:"UPSTREAM_DEPENDENCY_INCOMPLETE",error_message:`Cannot complete ${stage}: upstream stage(s) not complete: ${missing.join(", ")}.`},
    blocked:true,
    missing,
  };
}

export async function runPipeline(deps:PipelineDeps,matchId:string,opts:{budgetMs?:number;forceNewRun?:boolean}={}):Promise<PipelineResult>{
  const budget=Math.max(1,opts.budgetMs??DEFAULT_BUDGET_MS),startedAt=Date.now(),deadline=startedAt+budget,outOfTime=()=>Date.now()>deadline;
  const match=await deps.getMatch(matchId);if(!match)throw new Error(`Match ${matchId} not found`);
  const run=await ensureRun(deps,match,opts.forceNewRun===true),failures:PipelineResult["failures"]=[];let nextStage:Stage|null=null;
  const owner=`audit:${matchId}:${startedAt}:${Math.random().toString(36).slice(2)}`;
  let leaseAcquired=false;
  const initial=await deps.getStages(run.id);
  const allComplete=STAGES.every(st=>initial.find(f=>f.stage===st)?.status==="COMPLETE");
  if(run.status==="COMPLETE"&&allComplete)return pipelineResult(deps,matchId,run.id,initial,[],null);
  if(deps.acquireRunLease){
    leaseAcquired=await deps.acquireRunLease(run.id,owner,Math.max(600_000,budget*3));
    if(!leaseAcquired){
      const waiting=STAGES.find(st=>initial.find(f=>f.stage===st)?.status!=="COMPLETE")??null;
      return pipelineResult(deps,matchId,run.id,initial,[],waiting,true);
    }
  }else leaseAcquired=true;
  const stageState=new Map(initial.map(r=>[r.stage,r]));
  try{
    for(const stage of STAGES){
      const current=stageState.get(stage);
      if(current?.status==="COMPLETE"){
        // Never trust a persisted COMPLETE at face value: prove every stage
        // STAGE_DEPENDENCIES requires ahead of it is ALSO COMPLETE. A stale or
        // out-of-order COMPLETE (leftover data, a bug elsewhere, a hand edit)
        // is downgraded and re-queued instead of silently propagating downstream.
        const staleGaps=unmetDependencies(stage,Array.from(stageState.values()));
        if(!staleGaps.length)continue;
        const message=`Stage ${stage} was marked COMPLETE but upstream stage(s) are not: ${staleGaps.join(", ")}. Downgraded for re-execution in dependency order.`;
        try{await deps.setStage(run.id,matchId,stage,{status:"BLOCKED",error_code:"UPSTREAM_DEPENDENCY_INCOMPLETE",error_message:message,finished_at:null,heartbeat_at:deps.now().toISOString()});}
        catch{/* best effort downgrade; a resumed call will retry this stage */}
        stageState.set(stage,{...(current as StageRow),status:"BLOCKED",error_message:message});
        failures.push({stage,message});nextStage=stage;break;
      }
      if(outOfTime()){nextStage=stage;break;}
      const preGaps=unmetDependencies(stage,Array.from(stageState.values()));
      if(preGaps.length){
        const message=`Cannot start ${stage}: upstream stage(s) not complete: ${preGaps.join(", ")}.`;
        try{await deps.setStage(run.id,matchId,stage,{status:"BLOCKED",error_code:"UPSTREAM_DEPENDENCY_INCOMPLETE",error_message:message,heartbeat_at:deps.now().toISOString()});}
        catch{/* best effort */}
        stageState.set(stage,{...(current??{stage,status:"BLOCKED",attempts:0,error_message:null,done_count:0,total_count:0}),status:"BLOCKED",error_message:message} as StageRow);
        failures.push({stage,message});nextStage=stage;break;
      }
      const attempts=(stageState.get(stage)?.attempts??0)+1;
      try{
        if(deps.renewRunLease&&!(await deps.renewRunLease(run.id,owner,Math.max(600_000,budget*3))))throw new Error("Audit execution lease was lost before starting this stage; it will be resumed safely.");
        await deps.setStage(run.id,matchId,stage,{status:"RUNNING",attempts,started_at:deps.now().toISOString(),heartbeat_at:deps.now().toISOString(),error_code:null,error_message:null});
        stageState.set(stage,{...(current??{}) as StageRow,stage,status:"RUNNING",attempts});
      }catch(e){
        const message=(e as Error).message||String(e);
        failures.push({stage,message:`Could not start or persist ${stage}: ${message}`});nextStage=stage;break;
      }
      const progress=async(done:number,total:number)=>{
        if(deps.renewRunLease&&!(await deps.renewRunLease(run.id,owner,Math.max(600_000,budget*3))))throw new Error("Audit execution lease was lost while this stage was running; it will be resumed safely.");
        await deps.setStage(run.id,matchId,stage,{status:"RUNNING",done_count:Math.max(0,done),total_count:Math.max(0,total),heartbeat_at:deps.now().toISOString(),error_code:null,error_message:null});
      };
      try{
        const outcome=await executeStage(deps,stage,matchId,run.id,{deadline,progress});
        if(deps.renewRunLease&&!(await deps.renewRunLease(run.id,owner,Math.max(600_000,budget*3))))throw new Error("Audit execution lease was lost before this stage could persist its result; the newer driver owns completion.");
        const partial=outcome.status==="PARTIAL";
        const basePatch={status:partial?"RUNNING":outcome.status,finished_at:partial?null:deps.now().toISOString(),heartbeat_at:deps.now().toISOString(),done_count:Math.max(0,outcome.done),total_count:Math.max(0,outcome.total),detail:outcome.detail??{},error_code:outcome.status==="FAILED"||outcome.status==="BLOCKED"?outcome.errorCode??null:null,error_message:outcome.status==="FAILED"||outcome.status==="BLOCKED"?outcome.message??null:null};
        const guard=enforceStageDependencies(stage,basePatch,Array.from(stageState.values()));
        await deps.setStage(run.id,matchId,stage,guard.patch);
        stageState.set(stage,{...(current??{}) as StageRow,stage,status:String(guard.patch["status"]),error_message:(guard.patch["error_message"]as string|null)??null});
        await deps.log({audit_run_id:run.id,match_id:matchId,stage,status:guard.patch["status"]as string,output:{done:outcome.done,total:outcome.total,...(outcome.detail??{}),...(guard.blocked?{upstream_gap:guard.missing}:{})},matrix_visible:["MATRIX REVEAL AND COMPARISON","CURRENT CALIBRATION APPLICATION","COVERAGE PERSISTENCE / EVIDENCE VALIDATION","FINAL DECISION","FINAL COMBINATION GATE"].includes(stage)});
        if(guard.blocked){failures.push({stage,message:guard.patch["error_message"]as string});nextStage=stage;break;}
        if(partial){nextStage=stage;break;}
        if(outcome.status!=="COMPLETE"){failures.push({stage,message:outcome.message??"stage did not complete"});nextStage=stage;break;}
      }catch(e){
        const message=(e as Error).message||String(e);
        try{await deps.setStage(run.id,matchId,stage,{status:"FAILED",finished_at:deps.now().toISOString(),heartbeat_at:deps.now().toISOString(),error_code:classify(message),error_message:message.slice(0,800)});}
        catch(writeError){const writeMessage=(writeError as Error).message||String(writeError);failures.push({stage,message:`${message} (additionally, could not persist FAILED status: ${writeMessage})`});nextStage=stage;break;}
        try{await deps.log({audit_run_id:run.id,match_id:matchId,stage,status:"FAILED",output:{error:message.slice(0,800)}});}catch{/* stage status is already persisted */}
        failures.push({stage,message});nextStage=stage;break;
      }
    }
    const finalStages=await deps.getStages(run.id),complete=STAGES.every(st=>finalStages.find(f=>f.stage===st)?.status==="COMPLETE");
    try{if(deps.renewRunLease&&!(await deps.renewRunLease(run.id,owner,Math.max(600_000,budget*3))))throw new Error("Audit execution lease was lost before final run status persistence.");await deps.updateRun(run.id,{status:complete?"COMPLETE":failures.length?"BLOCKED":"RUNNING",heartbeat_at:deps.now().toISOString()});}
    catch(e){failures.push({stage:nextStage??"FINAL COMBINATION GATE",message:`Could not persist audit run status: ${(e as Error).message||String(e)}`});}
    const report=await buildReport(deps,matchId,run.id);
    return{runId:run.id,complete:complete&&failures.length===0,nextStage:complete&&failures.length===0?null:nextStage??STAGES.find(st=>finalStages.find(f=>f.stage===st)?.status!=="COMPLETE")??null,stages:stageDetails(finalStages),report,failures};
  } finally {
    if(leaseAcquired&&deps.releaseRunLease)try{await deps.releaseRunLease(run.id,owner);}catch{/* expiry remains the recovery path */}
  }
}

function stageDetails(rows:StageRow[]):Array<{stage:Stage;status:string;detail:string}>{
  return STAGES.map(stage=>{const row=rows.find(item=>item.stage===stage);return{stage,status:row?.status??"PENDING",detail:row?(row.error_message?row.error_message:`${row.done_count}/${row.total_count}`):"not started"};});
}
function classify(message:string){const m=message.toLowerCase();if(m.includes("rate limit")||m.includes("429"))return"PROVIDER_RATE_LIMIT";if(m.includes("credit")||m.includes("402"))return"PROVIDER_CREDITS";if(m.includes("api key")||m.includes("unauthorized")||m.includes("401"))return"AUTH_OR_CONFIG";if(m.includes("timeout")||m.includes("timed out"))return"TIMEOUT";if(m.includes("no active")||m.includes("definition"))return"MISSING_DEFINITIONS";if(m.includes("json")||m.includes("parse"))return"PROVIDER_RESPONSE_INVALID";return"ORCHESTRATION_EXCEPTION";}
type UnavailableReason="NO_SOURCE_FOUND"|"PRODUCER_FAILED_WITHOUT_REASON"|"PROVIDER_TIMEOUT"|"PROVIDER_AUTH_FAILED"|"PLAYER_NOT_FOUND"|"MATCH_NOT_FOUND"|"SURFACE_DATA_NOT_FOUND"|"INSUFFICIENT_SAMPLE"|"MISSING_REQUIRED_INPUT"|"SOURCE_CONFLICT"|"RECONSTRUCTION_FAILED"|"API_RATE_LIMIT"|"PARSING_FAILED"|"HISTORICAL_DATA_UNAVAILABLE";
function unavailableReason(message:string):UnavailableReason{const v=message.toLowerCase();if(v.includes("timeout")||v.includes("timed out"))return"PROVIDER_TIMEOUT";if(v.includes("rate limit")||v.includes("429"))return"API_RATE_LIMIT";if(v.includes("auth")||v.includes("api key")||v.includes("401")||v.includes("403"))return"PROVIDER_AUTH_FAILED";if(v.includes("player")&&v.includes("not found"))return"PLAYER_NOT_FOUND";if(v.includes("match")&&v.includes("not found"))return"MATCH_NOT_FOUND";if(v.includes("surface"))return"SURFACE_DATA_NOT_FOUND";if(v.includes("sample"))return"INSUFFICIENT_SAMPLE";if(v.includes("missing")||v.includes("required input"))return"MISSING_REQUIRED_INPUT";if(v.includes("conflict"))return"SOURCE_CONFLICT";if(v.includes("parse")||v.includes("json"))return"PARSING_FAILED";if(v.includes("historical"))return"HISTORICAL_DATA_UNAVAILABLE";return"NO_SOURCE_FOUND";}
// A metric row is only genuine two-sided evidence for the Truth Engine's
// COMPARISON_SPECS if it actually carries the named field (or an approved
// bareScalarFallback) that spec expects -- never merely because a producer
// executed and returned SOME value. Live proof this matters: metrics 008/010
// have persisted bare, unlabeled counts (deciding_sets_won, sets_played, ...)
// under a self-claimed DIRECT treatment that never actually meant "deciding-set
// win %"; COMPARISON_SPECS deliberately withholds bareScalarFallback for them
// for exactly this reason (see its own comment). A value that doesn't carry
// the declared field is downgraded to UNAVAILABLE here rather than persisted
// as if it were usable evidence -- this can only make the evidence-coverage
// numerator more truthful, never fabricate a new value.
function normalizedMetricCode(code:string):string{const m=code.match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):code.padStart(3,"0");}
function usableAgainstComparisonSpec(code:string,value:string):boolean{
  const spec=COMPARISON_SPECS[normalizedMetricCode(code)];
  if(!spec)return true; // no declared comparison spec (one of the 56 inactive codes) -- nothing to validate against here
  const parsed=parseMetricValue(value);
  const named=[spec.field,...(spec.fieldAliases??[])].some(name=>name!==null&&Number.isFinite(Number(parsed.fields.get(name))));
  if(named)return true;
  return Boolean(spec.bareScalarFallback)&&parsed.scalar!==null;
}
export function metricPairPatch(f:MetricFinding|undefined,providerError:string|null,retrievedAt:string){
  const side=(key:"p1"|"p2")=>{
    let treatment=f?.[`${key}_treatment`]??"UNAVAILABLE";
    let value=f?.[`${key}_value`]??null;
    if(f?.metric_code&&value!==null&&(treatment==="DIRECT"||treatment==="RECONSTRUCTED"||treatment==="PARTIAL")&&!usableAgainstComparisonSpec(f.metric_code,value)){
      treatment="UNAVAILABLE";value=null;
    }
    const usable=treatment==="DIRECT"||treatment==="RECONSTRUCTED";
    // WHAT THE PRODUCER ACTUALLY SAID, kept separate from the generic placeholder below.
    // The machine-readable reason must be derived only from a real, producer-stated
    // explanation -- never from filler text this function wrote itself.
    const statedDetail=(value===null&&f?.[`${key}_value`]!==null&&f?.[`${key}_value`]!==undefined)
      ?`Producer returned a value for this metric, but it was missing the specific field this metric's comparison requires (only unrelated statistics were present).`
      :f?.[`${key}_unavailable_reason`]??f?.unavailable_reason??null;
    const sideDetail=statedDetail??(providerError?"Research provider did not return a result for this metric.":null);
    const detail=usable?null:sideDetail;
    // REASON RESOLUTION, most authoritative first. Both fallbacks used to collapse onto
    // NO_SOURCE_FOUND, which metric-activation-status.ts reads as SOURCE_EMPTY -- one of the
    // three statuses that EXCUSE a metric from the per-match evidence denominator. So a
    // provider error, and a producer that simply returned nothing and said nothing, were both
    // being recorded as "we asked and the source is genuinely empty". Neither proved that:
    //   * a provider error is a producer failure, so it is classified from the error itself;
    //   * no stated reason and no error proves nothing at all, so it is
    //     PRODUCER_FAILED_WITHOUT_REASON -- a real miss to fix, never a free excusal.
    // Only a producer's own stated explanation may still resolve to an evidence-based
    // absence, which is exactly the burden of proof the denominator policy asks for.
    const reason=usable?null
      :statedDetail?unavailableReason(statedDetail)
      :providerError?providerReason(providerError)
      :treatment==="PARTIAL"?"MISSING_REQUIRED_INPUT"
      :"PRODUCER_FAILED_WITHOUT_REASON";
    return{treatment,value,detail,reason,status:treatmentToStatus(treatment)};
  };
  const p1=side("p1"),p2=side("p2");
  const patch:Record<string,unknown>={
    p1_value:p1.value,p2_value:p2.value,p1_status:p1.status,p2_status:p2.status,
    p1_treatment:p1.treatment,p2_treatment:p2.treatment,
    status:p1.status==="COMPLETE"||p2.status==="COMPLETE"?"COMPLETE":"UNAVAILABLE",
    sources:f?.sources??[],reliability:f?.reliability??null,sample:f?.sample??null,
    unavailable_reason:p1.reason===p2.reason?p1.reason:"MISSING_REQUIRED_INPUT",
    unavailable_detail:p1.detail===p2.detail?p1.detail:`P1: ${p1.detail??"usable"} | P2: ${p2.detail??"usable"}`,
    provider_error:providerError,source_attempts:f?.sources??[],reconstruction_attempted:false,
    retrieved_at:retrievedAt,p1_unavailable_reason:p1.reason,p2_unavailable_reason:p2.reason,
    p1_provider_error:providerError,p2_provider_error:providerError,
    p1_retrieved_at:retrievedAt,p2_retrieved_at:retrievedAt,
    missing_inputs:f?.missing_inputs??[],reconstruction_reason:null,reconstruction_result:null,
  };
  if(f?.evidence_family)patch["evidence_family"]=f.evidence_family;
  if(f?.differential)patch["differential"]=f.differential;
  return patch;
}
export function preserveSettledOppositeSide(patch:Record<string,unknown>,row:Record<string,unknown>,side:"p1"|"p2"){
  const opposite=side==="p1"?"p2":"p1";
  const oppositeStatus=String(row[`${opposite}_status`]??"");
  if(!["COMPLETE","UNAVAILABLE","EXCLUDED","NO_SOURCE"].includes(oppositeStatus))return patch;
  for(const key of Object.keys(patch))if(key.startsWith(`${opposite}_`))delete patch[key];
  const priorSources=Array.isArray(row["sources"])?row["sources"]:[];
  const nextSources=Array.isArray(patch["sources"])?patch["sources"]:[];
  patch["sources"]=[...priorSources,...nextSources].filter((source,index,all)=>{
    const candidate=source as SourceRef;
    return all.findIndex(other=>{
      const item=other as SourceRef;
      return item.source_name===candidate.source_name&&item.url===candidate.url;
    })===index;
  });
  const currentStatus=String(patch[`${side}_status`]??"UNAVAILABLE");
  patch["status"]=currentStatus==="COMPLETE"||oppositeStatus==="COMPLETE"?"COMPLETE":"UNAVAILABLE";
  return patch;
}

export function preserveUsableCurrentSide(patch:Record<string,unknown>,row:Record<string,unknown>,side:"p1"|"p2"){
  const usable=(treatment:unknown,value:unknown)=>["DIRECT","RECONSTRUCTED","PARTIAL"].includes(String(treatment))&&String(value??"").trim()!=="";
  if(!usable(row[`${side}_treatment`],row[`${side}_value`])||usable(patch[`${side}_treatment`],patch[`${side}_value`]))return patch;
  // The retrieval timestamp is deliberately NOT dropped with the rest of the side's keys.
  // Keeping the prior VALUE is the point of this function; suppressing the record that this
  // side was re-attempted is not, and it is what left the P2 stage with no per-row evidence
  // of its own execution -- forcing the fragile positional resume cursor
  // metricRowsForSideExecution used to depend on. The value is preserved; the attempt is
  // still recorded.
  const attemptedAt=patch[`${side}_retrieved_at`];
  for(const key of Object.keys(patch))if(key.startsWith(`${side}_`))delete patch[key];
  if(attemptedAt!==undefined)patch[`${side}_retrieved_at`]=attemptedAt;
  for(const key of["unavailable_reason","unavailable_detail","provider_error","missing_inputs"])delete patch[key];
  patch["status"]="COMPLETE";
  return patch;
}

// ----------------------------------------------------------------------------
// PASS-2 (DOSSIER RECONSTRUCTION) WRITE-BACK GUARD
//
// executeMetrics' second pass extracts catalogued atomic statistics from the
// player dossier and routes them back onto metric_results rows by evidence
// FAMILY (reconstruction/stat-catalog.ts's familyOf). A family is a GROUP of
// related statistics, never one measurement: catalogue family "008" alone
// holds sets_played, sets_won, set_win_pct and several imported aliases, while
// the Truth Engine's metric 008 means exactly "deciding-set win %". Routing by
// family therefore took whichever member of the family the producer happened to
// emit FIRST and wrote it as that metric's value under a usable treatment --
// making this the one write path in the pipeline that never passed through
// usableAgainstComparisonSpec, the field-contract guard metricPairPatch already
// applies to every pass-1 write.
//
// Live proof, from the current production database (60 completed runs): 57 of
// 60 metric-008 rows and 57 of 60 metric-010 rows carry a BARE COUNT (ranges
// 0..915 and 0..280) under treatment DIRECT, for two metrics whose declared
// quantity is a percentage; metric 009 ("Pressure point win %") was likewise
// being written from catalogue family "009", which is deciding-set statistics.
//
// Three rules, every one of them derived from a contract that already exists in
// this codebase rather than newly invented:
//
//  1. ONLY A GRADEABLE CODE. A code with no COMPARISON_SPEC is never written.
//     That keeps this path away from the settled rows instantiate() deliberately
//     seeds EXCLUDED/NO_SOURCE (META_OR_NON_PLAYER codes, quarantined codes,
//     042) -- previously it iterated every row and could resurrect one of them
//     into COMPLETE, defeating the quarantine it is supposed to respect.
//
//  2. ONLY THE DECLARED QUANTITY. The chosen stat's own catalogue key must BE
//     the spec's declared `field` or one of its `fieldAliases`, and the value is
//     persisted in that metric's KEYED form (`straight_set_win_pct=63.2`) rather
//     than as a bare number. "Same family" is not knowledge of which
//     measurement a bare number is; the key is. Because the write is keyed, it
//     satisfies usableAgainstComparisonSpec through the named-field branch and
//     never depends on a bareScalarFallback that 008/010 deliberately withhold.
//     Selection is also no longer "whichever the provider emitted first", so the
//     persisted value cannot change with provider response ordering.
//
//  3. THE EVIDENCE MUST BELONG TO THE SIDE BEING WRITTEN. Every SourcedStat
//     carries the player it was extracted for. That name must resolve, through
//     matchSideForName, to exactly the side this write targets -- so a P1
//     extraction can never populate P2 and vice versa. matchSideForName is used
//     rather than a string compare because it is the codebase's existing
//     definition of "which side is this name", accent- and initial-tolerant, and
//     it returns null (refusing the write) when two players' surnames collide and
//     the name cannot be attributed to one side without guessing.
//
//  4. TERMINAL STATES ARE TERMINAL. A side settled EXCLUDED or NO_SOURCE is a
//     decision already taken (a META_OR_NON_PLAYER code, a quarantined code);
//     no evidence write may silently transition it back into COMPLETE. Rule 1
//     already excludes today's settled codes because none of them carries a
//     COMPARISON_SPEC, but that is a coincidence of the current registry, not a
//     guarantee -- this states the invariant directly so a future reclassification
//     cannot quietly reopen the path.
//
//  5. NEVER OVERWRITE, NEVER CLOBBER, ALWAYS ATTRIBUTE. A side already holding
//     usable evidence is left exactly as it is (the same rule
//     preserveUsableCurrentSide enforces on the pass-1 path). `sources` is a
//     shared, un-sided column, so it is MERGED with what the row already holds
//     rather than replaced -- replacing it is what left 44 of 45 metric-001 rows
//     attributing P1's number to P2's source -- and every entry this side-specific
//     pass contributes is stamped with `player_side`, so a merged array stays
//     attributable to the side it actually came from. Entries with no
//     `player_side` are the pass-1 researcher's, which genuinely describe both
//     sides at once.
//
// Returns null whenever any rule declines the write, which is the common case.
// ----------------------------------------------------------------------------
export interface Pass2WriteBackContext{p1Name:string;p2Name:string;retrievedAt:string}

export function pass2WriteBackPatch(
  row:Record<string,unknown>,
  side:"p1"|"p2",
  statsByFamily:ReadonlyMap<string,readonly SourcedStat[]>,
  context:Pass2WriteBackContext,
):Record<string,unknown>|null{
  const code=normalizedMetricCode(String(row["metric_code"]??"").replace(/^M/,""));
  const spec=COMPARISON_SPECS[code];
  if(!spec)return null;
  const declared=[spec.field,...(spec.fieldAliases??[])].filter((name):name is string=>typeof name==="string"&&name.length>0);
  if(!declared.length)return null;
  if(["EXCLUDED","NO_SOURCE"].includes(String(row[`${side}_status`]??""))||["EXCLUDED","NO_SOURCE"].includes(String(row[`${side}_treatment`]??"")))return null;
  const expectedSide=side==="p1"?"P1":"P2";
  const facts={player1_name:context.p1Name,player2_name:context.p2Name};
  const stat=(statsByFamily.get(code)??[]).find(candidate=>
    declared.includes(candidate.key)
    &&Number.isFinite(candidate.value)
    &&matchSideForName(candidate.player,facts)===expectedSide,
  );
  if(!stat)return null;
  const alreadyUsable=["DIRECT","RECONSTRUCTED","PARTIAL"].includes(String(row[`${side}_treatment`]??""))&&String(row[`${side}_value`]??"").trim()!=="";
  if(alreadyUsable)return null;
  const value=`${stat.key}=${stat.value}`;
  if(!usableAgainstComparisonSpec(code,value))return null;
  const priorSources=Array.isArray(row["sources"])?(row["sources"] as SourceRef[]):[];
  const attributed=(stat.sources??[]).map(source=>({...source,player_side:expectedSide}));
  const sources=[...priorSources,...attributed].filter((source,index,all)=>
    all.findIndex(other=>{
      const a=other as SourceRef&{player_side?:string},b=source as SourceRef&{player_side?:string};
      return a.source_name===b.source_name&&a.url===b.url&&(a.player_side??null)===(b.player_side??null);
    })===index,
  );
  return{
    [`${side}_value`]:value,
    [`${side}_status`]:"COMPLETE",
    [`${side}_treatment`]:stat.origin,
    [`${side}_unavailable_reason`]:null,
    [`${side}_provider_error`]:null,
    [`${side}_retrieved_at`]:context.retrievedAt,
    status:"COMPLETE",
    sources,
    source_attempts:sources,
    reconstruction_attempted:true,
    reconstruction_reason:stat.calculation??null,
    reconstruction_result:value,
  };
}

// ----------------------------------------------------------------------------
// RESUME SEMANTICS: has THIS side already been researched with itself as the
// research subject?
//
// Why the two sides cannot share one rule, and why P2 could not simply copy P1's:
// the researcher returns ONE paired finding carrying both players' values, so the
// P1 stage's write settles p2_status too (metricPairPatch writes both prefixes;
// preserveSettledOppositeSide only withholds a side that is ALREADY settled, and on
// the first P1 pass P2 is not). If P2 filtered on p2_status the way P1 filters on
// p1_status, its pending set would be empty on arrival and the P2 stage would never
// execute anything -- P2 would silently inherit whatever the P1-oriented research
// happened to say about it. That is precisely the evidence the P2 stage exists to
// obtain independently.
//
// The old workaround was a POSITIONAL cursor: slice(priorDone - protectedCount) into
// a sorted array. Position is not identity: any change in the row set or its ordering
// between two slices of the same stage moves the window and silently skips P2 rows,
// permanently and with no trace -- they would finish the run holding only whatever
// P1's paired pass left on them.
//
// HONEST SCOPE. That is a latent fragility, not the cause of the one-sided-evidence
// gap the gap audit measured (97 P1-only against 25 P2-only). A read-only check of all
// 1,500 active metric-sides in production found p2_retrieved_at strictly later than
// p1_retrieved_at on 1,500 of 1,500 -- every row did get its own P2-oriented pass, so
// the cursor skipped nothing in those runs. The measured gap concentrates in the
// history-fed metrics (055, 006, 001, 010, 008, 068) while the point-by-point metrics
// (002, 003, 032) tilt the other way, which is a producer data-coverage signature
// rather than a side-handling bug. This change removes the fragility and fixes the
// provenance falsehood below; it does not claim to close that gap.
//
// The canonical per-row fact replacing it: `${side}_retrieved_at`, which now means
// exactly "a retrieval was performed for this row with THIS side as the research
// subject". claimRetrievalForExecutingSideOnly enforces that meaning -- a P1-oriented
// pass may still write P2's VALUE from the paired finding, but it no longer stamps a
// P2 retrieval it did not perform -- and preserveUsableCurrentSide always lets the
// stamp through, so it is recorded even on an attempt that keeps a prior better value.
// That last part is what makes resume terminate instead of re-researching forever.
//
// Deliberately a presence check, not a timestamp comparison. An earlier draft asked
// whether p2_retrieved_at had moved PAST p1_retrieved_at, which silently depends on
// clock resolution: two writes inside the same millisecond compare equal and the row
// looks untreated forever. Presence has no such failure mode.
//
// Both sides therefore answer the same question -- "has this row been researched with
// this side as the subject?" -- through the same expression, from persisted per-row
// state, and neither depends on where a row sits in an array.
// ----------------------------------------------------------------------------
function researchedForOwnSide(row:Record<string,unknown>,side:"p1"|"p2"):boolean{
  return String(row[`${side}_retrieved_at`]??"").trim()!=="";
}

/**
 * Strips the OPPOSITE side's retrieval timestamp from a research patch.
 *
 * The researcher answers with one paired finding carrying both players' values, so a
 * P1-oriented pass legitimately writes P2's value -- but it performed no retrieval with
 * P2 as the subject, and stamping p2_retrieved_at as though it had is what destroyed
 * the only per-row record the P2 stage could have resumed from. The value still lands;
 * only the claim to have retrieved it for that side is withheld.
 */
export function claimRetrievalForExecutingSideOnly(patch:Record<string,unknown>,side:"p1"|"p2"){
  delete patch[`${side==="p1"?"p2":"p1"}_retrieved_at`];
  return patch;
}

export function metricRowsForSideExecution(rows:Array<Record<string,unknown>>,side:"p1"|"p2"){
  const stableRows=[...rows].sort((a,b)=>String(a["metric_code"]??a["id"]??"").localeCompare(String(b["metric_code"]??b["id"]??"")));
  // Quarantine guard, derived from the metric's own CODE rather than its persisted
  // status -- the same silent-re-entry-proof approach audit-engine.ts's coverageFor()
  // uses. instantiate() already settles a MATRIX_SUMMARY_REQUIRED code as NO_SOURCE at
  // seed time, but a run seeded BEFORE the quarantine still carries "NOT STARTED" on
  // those rows, and resuming it would otherwise hand them to a researcher and compute
  // them from substitute evidence. Filtering here closes that path for legacy runs
  // without rewriting a single persisted row (historical results stay exactly as they
  // are); the row simply stops being offered for execution while quarantined, and
  // becomes eligible again the moment its record is removed from MATRIX_SUMMARY.
  // Covers both settled-unavailable classifications (PROTECTED_UNAVAILABLE and
  // MATRIX_SUMMARY_REQUIRED). Behaviourally identical for the PROTECTED codes, which
  // both seed paths already settle as NO_SOURCE -- including them here simply makes the
  // "never researched" guarantee code-identity-proof for them too, rather than dependent
  // on a persisted status a legacy row or a downstream writer could differ on.
  const active=stableRows.filter(row=>!isNoSourceRuleCode(String(row["metric_code"]??"")));
  // A side settled EXCLUDED/NO_SOURCE is never offered for research, on either side --
  // that is the instantiation-time decision the quarantine and META carve-outs rest on,
  // and it must hold identically for P1 and P2.
  const eligible=active.filter(row=>!["EXCLUDED","NO_SOURCE"].includes(String(row[`${side}_status`])));
  const pending=eligible.filter(row=>!researchedForOwnSide(row,side));
  return{pending,completedBefore:stableRows.length-pending.length};
}

async function ensureRun(deps:PipelineDeps,match:MatchRow,forceNewRun=false):Promise<RunRow>{
  const existing=await deps.getLatestRun(match.id);
  const now=deps.now();
  if(!forceNewRun&&existing&&isActiveRunStatus(existing.status)){
    if(existing.status==="COMPLETE")return existing;
    const expired=existing.status==="RUNNING"&&lockExpired(existing.research_lock_at,now);
    if(!existing.research_lock_at||expired){
      const refreshed=now.toISOString();
      const patch:Record<string,unknown>={status:"RUNNING",research_lock_at:refreshed,heartbeat_at:refreshed,stale_reason:null};
      await deps.updateRun(existing.id,patch);
      return{...existing,...patch} as RunRow;
    }
    if(existing.status!=="RUNNING"){
      await deps.updateRun(existing.id,{status:"RUNNING",heartbeat_at:now.toISOString()});
    }
    return{...existing,status:"RUNNING"} as RunRow;
  }

  const[metrics_version_id,verification_version_id,disagreement_version_id]=await Promise.all([
    deps.getActiveVersionId("METRICS"),
    deps.getActiveVersionId("VERIFICATION"),
    deps.getActiveVersionId("DISAGREEMENT"),
  ]);

  // Reaching here means there is no active run to resume: either this match
  // has never had one (existing === null), its latest run was invalidated
  // (Clear Slate, or a rule-document version change -- audit-stages.ts's
  // INVALIDATED_RUN_STATUS), or the caller explicitly forced a fresh run
  // despite an active one existing (forceNewRun). In every case the new row
  // must get a run_number strictly greater than any this match has ever had,
  // never a reset to 1: Clear Slate invalidates the previous row but never
  // deletes it, and `audit_runs_match_run_number_idx` is a live UNIQUE
  // (match_id, run_number) constraint in production -- a match that already
  // has an (invalidated) run_number=1 row would fail this insert outright if
  // a post-Clear-Slate run also tried to claim run_number 1. A UI that wants
  // to *display* "RUN 1" for the current slate should compute that from how
  // many active runs exist, not from this monotonically-increasing id.
  return deps.createRun({
    match_id:match.id,
    run_number:(existing?.run_number??0)+1,
    status:"RUNNING",
    research_lock_at:now.toISOString(),
    heartbeat_at:now.toISOString(),
    metrics_version_id,
    verification_version_id,
    disagreement_version_id,
  });
}

export async function preparePipelineRun(deps:PipelineDeps,matchId:string):Promise<RunRow>{
  const match=await deps.getMatch(matchId);
  if(!match)throw new Error(`Match ${matchId} not found`);
  try{return await ensureRun(deps,match);}catch(error){
    const concurrentlyCreated=await deps.getLatestRun(matchId);
    if(concurrentlyCreated)return concurrentlyCreated;
    throw error;
  }
}
interface StageOutcome{status:"COMPLETE"|"BLOCKED"|"FAILED"|"PARTIAL";done:number;total:number;message?:string;errorCode?:string;detail?:Record<string,unknown>;}
interface StageCtx{deadline:number;progress:(done:number,total:number)=>Promise<void>;}

async function executeStage(deps:PipelineDeps,stage:Stage,matchId:string,runId:string,ctx:StageCtx):Promise<StageOutcome>{switch(stage){case"MATCH INGESTION / PDF EXTRACTION":return confirmIngestion(deps,matchId);case"MATCH IDENTITY VERIFICATION":case"MATCH CONTEXT RESOLUTION":return identityAndContext(deps,matchId,runId,stage);case"DEFINITION INSTANTIATION":return instantiate(deps,matchId,runId);case"P1 METRIC EXECUTION":case"P2 METRIC EXECUTION":return executeMetrics(deps,matchId,runId,stage==="P1 METRIC EXECUTION"?"p1":"p2",ctx);case"VERIFICATION AUDIT":return executeRules(deps,matchId,runId,"VERIFICATION",ctx);case"DISAGREEMENT / TRAP AUDIT":return executeRules(deps,matchId,runId,"DISAGREEMENT",ctx);case"DANGEROUS UNDERDOG AUDIT":return executeUnderdog(deps,matchId,runId);case"STRESS / REMOVAL TESTS":return executeStress(deps,matchId,runId);case"INDEPENDENT CONCLUSION":return commitConclusion(deps,matchId,runId);case"MATRIX REVEAL AND COMPARISON":return revealMatrix(deps,matchId,runId);case"CURRENT CALIBRATION APPLICATION":return applyCalibration(deps,matchId,runId);case"COVERAGE PERSISTENCE / EVIDENCE VALIDATION":return persistCoverage(deps,matchId,runId);case"FINAL DECISION":return commitFinalDecision(deps,matchId,runId);case"FINAL COMBINATION GATE":return finalGate(deps,matchId,runId);}}

// MATCH INGESTION / PDF EXTRACTION is the first canonical stage, but the work
// it names (parsing the uploaded PDF into `matches`/`summary_versions`/
// `parsed_summary_fields`) necessarily already happened before any audit_run
// -- and therefore this stage's own row -- can exist: runPipeline is only
// ever invoked for a matchId that resolves to a real, already-ingested match
// (see the `if(!match)throw` guard at the top of runPipeline). So this stage
// records that precondition as a real, persisted canonical fact for the
// current run rather than re-deriving it from upload-time state, closing the
// only stage in the dependency chain that would otherwise never get an
// audit_stage_runs row of its own.
async function confirmIngestion(deps:PipelineDeps,matchId:string):Promise<StageOutcome>{const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");return{status:"COMPLETE",done:1,total:1,detail:{player1_name:match.player1_name,player2_name:match.player2_name}};}

async function identityAndContext(deps:PipelineDeps,matchId:string,runId:string,stage:Stage):Promise<StageOutcome>{const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");const isIdentity=stage==="MATCH IDENTITY VERIFICATION";if(isIdentity&&match.identity_status==="VERIFIED")return{status:"COMPLETE",done:2,total:2};if(!isIdentity&&match.surface_status==="VERIFIED"&&match.scheduled_date&&match.round)return{status:"COMPLETE",done:6,total:6};const parsed=await deps.getParsedFields(matchId);let finding:IdentityFinding;try{finding=await deps.research.identity({p1:match.player1_name,p2:match.player2_name,hints:{tournament:match.tournament_name??parsed["tournament"]??null,round:match.round??parsed["round"]??null,scheduled_date:match.scheduled_date??parsed["scheduled_date"]??null,surface:match.surface??parsed["surface"]??null,event_level:match.event_level??parsed["event_level"]??null}});}catch{if(isIdentity){await deps.updateMatch(matchId,{identity_status:"UNAVAILABLE"});await deps.saveIdentityRecords(matchId,[{field:"player_1",claimed_value:match.player1_name,verified_value:null,status:"UNAVAILABLE",note:"Identity search unavailable; names retained from PDF."},{field:"player_2",claimed_value:match.player2_name,verified_value:null,status:"UNAVAILABLE",note:"Identity search unavailable; names retained from PDF."}]);return{status:"COMPLETE",done:0,total:2,detail:{unavailable:"identity search"}};}await deps.updateMatch(matchId,{surface_status:"UNAVAILABLE"});return{status:"COMPLETE",done:0,total:6,detail:{unavailable:"context search"}};}const retrieved=deps.now().toISOString();await deps.saveSnapshots(runId,finding.sources.map(src=>({source_name:src.source_name,data_key:isIdentity?"match_identity":"match_context",raw_value:src.url,normalized_value:src.url,retrieved_at:src.retrieved_at??retrieved,reliability:.9})));if(finding.conflicts.length)await deps.saveConflicts(runId,finding.conflicts.map(c=>({data_key:c.field,critical:["player_1","player_2","surface"].includes(c.field),values:c.values,resolution_status:"UNRESOLVED",resolution_reason:c.note})));if(isIdentity){const rows=[{field:"player_1",claimed_value:match.player1_name,verified_value:finding.player1_canonical,status:finding.player1_status,note:finding.unresolved_reason},{field:"player_2",claimed_value:match.player2_name,verified_value:finding.player2_canonical,status:finding.player2_status,note:finding.unresolved_reason}];await deps.saveIdentityRecords(matchId,rows);const verified=finding.player1_status==="VERIFIED"&&finding.player2_status==="VERIFIED";await deps.updateMatch(matchId,{identity_status:verified?"VERIFIED":finding.player1_status==="CONFLICT"||finding.player2_status==="CONFLICT"?"CONFLICT":"UNVERIFIED"});const done=[finding.player1_status,finding.player2_status].filter(x=>x==="VERIFIED").length;return{status:"COMPLETE",done,total:2,detail:verified?{}:{identity_unverified:finding.unresolved_reason??"Player identity could not be confirmed against an external tennis source."}};}const patch:Record<string,unknown>={};if(finding.tournament)patch["tournament_name"]=finding.tournament;if(finding.event_level)patch["event_level"]=finding.event_level;if(finding.round)patch["round"]=finding.round;if(finding.scheduled_date)patch["scheduled_date"]=finding.scheduled_date;if(finding.surface)patch["surface"]=finding.surface;if(finding.indoor!==null&&finding.indoor!==undefined)patch["indoor"]=finding.indoor;if(finding.best_of)patch["best_of"]=finding.best_of;patch["surface_status"]=finding.surface?finding.surface_status:"UNVERIFIED";await deps.updateMatch(matchId,patch);await deps.saveIdentityRecords(matchId,(["tournament","event_level","round","scheduled_date","surface","best_of"] as const).map(field=>{const value=s(patch[field==="tournament"?"tournament_name":field]);return{field,claimed_value:parsed[field]??null,verified_value:value,status:value?"VERIFIED":"UNAVAILABLE",note:value?null:finding.unresolved_reason??"Retrieval attempted; no authoritative source carried this field."};}));const fields=["tournament_name","event_level","round","scheduled_date","surface","best_of"],done=fields.filter(f=>patch[f]!==undefined&&patch[f]!==null).length;return{status:"COMPLETE",done,total:fields.length,detail:finding.surface?{unresolved:fields.filter(f=>patch[f]===undefined)}:{unresolved:fields.filter(f=>patch[f]===undefined),surface_unverified:finding.unresolved_reason??"Surface could not be established from any approved source."}};}

// metric_results.p1_treatment/p2_treatment carry a DB check constraint that does not
// include 'NO_SOURCE' (status/p1_status/p2_status are unconstrained free text and do).
// audit-engine.ts's coverageFor() re-derives NO_SOURCE purely from the metric code via
// isNoSourceMetricCode(), ignoring the stored treatment value entirely (see its test
// "keeps a NO_SOURCE code out of the denominator even after a downstream writer
// overwrites its treatment"), so storing 'UNAVAILABLE' here for a NO_SOURCE-classified
// code is schema-safe and does not change coverage/gate scoring.
async function instantiate(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");const missing:string[]=[],versions:Record<string,string|null>={METRICS:await deps.getActiveVersionId("METRICS"),VERIFICATION:await deps.getActiveVersionId("VERIFICATION"),DISAGREEMENT:await deps.getActiveVersionId("DISAGREEMENT")};for(const[k,v]of Object.entries(versions))if(!v)missing.push(k);if(missing.length)return{status:"FAILED",done:0,total:3,errorCode:"MISSING_DEFINITIONS",message:`No active rule document version for: ${missing.join(", ")}. Upload/activate the definition documents in Rules before running the audit.`};await deps.updateRun(runId,{metrics_version_id:versions.METRICS,verification_version_id:versions.VERIFICATION,disagreement_version_id:versions.DISAGREEMENT});const[metricDefs,verDefs,disDefs]=await Promise.all([deps.getRules(versions.METRICS!),deps.getRules(versions.VERIFICATION!),deps.getRules(versions.DISAGREEMENT!)]);if(!metricDefs.length||!verDefs.length||!disDefs.length)return{status:"FAILED",done:0,total:3,errorCode:"MISSING_DEFINITIONS",message:`Active versions contain no parsed rules (metrics ${metricDefs.length}, verification ${verDefs.length}, disagreement ${disDefs.length}).`};
// Truth Engine execution universe is the 25 active codes (ACTIVE_METRIC_CODES,
// derived from COMPARISON_SPECS), never the full ~81-code registry. The other
// ~56 legitimate-but-inactive codes (real engines, e.g. 047/061) must never be
// instantiated, researched, or enter any Truth Engine stage -- exclusion happens
// here, at the earliest point, not as a late filter on an already-executed row.
// Two narrow, explicit exceptions are kept instantiated because a real, already-
// working downstream writer depends on the row existing as its write target:
//   - META_OR_NON_PLAYER codes (metric-classification.ts) -- meta-derived-
//     evidence.server.ts writes composite values into these rows. They are
//     ALREADY excluded from research below (seeded status "EXCLUDED"), so
//     keeping them costs zero provider calls; only the row itself is kept.
//   - "042" ("Opponent Win Pathways") -- itself MATRIX_SUMMARY_REQUIRED
//     (quarantined pending real Tennis Matrix AI Summary evidence, same as the
//     other 14 quarantined codes) and ALREADY excluded from research below
//     (seeded status "NO_SOURCE"), so this too costs zero provider calls.
//     opponent-win-pathways-meta.server.ts needs the row to exist purely as a
//     write target for a value it derives from the Dangerous Underdog stage
//     (pipeline stage 9), never from research.
const activeMetricDefs=metricDefs.filter(d=>isActiveMetricCode(d.rule_code)||isProcessMetaRuleCode(d.rule_code)||normalizeMetricCode(d.rule_code)==="042");
const existingMetrics=await deps.list("metric_results",runId),haveMetric=new Set(existingMetrics.map(r=>String(r["metric_code"]))),newMetrics=activeMetricDefs.filter(d=>!haveMetric.has(d.rule_code)).map(d=>{const excluded=isProcessMetaRuleCode(d.rule_code);const noSource=!excluded&&isNoSourceRuleCode(d.rule_code);const quarantined=noSource&&isMatrixSummaryQuarantinedRuleCode(d.rule_code);const initial=excluded?"EXCLUDED":noSource?"NO_SOURCE":"NOT STARTED";const settled=excluded||noSource;return{audit_run_id:runId,metric_code:d.rule_code,metric_name:d.rule_name,category:d.severity,evidence_family:d.rule_name,matrix_derived:false,status:initial,p1_status:initial,p2_status:initial,p1_treatment:excluded?"EXCLUDED":"UNAVAILABLE",p2_treatment:excluded?"EXCLUDED":"UNAVAILABLE",unavailable_reason:excluded?"PROCESS_META_NOT_PLAYER_EVIDENCE":quarantined?"MATRIX_SUMMARY_EVIDENCE_REQUIRED":noSource?"NO_SOURCE_NO_LEGITIMATE_PATHWAY":null,unavailable_detail:excluded?"Canonical classification registry classifies this code as a process/model-governance section (see metric-classification.ts), not a player-level metric; excluded from player-evidence coverage rather than scored as unavailable.":quarantined?"The Truth Engine does not currently possess the Tennis Matrix AI Summary evidence this code requires, so it is quarantined out of the ACTIVE audit pipeline (see MATRIX_SUMMARY_REQUIRED_RECORDS in metric-classification.ts). This is not a failure, a zero, a retirement, or a permanent determination: the definition, formula, schema and all historical results/evidence are preserved, the code contributes no active weight and cannot block this audit, and it is restored to the active denominator once real Matrix Summary evidence is uploaded, validated and the code has earned reactivation.":noSource?"Canonical classification registry records a documented determination that no legitimate obtainable or reconstructable evidence pathway exists for this code (see PROTECTED_UNAVAILABLE_RECORDS in metric-classification.ts); excluded from player-evidence coverage rather than scored as unavailable.":null};});if(newMetrics.length)await deps.insert("metric_results",newMetrics);const existingVer=await deps.list("verification_results",runId),haveVer=new Set(existingVer.map(r=>String(r["rule_code"]))),newVer=verDefs.filter(d=>!haveVer.has(d.rule_code)).map(d=>({audit_run_id:runId,rule_id:d.id,rule_code:d.rule_code,rule_name:d.rule_name,severity:d.severity,status:"NOT STARTED",outcome:"NOT STARTED"}));if(newVer.length)await deps.insert("verification_results",newVer);const existingDis=await deps.list("disagreement_results",runId),haveDis=new Set(existingDis.map(r=>String(r["rule_code"]))),newDis=disDefs.filter(d=>!haveDis.has(d.rule_code)).map(d=>({audit_run_id:runId,rule_id:d.id,rule_code:d.rule_code,rule_name:d.rule_name,status:"NOT STARTED"}));if(newDis.length)await deps.insert("disagreement_results",newDis);const existingUnder=await deps.list("underdog_results",runId),haveUnder=new Set(existingUnder.map(r=>`${r["player_side"]}|${r["pathway_code"]}`)),newUnder=[match.player1_name,match.player2_name].flatMap(side=>UNDERDOG_PATHWAYS.filter(([code])=>!haveUnder.has(`${side}|${code}`)).map(([code,name])=>({audit_run_id:runId,pathway_code:code,pathway_name:name,player_side:side,classification:"UNRESOLVED",status:"NOT STARTED"})));if(newUnder.length)await deps.insert("underdog_results",newUnder);const existingStress=await deps.list("stress_results",runId),haveStress=new Set(existingStress.map(r=>String(r["test_code"]))),newStress=STRESS_TESTS.filter(([code])=>!haveStress.has(code)).map(([code,name])=>({audit_run_id:runId,test_code:code,test_name:name,status:"NOT STARTED",outcome:"NOT STARTED"}));if(newStress.length)await deps.insert("stress_results",newStress);const total=activeMetricDefs.length+verDefs.length+disDefs.length+UNDERDOG_PATHWAYS.length*2+STRESS_TESTS.length;return{status:"COMPLETE",done:total,total,detail:{metrics:activeMetricDefs.length,verification:verDefs.length,disagreement:disDefs.length,underdog:UNDERDOG_PATHWAYS.length*2,stress:STRESS_TESTS.length}};}

async function executeMetrics(deps:PipelineDeps,matchId:string,runId:string,side:"p1"|"p2",ctx:StageCtx):Promise<StageOutcome>{const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");const rows=await deps.list("metric_results",runId);if(!rows.length)return{status:"FAILED",done:0,total:0,errorCode:"MISSING_DEFINITIONS",message:"No metric rows instantiated."};const stageName=side==="p1"?"P1 METRIC EXECUTION":"P2 METRIC EXECUTION",{pending,completedBefore}=metricRowsForSideExecution(rows,side),versions=await deps.getActiveVersionId("METRICS"),defs=versions?await deps.getRules(versions):[],bodyByCode=new Map(defs.map(d=>[d.rule_code,d.body])),digestContext=digestFrom(match,rows).context;let dossier="";if(pending.length&&deps.research.dossier){const run=await deps.getLatestRun(matchId),cached=(run as unknown as{independent_inputs?:Record<string,unknown>}|null)?.independent_inputs?.["dossiers"] as Record<string,string>|undefined,need=[match.player1_name,match.player2_name].filter(p=>!cached?.[p]),fresh:Record<string,string>={...(cached??{})};const retrieved=await Promise.all(need.map(async player=>{const opponent=player===match.player1_name?match.player2_name:match.player1_name;try{return[player,await deps.research.dossier!({player,opponent,context:digestContext})]as const;}catch{return[player,""]as const;}}));for(const[player,value]of retrieved)fresh[player]=value;if(need.length)await deps.updateRun(runId,{independent_inputs:{...((run as unknown as{independent_inputs?:Record<string,unknown>}|null)?.independent_inputs??{}),dossiers:fresh}});dossier=fresh[side==="p1"?match.player1_name:match.player2_name]??"";}
// Bounded in-audit retry: a transient/technical failure (provider timeout, rate limit --
// see metric-activation-status.ts's RETRIABLE_REASONS) gets a fresh attempt at the SAME
// metric through the SAME producer/source path, never a fallback to a different metric and
// never a relaxed definition. Bounded by both MAX_METRIC_RETRY_ATTEMPTS and the stage's own
// deadline, so a persistently failing source can never make the audit loop indefinitely.
// If retries exhaust and the reason is still transient, metric-activation-status.ts
// reclassifies it PRODUCER_FAILURE -- a real miss to fix, never confused with proof that no
// legitimate data exists.
const MAX_METRIC_RETRY_ATTEMPTS=2;
const RETRIABLE_REASONS=new Set(["PROVIDER_TIMEOUT","API_RATE_LIMIT"]);
const runResearchBatch=async(rowsToRun:Array<Record<string,unknown>>):Promise<Array<Record<string,unknown>>>=>{
  let findings:MetricFinding[]=[],providerError:string|null=null;
  // Throughput measurement (see audit-research.server.ts's matching comment): pairs
  // with the per-provider-attempt timing there to answer whether the 20s browser
  // slice is limited by provider latency (few batches per slice) or something else
  // (many batches, still slow overall). Remove once the throughput question is settled.
  const batchStartedAt=Date.now();
  // auditDate is the TYPED temporal boundary: the audited match's own scheduled_date,
  // passed as data rather than re-extracted downstream from the rendered context string.
  // Both leaks found so far (Phase 13's "no date means no filter", Phase 13.5's "no date
  // means today") originated in regex-recovering this value from prose. Passing it
  // explicitly makes an absent date unambiguous to every consumer instead of a parse miss
  // each one interprets for itself.
  try{findings=await deps.research.metrics({p1:match.player1_name,p2:match.player2_name,context:digestContext,auditDate:match.scheduled_date,dossier,researchSide:side,researchPlayer:side==="p1"?match.player1_name:match.player2_name,researchOpponent:side==="p1"?match.player2_name:match.player1_name,metrics:rowsToRun.map(r=>({code:String(r["metric_code"]),name:String(r["metric_name"]),body:bodyByCode.get(String(r["metric_code"]))??null}))});}catch(error){providerError=errorDetail(error);}
  console.log(`[research-timing] ${side.toUpperCase()} batch of ${rowsToRun.length} ${providerError?"ERROR":"OK"} ${Date.now()-batchStartedAt}ms`);
  const byCode=new Map(findings.map(f=>[f.metric_code,f]));const retrievedAt=deps.now().toISOString();const stillRetriable:Array<Record<string,unknown>>=[];
  await Promise.all(rowsToRun.map(async row=>{
    const paired=metricPairPatch(byCode.get(String(row["metric_code"])),providerError,retrievedAt);
    const oriented=claimRetrievalForExecutingSideOnly(preserveSettledOppositeSide(paired,row,side),side);
    const finalPatch=preserveUsableCurrentSide(oriented,row,side);
    await deps.update("metric_results",String(row["id"]),finalPatch);
    const reason=finalPatch[`${side}_unavailable_reason`];
    if(typeof reason==="string"&&RETRIABLE_REASONS.has(reason))stillRetriable.push(row);
  }));
  return stillRetriable;
};
let timedOut=false,treatedInPass=0;for(let i=0;i<pending.length;i+=METRIC_BATCH){if(Date.now()>ctx.deadline){timedOut=true;break;}const batch=pending.slice(i,i+METRIC_BATCH);
let retryQueue=await runResearchBatch(batch);
for(let attempt=1;attempt<=MAX_METRIC_RETRY_ATTEMPTS&&retryQueue.length&&Date.now()<=ctx.deadline;attempt++){
  await deps.log({audit_run_id:runId,match_id:matchId,stage:stageName,status:"RETRYING",output:{side,attempt,retried_codes:retryQueue.map(r=>String(r["metric_code"]))}});
  retryQueue=await runResearchBatch(retryQueue);
}
treatedInPass+=batch.length;await ctx.progress(completedBefore+treatedInPass,rows.length);}
if(!timedOut&&deps.research.extractStats){const player=side==="p1"?match.player1_name:match.player2_name,run=await deps.getLatestRun(matchId),cached=(run as unknown as{independent_inputs?:Record<string,unknown>}|null)?.independent_inputs?.["dossiers"] as Record<string,string>|undefined;let raw:SourcedStat[]=[],extractionError:string|null=null;try{raw=await deps.research.extractStats({player,dossier:cached?.[player]??dossier,context:digestContext});}catch(error){extractionError=errorDetail(error);}const outcome=reconstruct(raw),reconstructionRows=[...outcome.derived.map(stat=>({audit_run_id:runId,metric_code:stat.key,player_side:player,status:"COMPLETE",output:String(stat.value),formula:stat.formula??null,inputs:stat.inputs?.map(input=>({key:input.key,value:input.value,origin:input.origin,sources:input.sources}))??[],calculation:stat.calculation??null,source_refs:stat.sources,assumptions:null,reliability:.8,unavailable_reason:null,provider_error:null,missing_inputs:[],source_attempts:stat.sources,reconstruction_attempted:true,reconstruction_reason:stat.calculation??null,reconstruction_result:String(stat.value),retrieved_at:deps.now().toISOString()})),...outcome.blocked.map(blocked=>({audit_run_id:runId,metric_code:blocked.output,player_side:player,status:"UNAVAILABLE",output:null,formula:null,inputs:{missing:blocked.missing},calculation:blocked.reason,source_refs:[],assumptions:blocked.reason,reliability:null,unavailable_reason:"RECONSTRUCTION_FAILED",provider_error:null,missing_inputs:blocked.missing,source_attempts:[],reconstruction_attempted:true,reconstruction_reason:blocked.reason,reconstruction_result:null,retrieved_at:deps.now().toISOString()})),...(raw.length||outcome.blocked.length?[]:[{audit_run_id:runId,metric_code:"PASS2_EXTRACTION",player_side:player,status:"UNAVAILABLE",output:null,formula:null,inputs:{missing:["dossier"]},calculation:extractionError??"No catalogued statistics were extracted from the player dossier.",source_refs:[],assumptions:null,reliability:null,unavailable_reason:extractionError?unavailableReason(extractionError):"NO_SOURCE_FOUND",provider_error:extractionError,missing_inputs:["dossier"],source_attempts:[],reconstruction_attempted:true,reconstruction_reason:extractionError??"No catalogued statistics were extracted from the player dossier.",retrieved_at:deps.now().toISOString()}])];if(reconstructionRows.length)await deps.insert("reconstruction_results",reconstructionRows as never);const statsByFamily=new Map<string,SourcedStat[]>();for(const stat of[...raw,...outcome.derived]){const family=familyOf(stat.key);if(!family)continue;statsByFamily.set(family,[...(statsByFamily.get(family)??[]),stat]);}const writeBackContext:Pass2WriteBackContext={p1Name:match.player1_name,p2Name:match.player2_name,retrievedAt:deps.now().toISOString()};for(const row of rows){const patch=pass2WriteBackPatch(row,side,statsByFamily,writeBackContext);if(!patch)continue;await deps.update("metric_results",String(row["id"]),patch);}}
const done=completedBefore+treatedInPass;if(timedOut)return{status:"PARTIAL",done,total:rows.length,message:`${done}/${rows.length} metrics treated so far for ${side.toUpperCase()}.`};return{status:"COMPLETE",done:rows.length,total:rows.length};}

async function executeRules(deps:PipelineDeps,matchId:string,runId:string,kind:"VERIFICATION"|"DISAGREEMENT",ctx:StageCtx):Promise<StageOutcome>{
  const table:ChildTable=kind==="VERIFICATION"?"verification_results":"disagreement_results";
  const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");
  const rows=await deps.list(table,runId);
  if(!rows.length)return{status:"FAILED",done:0,total:0,errorCode:"MISSING_DEFINITIONS",message:`No ${kind.toLowerCase()} rules instantiated.`};
  // DETERMINISTIC AUDIT (docs/audit-truth-engine-decision-core.md): both audits are now
  // computed from the persisted metric evidence rather than requested from a provider. A
  // rule the deterministic audit genuinely answers is populated; every other rule is written
  // UNAVAILABLE carrying the exact missing evidence, so the stage can never report false
  // completeness by filling every row with the audit's overall verdict.
  const metrics=await deps.list("metric_results",runId);
  const audit=runTruthEngineAudit(compareMetricRows(metrics.map(m=>({metric_code:String(m["metric_code"]??""),p1_value:m["p1_value"]as string|null,p2_value:m["p2_value"]as string|null,p1_treatment:m["p1_treatment"]as string|null,p2_treatment:m["p2_treatment"]as string|null}))),match.player1_name,match.player2_name);
  const now=deps.now().toISOString();
  const pending=rows.filter(r=>!["COMPLETE","UNAVAILABLE","EXCLUDED"].includes(String(r["status"])));
  let processed=0,evaluated=0;
  for(const row of pending){
    if(Date.now()>ctx.deadline)break;
    const mapped=kind==="VERIFICATION"
      ?verificationRowPatch(row["rule_code"],audit,match.player1_name,match.player2_name,now)
      :disagreementRowPatch(row["rule_code"],audit,match.player1_name,match.player2_name,now);
    await deps.update(table,String(row["id"]),mapped.patch);
    if(mapped.evaluated)evaluated++;
    processed++;
    await ctx.progress(rows.length-pending.length+processed,rows.length);
  }
  const after=await deps.list(table,runId),done=after.filter(r=>["COMPLETE","UNAVAILABLE","EXCLUDED"].includes(String(r["status"]))).length;
  if(processed<pending.length)return{status:"PARTIAL",done,total:after.length,message:`${done}/${after.length} ${kind.toLowerCase()} rules treated so far.`};
  return done===after.length
    ?{status:"COMPLETE",done,total:after.length,detail:{deterministically_evaluated:evaluated,unavailable:after.length-evaluated}}
    :{status:"BLOCKED",done,total:after.length,errorCode:"RULE_EXECUTION_INCOMPLETE",message:`${after.length-done} ${kind.toLowerCase()} rules unexecuted.`};
}

async function executeUnderdog(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{
  const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");
  const rows=await deps.list("underdog_results",runId);
  if(!rows.length)return{status:"FAILED",done:0,total:0,errorCode:"MISSING_DEFINITIONS",message:"No underdog pathways instantiated."};
  // Pathways are now derived from measured evidence: a pathway is only classified when the
  // non-selected player actually leads an independent evidence family by more than that
  // metric's own noise floor. Pathways no active metric can establish are UNAVAILABLE with
  // the reason, replacing the previous hardcoded "no admissible evidence located" string.
  const metrics=await deps.list("metric_results",runId);
  const audit=runTruthEngineAudit(compareMetricRows(metrics.map(m=>({metric_code:String(m["metric_code"]??""),p1_value:m["p1_value"]as string|null,p2_value:m["p2_value"]as string|null,p1_treatment:m["p1_treatment"]as string|null,p2_treatment:m["p2_treatment"]as string|null}))),match.player1_name,match.player2_name);
  const now=deps.now().toISOString();
  let classified=0;
  for(const row of rows.filter(r=>!["COMPLETE","UNAVAILABLE","EXCLUDED"].includes(String(r["status"])))){
    const mapped=underdogRowPatch(row["pathway_code"],String(row["player_side"]??""),audit,match.player1_name,match.player2_name,now);
    await deps.update("underdog_results",String(row["id"]),mapped.patch);
    if(String(mapped.patch["status"])==="COMPLETE")classified++;
  }
  const after=await deps.list("underdog_results",runId),done=after.filter(r=>["COMPLETE","UNAVAILABLE","EXCLUDED"].includes(String(r["status"]))).length;
  return done===after.length
    ?{status:"COMPLETE",done,total:after.length,detail:{evidence_backed_pathways:audit.underdog.pathways.length,overall_viability:audit.underdog.overall_viability,rows_classified:classified,pathways_without_persisted_row:unmappedUnderdogPathways(audit)}}
    :{status:"BLOCKED",done,total:after.length,errorCode:"UNDERDOG_INCOMPLETE",message:`${after.length-done} pathways unexecuted.`};
}

async function executeStress(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{
  const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");
  const rows=await deps.list("stress_results",runId);
  if(!rows.length)return{status:"FAILED",done:0,total:0,errorCode:"MISSING_DEFINITIONS",message:"No stress tests instantiated."};
  const metrics=await deps.list("metric_results",runId);
  // The stress stage now RECOMPUTES the selection under adverse assumptions derived from each
  // metric's own declared noise floor, instead of asking a provider whether it looks stable.
  // winner_after is therefore a real recomputation result.
  const audit=runTruthEngineAudit(compareMetricRows(metrics.map(m=>({metric_code:String(m["metric_code"]??""),p1_value:m["p1_value"]as string|null,p2_value:m["p2_value"]as string|null,p1_treatment:m["p1_treatment"]as string|null,p2_treatment:m["p2_treatment"]as string|null}))),match.player1_name,match.player2_name);
  const now=deps.now().toISOString();
  const matrixDerivedUsed=metrics.filter(m=>m["matrix_derived"]===true&&m["status"]==="COMPLETE").length;
  const pending=rows.filter(r=>!["COMPLETE","UNAVAILABLE","EXCLUDED"].includes(String(r["status"])));
  let recomputed=0;
  for(const row of pending){
    const code=String(row["test_code"]??"");
    if(code==="ST01"||code==="ST02"){
      // Matrix-removal tests stay deterministic and independent of the provider: the audit
      // consumes no Matrix-derived metric, so removing them cannot change the winner.
      await deps.update("stress_results",String(row["id"]),{winner_before:audit.stress.winner_before==="INSUFFICIENT_EVIDENCE"?null:audit.stress.winner_before,winner_after:matrixDerivedUsed===0?(audit.stress.winner_before==="INSUFFICIENT_EVIDENCE"?null:audit.stress.winner_before):null,range_before:null,range_after:null,outcome:matrixDerivedUsed===0?"STABLE":"UNSTABLE",status:"COMPLETE",unavailable_detail:`Matrix-derived metrics consumed by the independent audit: ${matrixDerivedUsed}.`,retrieved_at:now});
      recomputed++;continue;
    }
    const mapped=stressRowPatch(code,audit,now);
    await deps.update("stress_results",String(row["id"]),mapped.patch);
    if(mapped.evaluated)recomputed++;
  }
  const after=await deps.list("stress_results",runId),done=after.filter(r=>["COMPLETE","UNAVAILABLE","EXCLUDED"].includes(String(r["status"]))).length;
  return done===after.length
    ?{status:"COMPLETE",done,total:after.length,detail:{winner_before:audit.stress.winner_before,winner_after:audit.stress.winner_after,changed:audit.stress.changed,stability:audit.stress.stability,recomputed_tests:recomputed}}
    :{status:"BLOCKED",done,total:after.length,errorCode:"STRESS_INCOMPLETE",message:`${after.length-done} stress tests unexecuted.`};
}

/**
 * DETERMINISTIC INDEPENDENT CONCLUSION (docs/audit-truth-engine-decision-core.md).
 *
 * The Truth Engine's winner is derived from the persisted metric evidence -- reproducible,
 * inspectable, identical on every re-run -- and then audited by the deterministic
 * Verification, Disagreement, Underdog and Stress layers. A selection that does not survive
 * its own adverse-case recomputation is refused rather than asserted. When the evidence does
 * not support a side this returns no winner WITH the reason, rather than asking a provider
 * to manufacture certainty.
 */
export function deterministicIndependentConclusion(metrics:Array<Record<string,unknown>>,p1Name:string,p2Name:string):ConclusionFinding&{audit:ReturnType<typeof runTruthEngineAudit>}{
  const audit=runTruthEngineAudit(
    compareMetricRows(metrics.map(m=>({metric_code:String(m["metric_code"]??""),p1_value:m["p1_value"]as string|null,p2_value:m["p2_value"]as string|null,p1_treatment:m["p1_treatment"]as string|null,p2_treatment:m["p2_treatment"]as string|null}))),
    p1Name,p2Name,
  );
  return{
    winner:audit.audit_winner,
    low:null,high:null,
    rationale:audit.audit_winner?`${audit.final_reason} Evidence chain: ${audit.evidence_chain.join(" | ")}`:null,
    insufficient_reason:audit.audit_winner?null:audit.final_reason,
    audit,
  };
}

async function provisionalConclusion(deps:PipelineDeps,matchId:string,runId:string,evidence:EvidenceDigest):Promise<ConclusionFinding>{const[ver,dis,und]=await Promise.all([deps.list("verification_results",runId),deps.list("disagreement_results",runId),deps.list("underdog_results",runId)]);try{return await deps.research.conclusion({evidence,verificationSummary:ver.filter(r=>r["outcome"]==="FAIL"||r["outcome"]==="WARN").map(r=>`${r["rule_code"]} ${r["outcome"]}: ${r["p1_finding"]??""} | ${r["p2_finding"]??""}`).join("\n").slice(0,6000),disagreementSummary:dis.filter(r=>r["contradiction_severity"]&&r["contradiction_severity"]!=="NONE").map(r=>`${r["rule_code"]} ${r["contradiction_severity"]}: ${r["final_effect"]??""}`).join("\n").slice(0,6000),underdogSummary:und.filter(r=>r["classification"]==="STRONG"||r["classification"]==="REALISTIC").map(r=>`${r["player_side"]} ${r["pathway_name"]} ${r["classification"]}: ${r["evidence"]??""}`).join("\n").slice(0,6000)});}catch{return{winner:null,low:null,high:null,rationale:null,insufficient_reason:"Independent conclusion unavailable because the research provider did not return a result."};}}
async function commitConclusion(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{const run=await deps.getLatestRun(matchId);if(run?.independent_decision_committed_at)return{status:"COMPLETE",done:1,total:1};const match=await deps.getMatch(matchId);if(!match)throw new Error("match disappeared");const metrics=await deps.list("metric_results",runId),evidence=digestFrom(match,metrics);
  // The deterministic, evidence-derived conclusion is AUTHORITATIVE for the winner: it is
  // reproducible and inspectable, where the provider path is neither and in practice
  // returned nothing at all across every historical run. The provider is consulted only
  // for supplementary rationale text, and can never override, supply, or overturn the
  // selected side -- that is what keeps this an independent audit rather than a narrative.
  const deterministic=deterministicIndependentConclusion(metrics,match.player1_name,match.player2_name);
  let conclusion:ConclusionFinding=deterministic;
  if(deterministic.winner){
    try{
      const narrated=await provisionalConclusion(deps,matchId,runId,evidence);
      if(narrated?.rationale)conclusion={...deterministic,rationale:`${deterministic.rationale} Provider narrative: ${narrated.rationale}`};
    }catch{/* provider narrative is optional; the deterministic selection stands regardless */}
  }
  // Independent evidence families come from the deterministic decision (correlated metrics
  // collapsed and counted once), not from a raw distinct-string count of evidence_family,
  // which double-counted correlated signals as independent corroboration.
  const families=new Set(deterministic.audit.decision.independent_support_families);if(!conclusion.winner){await deps.updateRun(runId,{independent_decision_committed_at:deps.now().toISOString(),effective_evidence_count:families.size,raw_signal_count:metrics.filter(m=>m["status"]==="COMPLETE").length});return{status:"COMPLETE",done:1,total:1,detail:{winner:null,families:families.size,insufficient_reason:conclusion.insufficient_reason??"Independent evidence was insufficient to commit a conclusion."}};}await deps.updateRun(runId,{independent_winner:conclusion.winner,independent_low:conclusion.low,independent_high:conclusion.high,independent_decision_committed_at:deps.now().toISOString(),effective_evidence_count:families.size,raw_signal_count:metrics.filter(m=>m["status"]==="COMPLETE").length});return{status:"COMPLETE",done:1,total:1,detail:{winner:conclusion.winner,families:families.size,rationale:conclusion.rationale?.slice(0,500)??null}};}
async function revealMatrix(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{const run=await deps.getLatestRun(matchId);if(!run?.independent_decision_committed_at)return{status:"BLOCKED",done:0,total:1,errorCode:"FIREWALL",message:"Matrix stays sealed until the independent conclusion is committed."};const fields=await deps.getParsedFields(matchId),wpRaw=fields["matrix_wp"],wp=wpRaw?Number(String(wpRaw).replace(/[^\d.]/g,"")):null;await deps.updateRun(runId,{matrix_revealed_at:deps.now().toISOString()});return{status:"COMPLETE",done:1,total:1,detail:{matrix_predicted_winner:fields["matrix_predicted_winner"]??null,matrix_wp:wp,agrees_with_independent:fields["matrix_predicted_winner"]&&run.independent_winner?fields["matrix_predicted_winner"].toLowerCase().includes(run.independent_winner.split(" ").slice(-1)[0]!.toLowerCase()):null}};}
async function applyCalibration(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{const{version,buckets}=await deps.getCalibration();if(!version||!buckets.length)return{status:"FAILED",done:0,total:1,errorCode:"NO_ACTIVE_CALIBRATION",message:"No active calibration version with buckets is stored."};const run=await deps.getLatestRun(matchId),fields=await deps.getParsedFields(matchId),wpRaw=fields["matrix_wp"],wp=wpRaw?Number(String(wpRaw).replace(/[^\d.]/g,"")):null,snapshot=buildCalibrationSnapshot({versionId:version.id,matrixWp:Number.isFinite(wp)?wp:null,buckets,independentLow:run?.independent_low??null,independentHigh:run?.independent_high??null});await deps.updateRun(runId,{calibration_version_id:version.id,calibrated_low:snapshot.calibratedLow,calibrated_high:snapshot.calibratedHigh});return{status:"COMPLETE",done:1,total:1,detail:{calibration_version:version.label,version_number:version.version_number,bucket:snapshot.bucketCode,verified_win_rate:snapshot.verifiedWinRate,bucket_wins:snapshot.bucketWins,bucket_graded:snapshot.bucketGraded}};}

// Fresh upstream re-check shared by the three closing stages: reads
// audit_stage_runs directly (not whatever this call's local loop state
// believes) so a stale in-memory view can never let one of them persist
// COMPLETE -- or, for Coverage/Final Decision, even write its records at
// all -- while a required upstream stage is not actually COMPLETE for this
// audit_run_id.
async function requireUpstreamComplete(deps:PipelineDeps,runId:string,stage:Stage):Promise<Stage[]>{
  const stages=await deps.getStages(runId);
  return unmetDependencies(stage,stages);
}

// COVERAGE PERSISTENCE / EVIDENCE VALIDATION: computes and persists
// audit_coverage + metric_coverage_rates from the current run's real,
// already-COMPLETE upstream data. This is evidence, not execution state --
// it never decides Final Combination Gate completion by itself (see
// finalGate below), only whether coverage/evidence was actually recorded.
async function persistCoverage(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{
  const missingUpstream=await requireUpstreamComplete(deps,runId,"COVERAGE PERSISTENCE / EVIDENCE VALIDATION");
  if(missingUpstream.length)return{status:"BLOCKED",done:0,total:1,errorCode:"UPSTREAM_DEPENDENCY_INCOMPLETE",message:`Coverage Persistence / Evidence Validation blocked: upstream stage(s) not complete: ${missingUpstream.join(", ")}.`};
  const report=await buildReport(deps,matchId,runId);
  await deps.saveCoverage(runId,[{player_side:"P1",...report.coverage.p1},{player_side:"P2",...report.coverage.p2}]);
  await deps.saveCoverageRates(runId,[{player_side:"P1",metric_family:"ALL",direct_count:report.coverage.p1.direct,reconstructed_count:report.coverage.p1.reconstructed,partial_count:report.coverage.p1.partial,unavailable_count:report.coverage.p1.unavailable,excluded_count:report.coverage.p1.excluded,total_count:report.coverage.p1.total,usable_percent:report.coverage.p1.usablePercent},{player_side:"P2",metric_family:"ALL",direct_count:report.coverage.p2.direct,reconstructed_count:report.coverage.p2.reconstructed,partial_count:report.coverage.p2.partial,unavailable_count:report.coverage.p2.unavailable,excluded_count:report.coverage.p2.excluded,total_count:report.coverage.p2.total,usable_percent:report.coverage.p2.usablePercent}]);
  return{status:"COMPLETE",done:1,total:1,detail:{evidence_coverage:report.coverage.usablePercent,p1_total:report.coverage.p1.total,p2_total:report.coverage.p2.total}};
}

// FINAL DECISION: persists the one final_decisions row for this run from the
// current, fully-swept report. Blocked (row still written, so the reason is
// visible, but never marked COMPLETE) unless the audit is ALSO substantively
// complete (report.auditComplete -- the original row/run-derived checks:
// identity, conflicts resolved, every metric/rule/pathway/test swept,
// independent conclusion committed, firewall respected, calibration
// applied). This is the exact completion invariant the pre-16-stage
// FINAL COMBINATION GATE used to enforce, moved here since Final Decision is
// now the stage that actually writes the decision row.
async function commitFinalDecision(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{
  const missingUpstream=await requireUpstreamComplete(deps,runId,"FINAL DECISION");
  if(missingUpstream.length)return{status:"BLOCKED",done:0,total:1,errorCode:"UPSTREAM_DEPENDENCY_INCOMPLETE",message:`Final Decision blocked: upstream stage(s) not complete: ${missingUpstream.join(", ")}.`};
  const report=await buildReport(deps,matchId,runId);
  const run=await deps.getLatestRun(matchId),fields=await deps.getParsedFields(matchId),wpRaw=fields["matrix_wp"],wp=wpRaw?Number(String(wpRaw).replace(/[^\d.]/g,"")):null,{version,buckets}=await deps.getCalibration(run?.calibration_version_id??null),snapshot=buildCalibrationSnapshot({versionId:version?.id??run?.calibration_version_id??null,matrixWp:Number.isFinite(wp)?wp:null,buckets,independentLow:run?.independent_low??null,independentHigh:run?.independent_high??null}),existing=await deps.getDecisionId(runId);
  // DECISION RECORD. The deterministic audit is recomputed from the same persisted metric
  // rows the conclusion stage used -- it is a pure function, so this reproduces that result
  // exactly rather than approximating it -- and its structured features are persisted into
  // the existing gate_report jsonb (no schema change).
  //
  // This exists because the forensic review found the decision's own features surviving
  // only as prose inside a rationale string, which made a resolved
  // decision -> actual-result observation impossible to reconstruct. It assigns NO weights
  // and computes NO probability: evidence_support_percent is how the surviving evidence is
  // distributed, evidence_coverage_* is diagnostic, and neither is a win probability. The
  // calibration target (actual_winner) is left null here and filled in only when the real
  // result is known.
  const decisionMetrics=await deps.list("metric_results",runId);
  const decisionMatch=await deps.getMatch(matchId);
  const decisionRecord=decisionMatch?buildDecisionRecord({
    audit:deterministicIndependentConclusion(decisionMetrics,decisionMatch.player1_name,decisionMatch.player2_name).audit,
    // p1_unavailable_reason/p2_unavailable_reason are NOT optional decoration here: they are
    // the ONLY input metric-activation-status.ts's classifier has for telling an evidenced
    // terminal absence (SOURCE_EMPTY / INSUFFICIENT_SAMPLE / GENUINELY_UNAVAILABLE -- the
    // three statuses that may legitimately leave a metric out of the per-match denominator)
    // apart from a real pipeline defect. Omitting them sent `reason: undefined` for every
    // side, which the classifier correctly refuses to excuse and files as PRODUCER_FAILURE --
    // so the dynamic denominator silently collapsed back onto the fixed 25 for every match,
    // and every honestly-unavailable metric side was recorded in the decision record as a
    // producer defect. Diagnostic only: nothing here can reach the winner, the colour, or the
    // 60% threshold.
    metricRows:decisionMetrics.map(m=>({metric_code:String(m["metric_code"]??""),p1_treatment:m["p1_treatment"] as string|null,p2_treatment:m["p2_treatment"] as string|null,p1_value:m["p1_value"] as string|null,p2_value:m["p2_value"] as string|null,p1_unavailable_reason:m["p1_unavailable_reason"] as string|null,p2_unavailable_reason:m["p2_unavailable_reason"] as string|null})),
    now:deps.now(),
    actualWinner:(decisionMatch as unknown as{actual_winner?:string|null}).actual_winner??null,
  }):null;
  await deps.saveDecision(runId,existing,{gate_report:decisionRecord?{deterministic_decision:decisionRecord}:{},final_audit_color:report.color,final_recommendation:report.action,completion_percent:report.completionPercent,audit_complete:report.auditComplete,independent_winner:run?.independent_winner??null,independent_range:run?.independent_low!==null&&run?.independent_high!==null?`${run?.independent_low}-${run?.independent_high}`:null,calibrated_range:snapshot.calibratedLow!==null&&snapshot.calibratedHigh!==null?`${snapshot.calibratedLow}-${snapshot.calibratedHigh}`:null,calibration_version_id:snapshot.calibrationVersionId,calibration_bucket:snapshot.bucketCode,verified_win_rate:snapshot.verifiedWinRate,calibration_wins:snapshot.bucketWins,calibration_graded:snapshot.bucketGraded,green_locked:report.greenLocked,green_lock_reasons:report.greenLockReasons,matrix_firewall_valid:report.matrixFirewallValid});
  if(!(await deps.getDecisionId(runId)))throw new Error("Final decision persistence invariant failed: no decision row exists after save.");
  if(deps.verifyFinalPersistence)await deps.verifyFinalPersistence(runId,report.coverage.p1.total+report.coverage.p2.total,report.auditComplete);
  const detail={color:report.color,action:report.action,completion_percent:report.completionPercent,evidence_coverage:report.coverage.usablePercent,calibration_version_id:snapshot.calibrationVersionId,calibration_bucket:snapshot.bucketCode,verified_win_rate:snapshot.verifiedWinRate};
  if(!report.auditComplete)return{status:"BLOCKED",done:0,total:1,errorCode:"COMPLETION_INVARIANT_FAILED",message:`Final decision persisted but the audit is incomplete (${report.completionPercent}% checks; ${report.coverage.usablePercent}% supported evidence coverage).`,detail};
  return{status:"COMPLETE",done:1,total:1,detail};
}

// FINAL COMBINATION GATE: the last stage, and the ONLY stage that requires
// BOTH signals -- the row/run-derived `auditComplete` AND `stagesComplete`
// (every audit_stage_runs row for this run, including Coverage Persistence
// and Final Decision, actually persisted COMPLETE). It writes nothing of its
// own: it never infers completion merely because metric_results/
// verification_results/coverage/final_decisions rows happen to exist --
// those are evidence, not execution state, and audit_stage_runs is what
// proves the execution state.
async function finalGate(deps:PipelineDeps,matchId:string,runId:string):Promise<StageOutcome>{
  const missingUpstream=await requireUpstreamComplete(deps,runId,"FINAL COMBINATION GATE");
  if(missingUpstream.length)return{status:"BLOCKED",done:0,total:1,errorCode:"UPSTREAM_DEPENDENCY_INCOMPLETE",message:`Final Combination Gate blocked: upstream stage(s) not complete: ${missingUpstream.join(", ")}.`};
  const report=await buildReport(deps,matchId,runId);
  const detail={color:report.color,action:report.action,completion_percent:report.completionPercent,evidence_coverage:report.coverage.usablePercent,stage_gaps:report.stageGaps};
  if(!report.auditComplete||!report.stagesComplete)return{status:"BLOCKED",done:0,total:1,errorCode:"COMPLETION_INVARIANT_FAILED",message:`Final Combination Gate blocked: audit ${report.auditComplete?"substantively complete":"not substantively complete"}, stages ${report.stagesComplete?"all persisted COMPLETE":`still pending: ${report.stageGaps.join(", ")}`}.`,detail};
  return{status:"COMPLETE",done:1,total:1,detail};
}
async function buildReport(deps:PipelineDeps,matchId:string,runId:string):Promise<GateReport>{const match=await deps.getMatch(matchId),run=await deps.getLatestRun(matchId);if(!match||!run)throw new Error("match/run missing while building report");const[metrics,verification,disagreement,underdog,stress,conflicts,reconstructions,stages]=await Promise.all([deps.list("metric_results",runId),deps.list("verification_results",runId),deps.list("disagreement_results",runId),deps.list("underdog_results",runId),deps.list("stress_results",runId),deps.getConflicts(runId),deps.getReconstructions(runId),deps.getStages(runId)]);const fields=await deps.getParsedFields(matchId),wpRaw=fields["matrix_wp"],matrixWp=wpRaw?Number(String(wpRaw).replace(/[^\d.]/g,"")):null;return evaluate({match,run,metrics:metrics as never,verification:verification as never,disagreement:disagreement as never,underdog:underdog as never,stress:stress as never,reconstructions,conflicts,matrixWp,stages:stages.map(row=>({stage:row.stage,status:row.status}))});}

async function pipelineResult(deps:PipelineDeps,matchId:string,runId:string,rows:StageRow[],failures:PipelineResult["failures"],nextStage:Stage|null,leaseHeld=false):Promise<PipelineResult>{
  const complete=STAGES.every(stage=>rows.find(row=>row.stage===stage)?.status==="COMPLETE");
  return{runId,complete,nextStage:complete?null:nextStage??STAGES.find(stage=>rows.find(row=>row.stage===stage)?.status!=="COMPLETE")??null,stages:stageDetails(rows),report:await buildReport(deps,matchId,runId),failures,leaseHeld};
}
