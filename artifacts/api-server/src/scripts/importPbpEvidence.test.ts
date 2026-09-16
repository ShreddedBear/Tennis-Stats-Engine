import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dedupeByExternalId, importRecords, type ExportedPbpRecord, type MinimalDb } from "./importPbpEvidence.js";

function makeRecord(overrides: Partial<ExportedPbpRecord> = {}): ExportedPbpRecord {
  return {
    provider: "sackmann",
    externalId: "2012-891-1",
    tour: "ATP_MAIN",
    pbpSourceRepo: "ppaulojr/tennis_pointbypoint",
    pbpSourceFile: "pbp_matches_atp_main_archive.csv",
    pbpSourceRow: 100,
    pbpRaw: "SSSS;RRRR",
    pbpSha256: "abc123",
    reconstructed: { valid: true, sets: [[6, 4]], winner: 0, points: 40, games: 10 },
    verifierVersion: 1,
    validationLevel: "STRUCTURALLY_VALIDATED",
    licenseStatus: "LICENSE_UNCERTAIN",
    ...overrides,
  };
}

describe("dedupeByExternalId — real ppaulojr duplicate-row wrinkle", () => {
  it("keeps the record with the lowest pbpSourceRow and reports the rest as discarded", () => {
    const records = [
      makeRecord({ pbpSourceRow: 1888, pbpSha256: "second" }),
      makeRecord({ pbpSourceRow: 1887, pbpSha256: "first" }),
    ];
    const { kept, discardedDuplicates } = dedupeByExternalId(records);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].pbpSha256, "first");
    assert.strictEqual(discardedDuplicates.length, 1);
    assert.strictEqual(discardedDuplicates[0].keptSourceRow, 1887);
    assert.strictEqual(discardedDuplicates[0].discardedSourceRow, 1888);
  });

  it("does not touch records with distinct externalIds", () => {
    const records = [makeRecord({ externalId: "A" }), makeRecord({ externalId: "B" })];
    const { kept, discardedDuplicates } = dedupeByExternalId(records);
    assert.strictEqual(kept.length, 2);
    assert.deepStrictEqual(discardedDuplicates, []);
  });

  it("distinguishes by (provider, externalId), not externalId alone", () => {
    const records = [
      makeRecord({ provider: "sackmann", externalId: "X", pbpSourceRow: 1 }),
      makeRecord({ provider: "other-provider", externalId: "X", pbpSourceRow: 2 }),
    ];
    const { kept, discardedDuplicates } = dedupeByExternalId(records);
    assert.strictEqual(kept.length, 2);
    assert.deepStrictEqual(discardedDuplicates, []);
  });
});

function makeFakeDb(opts: { existingMatches: Record<string, number>; onInsert?: (params: unknown[]) => void }): MinimalDb {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("SELECT id FROM historical_matches")) {
        const [provider, externalId] = params as [string, string];
        const id = opts.existingMatches[`${provider}:${externalId}`];
        return { rows: id !== undefined ? [{ id }] : [] };
      }
      if (sql.includes("INSERT INTO pbp_evidence")) {
        opts.onInsert?.(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as unknown as MinimalDb;
}

describe("importRecords", () => {
  it("inserts a pbp_evidence row for a record whose match exists in historical_matches", async () => {
    const insertedParams: unknown[][] = [];
    const db = makeFakeDb({
      existingMatches: { "sackmann:2012-891-1": 42 },
      onInsert: (p) => insertedParams.push(p),
    });

    const outcome = await importRecords(db, [makeRecord()], false);

    assert.strictEqual(outcome.insertedOrUpdated.length, 1);
    assert.strictEqual(outcome.insertedOrUpdated[0].matchId, 42);
    assert.strictEqual(outcome.skippedMatchNotFound.length, 0);
    assert.strictEqual(insertedParams.length, 1);
    assert.strictEqual(insertedParams[0][0], 42); // match_id
    assert.strictEqual(insertedParams[0][9], "STRUCTURALLY_VALIDATED"); // trust_level — never upgraded
    assert.strictEqual(insertedParams[0][10], "LICENSE_UNCERTAIN"); // license_status — retained verbatim
  });

  it("skips (never fabricates a matchId for) a record whose match is not yet in historical_matches", async () => {
    const db = makeFakeDb({ existingMatches: {} });
    const outcome = await importRecords(db, [makeRecord()], false);

    assert.strictEqual(outcome.insertedOrUpdated.length, 0);
    assert.deepStrictEqual(outcome.skippedMatchNotFound, ["2012-891-1"]);
  });

  it("dry-run resolves matches but never issues an INSERT", async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      existingMatches: { "sackmann:2012-891-1": 42 },
      onInsert: () => { insertCalled = true; },
    });

    const outcome = await importRecords(db, [makeRecord()], true);

    assert.strictEqual(outcome.insertedOrUpdated.length, 1, "dry-run still reports what WOULD be inserted");
    assert.strictEqual(insertCalled, false, "dry-run must never call INSERT");
  });

  it("never upgrades validationLevel/licenseStatus for a CONFLICT-level record passed through unexpectedly", async () => {
    // Defense in depth: this script trusts the export's validationLevel/licenseStatus verbatim --
    // it is the export's job (and evidenceEligibility.ts's, downstream) to decide usability, not
    // this import step silently rewriting either field.
    const insertedParams: unknown[][] = [];
    const db = makeFakeDb({
      existingMatches: { "sackmann:2012-891-1": 42 },
      onInsert: (p) => insertedParams.push(p),
    });
    await importRecords(db, [makeRecord({ validationLevel: "CONFLICT" })], false);
    assert.strictEqual(insertedParams[0][9], "CONFLICT");
  });
});
