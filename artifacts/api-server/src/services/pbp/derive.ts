import type { PbpDerivedStats } from "./types";

/**
 * Parses the ppaulojr-style point-by-point grammar (also used by other providers of the same
 * shape): one character per point (S=server won, R=returner won, A=ace, D=double fault), games
 * delimited by ';', sets delimited by '.', and '/' marking a change of server inside a tiebreak.
 *
 * This function derives ONLY what the grammar actually encodes. It never estimates serve speed,
 * serve direction, first-serve percentage, or rally length — those are not present in this token
 * stream at all, and are not returned as approximated numbers anywhere in this module.
 */
export interface ParsedPbp {
  pointsPlayed: number;
  /** Points won by whoever served that point, vs by the returner — tour-agnostic, not player-attributed yet. */
  serverWonCount: number;
  returnerWonCount: number;
  aces: number;
  doubleFaults: number;
  games: string[][]; // each game: array of point tokens ('S'|'R'|'A'|'D')
  sets: number;
  malformed: boolean;
  malformedReason: string | null;
}

const VALID_TOKENS = new Set(["S", "R", "A", "D"]);

/** Pure, real parse of the raw token stream. Returns malformed=true (never throws) on anything unrecognized. */
export function parsePbpString(raw: string): ParsedPbp {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { pointsPlayed: 0, serverWonCount: 0, returnerWonCount: 0, aces: 0, doubleFaults: 0, games: [], sets: 0, malformed: true, malformedReason: "empty_pbp_string" };
  }

  const setChunks = trimmed.split(".").filter((s) => s.length > 0);
  const games: string[][] = [];
  let pointsPlayed = 0;
  let serverWonCount = 0;
  let returnerWonCount = 0;
  let aces = 0;
  let doubleFaults = 0;
  let malformed = false;
  let malformedReason: string | null = null;

  for (const setChunk of setChunks) {
    const gameChunks = setChunk.split(";").filter((g) => g.length > 0);
    for (const gameChunk of gameChunks) {
      // '/' marks a tiebreak change-of-serve; it doesn't represent a point itself, so it is
      // stripped before tokenizing, not counted as a malformed character.
      const tokens = gameChunk.replace(/\//g, "").split("");
      const gameTokens: string[] = [];
      for (const token of tokens) {
        if (!VALID_TOKENS.has(token)) {
          malformed = true;
          malformedReason = malformedReason ?? `unrecognized_token:${token}`;
          continue;
        }
        gameTokens.push(token);
        pointsPlayed += 1;
        if (token === "S" || token === "A") serverWonCount += 1;
        if (token === "R" || token === "D") returnerWonCount += 1;
        if (token === "A") aces += 1;
        if (token === "D") doubleFaults += 1;
      }
      if (gameTokens.length > 0) games.push(gameTokens);
    }
  }

  if (pointsPlayed === 0) {
    malformed = true;
    malformedReason = malformedReason ?? "no_valid_points_parsed";
  }

  return { pointsPlayed, serverWonCount, returnerWonCount, aces, doubleFaults, games, sets: setChunks.length, malformed, malformedReason };
}

/**
 * Attributes the tour-agnostic parse above to player1/player2 using the winner + alternating-serve
 * convention shared by ppaulojr-shaped sources: server1 always serves the match's first game, and
 * service alternates game-by-game (standard tennis rules — the only exception, tiebreak mid-game
 * serve changes, is already stripped by `parsePbpString`, which treats the whole tiebreak game as
 * one unit served by whoever started it, since the grammar does not mark which sub-segment
 * belongs to which server explicitly beyond the '/' delimiter it already strips).
 *
 * Returns null (never a guess) when the token stream is malformed enough that per-game attribution
 * would be unreliable.
 */
export function deriveStatsFromPbp(args: {
  raw: string;
  sourceRecordId: string;
  server1IsPlayer1: boolean;
  adfFlag: 0 | 1 | null;
}): PbpDerivedStats | null {
  const parsed = parsePbpString(args.raw);
  if (parsed.malformed || parsed.pointsPlayed === 0) return null;

  let p1ServerPoints = 0;
  let p1ServerWon = 0;
  let p2ServerPoints = 0;
  let p2ServerWon = 0;
  let p1Aces = 0;
  let p2Aces = 0;
  let p1DoubleFaults = 0;
  let p2DoubleFaults = 0;

  parsed.games.forEach((gameTokens, gameIndex) => {
    // server1 serves games 0,2,4,...; server2 serves 1,3,5,... (standard alternation).
    const server1ServesThisGame = gameIndex % 2 === 0;
    const serverIsPlayer1 = args.server1IsPlayer1 ? server1ServesThisGame : !server1ServesThisGame;

    for (const token of gameTokens) {
      const serverWonPoint = token === "S" || token === "A";
      if (serverIsPlayer1) {
        p1ServerPoints += 1;
        if (serverWonPoint) p1ServerWon += 1;
        if (token === "A") p1Aces += 1;
        if (token === "D") p1DoubleFaults += 1;
      } else {
        p2ServerPoints += 1;
        if (serverWonPoint) p2ServerWon += 1;
        if (token === "A") p2Aces += 1;
        if (token === "D") p2DoubleFaults += 1;
      }
    }
  });

  const pct = (won: number, played: number): number | null => (played > 0 ? Math.round((won / played) * 1000) / 10 : null);
  // Return points won % is the opponent's serve points lost, from this player's perspective.
  const p1ReturnPlayed = p2ServerPoints;
  const p1ReturnWon = p2ServerPoints - p2ServerWon;
  const p2ReturnPlayed = p1ServerPoints;
  const p2ReturnWon = p1ServerPoints - p1ServerWon;

  const adfDataComplete = args.adfFlag === 1;

  return {
    pointsPlayed: parsed.pointsPlayed,
    serverPointsWon: { player1: p1ServerWon, player2: p2ServerWon },
    serverPointsPlayed: { player1: p1ServerPoints, player2: p2ServerPoints },
    servicePointsWonPct: { player1: pct(p1ServerWon, p1ServerPoints), player2: pct(p2ServerWon, p2ServerPoints) },
    returnPointsWonPct: { player1: pct(p1ReturnWon, p1ReturnPlayed), player2: pct(p2ReturnWon, p2ReturnPlayed) },
    // Real parsed counts in both branches — never null merely because adfFlag=0. adfFlag only
    // gates `adfDataComplete` (a completeness/confidence signal for the consumer), per the
    // source's own documented caveat that a flag of 0 means "none recorded", not "none occurred".
    aces: { player1: p1Aces, player2: p2Aces },
    doubleFaults: { player1: p1DoubleFaults, player2: p2DoubleFaults },
    adfDataComplete,
    gamesPlayed: parsed.games.length,
    setsPlayed: parsed.sets,
    sourceRecordId: args.sourceRecordId,
  };
}
