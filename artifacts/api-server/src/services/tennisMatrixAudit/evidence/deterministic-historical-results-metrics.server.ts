import type { MetricFinding, SourceRef } from "./audit-pipeline";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { buildCanonicalEvidenceMatchIdentity, classifyEvidenceTourFamily, type EvidenceTourFamily } from "./evidence-match-identity";
import { repositoryHistoryAvailable, repositoryResultsRows, type RepositoryResultsObservation } from "./repository-results-history.server";
import { deriveHistoricalResultMetric, TASK18A_HISTORICAL_RESULTS_CODES, type HistoricalResultRow } from "./historical-results-recovery";

// "006" is deliberately EXCLUDED from what this pipeline wrapper will answer, even though
// deriveHistoricalResultMetric (historical-results-recovery.ts) still computes a real,
// tested code-006 value and TASK18A_HISTORICAL_RESULTS_CODES still lists it. The canonical
// registry (public/seed/metrics.txt, category "6. Opponent Quality") names FIVE separate
// bullets under code 006, including both "Opponent-Adjusted Strength of Schedule" (a
// 90-day quality-banded win rate -- what deriveHistoricalResultMetric computes) and
// "Bad-Loss Rate" (share of losses to significantly weaker opponents). COMPARISON_SPECS's
// own declared field for 006 is "bad_loss_rate_pct", with its comment explicitly naming
// predixsport-recent.server.ts as the correct producer for that specific bullet -- a
// different quantity from the quality-banded win rate this file computes. Before this fix,
// this early deterministic tier ran first in the researcher waterfall and returned a
// "fully usable" (self-claimed) finding for 006 on ~40% of rows, which stopped the pipeline
// from ever trying the tier that actually supplies bad_loss_rate_pct -- the wrong bullet
// pre-empted the right one. See hybrid-audit-research.server.ts's selectedStats(), which
// was also missing the getRecentReconstruction() wiring that supplies bad_loss_rate_pct for
// code 006 at all (fixed alongside this). deriveHistoricalResultMetric's own code-006
// branch and its direct tests are left exactly as they are -- a real, useful, correctly
// computed diagnostic for a DIFFERENT bullet of the same composite metric code -- only its
// place in the live comparison pipeline changes.
const PIPELINE_EXCLUDED=new Set<string>(["006"]);
const OWNED=new Set<string>(TASK18A_HISTORICAL_RESULTS_CODES.filter(code=>!PIPELINE_EXCLUDED.has(code)));
function codeOf(v:unknown){const m=String(v??"").match(/(\d{1,3})$/);return m?m[1].padStart(3,"0"):String(v??"").padStart(3,"0");}
function contextSurface(context:string|null|undefined){const m=String(context??"").match(/(?:^|[|·;])\s*surface\s*[:=]?\s*(hard|clay|grass|carpet)\b/i);return m?m[1]:null;}
function canonicalKey(value:string|null|undefined){return normalizeEvidenceIdentity(String(value??""));}
function parsePayload(row:RepositoryResultsObservation){const p=row.raw_payload??{};const d=(p.history_detail&&typeof p.history_detail==="object"?p.history_detail:{}) as Record<string,unknown>;const n=(v:unknown)=>{const x=Number(v);return Number.isFinite(x)&&v!==null&&v!==""?x:null;};const pairs=Array.isArray(d.set_scores)?d.set_scores.flatMap(v=>Array.isArray(v)&&v.length>=2&&Number.isFinite(Number(v[0]))&&Number.isFinite(Number(v[1]))?[[Number(v[0]),Number(v[1])] as [number,number]]:[]):[];return {winner:canonicalKey(String(p.winner??""))||null,detail:{setsFor:n(d.sets_for),setsAgainst:n(d.sets_against),setScores:pairs,bestOf:n(d.best_of),opponentRank:n(d.opponent_rank),opponentElo:n(d.opponent_elo),status:d.status==null?null:String(d.status)}};}
function historicalRows(rows:RepositoryResultsObservation[]):HistoricalResultRow[]{return rows.flatMap(row=>{if(!row.event_date||!row.player_name||!row.opponent_name)return[];const player=canonicalKey(row.player_name),opponent=canonicalKey(row.opponent_name);if(!player||!opponent)return[];const parsed=parsePayload(row);const won=parsed.winner===player?true:parsed.winner===opponent?false:null;return[{date:row.event_date,player,opponent,won,surface:row.surface,tournament:row.tournament,...parsed.detail}];});}
function refs(rows:RepositoryResultsObservation[]):SourceRef[]{const seen=new Set<string>();const out:SourceRef[]=[];for(const row of rows){const k=row.source_name;if(seen.has(k))continue;seen.add(k);out.push({source_name:k,url:null,retrieved_at:null});}return out;}

export async function deterministicHistoricalResultsMetric(args:{metricCode:string;p1:string;p2:string;asOfDate:string;tournament?:string|null;surface?:string|null;tourFamily?:EvidenceTourFamily|null;context?:string|null;}):Promise<MetricFinding|null>{
  const code=codeOf(args.metricCode);if(!OWNED.has(code))return null;
  const family=args.tourFamily??classifyEvidenceTourFamily(args.context,args.tournament);if(!family)return null;
  // A player with zero repository coverage for this tour family must not sink the OTHER
  // player's real coverage too -- require only ONE side to have something, same reasoning
  // as the aOk/bOk split below. For the self-history-only codes (005/006/008/010/011/068)
  // the missing side's own deriveHistoricalResultMetric call simply returns null (its
  // `rows` filter never matches that player), which the aOk/bOk split already handles
  // correctly; for the opponent-referencing codes (007/080) a missing opponent side
  // correctly yields no common-opponent evidence for either side too, which is honest, not
  // a regression.
  if(!repositoryHistoryAvailable(args.p1,family)&&!repositoryHistoryAvailable(args.p2,family))return null;
  const p1Rows=repositoryResultsRows(args.p1,family,args.asOfDate,{strictBefore:true});const p2Rows=repositoryResultsRows(args.p2,family,args.asOfDate,{strictBefore:true});if(!p1Rows.length&&!p2Rows.length)return null;
  const allObs=[...p1Rows,...p2Rows];const rows=historicalRows(allObs);const surface=args.surface??contextSurface(args.context);const p1=canonicalKey(args.p1),p2=canonicalKey(args.p2);if(!p1||!p2||p1===p2)return null;
  const a=deriveHistoricalResultMetric({code,player:p1,opponent:p2,rows,asOfDate:args.asOfDate,surface,tournament:args.tournament});const b=deriveHistoricalResultMetric({code,player:p2,opponent:p1,rows,asOfDate:args.asOfDate,surface,tournament:args.tournament});
  const aOk=!!a&&a.sampleSize>0,bOk=!!b&&b.sampleSize>0;
  // A player with genuinely zero qualifying events for THIS metric (e.g. zero deciding-set
  // matches ever) must not sink the OTHER player's real, independently-derived evidence.
  // This used to require both sides non-null before returning anything, so one side's
  // legitimate zero-history discarded the other side's real computed value wholesale --
  // exactly the one-sided-evidence-becomes-fabricated-unavailability bug this file's own
  // callers (metricPairPatch, compareMetricRow) are built to never do. Only return null
  // here when NEITHER side has anything real; a later tier is free to try if so.
  if(!aOk&&!bOk)return null;
  // Bug fix: this used to hardcode `code==="057"?"PARTIAL":"RECONSTRUCTED"` -- "057" is
  // not even a code this file owns (it's real PROCESS_META, retargeted away long before
  // this wrapper was last touched). Since 013/017/068 were added to
  // TASK18A_HISTORICAL_RESULTS_CODES with treatment PARTIAL, that hardcoded guess meant
  // a.treatment (correctly "PARTIAL") never matched the guessed "RECONSTRUCTED", so this
  // wrapper silently discarded every finding for 013/017/068 no matter what data existed
  // -- confirmed by reading deriveHistoricalResultMetric's own per-code treatment values,
  // not by guessing. Use the treatment deriveHistoricalResultMetric actually returned
  // (per side that actually produced one) instead of a hardcoded per-code guess.
  const treatment=(aOk?a:b)!.treatment;
  const canonical=buildCanonicalEvidenceMatchIdentity({player1Name:args.p1,player2Name:args.p2,tournament:args.tournament,date:args.asOfDate,tour:family});
  const provenance={metric:code,tour_family:family,target_match:canonical.key,surface,cutoff:`strictly before ${args.asOfDate}`,p1:aOk?{raw_inputs:a!.rawInputs,transformation:a!.transformation,output:a!.value,sample_size:a!.sampleSize}:{unavailable:true},p2:bOk?{raw_inputs:b!.rawInputs,transformation:b!.transformation,output:b!.value,sample_size:b!.sampleSize}:{unavailable:true}};
  const partialReason=treatment==="PARTIAL"?"Retirement/walkover status is only credited for rows with explicitly preserved status; missing status is never treated as a normal completion.":null;
  return {
    metric_code:code,
    p1_value:aOk?a!.value:null,p2_value:bOk?b!.value:null,
    p1_treatment:aOk?a!.treatment:"UNAVAILABLE",p2_treatment:bOk?b!.treatment:"UNAVAILABLE",
    differential:null,evidence_family:"RESULTS_HISTORY",reliability:(aOk||bOk)?(treatment==="PARTIAL"?72:92):null,
    sample:JSON.stringify(provenance),
    unavailable_reason:!aOk||!bOk?(partialReason??"This player has no qualifying historical events for this metric's own definition (e.g. zero deciding-set matches, zero common opponents) in the available repository history."):partialReason,
    p1_unavailable_reason:aOk?null:"This player has no qualifying historical events for this metric's own definition in the available repository history.",
    p2_unavailable_reason:bOk?null:"This player has no qualifying historical events for this metric's own definition in the available repository history.",
    sources:refs(allObs),
  };
}