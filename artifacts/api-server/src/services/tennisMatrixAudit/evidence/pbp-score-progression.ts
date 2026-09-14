// ----------------------------------------------------------------------------
// Deriving point winners from a score progression.
//
// WHY: reconstructPbpScoreState requires an EXPLICIT winner on every point -- one of
// `winner`/`point_winner`/`pointWinner`/`winner_slot`/`won_by`, carrying one of a small set
// of tokens. A point without one is dropped, which makes the game incomplete, which fails
// the whole tape with "PBP lacks a complete server/point-winner game structure".
//
// Many providers never publish a per-point winner. They publish the RUNNING SCORE after each
// point -- "0-0", "15-0", "15-15", "30-15". The winner of each point is then not a guess: it
// is whichever side's score went up. Recovering it is reading the tape the provider actually
// sent, not inventing evidence the provider did not have.
//
// THE RULE THIS MODULE IS BUILT AROUND: ambiguity REJECTS. Every transition must be
// explicable as exactly one side winning exactly one point. A transition where both sides
// changed, neither changed, a score went backwards in a way no rally can produce, or the
// notation cannot be parsed, returns null for the whole game -- never a filled-in guess.
// A rejected game is an honest "this tape could not be read"; a guessed one is fabricated
// evidence, which is the one thing this layer must never produce.
// ----------------------------------------------------------------------------

export type PbpSide = "player1" | "player2";

/** Ladder positions for a standard game. AD is 4; deuce is 3-3. */
const LADDER = new Map<string, number>([
  ["0", 0], ["00", 0], ["love", 0],
  ["15", 1], ["30", 2], ["40", 3],
  ["a", 4], ["ad", 4], ["adv", 4], ["advantage", 4], ["45", 4],
]);

export interface ScoreState {
  /** Ladder index or raw tiebreak count for each side. */
  p1: number;
  p2: number;
  /** True when the pair was read as plain integers (a tiebreak or a numeric tape). */
  numeric: boolean;
}

/**
 * Parse one score state. Accepts "15-30", "15:30", [1,2], {p1,p2} and the common spellings
 * of advantage. Returns null when the notation is not understood -- which rejects rather
 * than assuming, because a misread score would silently invent a point winner.
 */
export function parseScoreState(raw: unknown): ScoreState | null {
  if (Array.isArray(raw) && raw.length >= 2) return fromPair(raw[0], raw[1]);
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const a = record["p1"] ?? record["player1"] ?? record["home"] ?? record["server"];
    const b = record["p2"] ?? record["player2"] ?? record["away"] ?? record["returner"];
    if (a !== undefined && b !== undefined) return fromPair(a, b);
    return null;
  }
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const parts = text.split(/[-:/\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  return fromPair(parts[0], parts[1]);
}

function fromPair(a: unknown, b: unknown): ScoreState | null {
  const left = String(a ?? "").trim().toLowerCase();
  const right = String(b ?? "").trim().toLowerCase();
  if (!left || !right) return null;

  // Plain integers are a tiebreak or a numeric tape: the ladder does not apply.
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const p1 = Number(left), p2 = Number(right);
    // 0/15/30/40 are ALSO valid integers, so a pair reads as the ladder only when BOTH
    // values sit on it -- "2-1" and "7-5" stay numeric because 2, 1, 7 and 5 do not.
    if (LADDER.has(left) && LADDER.has(right)) {
      return { p1: LADDER.get(left)!, p2: LADDER.get(right)!, numeric: false };
    }
    return { p1, p2, numeric: true };
  }

  const p1 = LADDER.get(left);
  const p2 = LADDER.get(right);
  if (p1 === undefined || p2 === undefined) return null;
  return { p1, p2, numeric: false };
}

/**
 * Who won the point that took the game from `prev` to `next`, or null if that is not
 * unambiguously one side winning one point.
 */
export function pointWinnerBetween(prev: ScoreState, next: ScoreState): PbpSide | null {
  // A tape must not switch notation mid-game; that is a parse failure, not a rally. The one
  // exception is the opening 0-0, which is identical under both notations and therefore
  // carries no information about which one this tape uses.
  const openingState = prev.p1 === 0 && prev.p2 === 0;
  if (!openingState && prev.numeric !== next.numeric) return null;
  if (openingState) prev = { ...prev, numeric: next.numeric };

  const d1 = next.p1 - prev.p1;
  const d2 = next.p2 - prev.p2;

  if (d1 === 1 && d2 === 0) return "player1";
  if (d2 === 1 && d1 === 0) return "player2";

  if (!prev.numeric) {
    // Advantage surrendered: AD-40 back to deuce means the OTHER side won the point.
    if (prev.p1 === 4 && prev.p2 === 3 && next.p1 === 3 && next.p2 === 3) return "player2";
    if (prev.p2 === 4 && prev.p1 === 3 && next.p2 === 3 && next.p1 === 3) return "player1";
  }
  return null;
}

export interface DerivedPoint { winner: PbpSide }

/**
 * Derive a winner for every point of one game from its score progression.
 *
 * `states` is the score AFTER each point, optionally preceded by the opening 0-0. The game's
 * final point is the one that ends it: a progression only shows in-game states, so the last
 * point's winner comes from `gameWinner` when the tape gives one. Without it, the final
 * point is unknowable and the whole game is rejected rather than half-credited.
 *
 * Returns null -- rejecting the game -- on any unparseable or ambiguous step.
 */
export function derivePointWinners(states: unknown[], gameWinner?: PbpSide | null): DerivedPoint[] | null {
  if (!Array.isArray(states) || states.length === 0) return null;

  const parsed: ScoreState[] = [];
  for (const raw of states) {
    const state = parseScoreState(raw);
    if (!state) return null;
    parsed.push(state);
  }

  // A tape that starts mid-game cannot be anchored, so prepend 0-0 only when the first state
  // is not already the start. If the first state is not reachable as a first point either,
  // the transition check below rejects it.
  const opening: ScoreState = { p1: 0, p2: 0, numeric: parsed[0]!.numeric };
  const sequence = parsed[0]!.p1 === 0 && parsed[0]!.p2 === 0 ? parsed : [opening, ...parsed];

  const winners: DerivedPoint[] = [];
  for (let i = 1; i < sequence.length; i++) {
    const winner = pointWinnerBetween(sequence[i - 1]!, sequence[i]!);
    if (!winner) return null;
    winners.push({ winner });
  }

  // The closing point. Only the tape's own stated game winner may supply it.
  if (gameWinner) winners.push({ winner: gameWinner });
  else if (!winners.length) return null;

  return winners.length ? winners : null;
}

/**
 * Pull a game's score progression out of whatever field carries it. Returns null when the
 * game has no recognisable progression, so callers can fall back to explicit winners.
 */
export function scoreProgressionOf(game: Record<string, unknown>): unknown[] | null {
  for (const key of ["score_progression", "scoreProgression", "scores", "score_states", "point_scores"]) {
    const value = game[key];
    if (Array.isArray(value) && value.length) return value;
  }
  // Or a per-point score field on each point entry.
  const points = game["points"];
  if (Array.isArray(points) && points.length) {
    const states = points.map((p) => {
      if (!p || typeof p !== "object") return null;
      const record = p as Record<string, unknown>;
      return record["score"] ?? record["score_after"] ?? record["scoreAfter"] ?? record["point_score"] ?? null;
    });
    if (states.every((s) => s !== null && s !== undefined)) return states;
  }
  return null;
}
