import { readFileSync } from "node:fs";
import { isBeforeCutoff } from "./temporal-boundary";

import { join } from "node:path";
import type { SourcedStat } from "./reconstruction/engine";
import { getTennisDataWtaHistoricalStats } from "./tennis-data-wta.server";

const SOURCE_URL = "https://www.kaggle.com/datasets/predixsport/sports-elo-ratings";
const SOURCE_NAME = "PredixSport public tennis ratings (CC BY 4.0)";

type CsvRow = Record<string, string>;
let atpRowsCache: CsvRow[] | null = null;
let wtaRowsCache: CsvRow[] | null = null;

function norm(v: string): string { return v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function tokens(v:string){return norm(v).split(" ").filter(Boolean);}

/** Resolve OCR/legacy shortened names to one unique dataset identity.
 * Exact match wins. Otherwise require surname agreement and a unique candidate.
 * Ambiguous surnames are deliberately rejected rather than guessed.
 */
function resolvePlayerRows(rows:CsvRow[], requested:string):{canonical:string;rows:CsvRow[]}|null{
  const needle=norm(requested); if(!needle)return null;
  const exact=rows.filter(r=>norm(r.player??"")===needle); if(exact.length)return{canonical:exact[0].player,rows:exact};
  const req=tokens(requested),surname=req[req.length-1]; if(!surname)return null;
  const names=[...new Set(rows.map(r=>r.player??"").filter(Boolean))];
  const candidates=names.filter(name=>{
    const nt=tokens(name); if(!nt.length||nt[nt.length-1]!==surname)return false;
    if(req.length===1)return true;
    const ns=new Set(nt); return req.every(t=>ns.has(t));
  });
  if(candidates.length!==1)return null;
  const canonical=candidates[0]; return{canonical,rows:rows.filter(r=>r.player===canonical)};
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (ch === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.length)) rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])));
}

function load(tour: "ATP" | "WTA"): CsvRow[] {
  if (tour === "ATP" && atpRowsCache) return atpRowsCache;
  if (tour === "WTA" && wtaRowsCache) return wtaRowsCache;
  const rel = tour === "ATP" ? "data/public/predixsport/atp/atp_elo_matches.csv" : "data/public/predixsport/wta/wta_elo_ratings.csv";
  try {
    const rows = parseCsv(readFileSync(join(process.cwd(), rel), "utf8"));
    if (tour === "ATP") atpRowsCache = rows; else wtaRowsCache = rows;
    return rows;
  } catch { return []; }
}
function cutoffFromContext(context: string): string | null { const m = context.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i); return m?.[1] ?? null; }
function surfaceFromContext(context: string): string | null { const m = context.match(/surface\s+(hard|clay|grass|carpet)/i); return m?.[1]?.toLowerCase() ?? null; }
function before(row: CsvRow, cutoff: string | null): boolean {
  /*Phase 13: unestablished boundary => no admissible evidence.*/
  return cutoff !== null && isBeforeCutoff(row.date, cutoff);
}
function number(v: string | undefined): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function source(retrievedAt: string) { return [{ source_name: SOURCE_NAME, url: SOURCE_URL, retrieved_at: retrievedAt }]; }
function stat(player: string, key: string, value: number, retrievedAt: string, surface: string | null = null, sample: number | null = null): SourcedStat { return { key, player, value, surface, window: "PRE_MATCH_HISTORY", tour_level: null, sample, origin: "DIRECT", sources: source(retrievedAt) }; }

export interface LocalDatasetEvidence { tour: "ATP" | "WTA"; player: string; canonicalPlayer?:string; context: string; cutoff: string | null; surface: string | null; stats: SourcedStat[]; summary: Record<string, number | string | null>; }

function atpEvidence(player: string, context: string): LocalDatasetEvidence | null {
  const cutoff = cutoffFromContext(context), surface = surfaceFromContext(context);
  const resolved=resolvePlayerRows(load("ATP"),player); if(!resolved)return null;
  const rows=resolved.rows.filter(r=>before(r,cutoff)).sort((a,b)=>(a.date||"").localeCompare(b.date||"")); if(!rows.length)return null;
  const retrievedAt = new Date().toISOString(); const surfaceRows = surface ? rows.filter((r) => (r.surface ?? "").toLowerCase() === surface) : rows; const use = surfaceRows.length ? surfaceRows : rows; const latest = use[use.length - 1];
  const elo = number(latest.elo_post) ?? number(latest.elo_pre); const vals=use.flatMap(r=>[number(r.elo_pre),number(r.elo_post)].filter((n):n is number=>n!==null)); const peak=vals.length?Math.max(...vals):null;
  const wins = use.filter((r) => r.won === "1").length, losses = use.filter((r) => r.won === "0").length; const setsWon = use.reduce((s,r) => s + (number(r.sets_for) ?? 0), 0), setsLost = use.reduce((s,r) => s + (number(r.sets_against) ?? 0), 0); const straightWins = use.filter((r) => r.won === "1" && number(r.sets_against) === 0).length;
  const deciding = use.filter((r) => { const a=number(r.sets_for), b=number(r.sets_against); return a!==null && b!==null && (a+b===3 || a+b===5); }); const decidingWins = deciding.filter((r) => r.won === "1").length;
  let last28 = 0; if (cutoff) { const end = new Date(`${cutoff}T00:00:00Z`).getTime(), start = end - 28*86400000; last28 = rows.filter((r) => { const t=Date.parse(`${r.date}T00:00:00Z`); return Number.isFinite(t) && t>=start && t<end; }).length; }
  const stats:SourcedStat[]=[]; if(elo!==null)stats.push(stat(player,"surface_elo",elo,retrievedAt,surface,use.length)); if(peak!==null)stats.push(stat(player,"peak_surface_elo",peak,retrievedAt,surface,use.length)); stats.push(stat(player,"surface_matches",use.length,retrievedAt,surface,use.length),stat(player,"surface_wins",wins,retrievedAt,surface,use.length),stat(player,"surface_losses",losses,retrievedAt,surface,use.length)); if(use.length)stats.push(stat(player,"surface_win_pct",100*wins/use.length,retrievedAt,surface,use.length)); stats.push(stat(player,"sets_played",setsWon+setsLost,retrievedAt,surface,use.length),stat(player,"sets_won",setsWon,retrievedAt,surface,use.length)); if(setsWon+setsLost)stats.push(stat(player,"set_win_pct",100*setsWon/(setsWon+setsLost),retrievedAt,surface,use.length)); stats.push(stat(player,"matches_won",wins,retrievedAt,surface,use.length),stat(player,"straight_set_wins",straightWins,retrievedAt,surface,use.length)); if(wins)stats.push(stat(player,"straight_set_win_pct",100*straightWins/wins,retrievedAt,surface,wins)); stats.push(stat(player,"deciding_sets_played",deciding.length,retrievedAt,surface,deciding.length),stat(player,"deciding_sets_won",decidingWins,retrievedAt,surface,deciding.length)); if(deciding.length)stats.push(stat(player,"deciding_set_win_pct",100*decidingWins/deciding.length,retrievedAt,surface,deciding.length)); stats.push(stat(player,"wins",wins,retrievedAt,surface,use.length),stat(player,"losses",losses,retrievedAt,surface,use.length),stat(player,"matches_played",use.length,retrievedAt,surface,use.length)); if(use.length)stats.push(stat(player,"win_pct",100*wins/use.length,retrievedAt,surface,use.length)); if(cutoff)stats.push(stat(player,"matches_last_28_days",last28,retrievedAt,surface,last28));
  return { tour:"ATP", player, canonicalPlayer:resolved.canonical, context, cutoff, surface, stats, summary:{ observations:use.length,wins,losses,elo,peak_elo:peak,last_date:latest.date??null,canonical_player:resolved.canonical } };
}

function wtaEvidence(player: string, context: string): LocalDatasetEvidence | null {
  const cutoff = cutoffFromContext(context), surface = surfaceFromContext(context);
  const historical = getTennisDataWtaHistoricalStats(player, context);
  const resolved = resolvePlayerRows(load("WTA"), player);

  // A player can be verified from the historical match archive even when she
  // predates the 2017+ Predix rating file. This is what makes 2007-2016 WTA
  // match evidence actually usable by the existing local audit pipeline.
  if (!resolved) {
    if (!historical.length) return null;
    return {
      tour: "WTA", player, canonicalPlayer: player, context, cutoff, surface,
      stats: historical,
      summary: { observations: historical.find((s) => s.key === "matches_played")?.value ?? historical[0]?.sample ?? 0, elo: null, peak_elo: null, last_date: null, canonical_player: player },
    };
  }

  const rows = resolved.rows.filter((r) => before(r, cutoff)).sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  if (!rows.length && !historical.length) return null;
  const stats:SourcedStat[] = [...historical];
  if (!rows.length) {
    return { tour:"WTA", player, canonicalPlayer:resolved.canonical, context, cutoff, surface, stats, summary:{ observations: historical.find((s) => s.key === "matches_played")?.value ?? historical[0]?.sample ?? 0, elo:null, peak_elo:null, last_date:null, canonical_player:resolved.canonical } };
  }
  const retrievedAt=new Date().toISOString(),surfaceRows=surface?rows.filter(r=>(r.surface??"").toLowerCase()===surface):rows,use=surfaceRows.length?surfaceRows:rows,latest=use[use.length-1],elo=number(latest.elo),vals=use.map(r=>number(r.elo)).filter((n):n is number=>n!==null),peak=vals.length?Math.max(...vals):null;
  if(elo!==null)stats.push(stat(player,"surface_elo",elo,retrievedAt,surface,use.length));
  if(peak!==null)stats.push(stat(player,"peak_surface_elo",peak,retrievedAt,surface,use.length));
  return {tour:"WTA",player,canonicalPlayer:resolved.canonical,context,cutoff,surface,stats,summary:{observations:use.length,elo,peak_elo:peak,last_date:latest.date??null,canonical_player:resolved.canonical}};
}

export function getPredixDatasetEvidence(player: string, context: string): LocalDatasetEvidence | null { return atpEvidence(player, context) ?? wtaEvidence(player, context); }
export function predixDatasetDossier(player: string, context: string): string { const e=getPredixDatasetEvidence(player,context); if(!e)return""; return `PREDIXSPORT_LOCAL_DATA:${JSON.stringify({tour:e.tour,player:e.player,canonicalPlayer:e.canonicalPlayer,cutoff:e.cutoff,surface:e.surface,summary:e.summary,stats:e.stats,source:SOURCE_URL,license:"CC BY 4.0"})}`; }
export function statsFromPredixDatasetDossier(dossier: string, player: string): SourcedStat[] { const marker="PREDIXSPORT_LOCAL_DATA:",i=dossier.indexOf(marker);if(i<0)return[];const tail=dossier.slice(i+marker.length).split("\n")[0];try{const parsed=JSON.parse(tail) as {stats?:SourcedStat[]};return(parsed.stats??[]).filter(s=>s.player===player);}catch{return[];} }
