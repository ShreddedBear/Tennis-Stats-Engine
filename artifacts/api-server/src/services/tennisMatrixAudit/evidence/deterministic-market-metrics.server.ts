import { auditWarehouseDb } from "./postgrestCompat";
import type { MetricFinding } from "./audit-pipeline";
import { evidencePairMatches, safeEvidenceAliases } from "./evidence-player-alias";
import { metricAllowsObservation } from "./metric-source-family-policy";
import { classifyEvidenceTourFamily, evidenceTourCompatible, normalizeEvidenceTournament, type EvidenceTourFamily } from "./evidence-match-identity";
import { certifyMetricFinding } from "./metric-certification";

const db = auditWarehouseDb as any;
const MARKET_CODES = new Set(["015", "019", "043", "044"]);
const from = "2020-06-06";

type MarketRow = {
  source_id: string | null;
  source_name: string | null;
  source_url: string | null;
  source_record_key: string | null;
  player_name: string | null;
  opponent_name: string | null;
  tournament: string | null;
  event_date: string | null;
  observation_type: string | null;
  observation_key: string | null;
  numeric_value: number | null;
  source_published_at: string | null;
  sample_label: string | null;
  raw_payload: any;
  provenance: any;
};

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function implied(decimalOdds: number) { return decimalOdds > 1 ? 1 / decimalOdds : null; }
function snapshotKey(row: MarketRow) { return String(row.provenance?.snapshot_timestamp ?? row.source_published_at ?? row.source_record_key ?? "unknown"); }
function bookmakerKey(row: MarketRow) { return String(row.provenance?.bookmaker_key ?? row.sample_label ?? "unknown"); }

function deVigForPlayer(playerRows: MarketRow[], opponentRows: MarketRow[]) {
  const oppByPair = new Map<string, number>();
  for (const row of opponentRows) { if (!row.numeric_value) continue; oppByPair.set(`${snapshotKey(row)}|${bookmakerKey(row)}`, row.numeric_value); }
  const probs: number[] = [];
  for (const row of playerRows) {
    if (!row.numeric_value) continue;
    const oppOdds = oppByPair.get(`${snapshotKey(row)}|${bookmakerKey(row)}`);
    if (!oppOdds) continue;
    const p = implied(row.numeric_value); const q = implied(oppOdds);
    if (p == null || q == null || p + q <= 0) continue;
    probs.push(p / (p + q));
  }
  return probs;
}

function movement(rows: MarketRow[]) {
  const pts = rows.filter((r) => typeof r.numeric_value === "number" && r.numeric_value! > 1)
    .map((r) => ({ t: Date.parse(String(r.source_published_at ?? r.provenance?.snapshot_timestamp ?? "")), p: implied(r.numeric_value!) }))
    .filter((x) => Number.isFinite(x.t) && x.p != null).sort((a, b) => a.t - b.t) as Array<{ t: number; p: number }>;
  if (pts.length < 2) return null;
  return pts[pts.length - 1].p - pts[0].p;
}

function eventCompatible(row: MarketRow, tournament?: string | null) {
  if (!tournament) return true;
  const expected = normalizeEvidenceTournament(tournament);
  const actual = normalizeEvidenceTournament(row.tournament ?? row.provenance?.tournament ?? row.raw_payload?.sport_title);
  if (!expected || !actual) return true;
  return expected === actual || expected.includes(actual) || actual.includes(expected);
}

function rowTourFamily(row: MarketRow) {
  return classifyEvidenceTourFamily(row.tournament, row.raw_payload?.sport_key, row.raw_payload?.sport_title, row.provenance?.sport_key, row.sample_label);
}

function expectedMarketFamily(args: { context?: string | null; tournament?: string | null }, rows: MarketRow[]): EvidenceTourFamily | null {
  const explicit = classifyEvidenceTourFamily(args.context, args.tournament);
  if (explicit) return explicit;
  const families = new Set(rows.map(rowTourFamily).filter((family): family is EvidenceTourFamily => Boolean(family)));
  return families.size === 1 ? [...families][0] : null;
}

async function loadSide(player: string, opponent: string, matchDate: string, tournament?: string | null) {
  const playerAliases = safeEvidenceAliases(player, opponent);
  const opponentAliases = safeEvidenceAliases(opponent, player);
  const { data, error } = await db.from("source_observations")
    .select("source_id,source_name,source_url,source_record_key,player_name,opponent_name,tournament,event_date,observation_type,observation_key,numeric_value,source_published_at,sample_label,raw_payload,provenance")
    .eq("source_id", "odds_api").eq("observation_type", "MARKET").eq("event_date", matchDate)
    .in("player_name", playerAliases).in("opponent_name", opponentAliases)
    .order("source_published_at", { ascending: true });
  if (error) return [] as MarketRow[];
  return ((data ?? []) as MarketRow[]).filter((row) => evidencePairMatches(row.player_name, row.opponent_name, player, opponent) && eventCompatible(row, tournament));
}

function summarizeMarket(rows: MarketRow[], opponentRows: MarketRow[]) {
  const odds = rows.map((r) => Number(r.numeric_value)).filter((v) => Number.isFinite(v) && v > 1);
  const rawImplied = odds.map((o) => 1 / o); const devig = deVigForPlayer(rows, opponentRows);
  return { observations: odds.length, paired_devig_observations: devig.length, avg_decimal_odds: mean(odds), median_decimal_odds: median(odds), avg_raw_implied_probability: mean(rawImplied), avg_devig_probability: mean(devig), probability_movement: movement(rows), favorite_share: rawImplied.length ? rawImplied.filter((p) => p > 0.5).length / rawImplied.length : null };
}
function fmtPct(v: number | null) { return v == null ? "n/a" : `${(v * 100).toFixed(1)}%`; }
function valueText(summary: ReturnType<typeof summarizeMarket>) { return [`avg_de_vig=${fmtPct(summary.avg_devig_probability)}`, `avg_raw=${fmtPct(summary.avg_raw_implied_probability)}`, `move=${fmtPct(summary.probability_movement)}`, `favorite_share=${fmtPct(summary.favorite_share)}`, `n=${summary.observations}`, `paired=${summary.paired_devig_observations}`].join("; "); }

export async function deterministicMarketMetric(args: { metricCode: unknown; p1: string; p2: string; asOfDate: string; tournament?: string | null; context?: string | null; }): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode); if (!MARKET_CODES.has(code) || args.asOfDate < from) return null;
  const [p1RowsRaw, p2RowsRaw] = await Promise.all([
    loadSide(args.p1, args.p2, args.asOfDate, args.tournament),
    loadSide(args.p2, args.p1, args.asOfDate, args.tournament),
  ]);
  const expectedFamily = expectedMarketFamily(args, [...p1RowsRaw, ...p2RowsRaw]);
  if (!expectedFamily) return null;
  const p1Rows = p1RowsRaw.filter((row) => metricAllowsObservation(code, row) && evidenceTourCompatible(expectedFamily, rowTourFamily(row)));
  const p2Rows = p2RowsRaw.filter((row) => metricAllowsObservation(code, row) && evidenceTourCompatible(expectedFamily, rowTourFamily(row)));
  if (!p1Rows.length && !p2Rows.length) return null;
  const p1Summary = summarizeMarket(p1Rows, p2Rows); const p2Summary = summarizeMarket(p2Rows, p1Rows);
  const sourceUrl = p1Rows[0]?.source_url ?? p2Rows[0]?.source_url;
  const sourceName = p1Rows[0]?.source_name ?? p2Rows[0]?.source_name;
  if (!sourceName) return null;
  const isCoreMarket = code === "015" || code === "019";
  // certifyMetricFinding is the same conservative, never-upgrades-only-downgrades
  // safety net this codebase already trusts for metric 019 (see
  // metric-certification.test.ts's "Market Calibration certification" cases). It
  // is applied here, at the source, rather than only in the separate completion-
  // sweep/diagnostic callers -- this function also feeds the live per-request
  // researcher (warehouse-first-researcher.server.ts), which did not otherwise
  // run it. Without this, isCoreMarket's RECONSTRUCTED claim for "019" persisted
  // uncorrected on the live path: current-match-only odds/de-vig text (no
  // historical price-bucket win-rate, no outcomes count) does not satisfy Market
  // Calibration's own definition, which requires realized-outcome-linked
  // calibration, not just today's price. certifyMetricFinding downgrades that
  // case to UNAVAILABLE; codes without a registered policy (015/043/044 today)
  // pass through unchanged.
  return certifyMetricFinding({ metric_code: code, p1_value: valueText(p1Summary), p2_value: valueText(p2Summary), p1_treatment: isCoreMarket ? "RECONSTRUCTED" : "PARTIAL", p2_treatment: isCoreMarket ? "RECONSTRUCTED" : "PARTIAL", differential: p1Summary.avg_devig_probability != null && p2Summary.avg_devig_probability != null ? `${((p1Summary.avg_devig_probability - p2Summary.avg_devig_probability) * 100).toFixed(1)} pp de-vig` : null, evidence_family: "MARKET", reliability: Math.min(95, 55 + Math.min(40, Math.floor((p1Summary.paired_devig_observations + p2Summary.paired_devig_observations) / 4))), sample: `The Odds API canonical four-tour match ${args.asOfDate}${args.tournament ? ` @ ${args.tournament}` : ""}; tour_family=${expectedFamily}; p1_n=${p1Summary.observations}; p2_n=${p2Summary.observations}`, unavailable_reason: code === "019" ? "Outcome-linked calibration completion still requires verified result labels; this row supplies deterministic historical market probability components." : null, sources: [{ source_name: sourceName, url: sourceUrl }] });
}