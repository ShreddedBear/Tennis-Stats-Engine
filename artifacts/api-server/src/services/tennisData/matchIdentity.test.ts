import test from "node:test";
import assert from "node:assert/strict";
import { buildMatchIdentityKey } from "./matchIdentity.js";

test("buildMatchIdentityKey: same match key regardless of player1/player2 order", () => {
  const a = buildMatchIdentityKey("2026-03-01", "Carlos Alcaraz", "Novak Djokovic");
  const b = buildMatchIdentityKey("2026-03-01", "Novak Djokovic", "Carlos Alcaraz");
  assert.equal(a, b);
});

test("buildMatchIdentityKey: same match key across accent/whitespace/case variants", () => {
  const a = buildMatchIdentityKey("2026-03-01", "Novak Djokovic", "Rafael Nadal");
  const b = buildMatchIdentityKey("2026-03-01", "  NOVAK   DJOKOVIC  ", "rafael nadal");
  assert.equal(a, b);

  // Diacritics fold the same way normalizePlayerName already does for cross-provider player
  // matching elsewhere in this codebase (see playerIdentity.nameMatch.test.ts).
  const c = buildMatchIdentityKey("2026-03-01", "Nadal Ráfaél", "Novak Đoković");
  const d = buildMatchIdentityKey("2026-03-01", "nadal rafael", "novak dokovic");
  assert.equal(c, d);
});

test("buildMatchIdentityKey: different dates never collide", () => {
  const a = buildMatchIdentityKey("2026-03-01", "Carlos Alcaraz", "Novak Djokovic");
  const b = buildMatchIdentityKey("2026-03-02", "Carlos Alcaraz", "Novak Djokovic");
  assert.notEqual(a, b);
});

test("buildMatchIdentityKey: different player pairs never collide", () => {
  const a = buildMatchIdentityKey("2026-03-01", "Carlos Alcaraz", "Novak Djokovic");
  const b = buildMatchIdentityKey("2026-03-01", "Carlos Alcaraz", "Rafael Nadal");
  assert.notEqual(a, b);
});
