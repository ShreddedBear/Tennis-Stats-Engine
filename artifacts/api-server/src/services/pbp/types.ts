export type PbpTour = "ATP" | "WTA" | "Challenger" | "ITF" | "Futures" | "Other";

export type PbpValidationStatus =
  | "VERIFIED"
  | "CORROBORATED"
  | "CANDIDATE"
  | "CONFLICT"
  | "REVIEW_REQUIRED";

export interface PointByPointRecord {
  source: string;
  sourceRecordId: string;
  date: string;
  tournamentName: string | null;
  tour: PbpTour;
  draw: "Main" | "Qualifying" | null;
  server1: string;
  server2: string;
  winner: 1 | 2;
  pbp: string;
  score: string | null;
  adfFlag: 0 | 1 | null;
  validationStatus: PbpValidationStatus;
  provenanceNote: string | null;
}

export interface PbpLookup {
  player1Name: string;
  player2Name: string;
  date?: string | null;
  tournamentName?: string | null;
  tour?: PbpTour | null;
}

export interface PbpDerivedStats {
  pointsPlayed: number;
  serverPointsWon: Record<"player1" | "player2", number>;
  serverPointsPlayed: Record<"player1" | "player2", number>;
  servicePointsWonPct: Record<"player1" | "player2", number | null>;
  returnPointsWonPct: Record<"player1" | "player2", number | null>;
  aces: Record<"player1" | "player2", number | null>;
  doubleFaults: Record<"player1" | "player2", number | null>;
  gamesPlayed: number;
  sourceRecordId: string;
}

export interface PbpMatchResult {
  record: PointByPointRecord;
  derived: PbpDerivedStats;
}

export interface PbpSource {
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly validationStatus: PbpValidationStatus;
  lookup(match: PbpLookup): Promise<PointByPointRecord | null>;
}

export interface PbpResolution {
  result: PbpMatchResult | null;
  attemptedSources: string[];
  rejectedSources: Array<{ source: string; reason: string }>;
}
