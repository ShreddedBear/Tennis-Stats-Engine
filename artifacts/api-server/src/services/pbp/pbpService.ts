import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, historicalMatchesTable, pbpMatchesTable, type PbpMatchRow } from "@workspace/db";
import { resolvePbpMatchIdentity, type CandidateHistoricalMatch } from "./identity";
import { PbpSourceRouter } from "./sourceRouter";
import { PpaulojrPbpSource } from "./sources/ppaulojrSource";
import type {
  CanonicalPbpLookup,
  PbpDerivedStats,
  PbpIdentityStatus,
  PbpSource,
  PbpValidationStatus,
} from "./types";

/**
 * Registered PBP sources, in priority order. Adding a future source (Sackmann, Sportradar, a
 * commercial provider, verified internal PBP) means implementing `PbpSource` and adding one line
 * here — no engine code changes required, per docs/pbp-source-policy.md.
 */
let registeredSources: PbpSource[] | null = null;
function getSources(): PbpSource[] {
  if (!registeredSources) registeredSources = [new PpaulojrPbpSource()];
  return registeredSources;
}

/** Test-only hook so unit tests can inject fake sources without touching module-level state elsewhere. */
export function __setSourcesForTesting(sources: PbpSource[] | null): void {
  registeredSources = sources;
}

export type PbpAvailability = "AVAILABLE" | "PBP_UNAVAILABLE" | "IDENTITY_AMBIGUOUS" | "PBP_CONFLICT" | "SOURCE_ERROR";

export interface PbpServiceResult {
  availability: PbpAvailability;
  source: string | null;
  sourceRecordId: string | null;
  validationStatus: PbpValidationStatus | null;
  identityStatus: PbpIdentityStatus;
  canonicalMatchId: number | null;
  provenanceNote: string | null;
  rawPbp: string | null;
  derived: PbpDerivedStats | null;
  /** True only when `derived.player1/player2` fields are already oriented to match the caller's player1/player2 — false means the caller must swap sides before use. Null when unavailable. */
  orientationMatchesLookup: boolean | null;
  attemptedSources: string[];
  rejectedSources: Array<{ source: string; reason: string }>;
  conflict: { sources: string[]; detail: string } | null;
}

const DATE_WINDOW_DAYS = 2;

async function loadCandidates(lookup: CanonicalPbpLookup): Promise<CandidateHistoricalMatch[]> {
  const target = new Date(`${lookup.date}T00:00:00Z`);
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

async function loadSingleCandidate(canonicalMatchId: number): Promise<CandidateHistoricalMatch | null> {
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
    .where(eq(historicalMatchesTable.id, canonicalMatchId))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, scheduledStartAt: row.scheduledStartAt.toISOString() } : null;
}

function rowToResult(row: PbpMatchRow): PbpServiceResult {
  const derived = (row.derivedStats as PbpDerivedStats | null) ?? null;
  let availability: PbpAvailability = "AVAILABLE";
  if (row.identityStatus === "AMBIGUOUS") availability = "IDENTITY_AMBIGUOUS";
  else if (row.validationStatus === "CONFLICT") availability = "PBP_CONFLICT";

  return {
    availability,
    source: row.source,
    sourceRecordId: row.sourceRecordId,
    validationStatus: row.validationStatus as PbpValidationStatus,
    identityStatus: row.identityStatus as PbpIdentityStatus,
    canonicalMatchId: row.canonicalMatchId,
    provenanceNote: row.provenanceNote,
    rawPbp: row.rawPbp,
    derived,
    orientationMatchesLookup: row.player1Id !== null ? true : null,
    attemptedSources: [row.source],
    rejectedSources: [],
    conflict: row.conflictDetail ? { sources: row.corroboratedBy ?? [], detail: row.conflictDetail } : null,
  };
}

function unavailableResult(attemptedSources: string[], rejectedSources: Array<{ source: string; reason: string }>, availability: PbpAvailability = "PBP_UNAVAILABLE"): PbpServiceResult {
  return {
    availability,
    source: null,
    sourceRecordId: null,
    validationStatus: null,
    identityStatus: "NO_MATCH",
    canonicalMatchId: null,
    provenanceNote: null,
    rawPbp: null,
    derived: null,
    orientationMatchesLookup: null,
    attemptedSources,
    rejectedSources,
    conflict: null,
  };
}

/**
 * The one entrypoint every consumer (Truth Engine, Stats/Prediction Engine, Parlay Builder) must
 * use for PBP — no engine may call a `PbpSource` adapter directly. Checks the durable store first
 * (idempotent — a second call for the same match never re-fetches or re-inserts), then falls back
 * to the source router, resolves canonical identity, persists, and returns one normalized result.
 *
 * Never throws for an ordinary "no PBP"/"ambiguous"/"conflict" outcome — those are represented in
 * `availability` so a failed PBP lookup can never crash the caller's prediction pathway. Only a
 * genuine infra error (e.g. the database itself unreachable) propagates as a rejected promise,
 * which is a `SOURCE_ERROR` case belongs at the caller's http/job boundary, not silently swallowed.
 */
export async function getPbpForMatch(lookup: CanonicalPbpLookup): Promise<PbpServiceResult> {
  const existing = await db
    .select()
    .from(pbpMatchesTable)
    .where(
      lookup.canonicalMatchId != null
        ? eq(pbpMatchesTable.canonicalMatchId, lookup.canonicalMatchId)
        : and(eq(pbpMatchesTable.player1Name, lookup.player1Name), eq(pbpMatchesTable.player2Name, lookup.player2Name), eq(pbpMatchesTable.date, lookup.date)),
    )
    .limit(1);

  if (existing[0]) return rowToResult(existing[0]);

  const router = new PbpSourceRouter(getSources());
  const resolution = await router.resolve({
    player1Name: lookup.player1Name,
    player2Name: lookup.player2Name,
    date: lookup.date,
    tournamentName: lookup.tournamentName ?? null,
    tour: lookup.tour ?? null,
  });

  if (resolution.conflict) {
    return { ...unavailableResult(resolution.attemptedSources, resolution.rejectedSources, "PBP_CONFLICT"), conflict: resolution.conflict };
  }
  if (!resolution.result) {
    return unavailableResult(resolution.attemptedSources, resolution.rejectedSources);
  }

  const candidates = lookup.canonicalMatchId != null
    ? [await loadSingleCandidate(lookup.canonicalMatchId)].filter((c): c is CandidateHistoricalMatch => c !== null)
    : await loadCandidates(lookup);

  const identity = resolvePbpMatchIdentity(lookup, candidates);

  const { record, derived } = resolution.result;
  const [inserted] = await db
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
      player1Name: lookup.player1Name,
      player2Name: lookup.player2Name,
      winner: record.winner,
      score: record.score,
      rawPbp: record.pbp,
      validationStatus: record.validationStatus,
      provenanceNote: record.provenanceNote,
      derivedStats: derived,
      rawSource: record.rawPayload ?? null,
    })
    .onConflictDoUpdate({
      target: [pbpMatchesTable.source, pbpMatchesTable.sourceRecordId],
      set: { updatedAt: sql`now()` },
    })
    .returning();

  const result = rowToResult(inserted);
  result.attemptedSources = resolution.attemptedSources;
  result.rejectedSources = resolution.rejectedSources;
  result.orientationMatchesLookup = identity.orientationMatchesLookup;
  if (identity.status === "AMBIGUOUS") result.availability = "IDENTITY_AMBIGUOUS";
  return result;
}

export interface PbpStatusAnswer {
  hasPbp: boolean;
  source: string | null;
  validationStatus: PbpValidationStatus | null;
  corroborated: boolean;
  corroboratedBy: string[];
  conflict: boolean;
  conflictDetail: string | null;
}

/** Truth-Engine-facing question set: do we have PBP, where from, has it been corroborated, does another source disagree. */
export async function getPbpStatus(lookup: CanonicalPbpLookup): Promise<PbpStatusAnswer> {
  const result = await getPbpForMatch(lookup);
  return {
    hasPbp: result.availability === "AVAILABLE",
    source: result.source,
    validationStatus: result.validationStatus,
    corroborated: result.validationStatus === "CORROBORATED" || result.validationStatus === "VERIFIED",
    corroboratedBy: result.conflict?.sources.filter((s) => s !== result.source) ?? [],
    conflict: result.availability === "PBP_CONFLICT",
    conflictDetail: result.conflict?.detail ?? null,
  };
}

export function getPbpSources(): Array<{ name: string; priority: number; enabled: boolean; validationStatus: PbpValidationStatus }> {
  return getSources().map((s) => ({ name: s.name, priority: s.priority, enabled: s.enabled, validationStatus: s.validationStatus }));
}

export async function getPbpDerivedStats(lookup: CanonicalPbpLookup): Promise<PbpDerivedStats | null> {
  const result = await getPbpForMatch(lookup);
  return result.derived;
}
