import { existsSync, readFileSync } from "node:fs";
import { isBeforeCutoff } from "./temporal-boundary";

import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";

const SOURCE_NAME = "Tennis-Data.co.uk WTA historical results";
const SOURCE_URL = "https://www.tennis-data.co.uk/alldata.php";
const DATA_PATH = "data/public/tennis-data-wta/wta_matches_2007_2016.csv";

type Row = Record<string, string>;
let cache: Row[] | null = null;

function norm(v: string | null | undefined) {
  return String(v ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(v: string) { return norm(v).split(" ").filter(Boolean); }
function n(v: string | undefined) { const x = Number(v); return Number.isFinite(x) ? x : null; }

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])));
}

function load(): Row[] {
  if (cache) return cache;
  const path = join(process.cwd(), DATA_PATH);
  if (!existsSync(path)) return [];
  try { return cache = parseCsv(readFileSync(path, "utf8")); }
  catch { return []; }
}

function resolvePlayer(rows: Row[], requested: string): { canonical: string; rows: Row[] } | null {
  const needle = norm(requested);
  if (!needle) return null;
  const names = [...new Set(rows.flatMap((r) => [r.winner, r.loser]).filter(Boolean))];
  const exact = names.filter((x) => norm(x) === needle);
  if (exact.length === 1) {
    const canonical = exact[0];
    return { canonical, rows: rows.filter((r) => r.winner === canonical || r.loser === canonical) };
  }
  const req = tokens(requested), surname = req.at(-1);
  if (!surname) return null;
  const candidates = names.filter((name) => {
    const nt = tokens(name);
    if (!nt.length || nt.at(-1) !== surname) return false;
    if (req.length === 1) return true;
    const set = new Set(nt);
    return req.every((t) => set.has(t));
  });
  if (candidates.length !== 1) return null;
  const canonical = candidates[0];
  return { canonical, rows: rows.filter((r) => r.winner === canonical || r.loser === canonical) };
}

function cutoffFromContext(context: string): string | null {
  return context.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1] ?? null;
}
function surfaceFromContext(context: string): string | null {
  return context.match(/surface\s+(hard|clay|grass|carpet)/i)?.[1]?.toLowerCase() ?? null;
}
function source(retrievedAt: string) { return [{ source_name: SOURCE_NAME, url: SOURCE_URL, retrieved_at: retrievedAt }]; }
function stat(player: string, key: string, value: number, retrievedAt: string, surface: string | null, sample: number): SourcedStat {
  return { key, player, value, surface, window: "HISTORICAL_WTA_2007_2016_PRE_MATCH", tour_level: null, sample, origin: "DIRECT", sources: source(retrievedAt) };
}

export interface TennisDataWtaEvidence {
  canonicalPlayer: string;
  rows: number;
  cutoff: string | null;
  surface: string | null;
  stats: SourcedStat[];
}

/**
 * Historical WTA match evidence from Tennis-Data.co.uk.
 *
 * Critical guardrail: this adapter does not manufacture current form. It emits
 * only aggregate historical match/set/surface facts actually present before
 * the audited cutoff. The source archive used by this app ends at 2016.
 */
export function getTennisDataWtaHistoricalStats(player: string, context: string): SourcedStat[] {
  const all = load();
  const resolved = resolvePlayer(all, player);
  if (!resolved) return [];
  const cutoff = cutoffFromContext(context), surface = surfaceFromContext(context);
  /*Phase 13: unestablished boundary => no admissible evidence.*/
  if (!cutoff) return [];
  let rows = resolved.rows.filter((r) => isBeforeCutoff(r.date, cutoff));
  if (!rows.length) return [];
  const surfaceRows = surface ? rows.filter((r) => norm(r.surface) === surface) : [];
  const use = surface && surfaceRows.length ? surfaceRows : rows;
  const retrievedAt = new Date().toISOString();
  const wins = use.filter((r) => r.winner === resolved.canonical).length;
  const losses = use.length - wins;
  let setsWon = 0, setsLost = 0, straightWins = 0, deciding = 0, decidingWins = 0;
  let rankSamples = 0, rankSum = 0;
  for (const r of use) {
    const won = r.winner === resolved.canonical;
    const wf = n(r.winner_sets), lf = n(r.loser_sets);
    if (wf !== null && lf !== null) {
      setsWon += won ? wf : lf;
      setsLost += won ? lf : wf;
      if (won && lf === 0) straightWins++;
      const total = wf + lf;
      if (total === 3 || total === 5) { deciding++; if (won) decidingWins++; }
    }
    const rank = n(won ? r.winner_rank : r.loser_rank);
    if (rank !== null && rank > 0) { rankSum += rank; rankSamples++; }
  }
  const out: SourcedStat[] = [];
  const sample = use.length;
  out.push(stat(player, "matches_played", sample, retrievedAt, surface, sample));
  out.push(stat(player, "wins", wins, retrievedAt, surface, sample));
  out.push(stat(player, "losses", losses, retrievedAt, surface, sample));
  out.push(stat(player, "matches_won", wins, retrievedAt, surface, sample));
  out.push(stat(player, "surface_matches", sample, retrievedAt, surface, sample));
  out.push(stat(player, "surface_wins", wins, retrievedAt, surface, sample));
  out.push(stat(player, "surface_losses", losses, retrievedAt, surface, sample));
  if (sample) {
    out.push(stat(player, "win_pct", 100 * wins / sample, retrievedAt, surface, sample));
    out.push(stat(player, "surface_win_pct", 100 * wins / sample, retrievedAt, surface, sample));
  }
  if (setsWon + setsLost > 0) {
    out.push(stat(player, "sets_played", setsWon + setsLost, retrievedAt, surface, sample));
    out.push(stat(player, "sets_won", setsWon, retrievedAt, surface, sample));
    out.push(stat(player, "set_win_pct", 100 * setsWon / (setsWon + setsLost), retrievedAt, surface, sample));
  }
  out.push(stat(player, "straight_set_wins", straightWins, retrievedAt, surface, sample));
  if (wins > 0) out.push(stat(player, "straight_set_win_pct", 100 * straightWins / wins, retrievedAt, surface, wins));
  out.push(stat(player, "deciding_sets_played", deciding, retrievedAt, surface, deciding));
  out.push(stat(player, "deciding_sets_won", decidingWins, retrievedAt, surface, deciding));
  if (deciding > 0) out.push(stat(player, "deciding_set_win_pct", 100 * decidingWins / deciding, retrievedAt, surface, deciding));
  if (rankSamples > 0) out.push(stat(player, "average_historical_rank", rankSum / rankSamples, retrievedAt, surface, rankSamples));
  return out;
}

export function getTennisDataWtaMatchRowsForTesting(): Row[] { return load(); }
