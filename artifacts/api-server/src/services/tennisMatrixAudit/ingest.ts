// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — summary ingestion.
//
// Turns an uploaded summary PDF into match rows the Audit can run against. Two steps,
// deliberately separate, because the person uploading has to be able to SEE what was
// detected before any of it becomes a match:
//
//   extractMatchups()  — read the PDF, parse matchups. Writes nothing.
//   commitMatchups()   — persist reviewed matchups as matches + summary versions + fields.
//
// MATCH IDENTITY is the whole point of the commit step. The same real match uploaded twice
// must resolve to the SAME match row, and two genuinely different matches must never merge.
// That is what canonicalKey (from the engine package) and the reuse search below exist for;
// getting it wrong in either direction is a data-integrity failure, not a UX annoyance.
// ----------------------------------------------------------------------------
import { canonicalKey, parseSummaryText, type ParsedMatchup } from "@workspace/truth-engine";
import { LOCAL_WORKSPACE_ID } from "@workspace/truth-engine";
import { pool } from "@workspace/db";
import { compatible, dedupeMatchups, fieldValue, nameTokens, samePair } from "./ingest-identity.js";

export interface ExtractedPdf {
  filename: string;
  pages: string[];
  matchups: ParsedMatchup[];
}

/**
 * Server-side PDF text extraction. Runs here rather than in the browser so ingestion needs
 * no heavyweight client bundle and so the parse that decides match identity happens in one
 * place. pdfjs is imported lazily: it is large, and only this path uses it.
 */
export async function extractMatchups(filename: string, base64: string): Promise<ExtractedPdf> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = content.items as Array<{ str?: string; transform?: number[] }>;
      // Group text items into lines by their y position: the parser reads line-oriented
      // blocks, and pdfjs emits positioned fragments rather than lines.
      let lastY: number | null = null;
      let line = "";
      const lines: string[] = [];
      for (const item of items) {
        const y = item.transform?.[5] ?? null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          if (line.trim()) lines.push(line.trim());
          line = "";
        }
        line += `${item.str ?? ""} `;
        lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.join("\n"));
    }

    return { filename, pages, matchups: dedupeMatchups(parseSummaryText(pages)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF text extraction failed for ${filename || "uploaded PDF"}: ${message}`);
  }
}

/**
 * Find an existing match row this parse describes, or null.
 *
 * Exact canonical key first. Failing that, a same-pair row whose context does not
 * CONTRADICT this parse -- because an earlier upload may have captured the tournament or
 * date that this one missed, and creating a second row for it would split one real match
 * in two. The final clause is the deliberately narrow case: exactly one same-pair row
 * exists and neither side carries contradicting context.
 */
async function findReusableMatch(matchup: ParsedMatchup, key: string): Promise<Record<string, unknown> | null> {
  const exact = await pool.query(`select * from matches where canonical_key = $1 limit 1`, [key]);
  if (exact.rows.length) return exact.rows[0] as Record<string, unknown>;

  const candidates = await pool.query(`select * from matches order by created_at desc limit 500`);
  const date = fieldValue(matchup, "scheduled_date");
  const tournament = fieldValue(matchup, "tournament");
  const round = fieldValue(matchup, "round");

  const pairMatches = (candidates.rows as Array<Record<string, unknown>>).filter((row) =>
    samePair(String(row["player1_name"] ?? ""), String(row["player2_name"] ?? ""), matchup.player1_name, matchup.player2_name),
  );
  const contextual = pairMatches.find(
    (row) =>
      compatible(row["scheduled_date"] as string, date) &&
      compatible(row["tournament_name"] as string, tournament) &&
      compatible(row["round"] as string, round),
  );
  if (contextual) return contextual;

  const only = pairMatches[0];
  if (pairMatches.length === 1 && only && (!date || !only["scheduled_date"]) && (!tournament || !only["tournament_name"])) {
    return only;
  }
  return null;
}

export interface CommitSummary {
  created: number;
  reused: number;
  versions: number;
  matchIds: string[];
  errors: Array<{ match: string; message: string }>;
}

export async function commitMatchups(files: ExtractedPdf[]): Promise<CommitSummary> {
  const summary: CommitSummary = { created: 0, reused: 0, versions: 0, matchIds: [], errors: [] };
  const user_id = LOCAL_WORKSPACE_ID;

  for (const file of files) {
    const upload = await pool.query(
      `insert into summary_uploads (user_id, filename, page_count, parse_status, raw_text)
       values ($1, $2, $3, 'COMPLETE', $4) returning id`,
      [user_id, file.filename, file.pages.length, file.pages.join("\n\f\n")],
    );
    const uploadId = (upload.rows[0] as { id: string }).id;

    for (const matchup of dedupeMatchups(file.matchups)) {
      const label = `${matchup.player1_name} vs ${matchup.player2_name}`;
      try {
        const key = canonicalKey({
          tournament: fieldValue(matchup, "tournament") || null,
          round: fieldValue(matchup, "round") || null,
          date: fieldValue(matchup, "scheduled_date") || null,
          p1: matchup.player1_name,
          p2: matchup.player2_name,
        });
        const existing = await findReusableMatch(matchup, key);
        let matchId = existing ? String(existing["id"]) : null;

        if (existing) {
          summary.reused += 1;
          // Enrich, never downgrade: a fuller name or a context field this row lacked is
          // taken; a value the row already has is not overwritten by a blank.
          const patch: Record<string, unknown> = {};
          if (nameTokens(matchup.player1_name).length > nameTokens(String(existing["player1_name"] ?? "")).length) {
            patch["player1_name"] = matchup.player1_name;
          }
          if (nameTokens(matchup.player2_name).length > nameTokens(String(existing["player2_name"] ?? "")).length) {
            patch["player2_name"] = matchup.player2_name;
          }
          for (const [column, parsed] of [
            ["tournament_name", fieldValue(matchup, "tournament")],
            ["event_level", fieldValue(matchup, "event_level")],
            ["round", fieldValue(matchup, "round")],
            ["scheduled_date", fieldValue(matchup, "scheduled_date")],
            ["surface", fieldValue(matchup, "surface")],
          ] as const) {
            if (parsed && parsed !== existing[column]) patch[column] = parsed;
          }
          const bestOf = Number(fieldValue(matchup, "best_of"));
          if (bestOf && bestOf !== existing["best_of"]) patch["best_of"] = bestOf;

          if (Object.keys(patch).length) {
            const columns = Object.keys(patch);
            const assignments = columns.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
            await pool.query(`update matches set ${assignments} where id = $${columns.length + 1}`, [
              ...columns.map((c) => patch[c]),
              matchId,
            ]);
          }
        } else {
          const inserted = await pool.query(
            `insert into matches (user_id, canonical_key, player1_name, player2_name, tournament_name,
                                  event_level, round, scheduled_date, surface, best_of)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
            [
              user_id, key, matchup.player1_name, matchup.player2_name,
              fieldValue(matchup, "tournament") || null,
              fieldValue(matchup, "event_level") || null,
              fieldValue(matchup, "round") || null,
              fieldValue(matchup, "scheduled_date") || null,
              fieldValue(matchup, "surface") || null,
              Number(fieldValue(matchup, "best_of")) || null,
            ],
          );
          matchId = (inserted.rows[0] as { id: string }).id;
          summary.created += 1;
        }

        if (!matchId) throw new Error("Match row was not created or reused");

        // Exactly one ACTIVE summary version per match: the active version is what defines
        // slate membership, so a new upload must retire the previous one rather than
        // leaving two rows both claiming to be current.
        const prior = await pool.query(
          `select id, version_number from summary_versions where match_id = $1 order by version_number desc`,
          [matchId],
        );
        if (prior.rows.length) {
          await pool.query(`update summary_versions set is_active = false where match_id = $1`, [matchId]);
        }
        const nextVersion = Number((prior.rows[0] as { version_number?: number } | undefined)?.version_number ?? 0) + 1;
        const version = await pool.query(
          `insert into summary_versions (user_id, match_id, upload_id, version_number, page_number, is_active)
           values ($1,$2,$3,$4,$5,true) returning id`,
          [user_id, matchId, uploadId, nextVersion, matchup.page_number],
        );
        const versionId = (version.rows[0] as { id: string }).id;
        summary.versions += 1;

        await pool.query(`update matches set active_summary_version_id = $1, canonical_key = $2 where id = $3`, [
          versionId, key, matchId,
        ]);

        for (const field of matchup.fields) {
          await pool.query(
            `insert into parsed_summary_fields
               (user_id, summary_version_id, field_key, raw_value, normalized_value, extraction_status, confidence, page_number)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [user_id, versionId, field.field_key, field.raw_value, field.normalized_value, field.extraction_status, field.confidence, field.page_number],
          );
        }

        await pool.query(
          `insert into execution_logs (user_id, match_id, stage, status, output, matrix_visible)
           values ($1,$2,'SUMMARY PDF INGESTION','COMPLETE',$3,false)`,
          [user_id, matchId, JSON.stringify({ file: file.filename, page: matchup.page_number })],
        );

        summary.matchIds.push(matchId);
      } catch (error) {
        // One bad matchup must not abandon the rest of the upload; it is reported instead.
        summary.errors.push({ match: label, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return summary;
}
