// Central policy for the 2005→present multi-source historical evidence layer.
// All historical ingestion adapters must pass through these rules before
// contributing to player records, H2H, form, surface, fatigue, Elo/calibration,
// common-opponent or reconstruction aggregates.

export const HISTORICAL_START_DATE = "2005-01-01" as const;
export const HISTORICAL_START_YEAR = 2005 as const;

export type Tour = "ATP" | "WTA";
export type HistoricalSourceId =
  | "current"
  | "official"
  | "tennis-data"
  | "datahub-atp"
  | "tennismylife";

export interface HistoricalSourcePolicy {
  id: HistoricalSourceId;
  tours: readonly Tour[];
  priority: number;
  enabled: boolean;
  mayFillHistoricalGaps: boolean;
  reuseTermsVerified: boolean;
}

export const HISTORICAL_SOURCE_POLICIES: readonly HistoricalSourcePolicy[] = [
  { id: "current", tours: ["ATP", "WTA"], priority: 0, enabled: true, mayFillHistoricalGaps: true, reuseTermsVerified: true },
  { id: "official", tours: ["ATP", "WTA"], priority: 1, enabled: true, mayFillHistoricalGaps: true, reuseTermsVerified: true },
  { id: "tennis-data", tours: ["ATP", "WTA"], priority: 2, enabled: true, mayFillHistoricalGaps: true, reuseTermsVerified: true },
  { id: "datahub-atp", tours: ["ATP"], priority: 3, enabled: true, mayFillHistoricalGaps: true, reuseTermsVerified: true },
  // Do not ingest TennisMyLife until reuse/licensing terms are explicitly verified.
  { id: "tennismylife", tours: ["ATP", "WTA"], priority: 4, enabled: false, mayFillHistoricalGaps: false, reuseTermsVerified: false },
] as const;

export function isOnOrAfterHistoricalCutoff(value: string | Date | null | undefined): boolean {
  if (!value) return false;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) && d.getTime() >= Date.parse(`${HISTORICAL_START_DATE}T00:00:00Z`);
}

export function sourcePolicy(id: HistoricalSourceId): HistoricalSourcePolicy {
  const policy = HISTORICAL_SOURCE_POLICIES.find((x) => x.id === id);
  if (!policy) throw new Error(`Unknown historical source: ${id}`);
  return policy;
}

export function sourceCanContribute(id: HistoricalSourceId, tour: Tour, date: string | Date): boolean {
  const p = sourcePolicy(id);
  return p.enabled && p.reuseTermsVerified && p.tours.includes(tour) && isOnOrAfterHistoricalCutoff(date);
}

export function historicalSourcePriority(id: HistoricalSourceId): number {
  return sourcePolicy(id).priority;
}
