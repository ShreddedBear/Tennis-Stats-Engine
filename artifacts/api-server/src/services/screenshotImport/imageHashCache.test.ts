import { test } from "node:test";
import assert from "node:assert/strict";
import { imageHash, cacheGet, cacheSet, cacheStats, cacheClear } from "./imageHashCache";

/**
 * OCR reliability audit (P0 Package 3) — regression coverage for image-level duplicate
 * detection and the OCR result cache, which previously had zero tests. See
 * OCR_RELIABILITY_REPORT.md.
 */

test("imageHash: identical bytes hash the same regardless of a data: URL prefix", () => {
  const withPrefix = "data:image/jpeg;base64,AAAABBBBCCCCDDDD";
  const withoutPrefix = "AAAABBBBCCCCDDDD";
  assert.equal(imageHash(withPrefix), imageHash(withoutPrefix));
});

test("imageHash: identical bytes hash the same even with a different declared mime type", () => {
  const jpeg = "data:image/jpeg;base64,AAAABBBBCCCCDDDD";
  const png = "data:image/png;base64,AAAABBBBCCCCDDDD";
  assert.equal(imageHash(jpeg), imageHash(png));
});

test("imageHash: different image bytes hash differently (no collisions on distinct screenshots)", () => {
  assert.notEqual(imageHash("data:image/jpeg;base64,AAAA"), imageHash("data:image/jpeg;base64,ZZZZ"));
});

test("cacheGet/cacheSet: a duplicate screenshot upload within TTL returns the cached result", () => {
  cacheClear();
  const hash = imageHash("data:image/jpeg;base64,DUPTEST");
  assert.equal(cacheGet(hash), null);
  cacheSet(hash, { matchups: ["x"] });
  assert.deepEqual(cacheGet(hash), { matchups: ["x"] });
});

test("cacheSet: at MAX_ENTRIES (200) capacity, the oldest-inserted entry is evicted (LRU by insertion order)", () => {
  cacheClear();
  for (let i = 0; i < 200; i++) cacheSet(`hash-${i}`, i);
  assert.equal(cacheStats().entries, 200);
  assert.equal(cacheGet("hash-0"), 0, "oldest entry still present right at capacity");

  cacheSet("hash-200", 200);
  assert.equal(cacheStats().entries, 200, "cache size stays capped after overflow insert");
  assert.equal(cacheGet("hash-0"), null, "oldest entry evicted to make room");
  assert.equal(cacheGet("hash-200"), 200, "newest entry present after overflow");
});

test("cacheClear: removes all entries", () => {
  cacheSet("a", 1);
  cacheClear();
  assert.equal(cacheStats().entries, 0);
});
