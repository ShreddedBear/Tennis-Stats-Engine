/**
 * Shared read accessor for wta_main_pbp_evidence (Prediction Engine + Parlay Builder,
 * see lib/db/src/schema/wtaMainPbpEvidence.ts for why this table -- and only this
 * table -- is exempt from the Parlay Builder / Prediction Engine isolation boundary
 * checkParlayBoundary.ts enforces).
 *
 * Ground-truth evidence only, one-way synced from tennis-truth-engine
 * (scripts/syncWtaMainPbpEvidence.ts). Truth Engine's own audit verdicts/decisions
 * are never synced here and must never be read through this or any other path --
 * that boundary is what keeps a prediction from being built out of the Truth
 * Engine's own conclusion about the same match.
 *
 * LICENSE: NONCOMMERCIAL_ONLY -- see licenseStatus on each row and
 * tennis-truth-engine's docs/WTA_MAIN_HISTORICAL_PBP_ATTRIBUTION.md before using
 * this in a commercial/monetized code path.
 */
import { and, or, sql } from "drizzle-orm";
import { db, wtaMainPbpEvidenceTable, type WtaMainPbpEvidence } from "@workspace/db";

const norm = (v: string) => v.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * All approved WTA Main PBP evidence for a given player pair, strictly before
 * `beforeDate` (exclusive -- a match's own PBP is never its own evidence). Order
 * is not guaranteed; sort by eventDate yourself if you need chronological order.
 */
export async function getWtaMainPbpEvidenceForPair(p1: string, p2: string, beforeDate?: string): Promise<WtaMainPbpEvidence[]> {
  const p1n = norm(p1), p2n = norm(p2);
  const rows = await db.select().from(wtaMainPbpEvidenceTable).where(
    or(
      and(sql`lower(${wtaMainPbpEvidenceTable.player1Name}) = ${p1n}`, sql`lower(${wtaMainPbpEvidenceTable.player2Name}) = ${p2n}`),
      and(sql`lower(${wtaMainPbpEvidenceTable.player1Name}) = ${p2n}`, sql`lower(${wtaMainPbpEvidenceTable.player2Name}) = ${p1n}`),
    ),
  );
  const filtered = beforeDate ? rows.filter((r) => (r.eventDate ?? "") !== "" && r.eventDate! < beforeDate) : rows;
  return filtered;
}

/** All approved WTA Main PBP evidence involving a single player, strictly before `beforeDate`. */
export async function getWtaMainPbpEvidenceForPlayer(player: string, beforeDate?: string): Promise<WtaMainPbpEvidence[]> {
  const pn = norm(player);
  const rows = await db.select().from(wtaMainPbpEvidenceTable).where(
    or(sql`lower(${wtaMainPbpEvidenceTable.player1Name}) = ${pn}`, sql`lower(${wtaMainPbpEvidenceTable.player2Name}) = ${pn}`),
  );
  const filtered = beforeDate ? rows.filter((r) => (r.eventDate ?? "") !== "" && r.eventDate! < beforeDate) : rows;
  return filtered;
}

export async function wtaMainPbpEvidenceRowCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(wtaMainPbpEvidenceTable);
  return row?.count ?? 0;
}
