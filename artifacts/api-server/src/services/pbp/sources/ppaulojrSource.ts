import { normalizePlayerName } from "../../tennisData/playerIdentity";
import type { PbpLookup, PbpSource, PbpTour, PointByPointRecord, PbpValidationStatus } from "../types";

/**
 * Adapter for the ppaulojr/tennis_pointbypoint GitHub dataset (2010-2015 main-draw point-by-point
 * sequences across ATP/WTA/Challenger/ITF/Futures).
 *
 * PROVENANCE — see docs/pbp-source-policy.md and the Truth Engine repo's own audit
 * (docs/atp-challenger-pbp-2012-2026-completion-audit.md, Addendum 5) for the full licensing
 * analysis. Summary: the repository carries no LICENSE file and no terms statement anywhere in
 * its history — this is NOT a permissive/no-restriction source, and is NOT the same thing as
 * Jeff Sackmann's own (differently-licensed) work. The project owner has explicitly authorized
 * integrating it as a CANDIDATE-only source specifically because raw match facts (point winners)
 * are not, by themselves, ppaulojr's to restrict, while his specific compiled file is. Every
 * record produced by this adapter is tagged `validationStatus: "CANDIDATE"` and carries its
 * source name and source record id — nothing here is ever silently promoted to VERIFIED.
 */
const BASE_URL = "https://raw.githubusercontent.com/ppaulojr/tennis_pointbypoint/master";
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "tennis-stats-engine-pbp-source-router/1.0";

const TOUR_FILE_PREFIX: Partial<Record<PbpTour, string>> = {
  ATP: "atp",
  WTA: "wta",
  Challenger: "ch",
  ITF: "itf",
  Futures: "fu",
};

export interface PpaulojrRawRow {
  date: string;
  tny_name: string;
  tour: string;
  draw: string;
  server1: string;
  server2: string;
  winner: string;
  pbp: string;
  score: string;
  adf_flag: string;
}

/** Minimal RFC-4180-compatible CSV row parser (same algorithm already used by sackmannBackfill.ts). */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = parseCsvRow(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j].trim()] = values[j] ?? "";
    rows.push(row);
  }
  return rows;
}

async function fetchCsv(url: string): Promise<Record<string, string>[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`ppaulojr fetch failed: HTTP ${res.status} for ${url}`);
    return parseCsv(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

function parseSourceDate(raw: string): string | null {
  // "DD Mon YY", e.g. "05 Jan 11".
  const m = raw.trim().match(/^(\d{1,2}) (\w{3}) (\d{2})$/);
  if (!m) return null;
  const [, d, mon, yy] = m;
  const months: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const mm = months[mon];
  if (!mm) return null;
  const year = Number(yy) <= 30 ? `20${yy}` : `19${yy}`; // dataset only spans 2010-2015; safe threshold
  return `${year}-${mm}-${d.padStart(2, "0")}`;
}

function toRecord(row: Record<string, string>, tour: PbpTour, sourceFile: string, rowIndex: number, validationStatus: PbpValidationStatus): PointByPointRecord | null {
  const date = parseSourceDate(row.date);
  const server1 = (row.server1 ?? "").trim();
  const server2 = (row.server2 ?? "").trim();
  const pbp = (row.pbp ?? "").trim();
  if (!date || !server1 || !server2 || !pbp) return null;
  const winnerRaw = (row.winner ?? "").trim();
  if (winnerRaw !== "1" && winnerRaw !== "2") return null;

  return {
    source: "ppaulojr",
    sourceRecordId: `${sourceFile}#${rowIndex}`,
    date,
    tournamentName: (row.tny_name ?? "").trim() || null,
    tour,
    draw: "Main",
    server1,
    server2,
    winner: winnerRaw === "1" ? 1 : 2,
    pbp,
    score: (row.score ?? "").trim() || null,
    adfFlag: row.adf_flag === "1" ? 1 : row.adf_flag === "0" ? 0 : null,
    validationStatus,
    provenanceNote:
      "Source: ppaulojr/tennis_pointbypoint (no LICENSE file; project owner has explicitly authorized CANDIDATE-only integration — see docs/pbp-source-policy.md). Raw match facts, not a licensed redistribution of the source's compiled file.",
    rawPayload: { ...row, __sourceFile: sourceFile, __rowIndex: rowIndex },
  };
}

export interface PpaulojrPbpSourceOptions {
  priority?: number;
  enabled?: boolean;
  /** Injectable for tests — defaults to the real GitHub fetch. */
  fetchImpl?: (url: string) => Promise<Record<string, string>[]>;
}

export class PpaulojrPbpSource implements PbpSource {
  readonly name = "ppaulojr";
  readonly priority: number;
  readonly enabled: boolean;
  readonly validationStatus: PbpValidationStatus = "CANDIDATE";

  private readonly fetchCsvImpl: (url: string) => Promise<Record<string, string>[]>;
  private readonly cache = new Map<string, Promise<Record<string, string>[]>>();

  constructor(options: PpaulojrPbpSourceOptions = {}) {
    // Deliberately low priority: this is the least-verified, least-licensed source available.
    // Any future source with a real license/API contract should be registered at a lower
    // (higher-priority) number so the router tries it first.
    this.priority = options.priority ?? 100;
    this.enabled = options.enabled ?? true;
    this.fetchCsvImpl = options.fetchImpl ?? fetchCsv;
  }

  private filesFor(tour: PbpTour): string[] {
    const prefix = TOUR_FILE_PREFIX[tour];
    if (!prefix) return [];
    return [`pbp_matches_${prefix}_main_archive.csv`, `pbp_matches_${prefix}_main_current.csv`];
  }

  private async loadFile(filename: string): Promise<Record<string, string>[]> {
    const cached = this.cache.get(filename);
    if (cached) return cached;
    const promise = this.fetchCsvImpl(`${BASE_URL}/${filename}`);
    this.cache.set(filename, promise);
    promise.catch(() => this.cache.delete(filename));
    return promise;
  }

  async lookup(match: PbpLookup): Promise<PointByPointRecord | null> {
    const tour = match.tour ?? "ATP";
    const files = this.filesFor(tour);
    if (files.length === 0) return null;

    const wantP1 = normalizePlayerName(match.player1Name);
    const wantP2 = normalizePlayerName(match.player2Name);

    for (const file of files) {
      const rows = await this.loadFile(file);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const s1 = normalizePlayerName(row.server1 ?? "");
        const s2 = normalizePlayerName(row.server2 ?? "");
        const straight = s1 === wantP1 && s2 === wantP2;
        const flipped = s1 === wantP2 && s2 === wantP1;
        if (!straight && !flipped) continue;

        const date = parseSourceDate(row.date ?? "");
        if (match.date && date && date !== match.date) continue;

        const record = toRecord(row, tour, file, i, this.validationStatus);
        if (record) return record;
      }
    }
    return null;
  }

  /** Bulk export for the backfill pipeline — yields every parseable row for a tour's main draw. */
  async *bulkFetch(tour: PbpTour): AsyncGenerator<PointByPointRecord> {
    const files = this.filesFor(tour);
    for (const file of files) {
      const rows = await this.loadFile(file);
      for (let i = 0; i < rows.length; i++) {
        const record = toRecord(rows[i], tour, file, i, this.validationStatus);
        if (record) yield record;
      }
    }
  }
}
