// ----------------------------------------------------------------------------
// Audit repository write-path tests. Require a real Postgres.
//
// These exist because of a defect a real pipeline run found and no amount of typechecking
// would have: the repository serialised EVERY object to JSON before binding it, which is
// right for a jsonb column and fatal for a Postgres array column -- text[] rejects the
// string "[]" outright as a malformed array literal, and the run died at COVERAGE
// PERSISTENCE. The fix reads each table's real column types from the catalog, so the tests
// below assert against the live catalog rather than a hard-coded list of array columns that
// would rot the first time the schema gained one.
//
//   DATABASE_URL=postgres://... pnpm --filter @workspace/api-server run test:tennisMatrixAudit:db
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

const DATABASE_URL = process.env["DATABASE_URL"];

describe("audit repository write path", { skip: DATABASE_URL ? false : "DATABASE_URL is not set" }, () => {
  let pool: typeof import("@workspace/db").pool;
  let normalizeRow: typeof import("./auditRepo.js").normalizeRow;

  before(async () => {
    ({ pool } = await import("@workspace/db"));
    ({ normalizeRow } = await import("./auditRepo.js"));
  });

  after(async () => {
    await pool.query("delete from source_definitions where source_name like 'TEST::%'");
    await pool.end();
  });

  const normalize = (table: string, row: Record<string, unknown>) =>
    normalizeRow(table, Object.keys(row), (column) => row[column]);

  test("an array column receives a JS array, not JSON text", async () => {
    const [supported] = await normalize("source_definitions", { supported_data: ["elo", "form"] });
    assert.deepEqual(supported, ["elo", "form"]);
  });

  test("an EMPTY array reaches an array column as an array -- the exact failing case", async () => {
    // "[]" is what the old code produced here, and it is what Postgres rejected.
    const [supported] = await normalize("source_definitions", { supported_data: [] });
    assert.deepEqual(supported, []);
    assert.notEqual(supported, "[]");
  });

  test("a jsonb column still receives serialised JSON", async () => {
    const [history] = await normalize("source_definitions", { error_history: [{ at: "now", error: "x" }] });
    assert.equal(typeof history, "string");
    assert.deepEqual(JSON.parse(String(history)), [{ at: "now", error: "x" }]);
  });

  test("a jsonb object column is serialised", async () => {
    const [report] = await normalize("final_decisions", { gate_report: { deterministic_decision: { outcome: "P1" } } });
    assert.equal(typeof report, "string");
    assert.deepEqual(JSON.parse(String(report)), { deterministic_decision: { outcome: "P1" } });
  });

  test("scalars, null and undefined are unchanged, and undefined becomes null", async () => {
    const [name, priority, domain, reliability] = await normalize("source_definitions", {
      source_name: "TEST::scalar", priority: 10, domain: null, reliability: undefined,
    });
    assert.equal(name, "TEST::scalar");
    assert.equal(priority, 10);
    assert.equal(domain, null);
    // The engine builds patches by spreading; a missing key means "null", never "leave as-is".
    assert.equal(reliability, null);
  });

  test("a Date is passed through rather than serialised", async () => {
    const at = new Date("2026-09-14T00:00:00Z");
    const [value] = await normalize("source_definitions", { last_fetch_at: at });
    assert.equal(value, at);
  });

  test("an array value actually round-trips through a real insert", async () => {
    // The end-to-end proof: bind through the same normalisation and read it back.
    const columns = ["user_id", "source_name", "category", "priority", "reliability", "supported_data", "error_history"];
    const row: Record<string, unknown> = {
      user_id: "00000000-0000-0000-0000-000000000001",
      source_name: "TEST::roundtrip",
      category: "TIER 2",
      priority: 99,
      reliability: 0.5,
      supported_data: ["elo", "serve"],
      error_history: [{ at: "2026-09-14", error: "none" }],
    };
    const values = await normalizeRow("source_definitions", columns, (column) => row[column]);
    await pool.query(
      `insert into source_definitions (${columns.map((c) => `"${c}"`).join(", ")})
       values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      values,
    );

    const { rows } = await pool.query(
      `select supported_data, error_history from source_definitions where source_name = 'TEST::roundtrip'`,
    );
    const stored = rows[0] as { supported_data: string[]; error_history: unknown };
    assert.deepEqual(stored.supported_data, ["elo", "serve"]);
    assert.deepEqual(stored.error_history, [{ at: "2026-09-14", error: "none" }]);
  });

  test("every ARRAY column in the audit schema is treated as an array", async () => {
    // Catalog-driven rather than a fixed list: a schema that gains an array column is
    // covered by this test the moment it is added.
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and data_type = 'ARRAY'`,
    );
    assert.ok(rows.length > 0, "expected the audit schema to contain array columns");
    for (const { table_name, column_name } of rows) {
      const [value] = await normalizeRow(table_name, [column_name], () => []);
      assert.deepEqual(value, [], `${table_name}.${column_name} was not treated as an array`);
    }
  });
});
