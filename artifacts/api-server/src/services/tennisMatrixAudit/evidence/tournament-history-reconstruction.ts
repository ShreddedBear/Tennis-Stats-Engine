import { loadRuntimeIndex } from "./runtime-tennis-index-data.server";

// PHASE 2 producer fix -- metric 030 (Tournament-Specific Strength).
//
// The live store showed 030 emitting `same_tournament_matches_5y=0; same_tournament_wins_5y=0`
// in 134 of 208 rows: its producer counts same-tournament history out of `source_observations`,
// which simply does not hold historical per-tournament results for most players. It also
// emitted only RAW COUNTS -- no rate and no denominator a comparison layer could use.
//
// The information already exists in the generated runtime index, which carries every
// player's chronological match history with the tournament name and win/loss attached. This
// reconstructs the same quantity from that index instead of introducing a new source.
//
// Two honest limits, both measured against the real audited slate rather than assumed:
//   * Coverage is event-shaped, not uniform. Players return to the same Grand Slam every
//     year (Rublev 40 prior US Open matches, Tsitsipas 17), but Challenger fields rotate, so
//     most Challenger pairs return 0 for at least one side. On a 7-pair sample of the live
//     slate only 2 pairs were two-sided and comfortably sampled.
//   * A one-sided result is NOT evidence. Both players must clear the floor, or the metric
//     reports nothing -- a player with no history at an event has an unknown record there,
//     not a bad one.
export interface TournamentHistory {
  matches: number;
  wins: number;
  /** null when matches === 0 -- an empty record has no rate, and 0% would be a lie. */
  win_pct: number | null;
}

function norm(value: string) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Tournament identity across sources. The index and the audited match disagree on
 * decoration ("US Open Men Singles" vs "US Open", "ATP Challenger Como" vs "Como"), so
 * tour/gender/level words are stripped before comparing. What remains is the event's actual
 * name, which is what "same tournament" means.
 */
export function tournamentKey(value: string | null | undefined) {
  return norm(String(value ?? ""))
    .replace(/\b(atp|wta|challenger|chall|men|women|singles|tour|itf|125k|125|250|500|1000)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Surname-plus-initial index keys ("rublev a") against a full name ("Andrey Rublev"). */
function keyMatchesPlayer(indexKey: string, player: string) {
  const key = norm(indexKey), name = norm(player);
  if (key === name) return true;
  const keyTokens = key.split(" ").filter(Boolean), nameTokens = name.split(" ").filter(Boolean);
  if (keyTokens.length < 2 || nameTokens.length < 2) return false;
  const initial = keyTokens[keyTokens.length - 1];
  if (initial.length !== 1) return false;
  return keyTokens.slice(0, -1).join(" ") === nameTokens.slice(1).join(" ") && initial === nameTokens[0][0];
}

/**
 * The player's record at one tournament, strictly BEFORE the audited date.
 *
 * `asOfDate` is exclusive on purpose: a match played on the audited day may BE the audited
 * match, and cannot be prior evidence for itself (see temporal-boundary.ts).
 */
export function sameTournamentHistory(player: string, tournament: string | null | undefined, asOfDate: string, withinYears = 5): TournamentHistory {
  const wanted = tournamentKey(tournament);
  const empty: TournamentHistory = { matches: 0, wins: 0, win_pct: null };
  if (!wanted || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return empty;

  const earliest = `${Number(asOfDate.slice(0, 4)) - withinYears}${asOfDate.slice(4)}`;
  const history = loadRuntimeIndex().matchHistory as unknown as Record<string, Record<string, unknown[]>>;
  const seen = new Set<string>();
  let matches = 0, wins = 0;

  for (const lane of Object.keys(history ?? {})) {
    for (const [indexKey, entries] of Object.entries(history[lane] ?? {})) {
      if (!Array.isArray(entries) || !keyMatchesPlayer(indexKey, player)) continue;
      for (const entry of entries) {
        if (!Array.isArray(entry)) continue;
        const [dateRaw, tournamentRaw, , opponentRaw, wonRaw] = entry as unknown[];
        const date = String(dateRaw ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= asOfDate || date < earliest) continue;
        if (wonRaw !== 0 && wonRaw !== 1) continue;               // unknown outcome is not a loss
        if (tournamentKey(String(tournamentRaw ?? "")) !== wanted) continue;
        // The same match can appear in more than one lane; count it once.
        const id = `${date}|${norm(String(opponentRaw ?? ""))}`;
        if (seen.has(id)) continue;
        seen.add(id);
        matches += 1;
        if (wonRaw === 1) wins += 1;
      }
    }
  }
  return { matches, wins, win_pct: matches > 0 ? Number(((100 * wins) / matches).toFixed(2)) : null };
}
