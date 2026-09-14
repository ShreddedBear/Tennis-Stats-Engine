// REAL-RESULT RESOLUTION -- the primitives that turn a finished match into a graded
// prediction observation.
//
// This module is the whole boundary between "what the engine decided" and "what actually
// happened". It is deliberately tiny and deliberately ignorant: the ONLY inputs it accepts
// are two player names, the selected player, the real winner's name, and the match's result
// status. It cannot see evidence coverage, the active-metric registry, evidence support, or
// any audit feature -- there is no parameter through which they could reach it. That is the
// point: a prediction wins because the player it named won, never because the evidence
// behind it looked good.
//
// The single rule everything else follows from: an unknown result is OPEN, never a loss.
// A match that was never played to a finish -- postponed, cancelled, abandoned, walked over,
// still scheduled -- stays open forever rather than being scored against the engine.

/**
 * Result statuses that establish a winner THROUGH PLAY, and therefore make a prediction
 * gradable. RETIRED is included because the app's existing calibration semantics already
 * count RETIREMENT WIN/RETIREMENT LOSS as real graded results (see gradeResult in
 * calibration.ts); this stays consistent with that rather than inventing a second rule.
 */
export const FINAL_RESULT_STATUSES = ["FINAL", "RETIRED"] as const;

/**
 * Statuses that explicitly do NOT establish a played result. WALKOVER is here for the same
 * reason it is excluded from gradeResult's `counts`: a walkover names a winner but no match
 * happened, so it can neither confirm nor refute a prediction about how one would go.
 */
export const NON_FINAL_RESULT_STATUSES = [
  "UNKNOWN", "SCHEDULED", "IN_PROGRESS", "POSTPONED", "CANCELLED", "ABANDONED", "WALKOVER",
] as const;

export type FinalResultStatus = (typeof FINAL_RESULT_STATUSES)[number];

export interface MatchResultFacts {
  player1_name: string;
  player2_name: string;
  /** Null/absent means nothing is known yet -- the match stays open. */
  actual_winner?: string | null;
  result_status?: string | null;
}

export type ResolutionStatus = "WIN" | "LOSS" | "UNRESOLVED";

export interface PredictionResolution {
  status: ResolutionStatus;
  /** True only for WIN/LOSS. An unresolved observation is never counted anywhere. */
  resolved: boolean;
  /** The side the real winner occupies, once it is known and unambiguous. */
  actual_side: "P1" | "P2" | null;
  selected_side: "P1" | "P2" | null;
  /** Vocabulary shared with the existing calibration ledger. */
  result_type: "WIN" | "LOSS" | "RETIREMENT WIN" | "RETIREMENT LOSS" | "NOT GRADED";
  /** Why an observation is still open. Null once resolved. */
  reason: string | null;
}

function normalizeName(value: string) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Lenient enough for "Bueno" vs "Gonzalo Bueno", strict enough never to fuse two players:
 * surnames must agree, so a shared given name alone matches nothing.
 */
export function playerNamesMatch(a: string | null | undefined, b: string | null | undefined) {
  const [x, y] = [normalizeName(String(a ?? "")), normalizeName(String(b ?? ""))];
  if (!x || !y) return false;
  if (x === y) return true;
  const [xt, yt] = [x.split(" "), y.split(" ")];
  return xt[xt.length - 1] === yt[yt.length - 1];
}

/**
 * Which side of THIS match a name refers to. Returns null when the name matches neither
 * player or -- the case that matters -- both of them, because two players whose surnames
 * collide cannot be told apart and guessing would silently invent a result.
 */
export function matchSideForName(name: string | null | undefined, facts: MatchResultFacts): "P1" | "P2" | null {
  if (!String(name ?? "").trim()) return null;
  const p1 = playerNamesMatch(name, facts.player1_name);
  const p2 = playerNamesMatch(name, facts.player2_name);
  return p1 === p2 ? null : p1 ? "P1" : "P2";
}

/** Whether the match has a final, played result at all -- independent of any prediction. */
export function matchResultIsFinal(facts: MatchResultFacts): boolean {
  const status = String(facts.result_status ?? "").trim().toUpperCase();
  if (!(FINAL_RESULT_STATUSES as readonly string[]).includes(status)) return false;
  return matchSideForName(facts.actual_winner, facts) !== null;
}

/**
 * Grade one prediction against one real result.
 *
 * Every early return is UNRESOLVED, never LOSS. A missing winner, a non-final status, an
 * unrecognisable name and a refusal to predict all leave the observation open, which is what
 * stops the population from quietly filling up with losses the engine never actually took.
 */
export function resolvePredictionOutcome(
  selectedPlayer: string | null | undefined,
  facts: MatchResultFacts,
): PredictionResolution {
  const open = (reason: string, extra: Partial<PredictionResolution> = {}): PredictionResolution => ({
    status: "UNRESOLVED", resolved: false, actual_side: null, selected_side: null,
    result_type: "NOT GRADED", reason, ...extra,
  });

  const selected_side = matchSideForName(selectedPlayer, facts);
  if (!String(selectedPlayer ?? "").trim()) return open("The engine selected no player, so there is nothing to grade.");
  if (!selected_side) return open("The selected player does not unambiguously identify one participant.");

  const status = String(facts.result_status ?? "").trim().toUpperCase() || "UNKNOWN";
  if (!String(facts.actual_winner ?? "").trim()) return open("No final result is known for this match yet.", { selected_side });
  if (!(FINAL_RESULT_STATUSES as readonly string[]).includes(status))
    return open(`Match result status is ${status}, which does not establish a played result.`, { selected_side });

  const actual_side = matchSideForName(facts.actual_winner, facts);
  if (!actual_side) return open("The recorded winner does not unambiguously identify one participant.", { selected_side });

  const won = actual_side === selected_side;
  const retired = status === "RETIRED";
  return {
    status: won ? "WIN" : "LOSS",
    resolved: true,
    actual_side,
    selected_side,
    result_type: retired ? (won ? "RETIREMENT WIN" : "RETIREMENT LOSS") : won ? "WIN" : "LOSS",
    reason: null,
  };
}

export interface CapturedResult {
  actual_winner: string | null;
  result_status: string | null;
  final_score?: string | null;
}

/**
 * Build the patch that writes a captured result onto a match, or null for "leave it alone".
 *
 * Two things it will never do: write a null/blank winner over anything, and overwrite a
 * winner that is already recorded. A recorded result is a fact about the real world; a later
 * capture pass that disagrees is a conflict to look at, not something to silently resolve by
 * last-write-wins. `allowOverwrite` exists for a deliberate correction and is never set by
 * the automatic capture path.
 */
export function mergeCapturedResult(
  existing: CapturedResult,
  incoming: CapturedResult,
  options: { now?: Date; allowOverwrite?: boolean } = {},
): Record<string, unknown> | null {
  const winner = String(incoming.actual_winner ?? "").trim();
  if (!winner) return null;
  const held = String(existing.actual_winner ?? "").trim();
  if (held && !options.allowOverwrite) return null;
  if (held && playerNamesMatch(held, winner) && !incoming.final_score) return null;

  const patch: Record<string, unknown> = {
    actual_winner: winner,
    result_status: String(incoming.result_status ?? "").trim().toUpperCase() || "UNKNOWN",
    result_recorded_at: (options.now ?? new Date()).toISOString(),
  };
  const score = String(incoming.final_score ?? "").trim();
  if (score) patch["final_score"] = score;
  return patch;
}


// ----------------------------------------------------------------------------
// RESULT STATUS FROM A HISTORY ROW (pure). Extracted verbatim from the audit
// app's match-result-capture.server.ts. Deciding whether a recorded score means
// FINAL / RETIRED / WALKOVER is result SEMANTICS, not data access, so it belongs
// beside the other resolution primitives -- and, like them, it can see only a
// score string: never coverage, never the registry, never a probability.
// ----------------------------------------------------------------------------
export type HistoryDetail = { status?: string | null; raw_score?: string | null };

/**
 * Map one history row's scoreline/status onto the match-level result vocabulary.
 *
 * A recorded history row exists because a match was PLAYED, so an absent status is FINAL,
 * not unknown -- that is the same reading every metric engine already applies to this store.
 * What must be pulled back out are the two shapes that name a winner without a played
 * result: walkovers and defaults. Those become WALKOVER, which resolution treats as
 * ungradable.
 */
export function resultStatusFromHistory(detail: HistoryDetail | undefined): string | null {
  const raw = String(detail?.raw_score ?? "");
  if (/\bw\.?\s*\/?\s*o\.?\b|walk\s*over|\bdef\.?\b|default/i.test(raw)) return "WALKOVER";
  if (/\bret\.?\b|\brtd\.?\b|retire/i.test(raw)) return "RETIRED";
  const status = String(detail?.status ?? "").trim().toUpperCase();
  if (!status || status === "FINISHED" || status === "COMPLETE" || status === "COMPLETED") return "FINAL";
  if (["WALKOVER", "RETIRED", "CANCELLED", "CANCELED", "POSTPONED", "ABANDONED"].includes(status)) {
    return status === "CANCELED" ? "CANCELLED" : status;
  }
  return null;
}

type Candidate = { winnerSide: "P1" | "P2"; status: string; score: string | null };

/**
 * Find this match's own recorded result. Returns null unless the store yields exactly one
 * consistent answer.
 *
 * The winner is returned as the match's OWN canonical player name, derived from which side
 * the row says won, never as the raw name string in the history row -- those are sometimes
 * abbreviated ("Micic E."), and passing one through would fail every later name comparison.
 */
