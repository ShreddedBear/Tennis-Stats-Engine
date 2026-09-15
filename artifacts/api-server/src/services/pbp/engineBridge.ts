import type { PbpDerivedStats } from "./types";
import type { PbpAvailability, PbpServiceResult } from "./pbpService";

/**
 * Single contract consumed by the Truth Engine, Stats Engine and Parlay Builder. The engines must
 * never fetch provider-specific PBP directly — they receive only this normalized bridge object
 * from `getPbpForMatch`, which keeps provenance, identity and validation decisions centralized.
 */
export interface EnginePbpContext {
  availability: PbpAvailability;
  available: boolean;
  source: string | null;
  sourceRecordId: string | null;
  validationStatus: string | null;
  identityStatus: string;
  canonicalMatchId: number | null;
  provenanceNote: string | null;
  pbp: string | null;
  derived: PbpDerivedStats | null;
  orientationMatchesLookup: boolean | null;
  attemptedSources: string[];
  rejectedSources: Array<{ source: string; reason: string }>;
  conflict: { sources: string[]; detail: string } | null;
}

export function toEnginePbpContext(result: PbpServiceResult): EnginePbpContext {
  return {
    availability: result.availability,
    available: result.availability === "AVAILABLE",
    source: result.source,
    sourceRecordId: result.sourceRecordId,
    validationStatus: result.validationStatus,
    identityStatus: result.identityStatus,
    canonicalMatchId: result.canonicalMatchId,
    provenanceNote: result.provenanceNote,
    pbp: result.rawPbp,
    derived: result.derived,
    orientationMatchesLookup: result.orientationMatchesLookup,
    attemptedSources: result.attemptedSources,
    rejectedSources: result.rejectedSources,
    conflict: result.conflict,
  };
}
