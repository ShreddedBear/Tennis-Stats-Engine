import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOcrText } from "./rawTextParser";

/**
 * OCR reliability audit (P0 Package 3) — regression coverage for the OCR.Space raw-text
 * fallback parser, which previously had zero tests. See OCR_RELIABILITY_REPORT.md.
 */

test("parseOcrText: inline 'vs' pattern extracts a clean pair", () => {
  assert.deepEqual(parseOcrText("Novak Djokovic vs Carlos Alcaraz"), [
    { player1Name: "Novak Djokovic", player2Name: "Carlos Alcaraz", eventName: null },
  ]);
});

test("parseOcrText: inline 'def.' pattern extracts a clean pair", () => {
  assert.deepEqual(parseOcrText("Iga Swiatek def. Aryna Sabalenka"), [
    { player1Name: "Iga Swiatek", player2Name: "Aryna Sabalenka", eventName: null },
  ]);
});

test("parseOcrText: consecutive name-like lines (sportsbook layout, no 'vs' keyword) pair up", () => {
  assert.deepEqual(parseOcrText("Rafael Nadal\nDaniil Medvedev\n\n6-4 6-2\nLive"), [
    { player1Name: "Rafael Nadal", player2Name: "Daniil Medvedev", eventName: null },
  ]);
});

test("parseOcrText: malformed/garbage OCR text yields zero matchups, not a crash or bad pair", () => {
  assert.deepEqual(parseOcrText("###\n@#$%\n1\n-\n...\n"), []);
});

test("parseOcrText: a single dangling name with no pair partner yields zero matchups", () => {
  assert.deepEqual(parseOcrText("Novak Djokovic\n\n6-4 6-2 Live"), []);
});

test("parseOcrText: hyphenated multi-word surnames are preserved intact, not truncated", () => {
  assert.deepEqual(parseOcrText("Felix Auger-Aliassime vs Stefanos Tsitsipas"), [
    { player1Name: "Felix Auger-Aliassime", player2Name: "Stefanos Tsitsipas", eventName: null },
  ]);
});

test("parseOcrText: seed-number decorations are stripped from names", () => {
  assert.deepEqual(parseOcrText("(3) Jannik Sinner vs (7) Alexander Zverev"), [
    { player1Name: "Jannik Sinner", player2Name: "Alexander Zverev", eventName: null },
  ]);
});

test("parseOcrText: identical name on both sides of 'vs' is rejected (never a same-player pair)", () => {
  assert.deepEqual(parseOcrText("Novak Djokovic vs Novak Djokovic"), []);
});

test("parseOcrText: multiple stacked matchups on one long/scrollable screenshot are all extracted", () => {
  assert.deepEqual(
    parseOcrText(
      "Novak Djokovic vs Carlos Alcaraz\nIga Swiatek vs Aryna Sabalenka\nRafael Nadal vs Daniil Medvedev",
    ),
    [
      { player1Name: "Novak Djokovic", player2Name: "Carlos Alcaraz", eventName: null },
      { player1Name: "Iga Swiatek", player2Name: "Aryna Sabalenka", eventName: null },
      { player1Name: "Rafael Nadal", player2Name: "Daniil Medvedev", eventName: null },
    ],
  );
});

// --- KNOWN BUG — see OCR_RELIABILITY_REPORT.md "Failure category 1" ---
// SKIP_PATTERNS' month-abbreviation filter (/^(jan|feb|mar|...)/i) is unanchored to word
// boundaries, so it matches on PREFIXES. Any player whose name starts with a month
// abbreviation gets misclassified as a calendar/date line and silently dropped from
// nameLines, breaking the consecutive-name-pairing strategy. Reproduces with the
// world No.1 men's player (Jannik "Jan..." Sinner) as of this writing.
// Un-skip once rawTextParser.ts's SKIP_PATTERNS month regex is anchored to full month names
// or given a trailing word boundary / requires a following date-like token.
test(
  "parseOcrText: player names starting with a month abbreviation are NOT dropped (Jannik Sinner)",
  { skip: "known bug — see OCR_RELIABILITY_REPORT.md; month-prefix regex has no word boundary" },
  () => {
    assert.deepEqual(
      parseOcrText("Moneyline\nCarlos Alcaraz\n-150\nJannik Sinner\n+130\nToday\n3 Markets"),
      [{ player1Name: "Carlos Alcaraz", player2Name: "Jannik Sinner", eventName: null }],
    );
  },
);

test("parseOcrText: sportsbook odds/currency/UI-label noise is filtered, real names still pair (non-month-colliding names)", () => {
  assert.deepEqual(
    parseOcrText("Moneyline\nCarlos Alcaraz\n-150\nTaylor Fritz\n+130\nToday\n3 Markets"),
    [{ player1Name: "Carlos Alcaraz", player2Name: "Taylor Fritz", eventName: null }],
  );
});
