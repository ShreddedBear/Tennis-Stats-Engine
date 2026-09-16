import type { MatchRecord } from "../../tennisData/types";

/**
 * `MatchRecord.setGameMargins` is stored/reconstructed from a fixed-length (5-slot) array in the
 * historical store (`historical_matches.game_margins_player1`) -- unplayed trailing sets are
 * padded with `{playerGames: 0, opponentGames: 0}` rather than the array being trimmed to the
 * real set count. `.length` alone is therefore always 5 and must never be used as a proxy for
 * "does this match have real set-score data" or "how many sets were played" -- a real set has at
 * least one game won by either side. Any code reading `setGameMargins` should filter through this
 * helper first.
 */
export function realSetGameMargins(match: MatchRecord): MatchRecord["setGameMargins"] {
  return match.setGameMargins.filter((s) => s.playerGames > 0 || s.opponentGames > 0);
}
