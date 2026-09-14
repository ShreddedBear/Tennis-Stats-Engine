import { supabaseAdmin } from "./postgrestCompat";
import { evidencePairMatches, safeEvidenceAliases } from "./evidence-player-alias";
import { metricAllowsObservation, observationFamily, policyForMetric } from "./metric-source-family-policy";
import { classifyEvidenceTourFamily, type EvidenceTourFamily } from "./evidence-match-identity";
import { inferRepositoryMatchContext } from "./repository-results-history.server";
import { buildBsdAtpMainPbpContext } from "./bsd-atp-main-pbp.server";
import { buildBsdWtaMainPbpContext } from "./bsd-wta-main-pbp.server";
import { buildBsdAtpChallengerPbpContext } from "./bsd-atp-challenger-pbp.server";
import { buildBsdWtaChallengerPbpContext } from "./bsd-wta-challenger-pbp.server";

const db = supabaseAdmin as any;

type MetricLike = { code: string; name: string };
type ObservationRow = {
  source_id: string | null;
  source_name: string | null;
  source_url: string | null;
  player_name: string | null;
  opponent_name: string | null;
  tournament: string | null;
  event_date: string | null;
  surface: string | null;
  observation_type: string | null;
  observation_key: string | null;
  text_value: string | null;
  numeric_value: number | null;
  sample_label: string | null;
  window_start: string | null;
  window_end: string | null;
};

function codeOf(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,3})$/);
  return match ? match[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}
function unique<T>(values: T[]) { return [...new Set(values)]; }
function compactObservation(row: ObservationRow) {
  return { family: observationFamily(row), source: row.source_name ?? row.source_id, url: row.source_url, player: row.player_name, opponent: row.opponent_name, tournament: row.tournament, event_date: row.event_date, surface: row.surface, key: row.observation_key, value: row.text_value ?? row.numeric_value, sample: row.sample_label, window_start: row.window_start, window_end: row.window_end };
}

async function loadCandidateRows(player: string, opponent: string, asOfDate: string) {
  const start = new Date(`${asOfDate}T00:00:00Z`);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  const aliases = unique([...safeEvidenceAliases(player, opponent), ...safeEvidenceAliases(opponent, player)]);
  const select = "source_id,source_name,source_url,player_name,opponent_name,tournament,event_date,surface,observation_type,observation_key,text_value,numeric_value,sample_label,window_start,window_end";
  const datedBase = () => db.from("source_observations").select(select)
    .gte("event_date", start.toISOString().slice(0, 10)).lte("event_date", asOfDate)
    .order("event_date", { ascending: false });
  const marketBase = () => db.from("source_observations").select(select)
    .eq("event_date", asOfDate).eq("observation_type", "MARKET")
    .order("event_date", { ascending: false });
  const nullDateBase = () => db.from("source_observations").select(select).is("event_date", null);

  // PBP is intentionally excluded from the generic warehouse lane. Evidence Coverage
  // receives PBP only through the tour-scoped BSD bridges below, so quarantined or
  // ambiguous records cannot become evidence merely because they exist in a table.
  // Market evidence is match-scoped: exact match date plus canonical/reversed pair.
  // NULL-date rows are accepted only when attached to one of the matchup aliases;
  // a shared row with neither player identity nor date cannot be safely joined.
  const [otherResult, marketResult, sharedResult, nullDatePlayerResult] = await Promise.all([
    datedBase().in("player_name", aliases).not("observation_type", "in", "(POINT_BY_POINT,PBP,MARKET)").limit(1000),
    marketBase().in("player_name", aliases).limit(1000),
    datedBase().is("player_name", null).not("observation_type", "in", "(POINT_BY_POINT,PBP,MARKET)").limit(1000),
    nullDateBase().in("player_name", aliases).not("observation_type", "in", "(POINT_BY_POINT,PBP,MARKET)").limit(1000),
  ]);
  const results = [otherResult, marketResult, sharedResult, nullDatePlayerResult];
  if (results.some((result) => result.error)) return [] as ObservationRow[];
  const rows = results.flatMap((result) => (result.data ?? []) as ObservationRow[]);
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.observation_type === "MARKET" && !(
      evidencePairMatches(row.player_name, row.opponent_name, player, opponent) ||
      evidencePairMatches(row.player_name, row.opponent_name, opponent, player)
    )) return false;
    const key = [row.source_id,row.source_url,row.player_name,row.opponent_name,row.event_date,row.observation_key,row.text_value,row.numeric_value].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contextFromObservationRows(args: { p1: string; p2: string; asOfDate: string }, rows: ObservationRow[]) {
  const exact = rows.filter((row) => row.event_date === args.asOfDate && (
    evidencePairMatches(row.player_name, row.opponent_name, args.p1, args.p2) ||
    evidencePairMatches(row.player_name, row.opponent_name, args.p2, args.p1)
  ));
  const classified = exact.map((row) => ({ row, tour: classifyEvidenceTourFamily(row.sample_label, row.tournament, row.source_id, row.source_name) })).filter((entry) => entry.tour !== null) as Array<{ row: ObservationRow; tour: NonNullable<ReturnType<typeof classifyEvidenceTourFamily>> }>;
  const tours = unique(classified.map((entry) => entry.tour));
  if (tours.length !== 1) return null;
  const row = classified[0].row;
  return [`Tournament: ${row.tournament ?? "unknown"}`, `Level: ${tours[0]!.replaceAll("_", " ")}`, `Tour: ${tours[0]!.replaceAll("_", " ")}`, row.surface ? `Surface: ${row.surface}` : null, `Date: ${args.asOfDate}`].filter(Boolean).join(" | ");
}

async function inferCanonicalMatchContext(args: { p1: string; p2: string; asOfDate: string }, rows: ObservationRow[]) {
  const fromRows = contextFromObservationRows(args, rows);
  if (fromRows) return fromRows;
  const fromRepository = inferRepositoryMatchContext(args);
  if (fromRepository) return fromRepository;
  const { data, error } = await db.from("matches")
    .select("player1_name,player2_name,tournament_name,event_level,scheduled_date,surface,round")
    .eq("scheduled_date", args.asOfDate).limit(250);
  if (error) return null;
  const matches = (data ?? []).filter((row: any) =>
    evidencePairMatches(row.player1_name, row.player2_name, args.p1, args.p2) ||
    evidencePairMatches(row.player1_name, row.player2_name, args.p2, args.p1));
  const classified = matches.map((row: any) => ({ row, tour: classifyEvidenceTourFamily(row.event_level, row.tournament_name) })).filter((entry: { row: { tournament_name: string | null; event_level: string | null; surface: string | null; round: string | null }; tour: ReturnType<typeof classifyEvidenceTourFamily> }) => entry.tour !== null) as Array<{ row: { tournament_name: string | null; event_level: string | null; surface: string | null; round: string | null }; tour: NonNullable<ReturnType<typeof classifyEvidenceTourFamily>> }>;
  const tours = unique(classified.map((entry) => entry.tour));
  if (classified.length !== 1 || tours.length !== 1) return null;
  const row = classified[0].row;
  const tour = tours[0]!;
  return [`Tournament: ${row.tournament_name ?? "unknown"}`, `Level: ${row.event_level ?? tour.replaceAll("_", " ")}`, `Tour: ${tour.replaceAll("_", " ")}`, row.surface ? `Surface: ${row.surface}` : null, `Date: ${args.asOfDate}`, row.round ? `Round: ${row.round}` : null].filter(Boolean).join(" | ");
}

async function approvedPbpPacket(args: { metrics: MetricLike[]; p1: string; p2: string; asOfDate: string; context?: string | null }, rows: ObservationRow[]) {
  const context = args.context ?? await inferCanonicalMatchContext(args, rows);
  const tour = classifyEvidenceTourFamily(context);
  if (!tour || !context) return {} as Record<string, any>;
  const input = { metrics: args.metrics, p1: args.p1, p2: args.p2, asOfDate: args.asOfDate, context };
  if (tour === "ATP_MAIN") return (await buildBsdAtpMainPbpContext(input)).packet as Record<string, any>;
  if (tour === "WTA_MAIN") return (await buildBsdWtaMainPbpContext(input)).packet as Record<string, any>;
  if (tour === "ATP_CHALLENGER") return (await buildBsdAtpChallengerPbpContext(input)).packet as Record<string, any>;
  return (await buildBsdWtaChallengerPbpContext(input)).packet as Record<string, any>;
}

function mergePacketEntry(base: any, pbp: any) {
  if (!base) return pbp;
  if (!pbp) return base;
  const observations = [...(base.observations ?? []), ...(pbp.observations ?? [])];
  const seen = new Set<string>();
  const deduped = observations.filter((row: any) => {
    const value = row?.value ?? {};
    const matchId = value?.match_id ?? String(row?.url ?? "").match(/\/matches\/(\d+)\//)?.[1] ?? "";
    const key = row?.family === "POINT_BY_POINT" && matchId
      ? [row?.family,row?.source,matchId].join("|")
      : [row?.family,row?.source,row?.player,row?.opponent,row?.player1,row?.player2,row?.event_date,row?.key].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...base,
    observed_families: unique([...(base.observed_families ?? []), ...(pbp.observed_families ?? [])]),
    direct_satisfaction_allowed: Boolean(base.direct_satisfaction_allowed || pbp.direct_satisfaction_allowed),
    observations: deduped.slice(0, 80),
    pbp_tour_guard: pbp.tour_guard ?? null,
  };
}

export async function buildMetricObservationContext(args: { metrics: MetricLike[]; p1: string; p2: string; asOfDate: string; context?: string | null; }) {
  const rows = await loadCandidateRows(args.p1, args.p2, args.asOfDate);
  const pbpPacket = await approvedPbpPacket(args, rows);
  const packet: Record<string, any> = {};
  for (const metric of args.metrics) {
    const code = codeOf(metric.code);
    const policy = policyForMetric(code);
    const allowed = rows.filter((row) => metricAllowsObservation(code, row));
    if (allowed.length) {
      const families = unique(allowed.map((row) => observationFamily(row)).filter(Boolean));
      const supportOnly = policy.support_only_families ?? [];
      const sufficient = policy.sufficient_families ?? [];
      packet[code] = { metric_name: metric.name, allowed_families: policy.allowed_families, sufficient_families: sufficient, support_only_families: supportOnly, observed_families: families, direct_satisfaction_allowed: families.some((family) => sufficient.includes(family!)), observations: allowed.slice(0, 80).map(compactObservation) };
    }
    packet[code] = mergePacketEntry(packet[code], pbpPacket[code]);
    if (!packet[code]) delete packet[code];
  }
  return packet;
}

export function appendMetricObservationContext(baseContext: string | null | undefined, packet: Record<string, unknown>) {
  if (!Object.keys(packet).length) return baseContext ?? "";
  const appendix = `\n\nWAREHOUSE_OBSERVATION_CONTEXT\n${JSON.stringify(packet)}\nEND_WAREHOUSE_OBSERVATION_CONTEXT\nRules: use only observations listed under the requested metric code; never borrow an observation family from another metric; support-only families may inform reconstruction but cannot alone justify DIRECT treatment or a complete metric answer.`;
  return `${baseContext ?? ""}${appendix}`;
}
