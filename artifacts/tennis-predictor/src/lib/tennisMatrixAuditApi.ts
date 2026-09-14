/**
 * Client for the Tennis Matrix Audit section.
 *
 * The Audit is a separate engine from the AI prediction model. Everything it reports is
 * deterministic: a selection with the evidence chain behind it, or an explicit refusal.
 * Nothing this module returns is a probability, and nothing in it should ever be rendered
 * as one -- the percentages below are an evidence SHARE (how the surviving directional
 * evidence is distributed) and an evidence COVERAGE (how much usable evidence existed).
 */

export type AuditColor =
  | "DOUBLE GREEN" | "GREEN" | "YELLOW" | "RED / PASS" | "INSUFFICIENT EVIDENCE" | "INCOMPLETE";

export interface AuditRow { [key: string]: unknown }

export interface GateReport {
  color: AuditColor;
  action: string;
  completionPercent: number;
  auditComplete: boolean;
  stagesComplete: boolean;
  stageGaps: string[];
  greenLocked: boolean;
  greenLockReasons: string[];
  effectiveEvidenceCount: number;
  matrixFirewallValid: boolean;
  checks: Array<{ key: string; label: string; pass: boolean; detail: string }>;
  counts: Record<string, { done: number; total: number }>;
  coverage: {
    usablePercent: number;
    thresholdPercent: number;
    p1: Record<string, unknown>;
    p2: Record<string, unknown>;
  };
}

export interface SlateEntry {
  match: AuditRow;
  run: AuditRow | null;
  decision: AuditRow | null;
  /** Canonical winner identity from the persisted decision record -- never parsed from prose. */
  selected_player: string | null;
}

export interface MatchDetail {
  match: AuditRow;
  run: AuditRow | null;
  wasInvalidated: boolean;
  stages: Array<{ stage: string; row: AuditRow | null }>;
  metrics: AuditRow[];
  verification: AuditRow[];
  disagreement: AuditRow[];
  underdog: AuditRow[];
  stress: AuditRow[];
  reconstructions: AuditRow[];
  coverage: AuditRow[];
  decision: AuditRow | null;
  report: GateReport | null;
  readiness: {
    expected: number; usable: number; oneSided: number; unavailable: number;
    notExecuted: number; percent: number; eligible: number; eligiblePercent: number;
    byCode: Array<{ code: string; outcome: string; activation: { p1: string; p2: string; activated: boolean; countsTowardDenominator: boolean } }>;
  } | null;
}

export interface RunSliceResult {
  ok: boolean;
  runId: string;
  complete: boolean;
  nextStage: string | null;
  stages: Array<{ stage: string; status: string; detail: string }>;
  failures: Array<{ stage: string; message: string }>;
  leaseHeld: boolean;
  color: AuditColor | null;
  action: string | null;
  completionPercent: number | null;
  auditComplete: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const getAuditSlate = () =>
  request<{ slate: SlateEntry[]; count: number }>("/api/tennis-matrix-audit/slate");

export const getAuditMatch = (matchId: string) =>
  request<MatchDetail>(`/api/tennis-matrix-audit/match/${encodeURIComponent(matchId)}`);

/**
 * One time-boxed slice. The pipeline persists partial stage progress and holds a lease, so
 * calling this repeatedly resumes the same run -- it never restarts it or creates a
 * duplicate. Callers drive a long audit by looping until `complete`.
 */
export const runAuditSlice = (matchId: string) =>
  request<RunSliceResult>(`/api/tennis-matrix-audit/match/${encodeURIComponent(matchId)}/run`, { method: "POST" });

/**
 * Execution logs. Scoped to current runs by default: a cleared match's rows are real
 * history and are never deleted, but they must not read as current operational output.
 */
export const getAuditLogs = (scope: "active" | "all" = "active", limit = 300) =>
  request<{ logs: AuditRow[]; scope: string; total: number }>(
    `/api/tennis-matrix-audit/logs?limit=${limit}&scope=${scope}`,
  );

export const getActiveMetrics = () =>
  request<{
    active_codes: string[];
    count: number;
    specs: Record<string, { label: string; field: string | null; direction: string; family: string; materiality: number }>;
    stages: string[];
  }>("/api/tennis-matrix-audit/metrics");

export const clearAuditSlate = () =>
  request<{ ok: boolean; deleted_matches: number }>("/api/tennis-matrix-audit/clear-slate", {
    method: "POST",
    body: JSON.stringify({ confirm: "CLEAR SLATE" }),
  });

// --- INGESTION ---------------------------------------------------------------------
export interface ParsedField {
  field_key: string; raw_value: string | null; normalized_value: string | null;
  extraction_status: string; confidence: number; page_number: number;
}
export interface ParsedMatchup {
  player1_name: string; player2_name: string; page_number: number;
  fields: ParsedField[]; confidence: number;
}
export interface ExtractedPdf { filename: string; pages: string[]; matchups: ParsedMatchup[] }

/**
 * The context fields shown for review before a parse is committed. Mirrors the server's
 * REVIEW_FIELDS: these are the fields that decide which match row a parse resolves to, so
 * they are the ones a person has to be able to see and correct.
 */
export const REVIEW_FIELDS = ["tournament", "event_level", "round", "scheduled_date", "surface", "best_of"];

/** Reads the PDFs and reports what was detected. Writes nothing. */
export const extractSummaries = (files: Array<{ filename: string; base64: string }>) =>
  request<{ files: ExtractedPdf[]; failures: Array<{ filename: string; message: string }> }>(
    "/api/tennis-matrix-audit/ingest/extract",
    { method: "POST", body: JSON.stringify({ files }) },
  );

/** Persists the reviewed matchups. Match identity is resolved server-side. */
export const commitSummaries = (files: ExtractedPdf[]) =>
  request<{ created: number; reused: number; versions: number; matchIds: string[]; errors: Array<{ match: string; message: string }> }>(
    "/api/tennis-matrix-audit/ingest/commit",
    { method: "POST", body: JSON.stringify({ files }) },
  );

/** Reads a File as base64 without File.arrayBuffer(), which some WebKit uploads lack. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// --- DASHBOARD & RUN HISTORY -------------------------------------------------------
export interface AuditDashboard {
  slate: { matches: number; withRun: number; completed: number; notRun: number; uploads: number };
  colors: Record<string, number>;
  calibration: {
    label: string; masterSequence: number; gradedSample: number;
    buckets: Array<{ bucket_code: string; wins: number; graded: number; win_rate: number | null }>;
  } | null;
}

export const getAuditDashboard = () => request<AuditDashboard>("/api/tennis-matrix-audit/dashboard");

export interface RunHistoryEntry extends AuditRow {
  isCurrent: boolean;
  decision: AuditRow | null;
  selected_player: string | null;
}

/** Every run this match has had — superseded runs included, never deleted. */
export const getMatchRunHistory = (matchId: string) =>
  request<{ runs: RunHistoryEntry[] }>(`/api/tennis-matrix-audit/match/${encodeURIComponent(matchId)}/runs`);

// --- READINESS ---------------------------------------------------------------------
/**
 * What the Audit needs before it can produce a selection rather than a refusal. Worth a
 * dedicated call because all three failure modes look identical from the slate — every
 * match refuses with INSUFFICIENT EVIDENCE — and the reason is never the match.
 */
export interface AuditReadiness {
  definitions: {
    ready: boolean;
    missing: string[];
    documents: Array<{ docType: string; status: string; parsed: number; expected: number }>;
  };
  sources: { ready: boolean; count: number };
  runtimeIndex: { ready: boolean; players: number; matches: number; generatedAt: string | null };
  /** Reports only whether a provider key is present. Never the key itself. */
  researchProvider: { ready: boolean; variable: string };
}

export const getAuditReadiness = () => request<AuditReadiness>("/api/tennis-matrix-audit/readiness");

export const bootstrapAuditDefinitions = () =>
  request<{
    calibration: string; sources: string;
    documents: Array<{ docType: string; status: string; expected: number; parsed: number; activated: boolean }>;
  }>("/api/tennis-matrix-audit/bootstrap", { method: "POST" });

// --- MASTER RANKED BOARD -----------------------------------------------------------
export interface BoardRow {
  matchId: string; matchLabel: string; selection: string | null;
  tournament: string | null; surface: string | null;
  /** The Matrix summary's own claim. Shown to be judged, never used to rank. */
  matrixPick: string | null; matrixWp: string | null;
  bucket: string | null; verifiedWinRate: number | null;
  independentWinner: string | null; independentRange: string | null; calibratedRange: string | null;
  evidence: number; color: string; action: string | null; completion: number;
}

export const getAuditBoard = () => request<{ rows: BoardRow[] }>("/api/tennis-matrix-audit/board");

// --- CALIBRATION -------------------------------------------------------------------
export interface CalibrationBucket {
  id: string; bucket_code: string; bucket_label: string;
  wp_min: number; wp_max: number; wins: number; graded: number;
  small_sample: boolean; win_rate: number | null;
}
export interface CalibrationView {
  version: AuditRow | null;
  buckets: CalibrationBucket[];
  ledger: AuditRow[];
}
export interface GradeInput {
  matchId: string | null; matchLabel: string; tournament: string | null; surface: string | null;
  matchDate: string | null; matrixPredictedWinner: string | null; matrixWp: string | null;
  resultType: string; actualWinner: string | null; note: string | null;
}

/** Retirements are real results. Walkovers and voids are recorded but never counted. */
export const RESULT_TYPES = ["WIN", "LOSS", "RETIREMENT WIN", "RETIREMENT LOSS", "WALKOVER", "VOID"];

export const getCalibration = () => request<CalibrationView>("/api/tennis-matrix-audit/calibration");

export const getCalibrationHistory = () =>
  request<{ versions: AuditRow[]; buckets: Array<CalibrationBucket & { calibration_version_id: string }> }>(
    "/api/tennis-matrix-audit/calibration/history",
  );

/** Fills the PREDICTION fields only. The actual result is always entered by hand. */
export const getCalibrationPrefill = (matchId: string) =>
  request<{
    matchLabel: string; tournament: string | null; surface: string | null;
    matchDate: string | null; matrixPredictedWinner: string | null; matrixWp: number | null;
  }>(`/api/tennis-matrix-audit/calibration/prefill/${encodeURIComponent(matchId)}`);

export const gradeCalibrationResult = (input: GradeInput) =>
  request<{ version: AuditRow; bucketCode: string | null; counted: boolean }>(
    "/api/tennis-matrix-audit/calibration/grade",
    { method: "POST", body: JSON.stringify(input) },
  );

// --- SOURCES, RULES, LOGS ----------------------------------------------------------
export const getAuditSources = () =>
  request<{ snapshots: AuditRow[]; conflicts: AuditRow[] }>("/api/tennis-matrix-audit/sources");

export const resolveSourceConflict = (id: string, resolution: "RESOLVED" | "UNRESOLVABLE") =>
  request<{ ok: boolean }>(`/api/tennis-matrix-audit/sources/conflict/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ resolution }),
  });

export const getAuditRules = () =>
  request<{ documents: AuditRow[]; versions: AuditRow[]; rules: AuditRow[] }>("/api/tennis-matrix-audit/rules");

/** Tailwind classes for an audit colour. Presentation only -- never used to derive a winner. */
export function colorClasses(color: AuditColor | string | null | undefined): string {
  switch (color) {
    case "DOUBLE GREEN": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "GREEN": return "bg-green-500/15 text-green-400 border-green-500/30";
    case "YELLOW": return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "RED / PASS": return "bg-red-500/15 text-red-400 border-red-500/30";
    case "INSUFFICIENT EVIDENCE": return "bg-slate-500/15 text-slate-300 border-slate-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}
