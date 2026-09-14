// ============================================================================
// APPROVED RECONSTRUCTION SPECIFICATIONS
//
// Every formula the engine is allowed to execute is declared here, statically.
// The AI is NEVER allowed to invent a formula: it may only supply directly
// sourced atomic inputs, which deterministic code then combines.
//
// A spec that cannot find every mandatory input in a single compatible
// evidence context is skipped and the target stays UNAVAILABLE with the
// missing inputs recorded.
// ============================================================================

import { STAT_BY_KEY } from "./stat-catalog";

export interface ReconstructionSpec {
  /** Stable spec identifier persisted with every reconstructed value. */
  id: string;
  /** Atomic statistic produced. */
  output: string;
  /** Human-readable approved formula, persisted with the result. */
  formula: string;
  /** Mandatory inputs. Missing ANY of them blocks the reconstruction. */
  required: string[];
  /** Optional inputs used only for cross-validation, never to fill a gap. */
  optional?: string[];
  /** Minimum denominator sample; below it the reconstruction is refused. */
  minSample?: { input: string; min: number };
  /** Deterministic computation. Returns null when the maths is undefined. */
  compute(v: Record<string, number>): number | null;
  /** Substitutions explicitly forbidden for this spec (documentation + audit). */
  prohibited?: string[];
  /** Contexts (surface/time window) the spec may be applied in. */
  contextSensitive?: boolean;
}

const pct = (num: number, den: number) => (den > 0 ? (num / den) * 100 : null);

export const RECONSTRUCTION_SPECS: ReconstructionSpec[] = [
  // ---------------------------- serve -------------------------------------
  {
    id: "RS-SRV-01",
    output: "first_serve_in_pct",
    formula: "first_serves_in / service_points × 100",
    required: ["first_serves_in", "service_points"],
    minSample: { input: "service_points", min: 100 },
    compute: (v) => pct(v["first_serves_in"]!, v["service_points"]!),
    prohibited: ["tour-average first-serve rates", "opponent first-serve data"],
    contextSensitive: true,
  },
  {
    id: "RS-SRV-02",
    output: "first_serve_points_won_pct",
    formula: "first_serve_points_won / first_serves_in × 100",
    required: ["first_serve_points_won", "first_serves_in"],
    minSample: { input: "first_serves_in", min: 80 },
    compute: (v) => pct(v["first_serve_points_won"]!, v["first_serves_in"]!),
    contextSensitive: true,
  },
  {
    id: "RS-SRV-03",
    output: "second_serve_points",
    formula: "service_points − first_serves_in",
    required: ["service_points", "first_serves_in"],
    compute: (v) => v["service_points"]! - v["first_serves_in"]!,
    contextSensitive: true,
  },
  {
    id: "RS-SRV-04",
    output: "second_serve_points_won_pct",
    formula: "second_serve_points_won / second_serve_points × 100",
    required: ["second_serve_points_won", "second_serve_points"],
    minSample: { input: "second_serve_points", min: 60 },
    compute: (v) => pct(v["second_serve_points_won"]!, v["second_serve_points"]!),
    contextSensitive: true,
  },
  {
    id: "RS-SRV-05",
    output: "service_points_won_pct",
    formula:
      "first_serve_in_pct/100 × first_serve_points_won_pct + (1 − first_serve_in_pct/100) × second_serve_points_won_pct",
    required: ["first_serve_in_pct", "first_serve_points_won_pct", "second_serve_points_won_pct"],
    compute: (v) => {
      const i = v["first_serve_in_pct"]! / 100;
      return i * v["first_serve_points_won_pct"]! + (1 - i) * v["second_serve_points_won_pct"]!;
    },
    prohibited: ["substituting hold % for service points won %"],
    contextSensitive: true,
  },
  {
    id: "RS-SRV-06",
    output: "hold_pct",
    formula: "service_games_won / service_games × 100",
    required: ["service_games_won", "service_games"],
    minSample: { input: "service_games", min: 30 },
    compute: (v) => pct(v["service_games_won"]!, v["service_games"]!),
    contextSensitive: true,
  },
  {
    id: "RS-SRV-07",
    output: "ace_rate_pct",
    formula: "aces / service_points × 100",
    required: ["aces", "service_points"],
    minSample: { input: "service_points", min: 100 },
    compute: (v) => pct(v["aces"]!, v["service_points"]!),
    contextSensitive: true,
  },
  {
    id: "RS-SRV-08",
    output: "double_fault_rate_pct",
    formula: "double_faults / service_points × 100",
    required: ["double_faults", "service_points"],
    minSample: { input: "service_points", min: 100 },
    compute: (v) => pct(v["double_faults"]!, v["service_points"]!),
    contextSensitive: true,
  },
  {
    id: "RS-SRV-09",
    output: "break_points_saved_pct",
    formula: "break_points_saved / break_points_faced × 100",
    required: ["break_points_saved", "break_points_faced"],
    minSample: { input: "break_points_faced", min: 20 },
    compute: (v) => pct(v["break_points_saved"]!, v["break_points_faced"]!),
    contextSensitive: true,
  },
  {
    id: "RS-SRV-10",
    output: "ace_to_df_ratio",
    formula: "aces / double_faults",
    required: ["aces", "double_faults"],
    compute: (v) => (v["double_faults"]! > 0 ? v["aces"]! / v["double_faults"]! : null),
    contextSensitive: true,
  },

  // ---------------------------- return ------------------------------------
  {
    id: "RS-RET-01",
    output: "return_points_won_pct",
    formula: "return_points_won / return_points × 100",
    required: ["return_points_won", "return_points"],
    minSample: { input: "return_points", min: 100 },
    compute: (v) => pct(v["return_points_won"]!, v["return_points"]!),
    contextSensitive: true,
  },
  {
    id: "RS-RET-02",
    output: "break_pct",
    formula: "return_games_won / return_games × 100",
    required: ["return_games_won", "return_games"],
    minSample: { input: "return_games", min: 30 },
    compute: (v) => pct(v["return_games_won"]!, v["return_games"]!),
    contextSensitive: true,
  },
  {
    id: "RS-RET-03",
    output: "break_point_conversion_pct",
    formula: "break_points_converted / break_points_opportunities × 100",
    required: ["break_points_converted", "break_points_opportunities"],
    minSample: { input: "break_points_opportunities", min: 20 },
    compute: (v) => pct(v["break_points_converted"]!, v["break_points_opportunities"]!),
    prohibited: ["estimating opportunities from break %"],
    contextSensitive: true,
  },
  {
    id: "RS-RET-04",
    output: "break_points_created_per_return_game",
    formula: "break_points_opportunities / return_games",
    required: ["break_points_opportunities", "return_games"],
    minSample: { input: "return_games", min: 30 },
    compute: (v) => (v["return_games"]! > 0 ? v["break_points_opportunities"]! / v["return_games"]! : null),
    contextSensitive: true,
  },

  // ---------------------------- combined ----------------------------------
  {
    id: "RS-CMB-01",
    output: "total_points_won_pct",
    formula: "(service_points_won + return_points_won) / (service_points + return_points) × 100",
    required: ["first_serve_points_won", "second_serve_points_won", "service_points", "return_points_won", "return_points"],
    compute: (v) =>
      pct(
        v["first_serve_points_won"]! + v["second_serve_points_won"]! + v["return_points_won"]!,
        v["service_points"]! + v["return_points"]!,
      ),
    contextSensitive: true,
  },
  // Dominance Ratio is intentionally NOT reconstructed here. The master metric
  // is opponent-aware (player RPW% / opponent RPW%), so it is calculated only
  // in matchup-efficiency.server.ts where both players are present.
  {
    id: "RS-CMB-03",
    output: "serve_return_spread",
    formula: "service_points_won_pct − return_points_won_pct",
    required: ["service_points_won_pct", "return_points_won_pct"],
    compute: (v) => v["service_points_won_pct"]! - v["return_points_won_pct"]!,
    contextSensitive: true,
  },

  // ---------------------------- records -----------------------------------
  {
    id: "RS-REC-01",
    output: "win_pct",
    formula: "wins / (wins + losses) × 100",
    required: ["wins", "losses"],
    minSample: { input: "matches_played", min: 0 },
    compute: (v) => pct(v["wins"]!, v["wins"]! + v["losses"]!),
    contextSensitive: true,
  },
  {
    id: "RS-REC-02",
    output: "matches_played",
    formula: "wins + losses",
    required: ["wins", "losses"],
    compute: (v) => v["wins"]! + v["losses"]!,
    contextSensitive: true,
  },
  {
    id: "RS-REC-03",
    output: "surface_win_pct",
    formula: "surface_wins / (surface_wins + surface_losses) × 100",
    required: ["surface_wins", "surface_losses"],
    compute: (v) => pct(v["surface_wins"]!, v["surface_wins"]! + v["surface_losses"]!),
    prohibited: ["career all-surface record used for a surface-specific request"],
    contextSensitive: true,
  },
  {
    id: "RS-REC-04",
    output: "surface_matches",
    formula: "surface_wins + surface_losses",
    required: ["surface_wins", "surface_losses"],
    compute: (v) => v["surface_wins"]! + v["surface_losses"]!,
    contextSensitive: true,
  },
  {
    id: "RS-REC-05",
    output: "tiebreak_win_pct",
    formula: "tiebreaks_won / tiebreaks_played × 100",
    required: ["tiebreaks_won", "tiebreaks_played"],
    minSample: { input: "tiebreaks_played", min: 8 },
    compute: (v) => pct(v["tiebreaks_won"]!, v["tiebreaks_played"]!),
    contextSensitive: true,
  },
  {
    id: "RS-REC-06",
    output: "deciding_set_win_pct",
    formula: "deciding_sets_won / deciding_sets_played × 100",
    required: ["deciding_sets_won", "deciding_sets_played"],
    minSample: { input: "deciding_sets_played", min: 6 },
    compute: (v) => pct(v["deciding_sets_won"]!, v["deciding_sets_played"]!),
    contextSensitive: true,
  },
  {
    id: "RS-REC-07",
    output: "set_win_pct",
    formula: "sets_won / sets_played × 100",
    required: ["sets_won", "sets_played"],
    minSample: { input: "sets_played", min: 20 },
    compute: (v) => pct(v["sets_won"]!, v["sets_played"]!),
    contextSensitive: true,
  },
  {
    id: "RS-REC-08",
    output: "straight_set_win_pct",
    formula: "straight_set_wins / matches_won × 100",
    required: ["straight_set_wins", "matches_won"],
    minSample: { input: "matches_won", min: 10 },
    compute: (v) => pct(v["straight_set_wins"]!, v["matches_won"]!),
    contextSensitive: true,
  },
  {
    id: "RS-REC-09",
    output: "common_opponent_win_pct",
    formula: "common_opponent_wins / (common_opponent_wins + common_opponent_losses) × 100",
    required: ["common_opponent_wins", "common_opponent_losses"],
    compute: (v) => pct(v["common_opponent_wins"]!, v["common_opponent_wins"]! + v["common_opponent_losses"]!),
    contextSensitive: true,
  },

  // ---------------------------- elo / context ------------------------------
  {
    id: "RS-ELO-01",
    output: "elo_win_probability",
    formula: "1 / (1 + 10^((opponent_surface_elo − surface_elo) / 400)) × 100",
    required: ["surface_elo", "opponent_surface_elo"],
    compute: (v) => (1 / (1 + Math.pow(10, (v["opponent_surface_elo"]! - v["surface_elo"]!) / 400))) * 100,
    prohibited: ["Matrix Elo", "Matrix win probability", "any Matrix model output"],
    contextSensitive: true,
  },
  {
    id: "RS-ELO-02",
    output: "peak_vs_current_elo_gap",
    formula: "peak_surface_elo − surface_elo",
    required: ["peak_surface_elo", "surface_elo"],
    compute: (v) => v["peak_surface_elo"]! - v["surface_elo"]!,
    contextSensitive: true,
  },
  {
    id: "RS-CTX-01",
    output: "ranking_gap_to_peak",
    formula: "ranking − peak_ranking",
    required: ["ranking", "peak_ranking"],
    compute: (v) => v["ranking"]! - v["peak_ranking"]!,
    contextSensitive: false,
  },
  {
    id: "RS-CTX-02",
    output: "avg_match_minutes",
    formula: "minutes_last_28_days / matches_last_28_days",
    required: ["minutes_last_28_days", "matches_last_28_days"],
    compute: (v) => (v["matches_last_28_days"]! > 0 ? v["minutes_last_28_days"]! / v["matches_last_28_days"]! : null),
    contextSensitive: false,
  },
];

// Fail fast in development if a spec references an unknown statistic.
for (const spec of RECONSTRUCTION_SPECS) {
  for (const key of [spec.output, ...spec.required, ...(spec.optional ?? [])]) {
    if (!STAT_BY_KEY.has(key)) throw new Error(`Reconstruction spec ${spec.id} references unknown stat "${key}"`);
  }
}

export const SPECS_BY_OUTPUT = RECONSTRUCTION_SPECS.reduce<Record<string, ReconstructionSpec[]>>((acc, s) => {
  (acc[s.output] ??= []).push(s);
  return acc;
}, {});

/** Every metric family that has at least one approved reconstruction route. */
export const RECONSTRUCTION_ELIGIBLE_FAMILIES = new Set(
  RECONSTRUCTION_SPECS.map((s) => STAT_BY_KEY.get(s.output)!.family),
);
