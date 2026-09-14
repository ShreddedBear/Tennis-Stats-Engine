// ----------------------------------------------------------------------------
// Summary-ingestion identity tests.
//
// These cover the one thing in ingestion that is a data-integrity concern rather than a
// convenience: deciding when two parses describe the SAME match. Getting it wrong in either
// direction is silent corruption -- merging two different matches destroys one of them, and
// splitting one match in two puts half its evidence on a row nobody looks at.
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ParsedMatchup } from "@workspace/truth-engine";
import { dedupeMatchups } from "./ingest-identity.js";

const field = (key: string, value: string) => ({
  field_key: key,
  raw_value: value,
  normalized_value: value,
  extraction_status: "DIRECT" as const,
  confidence: 1,
  page_number: 1,
});

const matchup = (p1: string, p2: string, fields: Array<[string, string]> = [], page = 1): ParsedMatchup => ({
  player1_name: p1,
  player2_name: p2,
  page_number: page,
  confidence: 1,
  fields: fields.map(([key, value]) => field(key, value)),
});

test("a truncated printing and its full form are the same player", () => {
  const rows = dedupeMatchups([
    matchup("Zverev", "Alcaraz"),
    matchup("Mischa Zverev", "Carlos Alcaraz"),
  ]);
  assert.equal(rows.length, 1);
  // The longer spelling survives: nothing downstream re-derives player names.
  assert.equal(rows[0]!.player1_name, "Mischa Zverev");
  assert.equal(rows[0]!.player2_name, "Carlos Alcaraz");
});

test("a trailing compound surname is treated as a different player", () => {
  // A known and accepted limitation of matching on the final token: "Carlos Alcaraz" and
  // "Carlos Alcaraz Garfia" stage separately. Left conservative rather than loosened,
  // because loosening the final-token rule is what would start merging genuinely different
  // players. The review step is where an operator collapses these by correcting the name.
  const rows = dedupeMatchups([
    matchup("Carlos Alcaraz", "Jannik Sinner"),
    matchup("Carlos Alcaraz Garfia", "Jannik Sinner"),
  ]);
  assert.equal(rows.length, 2);
});

test("a bare initial is NOT merged into a full first name", () => {
  // Conservative on purpose: "M. Zverev" is genuinely ambiguous between brothers. A wrong
  // merge destroys a match; a wrong split is visible in review and fixed by editing the
  // name before committing.
  const rows = dedupeMatchups([matchup("M. Zverev", "Carlos Alcaraz"), matchup("Mischa Zverev", "Carlos Alcaraz")]);
  assert.equal(rows.length, 2);
});

test("two siblings sharing a surname are NOT merged", () => {
  const rows = dedupeMatchups([
    matchup("Mischa Zverev", "Carlos Alcaraz"),
    matchup("Alexander Zverev", "Carlos Alcaraz"),
  ]);
  assert.equal(rows.length, 2);
});

test("different surnames are never the same player", () => {
  const rows = dedupeMatchups([matchup("A. Rublev", "C. Alcaraz"), matchup("A. Zverev", "C. Alcaraz")]);
  assert.equal(rows.length, 2);
});

test("the same matchup printed with the sides swapped is one match", () => {
  const rows = dedupeMatchups([matchup("Carlos Alcaraz", "Jannik Sinner"), matchup("Jannik Sinner", "Carlos Alcaraz")]);
  assert.equal(rows.length, 1);
});

test("a second printing that omitted context does not create a second staged match", () => {
  // The canonical key includes tournament/round/date. Keying the in-upload dedupe on it
  // would leave this pair staged twice, which is why grouping is by pair.
  const rows = dedupeMatchups([
    matchup("Carlos Alcaraz", "Jannik Sinner", [["tournament", "Roland Garros"], ["round", "SF"]]),
    matchup("Carlos Alcaraz", "Jannik Sinner"),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fields.find((f) => f.field_key === "tournament")?.normalized_value, "Roland Garros");
});

test("merging fills gaps without overwriting context that was already parsed", () => {
  const rows = dedupeMatchups([
    matchup("Carlos Alcaraz", "Jannik Sinner", [["tournament", "Roland Garros"], ["round", "SF"]]),
    matchup("Alcaraz", "Sinner", [["tournament", "WRONG"], ["surface", "Clay"]]),
  ]);
  assert.equal(rows.length, 1);
  const value = (key: string) => rows[0]!.fields.find((f) => f.field_key === key)?.normalized_value;
  assert.equal(value("tournament"), "Roland Garros");
  assert.equal(value("round"), "SF");
  // The gap the richer parse left is filled from the poorer one rather than dropped.
  assert.equal(value("surface"), "Clay");
});

test("the richer parse becomes the base even when it arrives second", () => {
  const rows = dedupeMatchups([
    matchup("Alcaraz", "Sinner", [], 7),
    matchup("Carlos Alcaraz", "Jannik Sinner", [["tournament", "Roland Garros"], ["surface", "Clay"], ["round", "SF"]], 2),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.page_number, 2);
});

test("distinct matches in one upload all survive", () => {
  const rows = dedupeMatchups([
    matchup("Carlos Alcaraz", "Jannik Sinner"),
    matchup("Iga Swiatek", "Aryna Sabalenka"),
    matchup("Novak Djokovic", "Daniil Medvedev"),
  ]);
  assert.equal(rows.length, 3);
});

test("an empty or unparsed name is never treated as a player match", () => {
  const rows = dedupeMatchups([matchup("", "Jannik Sinner"), matchup("", "Carlos Alcaraz")]);
  assert.equal(rows.length, 2);
});
