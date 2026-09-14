// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — match identity for summary ingestion.
//
// Pure functions, no database, so the rules that decide "is this the same match?" can be
// tested directly. Getting this wrong in either direction is silent corruption: merging two
// different matches destroys one of them, and splitting one match in two puts half its
// evidence on a row nobody looks at.
// ----------------------------------------------------------------------------
import { normalizeName, type ParsedMatchup } from "@workspace/truth-engine";

/** The context fields a reviewer can see and correct before a parse is committed. */
export const REVIEW_FIELDS = ["tournament", "event_level", "round", "scheduled_date", "surface", "best_of"];

export const fieldValue = (matchup: ParsedMatchup, key: string) =>
  matchup.fields.find((field) => field.field_key === key)?.normalized_value ?? "";

export const nameTokens = (name: string) => normalizeName(name).split(" ").filter(Boolean);

/**
 * Whether two spellings are the same player.
 *
 * Not string equality, deliberately: one summary prints "Alcaraz", another "Carlos Alcaraz",
 * and a third "Carlos Alcaraz Garfia". Surname must agree, and beyond that the shorter
 * name's tokens must all appear in the longer one (or two tokens must overlap). That keeps
 * two SIBLINGS apart -- "Mischa Zverev" and "Alexander Zverev" share a surname but neither
 * first name contains the other -- while still consolidating a truncated printing with its
 * full form.
 *
 * A BARE INITIAL is deliberately NOT merged: "M. Zverev" tokenises to "m", which is not the
 * token "mischa", so it stays separate from "Mischa Zverev". This is the conservative
 * direction and it is intentional -- "M. Zverev" is genuinely ambiguous between brothers,
 * and a wrong merge destroys a match while a wrong split is visible in the review step and
 * fixed by correcting the name there before committing.
 */
function samePlayer(a: string, b: string): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  if (x[x.length - 1] !== y[y.length - 1]) return false;
  const sx = new Set(x);
  const sy = new Set(y);
  const overlap = [...sx].filter((token) => sy.has(token)).length;
  const shorter = Math.min(sx.size, sy.size);
  return overlap === shorter || overlap >= Math.min(2, shorter);
}

/** Two parses describe the same pair if their players agree in either order. */
export function samePair(a1: string, a2: string, b1: string, b2: string): boolean {
  return (samePlayer(a1, b1) && samePlayer(a2, b2)) || (samePlayer(a1, b2) && samePlayer(a2, b1));
}

const clean = (value: string | null | undefined) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Absent context never contradicts present context, and one value containing the other is
 * agreement, not conflict -- "Roland Garros" and "Roland Garros - Paris" are the same event
 * written two ways, and treating them as a conflict would create a duplicate match row.
 */
export function compatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = clean(a);
  const y = clean(b);
  return !x || !y || x === y || x.includes(y) || y.includes(x);
}

/** How much usable context a parse carries. Context fields dominate; ties break on detail. */
function richness(matchup: ParsedMatchup): number {
  const contextFields = REVIEW_FIELDS.filter((key) =>
    matchup.fields.some((field) => field.field_key === key && field.normalized_value),
  ).length;
  return (
    contextFields +
    matchup.fields.length * 0.01 +
    matchup.player1_name.split(" ").length * 0.001 +
    matchup.player2_name.split(" ").length * 0.001
  );
}

/**
 * Combine two parses of the same match. The richer parse is the base; the other one only
 * fills gaps. Nothing already present is overwritten, and the longer spelling of each name
 * wins -- "Mischa Zverev" survives a second page that printed "M. Zverev".
 */
function mergeParsed(a: ParsedMatchup, b: ParsedMatchup): ParsedMatchup {
  const primary = richness(b) > richness(a) ? b : a;
  const secondary = primary === a ? b : a;
  const fields = [...primary.fields];
  for (const field of secondary.fields) {
    if (!fields.some((existing) => existing.field_key === field.field_key && existing.normalized_value)) {
      fields.push(field);
    }
  }
  const longer = (x: string, y: string) => (nameTokens(y).length > nameTokens(x).length ? y : x);
  return {
    ...primary,
    player1_name: longer(primary.player1_name, secondary.player1_name),
    player2_name: longer(primary.player2_name, secondary.player2_name),
    fields,
  };
}

/**
 * Consolidate repeated parses of one match within an upload. Grouping is by PAIR, not by
 * canonical key: the key includes context that a second printing of the same matchup may
 * have omitted, so keying on it would leave the same match staged twice.
 */
export function dedupeMatchups(matchups: ParsedMatchup[]): ParsedMatchup[] {
  const out: ParsedMatchup[] = [];
  for (const matchup of matchups) {
    const index = out.findIndex((existing) =>
      samePair(existing.player1_name, existing.player2_name, matchup.player1_name, matchup.player2_name),
    );
    if (index < 0) out.push(matchup);
    else out[index] = mergeParsed(out[index]!, matchup);
  }
  return out;
}

