import { supabaseAdmin } from "./postgrestCompat";
import type { MetricFinding } from "./audit-pipeline";
import { metricAllowsObservation } from "./metric-source-family-policy";

const db = supabaseAdmin as any;
const SUPPORTED = new Set(["021", "030", "060", "071"]);
const KEYS = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "pressure_msl",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
];

type EnvRow = {
  source_id: string;
  source_name: string;
  source_url: string;
  tournament: string | null;
  event_date: string | null;
  observation_type: string | null;
  observation_key: string | null;
  numeric_value: number | null;
  unit: string | null;
  raw_payload: any;
};

function codeOf(value: unknown) {
  const m = String(value ?? "").match(/(\d{1,3})$/);
  return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0");
}

function mean(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function round(value: number | null, digits = 1) {
  if (value === null) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function isoShift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function deterministicEnvironmentMetric(args: {
  metricCode: unknown;
  p1: string;
  p2: string;
  asOfDate: string;
  tournament?: string | null;
}): Promise<MetricFinding | null> {
  const code = codeOf(args.metricCode);
  if (!SUPPORTED.has(code)) return null;
  const tournament = String(args.tournament ?? "").trim();
  if (!tournament) return null;

  const query = db
    .from("source_observations")
    .select("source_id,source_name,source_url,tournament,event_date,observation_type,observation_key,numeric_value,unit,raw_payload")
    .eq("source_id", "open_meteo")
    .eq("observation_type", "ENVIRONMENT")
    .eq("tournament", tournament)
    // Upper bound is the match day itself, never after it (Phase 14 temporal sweep). The
    // match-day environment row is legitimately pre-match information -- venue weather is
    // forecast and published before play, and unlike a result it carries no outcome -- but
    // the day AFTER the match is not available to a pre-match audit under any reading, and
    // the previous `asOfDate + 1` bound admitted it. The -1 lower bound is retained: it
    // absorbs the feed's timezone boundary for late local starts recorded in UTC.
    .gte("event_date", isoShift(args.asOfDate, -1))
    .lte("event_date", args.asOfDate);

  const { data, error } = await query;
  if (error) return null;

  const rows = ((data ?? []) as EnvRow[]).filter((row) =>
    KEYS.includes(String(row.observation_key ?? "")) && metricAllowsObservation(code, row),
  );
  if (!rows.length) return null;

  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const key = String(row.observation_key ?? "");
    if (row.numeric_value === null || !Number.isFinite(Number(row.numeric_value))) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(Number(row.numeric_value));
    byKey.set(key, arr);
  }

  const t = round(mean(byKey.get("temperature_2m") ?? []));
  const rh = round(mean(byKey.get("relative_humidity_2m") ?? []));
  const rain = round(mean(byKey.get("precipitation") ?? []), 2);
  const wind = round(mean(byKey.get("wind_speed_10m") ?? []));
  const gust = round(mean(byKey.get("wind_gusts_10m") ?? []));
  const pressure = round(mean(byKey.get("pressure_msl") ?? byKey.get("surface_pressure") ?? []));

  const parts = [
    t === null ? null : `temp=${t}`,
    rh === null ? null : `humidity=${rh}`,
    rain === null ? null : `precip=${rain}`,
    wind === null ? null : `wind=${wind}`,
    gust === null ? null : `gust=${gust}`,
    pressure === null ? null : `pressure=${pressure}`,
  ].filter(Boolean);
  if (!parts.length) return null;

  const units = new Map(rows.map((row) => [String(row.observation_key), row.unit]));
  const value = `${parts.join(" | ")} | shared match environment`;
  const sourceMap = new Map<string, { source_name: string; url: string }>();
  for (const row of rows) sourceMap.set(`${row.source_name}|${row.source_url}`, { source_name: row.source_name, url: row.source_url });

  return {
    metric_code: code,
    p1_value: value,
    p2_value: value,
    p1_treatment: "PARTIAL",
    p2_treatment: "PARTIAL",
    differential: null,
    evidence_family: "ENVIRONMENT",
    reliability: rows.length >= 12 ? 85 : 70,
    sample: `Open-Meteo ${tournament} hourly observations=${rows.length}; units temp=${units.get("temperature_2m") ?? "unknown"}, humidity=${units.get("relative_humidity_2m") ?? "unknown"}, wind=${units.get("wind_speed_10m") ?? "unknown"}`,
    unavailable_reason: null,
    sources: [...sourceMap.values()],
  };
}
