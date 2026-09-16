import { logger } from "../../../lib/logger";
import type { TournamentLevel } from "../../tennisData/types";

/**
 * Task #77: auditable record of every time #76's last-resort, opponent-unresolved Elo fallback
 * (`levelBaselineElo`) is actually applied -- player, opponent, tournament, level, date, and
 * reason -- so a reviewer can answer "which matches actually needed the fallback, and why" after
 * the fact instead of just seeing an aggregate rate.
 */
export interface EloFallbackEvent {
  /** Canonical id of the player whose Elo replay hit the fallback (i.e. whose OPPONENT couldn't be resolved). */
  player: string;
  /** Canonical id of the unresolved opponent. */
  opponent: string;
  opponentName: string | null;
  tournament: string | null;
  level: TournamentLevel | null;
  date: string;
  reason: string;
}

export interface EloFallbackStats {
  totalAttempts: number;
  fallbackCount: number;
  /** 0-1; 0 when `totalAttempts` is 0 (nothing to divide by, never reported as "0% fallback"). */
  fallbackRate: number;
  events: EloFallbackEvent[];
}

/**
 * Run-scoped tracker -- `reset()` at the start of any run that replays Elo across many matches
 * (a walk-forward evaluation, a full-corpus rebuild) so its rate reflects THAT run, not a mix of
 * runs. Not meant to accumulate indefinitely across unrelated runs.
 */
/**
 * Hard cap on retained per-event detail so this tracker can never grow unbounded even if a caller
 * forgets to `reset()` between runs -- `totalAttempts`/`fallbackCount`/`fallbackRate` stay exact
 * regardless (they're plain counters), only the detailed `events` list for spot-checking specific
 * matches is capped. A single walk-forward/rebuild run's fallback count is normally in the
 * thousands at most, well under this cap.
 */
const MAX_RETAINED_EVENTS = 5000;

class EloFallbackTracker {
  private totalAttempts = 0;
  private fallbackCount = 0;
  private events: EloFallbackEvent[] = [];

  /**
   * Records one opponent-resolution attempt. Pass `event` only when `usedFallback` is true -- this
   * both counts the fallback and writes the structured log entry describing it.
   */
  record(usedFallback: boolean, event?: EloFallbackEvent): void {
    this.totalAttempts += 1;
    if (!usedFallback) return;
    this.fallbackCount += 1;
    if (event) {
      if (this.events.length < MAX_RETAINED_EVENTS) this.events.push(event);
      logger.info({ ...event }, "Elo opponent-strength fallback baseline applied (opponent genuinely unresolved)");
    }
  }

  reset(): void {
    this.totalAttempts = 0;
    this.fallbackCount = 0;
    this.events = [];
  }

  getStats(): EloFallbackStats {
    return {
      totalAttempts: this.totalAttempts,
      fallbackCount: this.fallbackCount,
      fallbackRate: this.totalAttempts > 0 ? this.fallbackCount / this.totalAttempts : 0,
      events: [...this.events],
    };
  }
}

/** Shared instance -- `replayElo` (surfaceElo.ts) and the full-corpus rebuild script both record into this one tracker. */
export const eloFallbackTracker = new EloFallbackTracker();

/** Matches the task spec's "more than 1% of matches in a run" threshold. */
export const FALLBACK_RATE_WARNING_THRESHOLD = 0.01;

/**
 * Builds the data-quality warning string for a run's fallback stats, or `null` when the rate is
 * at/below threshold (or there was nothing to score). Callers append this to their own existing
 * warnings/disclosures output -- this function never surfaces anything itself.
 */
export function fallbackRateWarning(stats: EloFallbackStats): string | null {
  if (stats.totalAttempts === 0 || stats.fallbackRate <= FALLBACK_RATE_WARNING_THRESHOLD) return null;
  const pct = (stats.fallbackRate * 100).toFixed(1);
  return (
    `${pct}% of opponent Elo lookups in this run (${stats.fallbackCount}/${stats.totalAttempts}) required the last-resort, ` +
    `level-aware baseline fallback because the opponent was genuinely unresolvable -- above the 1% expected threshold. ` +
    `Run completed; investigate opponent-identity coverage for the affected matches.`
  );
}
