// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — importing verified match results, and grading against them.
//
// A verified-winners document says who actually won. Recording that is what lets the slate
// show which selections were right and which were wrong -- but it is also the one place
// where an over-eager import would quietly corrupt the record, so the rules here are strict:
//
//   * a row whose winner is "NOT VERIFIED" (or blank) records NOTHING. An unknown result is
//     not a result, and writing one would turn a gap into a false fact.
//   * a row whose stated winner is not unambiguously one of the two named players is
//     REPORTED, not resolved. The source document contains at least one such row, and
//     guessing which player was meant is exactly how a wrong winner enters the record.
//   * grading itself is never done here. It is delegated to the engine's own
//     resolvePredictionOutcome, which already refuses to grade an unselected match, an
//     unknown result, or an ambiguous name -- so the colours on the slate can never disagree
//     with the engine about who won.
// ----------------------------------------------------------------------------
import { pool } from "@workspace/db";
import { matchSideForName, normalizeName, playerNamesMatch } from "@workspace/truth-engine";

/** One row of a verified-results document. */
export interface VerifiedResultRow {
  player1: string;
  player2: string;
  winner: string | null;
  date: string | null;
  event: string | null;
}

export interface ParsedResultsDocument {
  rows: VerifiedResultRow[];
  /** Rows the document itself marks as having no confirmed winner. */
  unverified: VerifiedResultRow[];
  /** Rows whose stated winner matches neither named player -- reported, never guessed. */
  inconsistent: Array<VerifiedResultRow & { problem: string }>;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/** "September 13, 2026" -> "2026-09-13". Returns null rather than a guessed date. */
export function parseDocumentDate(raw: string): string | null {
  const match = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : null;
  const month = MONTHS[match[1]!.toLowerCase()];
  return month ? `${match[3]}-${month}-${match[2]!.padStart(2, "0")}` : null;
}


/**
 * Whether two names share a surname but disagree on a given name that BOTH state. Returns
 * the conflicting pair, or null when there is no conflict -- which includes the ordinary
 * case of one name simply being shorter ("Sinner" vs "Jannik Sinner").
 */
function givenNameConflict(a: string, b: string): string | null {
  const left = normalizeName(a).split(" ").filter(Boolean);
  const right = normalizeName(b).split(" ").filter(Boolean);
  if (left.length < 2 || right.length < 2) return null;
  if (left[left.length - 1] !== right[right.length - 1]) return null;
  const leftGiven = left.slice(0, -1);
  const rightGiven = right.slice(0, -1);
  // A conflict only when neither side's given names appear in the other's at all: an added
  // middle name or a reordering is not a contradiction.
  const overlap = leftGiven.some((token) => rightGiven.includes(token));
  return overlap ? null : `"${leftGiven.join(" ")}" vs "${rightGiven.join(" ")}"`;
}

const UNVERIFIED = /^(not verified|unverified|unknown|tbd|n\/a|-|—)$/i;

/**
 * Parse the verified-winners table out of extracted PDF text.
 *
 * Each data row reads "P1 vs P2 <date> <winner> <event>", with runs of whitespace between
 * the columns. The split is anchored on the date, which is the only field with a fixed
 * shape -- keying on "vs" alone would break on any player whose name contains it.
 */
export function parseVerifiedResults(pages: string[]): ParsedResultsDocument {
  const rows: VerifiedResultRow[] = [];
  const unverified: VerifiedResultRow[] = [];
  const inconsistent: ParsedResultsDocument["inconsistent"] = [];

  const datePattern = /\s{2,}([A-Za-z]+\s+\d{1,2},\s*\d{4})\s{2,}/;

  for (const page of pages) {
    for (const line of page.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || /^Match\s/i.test(text)) continue;
      const dateMatch = text.match(datePattern);
      if (!dateMatch) continue;

      const before = text.slice(0, dateMatch.index!).trim();
      const after = text.slice(dateMatch.index! + dateMatch[0].length).trim();
      const versus = before.split(/\s+vs\.?\s+/i);
      if (versus.length !== 2) continue;

      // The remainder is "<winner>  <event>"; the event begins at the wide gap.
      const tail = after.split(/\s{2,}/);
      const winnerRaw = (tail[0] ?? "").trim();
      const event = tail.slice(1).join(" ").trim() || null;

      const row: VerifiedResultRow = {
        player1: versus[0]!.trim(),
        player2: versus[1]!.trim(),
        winner: UNVERIFIED.test(winnerRaw) ? null : winnerRaw || null,
        date: parseDocumentDate(dateMatch[1]!),
        event,
      };

      if (!row.winner) { unverified.push(row); continue; }

      // The stated winner must be one of the two players. Anything else is a defect in the
      // source that a person has to settle -- never something to resolve by proximity.
      const side = matchSideForName(row.winner, { player1_name: row.player1, player2_name: row.player2 });
      if (!side) {
        inconsistent.push({ ...row, problem: `Stated winner "${row.winner}" matches neither "${row.player1}" nor "${row.player2}".` });
        continue;
      }
      // A surname match is not enough on its own. The engine's name comparison is
      // deliberately surname-tolerant so "M. Zverev" resolves to "Mischa Zverev" -- but that
      // same tolerance accepts "Stefanos Sakellaridis" as the winner of a match listed
      // against "Dimitris Sakellaridis", which the document itself contradicts. Where both
      // names carry a given name and the given names DISAGREE, the source is inconsistent
      // and a person has to settle it.
      const matched = side === "P1" ? row.player1 : row.player2;
      const conflict = givenNameConflict(row.winner, matched);
      if (conflict) {
        inconsistent.push({ ...row, problem: `Stated winner "${row.winner}" shares a surname with "${matched}" but the given names differ (${conflict}). The document contradicts itself, so no result was recorded.` });
        continue;
      }
      rows.push(row);
    }
  }
  return { rows, unverified, inconsistent };
}

export interface ImportSummary {
  parsed: number;
  unverified: number;
  inconsistent: Array<{ match: string; problem: string }>;
  matched: number;
  updated: number;
  unmatched: Array<{ match: string; reason: string }>;
}

/**
 * Write verified winners onto the matches they identify.
 *
 * A row is applied only when it identifies exactly ONE match on the slate. Zero matches
 * means the audit never covered it; more than one means the pairing is ambiguous and
 * applying it could write the result onto the wrong match. Both are reported, not resolved.
 */
export async function importVerifiedResults(document: ParsedResultsDocument): Promise<ImportSummary> {
  const summary: ImportSummary = {
    parsed: document.rows.length,
    unverified: document.unverified.length,
    inconsistent: document.inconsistent.map((row) => ({ match: `${row.player1} vs ${row.player2}`, problem: row.problem })),
    matched: 0, updated: 0, unmatched: [],
  };

  const { rows: matches } = await pool.query(
    `select id, player1_name, player2_name, scheduled_date, actual_winner, result_status from matches`,
  );

  for (const row of document.rows) {
    const label = `${row.player1} vs ${row.player2}`;
    // Pair equality uses the engine's own name comparison, so the import agrees with the
    // rest of the system about when two spellings are the same player.
    const candidates = (matches as Array<Record<string, unknown>>).filter((match) => {
      const a = String(match["player1_name"] ?? "");
      const b = String(match["player2_name"] ?? "");
      const forward = playerNamesMatch(a, row.player1) && playerNamesMatch(b, row.player2);
      const reversed = playerNamesMatch(a, row.player2) && playerNamesMatch(b, row.player1);
      if (!forward && !reversed) return false;
      // When the document carries a date, it must not contradict the match's own.
      const scheduled = match["scheduled_date"] ? String(match["scheduled_date"]).slice(0, 10) : null;
      return !row.date || !scheduled || row.date === scheduled;
    });

    if (candidates.length === 0) { summary.unmatched.push({ match: label, reason: "No match on the slate corresponds to this row." }); continue; }
    if (candidates.length > 1) { summary.unmatched.push({ match: label, reason: `${candidates.length} slate matches share this pairing; the row is ambiguous and was not applied.` }); continue; }

    summary.matched += 1;
    const target = candidates[0]!;
    // The winner is stored in the SLATE's spelling of that player, so every downstream
    // comparison sees one canonical name rather than the document's variant.
    const side = matchSideForName(row.winner, {
      player1_name: String(target["player1_name"] ?? ""),
      player2_name: String(target["player2_name"] ?? ""),
    });
    if (!side) { summary.unmatched.push({ match: label, reason: `Stated winner "${row.winner}" does not identify a side of the slate match.` }); continue; }
    const canonicalWinner = String(target[side === "P1" ? "player1_name" : "player2_name"]);

    await pool.query(
      `update matches set actual_winner = $1, result_status = 'FINAL' where id = $2`,
      [canonicalWinner, target["id"]],
    );
    summary.updated += 1;
  }
  return summary;
}

/** Normalised-name helper kept for callers that need the document's own spelling compared. */
export const sameName = (a: string, b: string) => normalizeName(a) === normalizeName(b);
