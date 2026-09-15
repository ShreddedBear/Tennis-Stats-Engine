import type { PbpLookup, PbpMatchResult, PbpResolution, PbpSource } from "./types";

/**
 * Central PBP resolver. Sources are deliberately injected so provenance/licensing policy stays
 * outside the prediction engines. The resolver returns one normalized record to every consumer.
 */
export class PbpSourceRouter {
  constructor(private readonly sources: PbpSource[]) {}

  async resolve(match: PbpLookup): Promise<PbpResolution> {
    const attemptedSources: string[] = [];
    const rejectedSources: Array<{ source: string; reason: string }> = [];

    const ordered = [...this.sources].sort((a, b) => a.priority - b.priority);
    for (const source of ordered) {
      if (!source.enabled) {
        rejectedSources.push({ source: source.name, reason: "source_disabled" });
        continue;
      }
      if (source.validationStatus === "CONFLICT" || source.validationStatus === "REVIEW_REQUIRED") {
        rejectedSources.push({ source: source.name, reason: `source_status_${source.validationStatus.toLowerCase()}` });
        continue;
      }

      attemptedSources.push(source.name);
      try {
        const record = await source.lookup(match);
        if (!record) continue;
        return {
          result: {
            record,
            // Derived point statistics are populated by the source adapter before returning.
            derived: {
              pointsPlayed: 0,
              serverPointsWon: { player1: 0, player2: 0 },
              serverPointsPlayed: { player1: 0, player2: 0 },
              servicePointsWonPct: { player1: null, player2: null },
              returnPointsWonPct: { player1: null, player2: null },
              aces: { player1: null, player2: null },
              doubleFaults: { player1: null, player2: null },
              gamesPlayed: 0,
              sourceRecordId: record.sourceRecordId,
            },
          } satisfies PbpMatchResult,
          attemptedSources,
          rejectedSources,
        };
      } catch (error) {
        rejectedSources.push({
          source: source.name,
          reason: error instanceof Error ? error.message : "source_lookup_failed",
        });
      }
    }

    return { result: null, attemptedSources, rejectedSources };
  }
}
