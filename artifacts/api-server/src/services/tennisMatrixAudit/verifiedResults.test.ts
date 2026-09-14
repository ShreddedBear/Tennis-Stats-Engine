// ----------------------------------------------------------------------------
// Importing verified results, and what must NOT be imported.
//
// This is the one place where an over-eager parser corrupts the record permanently: a wrong
// winner written onto a match turns every later "correct/incorrect" colour on that row into
// a lie, and nothing downstream can detect it. So most of these tests are about refusing.
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { parseDocumentDate, parseVerifiedResults } from "./verifiedResults.js";

/** The document's real layout: columns separated by runs of whitespace. */
const row = (match: string, date: string, winner: string, event: string) =>
  `${match}   ${date}   ${winner}   ${event}`;

const page = (...lines: string[]) => ["Match   Date   Winner   Event", ...lines].join("\n");

describe("reading the verified-winners document", () => {
  test("a normal row is parsed into players, date, winner and event", () => {
    const parsed = parseVerifiedResults([page(
      row("Alex Michelsen vs Federico Cina", "August 30, 2026", "Alex Michelsen", "US Open Men Singles"),
    )]);
    assert.equal(parsed.rows.length, 1);
    assert.deepEqual(parsed.rows[0], {
      player1: "Alex Michelsen", player2: "Federico Cina",
      winner: "Alex Michelsen", date: "2026-08-30", event: "US Open Men Singles",
    });
  });

  test("the header row is not mistaken for data", () => {
    assert.equal(parseVerifiedResults([page()]).rows.length, 0);
  });

  test("document dates convert, and an unreadable one is not guessed", () => {
    assert.equal(parseDocumentDate("September 13, 2026"), "2026-09-13");
    assert.equal(parseDocumentDate("August 3, 2026"), "2026-08-03");
    assert.equal(parseDocumentDate("2026-08-03"), "2026-08-03");
    assert.equal(parseDocumentDate("Smarch 40, 2026"), null);
  });

  test("a winner in the second position is read correctly", () => {
    const parsed = parseVerifiedResults([page(
      row("Alycia Parks vs Taylah Preston", "August 30, 2026", "Taylah Preston", "US Open Women Singles"),
    )]);
    assert.equal(parsed.rows[0]?.winner, "Taylah Preston");
  });
});

describe("what must not be imported", () => {
  test("NOT VERIFIED records nothing at all", () => {
    const parsed = parseVerifiedResults([page(
      row("Luca Sanchez vs David de Jonge", "September 13, 2026", "NOT VERIFIED", "ATP Challenger Rennes"),
    )]);
    // An unknown result is not a result. Writing one would turn a gap into a false fact.
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.unverified.length, 1);
  });

  test("a winner matching neither player is reported, not resolved", () => {
    const parsed = parseVerifiedResults([page(
      row("Alex Michelsen vs Federico Cina", "August 30, 2026", "Novak Djokovic", "US Open Men Singles"),
    )]);
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.inconsistent.length, 1);
    assert.match(parsed.inconsistent[0]!.problem, /matches neither/);
  });

  test("a shared surname with CONFLICTING given names is refused", () => {
    // The real defect in the source document: the match lists Dimitris Sakellaridis, the
    // winner column says Stefanos Sakellaridis. The engine's name matcher is surname-tolerant
    // by design, so without this check the contradiction would be imported as fact.
    const parsed = parseVerifiedResults([page(
      row("Lorenzo Beraldo vs Dimitris Sakellaridis", "September 13, 2026", "Stefanos Sakellaridis", "ATP Challenger Biella"),
    )]);
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.inconsistent.length, 1);
    assert.match(parsed.inconsistent[0]!.problem, /given names differ/);
  });

  test("a merely SHORTER name is not a conflict", () => {
    // "Sinner" vs "Jannik Sinner" states no contradicting given name, so it imports.
    const parsed = parseVerifiedResults([page(
      row("Jannik Sinner vs Carlos Alcaraz", "August 30, 2026", "Sinner", "US Open Men Singles"),
    )]);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.inconsistent.length, 0);
  });

  test("an added middle name is not a conflict", () => {
    const parsed = parseVerifiedResults([page(
      row("Matthew William Donald vs Giovanni Oradini", "September 13, 2026", "Matthew Donald", "ATP Challenger Biella"),
    )]);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.inconsistent.length, 0);
  });

  test("every row is accounted for in exactly one bucket", () => {
    const parsed = parseVerifiedResults([page(
      row("A One vs B Two", "August 30, 2026", "A One", "Event"),
      row("C Three vs D Four", "August 30, 2026", "NOT VERIFIED", "Event"),
      row("E Five vs F Six", "August 30, 2026", "Z Nine", "Event"),
    )]);
    // Nothing may be silently dropped: a row that vanishes is a result nobody knows is missing.
    assert.equal(parsed.rows.length + parsed.unverified.length + parsed.inconsistent.length, 3);
  });
});
