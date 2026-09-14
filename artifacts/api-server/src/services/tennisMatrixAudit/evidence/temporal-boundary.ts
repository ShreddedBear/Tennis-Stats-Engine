// TRUTH ENGINE — THE TEMPORAL BOUNDARY
//
// Phase 13 forensic finding. Producers across this codebase filtered their source rows
// with the shape:
//
//     rows.filter(r => !cutoff || !r.date || r.date < cutoff)
//
// which fails open twice:
//
//   1. NO CUTOFF MEANS NO FILTER. When the audited match carries no scheduled_date, the
//      context string contains no date token, `cutoff` is null, and the entire history --
//      including every match played AFTER the audited one -- flows into the metric. The
//      audit then reports the player's CURRENT state as if it were their state at the
//      match. Proven against the live dataset: with a date the producer correctly returned
//      nothing for a player with no prior matches; with the date removed it returned a
//      current Elo of 1568.71 and a last-10 win rate. 1 of the 55 live matches has a null
//      scheduled_date, so this was reachable in production.
//
//   2. AN UNDATED ROW IS ALWAYS INCLUDED. A row with no date cannot be shown to precede
//      the match, so admitting it asserts something the evidence does not support.
//
// The rule this module enforces instead: evidence is admissible only when it can be PROVEN
// to precede the audited match. If the boundary itself cannot be established, the honest
// answer is no evidence -- which surfaces as UNAVAILABLE -- never all evidence.

/**
 * The audited match's date, parsed from the pipeline's context string
 * ("tournament X · date 2024-05-02 · surface clay"). Null means the boundary could not be
 * established, which callers must treat as "no admissible evidence", never as "no filter".
 */
export function auditCutoff(context: string): string | null {
  return context.match(/(?:date\s+)?(20\d{2}-\d{2}-\d{2})/i)?.[1] ?? null;
}

/**
 * True only when `rowDate` is present and strictly before the boundary. Strictly before,
 * not on-or-before: a match played on the audited day is not information available for
 * predicting that day's match. A missing date returns false -- unprovable is not admissible.
 */
export function isBeforeCutoff(rowDate: string | null | undefined, cutoff: string): boolean {
  return typeof rowDate === "string" && rowDate.length > 0 && rowDate < cutoff;
}

/** True when `rowDate` is present and at or before the boundary (for opponent-state lookups). */
export function isAtOrBeforeCutoff(rowDate: string | null | undefined, cutoff: string): boolean {
  return typeof rowDate === "string" && rowDate.length > 0 && rowDate <= cutoff;
}
