import { describe, expect, it } from "vitest";
import {
  META_OR_NON_PLAYER_CODES,
  PROTECTED_UNAVAILABLE_CODES,
  UNKNOWN_REQUIRES_REVIEW_CODES,
  META_OR_NON_PLAYER_RECORDS,
  PROTECTED_UNAVAILABLE_RECORDS,
  classificationRecordFor,
  classifyMetric,
  metricUniverseAccounting,
  playerEvidenceDenominatorCodes,
} from "./metric-classification";

const ALL_CODES = Array.from({ length: 81 }, (_, i) => String(i + 1).padStart(3, "0"));

describe("canonical metric classification registry", () => {
  it("keeps META_OR_NON_PLAYER, PROTECTED_UNAVAILABLE, and UNKNOWN_REQUIRES_REVIEW mutually exclusive", () => {
    const sets = [META_OR_NON_PLAYER_CODES, PROTECTED_UNAVAILABLE_CODES, UNKNOWN_REQUIRES_REVIEW_CODES];
    for (const code of ALL_CODES) {
      const memberships = sets.filter((set) => set.has(code)).length;
      expect(memberships).toBeLessThanOrEqual(1);
    }
  });

  it("excludes META_OR_NON_PLAYER and PROTECTED_UNAVAILABLE from the player evidence denominator", () => {
    const denominator = new Set(playerEvidenceDenominatorCodes());
    for (const code of META_OR_NON_PLAYER_CODES) expect(denominator.has(code)).toBe(false);
    for (const code of PROTECTED_UNAVAILABLE_CODES) expect(denominator.has(code)).toBe(false);
  });

  it("keeps UNKNOWN_REQUIRES_REVIEW metrics IN the player evidence denominator (burden of proof not met)", () => {
    const denominator = new Set(playerEvidenceDenominatorCodes());
    for (const code of UNKNOWN_REQUIRES_REVIEW_CODES) expect(denominator.has(code)).toBe(true);
  });

  it("ACTIVE denominator equals 81 minus meta minus protected minus Matrix-Summary-quarantined", () => {
    const accounting = metricUniverseAccounting();
    expect(playerEvidenceDenominatorCodes()).toHaveLength(accounting.legitimate_player_metric_count);
    expect(accounting.legitimate_player_metric_count).toBe(
      81 - accounting.meta_or_non_player_count - accounting.protected_unavailable_count - accounting.matrix_summary_required_count,
    );
    // The quarantine withholds codes from the ACTIVE denominator without shrinking the
    // player-metric universe: reactivating all of them restores the prior 60.
    expect(accounting.legitimate_player_metric_count_including_quarantined).toBe(
      81 - accounting.meta_or_non_player_count - accounting.protected_unavailable_count,
    );
    expect(accounting.legitimate_player_metric_count_including_quarantined).toBe(60);
  });

  it("does not classify known-recoverable metrics as excluded (guards against over-exclusion)", () => {
    // Directly PBP-reconstructable codes that must never be quietly moved out of the
    // player metric universe. "026" was removed from this list when it was quarantined
    // pending Tennis Matrix AI Summary evidence (docs/audit-task-matrix-summary-quarantine.md)
    // -- that is a deliberate, reversible withholding from the ACTIVE denominator, asserted
    // in matrix-summary-quarantine.test.ts, not the silent over-exclusion this guards against.
    for (const code of ["002", "005", "006", "009", "014", "021", "027", "031", "032"]) {
      expect(classifyMetric(code)).toBe("LEGITIMATE_PLAYER_METRIC");
    }
  });

  it("no Matrix-Summary quarantine leaks into the META or PROTECTED buckets", () => {
    // The quarantine must stay its own auditable bucket: a reversible "not in the Truth
    // Engine yet" state must never be recorded as a permanent no-pathway determination.
    const accounting = metricUniverseAccounting();
    for (const code of accounting.matrix_summary_required_codes) {
      expect(accounting.meta_or_non_player_codes).not.toContain(code);
      expect(accounting.protected_unavailable_codes).not.toContain(code);
      expect(classifyMetric(code)).toBe("MATRIX_SUMMARY_REQUIRED");
    }
  });

  it("every META_OR_NON_PLAYER and PROTECTED_UNAVAILABLE record carries a complete, non-fabricated audit trail", () => {
    for (const record of [...META_OR_NON_PLAYER_RECORDS, ...PROTECTED_UNAVAILABLE_RECORDS]) {
      expect(record.reason.length).toBeGreaterThan(20);
      expect(record.sources_checked.length).toBeGreaterThan(0);
      expect(record.date_classified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(record.review_status).toBe("REVIEWED");
      // A record must not claim reconstruction was attempted without a result, or vice versa.
      if (record.reconstruction_attempted) expect(record.reconstruction_result.length).toBeGreaterThan(0);
    }
  });

  it("does not allow a classification to exist solely to inflate coverage — every exclusion documents required_raw_fields and a reason tied to that field's absence", () => {
    for (const record of [...META_OR_NON_PLAYER_RECORDS, ...PROTECTED_UNAVAILABLE_RECORDS]) {
      expect(record.required_raw_fields.length).toBeGreaterThan(0);
    }
  });

  it("classificationRecordFor returns null for an ordinary legitimate player metric", () => {
    expect(classificationRecordFor("001")).toBeNull();
    expect(classifyMetric("001")).toBe("LEGITIMATE_PLAYER_METRIC");
  });

  it("classifies 059 (Loss Path Probability) as META_OR_NON_PLAYER -- every bullet is framed around why THE PICK loses, not a player fact", () => {
    expect(classifyMetric("059")).toBe("META_OR_NON_PLAYER");
    const record = classificationRecordFor("059");
    expect(record?.review_status).toBe("REVIEWED");
  });

  it("resolves 047 (Uncertainty-Adjusted Advantage) and 061 (Final Advanced Tests -> Historical Twin Match Search) to LEGITIMATE_PLAYER_METRIC -- both had a human classification decision made and now have real engines (see docs/audit-task-047-061-classification-decisions.md)", () => {
    // 047: a confidence-interval treatment applied to two players' own statistics is a
    // player-comparison fact, not a meta-method -- audit-metric-047-uncertainty-adjusted-
    // advantage.ts builds it as a real two-proportion CI-adjusted comparison.
    expect(classifyMetric("047")).toBe("LEGITIMATE_PLAYER_METRIC");
    expect(classificationRecordFor("047")).toBeNull();
    // 061: split into a real Historical Twin Match Search (audit-metric-061-historical-
    // twin-match-search.ts, now what code 061 means) plus a permanently-excluded
    // counterfactual/opponent-upgrade-rerun component that intentionally never gets its own
    // metric code (see final-advanced-meta.server.ts's header).
    expect(classifyMetric("061")).toBe("LEGITIMATE_PLAYER_METRIC");
    expect(classificationRecordFor("061")).toBeNull();
    const denominator = new Set(playerEvidenceDenominatorCodes());
    expect(denominator.has("047")).toBe(true);
    expect(denominator.has("061")).toBe(true);
    expect(UNKNOWN_REQUIRES_REVIEW_CODES.size).toBe(0);
  });

  it("the 10 originally-flagged special metrics each resolve to an explicit classification, not a silent default", () => {
    const flagged = ["017", "029", "048", "063", "065", "066", "067", "072", "074", "078"];
    for (const code of flagged) {
      const record = classificationRecordFor(code);
      // 029 is intentionally NOT excluded: PBP score-state legitimately reconstructs
      // part of its "response after losing X" components, so it stays a normal metric.
      if (code === "029") {
        expect(record).toBeNull();
        expect(classifyMetric(code)).toBe("LEGITIMATE_PLAYER_METRIC");
      } else {
        expect(record).not.toBeNull();
        expect(["META_OR_NON_PLAYER", "PROTECTED_UNAVAILABLE"]).toContain(record!.classification);
      }
    }
  });
});
