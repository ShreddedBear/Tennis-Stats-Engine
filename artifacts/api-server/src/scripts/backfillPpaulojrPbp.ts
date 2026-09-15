// CLI entry point for the ppaulojr PBP backfill pipeline.
// Usage: pnpm --filter @workspace/api-server exec tsx src/scripts/backfillPpaulojrPbp.ts --tour ATP
//
// Idempotent: every row is upserted on (source, sourceRecordId), so running this twice (or
// resuming after a crash) never creates duplicate pbp_matches rows -- see
// lib/db/src/schema/pbp.ts's uniqueIndex. Each candidate row is independently identity-resolved
// against historical_matches before insert (never a raw-name guess); ambiguous/unmatched rows are
// still recorded (with identityStatus NO_MATCH/AMBIGUOUS) so they remain auditable, but they are
// never attached to a canonicalMatchId unless resolution was unique.
import { and, eq, gte, lte } from "drizzle-orm";
import { db, historicalMatchesTable, pbpMatchesTable, pool } from "@workspace/db";
import { PpaulojrPbpSource } from "../services/pbp/sources/ppaulojrSource";
import { resolvePbpMatchIdentity, type CandidateHistoricalMatch } from "../services/pbp/identity";
import { deriveStatsFromPbp } from "../services/pbp/derive";
import { normalizePlayerName } from "../services/tennisData/playerIdentity";
import type { PbpTour } from "../services/pbp/types";

const SUPPORTED_TOURS: PbpTour[] = ["ATP", "WTA", "Challenger", "ITF", "Futures"];
const DATE_WINDOW_DAYS = 2;

function parseArgs(argv: string[]): { tours: PbpTour[]; dryRun: boolean } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const tourArg = get("--tour");
  const tours = tourArg
    ? (tourArg.split(",").map((t) => t.trim()) as PbpTour[])
    : SUPPORTED_TOURS;
  for (const t of tours) {
    if (!SUPPORTED_TOURS.includes(t)) {
      throw new Error(`Unsupported --tour "${t}". Supported: ${SUPPORTED_TOURS.join(", ")}`);
    }
  }
  return { tours, dryRun: argv.includes("--dry-run") };
}

async function loadCandidatesForDate(date: string): Promise<CandidateHistoricalMatch[]> {
  const target = new Date(`${date}T00:00:00Z`);
  const from = new Date(target.getTime() - DATE_WINDOW_DAYS * 86_400_000);
  const to = new Date(target.getTime() + DATE_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      id: historicalMatchesTable.id,
      player1Name: historicalMatchesTable.player1Name,
      player2Name: historicalMatchesTable.player2Name,
      tournamentName: historicalMatchesTable.tournamentName,
      scheduledStartAt: historicalMatchesTable.scheduledStartAt,
      surface: historicalMatchesTable.surface,
      round: historicalMatchesTable.round,
    })
    .from(historicalMatchesTable)
    .where(and(gte(historicalMatchesTable.scheduledStartAt, from), lte(historicalMatchesTable.scheduledStartAt, to)));
  return rows.map((r) => ({ ...r, scheduledStartAt: r.scheduledStartAt.toISOString() }));
}

interface TourSummary {
  tour: PbpTour;
  rowsSeen: number;
  malformed: number;
  matched: number;
  noMatch: number;
  ambiguous: number;
  inserted: number;
  alreadyPresent: number;
}

async function backfillTour(tour: PbpTour, dryRun: boolean): Promise<TourSummary> {
  const source = new PpaulojrPbpSource();
  const summary: TourSummary = { tour, rowsSeen: 0, malformed: 0, matched: 0, noMatch: 0, ambiguous: 0, inserted: 0, alreadyPresent: 0 };
  const candidateCacheByDate = new Map<string, CandidateHistoricalMatch[]>();

  for await (const record of source.bulkFetch(tour)) {
    summary.rowsSeen += 1;

    const existing = await db
      .select({ id: pbpMatchesTable.id })
      .from(pbpMatchesTable)
      .where(and(eq(pbpMatchesTable.source, record.source), eq(pbpMatchesTable.sourceRecordId, record.sourceRecordId)))
      .limit(1);
    if (existing[0]) {
      summary.alreadyPresent += 1;
      continue;
    }

    let candidates = candidateCacheByDate.get(record.date);
    if (!candidates) {
      candidates = await loadCandidatesForDate(record.date);
      candidateCacheByDate.set(record.date, candidates);
    }

    const identity = resolvePbpMatchIdentity(
      { player1Name: record.server1, player2Name: record.server2, date: record.date, tournamentName: record.tournamentName },
      candidates,
    );
    if (identity.status === "MATCHED") summary.matched += 1;
    else if (identity.status === "AMBIGUOUS") summary.ambiguous += 1;
    else summary.noMatch += 1;

    const derived = deriveStatsFromPbp({
      raw: record.pbp,
      sourceRecordId: record.sourceRecordId,
      server1IsPlayer1: true,
      adfFlag: record.adfFlag,
    });
    if (!derived) summary.malformed += 1;

    if (dryRun) continue;

    await db
      .insert(pbpMatchesTable)
      .values({
        canonicalMatchId: identity.canonicalMatchId,
        identityStatus: identity.status,
        identityReason: identity.reason,
        round: null,
        source: record.source,
        sourceRecordId: record.sourceRecordId,
        date: record.date,
        tour: record.tour,
        tournamentName: record.tournamentName,
        draw: record.draw,
        player1Name: record.server1,
        player2Name: record.server2,
        winner: record.winner,
        score: record.score,
        rawPbp: record.pbp,
        validationStatus: record.validationStatus,
        provenanceNote: record.provenanceNote,
        derivedStats: derived,
        rawSource: record.rawPayload ?? null,
      })
      .onConflictDoNothing({ target: [pbpMatchesTable.source, pbpMatchesTable.sourceRecordId] });
    summary.inserted += 1;
  }

  return summary;
}

async function main(): Promise<void> {
  const { tours, dryRun } = parseArgs(process.argv.slice(2));
  const results: TourSummary[] = [];
  for (const tour of tours) {
    console.log(`[backfillPpaulojrPbp] ${tour}${dryRun ? " (dry run)" : ""}...`);
    results.push(await backfillTour(tour, dryRun));
  }
  console.log(JSON.stringify(results, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
