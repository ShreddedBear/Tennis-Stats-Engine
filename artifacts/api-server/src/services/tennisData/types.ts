// Provider-agnostic tennis data types. Any real data source (API-Tennis, Sportradar, ...)
// implements TennisDataProvider and returns these shapes. Nothing here is mock/sample data --
// every field is either present from the upstream API or explicitly null.

export type Surface = "Hard" | "Clay" | "Grass" | "IndoorHard";
export type MatchFormat = "BestOf3" | "BestOf5";
export type TournamentLevel =
  | "GrandSlam"
  | "Masters1000"
  | "ATP500"
  | "ATP250"
  | "WTA1000"
  | "WTA500"
  | "WTA250"
  | "Challenger"
  | "ITF"
  | "Other";

/**
 * How a player's tour/rank were resolved. "live-standings" means the current ATP/WTA standings
 * feed had them (rank/tour are live). "historical-match" means the standings feed didn't have
 * them (e.g. a Challenger/ITF-only player, or a recently-retired/returning player outside the
 * current top rankings), but a real, previously-fetched match record did -- still real data, just
 * reflecting their last known match rather than a live ranking. Omitted (undefined) when neither
 * source could resolve anything -- a genuinely unresolvable player, never silently defaulted.
 */
export type PlayerProfileSource = "live-standings" | "historical-match";

export interface PlayerSummary {
  id: string;
  name: string;
  countryCode: string | null;
  currentRank: number | null;
  tour: string | null;
  source?: PlayerProfileSource;
}

export interface PlayerProfile extends PlayerSummary {
  age: number | null;
  plays: string | null;
  /** Provider's full given+family name, when it differs from the display name. */
  fullName: string | null;
}

export interface MatchStatLine {
  firstServePct: number | null;
  firstServeWon: number | null;
  secondServeWon: number | null;
  aces: number | null;
  doubleFaults: number | null;
  breakPointsSaved: number | null;
  breakPointsFaced: number | null;
  returnPointsWon: number | null;
  /**
   * Overall percentage of total service points won in the match (0-100), when the provider
   * reports match-level point totals directly. Distinct from `firstServeWon`/`secondServeWon`,
   * which only cover points won on first/second serve individually.
   */
  servicePointsWonPct: number | null;
}

export interface MatchRecord {
  id: string;
  date: string;
  tournamentName: string | null;
  tournamentLevel: TournamentLevel | null;
  round: string | null;
  matchFormat: MatchFormat | null;
  surface: Surface | null;
  indoor: boolean | null;
  opponentId: string;
  opponentName: string;
  opponentRank: number | null;
  result: "W" | "L";
  score: string | null;
  retired: boolean;
  walkover: boolean;
  stats: MatchStatLine | null;
  opponentStats: MatchStatLine | null;
  /** Games won/lost per set, when the provider reports it. Used for serve/return proxies. */
  setGameMargins: Array<{ playerGames: number; opponentGames: number }>;
}

export interface Fixture {
  id: string;
  /** Calendar date the match is scheduled for (YYYY-MM-DD), always present. */
  date: string;
  /**
   * Full ISO-8601 instant (UTC) combining the provider's real event_date + event_time for this
   * specific fixture. Null when the provider did not supply a verified start time for this match
   * -- never fabricated or copied from another fixture/tournament. When null, `timeConfirmed` is
   * false and callers must display "Time TBD" rather than inventing a time.
   */
  scheduledStart: string | null;
  /** True only when `scheduledStart` reflects a real provider-supplied time for this exact fixture. */
  timeConfirmed: boolean;
  /**
   * True when `scheduledStart` is confirmed and already in the past but the provider has not yet
   * reported a winner for this fixture -- i.e. it's currently in progress. False for a genuinely
   * upcoming (not yet started) fixture, and also false when `scheduledStart` is null ("Time TBD")
   * since there's no real evidence the match has started.
   */
  isLive: boolean;
  tournamentName: string | null;
  tournamentLevel: TournamentLevel | null;
  round: string | null;
  surface: Surface | null;
  indoor: boolean | null;
  matchFormat: MatchFormat | null;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
}

export interface LiveScoreSet {
  player1Games: number;
  player2Games: number;
}

/**
 * Real-time set/game score for a currently-live fixture. `sets` is always aligned to the same
 * player1/player2 identity as the `Fixture` it belongs to -- never a generic "home/away" pairing
 * that could be flipped relative to `Fixture.player1Id`/`player2Id`.
 */
export interface LiveScore {
  sets: LiveScoreSet[];
  statusText: string | null;
}

export interface HeadToHeadMeeting {
  date: string;
  tournamentName: string | null;
  surface: Surface | null;
  score: string | null;
  winnerId: string;
}

export interface HeadToHeadRecord {
  player1Id: string;
  player2Id: string;
  meetings: HeadToHeadMeeting[];
}

/**
 * A single completed (or definitively-terminated: retired/walkover/cancelled) historical match,
 * as reported directly by a provider's bulk date-range endpoint. This is intentionally a richer,
 * lower-level shape than `MatchRecord` (which is player-perspective) -- the historical backfill
 * pipeline needs the neutral, tour-wide view so it can process matches in true chronological
 * order across every player at once.
 */
export interface HistoricalFixture {
  id: string;
  provider: string;
  date: string; // YYYY-MM-DD, as reported by the provider
  time: string | null; // HH:MM local-to-provider, when known
  tour: string | null;
  tournamentName: string | null;
  tournamentLevel: TournamentLevel | null;
  round: string | null;
  surface: Surface | null;
  matchFormat: MatchFormat | null;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  winnerId: string | null; // null only when cancelled
  score: string | null;
  retired: boolean;
  walkover: boolean;
  cancelled: boolean;
  /** Games won/lost per set, from player1's perspective, when the provider reports it. */
  setGameMargins: Array<{ player1Games: number; player2Games: number }>;
  /**
   * Whether the match was played indoors, taken directly from the provider's `indoor` flag when
   * available. Null when the provider doesn't supply it -- callers can still infer a best-guess
   * from surface ("IndoorHard" → indoor) but should treat that as a fallback, not this field.
   */
  indoor: boolean | null;
  /**
   * ATP/WTA ranking of player1 and player2 at time of the match, taken directly from the
   * provider's fixture payload when available. Null when the provider doesn't supply it for this
   * match -- never fabricated as zero or a placeholder.
   */
  player1Rank: number | null;
  player2Rank: number | null;
  /** Raw provider payload, kept for audit trails in the historical store. */
  raw: unknown;
}

export interface ProviderStatusInfo {
  provider: string;
  connected: boolean;
  lastSuccessfulCallAt: string | null;
  lastError: string | null;
}

/** Thrown when the upstream provider cannot serve a request (network error, missing key, non-2xx, etc). */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface TennisDataProvider {
  readonly name: string;
  searchPlayers(query: string): Promise<PlayerSummary[]>;
  getPlayer(playerId: string): Promise<PlayerProfile | null>;
  getPlayerMatches(playerId: string): Promise<MatchRecord[]>;
  getUpcomingFixtures(date: string): Promise<Fixture[]>;
  /**
   * Same data as `getUpcomingFixtures`, but for an entire calendar-day range in a single
   * provider round trip instead of one call per day. Used by the upcoming-matches window
   * (`collectUpcomingWindow`), which otherwise needs several sequential per-day calls to fill its
   * result cap during a sparse (e.g. off-season) stretch. `dateStart`/`dateStop` are inclusive,
   * `YYYY-MM-DD`.
   */
  getUpcomingFixturesRange(dateStart: string, dateStop: string, opts?: { bypassCache?: boolean }): Promise<Fixture[]>;
  getHeadToHead(player1Id: string, player2Id: string): Promise<HeadToHeadRecord>;
  /**
   * Bulk, player-agnostic pull of every definitively-terminated match in a date range (finished,
   * retired, walkover, or cancelled). Used only by the historical backfill pipeline -- never by
   * live prediction requests. `dateStart`/`dateStop` are inclusive, `YYYY-MM-DD`.
   */
  getCompletedMatchesByDateRange(dateStart: string, dateStop: string): Promise<HistoricalFixture[]>;
  /**
   * Real-time set/game scores for a specific set of already-live fixture ids, on a short (5-10s)
   * cache lane dedicated to live scores -- kept separate from the general fixtures cache so
   * frequent polling for scores never forces a full fixtures re-fetch, and vice versa. Fixture
   * ids the provider currently has no live score for (already finished, or unknown) are simply
   * omitted from the returned map, never fabricated.
   */
  getLiveScores(fixtureIds: string[]): Promise<Map<string, LiveScore>>;
  /**
   * Same data as `getLiveScores`, but for fixture ids that came from a DIFFERENT provider's id
   * namespace (e.g. MatchStat's `${tournamentId}:${player1Id}:${player2Id}` composite key passed
   * to API-Tennis, whose ids are its own `event_key`). Correlates by a stable, provider-agnostic
   * identity (calendar date + normalized player names, see `matchIdentity.ts`) instead of
   * assuming id equality across providers. The returned map is keyed by the caller-supplied `id`
   * (not this provider's own native id), so results can be merged straight into a `getLiveScores`
   * result. Optional -- only implemented by providers that can serve live scores at all
   * (`CompositeTennisProvider` calls this on its fallback as a second pass after native-id lookup
   * misses).
   */
  getLiveScoresByIdentity?(
    fixtures: Array<{ id: string; date: string; player1Name: string; player2Name: string }>,
  ): Promise<Map<string, LiveScore>>;
  getStatus(): ProviderStatusInfo;
  /**
   * Name-only fallback surface/level lookup for callers with no `tournament_key` (currently just
   * the screenshot-import flow, which only ever has OCR'd event text). Returns null when no
   * confident single-surface match exists -- never a guess. Optional so providers other than
   * API-Tennis aren't forced to implement a real name search they may not have.
   */
  findTournamentSurfaceByName?(name: string): Promise<{ surface: Surface | null; level: TournamentLevel | null } | null>;
  /**
   * Fetches current ATP + WTA standings from the provider and returns them in a flat,
   * provider-neutral shape. Used by the ranking-verification job to compare stored
   * `master_players.currentRank` values against live official standings. Optional so
   * providers that have no rankings feed aren't forced to implement it.
   */
  getCurrentStandings?(): Promise<Array<{ playerKey: string; rank: number; name: string; tour: "ATP" | "WTA" }>>;
}
