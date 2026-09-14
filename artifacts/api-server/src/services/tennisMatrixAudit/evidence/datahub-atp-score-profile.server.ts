import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";

const SOURCE_URL = "https://datahub.io/core/atp-world-tour-tennis-data";
const SOURCE_NAME = "DataHub ATP World Tour tennis data (CC BY 4.0)";
const HISTORICAL_MIN_YEAR = 2005;

type Row = Record<string, string>;
let cache: Row[] | null = null;

function norm(v: string) { return v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function parse(text: string) {
  const rows: string[][] = []; let r: string[] = [], c = "", q = false;
  for (let i = 0; i < text.length; i++) { const x = text[i]; if (x === '"') { if (q && text[i + 1] === '"') { c += '"'; i++; } else q = !q; } else if (x === "," && !q) { r.push(c); c = ""; } else if ((x === "\n" || x === "\r") && !q) { if (x === "\r" && text[i + 1] === "\n") i++; r.push(c); c = ""; if (r.some(Boolean)) rows.push(r); r = []; } else c += x; }
  if (c || r.length) { r.push(c); rows.push(r); } if (!rows.length) return []; const h = rows[0].map((x) => x.trim()); return rows.slice(1).map((a) => Object.fromEntries(h.map((k, i) => [k, (a[i] ?? "").trim()])));
}
function yearOf(r: Row) { return Number((r.tourney_year_id ?? "").slice(0, 4)); }
function load() { if (cache) return cache; try { return cache = ["match_scores_1991-2016.csv", "match_scores_2017.csv"].flatMap((f) => parse(readFileSync(join(process.cwd(), "data/public/datahub-atp", f), "utf8"))).filter((r) => yearOf(r) >= HISTORICAL_MIN_YEAR); } catch { return []; } }
function cutoffYear(context: string) { const m = context.match(/(?:date\s+)?(20\d{2})-\d{2}-\d{2}/i); return m ? Number(m[1]) : null; }
function stat(p: string, k: string, v: number, n: number): SourcedStat { return { key: k, player: p, value: v, surface: null, window: "HISTORICAL_2005_THROUGH_2017", tour_level: null, sample: n, origin: "RECONSTRUCTED", sources: [{ source_name: SOURCE_NAME, url: SOURCE_URL, retrieved_at: new Date().toISOString() }] }; }

export function parseDataHubSets(score: string): Array<[number, number]> {
  return score.split(/\s+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const hyphen = s.match(/^(\d+)-(\d+)/); if (hyphen) { const a = Number(hyphen[1]), b = Number(hyphen[2]); return Number.isFinite(a) && Number.isFinite(b) ? [a, b] as [number, number] : null; }
    const compact = s.match(/^(\d)(\d)(?:\([^)]*\))?$/); if (compact) return [Number(compact[1]), Number(compact[2])] as [number, number]; return null;
  }).filter((x): x is [number, number] => !!x);
}
function n(v: string | undefined) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function isDecidingMatch(row: Row) { const w = n(row.winner_sets_won), l = n(row.loser_sets_won); return (w === 2 && l === 1) || (w === 3 && l === 2); }
function hasTiebreak(sets: Array<[number, number]>) { return sets.some(([a,b]) => (a === 7 && b === 6) || (a === 6 && b === 7)); }
function hasNarrowSet(sets: Array<[number, number]>) { return sets.some(([a,b]) => Math.max(a,b) >= 7 && Math.abs(a-b) <= 2); }

export function computeHistoricalScoreProfileStatsFromRows(rows: Row[], player: string, context: string): SourcedStat[] {
  const pn = norm(player), cy = cutoffYear(context);
  const ms = rows.filter((r) => { const y = yearOf(r); return y >= HISTORICAL_MIN_YEAR && (!cy || y < cy) && (norm(r.winner_name ?? "") === pn || norm(r.loser_name ?? "") === pn); }); if (!ms.length) return [];
  let s1=0,s1w=0,s2=0,s2w=0,afterLoss=0,afterLossW=0,afterWin=0,afterWinW=0,secondAfterLoss=0,secondAfterLossW=0,tb=0,tbw=0,deciding=0,decidingW=0,straightWins=0,wins=0,parsedMatches=0,closeDependentWins=0,decidingOrTbWins=0;
  for (const m of ms) {
    const isW = norm(m.winner_name ?? "") === pn; const ss = parseDataHubSets(m.match_score_tiebreaks ?? ""); if (!ss.length) continue; parsedMatches++; const view = ss.map(([a,b]) => isW ? [a,b] as [number,number] : [b,a] as [number,number]);
    if (view[0]) { s1++; if (view[0][0] > view[0][1]) s1w++; } if (view[1]) { s2++; if (view[1][0] > view[1][1]) s2w++; }
    if (view[0]) { if (view[0][0] < view[0][1]) { afterLoss++; if (isW) afterLossW++; if (view[1]) { secondAfterLoss++; if (view[1][0] > view[1][1]) secondAfterLossW++; } } else if (view[0][0] > view[0][1]) { afterWin++; if (isW) afterWinW++; } }
    for (const [a,b] of view) { if ((a===7&&b===6)||(a===6&&b===7)) { tb++; if (a>b) tbw++; } }
    const decidingMatch = isDecidingMatch(m);
    if (decidingMatch && view.length) { deciding++; const d=view[view.length-1]; if (d[0]>d[1]) decidingW++; }
    if (isW) {
      wins++; if (view.every(([a,b]) => a>b)) straightWins++;
      // Close-Match Dependency: share of wins that were not clear-margin wins,
      // operationalized transparently as requiring a deciding set OR containing
      // a narrow 7-5/7-6 style set. This is not generic close-match win percentage.
      if (decidingMatch || hasNarrowSet(view)) closeDependentWins++;
      // Deciding-Set/Tiebreak Reliance: share of wins requiring a decider or at
      // least one tiebreak, exactly matching the master "wins require" wording.
      if (decidingMatch || hasTiebreak(view)) decidingOrTbWins++;
    }
  }
  const out:SourcedStat[]=[]; const add=(k:string,a:number,b:number)=>{if(b>0)out.push(stat(player,k,100*a/b,b));};
  add("set1_win_pct",s1w,s1); add("set2_win_pct",s2w,s2); add("win_after_losing_set1_pct",afterLossW,afterLoss); add("win_after_winning_set1_pct",afterWinW,afterWin); add("second_set_after_losing_set1_win_pct",secondAfterLossW,secondAfterLoss); add("tiebreak_win_pct",tbw,tb); add("historical_deciding_set_win_pct",decidingW,deciding); add("set3_deciding_set_win_pct",decidingW,deciding);
  add("historical_straight_set_control_pct",straightWins,wins); add("straight_set_match_win_pct",straightWins,parsedMatches);
  add("close_match_dependency_pct",closeDependentWins,wins); add("deciding_tiebreak_win_reliance_pct",decidingOrTbWins,wins);
  if(tb>0)out.push(stat(player,"tiebreaks_played",tb,tb)); if(deciding>0)out.push(stat(player,"deciding_matches_played",deciding,deciding)); return out;
}
export function getHistoricalScoreProfileStats(player: string, context: string): SourcedStat[] { return computeHistoricalScoreProfileStatsFromRows(load(), player, context); }
