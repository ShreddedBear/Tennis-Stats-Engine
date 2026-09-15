import test from "node:test";
import assert from "node:assert/strict";
import { PbpSourceRouter } from "./sourceRouter";
import type { PbpLookup, PbpSource, PointByPointRecord, PbpValidationStatus } from "./types";

function fakeRecord(overrides: Partial<PointByPointRecord> = {}): PointByPointRecord {
  return {
    source: "fake",
    sourceRecordId: "1",
    date: "2014-06-01",
    tournamentName: "Test Open",
    tour: "ATP",
    draw: "Main",
    server1: "Player One",
    server2: "Player Two",
    winner: 1,
    pbp: "SSSS;RRRR;",
    score: "6-4 6-4",
    adfFlag: 1,
    validationStatus: "CANDIDATE",
    provenanceNote: null,
    rawPayload: null,
    ...overrides,
  };
}

function fakeSource(opts: {
  name: string;
  priority: number;
  enabled?: boolean;
  validationStatus?: PbpValidationStatus;
  result?: PointByPointRecord | null | Error;
}): PbpSource {
  return {
    name: opts.name,
    priority: opts.priority,
    enabled: opts.enabled ?? true,
    validationStatus: opts.validationStatus ?? "CANDIDATE",
    async lookup(_match: PbpLookup) {
      if (opts.result instanceof Error) throw opts.result;
      return opts.result ?? null;
    },
  };
}

const lookup: PbpLookup = { player1Name: "Player One", player2Name: "Player Two", date: "2014-06-01" };

test("router: exact match found by the only registered source", async () => {
  const router = new PbpSourceRouter([fakeSource({ name: "A", priority: 1, result: fakeRecord({ source: "A" }) })]);
  const resolution = await router.resolve(lookup);
  assert.ok(resolution.result);
  assert.equal(resolution.result!.record.source, "A");
  assert.equal(resolution.result!.derived.pointsPlayed, 8);
});

test("router: source fallback -- primary has no match, secondary does", async () => {
  const router = new PbpSourceRouter([
    fakeSource({ name: "A", priority: 1, result: null }),
    fakeSource({ name: "B", priority: 2, result: fakeRecord({ source: "B" }) }),
  ]);
  const resolution = await router.resolve(lookup);
  assert.ok(resolution.result);
  assert.equal(resolution.result!.record.source, "B");
  assert.deepEqual(resolution.attemptedSources, ["A", "B"]);
  assert.equal(resolution.rejectedSources[0].reason, "no_match_in_source");
});

test("router: priority order -- lower priority number tried and wins even when both would resolve", async () => {
  const router = new PbpSourceRouter([
    fakeSource({ name: "low-priority", priority: 50, result: fakeRecord({ source: "low-priority" }) }),
    fakeSource({ name: "high-priority", priority: 1, result: fakeRecord({ source: "high-priority" }) }),
  ]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result!.record.source, "high-priority");
  assert.deepEqual(resolution.attemptedSources, ["high-priority"]); // low-priority never even attempted
});

test("router: disabled source is skipped, not attempted", async () => {
  const router = new PbpSourceRouter([
    fakeSource({ name: "disabled", priority: 1, enabled: false, result: fakeRecord() }),
    fakeSource({ name: "enabled", priority: 2, result: fakeRecord({ source: "enabled" }) }),
  ]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result!.record.source, "enabled");
  assert.equal(resolution.rejectedSources.some((r) => r.source === "disabled" && r.reason === "source_disabled"), true);
  assert.equal(resolution.attemptedSources.includes("disabled"), false);
});

test("router: a source flagged CONFLICT/REVIEW_REQUIRED at the source level is never queried", async () => {
  const router = new PbpSourceRouter([fakeSource({ name: "under-review", priority: 1, validationStatus: "REVIEW_REQUIRED", result: fakeRecord() })]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result, null);
  assert.equal(resolution.rejectedSources[0].reason, "source_status_review_required");
});

test("router: candidate source status is preserved on the returned record", async () => {
  const router = new PbpSourceRouter([fakeSource({ name: "A", priority: 1, result: fakeRecord({ validationStatus: "CANDIDATE" }) })]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result!.record.validationStatus, "CANDIDATE");
});

test("router: corroboration -- two enabled sources agree when checkCorroboration is requested", async () => {
  const router = new PbpSourceRouter([
    fakeSource({ name: "A", priority: 1, result: fakeRecord({ source: "A", winner: 1, score: "6-4 6-4" }) }),
    fakeSource({ name: "B", priority: 2, result: fakeRecord({ source: "B", winner: 1, score: "6-4 6-4" }) }),
  ]);
  const resolution = await router.resolve(lookup, { checkCorroboration: true });
  assert.ok(resolution.result);
  assert.equal(resolution.conflict, undefined);
});

test("router: conflicting PBP -- two sources disagree on winner -> CONFLICT, never silently picks one", async () => {
  const router = new PbpSourceRouter([
    fakeSource({ name: "A", priority: 1, result: fakeRecord({ source: "A", winner: 1 }) }),
    fakeSource({ name: "B", priority: 2, result: fakeRecord({ source: "B", winner: 2 }) }),
  ]);
  const resolution = await router.resolve(lookup, { checkCorroboration: true });
  assert.equal(resolution.result, null);
  assert.ok(resolution.conflict);
  assert.deepEqual(resolution.conflict!.sources.sort(), ["A", "B"]);
});

test("router: missing PBP -- no source has it, distinguished from a source error", async () => {
  const router = new PbpSourceRouter([fakeSource({ name: "A", priority: 1, result: null })]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result, null);
  assert.equal(resolution.rejectedSources[0].reason, "no_match_in_source");
});

test("router: source error is distinguished from no-match / never crashes the caller", async () => {
  const router = new PbpSourceRouter([
    fakeSource({ name: "broken", priority: 1, result: new Error("network timeout") }),
    fakeSource({ name: "backup", priority: 2, result: fakeRecord({ source: "backup" }) }),
  ]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result!.record.source, "backup");
  assert.equal(resolution.rejectedSources.find((r) => r.source === "broken")?.reason, "network timeout");
});

test("router: malformed PBP from the only source resolves to no result, not a crash", async () => {
  const router = new PbpSourceRouter([fakeSource({ name: "A", priority: 1, result: fakeRecord({ pbp: "not valid pbp!!" }) })]);
  const resolution = await router.resolve(lookup);
  assert.equal(resolution.result, null);
  assert.equal(resolution.rejectedSources.find((r) => r.source === "A")?.reason, "malformed_pbp");
});
