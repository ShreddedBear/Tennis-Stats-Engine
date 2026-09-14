export const CALIBRATION_BUCKETS = [
  { code: "ORANGE", label: "Orange · ≤55%", min: 0, max: 55, wins: 1, graded: 3 },
  { code: "TAN", label: "Tan · 56–64%", min: 56, max: 64, wins: 13, graded: 23 },
  { code: "PURPLE", label: "Purple · 65–69%", min: 65, max: 69, wins: 15, graded: 19 },
  { code: "BLUE", label: "Blue · 70–74%", min: 70, max: 74, wins: 20, graded: 27 },
  { code: "PINK", label: "Pink · 75–79%", min: 75, max: 79, wins: 19, graded: 26 },
  { code: "BROWN", label: "Brown · 80–84%", min: 80, max: 84, wins: 9, graded: 12 },
  { code: "INDIGO", label: "Indigo · 85–89%", min: 85, max: 89, wins: 6, graded: 8 },
  { code: "GOLD", label: "Gold · 90%+", min: 90, max: 100, wins: 2, graded: 2 },
] as const;

export const MASTER_RECORD_START = 183;
export const SMALL_SAMPLE_THRESHOLD = 10;

export const BUCKET_TOKEN: Record<string, string> = {
  ORANGE: "var(--cal-orange)",
  TAN: "var(--cal-tan)",
  PURPLE: "var(--cal-purple)",
  BLUE: "var(--cal-blue)",
  PINK: "var(--cal-pink)",
  BROWN: "var(--cal-brown)",
  INDIGO: "var(--cal-indigo)",
  GOLD: "var(--cal-gold)",
};

export const UNDERDOG_PATHWAYS = [
  ["SERVE_THROUGH", "Serve-through"],
  ["RETURN_PRESSURE", "Return pressure"],
  ["SECOND_SERVE", "Second-serve exploitation"],
  ["SHORT_RALLY", "Short-rally"],
  ["LONG_RALLY", "Long-rally"],
  ["MOVEMENT", "Movement / physical"],
  ["SLOW_START", "Slow start"],
  ["DECIDING_SET", "Deciding set"],
  ["TIEBREAK", "Tiebreak"],
  ["FATIGUE", "Fatigue"],
  ["STYLE_MISMATCH", "Style mismatch"],
  ["MARKET_INFO", "Market information"],
  ["FAV_COLLAPSE", "Favorite collapse"],
  ["SURFACE_TRANSITION", "Surface transition"],
  ["RANKING_LAG", "Recent improvement / ranking lag"],
] as const;

export const STRESS_TESTS = [
  ["ST01", "Remove Matrix headline"],
  ["ST02", "Remove all Matrix-derived outputs"],
  ["ST03", "Remove strongest independent favorite family"],
  ["ST04", "Remove market"],
  ["ST05", "Upweight recent form"],
  ["ST06", "Upweight same-surface evidence"],
  ["ST07", "Upweight opponent-specific evidence"],
  ["ST08", "Conservative probability floor"],
  ["ST09", "Dangerous-underdog ceiling"],
  ["ST10", "Physical / conditions shock"],
] as const;

// Every key here is prediction-engine output -- guidance/reference only, read exclusively
// through the same firewalled path matrix_wp already uses (gated behind
// independent_decision_committed_at / matrix_revealed_at in match.$matchId.tsx). None of
// these are ever passed into digestFrom()/deps.research.metrics() for the 81-metric
// research call -- see summary-parser.test.ts's firewall-isolation guardrail.
export const MATRIX_FIELDS = [
  "matrix_predicted_winner",
  "matrix_wp",
  "matrix_wp_range",
  "matrix_confidence_label",
  "matrix_agreement_label",
  "monte_carlo_winner",
  "monte_carlo_prob",
  "monte_carlo_range",
  "monte_carlo_expected_sets",
  "monte_carlo_simulations",
  "monte_carlo_set_score_distribution",
  "matrix_elo",
  "matrix_elo_detail",
  "matrix_serve_return",
  "matrix_serve_return_detail",
  "matrix_recent_form",
  "matrix_recent_form_detail",
  "matrix_head_to_head",
  "matrix_head_to_head_detail",
  "matrix_fatigue_index_detail",
  "matrix_rest_travel_injury_detail",
  "matrix_style_matchup_detail",
  "general_model",
  "specialist_model",
  "model_agreement",
  "upset_risk",
  "data_quality",
  "matchup_closeness",
  "matrix_market",
];

export const IDENTITY_FIELDS = [
  "player_1",
  "player_2",
  "tournament",
  "event_level",
  "round",
  "scheduled_date",
  "surface",
  "indoor_outdoor",
  "best_of",
  "match_status",
];

export const DEFAULT_SOURCES = [
  { source_name: "ATP Tour (official)", domain: "atptour.com", category: "TIER 1", priority: 10, reliability: 0.98 },
  { source_name: "WTA Tour (official)", domain: "wtatennis.com", category: "TIER 1", priority: 10, reliability: 0.98 },
  { source_name: "ITF", domain: "itftennis.com", category: "TIER 1", priority: 15, reliability: 0.95 },
  { source_name: "Tennis Abstract", domain: "tennisabstract.com", category: "TIER 2", priority: 20, reliability: 0.92 },
  { source_name: "Ultimate Tennis Statistics", domain: "ultimatetennisstatistics.com", category: "TIER 2", priority: 25, reliability: 0.9 },
  { source_name: "Tennis Explorer", domain: "tennisexplorer.com", category: "TIER 2", priority: 35, reliability: 0.82 },
  { source_name: "Oddsportal", domain: "oddsportal.com", category: "TIER 3", priority: 40, reliability: 0.85 },
  { source_name: "Pinnacle", domain: "pinnacle.com", category: "TIER 3", priority: 42, reliability: 0.9 },
  { source_name: "Reuters / AP tennis desk", domain: "reuters.com", category: "TIER 4", priority: 60, reliability: 0.85 },
];

export const LOCAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
