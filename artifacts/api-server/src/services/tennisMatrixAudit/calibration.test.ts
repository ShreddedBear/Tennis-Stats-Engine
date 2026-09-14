// ----------------------------------------------------------------------------
// Calibration-ledger integration tests. Require a real Postgres.
//
// Grading is the Audit's only new multi-table write, and the invariant it has to hold is
// not expressible in types: exactly one active calibration version, a bucket set that
// belongs to it, and a ledger row naming the version before and after. Half-applied is the
// one state that must never be reachable, because from it no verified win rate on any board
// row can be attributed to the record that produced it.
//
// Run against a throwaway database:
//   DATABASE_URL=postgres://... pnpm --filter @workspace/api-server run test:tennisMatrixAudit:db
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

const DATABASE_URL = process.env["DATABASE_URL"];
// THIS SUITE IS DESTRUCTIVE: it empties calibration_versions, calibration_buckets and
// calibration_ledger so sequence numbers in the assertions are predictable. Pointed at a
// real database that would delete a genuine calibration record -- the graded history every
// verified win rate on the board is derived from, which no re-run can reconstruct because
// grading needs real match results entered by a person.
//
// So it refuses to run unless the operator says the target is disposable. A skipped test is
// a far better outcome than a silently erased ledger.
const DESTRUCTIVE_OK = process.env["AUDIT_DB_TEST_ALLOW_DESTRUCTIVE"] === "1";
const skipReason = !DATABASE_URL
  ? "DATABASE_URL is not set"
  : !DESTRUCTIVE_OK
    ? "refusing to erase calibration data: set AUDIT_DB_TEST_ALLOW_DESTRUCTIVE=1 to confirm this database is disposable"
    : false;

describe("calibration ledger", { skip: skipReason }, () => {
  // Imported lazily: @workspace/db throws at import time without DATABASE_URL, which would
  // fail the file rather than skip it.
  let pool: typeof import("@workspace/db").pool;
  let gradeResult: typeof import("./calibration.js").gradeResult;
  let readCalibration: typeof import("./calibration.js").readCalibration;
  let readCalibrationHistory: typeof import("./calibration.js").readCalibrationHistory;

  before(async () => {
    ({ pool } = await import("@workspace/db"));
    ({ gradeResult, readCalibration, readCalibrationHistory } = await import("./calibration.js"));
    // Start from the seeded v1 so sequence numbers in the assertions are predictable.
    await pool.query("delete from calibration_ledger");
    await pool.query("delete from calibration_buckets");
    await pool.query("delete from calibration_versions");
    const version = await pool.query(
      `insert into calibration_versions (user_id, version_number, label, master_sequence_count, graded_sample_count, is_active)
       values ('00000000-0000-0000-0000-000000000001', 1, 'Calibration v1', 0, 0, true) returning id`,
    );
    const versionId = (version.rows[0] as { id: string }).id;
    for (const [code, label, min, max] of [
      ["ORANGE", "Orange · ≤55%", 0, 55], ["TAN", "Tan · 56–64%", 56, 64],
      ["PURPLE", "Purple · 65–69%", 65, 69], ["BLUE", "Blue · 70–74%", 70, 74],
      ["PINK", "Pink · 75–79%", 75, 79], ["BROWN", "Brown · 80–84%", 80, 84],
      ["INDIGO", "Indigo · 85–89%", 85, 89], ["GOLD", "Gold · 90%+", 90, 100],
    ] as Array<[string, string, number, number]>) {
      await pool.query(
        `insert into calibration_buckets (user_id, calibration_version_id, bucket_code, bucket_label, wp_min, wp_max, wins, graded, small_sample)
         values ('00000000-0000-0000-0000-000000000001', $1, $2, $3, $4, $5, 0, 0, true)`,
        [versionId, code, label, min, max],
      );
    }
  });

  after(async () => {
    await pool.query("delete from calibration_ledger");
    await pool.query("delete from calibration_buckets");
    await pool.query("delete from calibration_versions");
    // Release the pool, or the runner sits on an open connection until it times out.
    await pool.end();
  });

  const grade = (over: Partial<Parameters<typeof gradeResult>[0]>) =>
    gradeResult({
      matchId: null, matchLabel: "A vs B", tournament: null, surface: null, matchDate: null,
      matrixPredictedWinner: "A", matrixWp: 72, resultType: "WIN", actualWinner: "A", note: null,
      ...over,
    });

  test("a win lands in the band its stated probability falls in", async () => {
    const result = await grade({ matrixWp: 72 });
    assert.equal(result.bucketCode, "BLUE");
    assert.equal(result.counted, true);

    const view = await readCalibration();
    const blue = view.buckets.find((bucket) => bucket.bucket_code === "BLUE");
    assert.equal(blue?.wins, 1);
    assert.equal(blue?.graded, 1);
    assert.equal(blue?.win_rate, 100);
    // Every other band is untouched: a result moves exactly one band.
    assert.equal(view.buckets.filter((bucket) => bucket.graded > 0).length, 1);
  });

  test("a loss raises the denominator without raising the win rate", async () => {
    await grade({ matrixWp: 72, resultType: "LOSS", actualWinner: "B" });
    const view = await readCalibration();
    const blue = view.buckets.find((bucket) => bucket.bucket_code === "BLUE");
    assert.equal(blue?.wins, 1);
    assert.equal(blue?.graded, 2);
    assert.equal(blue?.win_rate, 50);
  });

  test("an in-match retirement is graded as a real result", async () => {
    await grade({ matrixWp: 91, resultType: "RETIREMENT WIN" });
    const view = await readCalibration();
    const gold = view.buckets.find((bucket) => bucket.bucket_code === "GOLD");
    assert.equal(gold?.wins, 1);
    assert.equal(gold?.graded, 1);
  });

  test("a walkover is recorded but never counted", async () => {
    const before = await readCalibration();
    const result = await grade({ matrixWp: 91, resultType: "WALKOVER" });
    assert.equal(result.counted, false);

    const view = await readCalibration();
    const gold = view.buckets.find((bucket) => bucket.bucket_code === "GOLD");
    assert.equal(gold?.graded, 1, "a walkover must not move a graded count");
    // It still happened, so it is in the ledger -- marked as not counted.
    assert.equal(view.ledger.length, before.ledger.length + 1);
    const latest = view.ledger[0] as Record<string, unknown>;
    assert.equal(latest["result_type"], "WALKOVER");
    assert.equal(latest["counted_in_bucket"], false);
    assert.equal(latest["result_grading_status"], "NOT GRADED");
  });

  test("a result with no stated probability is recorded but lands in no band", async () => {
    const result = await grade({ matrixWp: null });
    assert.equal(result.bucketCode, null);
    assert.equal(result.counted, false);
  });

  test("exactly one calibration version is active after every grading", async () => {
    const { rows } = await pool.query("select count(*)::int as n from calibration_versions where is_active = true");
    assert.equal((rows[0] as { n: number }).n, 1);
  });

  test("each version carries its own complete copy of the buckets", async () => {
    const history = await readCalibrationHistory();
    for (const version of history.versions as Array<Record<string, unknown>>) {
      const owned = history.buckets.filter((bucket) => bucket.calibration_version_id === String(version["id"]));
      assert.equal(owned.length, 8, `version ${version["label"]} should own 8 buckets, found ${owned.length}`);
    }
  });

  test("a ledger row names the version before and after, and they differ", async () => {
    const view = await readCalibration();
    for (const row of view.ledger as Array<Record<string, unknown>>) {
      assert.ok(row["calibration_version_before"], "missing version before");
      assert.ok(row["calibration_version_after"], "missing version after");
      assert.notEqual(row["calibration_version_before"], row["calibration_version_after"]);
    }
  });

  test("master sequence increases by one per graded result, with no gaps", async () => {
    const view = await readCalibration();
    const sequences = (view.ledger as Array<Record<string, unknown>>)
      .map((row) => Number(row["master_sequence"])).sort((a, b) => a - b);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  });

  test("an unknown result type is refused and writes nothing", async () => {
    const before = await readCalibration();
    await assert.rejects(() => grade({ resultType: "PROBABLY WON" }), /Unknown result type/);
    const after_ = await readCalibration();
    assert.equal(after_.ledger.length, before.ledger.length);
    assert.equal(String(after_.version?.["id"]), String(before.version?.["id"]), "the active version must not advance");
  });

  test("a result with no match label is refused and writes nothing", async () => {
    const before = await readCalibration();
    await assert.rejects(() => grade({ matchLabel: "   " }), /match label is required/);
    const after_ = await readCalibration();
    assert.equal(after_.ledger.length, before.ledger.length);
    assert.equal(String(after_.version?.["id"]), String(before.version?.["id"]));
  });

  test("past versions keep the counts they had -- grading never edits history", async () => {
    const history = await readCalibrationHistory();
    const versions = (history.versions as Array<Record<string, unknown>>)
      .slice().sort((a, b) => Number(a["version_number"]) - Number(b["version_number"]));
    const blueByVersion = versions.map((version) =>
      history.buckets.find(
        (bucket) => bucket.calibration_version_id === String(version["id"]) && bucket.bucket_code === "BLUE",
      )?.graded ?? 0,
    );
    // v1 was seeded empty and must still read empty however many results were graded since.
    assert.equal(blueByVersion[0], 0);
    // And the sequence never decreases: each version is the previous one plus this result.
    for (let index = 1; index < blueByVersion.length; index++) {
      assert.ok(blueByVersion[index]! >= blueByVersion[index - 1]!);
    }
  });
});
