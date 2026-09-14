/**
 * Item 11: trace ONE controlled pair through the point-by-point retrieval chain.
 * history discovery -> qualifying matches -> PBP retrieval -> classification.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { auditDataPath, auditDataRoot, describeTally, emptyTally, fetchPbpClassified, recordOutcome, pbpRequestTimeoutMs, sourcePacketBudgetMs } from "../services/tennisMatrixAudit/evidence/bsd-pbp-fetch.js";

const norm = (v: unknown) => String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const P1 = process.argv[2] ?? "Alex Michelsen";
const P2 = process.argv[3] ?? "Federico Cina";
const AS_OF = process.argv[4] ?? "2026-08-30";

async function loadIndex(year: number): Promise<any[]> {
  try {
    const file = auditDataPath("audit", "bsd-atp-main-pbp-history", String(year), "results.json");
    if (!file) return [];
    const p = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

async function main() {
  console.log(`PAIR: ${P1} vs ${P2}   as-of ${AS_OF}`);
  console.log(`CONFIG: stage budget ${sourcePacketBudgetMs()}ms, per-request timeout ${pbpRequestTimeoutMs()}ms`);
  console.log(`DATA ROOT: ${auditDataRoot() ?? "NOT FOUND"}`);
  console.log(`CREDENTIAL: BSD_TENNIS_API_KEY ${process.env["BSD_TENNIS_API_KEY"] ? "present" : "NOT SET"}`);

  const rows = (await Promise.all([2024, 2025, 2026].map(loadIndex))).flat();
  console.log(`1. HISTORY INDEX        : ${rows.length} rows loaded`);

  const p1n = norm(P1), p2n = norm(P2);
  const eligible = rows.filter((r) => r.structurally_present === true && r.date
    && String(r.date).slice(0, 10) < AS_OF
    && (r.players ?? []).map(norm).some((n: string) => n === p1n || n === p2n));
  console.log(`2. PRE-MATCH ELIGIBLE   : ${eligible.length} (strictly before ${AS_OF} — no look-ahead)`);

  const per = (who: string) => eligible.filter((r) => (r.players ?? []).map(norm).includes(who));
  console.log(`   ${P1}: ${per(p1n).length}   ${P2}: ${per(p2n).length}`);

  const sorted = [...eligible].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const seen = new Set<string>();
  const candidates = [...per(p1n).slice(0, 12), ...per(p2n).slice(0, 12)]
    .filter((r) => { const k = String(r.match_id ?? ""); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  console.log(`3. QUALIFYING CANDIDATES: ${candidates.length} unique matches (12/player cap, deduped)`);
  if (!candidates.length) { console.log("   -> nothing to retrieve; stopping."); return; }
  for (const c of candidates.slice(0, 5)) console.log(`   - ${c.date} ${(c.players ?? []).join(" vs ")} [${c.match_id}]`);

  const probe = candidates.slice(0, 3);
  const tally = emptyTally();
  const started = Date.now();
  for (const c of probe) {
    const r = await fetchPbpClassified(c.match_id, { userAgent: "audit-diagnostic/1.0" });
    recordOutcome(tally, r);
    console.log(`4. PBP ${String(c.match_id).padEnd(10)} -> ${r.ok ? "OK payload" : `${r.reason}: ${r.detail.slice(0, 70)}`}`);
  }
  console.log(`5. RETRIEVAL TALLY      : ${describeTally(tally)}  (${Date.now() - started}ms for ${probe.length} requests)`);
  console.log(`6. CLASSIFICATION       : ${(tally.ok ?? 0) > 0 || (tally.NO_QUALIFYING_DATA ?? 0) > 0
    ? "provider was reached — a no-observation result would be genuine absence"
    : "provider was NOT reached — a no-observation result must NOT read as absence"}`);
  void sorted;
}
main();
