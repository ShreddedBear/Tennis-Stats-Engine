import { normalizePlayerName } from "../tennisData/playerIdentity";
import type { CanonicalPbpLookup, PbpIdentityStatus } from "./types";

/** The minimal shape of a historical_matches row this resolver needs — kept narrow and DB-free so it stays unit-testable without a live database. */
export interface CandidateHistoricalMatch {
  id: number;
  player1Name: string;
  player2Name: string;
  tournamentName: string | null;
  /** ISO date (YYYY-MM-DD) or full timestamp — only the date portion is compared. */
  scheduledStartAt: string;
  surface: string | null;
  round: string | null;
}

export interface IdentityResolution {
  status: PbpIdentityStatus;
  canonicalMatchId: number | null;
  /** Whether the winning/only candidate has server1==lookup.player1 (true) or is flipped (false) — needed to attribute PBP stats to the right canonical player. Null when there is no matched candidate. */
  orientationMatchesLookup: boolean | null;
  candidateIds: number[];
  reason: string;
}

const DATE_TOLERANCE_DAYS = 1;

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${dateOnly(a)}T00:00:00Z`).getTime();
  const db = new Date(`${dateOnly(b)}T00:00:00Z`).getTime();
  return Math.abs(da - db) / 86_400_000;
}

function normalizedTournament(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\batp\b|\bwta\b|\bchallenger\b|\btour\b|\bqualifying\b|\bmain\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Resolves a PBP lookup (raw names + date, from an adapter's source data) against a pre-fetched
 * set of `historical_matches` candidates for the same approximate date window. Never guesses: an
 * empty candidate set is NO_MATCH, more than one plausible candidate is AMBIGUOUS, and only an
 * exact single match on both players (either orientation) plus a date within tolerance is MATCHED.
 * Tournament name is used only to break ties when multiple candidates share the same player pair
 * and date — it never substitutes for the player+date check.
 */
export function resolvePbpMatchIdentity(
  lookup: CanonicalPbpLookup,
  candidates: CandidateHistoricalMatch[],
): IdentityResolution {
  const p1 = normalizePlayerName(lookup.player1Name);
  const p2 = normalizePlayerName(lookup.player2Name);
  if (!p1 || !p2) {
    return { status: "REVIEW_REQUIRED", canonicalMatchId: null, orientationMatchesLookup: null, candidateIds: [], reason: "missing_player_name" };
  }

  const playerMatches = candidates.filter((c) => {
    const c1 = normalizePlayerName(c.player1Name);
    const c2 = normalizePlayerName(c.player2Name);
    const straight = c1 === p1 && c2 === p2;
    const flipped = c1 === p2 && c2 === p1;
    if (!straight && !flipped) return false;
    return daysBetween(c.scheduledStartAt, lookup.date) <= DATE_TOLERANCE_DAYS;
  });

  if (playerMatches.length === 0) {
    return { status: "NO_MATCH", canonicalMatchId: null, orientationMatchesLookup: null, candidateIds: [], reason: "no_historical_match_for_player_pair_and_date" };
  }

  if (playerMatches.length === 1) {
    const match = playerMatches[0];
    const orientationMatchesLookup = normalizePlayerName(match.player1Name) === p1;
    return { status: "MATCHED", canonicalMatchId: match.id, orientationMatchesLookup, candidateIds: [match.id], reason: "unique_player_pair_and_date_match" };
  }

  // More than one candidate on the same player pair within the date window (e.g. two meetings a
  // day apart at the same event, or a data error) — try tournament name as a tie-breaker only.
  if (lookup.tournamentName) {
    const wantedTournament = normalizedTournament(lookup.tournamentName);
    const tournamentMatches = playerMatches.filter((c) => {
      const candidateTournament = normalizedTournament(c.tournamentName);
      return candidateTournament.length > 0 && wantedTournament.length > 0 && (candidateTournament.includes(wantedTournament) || wantedTournament.includes(candidateTournament));
    });
    if (tournamentMatches.length === 1) {
      const match = tournamentMatches[0];
      const orientationMatchesLookup = normalizePlayerName(match.player1Name) === p1;
      return { status: "MATCHED", canonicalMatchId: match.id, orientationMatchesLookup, candidateIds: [match.id], reason: "unique_after_tournament_tiebreak" };
    }
  }

  return {
    status: "AMBIGUOUS",
    canonicalMatchId: null,
    orientationMatchesLookup: null,
    candidateIds: playerMatches.map((c) => c.id),
    reason: `${playerMatches.length}_candidates_same_player_pair_and_date_window`,
  };
}
