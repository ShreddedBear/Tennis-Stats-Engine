// Deterministic parser for the master audit documents.
// Documents are numbered-section documents: lines like "12. Section Title".
// A section becomes one rule. Completeness is computed, never asserted.

export interface ParsedRule {
  rule_code: string;
  rule_name: string;
  category: string | null;
  body: string;
  severity: string;
  blocking: boolean;
  mapping_status: "MAPPED" | "REQUIRES HUMAN RULE MAPPING";
}

export interface ParseReport {
  pages_detected: number;
  headings_detected: number;
  expected_rules: number;
  parsed_rules: number;
  unmapped_rules: number;
  unparsed_text_chars: number;
  parser_confidence: number;
  rules: ParsedRule[];
  ambiguous: string[];
}

const HEADING = /^\s*(\d{1,3})\.\s+(\S.*)$/;

// A section is "machine mapped" when it contains an explicit threshold or a
// deterministic keyword the engine can evaluate. Everything else must be
// mapped by a human before it can be executed as logic.
const MAPPABLE = /(<=|>=|\d+\s*%|\bat least\b|\bnever\b|\bmust\b|\bautomatic\b|\bcannot\b)/i;
const BLOCKING = /(never green|automatic pass|red|veto|blocked|cannot be green|hard rule|no green)/i;
const CRITICAL = /(critical|hard rule|veto|automatic)/i;

export function parseRuleDocument(text: string): ParseReport {
  const pages = Math.max(1, (text.match(/\f/g) || []).length + 1);
  const lines = text.split(/\r?\n/);

  const headingIdx: number[] = [];
  let last = 0;
  lines.forEach((line, i) => {
    const m = line.match(HEADING);
    if (!m) return;
    const n = Number(m[1]);
    // Sequential numbering only — avoids treating list fragments as headings.
    if (n === last + 1 || (n === 1 && last === 0)) {
      headingIdx.push(i);
      last = n;
    }
  });

  const rules: ParsedRule[] = [];
  const ambiguous: string[] = [];
  let consumed = 0;

  headingIdx.forEach((start, k) => {
    const end = headingIdx[k + 1] ?? lines.length;
    const m = (lines[start] ?? "").match(HEADING);
    if (!m) return;
    const num = m[1] ?? "";
    const title = m[2] ?? "";
    const body = lines
      .slice(start + 1, end)
      .join("\n")
      .trim();
    consumed += lines.slice(start, end).join("\n").length;
    const name = title.replace(/\s+/g, " ").trim();
    if (!name) {
      ambiguous.push(`Section ${num} has no title`);
      return;
    }
    rules.push({
      rule_code: num.padStart(3, "0"),
      rule_name: name,
      category: null,
      body,
      severity: CRITICAL.test(name + body) ? "CRITICAL" : "STANDARD",
      blocking: BLOCKING.test(name + body),
      mapping_status: MAPPABLE.test(body) ? "MAPPED" : "REQUIRES HUMAN RULE MAPPING",
    });
  });


  const expected = headingIdx.length;
  const parsed = rules.length;
  const unmapped = rules.filter((r) => r.mapping_status !== "MAPPED").length;
  const unparsed = Math.max(0, text.length - consumed);
  const confidence = expected === 0 ? 0 : Number((parsed / expected).toFixed(4));

  return {
    pages_detected: pages,
    headings_detected: expected,
    expected_rules: expected,
    parsed_rules: parsed,
    unmapped_rules: unmapped,
    unparsed_text_chars: unparsed,
    parser_confidence: confidence,
    rules,
    ambiguous,
  };
}

// A version may only be activated when every detected section became a rule.
export function activationStatus(r: ParseReport): "READY" | "BLOCKED" {
  return r.expected_rules > 0 && r.parsed_rules === r.expected_rules ? "READY" : "BLOCKED";
}
