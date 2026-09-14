// Metric #026 -- Early-Warning / Slow-Start Metrics
// (docs/audit-task-026-034-053.md; public/seed/metrics.txt #26)
//
// The prior pass reported 026 as permanently blocked, claiming the needed in-match
// score-state data does not exist anywhere. That was wrong: src/lib/pbp-score-state-
// recovery.ts's reconstructPbpScoreState() already replays approved BSD point-by-point
// data game-by-game for any match covered by the four bsd-*-pbp.server.ts fetchers, and
// this file's own deriveOpeningWindowProfile() (same source file) turns that replay into
// exactly the within-match opening-window fields 026's catalog bullets ask for. This
// module supplies the second, genuinely different half of what was actually commissioned:
// a CROSS-MATCH aggregation, over a player's own past PBP-covered matches, of "how often
// does a detected slow start still end in that player winning the match" -- the user's
// own plain-language framing of this metric.
//
// Two layers, matching the commissioning brief exactly:
//   1. Within-match: deriveOpeningWindowProfile(payload) (pbp-score-state-recovery.ts) --
//      opening service-game hold, opening return-game break, first-4-games win
//      differential, first-6-games point differential, early-break-conceded,
//      time-to-first-break, and this build's own documented slow_start_flag threshold.
//   2. Cross-match: computeSlowStartRecovery() below -- for a player's own past matches
//      that ALSO have usable BSD PBP coverage (cross-referenced against the same
//      results.json index files each bsd-*-pbp.server.ts reads, not assumed), what
//      fraction of slow-start-flagged matches did the player still go on to win.
//
// Ground truth for "did the player win the match" is taken from laneMatchesBefore's own
// already-validated match-history record (task18c-rank-form-workload.ts), matched to each
// PBP-covered candidate by date + normalized opponent identity -- the same
// date+opponent cross-reference technique audit-metric-046-match-state-elo.ts's
// buildSetScoreIndex already uses to attach set-score detail to a leakage-filtered match
// list. This avoids re-deriving the match winner from PBP a second time (a set-count
// reconstruction pbp-score-state-recovery.ts does not build) and keeps a single source of
// truth for who won.
//
// WTA_CHALLENGER lane: bsd-wta-challenger-pbp.server.ts's own header comment (verified
// directly, not assumed) confirms its approved-index rows carry only aggregate
// set_scores/total_points/total_games/breaks -- no per-game server/point-winner
// chronology at all (task18b_raw_fields_available:false,
// server_oriented_point_chronology_preserved:false). deriveOpeningWindowProfile needs
// exactly that chronology, so this lane structurally cannot support 026 and is reported
// NOT_ENOUGH_DATA with that specific, verified reason -- never silently degraded to a
// guess and never lumped in with "PBP doesn't exist" for the other three lanes.
//
// Live network + testability: fetching PBP payloads for a player's own past matches
// requires the same live BSD API calls the four bsd-*-pbp.server.ts fetchers already make
// (and, like those files, is not itself unit-tested against the network -- there is no
// existing test file for their fetch behavior either). The PBP fetch is injected via
// `fetchPbp` so the pure cross-referencing/aggregation logic below IS fully unit-tested
// (including leakage) against a synthetic fetcher, without a live network call.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { laneMatchesBefore, type HistoryLane } from "./task18c-rank-form-workload";
import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import { deriveOpeningWindowProfile, type PbpSide } from "./pbp-score-state-recovery";
import { type LaneOutcome, type TourLane, asTourFamily } from "./audit-metrics-shared";

const norm = (v: unknown) => String(v ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type PbpLaneConfig = { historyDir: string; coverageStart: string; firstYear: number; circuit: "ATP" | "WTA"; challenger: boolean; base: string };
// Coverage windows and index directories are copied from the matching bsd-*-pbp.server.ts
// constant of the same name (COVERAGE_START/BASE) -- kept in sync manually since those
// files don't export them; a divergence here would only make this module MORE
// conservative (reject dates the source file would accept) or trigger empty results, never
// fabricate a match that isn't really covered, because loadIndexRows below still requires
// the row's own `structurally_present === true` flag from the real index file.
const PBP_LANES: Partial<Record<TourLane, PbpLaneConfig>> = {
  ATP_MAIN: { historyDir: "bsd-atp-main-pbp-history", coverageStart: "2024-01-01", firstYear: 2024, circuit: "ATP", challenger: false, base: "https://sports.bzzoiro.com/tennis/api/v2" },
  ATP_CHALLENGER: { historyDir: "bsd-atp-challenger-pbp-history", coverageStart: "2025-01-01", firstYear: 2025, circuit: "ATP", challenger: true, base: "https://sports.bzzoiro.com/tennis/api/v2" },
  WTA_MAIN: { historyDir: "bsd-wta-main-pbp-history", coverageStart: "2024-12-02", firstYear: 2024, circuit: "WTA", challenger: false, base: "https://sports.bzzoiro.com/tennis/api/v2" },
  // WTA_CHALLENGER intentionally absent -- see module header comment.
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
    const r = await fetch(`${base}/matches/${encodeURIComponent(String(matchId))}/point-by-point/`, { headers: { Authorization: `Token ${token}`, "User-Agent": "tennis-truth-engine-audit-metric-026/1.0" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const p = await r.json();
    return p && typeof p === "object" && (p as any).available === true ? p : null;
  } catch { return null; }
}

export interface SlowStartMatchOutcome { date: string; opponent: string; slow_start: boolean; won_match: boolean }
export interface SlowStartRecoveryResult {
  pbp_covered_matches_examined: number;
  slow_start_matches: number;
  slow_start_matches_won: number;
  slow_start_recovery_rate_pct: number | null;
  non_slow_start_win_rate_pct: number | null; // context: how the player does when they DON'T start slow, for comparison
  matches: SlowStartMatchOutcome[];
}

// This build's own documented minimum-support threshold, reasoned explicitly rather than
// borrowed blind: audit-metrics-shared.ts's MIN_SUPPORT_N=50 is calibrated against the
// full four-tour static results/schedule history (thousands of matches per active
// player), which BSD approved PBP coverage does not remotely approach -- coverage only
// starts 2024-01-01 (ATP Main) / 2024-12-02 (WTA Main) / 2025-01-01 (ATP Challenger), so
// even a very active player intersecting this window has at most low tens of PBP-covered
// matches, and only a FRACTION of those will show a slow start at all. Requiring 50
// slow-start instances would make this aggregate permanently NOT_ENOUGH_DATA for every
// player, which is itself a form of dishonesty (silently promising a metric no lane could
// ever satisfy). MIN_SLOW_START_INSTANCES=5 is chosen as the smallest count this build is
// willing to call a "rate" rather than an anecdote -- below it, NOT_ENOUGH_DATA is
// reported honestly with the real count, never a guessed or rounded-up rate.
export const MIN_SLOW_START_INSTANCES = 5;
// Independent floor on total PBP-covered matches examined (not just slow-start ones),
// so a player with e.g. exactly 5 total PBP-covered matches, all slow starts, isn't
// reported as if their whole recent history were examined.
export const MIN_MATCHES_EXAMINED = 6;

/**
 * Cross-match slow-start-recovery aggregation for `player` in `lane`, strictly using
 * matches before `asOfDate` (both for the outcome ground truth via laneMatchesBefore, and
 * for which PBP index rows are even considered -- see the date filter below). Returns
 * null when the lane structurally has no per-game PBP chronology (WTA_CHALLENGER) or the
 * date is outside that lane's confirmed coverage start.
 */
export async function computeSlowStartRecovery(args: { player: string; lane: TourLane; asOfDate: string; fetchPbp?: PbpFetcher; historyLaneOverride?: HistoryLane; indexRowsOverride?: IndexRow[] }): Promise<LaneOutcome<SlowStartRecoveryResult>> {
  const { player, lane, asOfDate } = args;
  const cfg = PBP_LANES[lane];
  if (!cfg) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "WTA Challenger's approved PBP index carries only aggregate set/point/game totals (task18b_raw_fields_available:false in bsd-wta-challenger-pbp.server.ts) -- no per-game server/point-winner chronology exists to detect a slow start from, verified against that file's own row shape." };
  }
  if (asOfDate < cfg.coverageStart) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: `Outside confirmed BSD ${lane} PBP coverage boundary (starts ${cfg.coverageStart}).` };
  }
  const fetchPbp = args.fetchPbp ?? ((a: { matchId: string | number }) => defaultFetchPbp({ base: cfg.base, matchId: a.matchId }));

  const family = asTourFamily(lane);
  // historyLaneOverride/indexRowsOverride let tests fully control both the match-outcome
  // ground truth and the PBP index rows without touching the real generated index, real
  // disk files, or the live network -- see this module's header comment on testability.
  const historyLane = args.historyLaneOverride ?? (loadRuntimeIndex().matchHistory[family] as HistoryLane);
  const playerKey = normalizeEvidenceIdentity(player);
  const laneMatches = laneMatchesBefore(historyLane, asOfDate).filter(m => m.p1 === playerKey || m.p2 === playerKey);
  // date|opponent -> winner, built ONLY from laneMatchesBefore's own already leakage-safe,
  // deduplicated match list -- see this module's header comment for why match outcome is
  // sourced from here rather than re-derived from PBP.
  const outcomeIndex = new Map<string, string>();
  for (const m of laneMatches) {
    const opponent = m.p1 === playerKey ? m.p2 : m.p1;
    outcomeIndex.set(`${m.date}|${opponent}`, m.winner);
  }
  if (!outcomeIndex.size) {
    return { lane, status: "NOT_ENOUGH_DATA", n: 0, reason: "Player has no matches in the static history index before asOfDate to cross-reference match outcomes against." };
  }

  const rawIndexRows = args.indexRowsOverride ?? (await loadIndexRows(cfg, asOfDate));
  const indexRows = rawIndexRows.filter(r => rowMatchesLane(cfg, r) && Boolean(r.date) && String(r.date).slice(0, 10) >= cfg.coverageStart && String(r.date).slice(0, 10) < asOfDate && (r.players ?? []).map(norm).includes(playerKey));
  const sorted = [...indexRows].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))).slice(0, 40);

  const matches: SlowStartMatchOutcome[] = [];
  await Promise.all(sorted.map(async (row) => {
    if (!Array.isArray(row.players) || row.players.length !== 2 || !row.match_id) return;
    const names = row.players.map(v => String(v ?? ""));
    const idx = names.findIndex(n => norm(n) === playerKey);
    if (idx < 0) return;
    const opponentName = names[idx === 0 ? 1 : 0];
    const date = String(row.date).slice(0, 10);
    const winner = outcomeIndex.get(`${date}|${norm(opponentName)}`);
    if (!winner) return; // no cross-referenced ground-truth outcome for this exact match -- skipped, never guessed
    const payload = await fetchPbp({ matchId: row.match_id! });
    if (!payload) return;
    const recovery = deriveOpeningWindowProfile(payload);
    if (!recovery.valid) return;
    const side: PbpSide = idx === 0 ? "player1" : "player2";
    const profile = recovery.derived[side];
    if (!profile || profile.slow_start_flag === null) return;
    matches.push({ date, opponent: opponentName, slow_start: profile.slow_start_flag, won_match: winner === playerKey });
  }));

  const examined = matches.length;
  const slowStartMatches = matches.filter(m => m.slow_start);
  const slowStartWins = slowStartMatches.filter(m => m.won_match).length;
  const nonSlowStartMatches = matches.filter(m => !m.slow_start);
  const nonSlowStartWins = nonSlowStartMatches.filter(m => m.won_match).length;

  if (examined < MIN_MATCHES_EXAMINED || slowStartMatches.length < MIN_SLOW_START_INSTANCES) {
    return {
      lane, status: "NOT_ENOUGH_DATA", n: examined,
      reason: `Only ${examined} PBP-covered past ${lane} match(es) (needs >=${MIN_MATCHES_EXAMINED}) with ${slowStartMatches.length} slow-start instance(s) (needs >=${MIN_SLOW_START_INSTANCES}) found for this player before asOfDate.`,
    };
  }
  return {
    lane, status: "GO", n: examined,
    value: {
      pbp_covered_matches_examined: examined,
      slow_start_matches: slowStartMatches.length,
      slow_start_matches_won: slowStartWins,
      slow_start_recovery_rate_pct: Number(((100 * slowStartWins) / slowStartMatches.length).toFixed(1)),
      non_slow_start_win_rate_pct: nonSlowStartMatches.length ? Number(((100 * nonSlowStartWins) / nonSlowStartMatches.length).toFixed(1)) : null,
      matches,
    },
  };
}
