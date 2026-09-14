// Metric #040 -- Hidden Decline Detector
// (docs/audit-task-038-040-062.md; public/seed/metrics.txt #40)
//
// Catalog definition: "chronological serve velocity, ace rate, first/second-serve points
// won, return points won, break opportunities, service-game danger-score/hold-vulnerability,
// double-fault rate, match duration and three-set dependency histories."
//
// A prior audit pass reported 040 as structurally UNAVAILABLE, reasoning from serve
// velocity alone (genuinely absent from every data source in this repository -- verified
// again for this pass, no CSV or live provider carries ball speed). That correctly rules
// OUT serve velocity, but wrongly implied the whole metric was blocked: most of the other
// named components -- ace rate, service-points-won, return-points-won, break
// opportunities, and hold% (used here as the "service-game danger-score/hold-vulnerability"
// proxy: a falling hold% across a player's own chronological matches IS rising service-game
// vulnerability) -- are already computed per match by pbp-score-state-recovery.ts's
// reconstructPbpScoreState() (its "002"/"003"/"032" derived fields), the same replay 026 and
// 053 already reuse. This module adds the missing piece: a CROSS-MATCH trend over a
// player's own chronological PBP-covered matches, comparing an earlier half against a more
// recent half via the same two-proportion confidence-interval test metric #047 already
// established (twoProportionZTest, reused here rather than re-derived) -- "decline" is
// reported only when the recent-half rate is both lower AND the 95% CI on the difference
// excludes zero, never from a raw delta alone.
//
// Explicitly excluded from this pass, and why (same honest-partial pattern as 032/034/053):
//   - serve velocity trend: no data source anywhere carries it (re-verified for this task).
//   - first/second-serve-points-won trends (split by serve number): reconstructPbpScoreState
//     itself documents serve_number_available:false on both "002" and "003" -- the raw BSD
//     PBP payload does not encode which serve number won the point, so this cannot be
//     split, only an OVERALL service-points-won trend is reported.
//   - match duration trend: no duration/minutes field exists anywhere in the PBP replay.
//   - three-set-dependency trend: would need a reliable per-match "went the distance" signal
//     cross-referenced with best-of format; no clean derivation was available in scope for
//     this pass without touching unrelated modules, so it is left out rather than guessed.
//
// Live network + testability: identical contract to audit-metric-026-early-warning-slow-
// start.ts -- fetching a player's own past PBP payloads requires the same live BSD API
// calls the four bsd-*-pbp.server.ts fetchers already make, injected here via `fetchPbp` so
// the pure trend-comparison logic is fully unit-tested (including leakage) against a
// synthetic fetcher, without a live network call.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { laneMatchesBefore, type HistoryLane } from "./task18c-rank-form-workload";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { reconstructPbpScoreState, type PbpSide } from "./pbp-score-state-recovery";
import { twoProportionZTest, type TwoProportionTestResult } from "./audit-metric-047-uncertainty-adjusted-advantage";
import { type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

const norm = (v: unknown) => String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type PbpLaneConfig = { historyDir: string; coverageStart: string; firstYear: number; circuit: "ATP" | "WTA"; challenger: boolean; base: string };
// Copied from the matching bsd-*-pbp.server.ts constants -- see audit-metric-026's own
// header comment for why keeping this in sync manually only ever makes this module MORE
// conservative, never able to fabricate a match the source file wouldn't itself approve.
const PBP_LANES: Partial<Record<TourLane, PbpLaneConfig>> = {
  ATP_MAIN: { historyDir: "bsd-atp-main-pbp-history", coverageStart: "2024-01-01", firstYear: 2024, circuit: "ATP", challenger: false, base: "https://sports.bzzoiro.com/tennis/api/v2" },
  ATP_CHALLENGER: { historyDir: "bsd-atp-challenger-pbp-history", coverageStart: "2025-01-01", firstYear: 2025, circuit: "ATP", challenger: true, base: "https://sports.bzzoiro.com/tennis/api/v2" },
  WTA_MAIN: { historyDir: "bsd-wta-main-pbp-history", coverageStart: "2024-12-02", firstYear: 2024, circuit: "WTA", challenger: false, base: "https://sports.bzzoiro.com/tennis/api/v2" },
  // WTA_CHALLENGER intentionally absent: bsd-wta-challenger-pbp.server.ts's own header
  // confirms its approved index carries only aggregate totals, no per-game chronology --
  // reconstructPbpScoreState needs the latter, same structural gap 026 documents.
};

export type IndexRow = { match_id?: string | number | null; date?: string | null; players?: string[]; tournament?: string | null; circuit?: string | null; category?: string | null; structurally_present?: boolean };

function rowMatchesLane(cfg: PbpLaneConfig, r: IndexRow): boolean {
  const blob = norm(`${r.category ?? ""} ${r.tournament ?? ""}`);
  if (String(r.circuit ?? "").toUpperCase() !== cfg.circuit) return false;
  if (r.structurally_present !== true) return false;
  if (["itf", "futures", "utr", "satellite", "exhibition"].some(x => blob.includes(x))) return false;
  const isChallengerRow = blob.includes("challenger") || blob.includes("wta 125") || blob.includes("wta125") || blob.includes("125k");
  return cfg.challenger ? isChallengerRow : !isChallengerRow;
}

async function loadIndexRows(cfg: PbpLaneConfig, throughDate: string): Promise<IndexRow[]> {
  const endYear = Math.min(new Date().getUTCFullYear(), Number(throughDate.slice(0, 4)) || new Date().getUTCFullYear());
  const years = Array.from({ length: Math.max(0, endYear - cfg.firstYear + 1) }, (_, i) => cfg.firstYear + i);
  const rows = await Promise.all(years.map(async (year) => {
    try {
      const raw = JSON.parse(await readFile(join(process.cwd(), "data", "audit", cfg.historyDir, String(year), "results.json"), "utf8"));
      return Array.isArray(raw) ? (raw as IndexRow[]) : [];
    } catch { return []; }
  }));
  return rows.flat();
}

export type PbpFetcher = (args: { matchId: string | number }) => Promise<unknown | null>;
async function defaultFetchPbp({ base, matchId }: { base: string; matchId: string | number }): Promise<unknown | null> {
  const token = process.env.BSD_TENNIS_API_KEY;
  if (!token) return null;
  try {
    const r = await fetch(`${base}/matches/${encodeURIComponent(String(matchId))}/point-by-point/`, { headers: { Authorization: `Token ${token}`, "User-Agent": "tennis-truth-engine-audit-metric-040/1.0" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const p = await r.json();
    return p && typeof p === "object" && (p as any).available === true ? p : null;
  } catch { return null; }
}

interface MatchStats { date: string; ace_pct: number | null; ace_n: number; df_pct: number | null; df_n: number; service_points_won_pct: number | null; service_points_n: number; return_points_won_pct: number | null; return_points_n: number; hold_pct: number | null; hold_n: number; break_converted_pct: number | null; break_n: number }

function toMatchStats(date: string, side: PbpSide, recovery: ReturnType<typeof reconstructPbpScoreState>): MatchStats | null {
  if (!recovery.valid) return null;
  const s002 = recovery.derived[side]?.["002"]?.value;
  const s003 = recovery.derived[side]?.["003"]?.value;
  const s032 = recovery.derived[side]?.["032"]?.value;
  if (!s002 && !s003 && !s032) return null;
  const acePct = s002 && s002.aces !== null && typeof s002.service_points === "number" && s002.service_points > 0 ? (100 * Number(s002.aces)) / s002.service_points : null;
  const dfPct = s002 && s002.double_faults !== null && typeof s002.service_points === "number" && s002.service_points > 0 ? (100 * Number(s002.double_faults)) / s002.service_points : null;
  return {
    date,
    ace_pct: acePct, ace_n: typeof s002?.service_points === "number" ? s002.service_points : 0,
    df_pct: dfPct, df_n: typeof s002?.service_points === "number" ? s002.service_points : 0,
    service_points_won_pct: typeof s002?.service_point_win_pct === "number" ? s002.service_point_win_pct : null, service_points_n: typeof s002?.service_points === "number" ? s002.service_points : 0,
    return_points_won_pct: typeof s003?.return_point_win_pct === "number" ? s003.return_point_win_pct : null, return_points_n: typeof s003?.return_points === "number" ? s003.return_points : 0,
    hold_pct: typeof s002?.hold_pct === "number" ? s002.hold_pct : null, hold_n: typeof s002?.service_games === "number" ? s002.service_games : 0,
    break_converted_pct: typeof s032?.bp_converted_pct === "number" ? s032.bp_converted_pct : null, break_n: typeof s032?.break_chances === "number" ? s032.break_chances : 0,
  };
}

export interface DimensionTrend { dimension: string; earlier_rate_pct: number | null; earlier_n: number; recent_rate_pct: number | null; recent_n: number; test: TwoProportionTestResult | null; verdict: "DECLINE" | "IMPROVEMENT" | "NOT_STATISTICALLY_DISTINGUISHABLE" | "INSUFFICIENT_SAMPLE" }

const MIN_N_PER_HALF = 30; // pooled point/game count per half, not match count -- same statistical-floor reasoning as twoProportionZTest's own MIN_N_PER_SIDE, just applied per dimension here since each dimension has its own denominator (points vs games vs break chances)

function pooledRate(matches: MatchStats[], rateKey: keyof MatchStats, nKey: keyof MatchStats): { rate: number | null; n: number } {
  let weighted = 0, n = 0;
  for (const m of matches) {
    const rate = m[rateKey] as number | null;
    const weight = m[nKey] as number;
    if (rate === null || !Number.isFinite(weight) || weight <= 0) continue;
    weighted += rate * weight;
    n += weight;
  }
  return { rate: n > 0 ? weighted / n : null, n };
}

function dimensionTrend(dimension: string, matches: MatchStats[], rateKey: keyof MatchStats, nKey: keyof MatchStats): DimensionTrend {
  const mid = Math.floor(matches.length / 2);
  const earlier = pooledRate(matches.slice(0, mid), rateKey, nKey);
  const recent = pooledRate(matches.slice(mid), rateKey, nKey);
  if (earlier.rate === null || recent.rate === null || earlier.n < MIN_N_PER_HALF || recent.n < MIN_N_PER_HALF) {
    return { dimension, earlier_rate_pct: earlier.rate, earlier_n: earlier.n, recent_rate_pct: recent.rate, recent_n: recent.n, test: null, verdict: "INSUFFICIENT_SAMPLE" };
  }
  const test = twoProportionZTest(earlier.rate, Math.round(earlier.n), recent.rate, Math.round(recent.n));
  const verdict = test.verdict === "NOT_STATISTICALLY_DISTINGUISHABLE" ? "NOT_STATISTICALLY_DISTINGUISHABLE" : recent.rate < earlier.rate ? "DECLINE" : "IMPROVEMENT";
  return { dimension, earlier_rate_pct: earlier.rate, earlier_n: Math.round(earlier.n), recent_rate_pct: recent.rate, recent_n: Math.round(recent.n), test, verdict };
}

export interface HiddenDeclineResult { matches_examined: number; dimensions: DimensionTrend[] }

export const MIN_MATCHES_EXAMINED = 12; // needs enough matches to split into two meaningfully-sized halves; see audit-metric-026's header for why BSD PBP coverage windows keep this small relative to MIN_SUPPORT_N

/**
 * Cross-match decline-trend aggregation for `player` in `lane`, strictly using matches
 * before `asOfDate`. Mirrors audit-metric-026-early-warning-slow-start.ts's
 * computeSlowStartRecovery cross-referencing technique (ground truth for which matches are
 * this player's own comes from laneMatchesBefore, PBP payloads are only used for the
 * per-match stat detail, not for identifying which matches happened).
 */
export async function computeHiddenDecline(args: { player: string; lane: TourLane; asOfDate: string; fetchPbp?: PbpFetcher; historyLaneOverride?: HistoryLane; indexRowsOverride?: IndexRow[] }): Promise<LaneOutcome<HiddenDeclineResult>> {
  const { player, lane, asOfDate } = args;
  const cfg = PBP_LANES[lane];
  if (!cfg) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "WTA Challenger's approved PBP index carries only aggregate totals -- no per-game chronology exists to compute ace/hold/break trends from, verified against bsd-wta-challenger-pbp.server.ts's own row shape." };
  }
  if (asOfDate < cfg.coverageStart) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `Outside confirmed BSD ${lane} PBP coverage boundary (starts ${cfg.coverageStart}).` };
  }
  const fetchPbp = args.fetchPbp ?? ((a: { matchId: string | number }) => defaultFetchPbp({ base: cfg.base, matchId: a.matchId }));

  const family = asTourFamily(lane);
  const historyLane = args.historyLaneOverride ?? (loadRuntimeIndex().matchHistory[family] as HistoryLane);
  const playerKey = normalizeEvidenceIdentity(player);
  const laneMatches = laneMatchesBefore(historyLane, asOfDate).filter(m => m.p1 === playerKey || m.p2 === playerKey);
  const outcomeIndex = new Set<string>();
  for (const m of laneMatches) {
    const opponent = m.p1 === playerKey ? m.p2 : m.p1;
    outcomeIndex.add(`${m.date}|${opponent}`);
  }
  if (!outcomeIndex.size) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Player has no matches in the static history index before asOfDate to cross-reference against." };
  }

  const rawIndexRows = args.indexRowsOverride ?? (await loadIndexRows(cfg, asOfDate));
  const indexRows = rawIndexRows.filter(r => rowMatchesLane(cfg, r) && Boolean(r.date) && String(r.date).slice(0, 10) >= cfg.coverageStart && String(r.date).slice(0, 10) < asOfDate && (r.players ?? []).map(norm).includes(playerKey));
  const sorted = [...indexRows].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? ""))).slice(-60); // most recent 60 PBP-covered matches, chronologically ascending so the trend split below is temporally meaningful

  const collected: MatchStats[] = [];
  const results = await Promise.all(sorted.map(async (row) => {
    if (!Array.isArray(row.players) || row.players.length !== 2 || !row.match_id) return null;
    const names = row.players.map(v => String(v ?? ""));
    const idx = names.findIndex(n => norm(n) === playerKey);
    if (idx < 0) return null;
    const opponentName = names[idx === 0 ? 1 : 0];
    const date = String(row.date).slice(0, 10);
    if (!outcomeIndex.has(`${date}|${norm(opponentName)}`)) return null; // no cross-referenced ground-truth match -- skipped, never guessed
    const payload = await fetchPbp({ matchId: row.match_id! });
    if (!payload) return null;
    const recovery = reconstructPbpScoreState(payload);
    const side: PbpSide = idx === 0 ? "player1" : "player2";
    return toMatchStats(date, side, recovery);
  }));
  for (const r of results) if (r) collected.push(r);
  collected.sort((a, b) => a.date.localeCompare(b.date));

  if (collected.length < MIN_MATCHES_EXAMINED) {
    return { lane, status: "NOT_ENOUGH_DATA", n: collected.length, reason: `Only ${collected.length} PBP-covered past ${lane} match(es) with usable per-game stats found before asOfDate (needs >=${MIN_MATCHES_EXAMINED}).` };
  }

  const dimensions: DimensionTrend[] = [
    dimensionTrend("ace_rate_pct", collected, "ace_pct", "ace_n"),
    dimensionTrend("double_fault_rate_pct", collected, "df_pct", "df_n"),
    dimensionTrend("service_points_won_pct", collected, "service_points_won_pct", "service_points_n"),
    dimensionTrend("return_points_won_pct", collected, "return_points_won_pct", "return_points_n"),
    dimensionTrend("hold_pct", collected, "hold_pct", "hold_n"),
    dimensionTrend("break_points_converted_pct", collected, "break_converted_pct", "break_n"),
  ];
  const anyResolved = dimensions.some(d => d.verdict !== "INSUFFICIENT_SAMPLE");
  if (!anyResolved) {
    return { lane, status: "NOT_ENOUGH_DATA", n: collected.length, reason: `${collected.length} PBP-covered matches found, but no dimension had enough pooled sample in both the earlier and recent half (needs >=${MIN_N_PER_HALF} per half per dimension).` };
  }
  return { lane, status: "GO", n: collected.length, value: { matches_examined: collected.length, dimensions } };
}
