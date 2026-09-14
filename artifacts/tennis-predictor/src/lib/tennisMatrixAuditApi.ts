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

export const getAuditLogs = (limit = 200) =>
  request<{ logs: AuditRow[] }>(`/api/tennis-matrix-audit/logs?limit=${limit}`);

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
