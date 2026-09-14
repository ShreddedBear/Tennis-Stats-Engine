// Live Supabase wrapper for metrics #036/#037 (Loss/Win Autopsy) and #039
// (Performance Surprise Rating). Pulls the audit DB's own
// parsed_summary_fields-scored, completed-match population and turns it
// into the pure ScoredOutcome/SurpriseInput shapes those modules already
// take -- see their headers for why this population is bounded to the
// audit DB and never extended to the four-tour historical index.
//
// The population-wide summary helpers remain useful for calibration/admin
// reporting, but are never used as a per-player audit value. The live metric
// adapter below independently filters this population for P1 and P2, or
// returns UNAVAILABLE when the necessary player-specific history is absent.
// Metric 036 continues to use audit-metric-036-loss-autopsy.ts and the static
// four-tour history; this file owns only the audit-DB-dependent 037/039 path.
//
// Follows the same supabaseAdmin/ownerId/LOCAL_WORKSPACE_ID convention as
// audit-repo.server.ts, and the same summary_versions(match_id, is_active)
// -> parsed_summary_fields(summary_version_id) join it already uses for
// getParsedFields (not matches.active_summary_version_id, which
// calibration-matrix-autofill.ts uses for a different, single-match UI path).
import { supabaseAdmin } from "./postgrestCompat";
import { LOCAL_WORKSPACE_ID } from "./constants";
import {
  computeLossWinAutopsy,
  isPredictionBeforeResult,
  isCloseMatch,
  parseFinalScoreSets,
  summarizeAutopsyDistribution,
  type ScoredOutcome,
} from "./audit-metric-036-037-loss-win-autopsy";
import {
  computeRollingSurprise,
  computeSignedSurprise,
  type SurpriseInput,
} from "./audit-metric-039-performance-surprise";
import { MIN_SUPPORT_N, round1 } from "./audit-metrics-shared";
import { normalizeEvidenceIdentity } from "./evidence-player-alias";
import type { MetricFinding } from "./audit-pipeline";
import { BoundedPromiseCache } from "./bounded-promise-cache";

const OWNER = LOCAL_WORKSPACE_ID;
const AUDIT_DB_SOURCE = "Audit DB completed TennisMatrixAi-scored matches";
const ROLLING_SURPRISE_WINDOW = 10;
export const AUDIT_DB_PAGE_SIZE = 500;
const AUDIT_DB_ID_BATCH_SIZE = 100;
const scoredMatchesCache = new BoundedPromiseCache<ScoredMatchRow[]>(1, 5 * 60_000);

export async function collectPaged<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = AUDIT_DB_PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function batches<T>(rows: T[], size = AUDIT_DB_ID_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function strictNameMatches(candidateName: string | null, expectedName: string): boolean {
  const candidate = normalizeEvidenceIdentity(candidateName);
  const expected = normalizeEvidenceIdentity(expectedName);
  if (!candidate || !expected) return false;
  if (candidate === expected) return true;
  const candidateParts = candidate.split(" ");
  const expectedParts = expected.split(" ");
  if (candidateParts.length > 1 && expectedParts.length > 1) return false;
  return candidateParts.at(-1) === expectedParts.at(-1);
}

export interface ScoredMatchRow {
  id: string;
  final_score: string | null;
  best_of: number | null;
  actual_winner: string | null;
  player1_name: string;
  player2_name: string;
  result_recorded_at: string | null;
  matrixWp: number;
  matrixPredictedWinner: string;
  matrixWpCreatedAt: string;
  matrixPredictedWinnerCreatedAt: string;
}

export interface PlayerScoredMatch {
  matchId: string;
  resultRecordedAt: string;
  finalScore: string | null;
  outcome: ScoredOutcome;
}

/**
 * Loads every completed, TennisMatrixAi-scored match in the audit DB --
 * actual_winner populated AND a numeric matrix_wp/matrix_predicted_winner
 * recorded against its active summary version -- with the leakage guard
 * already applied (a matrix_wp field recorded on/after the match's own
 * result_recorded_at is dropped, never trusted as a genuine pre-match call).
 */
export async function loadAuditDbScoredMatches(): Promise<ScoredMatchRow[]> {
  return scoredMatchesCache.getOrCreate("all", fetchAuditDbScoredMatches);
}

async function fetchAuditDbScoredMatches(): Promise<ScoredMatchRow[]> {
  const db = supabaseAdmin as any;
  type MatchRow = Pick<ScoredMatchRow, "id" | "final_score" | "best_of" | "actual_winner" | "player1_name" | "player2_name" | "result_recorded_at">;
  type VersionRow = { id: string; match_id: string };
  type FieldRow = { id: string; summary_version_id: string; field_key: string; normalized_value: string | null; created_at: string };

  const matches = await collectPaged<MatchRow>(async (from, to) => {
    const { data, error } = await db
      .from("matches")
      .select("id, final_score, best_of, actual_winner, player1_name, player2_name, result_recorded_at")
      .eq("user_id", OWNER)
      .not("actual_winner", "is", null)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`Audit DB scored-match query failed: ${error.message}`);
    return data ?? [];
  });
  if (!matches.length) return [];

  const versions: VersionRow[] = [];
  for (const matchBatch of batches(matches)) {
    versions.push(...await collectPaged<VersionRow>(async (from, to) => {
      const { data, error } = await db
        .from("summary_versions")
        .select("id, match_id")
        .eq("user_id", OWNER)
        .eq("is_active", true)
        .in("match_id", matchBatch.map(match => match.id))
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`Audit DB summary-version query failed: ${error.message}`);
      return data ?? [];
    }));
  }
  if (!versions.length) return [];
  const versionIdToMatchId = new Map(versions.map(version => [version.id, version.match_id]));

  const fields: FieldRow[] = [];
  for (const versionBatch of batches(versions)) {
    fields.push(...await collectPaged<FieldRow>(async (from, to) => {
      const { data, error } = await db
        .from("parsed_summary_fields")
        .select("id, summary_version_id, field_key, normalized_value, created_at")
        .in("summary_version_id", versionBatch.map(version => version.id))
        .in("field_key", ["matrix_wp", "matrix_predicted_winner"])
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`Audit DB prediction-field query failed: ${error.message}`);
      return data ?? [];
    }));
  }
  if (!fields.length) return [];

  const byMatch = new Map<string, { wp?: string; wpCreatedAt?: string; predictedWinner?: string; predictedWinnerCreatedAt?: string }>();
  for (const f of [...fields].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const matchId = versionIdToMatchId.get(f.summary_version_id);
    if (!matchId) continue;
    const entry = byMatch.get(matchId) ?? {};
    if (f.field_key === "matrix_wp") { entry.wp = f.normalized_value ?? undefined; entry.wpCreatedAt = f.created_at; }
    if (f.field_key === "matrix_predicted_winner") {
      entry.predictedWinner = f.normalized_value ?? undefined;
      entry.predictedWinnerCreatedAt = f.created_at;
    }
    byMatch.set(matchId, entry);
  }

  const matchById = new Map(matches.map((m) => [m.id, m]));
  const out: ScoredMatchRow[] = [];
  for (const [matchId, entry] of byMatch) {
    const match = matchById.get(matchId);
    if (!match || !entry.wp || !entry.predictedWinner || !entry.wpCreatedAt || !entry.predictedWinnerCreatedAt) continue;
    const wp = Number(entry.wp);
    if (!Number.isFinite(wp) || wp < 0 || wp > 100) continue; // never coerce or clamp a malformed probability
    if (!isPredictionBeforeResult(entry.wpCreatedAt, match.result_recorded_at)) continue; // leakage guard
    if (!isPredictionBeforeResult(entry.predictedWinnerCreatedAt, match.result_recorded_at)) continue;
    out.push({
      id: match.id,
      final_score: match.final_score, best_of: match.best_of, actual_winner: match.actual_winner,
      player1_name: match.player1_name, player2_name: match.player2_name, result_recorded_at: match.result_recorded_at,
      matrixWp: wp, matrixPredictedWinner: entry.predictedWinner, matrixWpCreatedAt: entry.wpCreatedAt,
      matrixPredictedWinnerCreatedAt: entry.predictedWinnerCreatedAt,
    });
  }
  return out;
}

/** Converts a scored match row into #036/#037's ScoredOutcome, from the perspective of the player TennisMatrixAi favored. */
export function toScoredOutcome(row: ScoredMatchRow): ScoredOutcome {
  const playerWon = strictNameMatches(row.actual_winner, row.matrixPredictedWinner);
  return {
    playerWinProbabilityPct: row.matrixWp,
    playerWon,
    wasClose: isCloseMatch(row.final_score, row.best_of),
  };
}

/** Converts a scored match row into #039's SurpriseInput, from the same TennisMatrixAi-favored-player perspective. */
export function toSurpriseInput(row: ScoredMatchRow): SurpriseInput {
  return {
    playerWinProbabilityPct: row.matrixWp,
    playerWon: strictNameMatches(row.actual_winner, row.matrixPredictedWinner),
  };
}

function uniqueParticipantSide(row: ScoredMatchRow, name: string): "P1" | "P2" | null {
  const p1 = strictNameMatches(row.player1_name, name);
  const p2 = strictNameMatches(row.player2_name, name);
  return p1 === p2 ? null : p1 ? "P1" : "P2";
}

function validAsOfBoundary(asOfDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return null;
  const parsed = Date.parse(`${asOfDate}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Produces a player's independently oriented, chronological history.
 * Probabilities are inverted only when the stored predicted winner resolves
 * unambiguously to the opponent side. Every ambiguous row is dropped.
 */
export function playerScoredHistory(rows: ScoredMatchRow[], player: string, asOfDate: string): PlayerScoredMatch[] {
  const boundary = validAsOfBoundary(asOfDate);
  if (boundary === null) return [];
  const history: PlayerScoredMatch[] = [];

  for (const row of rows) {
    const resultTime = Date.parse(row.result_recorded_at ?? "");
    if (!Number.isFinite(resultTime) || resultTime >= boundary) continue;
    if (!isPredictionBeforeResult(row.matrixWpCreatedAt, row.result_recorded_at)) continue;
    if (!isPredictionBeforeResult(row.matrixPredictedWinnerCreatedAt, row.result_recorded_at)) continue;
    if (!Number.isFinite(row.matrixWp) || row.matrixWp < 0 || row.matrixWp > 100) continue;

    const playerSide = uniqueParticipantSide(row, player);
    const predictedSide = uniqueParticipantSide(row, row.matrixPredictedWinner);
    const winnerSide = uniqueParticipantSide(row, row.actual_winner ?? "");
    if (!playerSide || !predictedSide || !winnerSide) continue;

    const probability = predictedSide === playerSide ? row.matrixWp : 100 - row.matrixWp;
    history.push({
      matchId: row.id,
      resultRecordedAt: row.result_recorded_at!,
      finalScore: row.final_score,
      outcome: {
        playerWinProbabilityPct: probability,
        playerWon: winnerSide === playerSide,
        wasClose: isCloseMatch(row.final_score, row.best_of),
      },
    });
  }

  return history.sort((a, b) => a.resultRecordedAt.localeCompare(b.resultRecordedAt) || a.matchId.localeCompare(b.matchId));
}

function unavailableSide(reason: string) {
  return { value: null, treatment: "UNAVAILABLE" as const, reason };
}

function winAutopsySide(player: string, history: PlayerScoredMatch[]) {
  const wins = history.filter(item => item.outcome.playerWon && parseFinalScoreSets(item.finalScore).length > 0);
  const summary = summarizeAutopsyDistribution(wins.map(item => item.outcome));
  if (summary.status !== "GO") {
    return unavailableSide(`Only ${summary.n} prior TennisMatrixAi-scored wins with a parseable final score were available for ${player}; minimum support is ${MIN_SUPPORT_N}.`);
  }
  const closeWins = wins.filter(item => item.outcome.wasClose).length;
  const probabilities = wins.map(item => item.outcome.playerWinProbabilityPct);
  const categories = ["DOMINANT", "ROUTINE", "ESCAPE", "UPSET_WIN", "UNCLASSIFIED"]
    .map(category => `${category}:${summary.value[category] ?? 0}`)
    .join(",");
  return {
    value: [
      `PLAYER=${player}`,
      `SOURCE=${AUDIT_DB_SOURCE}`,
      `SAMPLE=prior scored wins n=${summary.n}`,
      "FORMULA=classify each completed win from the player's frozen pre-match win probability and final score margin",
      `recent scored wins=${summary.n}`,
      `pre match win probability range=${Math.min(...probabilities)}-${Math.max(...probabilities)} pct`,
      `final score margin close wins=${closeWins}/${summary.n}`,
      `win autopsy category distribution=${categories}`,
      "opponent collapse=UNAVAILABLE (no stored in-play probability series)",
    ].join("; "),
    treatment: "RECONSTRUCTED" as const,
    reason: null,
  };
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function performanceSurpriseSide(player: string, history: PlayerScoredMatch[]) {
  if (history.length < MIN_SUPPORT_N) {
    return unavailableSide(`Only ${history.length} prior TennisMatrixAi-scored matches were available for ${player}; minimum support is ${MIN_SUPPORT_N}.`);
  }
  const latest = history.at(-1)!;
  const chronological = history.map(item => ({
    playerWinProbabilityPct: item.outcome.playerWinProbabilityPct,
    playerWon: item.outcome.playerWon,
  }));
  const rolling = computeRollingSurprise(chronological, ROLLING_SURPRISE_WINDOW);
  const actual = latest.outcome.playerWon ? 1 : 0;
  const expected = round1(latest.outcome.playerWinProbabilityPct)! / 100;
  const surprise = round1(computeSignedSurprise(chronological.at(-1)!) * 100)! / 100;
  return {
    value: [
      `PLAYER=${player}`,
      `SOURCE=${AUDIT_DB_SOURCE}`,
      `SAMPLE=prior scored matches n=${history.length}; rolling n=${rolling.n}`,
      "FORMULA=actual performance (1 win, 0 loss) minus pre match expected performance frozen before result",
      `actual performance=${actual}`,
      `pre match expected performance=${expected}`,
      `performance surprise=${signed(surprise)}`,
      `rolling performance surprise last 10=${signed(rolling.mean_signed_surprise)}`,
      `rolling absolute surprise last 10=${rolling.mean_absolute_surprise}`,
      `latest eligible result recorded at=${latest.resultRecordedAt}`,
    ].join("; "),
    treatment: "RECONSTRUCTED" as const,
    reason: null,
  };
}

export function isAuditDbCompositeMetric(metricCode: string) {
  const match = String(metricCode).match(/(\d{1,3})$/);
  const code = match ? match[1].padStart(3, "0") : String(metricCode).padStart(3, "0");
  return code === "037" || code === "039";
}

/** Pure adapter used by tests and by the live DB-loading wrapper below. */
export function buildAuditDbCompositeMetricFinding(args: {
  metricCode: string;
  p1: string;
  p2: string;
  asOfDate: string;
  rows: ScoredMatchRow[];
}): MetricFinding | null {
  const match = String(args.metricCode).match(/(\d{1,3})$/);
  const code = match ? match[1].padStart(3, "0") : String(args.metricCode).padStart(3, "0");
  if (!isAuditDbCompositeMetric(code)) return null;

  const p1History = playerScoredHistory(args.rows, args.p1, args.asOfDate);
  const p2History = playerScoredHistory(args.rows, args.p2, args.asOfDate);
  const p1 = code === "037" ? winAutopsySide(args.p1, p1History) : performanceSurpriseSide(args.p1, p1History);
  const p2 = code === "037" ? winAutopsySide(args.p2, p2History) : performanceSurpriseSide(args.p2, p2History);
  const reasons = [p1.reason, p2.reason].filter((reason): reason is string => Boolean(reason));

  return {
    metric_code: code,
    p1_value: p1.value,
    p2_value: p2.value,
    p1_treatment: p1.treatment,
    p2_treatment: p2.treatment,
    differential: null,
    evidence_family: code === "037" ? "AUDIT_DB_PLAYER_WIN_AUTOPSY" : "AUDIT_DB_PLAYER_PERFORMANCE_SURPRISE",
    reliability: 95,
    sample: `audit DB player history before ${args.asOfDate}; P1 n=${p1History.length}; P2 n=${p2History.length}`,
    unavailable_reason: reasons.length ? reasons.join(" | ") : null,
    missing_inputs: reasons.length ? ["minimum player-specific pre-result TennisMatrixAi-scored history"] : [],
    sources: [{ source_name: AUDIT_DB_SOURCE, url: null, retrieved_at: null }],
  };
}

/** Loads the bounded audit-DB population and returns an owned 037/039 finding. */
export async function auditDbCompositeMetric(args: {
  metricCode: string;
  p1: string;
  p2: string;
  asOfDate: string;
}): Promise<MetricFinding | null> {
  if (!isAuditDbCompositeMetric(args.metricCode)) return null;
  try {
    return buildAuditDbCompositeMetricFinding({ ...args, rows: await loadAuditDbScoredMatches() });
  } catch (error) {
    const match = String(args.metricCode).match(/(\d{1,3})$/);
    const code = match ? match[1].padStart(3, "0") : String(args.metricCode).padStart(3, "0");
    const message = error instanceof Error ? error.message : "Unknown audit DB retrieval failure.";
    return {
      metric_code: code,
      p1_value: null,
      p2_value: null,
      p1_treatment: "UNAVAILABLE",
      p2_treatment: "UNAVAILABLE",
      differential: null,
      evidence_family: code === "037" ? "AUDIT_DB_PLAYER_WIN_AUTOPSY" : "AUDIT_DB_PLAYER_PERFORMANCE_SURPRISE",
      reliability: null,
      sample: `audit DB player history before ${args.asOfDate}; retrieval incomplete`,
      unavailable_reason: message,
      provider_error: message,
      missing_inputs: ["complete paginated audit DB prediction history"],
      sources: [{ source_name: AUDIT_DB_SOURCE, url: null, retrieved_at: null }],
    };
  }
}
