import { deriveStatsFromPbp } from "./derive";
import { normalizePlayerName } from "../tennisData/playerIdentity";
import type { PbpLookup, PbpMatchResult, PbpResolution, PbpSource } from "./types";

/**
 * Central PBP resolver. Sources are deliberately injected so provenance/licensing policy stays
 * outside the prediction engines. The resolver returns one normalized record to every consumer,
 * tries sources in priority order, and stops at the first one that resolves — but continues
 * checking already-attempted lower-priority sources for CORROBORATION/CONFLICT only when the
 * caller explicitly asks via `checkCorroboration` (the default single-source lookup path stays
 * cheap: one successful source call, no N-source fan-out on every request).
 */
export class PbpSourceRouter {
  constructor(private readonly sources: PbpSource[]) {}

  async resolve(match: PbpLookup, options: { checkCorroboration?: boolean } = {}): Promise<PbpResolution> {
    const attemptedSources: string[] = [];
    const rejectedSources: Array<{ source: string; reason: string }> = [];

    const ordered = [...this.sources].sort((a, b) => a.priority - b.priority);
    let primary: { source: PbpSource; record: NonNullable<Awaited<ReturnType<PbpSource["lookup"]>>> } | null = null;

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
        if (!record) {
          rejectedSources.push({ source: source.name, reason: "no_match_in_source" });
          continue;
        }
        if (!primary) {
          primary = { source, record };
          if (!options.checkCorroboration) break;
          continue;
        }
        // A second source resolved the same lookup — check for corroboration/conflict rather
        // than silently picking one (see docs/pbp-source-policy.md).
        if (record.winner !== primary.record.winner || (record.score && primary.record.score && record.score !== primary.record.score)) {
          return {
            result: null,
            attemptedSources,
            rejectedSources,
            conflict: {
              sources: [primary.source.name, source.name],
              detail: `winner/score mismatch: ${primary.source.name}=${primary.record.winner}/${primary.record.score ?? "?"} vs ${source.name}=${record.winner}/${record.score ?? "?"}`,
            },
          };
        }
      } catch (error) {
        rejectedSources.push({ source: source.name, reason: error instanceof Error ? error.message : "source_lookup_failed" });
      }
    }

    if (!primary) {
      return { result: null, attemptedSources, rejectedSources };
    }

    const server1IsPlayer1 = normalizePlayerName(primary.record.server1) === normalizePlayerName(match.player1Name);
    const derived = deriveStatsFromPbp({
      raw: primary.record.pbp,
      sourceRecordId: primary.record.sourceRecordId,
      server1IsPlayer1,
      adfFlag: primary.record.adfFlag,
    });

    if (!derived) {
      rejectedSources.push({ source: primary.source.name, reason: "malformed_pbp" });
      return { result: null, attemptedSources, rejectedSources };
    }

    // The router only confirms a source returned content for this raw-name/date lookup — it does
    // not itself perform canonical identity resolution against historical_matches (that requires
    // DB access the router deliberately doesn't have). Callers needing a trustworthy identity
    // verdict must resolve through pbpService.getPbpForMatch, which runs resolvePbpMatchIdentity
    // and overwrites these two fields with the real result before returning to any engine.
    return {
      result: { record: primary.record, derived, identityStatus: "REVIEW_REQUIRED", canonicalMatchId: null } satisfies PbpMatchResult,
      attemptedSources,
      rejectedSources,
    };
  }
}
