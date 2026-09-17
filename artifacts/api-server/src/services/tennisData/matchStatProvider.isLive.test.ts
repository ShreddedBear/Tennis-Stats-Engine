/**
 * Verifies MatchStatProvider's fixture isLive computation.
 *
 * The upcoming/matches endpoint has no live/winner field -- it only returns "upcoming" fixtures --
 * so isLive must be derived from the same elapsed-time heuristic ApiTennisProvider uses (confirmed
 * start time already in the past). Before this fix isLive was hardcoded false for every MatchStat
 * fixture, which meant a match served by the primary provider could never enter the "Live Now"
 * bucket or trigger live-score polling, no matter how far in the past its start time was.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MatchStatProvider } from "./matchStatProvider.js";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(stub: FetchStub): () => void {
  const prev = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = stub;
  return () => {
    (globalThis as unknown as Record<string, unknown>).fetch = prev;
  };
}

function rawMatch(overrides: { date?: string | null; tournamentId?: number } = {}) {
  return {
    tournament: { id: overrides.tournamentId ?? 555, name: "Test Open", date: "2026-01-01T00:00:00.000Z", rankId: 2 },
    court: "Hard",
    roundId: 8,
    rank: 2,
    date: overrides.date === undefined ? "2026-01-01T12:00:00.000Z" : overrides.date,
    type: "atp",
    player1: { id: 101, name: "Player One" },
    player2: { id: 102, name: "Player Two" },
  };
}

function upcomingFetchStub(atpMatches: object[]): FetchStub {
  return async (url: string) => {
    if (url.includes("/upcoming/matches/atp")) return jsonResponse({ total: atpMatches.length, matches: atpMatches });
    if (url.includes("/upcoming/matches/wta")) return jsonResponse({ total: 0, matches: [] });
    return jsonResponse({}, 404);
  };
}

test("isLive: true when the confirmed start time is already in the past", async () => {
  const provider = new MatchStatProvider("test-key");
  const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  const restore = mockFetch(upcomingFetchStub([rawMatch({ date: pastIso })]));
  try {
    const fixtures = await provider.getUpcomingFixturesRange("", "");
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].isLive, true, "a fixture whose confirmed start time has passed must be marked live");
  } finally {
    restore();
  }
});

test("isLive: false when the confirmed start time is still in the future", async () => {
  const provider = new MatchStatProvider("test-key");
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
  const restore = mockFetch(upcomingFetchStub([rawMatch({ date: futureIso })]));
  try {
    const fixtures = await provider.getUpcomingFixturesRange("", "");
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].isLive, false);
  } finally {
    restore();
  }
});

test("isLive: false when there is no confirmed start time (Time TBD)", async () => {
  const provider = new MatchStatProvider("test-key");
  const restore = mockFetch(upcomingFetchStub([rawMatch({ date: null })]));
  try {
    const fixtures = await provider.getUpcomingFixturesRange("", "");
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].timeConfirmed, false);
    assert.equal(fixtures[0].isLive, false, "an unconfirmed time must never be treated as evidence of a live match");
  } finally {
    restore();
  }
});
