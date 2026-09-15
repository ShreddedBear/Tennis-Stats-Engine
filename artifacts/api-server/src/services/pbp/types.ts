export type PbpTour = "ATP" | "WTA" | "Challenger" | "ITF" | "Futures" | "Other";

export type PbpValidationStatus =
  | "VERIFIED"
  | "CORROBORATED"
  | "CANDIDATE"
  | "CONFLICT"
  | "REVIEW_REQUIRED";

/**
 * Whether the raw record was successfully attached to a real canonical match, distinct from
 * `PbpValidationStatus` (which is about how trustworthy the PBP content itself is). A record can
 * be identity-MATCHED but still validation-CANDIDATE (attached to the right match, content not
 * yet corroborated), or identity-AMBIGUOUS with no validation status at all (we don't know which
 * match, so we can't even ask whether the content is trustworthy). Never "guessed" — an ambiguous
 * or absent identity match always resolves to NO_MATCH/REVIEW_REQUIRED/AMBIGUOUS, never a pick.
 */
export type PbpIdentityStatus = "MATCHED" | "NO_MATCH" | "AMBIGUOUS" | "REVIEW_REQUIRED";

export interface PointByPointRecord {
  source: string;
  sourceRecordId: string;
  date: string;
  tournamentName: string | null;
  tour: PbpTour;
  draw: "Main" | "Qualifying" | null;
  server1: string;
  server2: string;
  winner: 1 | 2;
  pbp: string;
  score: string | null;
  adfFlag: 0 | 1 | null;
  validationStatus: PbpValidationStatus;
  provenanceNote: string | null;
  /** Original, un-normalized payload from the source (e.g. the raw CSV row) — retained verbatim for audit/reproducibility, never destroyed. Null only for a source that has no separate raw shape to keep. */
  rawPayload: unknown;
}

/** Raw-name lookup used by individual source adapters, which only ever see a provider's own names. */
export interface PbpLookup {
  player1Name: string;
  player2Name: string;
  date?: string | null;
  tournamentName?: string | null;
  tour?: PbpTour | null;
}

/**
 * Canonical lookup used by the central PBP service's public entrypoint. Callers identify a match
 * by its `historical_matches` row (preferred, unambiguous) or by canonical player/date/tournament
 * fields when no such row exists yet (e.g. a match still only known via the ppaulojr identity
 * pass). The service resolves this into provider-shaped `PbpLookup`s per source and independently
 * re-validates every candidate record against these same fields before accepting it.
 */
export interface CanonicalPbpLookup {
  /** `historical_matches.id`, when known — the strongest possible identity anchor. */
  canonicalMatchId?: number | null;
  player1Name: string;
  player2Name: string;
  date: string;
  tournamentName?: string | null;
  tour?: PbpTour | null;
  surface?: string | null;
  round?: string | null;
}

export interface PbpDerivedStats {
  pointsPlayed: number;
  serverPointsWon: Record<"player1" | "player2", number>;
  serverPointsPlayed: Record<"player1" | "player2", number>;
  servicePointsWonPct: Record<"player1" | "player2", number | null>;
  returnPointsWonPct: Record<"player1" | "player2", number | null>;
  /**
   * Real counts parsed directly from the pbp token stream ('A'/'D' characters), never estimated.
   * `adfDataComplete=false` means the source's own adf_flag indicates aces/double-faults were not
   * reliably recorded for this match — the counts below may under-report and should be treated as
   * a floor, not a precise total (see the source's own documentation of this flag). Still real
   * parsed data, not fabricated, in both cases.
   */
  aces: Record<"player1" | "player2", number | null>;
  doubleFaults: Record<"player1" | "player2", number | null>;
  adfDataComplete: boolean;
  gamesPlayed: number;
  setsPlayed: number;
  sourceRecordId: string;
}

export interface PbpMatchResult {
  record: PointByPointRecord;
  derived: PbpDerivedStats;
  identityStatus: PbpIdentityStatus;
  canonicalMatchId: number | null;
}

export interface PbpSource {
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly validationStatus: PbpValidationStatus;
  lookup(match: PbpLookup): Promise<PointByPointRecord | null>;
  /** Optional bulk export for backfill pipelines. Sources without a practical bulk mode omit this. */
  bulkFetch?(tour: PbpTour): AsyncGenerator<PointByPointRecord>;
}

/** Distinct rejection reasons a router/service caller must be able to tell apart — see docs/pbp-source-policy.md. */
export type PbpRejectionReason =
  | "source_disabled"
  | `source_status_${string}`
  | "source_lookup_failed"
  | "no_match_in_source"
  | "identity_ambiguous"
  | "identity_no_match"
  | "conflict_between_sources";

export interface PbpResolution {
  result: PbpMatchResult | null;
  attemptedSources: string[];
  rejectedSources: Array<{ source: string; reason: string }>;
  /** Set only when two enabled sources returned materially different content for the same match. */
  conflict?: {
    sources: string[];
    detail: string;
  };
}
