import { describe, expect, it } from "vitest";
import { canonicalKey, normalizeName, parseSummaryText } from "./summary-parser";

function fieldMap(fields: Array<{ field_key: string; normalized_value: string | null }>) {
  return Object.fromEntries(fields.map((f) => [f.field_key, f.normalized_value]));
}

describe("summary-parser", () => {
  it("extracts a matchup and its labelled fields from a plain-text page", () => {
    const page = [
      "Roman Andres Burruchaga vs Moise Kouame",
      "Tournament: US Open Qualifying",
      "Round: Q1",
      "Surface: Hard",
      "Predicted Winner: Roman Andres Burruchaga",
      "Win Probability: 56.7%",
    ].join("\n");
    const matchups = parseSummaryText([page]);
    expect(matchups).toHaveLength(1);
    expect(matchups[0].player1_name).toBe("Roman Andres Burruchaga");
    expect(matchups[0].player2_name).toBe("Moise Kouame");
    const flat = fieldMap(matchups[0].fields);
    expect(flat.matrix_predicted_winner).toBe("Roman Andres Burruchaga");
    expect(flat.matrix_wp).toBe("56.7");
    expect(flat.surface).toBe("Hard");
  });

  // Best-effort top-level scalar extraction for the OCR/text-layer path -- see the
  // header comment on FIELD_PATTERNS in summary-parser.ts. The dense per-module "Full
  // Engine Breakdown" content is vision-only and is not attempted here.
  it("best-effort extracts confidence/agreement labels and Monte Carlo scalars when printed as clean labelled text", () => {
    const page = [
      "Sebastian Baez vs Camilo Ugo Carabelli",
      "range 21-99",
      "HIGH CONFIDENCE",
      "STRONGLY AGREE",
      "Expected sets: 2.4",
      "Simulations: 10000",
    ].join("\n");
    const matchups = parseSummaryText([page]);
    const flat = fieldMap(matchups[0].fields);
    expect(flat.matrix_wp_range).toBe("21-99");
    expect(flat.matrix_confidence_label?.toLowerCase()).toBe("high confidence");
    expect(flat.matrix_agreement_label?.toLowerCase()).toBe("strongly agree");
    expect(flat.monte_carlo_expected_sets).toBe("2.4");
    expect(flat.monte_carlo_simulations).toBe("10000");
  });

  it("never fabricates a field that isn't present in the text", () => {
    const page = "Alice Alpha vs Bob Beta";
    const matchups = parseSummaryText([page]);
    const flat = fieldMap(matchups[0].fields);
    expect(flat.matrix_wp).toBeUndefined();
    expect(flat.matrix_confidence_label).toBeUndefined();
    expect(flat.monte_carlo_simulations).toBeUndefined();
  });

  it("does not synthesize a matchup from a page with no player-pair signal", () => {
    const page = "Tournament: US Open Qualifying\nSurface: Hard";
    expect(parseSummaryText([page])).toEqual([]);
  });

  it("canonicalKey ignores player order and is stable under accent/case differences", () => {
    const a = canonicalKey({ tournament: "US Open", round: "R32", date: "2026-08-27", p1: "Roman Andres Burruchaga", p2: "Moise Kouamé" });
    const b = canonicalKey({ tournament: "us open", round: "r32", date: "2026-08-27", p1: "moise kouame", p2: "Roman Andres Burruchaga" });
    expect(a).toBe(b);
  });

  it("normalizeName strips accents and punctuation", () => {
    expect(normalizeName("Moise Kouamé")).toBe("moise kouame");
  });
});

// Fixtures mirror real betting-card PDFs uploaded through the app: a "X vs Y"
// title line, a "Today @ h:mmam/pm · TOURNAMENT" subtitle, two "Name ... odds"
// rows, and a "$N vol" footer. OCR of the flag/rank icon beside each name
// commonly glues 1-2 stray letters onto the real name (e.g. "s K Oliver
// Tarvet"), and the subtitle's schedule prefix used to leak into the
// tournament field. These fixtures pin both bugs closed.
describe("summary-parser OCR fixture regressions", () => {
  it("strips the schedule prefix from the tournament field and still detects the tour", () => {
    const page = [
      "Tarvet vs Hudd",
      "Today @ 8:10am · ATP Challenger Roehampton 2",
      "Oliver Tarvet -720",
      "Emile Hudd +573",
      "$5,139 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    expect(matchup.player1_name).toBe("Oliver Tarvet");
    expect(matchup.player2_name).toBe("Emile Hudd");
    const tournament = matchup.fields.find((f) => f.field_key === "tournament")?.normalized_value;
    expect(tournament).toBe("ATP Challenger Roehampton 2");
    expect(matchup.fields.find((f) => f.field_key === "event_level")?.normalized_value).toBe("Challenger");
  });

  it("handles OCR truncating 'Today' down to 'day' with a period instead of a middot", () => {
    // Exact shape observed from a real uploaded PDF's OCR output.
    const page = [
      "Basing vs Broom",
      "day @ 8:18am. ATP Challenger Roehampton 2",
      "Charles Broom",
      "Max Basing",
      "$1,424 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    const tournament = matchup.fields.find((f) => f.field_key === "tournament")?.normalized_value;
    expect(tournament).toBe("ATP Challenger Roehampton 2");
    expect(matchup.fields.find((f) => f.field_key === "event_level")?.normalized_value).toBe("Challenger");
  });

  it("still detects WTA/ATP event level once the schedule prefix no longer blocks the start-anchored check", () => {
    const page = [
      "Starodubtseva vs Mertens",
      "Today @ 10:40pm - WTA Monterrey",
      "Elina Starodubtseva -150",
      "Elise Mertens +120",
      "$2,000 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    const tournament = matchup.fields.find((f) => f.field_key === "tournament")?.normalized_value;
    expect(tournament).toBe("WTA Monterrey");
    expect(matchup.fields.find((f) => f.field_key === "event_level")?.normalized_value).toBe("WTA");
  });

  it("drops an OCR icon-glyph prefix glued onto a player name instead of keeping it as a fake extra name token", () => {
    const page = [
      "Tarvet vs Hudd",
      "Today @ 8:10am · ATP Challenger Roehampton 2",
      "s K Oliver Tarvet",
      "s 4 Emile Hudd",
      "$5,139 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    expect(matchup.player1_name).toBe("Oliver Tarvet");
    expect(matchup.player2_name).toBe("Emile Hudd");
  });

  it("also strips a two-letter icon-glyph prefix and normalizes stray lowercase from OCR", () => {
    const page = [
      "Tarvet vs Hudd",
      "Today @ 8:10am · ATP Challenger Roehampton 2",
      "NE oliver Tarvet",
      "SH emile Hudd",
      "$5,139 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    expect(matchup.player1_name).toBe("Oliver Tarvet");
    expect(matchup.player2_name).toBe("Emile Hudd");
  });

  it("does not corrupt a real two-word name with a genuinely short first name", () => {
    const page = [
      "Jo vs Konta",
      "Today @ 6:00pm · WTA Monterrey",
      "Jo Durie",
      "Ana Konta",
      "$800 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    expect(matchup.player1_name).toBe("Jo Durie");
    expect(matchup.player2_name).toBe("Ana Konta");
  });

  it("preserves apostrophes and hyphens in surnames through title-casing", () => {
    const page = [
      "O'Connor vs Auger-Aliassime",
      "Today @ 6:00pm · ATP Winston Salem",
      "shane O'Connor",
      "felix AUGER-ALIASSIME",
      "$1,200 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    expect(matchup.player1_name).toBe("Shane O'Connor");
    expect(matchup.player2_name).toBe("Felix Auger-Aliassime");
  });

  it("does not treat two section headings joined by a stray dash as a matchup", () => {
    // Real OCR noise from a dense multi-section match-report screenshot: two
    // unrelated headings ended up on adjacent lines with a stray dash-like
    // artifact between them (table border/divider misread by OCR).
    const page = [
      "Model Votes",
      "— Monte Carlo Simulation",
      "38.6% 27.6%",
    ].join("\n");
    expect(parseSummaryText([page])).toEqual([]);
  });

  it("no longer treats a bare em/en-dash as equivalent to the word 'vs'", () => {
    // A real "Player1 vs Player2" title always spells out "vs" in every
    // fixture observed (betting cards and the app's own reports alike); a
    // bare dash was previously accepted too, which is what let noisy OCR
    // register unrelated headings as a fake matchup. This locks in the
    // narrower, deliberate behavior.
    expect(parseSummaryText(["Oliver Tarvet — Emile Hudd"])).toEqual([]);
    expect(parseSummaryText(["Oliver Tarvet vs Emile Hudd"])[0]?.player1_name).toBe("Oliver Tarvet");
  });

  it("rejects a 'vs' anchor when a nearby name-shaped line is actually a known report section heading", () => {
    const page = [
      "Roman Safiullin vs Model Votes",
      "Today @ 6:00pm · ATP Winston Salem",
    ].join("\n");
    expect(parseSummaryText([page])).toEqual([]);
  });

  it("resolves a compound three-word given name without treating the extra word as noise", () => {
    const page = [
      "Cerundolo vs Buse",
      "Today @ 4:00pm · ATP Winston Salem",
      "Juan Manuel Cerundolo -132",
      "Ignacio Buse +105",
      "$24,773 vol",
    ].join("\n");
    const [matchup] = parseSummaryText([page]);
    expect(matchup.player1_name).toBe("Juan Manuel Cerundolo");
    expect(matchup.player2_name).toBe("Ignacio Buse");
  });
});

describe("normalizeName / canonicalKey", () => {
  it("normalizes accents and case for identity comparison", () => {
    expect(normalizeName("Félix Auger-Aliassime")).toBe("felix augeraliassime");
  });
  it("builds an order-independent canonical key for a pair", () => {
    const a = canonicalKey({ tournament: "ATP Winston Salem", round: null, date: "2026-08-27", p1: "Juan Manuel Cerundolo", p2: "Ignacio Buse" });
    const b = canonicalKey({ tournament: "ATP Winston Salem", round: null, date: "2026-08-27", p1: "Ignacio Buse", p2: "Juan Manuel Cerundolo" });
    expect(a).toBe(b);
  });
});
