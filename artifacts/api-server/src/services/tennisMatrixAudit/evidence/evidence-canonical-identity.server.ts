import { supabaseAdmin } from "./postgrestCompat";
import {
  isSurnameOnlyEvidenceIdentity,
  normalizeEvidenceIdentity,
  uniqueCanonicalWarehouseIdentity,
} from "./evidence-player-alias";

const db = supabaseAdmin as any;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_LANE = 20;
const MAX_PLAYER_PAGES = 50;

type IdentityStatus = "ALREADY_CANONICAL" | "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS" | "QUERY_FAILED";

export type CanonicalEvidenceIdentity = {
  input: string;
  canonical: string;
  status: IdentityStatus;
  candidates: string[];
  query_errors: string[];
  stable_id?: string | null;
  normalized_key?: string | null;
  aliases?: string[];
  tour?: string | null;
};

type LaneResult = { names: string[]; errors: string[]; truncated: boolean };
type PlayerDirectoryRow = {
  id: string;
  canonical_name: string;
  normalized_key: string | null;
  aliases: string[] | null;
  tour: string | null;
};

type DirectoryResult = { rows: PlayerDirectoryRow[]; errors: string[]; truncated: boolean };
let playerDirectoryPromise: Promise<DirectoryResult> | null = null;

function candidateNames(rows: any[], fields: string[]) {
  const out: string[] = [];
  for (const row of rows) for (const field of fields) {
    const value = String(row?.[field] ?? "").trim();
    if (value) out.push(value);
  }
  return out;
}

function exactCanonicalCandidates(uploaded: string, names: string[]) {
  const candidates = new Map<string, string>();
  for (const value of names) {
    const canonical = uniqueCanonicalWarehouseIdentity(uploaded, [value]);
    if (!canonical) continue;
    candidates.set(normalizeEvidenceIdentity(canonical), canonical);
  }
  return candidates;
}

async function loadPlayerDirectory(): Promise<DirectoryResult> {
  if (playerDirectoryPromise) return playerDirectoryPromise;
  playerDirectoryPromise = (async () => {
    const rows: PlayerDirectoryRow[] = [];
    for (let page = 0; page < MAX_PLAYER_PAGES; page++) {
      const from = page * PAGE_SIZE;
      let result: any;
      try {
        result = await db.from("players")
          .select("id,canonical_name,normalized_key,aliases,tour")
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
      } catch (error) {
        return { rows, errors: [error instanceof Error ? error.message : String(error)], truncated: false };
      }
      if (result.error) return { rows, errors: [result.error.message], truncated: false };
      const pageRows = (result.data ?? []) as PlayerDirectoryRow[];
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) return { rows, errors: [], truncated: false };
    }
    return { rows, errors: [], truncated: true };
  })();
  return playerDirectoryPromise;
}

function rowIdentityKeys(row: PlayerDirectoryRow) {
  return new Set([
    normalizeEvidenceIdentity(row.canonical_name),
    normalizeEvidenceIdentity(row.normalized_key ?? ""),
    ...((row.aliases ?? []).map(normalizeEvidenceIdentity)),
  ].filter(Boolean));
}

function rowSurnameKeys(row: PlayerDirectoryRow) {
  const keys = new Set<string>();
  for (const value of [row.canonical_name, ...(row.aliases ?? [])]) {
    const normalized = normalizeEvidenceIdentity(value);
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length >= 2) keys.add(tokens[tokens.length - 1]);
  }
  return keys;
}

function directoryMatches(input: string, rows: PlayerDirectoryRow[]) {
  const normalized = normalizeEvidenceIdentity(input);
  const stableId = String(input ?? "").trim().toLowerCase();
  const surnameOnly = isSurnameOnlyEvidenceIdentity(input);
  const matches = new Map<string, PlayerDirectoryRow>();

  for (const row of rows) {
    const idMatch = String(row.id ?? "").toLowerCase() === stableId;
    const exactNameMatch = rowIdentityKeys(row).has(normalized);
    const surnameMatch = surnameOnly && rowSurnameKeys(row).has(normalized);
    if (!idMatch && !exactNameMatch && !surnameMatch) continue;
    matches.set(String(row.id), row);
  }
  return [...matches.values()];
}

function resolvedFromDirectory(input: string, row: PlayerDirectoryRow): CanonicalEvidenceIdentity {
  return {
    input,
    canonical: row.canonical_name,
    status: normalizeEvidenceIdentity(input) === normalizeEvidenceIdentity(row.canonical_name) ? "ALREADY_CANONICAL" : "RESOLVED",
    candidates: [row.canonical_name],
    query_errors: [],
    stable_id: row.id,
    normalized_key: row.normalized_key,
    aliases: row.aliases ?? [],
    tour: row.tour,
  };
}

async function pagedLane(
  input: string,
  fields: string[],
  makeQuery: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: { message: string } | null }>,
): Promise<LaneResult> {
  const names: string[] = [];
  for (let page = 0; page < MAX_PAGES_PER_LANE; page++) {
    const from = page * PAGE_SIZE;
    let result: { data: any[] | null; error: { message: string } | null };
    try { result = await makeQuery(from, from + PAGE_SIZE - 1); }
    catch (error) { return { names, errors: [error instanceof Error ? error.message : String(error)], truncated: false }; }
    if (result.error) return { names, errors: [result.error.message], truncated: false };
    const rows = result.data ?? [];
    names.push(...candidateNames(rows, fields));
    if (exactCanonicalCandidates(input, names).size > 1) return { names, errors: [], truncated: false };
    if (rows.length < PAGE_SIZE) return { names, errors: [], truncated: false };
  }
  return { names, errors: [], truncated: true };
}

async function queryEvidenceCandidates(input: string) {
  const token = normalizeEvidenceIdentity(input);
  if (!token || !/^[a-z0-9]+$/.test(token)) return { names: [] as string[], errors: ["Identity token is not query-safe."], truncated: false };
  const pattern = `%${token}%`;
  const lanes = await Promise.all([
    pagedLane(input, ["player_name"], (from, to) => db.from("source_observations")
      .select("id,player_name").not("observation_type", "in", "(POINT_BY_POINT,PBP,MARKET)")
      .ilike("player_name", pattern).order("id", { ascending: true }).range(from, to)),
    pagedLane(input, ["opponent_name"], (from, to) => db.from("source_observations")
      .select("id,opponent_name").not("observation_type", "in", "(POINT_BY_POINT,PBP,MARKET)")
      .ilike("opponent_name", pattern).order("id", { ascending: true }).range(from, to)),
    pagedLane(input, ["player_name"], (from, to) => db.from("metric_evidence_store")
      .select("id,player_name").ilike("player_name", pattern).order("id", { ascending: true }).range(from, to)),
    pagedLane(input, ["opponent_name"], (from, to) => db.from("metric_evidence_store")
      .select("id,opponent_name").ilike("opponent_name", pattern).order("id", { ascending: true }).range(from, to)),
  ]);
  return {
    names: lanes.flatMap((lane) => lane.names),
    errors: lanes.flatMap((lane) => lane.errors),
    truncated: lanes.some((lane) => lane.truncated),
  };
}

export async function resolveCanonicalEvidenceIdentity(input: string): Promise<CanonicalEvidenceIdentity> {
  const directory = await loadPlayerDirectory();
  const matches = directoryMatches(input, directory.rows);

  // Stable IDs, normalized keys, full canonical names and declared aliases all
  // resolve through the canonical player directory before display-name evidence.
  if (!directory.errors.length && !directory.truncated) {
    if (matches.length === 1) return resolvedFromDirectory(input, matches[0]);
    if (matches.length > 1) {
      return {
        input, canonical: input, status: "AMBIGUOUS",
        candidates: matches.map((row) => row.canonical_name).sort(), query_errors: [],
      };
    }
  }

  if (!isSurnameOnlyEvidenceIdentity(input)) {
    if (directory.errors.length || directory.truncated) {
      return {
        input, canonical: input, status: "QUERY_FAILED", candidates: matches.map((row) => row.canonical_name).sort(),
        query_errors: [...directory.errors, ...(directory.truncated ? ["Canonical player directory lookup exceeded its bounded pagination window."] : [])],
      };
    }
    // A full name not present in the canonical directory remains usable as its
    // own exact identity. We never fuzzy-expand it.
    return { input, canonical: input, status: "ALREADY_CANONICAL", candidates: [input], query_errors: [] };
  }

  // Surname-only input is stricter: uniqueness must be proven. Combine the
  // canonical directory with non-PBP/non-market warehouse evidence, and fail
  // closed if either proof source is incomplete.
  const lookup = await queryEvidenceCandidates(input);
  const combinedNames = [
    ...matches.map((row) => row.canonical_name),
    ...lookup.names,
  ];
  const normalizedCandidates = exactCanonicalCandidates(input, combinedNames);
  const candidates = [...normalizedCandidates.values()].sort();
  const errors = [...directory.errors, ...lookup.errors];
  const truncated = directory.truncated || lookup.truncated;
  if (errors.length || truncated) {
    return {
      input, canonical: input, status: "QUERY_FAILED", candidates,
      query_errors: [...errors, ...(truncated ? ["Canonical warehouse identity lookup exceeded its bounded pagination window."] : [])],
    };
  }
  const canonical = uniqueCanonicalWarehouseIdentity(input, candidates);
  if (canonical) {
    const row = matches.find((entry) => normalizeEvidenceIdentity(entry.canonical_name) === normalizeEvidenceIdentity(canonical));
    return row ? resolvedFromDirectory(input, row) : { input, canonical, status: "RESOLVED", candidates, query_errors: [] };
  }
  return { input, canonical: input, status: candidates.length > 1 ? "AMBIGUOUS" : "UNRESOLVED", candidates, query_errors: [] };
}

export async function resolveCanonicalEvidencePair(p1: string, p2: string) {
  const [left, right] = await Promise.all([resolveCanonicalEvidenceIdentity(p1), resolveCanonicalEvidenceIdentity(p2)]);
  if (normalizeEvidenceIdentity(left.canonical) === normalizeEvidenceIdentity(right.canonical)) {
    return {
      p1: { ...left, canonical: p1, status: left.status === "ALREADY_CANONICAL" ? left.status : "AMBIGUOUS" as IdentityStatus },
      p2: { ...right, canonical: p2, status: right.status === "ALREADY_CANONICAL" ? right.status : "AMBIGUOUS" as IdentityStatus },
    };
  }
  return { p1: left, p2: right };
}
