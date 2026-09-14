import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { auditWarehouseDb } from "./postgrestCompat";
import type { MetricFinding, SourceRef } from "./audit-pipeline";
import { evidenceNameMatches, safeEvidenceAliases } from "./evidence-player-alias";
import { metricAllowsObservation } from "./metric-source-family-policy";
import { classifyEvidenceTourFamily, type EvidenceTourFamily } from "./evidence-match-identity";
import { computeHistoryMetric, type HistoryLane, type HistoryMetricCode } from "./task18c-rank-form-workload";

const db = auditWarehouseDb as any;
// Task 20 reconciliation: "005"/"007"/"021"/"061" removed from this file's history-code
// ownership -- see the header comment on HistoryMetricCode in
// task18c-rank-form-workload.ts for the full rationale (005/061 are PROCESS_META; 007's
// workload content duplicates the already-correct 012 engine; 021's Elo-differential
// content was merged into the existing 001 entry, since real 021 is already correctly
// served by deterministic-environment-metrics.server.ts). "014" is unrelated ranking-
// snapshot evidence handled by directRankingFinding below, not history-code content.
const OWNED = new Set(["001", "014"]);
const HISTORY_CODES = new Set<HistoryMetricCode>(["001"]);

type Row = { id?: string; source_id: string | null; source_name: string | null; source_url: string | null; player_name: string | null; event_date: string | null; observation_type: string | null; observation_key: string | null; text_value: string | null; numeric_value: number | null; sample_label: string | null };
function codeOf(value: unknown) { const m = String(value ?? "").match(/(\d{1,3})$/); return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0"); }
function days(a: string, b: string) { return Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000); }
function payload(row: Row) { try { return JSON.parse(row.text_value ?? "{}") as Record<string, unknown>; } catch { return {}; } }
function rank(row: Row) { const p = payload(row); const n = Number(p.rank ?? row.numeric_value); return Number.isFinite(n) && n > 0 ? n : null; }
function points(row: Row) { const p = payload(row); const n = Number(p.points); return Number.isFinite(n) && n >= 0 ? n : null; }
// Ranking points are only asserted when the snapshots for one ranking slot AGREE.
//
// Every ATP player is ingested twice for the same (circuit, date, rank) by two paths under
// different name formats ("Jannik Sinner" vs "J. Sinner"). One of them wrote the table's AGE
// column as points until the ingestion fix in tour-rankings.server.ts, so ~200 already
// persisted rows still carry ages. Sorting picks one arbitrarily, which is how metric 014's
// stored evidence came to hold "rank=3; points=23" alongside "rank=29; points=1652".
//
// Refusing to assert is the correct response to two sources contradicting each other: a
// disagreement means points are unproven for that slot, so this returns null and the value
// renders "points=NA". It never averages them, never prefers the larger, and never drops
// the row -- `rank` itself is unaffected (both duplicates agree on it) and remains the
// metric's reliable quantity. Once the ingestion fix has repopulated these rows the
// duplicates agree and points are asserted again automatically, with no further change.
function agreedPoints(rowsForSlot: Row[]) {
  const values = [...new Set(rowsForSlot.map(points).filter((v): v is number => v !== null))];
  return values.length === 1 ? values[0] : null;
}
function sourceRefs(rows: Row[]): SourceRef[] { const out: SourceRef[] = [], seen = new Set<string>(); for (const row of rows) { if (!row.source_name) continue; const key = `${row.source_name}|${row.source_url ?? ""}`; if (seen.has(key)) continue; seen.add(key); out.push({ source_name: row.source_name, url: row.source_url, retrieved_at: null }); } return out; }
function nearest(rows: Row[], asOf: string, targetDays: number) { return rows.filter(row => row.event_date && days(row.event_date, asOf) >= targetDays).sort((a, b) => Math.abs(days(a.event_date!, asOf) - targetDays) - Math.abs(days(b.event_date!, asOf) - targetDays))[0] ?? null; }
function rankingSummary(player: string, opponent: string, rows: Row[], asOf: string) { const playerRows = rows.filter(row => evidenceNameMatches(row.player_name, player, opponent) && row.event_date && row.event_date <= asOf).sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))); const current = playerRows[0] ?? null; if (!current) return null; const currentRank = rank(current); if (currentRank === null) return null; const r30 = nearest(playerRows, asOf, 30), r90 = nearest(playerRows, asOf, 90); const movement = (row: Row | null) => { const value = row ? rank(row) : null; return value === null ? null : value - currentRank; }; const ranks52 = playerRows.filter(row => row.event_date && days(row.event_date, asOf) >= 0 && days(row.event_date, asOf) <= 365).map(rank).filter((x): x is number => x !== null); const sameSlot = playerRows.filter(row => row.event_date === current.event_date && rank(row) === currentRank); return { rank: currentRank, points: agreedPoints(sameSlot), observation_date: current.event_date!, rank_change_30d: movement(r30), rank_change_90d: movement(r90), best_rank_52w: ranks52.length ? Math.min(...ranks52) : currentRank, snapshots_52w: ranks52.length }; }
function rankingValue(summary: ReturnType<typeof rankingSummary>) { if (!summary) return null; return `rank=${summary.rank}; points=${summary.points ?? "NA"}; observation_date=${summary.observation_date}; rank_change_30d=${summary.rank_change_30d ?? "NA"}; rank_change_90d=${summary.rank_change_90d ?? "NA"}; best_rank_52w=${summary.best_rank_52w}; snapshots_52w=${summary.snapshots_52w}`; }
function rowCircuit(row: Row): "ATP" | "WTA" | null { const family = classifyEvidenceTourFamily(row.source_id, row.source_name, row.sample_label, row.observation_type, row.observation_key, row.text_value); if (family === "ATP_MAIN" || family === "ATP_CHALLENGER") return "ATP"; if (family === "WTA_MAIN" || family === "WTA_CHALLENGER") return "WTA"; return null; }
function familyFromContext(context: string | null | undefined): EvidenceTourFamily | null { return classifyEvidenceTourFamily(context); }
function expectedCircuit(context: string | null | undefined, rows: Row[]): "ATP" | "WTA" | null { const family = familyFromContext(context); if (family === "ATP_MAIN" || family === "ATP_CHALLENGER") return "ATP"; if (family === "WTA_MAIN" || family === "WTA_CHALLENGER") return "WTA"; const circuits = new Set(rows.map(rowCircuit).filter((value): value is "ATP" | "WTA" => Boolean(value))); return circuits.size === 1 ? [...circuits][0] : null; }
function surfaceFromContext(context: string | null | undefined) { return String(context ?? "").match(/\bsurface\s*:?[ ]*(hard|clay|grass|carpet)\b/i)?.[1]?.toLowerCase() ?? null; }
async function rankingRows(p1: string, p2: string, start: string, asOfDate: string) { const aliases = [...new Set([...safeEvidenceAliases(p1, p2), ...safeEvidenceAliases(p2, p1)])]; const results = await Promise.all(aliases.map(alias => db.from("source_observations").select("id,source_id,source_name,source_url,player_name,event_date,observation_type,observation_key,text_value,numeric_value,sample_label").gte("event_date", start).lte("event_date", asOfDate).ilike("player_name", `%${alias}%`).order("event_date", { ascending: false }).limit(2000))); if (results.some(result => result.error)) return null; const dedup = new Map<string, Row>(); for (const result of results) for (const row of (result.data ?? []) as Row[]) { const key = String(row.id ?? `${row.source_id}|${row.player_name}|${row.event_date}|${row.observation_key}|${row.numeric_value}|${row.text_value}`); dedup.set(key, row); } return [...dedup.values()]; }
async function directRankingFinding(args: { p1: string; p2: string; asOfDate: string; context?: string | null }): Promise<MetricFinding | null> { const start = new Date(`${args.asOfDate}T00:00:00Z`); start.setUTCFullYear(start.getUTCFullYear() - 2); const fetched = await rankingRows(args.p1, args.p2, start.toISOString().slice(0, 10), args.asOfDate); if (!fetched) return null; const circuit = expectedCircuit(args.context, fetched); if (!circuit) return null; const rows = fetched.filter(row => metricAllowsObservation("014", row) && rowCircuit(row) === circuit && row.event_date && row.event_date <= args.asOfDate); if (!rows.length) return null; const p1Summary = rankingSummary(args.p1, args.p2, rows, args.asOfDate), p2Summary = rankingSummary(args.p2, args.p1, rows, args.asOfDate); const p1 = rankingValue(p1Summary), p2 = rankingValue(p2Summary); if (!p1 || !p2) return null; return { metric_code: "014", p1_value: p1, p2_value: p2, p1_treatment: "DIRECT", p2_treatment: "DIRECT", differential: p1Summary && p2Summary ? `ranking_gap_p1_minus_p2=${p1Summary.rank - p2Summary.rank}` : null, evidence_family: "RANKING", reliability: 95, sample: `source_observations=official ${circuit} ranking snapshots; date_window=observation_date<=${args.asOfDate}; players=${args.p1} vs ${args.p2}; calculation=latest valid ranking plus historical trend; output=pair-complete; metric=014; circuit=${circuit}; match_date=${args.asOfDate}; future_leakage=blocked`, unavailable_reason: null, sources: sourceRefs(rows) }; }
// Task 20 reconciliation note: evidence_family is always "RANKING_FORM" here because
// HISTORY_CODES/HistoryMetricCode is now locked to "001" only -- the old "007"/"061"
// RESULTS_SCHEDULE branch this file used to need is unreachable (those codes are no
// longer valid HistoryMetricCode values; see task18c-rank-form-workload.ts).
function historyFinding(args: { code: HistoryMetricCode; p1: string; p2: string; asOfDate: string; context?: string | null }): MetricFinding | null { const family = familyFromContext(args.context); if (!family) return null; const lane = (loadRuntimeIndex() as any)?.matchHistory?.[family] as HistoryLane | undefined; if (!lane || typeof lane !== "object") return null; const result = computeHistoryMetric({ code: args.code, p1: args.p1, p2: args.p2, asOfDate: args.asOfDate, family, surface: surfaceFromContext(args.context), lane }); if (!result) return null; return { metric_code: args.code, p1_value: result.p1_value, p2_value: result.p2_value, p1_treatment: result.treatment, p2_treatment: result.treatment, differential: result.differential, evidence_family: "RANKING_FORM", reliability: result.reliability, sample: result.sample, unavailable_reason: result.unavailable_reason, sources: result.source_names.map(source_name => ({ source_name, url: null, retrieved_at: null })) }; }
export async function deterministicRankingMetric(args: { metricCode: string; p1: string; p2: string; asOfDate: string; context?: string | null }): Promise<MetricFinding | null> { const code = codeOf(args.metricCode); if (!OWNED.has(code)) return null; if (code === "014") return directRankingFinding(args); if (!HISTORY_CODES.has(code as HistoryMetricCode)) return null; return historyFinding({ ...args, code: code as HistoryMetricCode }); }
