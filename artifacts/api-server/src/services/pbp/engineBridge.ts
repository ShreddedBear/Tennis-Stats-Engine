import type { PbpDerivedStats, PbpResolution } from "./types";

/**
 * Single contract consumed by the Truth Engine, Stats Engine and Parlay Builder.
 * The engines must never fetch provider-specific PBP directly. They receive only this normalized
 * bridge object, which keeps provenance, validation and source decisions centralized.
 */
export interface EnginePbpContext {
  available: boolean;
  source: string | null;
  sourceRecordId: string | null;
  validationStatus: string | null;
  provenanceNote: string | null;
  pbp: string | null;
  derived: PbpDerivedStats | null;
  attemptedSources: string[];
  rejectedSources: Array<{ source: string; reason: string }>;
}

export function toEnginePbpContext(resolution: PbpResolution): EnginePbpContext {
  if (!resolution.result) {
    return {
      available: false,
      source: null,
      sourceRecordId: null,
      validationStatus: null,
      provenanceNote: null,
      pbp: null,
      derived: null,
      attemptedSources: resolution.attemptedSources,
      rejectedSources: resolution.rejectedSources,
    };
  }

  return {
    available: true,
    source: resolution.result.record.source,
    sourceRecordId: resolution.result.record.sourceRecordId,
    validationStatus: resolution.result.record.validationStatus,
    provenanceNote: resolution.result.record.provenanceNote,
    pbp: resolution.result.record.pbp,
    derived: resolution.result.derived,
    attemptedSources: resolution.attemptedSources,
    rejectedSources: resolution.rejectedSources,
  };
}
