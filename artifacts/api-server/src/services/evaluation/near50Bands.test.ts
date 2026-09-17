import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNear50, tallyNear50Bands } from "./near50Bands";

test("classifyNear50: exactly 50 is inside every band", () => {
  const bands = classifyNear50(50);
  assert.deepEqual(bands, { exact50: true, within49to51: true, within48to52: true, within47to53: true });
});

test("classifyNear50: 50.5 is inside 49-51/48-52/47-53 but not exact50", () => {
  const bands = classifyNear50(50.5);
  assert.deepEqual(bands, { exact50: false, within49to51: true, within48to52: true, within47to53: true });
});

test("classifyNear50: 51.5 is inside 48-52/47-53 but not 49-51 or exact50", () => {
  const bands = classifyNear50(51.5);
  assert.deepEqual(bands, { exact50: false, within49to51: false, within48to52: true, within47to53: true });
});

test("classifyNear50: 52.9 is inside only 47-53", () => {
  const bands = classifyNear50(52.9);
  assert.deepEqual(bands, { exact50: false, within49to51: false, within48to52: false, within47to53: true });
});

test("classifyNear50: 53.1 is outside every band", () => {
  const bands = classifyNear50(53.1);
  assert.deepEqual(bands, { exact50: false, within49to51: false, within48to52: false, within47to53: false });
});

test("classifyNear50: boundary values are inclusive (49.0, 51.0, 48.0, 52.0, 47.0, 53.0)", () => {
  for (const p of [49.0, 51.0]) assert.equal(classifyNear50(p).within49to51, true, `${p} should be inside 49-51`);
  for (const p of [48.0, 52.0]) assert.equal(classifyNear50(p).within48to52, true, `${p} should be inside 48-52`);
  for (const p of [47.0, 53.0]) assert.equal(classifyNear50(p).within47to53, true, `${p} should be inside 47-53`);
});

test("classifyNear50: symmetric around 50 (player-swap orientation should not matter)", () => {
  assert.deepEqual(classifyNear50(48.5), classifyNear50(51.5));
  assert.deepEqual(classifyNear50(47.2), classifyNear50(52.8));
});

test("tallyNear50Bands: counts each band independently and never fabricates a value for missing input", () => {
  const counts = tallyNear50Bands([50, 50.9, 51.5, 52.9, 60, null, undefined, NaN]);
  // Only 5 of the 8 inputs are finite numbers -- n must reflect that, not 8.
  assert.equal(counts.n, 5);
  assert.equal(counts.exact50, 1); // 50
  assert.equal(counts.within49to51, 2); // 50, 50.9
  assert.equal(counts.within48to52, 3); // 50, 50.9, 51.5
  assert.equal(counts.within47to53, 4); // 50, 50.9, 51.5, 52.9 (60 excluded)
});

test("tallyNear50Bands: empty input produces all-zero counts, not null/undefined", () => {
  const counts = tallyNear50Bands([]);
  assert.deepEqual(counts, { n: 0, exact50: 0, within49to51: 0, within48to52: 0, within47to53: 0 });
});
