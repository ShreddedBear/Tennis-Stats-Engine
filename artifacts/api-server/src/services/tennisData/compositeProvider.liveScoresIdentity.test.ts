/**
 * Verifies CompositeTennisProvider.getLiveScores' cross-provider identity correlation.
 *
 * The bug this covers: fixtures are normally served by the primary provider (MatchStat), whose
 * fixture ids are a composite key in ITS OWN namespace (`${tournamentId}:${player1Id}:${player2Id}`)
 * -- completely unrelated to the fallback (API-Tennis)'s own `event_key` ids. But live scores are
 * hard-routed to the fallback (MatchStat has no live-score endpoint), which used to look those ids
 * up directly against its own `event_key` namespace and silently return nothing for every
 * MatchStat-sourced id -- live scores never populated for the common case. The fix correlates
 * unresolved ids via a stable, provider-agnostic identity (date + normalized player names) cached
 * from the fixture's last getUpcomingFixturesRange call, never by assuming id equality.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompositeTennisProvider } from "./compositeProvider.js";
import { ProviderUnavailableError } from "./types.js";
import type {
  Fixture,
  HeadToHeadRecord,
  HistoricalFixture,
  LiveScore,
  MatchRecord,
  PlayerProfile,
  PlayerSummary,
  ProviderStatusInfo,
  TennisDataProvider,
} from "./types.js";

const UNAVAILABLE = new ProviderUnavailableError("provider down");

function baseStub(name: string): TennisDataProvider {
  return {
    name,
    getStatus(): ProviderStatusInfo {
      return { provider: name, connected: true, lastSuccessfulCallAt: new Date().toISOString(), lastError: null };
    },
    async searchPlayers(): Promise<PlayerSummary[]> { throw UNAVAILABLE; },
    async getPlayer(): Promise<PlayerProfile | null> { throw UNAVAILABLE; },
    async getPlayerMatches(): Promise<MatchRecord[]> { throw UNAVAILABLE; },
    async getUpcomingFixtures(): Promise<Fixture[]> { throw UNAVAILABLE; },
    async getUpcomingFixturesRange(): Promise<Fixture[]> { return []; },
    async getHeadToHead(): Promise<HeadToHeadRecord> { throw UNAVAILABLE; },
    async getCompletedMatchesByDateRange(): Promise<HistoricalFixture[]> { return []; },
    async getLiveScores(): Promise<Map<string, LiveScore>> { return new Map(); },
  };
}

const MATCHSTAT_FIXTURE_ID = "555:101:102"; // MatchStat's own `${tournamentId}:${p1}:${p2}` namespace
const LIVE_SCORE: LiveScore = { sets: [{ player1Games: 6, player2Games: 4 }], statusText: "2nd Set" };

function makePrimary(): TennisDataProvider {
  return {
    ...baseStub("MatchStat"),
    async getUpcomingFixturesRange(): Promise<Fixture[]> {
      return [{
        id: MATCHSTAT_FIXTURE_ID,
        date: "2026-03-01",
        scheduledStart: "2026-03-01T12:00:00.000Z",
        timeConfirmed: true,
        isLive: true,
        tournamentName: "Test Open",
        tournamentLevel: "ATP250",
        round: "Round of 16",
        surface: "Hard",
        indoor: null,
        matchFormat: "BestOf3",
        player1Id: "101",
        player1Name: "Carlos Alcaraz",
        player2Id: "102",
        player2Name: "Novak Djokovic",
      }];
    },
  };
}

describe("CompositeTennisProvider.getLiveScores — cross-provider identity correlation", () => {
  it("resolves a live score for a primary-sourced (MatchStat) fixture id via identity, not id equality", async () => {
    const primary = makePrimary();
    const fallback: TennisDataProvider = {
      ...baseStub("API-Tennis"),
      // Native event_key lookup finds nothing -- the requested id is MatchStat's, not ours.
      async getLiveScores(fixtureIds: string[]): Promise<Map<string, LiveScore>> {
        assert.deepEqual(fixtureIds, [MATCHSTAT_FIXTURE_ID]);
        return new Map();
      },
      // Identity-based lookup matches by date + normalized player names.
      async getLiveScoresByIdentity(
        fixtures: Array<{ id: string; date: string; player1Name: string; player2Name: string }>,
      ): Promise<Map<string, LiveScore>> {
        const result = new Map<string, LiveScore>();
        for (const f of fixtures) {
          if (f.date === "2026-03-01" && f.player1Name === "Carlos Alcaraz" && f.player2Name === "Novak Djokovic") {
            result.set(f.id, LIVE_SCORE);
          }
        }
        return result;
      },
    };
    const composite = new CompositeTennisProvider(primary, fallback);

    // Populate the identity cache the way the real fixtures route does.
    await composite.getUpcomingFixturesRange("2026-03-01", "2026-03-01");

    const scores = await composite.getLiveScores([MATCHSTAT_FIXTURE_ID]);
    assert.equal(scores.size, 1);
    assert.deepEqual(scores.get(MATCHSTAT_FIXTURE_ID), LIVE_SCORE);
  });

  it("prefers the native id-based result and never calls getLiveScoresByIdentity for ids already resolved", async () => {
    const primary = makePrimary();
    let identityCalled = false;
    const fallback: TennisDataProvider = {
      ...baseStub("API-Tennis"),
      async getLiveScores(fixtureIds: string[]): Promise<Map<string, LiveScore>> {
        const result = new Map<string, LiveScore>();
        for (const id of fixtureIds) result.set(id, LIVE_SCORE);
        return result;
      },
      async getLiveScoresByIdentity(): Promise<Map<string, LiveScore>> {
        identityCalled = true;
        return new Map();
      },
    };
    const composite = new CompositeTennisProvider(primary, fallback);
    await composite.getUpcomingFixturesRange("2026-03-01", "2026-03-01");

    const scores = await composite.getLiveScores(["some-api-tennis-event-key"]);
    assert.deepEqual(scores.get("some-api-tennis-event-key"), LIVE_SCORE);
    assert.equal(identityCalled, false, "identity correlation must be skipped once native lookup already resolved every id");
  });

  it("returns an empty map (not throw) for an id with no cached identity metadata and no native match", async () => {
    const primary = makePrimary();
    const fallback: TennisDataProvider = {
      ...baseStub("API-Tennis"),
      async getLiveScores(): Promise<Map<string, LiveScore>> { return new Map(); },
      async getLiveScoresByIdentity(): Promise<Map<string, LiveScore>> { return new Map(); },
    };
    const composite = new CompositeTennisProvider(primary, fallback);
    // Note: no getUpcomingFixturesRange call first, so nothing is cached for this id.

    const scores = await composite.getLiveScores(["unknown-fixture-id"]);
    assert.equal(scores.size, 0);
  });
});
