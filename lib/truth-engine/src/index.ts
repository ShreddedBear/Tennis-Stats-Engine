// ----------------------------------------------------------------------------
// @workspace/truth-engine — the Tennis Matrix Audit's deterministic core.
//
// This package is the Truth Engine exactly as it was audited and frozen in the
// standalone Audit application: the 25 active metrics' comparison specs, family
// consolidation, the 60% directional-evidence threshold, leave-one-family-out,
// the verification / disagreement / dangerous-underdog / stress layers, the
// 16-stage pipeline and its dependency gate, coverage accounting, the activation
// taxonomy behind the dynamic evidence denominator, and result resolution.
//
// WHAT IT DELIBERATELY DOES NOT CONTAIN: any database client, any HTTP
// transport, any provider SDK, any React. The whole pipeline is driven through
// `PipelineDeps` (audit-pipeline.ts), which is what let the engine move here
// unchanged -- the standalone app's Supabase implementation of that interface
// stayed behind, and the monorepo supplies its own Postgres one. Nothing in this
// package can be made to depend on where the data lives.
//
// It is also NOT the AI prediction engine. This package never produces a
// probability: it produces a deterministic selection or an explicit refusal,
// with the evidence chain that justifies it. The two engines live side by side
// in this workspace and must not be merged.
// ----------------------------------------------------------------------------

// --- Pipeline orchestration and its injected data contract -------------------
export {
  runPipeline,
  preparePipelineRun,
  metricPairPatch,
  metricRowsForSideExecution,
  pass2WriteBackPatch,
  preserveSettledOppositeSide,
  preserveUsableCurrentSide,
  claimRetrievalForExecutingSideOnly,
  enforceStageDependencies,
  deterministicIndependentConclusion,
  TREATMENTS,
  STAGES,
  STAGE_DEPENDENCIES,
  unmetDependencies,
  isActiveRunStatus,
  resolveActiveRun,
  INVALIDATED_RUN_STATUS,
} from "./audit-pipeline";
export type {
  PipelineDeps,
  PipelineResult,
  Researcher,
  MatchRow,
  RunRow,
  RuleDef,
  StageRow,
  ChildTable,
  Stage,
  Treatment,
  SourceRef,
  IdentityFinding,
  MetricFinding,
  RuleFinding,
  UnderdogFinding,
  StressFinding,
  ConclusionFinding,
  EvidenceDigest,
  StageDependencyGuard,
  Pass2WriteBackContext,
} from "./audit-pipeline";

// --- Stage model -------------------------------------------------------------
export { FINAL_STAGE, canonicalizeStageRows } from "./audit-stages";
export type { StageStatusRow, RunStatusRow } from "./audit-stages";

// --- Completion engine: coverage, gate report, colour ------------------------
export { evaluate, bucketFor, winRate, DONE_STATES } from "./audit-engine";
export type { EngineInput, GateReport, CoverageReport, CountPair } from "./audit-engine";

// --- Deterministic decision core --------------------------------------------
export {
  decideTruthEngineSelection,
  EVIDENCE_SELECTION_THRESHOLD,
  MIN_COMPARISONS_PER_FAMILY,
  MIN_INDEPENDENT_SUPPORT_FAMILIES,
} from "./truth-engine-decision";
export type { TruthEngineDecision, FamilyEvidence, FamilyVote, SelectionOutcome, SelectionStability } from "./truth-engine-decision";

// --- The 25 active metrics and their comparison contract ---------------------
export { COMPARISON_SPECS, compareMetricRow, compareMetricRows, parseMetricValue } from "./truth-engine-metric-comparison";
export type { ComparisonSpec, MetricComparison, MetricRowForComparison, ComparisonStatus, ComparisonFavours, ComparisonDirection } from "./truth-engine-metric-comparison";
export { ACTIVE_METRIC_CODES, isActiveMetricCode, normalizeMetricCode, activeMetricReadiness } from "./truth-engine-active-metrics";
export type { ActiveMetricReadiness, MetricRowForReadiness, ActiveMetricOutcome } from "./truth-engine-active-metrics";

// --- Audit layers: verification / disagreement / underdog / stress -----------
export { runTruthEngineAudit, runVerificationAudit, runDisagreementAudit, runUnderdogAnalysis, runStressTest, magnitudeRatio } from "./truth-engine-audit";
export type { TruthEngineAuditResult, VerificationAudit, DisagreementAudit, UnderdogAnalysis, StressTest, Severity } from "./truth-engine-audit";
export { verificationRowPatch, disagreementRowPatch, underdogRowPatch, stressRowPatch, unmappedUnderdogPathways, STRESS_OUTCOME_NOT_EVALUATED } from "./truth-engine-stage-mapping";
export type { StageRowPatch } from "./truth-engine-stage-mapping";

// --- The persisted decision record (the calibration-facing feature set) ------
export { buildDecisionRecord, isResolvedObservation } from "./truth-engine-decision-record";
export type { TruthEngineDecisionRecord, DecisionFamilyRecord, DecisionRecordInput } from "./truth-engine-decision-record";

// --- Metric classification and activation taxonomy ---------------------------
export { classifyMetric, META_OR_NON_PLAYER_CODES, PROTECTED_UNAVAILABLE_CODES, MATRIX_SUMMARY_REQUIRED_CODES } from "./metric-classification";
export { classifySideActivation, classifyMetricActivation, DENOMINATOR_EXCUSED_STATUSES } from "./metric-activation-status";
export type { ActivationStatus, MetricActivationForMatch, PersistedUnavailableReason, SideActivationInput } from "./metric-activation-status";

// --- Result capture and grading ---------------------------------------------
export { captureAndResolveResults, selectedPlayerForRun, isResolvedGrade } from "./match-result-capture";
export type { ResultCaptureDeps, ResultCaptureSummary, CaptureMatchRow, CaptureRunRow, CaptureDecisionRow, CaptureGradeRow } from "./match-result-capture";
export { resolvePredictionOutcome, matchResultIsFinal, matchSideForName, playerNamesMatch, mergeCapturedResult, resultStatusFromHistory, FINAL_RESULT_STATUSES, NON_FINAL_RESULT_STATUSES } from "./match-result-resolution";
export type { PredictionResolution, MatchResultFacts, CapturedResult, ResolutionStatus } from "./match-result-resolution";

// --- Batch / drive scheduling, progress, current-run resolution --------------
export { normalizeBatchMatchIds, mapBounded, dispatchAuditBatch } from "./audit-batch";
export { failureSignature, isStuck, describeFailure } from "./audit-drive";
export type { DriveOutcome } from "./audit-drive";
export { latestRunsByMatch, currentAuditRows, activeSlateMatchIds, activeRunIds, isRowOnActiveSlate } from "./current-audit-state";

// --- Calibration snapshot (applies a stored bucket; computes no probability) --
export { buildCalibrationSnapshot } from "./calibration-snapshot";

// --- Evidence reconstruction (dossier -> catalogued statistics) --------------
export { reconstruct } from "./reconstruction/engine";
export type { SourcedStat, StatSource, StatOrigin } from "./reconstruction/engine";
export { STAT_CATALOG, STAT_BY_KEY, familyOf } from "./reconstruction/stat-catalog";

// --- Summary ingestion: PDF text -> matchups, and the canonical match key ----
// Pure parsing. The canonical key is what makes "the same real match" resolve to the same
// match row across uploads, and what keeps two genuinely different matches apart.
export { parseSummaryText, canonicalKey, normalizeName } from "./summary-parser";
export type { ParsedMatchup, ParsedField, ExtractionStatus } from "./summary-parser";
export { parseRuleDocument } from "./rule-parser";

// --- Definition documents ----------------------------------------------------
export { UNDERDOG_PATHWAYS, STRESS_TESTS, LOCAL_WORKSPACE_ID } from "./constants";
