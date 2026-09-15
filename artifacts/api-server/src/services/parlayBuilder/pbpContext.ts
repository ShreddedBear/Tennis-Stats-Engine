import { getPbpForMatch, toEnginePbpContext, type CanonicalPbpLookup, type EnginePbpContext } from "../pbp";

/**
 * The Parlay Builder's only door into PBP data. It must never scrape or parse a PBP provider
 * itself, and must never import from `services/predictionEngine/` (enforced by
 * `scripts/checkParlayBoundary.ts`) — this file calls the same centralized `services/pbp` layer
 * the Prediction Engine and Truth Engine use, so PBP is shared infrastructure/data, never shared
 * prediction logic. A failed/absent PBP lookup never throws here; callers get
 * `EnginePbpContext.available=false` and continue down the Builder's existing non-PBP evidence
 * pathway (see `DataSourceDiagnostics` in builderScoringService.ts).
 */
export async function getPbpContextForLeg(lookup: CanonicalPbpLookup): Promise<EnginePbpContext> {
  const result = await getPbpForMatch(lookup);
  return toEnginePbpContext(result);
}
