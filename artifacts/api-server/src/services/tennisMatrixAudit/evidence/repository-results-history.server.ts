import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";
import { evidencePairMatches, normalizeEvidenceIdentity } from "./evidence-player-alias";
import { normalizeEvidenceTournament, type EvidenceTourFamily } from "./evidence-match-identity";

export type RepositoryResultsObservation = {
  source_id: string; source_name: string; source_url: null; player_name: string; opponent_name: string | null; tournament: string | null; event_date: string | null; surface: string | null; observation_type: "MATCH_RESULT_OR_SCHEDULE"; observation_key: "match_record"; text_value: string; sample_label: string | null; raw_payload: Record<string, unknown>; provenance: Record<string, unknown>;
};
type HistoryDetails={sets_for?:number|null;sets_against?:number|null;set_scores?:Array<[number,number]>;best_of?:number|null;opponent_rank?:number|null;opponent_elo?:number|null;status?:string|null;raw_score?:string|null};
type HistoryEntry = [unknown, unknown, unknown, unknown, unknown, unknown, unknown, HistoryDetails?];
const FAMILIES: EvidenceTourFamily[] = ["ATP_MAIN", "WTA_MAIN", "ATP_CHALLENGER", "WTA_CHALLENGER"];
function sourceId(family: EvidenceTourFamily) {switch (family) {case "ATP_MAIN": return "atp";case "WTA_MAIN": return "wta";case "ATP_CHALLENGER": return "atp_challenger";case "WTA_CHALLENGER": return "wta_challenger";}}
// Both TennisData.app-sourced lanes (WTA_CHALLENGER's validated WTA 125 production
// history, and WTA_MAIN's TennisData.app WTA Tour production history) identify every
// player -- both a bucket's own key and every opponent it references -- using
// "Surname InitialOfFirstName" (e.g. "Heisen V.", "Haddad Maia B."), not the full name
// used everywhere else in the app. This is a real, confirmed 0%-credit bug, not a missing-
// data problem: real, already-validated match history is sitting in these buckets, but a
// full-name lookup ("Victoria Heisen") can never match the bucket's own key ("heisen v").
// Because the source data uses this abbreviated convention consistently for every name it
// stores (a player's own bucket key AND every opponent name inside every bucket),
// resolving only this entry-point lookup keeps the rest of the pipeline (common-opponent
// cross-referencing in historical-results-recovery.ts, etc.) internally consistent --
// those comparisons are between two "Surname I." strings either way, so nothing further
// needs to change.
//
// No fuzzy/edit-distance matching: every candidate key below is mechanically derived from
// the query name, and a candidate only ever resolves anything by an EXACT string match
// against a real, already-existing bucket key -- a wrong guess simply finds nothing (fails
// closed, same as today), it can never misattribute one player's history to another. Two
// candidates are tried because tennis surnames are sometimes compound ("Beatriz Haddad
// Maia" -> "haddad maia b") and sometimes not ("Victoria Heisen" -> "heisen v"), and a flat
// name string alone can't disambiguate given-name-count from surname-word-count; trying
// both the "everything but the first token" and "just the last token" derivations covers
// both real shapes without guessing between them. Any ambiguity among distinct players who
// share a surname+initial is a limitation already baked into the source data itself, not
// something these candidates introduce or worsen.
function surnameInitialKeyCandidates(value: string): string[] {
  const parts = normalizeEvidenceIdentity(value).split(" ").filter(Boolean);
  if (parts.length < 2) return [];
  const firstInitial = parts[0][0];
  const candidates = new Set<string>([
    `${parts.slice(1).join(" ")} ${firstInitial}`,
    `${parts[parts.length - 1]} ${firstInitial}`,
  ]);
  return [...candidates];
}
const SURNAME_INITIAL_FALLBACK_FAMILIES = new Set<EvidenceTourFamily>(["WTA_MAIN", "WTA_CHALLENGER"]);
function historyRows(player: string, family: EvidenceTourFamily): HistoryEntry[] {
  const key = normalizeEvidenceIdentity(player);
  if (!key) return [];
  const lane = (loadRuntimeIndex() as any)?.matchHistory?.[family];
  const direct = lane?.[key];
  if (Array.isArray(direct)) return direct as HistoryEntry[];
  if (SURNAME_INITIAL_FALLBACK_FAMILIES.has(family)) {
    for (const candidate of surnameInitialKeyCandidates(player)) {
      const fallback = lane?.[candidate];
      if (Array.isArray(fallback)) return fallback as HistoryEntry[];
    }
  }
  return [];
}
export function repositoryHistoryAvailable(player:string,family:EvidenceTourFamily){return historyRows(player,family).length>0;}

export function inferRepositoryMatchContext(args: { p1: string; p2: string; asOfDate: string; tournament?: string | null }) {
  const expectedTournament = normalizeEvidenceTournament(args.tournament);
  const found = new Map<string, { family: EvidenceTourFamily; date: string; tournament: string | null; surface: string | null; round: string | null }>();
  for (const family of FAMILIES) for (const entry of historyRows(args.p1, family)) {
    const [dateRaw, tournamentRaw, surfaceRaw, opponentRaw, , roundRaw] = entry;const date = String(dateRaw ?? "").slice(0, 10);const opponent = String(opponentRaw ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date !== args.asOfDate || !evidencePairMatches(args.p1, opponent, args.p1, args.p2)) continue;
    const tournament = String(tournamentRaw ?? "").trim() || null;const normalizedTournament = normalizeEvidenceTournament(tournament);if (expectedTournament && normalizedTournament && expectedTournament !== normalizedTournament) continue;
    const round = String(roundRaw ?? "").trim() || null;const surface = String(surfaceRaw ?? "").trim() || null;found.set(`${family}|${normalizedTournament}|${date}|${round ?? ""}`, { family, date, tournament, surface, round });
  }
  if (found.size !== 1) return null;const row = [...found.values()][0];const level = row.family.replaceAll("_", " ");return [`Tournament: ${row.tournament ?? args.tournament ?? "unknown"}`, `Level: ${level}`, `Tour: ${level}`, row.surface ? `Surface: ${row.surface}` : null, `Date: ${row.date}`, row.round ? `Round: ${row.round}` : null].filter(Boolean).join(" | ");
}

export function repositoryResultsRows(player: string, family: EvidenceTourFamily, asOfDate: string, options:{strictBefore?:boolean}={}): RepositoryResultsObservation[] {
  const rows = historyRows(player, family);if (!rows.length) return [];const out: RepositoryResultsObservation[] = [];
  for (const entry of rows) {
    const [dateRaw, tournamentRaw, surfaceRaw, opponentRaw, wonRaw, roundRaw, sourceRaw, detailRaw] = entry;const date = String(dateRaw ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (options.strictBefore ? date >= asOfDate : date > asOfDate)) continue;
    const opponent = String(opponentRaw ?? "").trim();if (!opponent) continue;const won = wonRaw === 1 ? true : wonRaw === 0 ? false : null;const winner = won === true ? player : won === false ? opponent : null;
    const tournament = String(tournamentRaw ?? "").trim() || null;const surface = String(surfaceRaw ?? "").trim() || null;const round = String(roundRaw ?? "").trim() || null;const source = String(sourceRaw ?? "").trim() || `Repository ${family} history`;const history_detail=(detailRaw&&typeof detailRaw==="object"?detailRaw:{}) as HistoryDetails;
    const payload = { winner, round, tour_family: family, repository_history: true, history_detail };
    out.push({source_id: sourceId(family),source_name: source,source_url: null,player_name: player,opponent_name: opponent,tournament,event_date: date,surface,observation_type: "MATCH_RESULT_OR_SCHEDULE",observation_key: "match_record",text_value: JSON.stringify(payload),sample_label: round,raw_payload: payload,provenance: { repository_history: true, tour_family: family, strict_before_target: Boolean(options.strictBefore), raw_score_preserved: history_detail.raw_score != null }});
  }
  return out;
}
