import { auditWarehouseDb } from "./postgrestCompat";
import { auditCutoff } from "./temporal-boundary";
import type { MetricFinding, Researcher } from "./audit-pipeline";
import { deterministicEnvironmentMetric } from "./deterministic-environment-metrics.server";
import { deterministicMarketMetric } from "./deterministic-market-metrics.server";
import { deterministicPbpMetricFromPacket } from "./deterministic-pbp-metrics.server";
import { deterministicRankingMetric } from "./deterministic-ranking-metrics.server";
import { deterministicResultsScheduleMetric } from "./deterministic-results-schedule-metrics.server";
import { deterministicRulesContextMetric } from "./deterministic-rules-context-metric.server";
import { deterministicBatch1StandaloneMetric } from "./deterministic-batch1-standalone-metrics.server";
import { deterministicBatch2NewMetric } from "./deterministic-batch2-new-metrics.server";
import { deterministicBatch3EarlyWarningMetric } from "./deterministic-batch3-early-warning.server";
import { deterministicBatch4FavoriteUnderdogPatterns } from "./deterministic-batch4-favorite-underdog-patterns.server";
import { deterministicBatch5NewMetrics } from "./deterministic-batch5-new-metrics.server";
import { deterministicBatch6ResidualStakes, deterministicBatch6HiddenDecline } from "./deterministic-batch6-residual-decline-stakes.server";
import { resolveCanonicalEvidencePair } from "./evidence-canonical-identity.server";
import { evidencePairMatches } from "./evidence-player-alias";
import { classifyEvidenceTourFamily, normalizeEvidenceTournament, type EvidenceTourFamily } from "./evidence-match-identity";
import { finalMetricWiringResearcher } from "./metric-wiring-078-081.server";
import { appendMetricObservationContext, buildMetricObservationContext } from "./source-observation-metric-bridge.server";
import { buildBsdAtpChallengerPbpContext } from "./bsd-atp-challenger-pbp.server";
import { buildBsdAtpMainPbpContext } from "./bsd-atp-main-pbp.server";
import { buildBsdWtaMainPbpContext } from "./bsd-wta-main-pbp.server";
import { buildBsdWtaChallengerPbpContext } from "./bsd-wta-challenger-pbp.server";
import { localMetricRows } from "./hybrid-audit-research.server";
import { officialWtaMetricRows } from "./wta-official-match-evidence.server";
import { certifyMetricFinding } from "./metric-certification";
import { BoundedPromiseCache } from "./bounded-promise-cache";
import { BoundedOperationPool } from "./async-time-budget";
import { auditDbCompositeMetric, isAuditDbCompositeMetric } from "./audit-metric-036-037-039-live.server";

const db = auditWarehouseDb as any;
const USABLE = new Set(["DIRECT", "RECONSTRUCTED", "PARTIAL"]);
const metricCallCache = new BoundedPromiseCache<MetricFinding[]>(256, 15 * 60_000);
const SOURCE_PACKET_BUDGET_MS = 7_000;
const LIVE_PROVIDER_BUDGET_MS = 12_000;
const researchWorkPool = new BoundedOperationPool(4);

function metricCallKey(input: Parameters<Researcher["metrics"]>[0]) {
  return JSON.stringify([
    input.p1,
    input.p2,
    input.context,
    input.dossier ?? "",
    input.researchSide ?? "",
    input.researchPlayer ?? "",
    input.researchOpponent ?? "",
    input.metrics.map(metric => [metric.code, metric.name, metric.body]),
  ]);
}

type StoredEvidence = {
  metric_code: string;
  player_name: string;
  opponent_name: string | null;
  tournament: string | null;
  surface: string | null;
  as_of_date: string;
  treatment: MetricFinding["p1_treatment"];
  value_text: string | null;
  reliability: number | null;
  sample_label: string | null;
  evidence_family: string | null;
  sources: MetricFinding["sources"] | null;
  unavailable_reason: string | null;
  valid_until: string | null;
  computed_at: string | null;
  updated_at: string | null;
};

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
/**
 * The audited match's temporal boundary. Phase 14: prefer the TYPED `auditDate` the
 * pipeline now passes (audit-pipeline.ts's executeMetrics, sourced directly from
 * `matches.scheduled_date`) and fall back to parsing the rendered context only for callers
 * that predate that field. A typed null and a parse miss are treated identically -- both
 * mean "boundary not established", which returns "" and therefore admits nothing.
 */
export function auditBoundary(input: { auditDate?: string | null; context?: string | null }) {
  const typed = String(input.auditDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(typed)) return typed;
  return asOfDate(input.context);
}
export function asOfDate(context: string | null | undefined) {
  // Phase 13.5 finding: this previously fell back to TODAY'S WALL-CLOCK DATE when the
  // context carried no date token -- i.e. whenever the audited match has a null
  // scheduled_date (1 of 55 live matches at the time of this fix). That silently treated
  // the audit as happening "now", admitting every record up to the moment the code runs --
  // the same class of leak temporal-boundary.ts was written to close in the CSV producers
  // (Phase 13), here inside this async tier chain instead. An unestablished boundary must
  // admit nothing, never "today": every caller below filters with a strict `<`/`<=`
  // comparison against this string, so an empty string fails every comparison and returns
  // zero rows rather than guessing a cutoff.
  return auditCutoff(String(context ?? "")) ?? "";
}
function tournamentFromContext(context: string | null | undefined) {
  const match = String(context ?? "").match(/\btournament\s*:?[ ]*([^;·|\n]+)/i);
  return match?.[1]?.trim() || null;
}
function surfaceFromContext(context: string | null | undefined) {
  const match = String(context ?? "").match(/\bsurface\s*:?[ ]*([^;·|\n]+)/i);
  return match?.[1]?.trim() || null;
}
function ttlHours(code: string) {
  if (["062", "064", "069", "071", "075", "076", "081"].includes(code)) return 12;
  if (["012", "028", "077", "079"].includes(code)) return 24;
  if (["015", "019"].includes(code)) return 6;
  return 168;
}
function fullyUsableFinding(row: MetricFinding | undefined) {
  return Boolean(row && USABLE.has(row.p1_treatment) && USABLE.has(row.p2_treatment) && row.p1_value && row.p2_value);
}

function usableSide(row: MetricFinding | undefined, side: "p1" | "p2") {
  return Boolean(row && USABLE.has(row[`${side}_treatment`]) && row[`${side}_value`]);
}

export function restoreRequestedOrientation(row: MetricFinding, reversed: boolean): MetricFinding {
  if (!reversed) return row;
  const restored = { ...row } as Record<string, unknown>;
  const original = row as unknown as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key.startsWith("p1_")) restored[key] = original[`p2_${key.slice(3)}`];
    if (key.startsWith("p2_")) restored[key] = original[`p1_${key.slice(3)}`];
  }
  return restored as unknown as MetricFinding;
}

export function mergeMetricFindingSides(primary: MetricFinding | undefined, fallback: MetricFinding | undefined) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const p1 = usableSide(primary, "p1") ? primary : fallback;
  const p2 = usableSide(primary, "p2") ? primary : fallback;
  const sources = [...(primary.sources ?? []), ...(fallback.sources ?? [])].filter(
    (source, index, rows) => rows.findIndex(other => other.source_name === source.source_name && other.url === source.url) === index,
  );
  const reliabilities = [primary.reliability, fallback.reliability].filter((value): value is number => typeof value === "number");
  return {
    ...fallback,
    ...primary,
    p1_value: p1.p1_value,
    p1_treatment: p1.p1_treatment,
    p2_value: p2.p2_value,
    p2_treatment: p2.p2_treatment,
    evidence_family: p1.evidence_family ?? p2.evidence_family ?? primary.evidence_family ?? fallback.evidence_family,
    reliability: reliabilities.length ? Math.min(...reliabilities) : null,
    sources,
  };
}
function rowTime(row: StoredEvidence) {
  return Date.parse(row.updated_at ?? row.computed_at ?? `${row.as_of_date}T00:00:00Z`) || 0;
}
function sameCircuit(a: EvidenceTourFamily, b: EvidenceTourFamily) {
  return (a.startsWith("ATP_") && b.startsWith("ATP_")) || (a.startsWith("WTA_") && b.startsWith("WTA_"));
}
function storedFamily(row: StoredEvidence) {
  let sources = "";
  try { sources = JSON.stringify(row.sources ?? []); } catch {}
  return classifyEvidenceTourFamily(row.tournament, row.sample_label, row.evidence_family, sources);
}
function storedContextCompatible(row: StoredEvidence, args: { tourFamily: EvidenceTourFamily | null; tournament: string | null; surface: string | null }) {
  const expectedTournament = normalizeEvidenceTournament(args.tournament);
  const actualTournament = normalizeEvidenceTournament(row.tournament);
  if (expectedTournament && actualTournament && expectedTournament !== actualTournament) return false;
  if (args.surface && row.surface && args.surface.trim().toLowerCase() !== row.surface.trim().toLowerCase()) return false;
  if (!args.tourFamily) return true;
  const family = storedFamily(row);
  if (family) {
    if (row.evidence_family === "RANKING") return sameCircuit(args.tourFamily, family);
    return family === args.tourFamily;
  }
  return Boolean(expectedTournament && actualTournament && expectedTournament === actualTournament);
}

function unambiguousStoredRow(rows:StoredEvidence[]) {
  if (rows.length === 1) return rows[0];
  const signatures = new Set(rows.map(row => JSON.stringify([row.treatment,row.value_text,row.evidence_family,row.unavailable_reason])));
  return signatures.size===1?rows[0]:null;
}

async function lookup(metricCodes: string[], player: string, opponent: string, date: string, context: string | null | undefined, tournament: string | null, surface: string | null): Promise<Map<string, StoredEvidence>> {
  if (!metricCodes.length) return new Map<string, StoredEvidence>();
  const tourFamily = classifyEvidenceTourFamily(context, tournament);
  const { data, error } = await db.from("metric_evidence_store")
    .select("metric_code,player_name,opponent_name,tournament,surface,as_of_date,treatment,value_text,reliability,sample_label,evidence_family,sources,unavailable_reason,valid_until,computed_at,updated_at")
    .in("metric_code", metricCodes)
    .lte("as_of_date", date)
    .order("as_of_date", { ascending: false })
    .limit(5000);
  if (error) return new Map<string, StoredEvidence>();

  const byCode = new Map<string, StoredEvidence[]>();
  for (const row of (data ?? []) as StoredEvidence[]) {
    if (!evidencePairMatches(row.player_name, row.opponent_name, player, opponent)) continue;
    if (!storedContextCompatible(row, { tourFamily, tournament, surface })) continue;
    const code = codeOf(row.metric_code);
    byCode.set(code, [...(byCode.get(code) ?? []), row]);
  }

  const out = new Map<string, StoredEvidence>();
  for (const [code, rows] of byCode) {
    const sorted = [...rows].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date) || rowTime(b) - rowTime(a));
    if (!sorted.length) continue;
    const newestDate = sorted[0].as_of_date;
    const newest = sorted.filter(row => row.as_of_date === newestDate);
    const selected = unambiguousStoredRow(newest);
    if(selected)out.set(code,selected);
  }
  return out;
}
function sourcesOf(row: StoredEvidence | undefined): MetricFinding["sources"] {
  return Array.isArray(row?.sources) ? row!.sources! : [];
}

async function saveSide(args: { code: string; name: string; player: string; opponent: string; date: string; treatment: MetricFinding["p1_treatment"]; value: string | null; reliability: number | null; sample: string | null; family: string | null; sources: MetricFinding["sources"]; unavailableReason: string | null; tournament: string | null; surface: string | null; tourFamily: EvidenceTourFamily | null }) {
  const { code, name, player, opponent, date, treatment, value, reliability, sample, family, sources, unavailableReason, tournament, surface, tourFamily } = args;
  if (!USABLE.has(treatment) || !value) return;
  const validUntil = new Date(Date.now() + ttlHours(code) * 3_600_000).toISOString();
  const sourceIds = (sources ?? []).map(source => source.source_name).filter(Boolean);
  const sampleLabel = [sample, tourFamily ? `tour_family=${tourFamily}` : null].filter(Boolean).join(" | ") || null;
  const payload = { metric_code: code, metric_name: name, player_name: player, opponent_name: opponent, tournament, surface, as_of_date: date, treatment, value_text: value, reliability, sample_label: sampleLabel, evidence_family: family, source_ids: sourceIds, sources: sources ?? [], unavailable_reason: unavailableReason, valid_until: validUntil, updated_at: new Date().toISOString() };
  const persisted = await db.rpc("upsert_metric_evidence_side", { p_payload: payload });
  if (persisted.error || !persisted.data?.id) throw new Error(`[metric_evidence_store] write failed for ${code} ${player} vs ${opponent} (${date}): ${persisted.error?.message ?? "persisted row was not returned"}`);
  const verification = await db.from("metric_evidence_store").select("id,treatment,value_text").eq("id", persisted.data.id).maybeSingle();
  if (verification.error || !verification.data || verification.data.treatment !== treatment || verification.data.value_text !== value) {
    throw new Error(`[metric_evidence_store] verification failed for ${code} ${player} vs ${opponent} (${date}): ${verification.error?.message ?? "persisted row does not match the computed side"}`);
  }
}

function observationIdentity(row: any) {
  const value = row?.value ?? {};
  const matchId = value?.match_id ?? String(row?.url ?? "").match(/\/matches\/(\d+)\//)?.[1] ?? null;
  if (row?.family === "POINT_BY_POINT" && matchId) return `PBP|${row?.source ?? ""}|${matchId}`;
  return [row?.family, row?.source, row?.player, row?.opponent, row?.player1, row?.player2, row?.tournament, row?.event_date, row?.key].join("|");
}
function mergeObservationPackets(base: Record<string, unknown>, extra: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...base };
  for (const [code, value] of Object.entries(extra)) {
    const a = (merged[code] ?? {}) as Record<string, any>;
    const b = (value ?? {}) as Record<string, any>;
    const seen = new Set<string>();
    const observations = [...(Array.isArray(a.observations) ? a.observations : []), ...(Array.isArray(b.observations) ? b.observations : [])].filter((row: any) => {
      const key = observationIdentity(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const observedFamilies = [...new Set([...(Array.isArray(a.observed_families) ? a.observed_families : []), ...(Array.isArray(b.observed_families) ? b.observed_families : [])])];
    merged[code] = { ...a, ...b, observations, observed_families: observedFamilies, direct_satisfaction_allowed: Boolean(a.direct_satisfaction_allowed || b.direct_satisfaction_allowed) };
  }
  return merged;
}

export const warehouseFirstResearcher: Researcher = {
  ...finalMetricWiringResearcher,
  async metrics(input) {
    return metricCallCache.getOrCreate(metricCallKey(input), async () => {
    const reversedOrientation = input.researchSide === "p2";
    const requestedP1 = reversedOrientation ? (input.researchPlayer ?? input.p2) : input.p1;
    const requestedP2 = reversedOrientation ? (input.researchOpponent ?? input.p1) : input.p2;
    const callStartedAt = Date.now();
    const identityFallback = (name: string) => ({ input: name, canonical: name, status: "QUERY_FAILED" as const, candidates: [], query_errors: ["Canonical identity lookup exceeded its time budget."] });
    const identities = await researchWorkPool.runWithBudget(
      "canonical-identity",
      SOURCE_PACKET_BUDGET_MS,
      () => resolveCanonicalEvidencePair(requestedP1, requestedP2),
      () => ({ p1: identityFallback(requestedP1), p2: identityFallback(requestedP2) }),
    );
    console.log(`[research-timing] canonical identity ${Date.now()-callStartedAt}ms`);
    input = { ...input, p1: identities.p1.canonical, p2: identities.p2.canonical };
    const { p1, p2, metrics } = input;
    const date = auditBoundary({ auditDate: input.auditDate, context: input.context });
    const tournament = tournamentFromContext(input.context);
    const surface = surfaceFromContext(input.context);
    const tourFamily = classifyEvidenceTourFamily(input.context, tournament);
    const codes = metrics.map(metric => codeOf(metric.code));
    const [p1Stored, p2Stored] = await researchWorkPool.runWithBudget(
      "stored-evidence",
      SOURCE_PACKET_BUDGET_MS,
      () => Promise.all([
        lookup(codes, p1, p2, date, input.context, tournament, surface),
        lookup(codes, p2, p1, date, input.context, tournament, surface),
      ]),
      () => [new Map<string, StoredEvidence>(), new Map<string, StoredEvidence>()],
    );
    console.log(`[research-timing] stored evidence ${Date.now()-callStartedAt}ms`);

    const missing = metrics.filter(metric => {
      const code = codeOf(metric.code), a = p1Stored.get(code), b = p2Stored.get(code);
      if (isAuditDbCompositeMetric(code)) return true;
      return !a || !b || !USABLE.has(a.treatment) || !USABLE.has(b.treatment) || !a.value_text || !b.value_text;
    });

    const deterministicResult = await researchWorkPool.runWithBudget("deterministic-metrics", SOURCE_PACKET_BUDGET_MS, () => Promise.all(missing.map(async metric => {
      const auditDb = await auditDbCompositeMetric({ metricCode: metric.code, p1, p2, asOfDate: date }); if (auditDb) return auditDb;
      const ranking = await deterministicRankingMetric({ metricCode: metric.code, p1, p2, asOfDate: date, context: input.context }); if (ranking) return ranking;
      const rules = await deterministicRulesContextMetric({ metricCode: metric.code, p1, p2, asOfDate: date, context: input.context }); if (rules) return rules;
      const environment = await deterministicEnvironmentMetric({ metricCode: metric.code, p1, p2, asOfDate: date, tournament }); if (environment) return environment;
      // Batch4 favorite/underdog pattern modules (043/044) -- real per-player
      // historical-pattern engines (docs/audit-task-043-044-opponent-upset-
      // compatibility.md), tried BEFORE the market tier below so they take
      // priority; deterministicMarketMetric's de-vig pricing remains a real
      // fallback for 043/044 (price/favorite-designation are named inputs to
      // both codes) when this tier can't resolve either player.
      const batch4 = await deterministicBatch4FavoriteUnderdogPatterns({ metricCode: metric.code, p1, p2, asOfDate: date, tourFamily, surface }); if (batch4) return batch4;
      // Batch5 modules (047/061) -- docs/audit-task-047-061-classification-decisions.md.
      // Tried alongside batch4 (no owned-code overlap between the two tiers), ahead of the
      // market tier below since neither 047 nor 061 has any legitimate market-derived input.
      const batch5 = await deterministicBatch5NewMetrics({ metricCode: metric.code, p1, p2, asOfDate: date, tourFamily, surface }); if (batch5) return batch5;
      const market = await deterministicMarketMetric({ metricCode: metric.code, p1, p2, asOfDate: date, tournament, context: input.context }); if (market) return market;
      const resultsSchedule = await deterministicResultsScheduleMetric({ metricCode: metric.code, p1, p2, asOfDate: date, tournament, eventLevel: null, tourFamily, context: input.context }); if (resultsSchedule) return resultsSchedule;
      // Batch1 standalone modules (027/031/041/046/051) -- reconnected per
      // docs/audit-task-new-batch1-standalone-modules-wiring.md, same pattern as
      // docs/ARCHITECTURE-FINDING-disconnected-hybrid-researcher.md. Tried last
      // in this cheap deterministic chain since it needs a resolved tourFamily.
      const batch1 = await deterministicBatch1StandaloneMetric({ metricCode: metric.code, p1, p2, asOfDate: date, tourFamily }); if (batch1) return batch1;
      // Batch2 newly-built modules (020/036/045/052) --
      // docs/audit-task-020-026-034-036-045-052-053.md.
      const batch2 = await deterministicBatch2NewMetric({ metricCode: metric.code, p1, p2, asOfDate: date, tourFamily }); if (batch2) return batch2;
      // Batch6 synchronous modules (038/062) -- docs/audit-task-038-040-062.md. 040 is NOT
      // handled here -- it needs a live PBP fetch, see the live-fetch phase below (same
      // shape as 026's own live-fetch tier).
      return deterministicBatch6ResidualStakes({ metricCode: metric.code, p1, p2, asOfDate: date, tourFamily });
    })), () => []);
    const deterministicRows = deterministicResult.filter((row): row is MetricFinding => Boolean(row));
    console.log(`[research-timing] deterministic tier ${Date.now()-callStartedAt}ms`);
    const deterministicByCode = new Map(deterministicRows.map(row => [codeOf(row.metric_code), row]));
    const liveMissing = missing.filter(metric => {
      const code = codeOf(metric.code);
      return !isAuditDbCompositeMetric(code) && !fullyUsableFinding(deterministicByCode.get(code));
    });

    let liveRows: MetricFinding[] = [];
    if (liveMissing.length) {
      const sourceFallback = { packet: {}, status: { outcome: "SOURCE_TIMEOUT" } } as any;
      const [warehouseResult, challengerResult, atpMainResult, wtaMainResult, wtaChallengerResult] = await researchWorkPool.runWithBudget(
        "source-packets",
        SOURCE_PACKET_BUDGET_MS,
        () => Promise.all([
          buildMetricObservationContext({ metrics: liveMissing, p1, p2, asOfDate: date, context: input.context }),
          buildBsdAtpChallengerPbpContext({ metrics: liveMissing, p1, p2, asOfDate: date, context: input.context }),
          buildBsdAtpMainPbpContext({ metrics: liveMissing, p1, p2, asOfDate: date, context: input.context }),
          buildBsdWtaMainPbpContext({ metrics: liveMissing, p1, p2, asOfDate: date, context: input.context }),
          buildBsdWtaChallengerPbpContext({ metrics: liveMissing, p1, p2, asOfDate: date, context: input.context }),
        ]),
        () => [{}, sourceFallback, sourceFallback, sourceFallback, sourceFallback],
      );
      console.log(`[research-timing] source packets ${Date.now()-callStartedAt}ms`);
      const unavailablePbp = sourceFallback;
      const warehousePacket = warehouseResult ?? {};
      const bsdAtpChallengerPbp = challengerResult ?? unavailablePbp;
      const bsdAtpMainPbp = atpMainResult ?? unavailablePbp;
      const bsdWtaMainPbp = wtaMainResult ?? unavailablePbp;
      const bsdWtaChallengerPbp = wtaChallengerResult ?? unavailablePbp;
      let observationPacket = mergeObservationPackets(warehousePacket, bsdAtpChallengerPbp.packet);
      observationPacket = mergeObservationPackets(observationPacket, bsdAtpMainPbp.packet);
      observationPacket = mergeObservationPackets(observationPacket, bsdWtaMainPbp.packet);
      observationPacket = mergeObservationPackets(observationPacket, bsdWtaChallengerPbp.packet);

      for (const metric of liveMissing) {
        const code = codeOf(metric.code);
        // Metric 026's cross-match slow-start-recovery aggregation is its own live-fetch
        // shape (a player's own past PBP-covered matches, not this match's own packet) --
        // see deterministic-batch3-early-warning.server.ts's header comment for why it is
        // tried here rather than in the cheap deterministic chain above or through the
        // per-match packet path below.
        if (code === "026") {
          const earlyWarning = await deterministicBatch3EarlyWarningMetric({ metricCode: code, p1, p2, asOfDate: date, tourFamily });
          if (fullyUsableFinding(earlyWarning ?? undefined)) deterministicByCode.set(code, earlyWarning!);
          continue;
        }
        // Metric 040's cross-match ace/serve/return/hold/break trend is the same live-fetch
        // shape as 026's -- see deterministic-batch6-residual-decline-stakes.server.ts's
        // header comment.
        if (code === "040") {
          const hiddenDecline = await deterministicBatch6HiddenDecline({ metricCode: code, p1, p2, asOfDate: date, tourFamily });
          if (fullyUsableFinding(hiddenDecline ?? undefined)) deterministicByCode.set(code, hiddenDecline!);
          continue;
        }
        const recovered=deterministicPbpMetricFromPacket({metricCode:code,p1,p2,asOfDate:date,packet:observationPacket});
        if (fullyUsableFinding(recovered ?? undefined)) deterministicByCode.set(code, recovered!);
      }

      for (const [code, row] of deterministicByCode) {
        const existing = (observationPacket as Record<string, any>)[code] ?? {};
        (observationPacket as Record<string, any>)[code] = { ...existing, deterministic_components: { p1_value: row.p1_value, p2_value: row.p2_value, treatment: row.p1_treatment, evidence_family: row.evidence_family, sample: row.sample } };
      }
      const beforeStaticWarehouse = liveMissing.filter(metric => !fullyUsableFinding(deterministicByCode.get(codeOf(metric.code))));
      if (beforeStaticWarehouse.length) {
        // Cheap deterministic tier, ahead of the live AI search: the PredixSport/
        // DataHub CSV warehouse and the live WTA official API. This was previously
        // built, tested, and never actually wired into any live researcher --
        // see docs/ARCHITECTURE-FINDING-disconnected-hybrid-researcher.md. Never
        // trust its self-reported treatment directly: certifyMetricFinding is the
        // same conservative, tested, never-upgrades-only-downgrades policy check
        // already relied on elsewhere in this file (see
        // docs/metric-audit-019-market-calibration.md and
        // docs/metric-audit-012-fatigue-workload-schedule-engine.md) for the
        // certified codes (012/019/022/024/025/072-076); everything else passes
        // through unchanged.
        const localRows = localMetricRows(p1, p2, input.context ?? "", beforeStaticWarehouse).map(certifyMetricFinding);
        const localByCode = new Map(localRows.map(row => [codeOf(row.metric_code), row]));
        let wtaRows: MetricFinding[] = [];
        try {
          wtaRows = (await researchWorkPool.runWithBudget(
            "official-wta",
            SOURCE_PACKET_BUDGET_MS,
            () => officialWtaMetricRows({ p1, p2, context: input.context ?? "", metrics: beforeStaticWarehouse }),
            () => [],
          )) ?? [];
        } catch { /* live WTA API outage falls through to the local CSV row (if any) or live AI search below */ }
        const wtaByCode = new Map(wtaRows.map(row => [codeOf(row.metric_code), certifyMetricFinding(row)]));
        for (const metric of beforeStaticWarehouse) {
          const code = codeOf(metric.code);
          const wta = wtaByCode.get(code), local = localByCode.get(code);
          const chosen = fullyUsableFinding(wta) ? wta : fullyUsableFinding(local) ? local : null;
          if (chosen) deterministicByCode.set(code, chosen);
        }
        for (const [code, row] of deterministicByCode) {
          const existing = (observationPacket as Record<string, any>)[code] ?? {};
          (observationPacket as Record<string, any>)[code] = { ...existing, deterministic_components: { p1_value: row.p1_value, p2_value: row.p2_value, treatment: row.p1_treatment, evidence_family: row.evidence_family, sample: row.sample } };
        }
      }
      const remainingLiveMissing=liveMissing.filter(metric=>!fullyUsableFinding(deterministicByCode.get(codeOf(metric.code))));
      if (remainingLiveMissing.length) {
        const identityResolution = { p1: identities.p1, p2: identities.p2 };
        const context = appendMetricObservationContext(input.context, { ...observationPacket, _canonical_identity_resolution: identityResolution, _bsd_atp_challenger_pbp_status: bsdAtpChallengerPbp.status, _bsd_atp_main_pbp_status: bsdAtpMainPbp.status, _bsd_wta_main_pbp_status: bsdWtaMainPbp.status, _bsd_wta_challenger_pbp_status: bsdWtaChallengerPbp.status });
        const providerRows = await researchWorkPool.runWithBudget(
          "live-provider",
          LIVE_PROVIDER_BUDGET_MS,
          () => finalMetricWiringResearcher.metrics({ ...input, context, metrics: remainingLiveMissing }),
          () => [],
        );
        liveRows = providerRows;
        console.log(`[research-timing] live provider ${Date.now()-callStartedAt}ms`);
      }
    }
    const liveByCode = new Map(liveRows.map(row => [codeOf(row.metric_code), row]));

    const output: MetricFinding[] = [];
    for (const metric of metrics) {
      const code = codeOf(metric.code), auditDbOwned = isAuditDbCompositeMetric(code);
      const a = auditDbOwned ? undefined : p1Stored.get(code), b = auditDbOwned ? undefined : p2Stored.get(code), live = liveByCode.get(code), deterministic = deterministicByCode.get(code);
      if (a && b && USABLE.has(a.treatment) && USABLE.has(b.treatment) && a.value_text && b.value_text) {
        const mergedSources = [...sourcesOf(a), ...sourcesOf(b)].filter((source, index, rows) => rows.findIndex(other => other.source_name === source.source_name && other.url === source.url) === index);
        output.push({ metric_code: code, p1_value: a.value_text, p2_value: b.value_text, p1_treatment: a.treatment, p2_treatment: b.treatment, differential: null, evidence_family: a.evidence_family ?? b.evidence_family, reliability: Math.min(a.reliability ?? 100, b.reliability ?? 100), sample: [a.sample_label, b.sample_label].filter(Boolean).join(" | ") || null, unavailable_reason: null, sources: mergedSources });
        continue;
      }
      const cached: MetricFinding = {
        metric_code: code,
        p1_value: a?.value_text ?? null,
        p2_value: b?.value_text ?? null,
        p1_treatment: a?.treatment ?? "UNAVAILABLE",
        p2_treatment: b?.treatment ?? "UNAVAILABLE",
        differential: null,
        evidence_family: a?.evidence_family ?? b?.evidence_family ?? null,
        reliability: Math.min(a?.reliability ?? 100, b?.reliability ?? 100),
        sample: [a?.sample_label, b?.sample_label].filter(Boolean).join(" | ") || null,
        unavailable_reason: null,
        sources: [...sourcesOf(a), ...sourcesOf(b)],
      };
      const computed = mergeMetricFindingSides(live, deterministic);
      const chosen = mergeMetricFindingSides(cached, computed);
      if (!chosen) continue;
      output.push(chosen);
      await Promise.all([
        saveSide({ code, name: metric.name, player: p1, opponent: p2, date, treatment: chosen.p1_treatment, value: chosen.p1_value, reliability: chosen.reliability, sample: chosen.sample, family: chosen.evidence_family, sources: chosen.sources ?? [], unavailableReason: chosen.unavailable_reason, tournament, surface, tourFamily }),
        saveSide({ code, name: metric.name, player: p2, opponent: p1, date, treatment: chosen.p2_treatment, value: chosen.p2_value, reliability: chosen.reliability, sample: chosen.sample, family: chosen.evidence_family, sources: chosen.sources ?? [], unavailableReason: chosen.unavailable_reason, tournament, surface, tourFamily }),
      ]);
    }
    return output.map(row => restoreRequestedOrientation(row, reversedOrientation));
    });
  },
};
