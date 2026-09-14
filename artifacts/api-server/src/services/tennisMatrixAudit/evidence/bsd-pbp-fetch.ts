// ----------------------------------------------------------------------------
// BSD/Bzzoiro point-by-point retrieval — classified.
//
// WHY THIS EXISTS: the four BSD modules each had their own `fetchPbp` that returned a bare
// `null` for five completely different conditions -- no API key configured, a non-OK HTTP
// status, a JSON parse failure, a network error or timeout, and the provider genuinely
// answering "no point-by-point available for this match". Downstream, all five looked
// identical, so an unconfigured credential was indistinguishable from a provider that had
// been asked and had nothing. That is the one distinction this engine must never lose: it
// is the difference between "we have no evidence" and "we never actually looked".
//
// So retrieval returns a discriminated result. Callers can still treat everything that is
// not `ok` as "no payload" -- the shape makes that easy -- but the REASON survives, and the
// status each module reports can say which of the five actually happened.
//
// TIMEOUTS. The per-request timeout used to be a hardcoded 12s, sitting inside a 7s
// stage-level budget (SOURCE_PACKET_BUDGET_MS) shared by five source builders. A single
// request was therefore allowed to outlive the entire stage it belonged to, which is
// incoherent: the stage could only ever end by abandoning work that was still legitimately
// in flight. Both are now configurable, and the per-request timeout is clamped so it can
// never exceed the stage budget it runs inside.
// ----------------------------------------------------------------------------

export const BSD_BASE = "https://sports.bzzoiro.com/tennis/api/v2";

/**
 * Why a retrieval produced no payload. These map onto the persisted unavailable-reason
 * vocabulary rather than inventing a parallel one, so a producer can pass them straight
 * through without translation.
 */
export type PbpFailureReason =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_TIMEOUT"
  | "PARSING_FAILED"
  | "NO_QUALIFYING_DATA";

export type PbpFetchResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: PbpFailureReason; detail: string; status?: number };

/** Read an integer from the environment, falling back when unset or not a sane number. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * The whole-stage budget for building source packets. Configurable because the right value
 * depends on how fast the provider actually answers, which is a deployment fact rather than
 * a property of the engine -- but bounded at both ends, so it can neither be set so low that
 * no retrieval can finish nor so high that a run hangs indefinitely.
 */
export function sourcePacketBudgetMs(): number {
  return envInt("AUDIT_SOURCE_PACKET_BUDGET_MS", 7_000, 1_000, 120_000);
}

/**
 * The per-request timeout, clamped to the stage budget. A request that cannot finish before
 * the stage it belongs to has to end is not a request worth waiting on: letting it run
 * longer only guarantees its result is discarded.
 */
export function pbpRequestTimeoutMs(): number {
  const requested = envInt("AUDIT_PBP_REQUEST_TIMEOUT_MS", 6_000, 500, 120_000);
  return Math.min(requested, sourcePacketBudgetMs());
}

/**
 * Fetch one match's point-by-point payload, classified.
 *
 * `available !== true` is the provider's own way of saying it holds no point data for this
 * match. That is a real, evidenced absence and is reported as NO_QUALIFYING_DATA -- distinct
 * from every failure above it, because it is the only one that says anything about the data.
 */
export async function fetchPbpClassified(
  id: string | number,
  options: { userAgent: string; token?: string | undefined; timeoutMs?: number },
): Promise<PbpFetchResult> {
  const token = options.token ?? process.env["BSD_TENNIS_API_KEY"];
  if (!token) {
    return {
      ok: false,
      reason: "PROVIDER_NOT_CONFIGURED",
      detail: "BSD_TENNIS_API_KEY is not set, so the point-by-point provider was never called.",
    };
  }

  const url = `${BSD_BASE}/matches/${encodeURIComponent(String(id))}/point-by-point/`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Token ${token}`, "User-Agent": options.userAgent },
      signal: AbortSignal.timeout(options.timeoutMs ?? pbpRequestTimeoutMs()),
    });
  } catch (error) {
    // A timeout and a transport failure are different operational problems: one says the
    // provider is slow, the other that it could not be reached at all.
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      reason: aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_HTTP_ERROR",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "PROVIDER_HTTP_ERROR",
      detail: `Provider responded ${response.status} ${response.statusText}`,
      status: response.status,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason: "PARSING_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "PARSING_FAILED", detail: "Provider returned a non-object payload." };
  }
  if ((parsed as { available?: unknown }).available !== true) {
    return {
      ok: false,
      reason: "NO_QUALIFYING_DATA",
      detail: "Provider holds no point-by-point data for this match.",
    };
  }
  return { ok: true, payload: parsed as Record<string, unknown> };
}

/** Counts of each failure reason across a batch, for the status a module reports. */
export type PbpRetrievalTally = Partial<Record<PbpFailureReason, number>> & { ok: number };

export function emptyTally(): PbpRetrievalTally {
  return { ok: 0 };
}

export function recordOutcome(tally: PbpRetrievalTally, result: PbpFetchResult): void {
  if (result.ok) tally.ok += 1;
  else tally[result.reason] = (tally[result.reason] ?? 0) + 1;
}

/**
 * A one-line summary of what a batch of retrievals actually did. Written so the distinction
 * survives into the persisted status rather than being flattened into "unavailable".
 */
export function describeTally(tally: PbpRetrievalTally): string {
  const parts: string[] = [];
  if (tally.ok) parts.push(`${tally.ok} retrieved`);
  for (const reason of [
    "PROVIDER_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_HTTP_ERROR", "PARSING_FAILED", "NO_QUALIFYING_DATA",
  ] as PbpFailureReason[]) {
    const count = tally[reason];
    if (count) parts.push(`${count} ${reason}`);
  }
  return parts.length ? parts.join(", ") : "no candidate matches to retrieve";
}

// ----------------------------------------------------------------------------
// Locating the bundled history indexes.
//
// The BSD modules discover candidate matches from JSON indexes shipped with the
// application. They resolved them against process.cwd(), which differs between running the
// server (artifacts/api-server) and running a script from the repository root -- and a path
// that misses does not fail loudly: readFile throws, the catch returns [], and the module
// reports "no candidate matches" exactly as it would if the player had never played. A
// deployment error becomes indistinguishable from evidence of absence, which is the one
// outcome this layer must never fake.
//
// So resolution is explicit and ordered, and a caller can pin it with AUDIT_DATA_ROOT.
// ----------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedRoot: string | null = null;

/** The directory containing `audit/` and `metrics/`, or null when none can be found. */
export function auditDataRoot(): string | null {
  if (cachedRoot !== null) return cachedRoot || null;

  const candidates: string[] = [];
  const pinned = process.env["AUDIT_DATA_ROOT"];
  if (pinned) candidates.push(resolve(pinned));
  candidates.push(join(process.cwd(), "data"));

  // Walk up from this module: covers both src/ during development and dist/ once bundled,
  // regardless of which directory the process happens to have been started from.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(join(dir, "data"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "audit")) || existsSync(join(candidate, "metrics"))) {
      cachedRoot = candidate;
      return candidate;
    }
  }
  cachedRoot = "";
  return null;
}

/**
 * Resolve a path under the data root. Returns null when the root is missing entirely, so a
 * caller can tell "the data is not deployed" apart from "this particular file is absent".
 */
export function auditDataPath(...segments: string[]): string | null {
  const root = auditDataRoot();
  return root === null ? null : join(root, ...segments);
}

/** Test hook: forget the memoised root so a different environment can be exercised. */
export function resetAuditDataRoot(): void {
  cachedRoot = null;
}
