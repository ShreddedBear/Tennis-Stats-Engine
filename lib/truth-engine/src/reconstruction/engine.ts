// ============================================================================
// DETERMINISTIC RECONSTRUCTION ENGINE (PASS 2)
//
// Input : atomic statistics that were DIRECTLY sourced from named public
//         tennis sources (extraction only — no derivation by the model).
// Output: additional atomic statistics computed by approved formulas, each
//         carrying a full provenance chain, plus an explicit record of every
//         reconstruction that was REFUSED and exactly which inputs were absent.
//
// Guardrails enforced here, not by the model:
//  * only formulas from RECONSTRUCTION_SPECS may execute;
//  * every mandatory input must exist in the SAME evidence context
//    (same player, surface and time window) — no cross-context blending;
//  * inputs must themselves be DIRECT or previously RECONSTRUCTED;
//  * results outside the catalog's validity range are discarded;
//  * sample-size floors are respected;
//  * nothing is ever estimated, imputed or defaulted.
// ============================================================================

import { STAT_BY_KEY } from "./stat-catalog";
import { RECONSTRUCTION_SPECS, type ReconstructionSpec } from "./specs";

export type StatOrigin = "DIRECT" | "RECONSTRUCTED";

export interface StatSource {
  source_name: string;
  url?: string | null;
  retrieved_at?: string | null;
}

export interface SourcedStat {
  key: string;
  player: string;
  value: number;
  /** Surface the figure describes; null = surface-agnostic. */
  surface: string | null;
  /** Time window, e.g. "52w", "2026 season", "career". */
  window: string | null;
  tour_level?: string | null;
  sample?: number | null;
  origin: StatOrigin;
  sources: StatSource[];
  /** Present only for reconstructed values. */
  spec_id?: string;
  formula?: string;
  calculation?: string;
  inputs?: SourcedStat[];
}

export interface BlockedReconstruction {
  spec_id: string;
  output: string;
  player: string;
  surface: string | null;
  window: string | null;
  missing: string[];
  reason: string;
}

export interface ReconstructionOutcome {
  derived: SourcedStat[];
  blocked: BlockedReconstruction[];
}

const norm = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : null);
const ctxKey = (s: { player: string; surface: string | null; window: string | null }) =>
  `${norm(s.player)}|${norm(s.surface) ?? "*"}|${norm(s.window) ?? "*"}`;

/** Discard anything that is not a catalogued, finite, in-range statistic. */
export function sanitizeEvidence(raw: SourcedStat[]): SourcedStat[] {
  const out: SourcedStat[] = [];
  for (const s of raw) {
    const def = STAT_BY_KEY.get(s.key);
    if (!def) continue;
    if (typeof s.value !== "number" || !Number.isFinite(s.value)) continue;
    if (s.value < def.min || s.value > def.max) continue;
    if (!s.sources?.length || !s.sources.some((src) => src.source_name?.trim())) continue; // unsourced = inadmissible
    out.push({ ...s, origin: "DIRECT", surface: s.surface ?? null, window: s.window ?? null });
  }
  return out;
}

function describe(spec: ReconstructionSpec, values: Record<string, number>, result: number): string {
  const subs = spec.required.map((k) => `${k}=${round(values[k]!)}`).join(", ");
  return `${spec.formula} with ${subs} → ${round(result)}`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Run every approved spec against the supplied evidence, iterating so that a
 * reconstructed value may legally feed another approved formula. The chain of
 * provenance is preserved at every level.
 */
export function reconstruct(evidenceIn: SourcedStat[]): ReconstructionOutcome {
  const evidence = sanitizeEvidence(evidenceIn);
  // context -> key -> stat (direct wins over reconstructed)
  const table = new Map<string, Map<string, SourcedStat>>();
  const put = (s: SourcedStat) => {
    const ctx = ctxKey(s);
    const bucket = table.get(ctx) ?? new Map<string, SourcedStat>();
    const existing = bucket.get(s.key);
    if (!existing || (existing.origin === "RECONSTRUCTED" && s.origin === "DIRECT")) bucket.set(s.key, s);
    table.set(ctx, bucket);
  };
  evidence.forEach(put);

  const derived: SourcedStat[] = [];
  const blockedMap = new Map<string, BlockedReconstruction>();

  for (let pass = 0; pass < 4; pass++) {
    let progressed = false;
    for (const [, bucket] of table) {
      const any = bucket.values().next().value as SourcedStat | undefined;
      if (!any) continue;
      for (const spec of RECONSTRUCTION_SPECS) {
        if (bucket.has(spec.output) && bucket.get(spec.output)!.origin === "DIRECT") continue;
        if (bucket.has(spec.output)) continue; // already reconstructed

        const missing = spec.required.filter((k) => !bucket.has(k));
        const blockKey = `${spec.id}|${ctxKey(any)}`;
        if (missing.length) {
          blockedMap.set(blockKey, {
            spec_id: spec.id,
            output: spec.output,
            player: any.player,
            surface: any.surface,
            window: any.window,
            missing,
            reason: `Mandatory input(s) not independently sourced: ${missing.join(", ")}. Value left UNAVAILABLE rather than estimated.`,
          });
          continue;
        }

        const inputs = spec.required.map((k) => bucket.get(k)!);
        const values: Record<string, number> = {};
        for (const i of inputs) values[i.key] = i.value;

        // Sample floor
        if (spec.minSample) {
          const s = bucket.get(spec.minSample.input);
          const observed = s?.value ?? inputs.find((i) => i.sample != null)?.sample ?? null;
          if (spec.minSample.min > 0 && (observed == null || observed < spec.minSample.min)) {
            blockedMap.set(blockKey, {
              spec_id: spec.id,
              output: spec.output,
              player: any.player,
              surface: any.surface,
              window: any.window,
              missing: [spec.minSample.input],
              reason: `Sample below the approved floor (${spec.minSample.input} ≥ ${spec.minSample.min} required, observed ${observed ?? "unknown"}).`,
            });
            continue;
          }
        }

        let result: number | null = null;
        try {
          result = spec.compute(values);
        } catch {
          result = null;
        }
        const def = STAT_BY_KEY.get(spec.output)!;
        if (result === null || !Number.isFinite(result) || result < def.min || result > def.max) {
          blockedMap.set(blockKey, {
            spec_id: spec.id,
            output: spec.output,
            player: any.player,
            surface: any.surface,
            window: any.window,
            missing: [],
            reason:
              result === null
                ? "Formula is undefined for the sourced inputs (zero denominator)."
                : `Computed value ${round(result)} falls outside the admissible range for ${spec.output}; discarded rather than clamped.`,
          });
          continue;
        }

        const stat: SourcedStat = {
          key: spec.output,
          player: any.player,
          value: round(result),
          surface: any.surface,
          window: any.window,
          tour_level: any.tour_level ?? null,
          sample: spec.minSample ? (bucket.get(spec.minSample.input)?.value ?? null) : null,
          origin: "RECONSTRUCTED",
          sources: dedupeSources(inputs.flatMap((i) => i.sources)),
          spec_id: spec.id,
          formula: spec.formula,
          calculation: describe(spec, values, result),
          inputs,
        };
        put(stat);
        derived.push(stat);
        blockedMap.delete(blockKey);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  // A spec that eventually succeeded must not also be reported as blocked.
  const succeeded = new Set(derived.map((d) => `${d.spec_id}|${ctxKey(d)}`));
  return { derived, blocked: [...blockedMap.values()].filter((b) => !succeeded.has(`${b.spec_id}|${norm(b.player)}|${norm(b.surface) ?? "*"}|${norm(b.window) ?? "*"}`)) };
}

function dedupeSources(list: StatSource[]): StatSource[] {
  const seen = new Set<string>();
  const out: StatSource[] = [];
  for (const s of list) {
    const k = `${s.source_name}|${s.url ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Flatten a reconstructed value into a readable provenance chain. */
export function provenanceChain(stat: SourcedStat, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const def = STAT_BY_KEY.get(stat.key);
  const label = def?.label ?? stat.key;
  if (stat.origin === "DIRECT") {
    return [`${pad}${label} = ${stat.value} [DIRECT — ${stat.sources.map((s) => s.source_name).join("; ")}]`];
  }
  const head = `${pad}${label} = ${stat.value} [RECONSTRUCTED ${stat.spec_id}: ${stat.calculation}]`;
  return [head, ...(stat.inputs ?? []).flatMap((i) => provenanceChain(i, depth + 1))];
}

export function contextLabel(stat: { surface: string | null; window: string | null }): string {
  return [stat.surface ?? "all surfaces", stat.window ?? "unspecified window"].join(" · ");
}
