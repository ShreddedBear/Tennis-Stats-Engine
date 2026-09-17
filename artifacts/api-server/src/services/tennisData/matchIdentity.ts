/**
 * Stable, provider-agnostic identity for a single fixture, used only to correlate the SAME
 * real-world match across two different providers when their native fixture ids don't (and
 * shouldn't be assumed to) line up -- e.g. MatchStat's `${tournamentId}:${player1Id}:${player2Id}`
 * composite key vs. API-Tennis's own `event_key`. Never used as a replacement for either
 * provider's own id -- those are preserved and tried first everywhere this key is used.
 *
 * Built from the calendar date + both player names (accent/punctuation/case-folded via
 * `normalizePlayerName`, the same normalization already trusted for cross-provider player
 * matching elsewhere in this codebase) rather than either provider's numeric player id, since
 * player-id namespaces are just as provider-specific as fixture-id namespaces. Order-independent
 * so a home/away or player1/player2 swap between providers still produces the same key.
 */
import { normalizePlayerName } from "./playerIdentity";

export function buildMatchIdentityKey(date: string, player1Name: string, player2Name: string): string {
  const a = normalizePlayerName(player1Name);
  const b = normalizePlayerName(player2Name);
  const [first, second] = a <= b ? [a, b] : [b, a];
  return `${date}|${first}|${second}`;
}
