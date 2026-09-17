import type { HistoricalMatchRow, SpecialistModelRow } from "@workspace/db";
import { runPredictionEngine } from "../predictionEngine";
import { resolveOpponentStrengthFromIndex, type EloHistoryIndex } from "../predictionEngine/opponentStrength";
import { reconstructHeadToHead, reconstructPlayerMatchHistory, type MatchHistoryIndex } from "../historicalData/matchRecordReconstruction";
import { resolveSegmentSpecialistInputSync } from "./specialistWeights";
import { LIVE_MODEL_VERSION, type LiveFeatureSnapshot, type CalibrationKnot } from "./types";
import type { MatchFormat, PlayerProfile, Surface } from "../tennisData/types";
import type { PlayerIdentityIndex } from "../tennisData/playerIdentity";
import { extractFallbackInstrumentation, type FallbackSource } from "./fallbackInstrumentation";

/**
 * Everything `scoreHistoricalMatch` needs that's shared across every match in a walk-forward
 * run, preloaded ONCE by the caller (see `walkForward.ts`) instead of re-queried per match --
 * the corpus is small enough (tens of thousands of rows) to hold entirely in memory, and a full
 * run scores thousands of matches, so a per-match DB round-trip for match history/H2H/opponent
 * Elo would turn a run that should take seconds into one that takes hours.
 */
export interface HistoricalScoringContext {
  matchHistory: MatchHistoryIndex;
  eloHistory: EloHistoryIndex;
  /**
   * Task #77: whole-corpus canonical player-identity index, built ONCE per run (see
   * `walkForward.ts`) and passed through here so opponent resolution can canonicalize aliased
   * ids/name variants -- must be the SAME index used to build `eloHistory` (via
   * `buildEloHistoryIndex(identityIndex)`), or a fragmented opponent's history would be
   * canonicalized here but never actually merged in the index itself.
   */
  identityIndex: PlayerIdentityIndex;
  /**
   * Task #65: the tour/surface specialist state as it stood BEFORE this walk-forward run's own
   * fold scoring -- i.e. whatever the PREVIOUS run's `computeAndStoreSpecialistSegments` last
   * persisted (see `walkForward.ts`, which loads this once, before its own end-of-run refit
   * overwrites the table). Applying that prior fit here lets `specialistApplied` genuinely be
   * true for historical_test rows without circularity: a cycle's specialists are fit FROM this
   * cycle's own validation output, so they must never be applied back to this SAME cycle's rows.
   */
  specialistRowsBySegmentKey: ReadonlyMap<string, SpecialistModelRow>;
  /**
   * Set to `true` by shadow replay (`shadowReplay.ts`) to signal that this scoring call is a
   * point-in-time historical evaluation.  When true, the segment specialist is suppressed:
   * specialist calibration mappings in `specialistRowsBySegmentKey` are always from TODAY's DB
   * state (the previous run's persisted fit), never from the mapping that was in force as of the
   * match's own `cutoffAt`, so applying them alongside a historical general-calibration override
   * mixes two incompatible time-points and partially defeats the override.
   *
   * Walk-forward leaves this undefined/false: it legitimately uses the previous cycle's specialist
   * fit (pre-circular by design), so suppression is wrong there.
   *
   * Do NOT gate this on whether `activeCalibrationOverride` was supplied by the caller — that
   * would be a "caller-supplied-or-not" signal the calibration-architecture doc explicitly forbids,
   * because the override can be null even in a shadow replay run (no calibration history before
   * that match's date) while still needing consistent specialist treatment throughout the replay.
   */
  isPointInTimeReplay?: boolean;
}

/**
 * Winner-first slot assignment fix (2026-09-17): every row sourced from Sackmann's CSVs maps
 * winner_id -> historical_matches.player1_id and loser_id -> player2_id at ingestion time (see
 * `sackmannBackfill.ts`'s `rowToFixture` -- "In Sackmann: winner is always player1"). That
 * assignment is made AFTER the match outcome is known, so 179,986+ historical_test rows carry an
 * outcome-oriented player1/player2 slot rather than a neutral one. Any asymmetry in how the
 * ensemble breaks a near-50/50 tie (or any other slot-position-dependent effect) would then
 * systematically favor the eventual winner through slot position alone, independent of whether
 * the model actually distinguished the two players.
 *
 * Fix location (deliberately NOT ingestion): re-deriving 179,986 rows' stored player1Id/player2Id
 * would require a full historical-corpus rewrite, which the fix is explicitly scoped to avoid,
 * and would still leave every currently-running evaluation caller unaffected until that rewrite
 * completed. Every evaluation path (walk-forward, backtest, shadow replay, bridge rescore, the
 * frozen-vs-dynamic-weights script) already funnels through this single function
 * (`scoreHistoricalMatch`), so applying a deterministic, outcome-independent re-ordering HERE --
 * at evaluation-reconstruction time, never touching the stored row -- guarantees no outcome-
 * derived ordering reaches the Prediction Engine, for every caller, without rewriting anything.
 *
 * The rule: whichever of the two player ids sorts first lexicographically occupies the engine's
 * own "player1" slot for this scoring call. String comparison depends only on the two ids
 * themselves, never on which one is `historical_matches.winner_id` -- the same two players get
 * the same slot assignment for every match they ever play against each other, regardless of who
 * won any particular meeting. This function is called BEFORE the match's own outcome is read for
 * any purpose other than post-prediction grading (see `scoreHistoricalMatch` below), so it cannot
 * see or depend on this match's own winner.
 */
export function determineNeutralSlotOrder(
  storedPlayer1Id: string,
  storedPlayer2Id: string,
): { firstId: string; secondId: string; swapped: boolean } {
  if (storedPlayer2Id < storedPlayer1Id) {
    return { firstId: storedPlayer2Id, secondId: storedPlayer1Id, swapped: true };
  }
  return { firstId: storedPlayer1Id, secondId: storedPlayer2Id, swapped: false };
}

function minimalProfile(id: string, name: string): PlayerProfile {
  // A historical match row carries only the two player ids/names it was imported with -- rank,
  // country, age, and playing hand are live-standings concepts this row never captured. Every
  // engine module that would use them (e.g. buildPlayerProfileWarnings) already treats an
  // absent field as "unknown", never a fabricated default.
  return { id, name, countryCode: null, currentRank: null, tour: null, age: null, plays: null, fullName: null };
}

/**
 * Scores a historical match by running the exact same live ensemble (`runPredictionEngine`)
 * real paper-trading/live predictions use, fed with real match history reconstructed from
 * Phase 3's leak-proof historical store -- strictly bounded to this match's own frozen
 * `cutoffAt`, so nothing timestamped at or after that instant can leak in.
 *
 * The engine's own player1/player2 slots are assigned by `determineNeutralSlotOrder`, a
 * deterministic ordering of the two player ids that does NOT depend on `match.winnerId` or which
 * one is `historical_matches.player1_id` (see that function's doc comment) -- see the winner-first
 * slot fix immediately below. `match.winnerId` itself is never read anywhere in this function;
 * only the caller, after this function returns, compares its own predicted winner against it for
 * grading.
 *
 * This replaces the earlier, deliberately reduced Elo/form/game-share reconstruction (see the
 * legacy `HistoricalFeatureSnapshot` type in `./types.ts`): walk-forward accuracy now describes
 * the actual model users see when they run a live prediction, not a simplified stand-in for it.
 *
 * The Phase 7 simulator's adoption vote, live calibration, and weather are always omitted
 * (null/undefined) here -- they are either themselves *outputs* of THIS SAME evaluation run
 * (simulator adoption/live calibration are fit FROM this run's walk-forward results, so feeding
 * them back in would be circular) or have no honest historical reconstruction (no archived
 * weather data). This mirrors the engine's own "absent, not faked" contract.
 *
 * Segment specialists are the one exception (Task #65): `context.specialistRowsBySegmentKey` is
 * the PREVIOUS run's persisted fit, not this run's own, so applying it here is not circular --
 * see the doc on `HistoricalScoringContext.specialistRowsBySegmentKey`.
 *
 * `activeCalibrationOverride` is a second, narrower exception, used ONLY by the shadow-mode
 * replay (`shadowReplay.ts`), never by walk-forward: unlike walk-forward's fold-fit mapping
 * (which IS an output of that same run, so applying it here would be circular), the shadow replay
 * reuses whichever calibration mapping was ALREADY genuinely active as of THIS match's own
 * `cutoffAt` (Task #160) -- a real, already-fitted prior artifact, not something this call is
 * fitting -- so passing it through is not circular. Callers resolve this per-match from their own
 * fitted-calibration history (see `shadowReplay.ts`'s `getCalibrationMappingAsOf`), not a single
 * value reused across every match in a run. Left undefined/null by every other caller, which
 * keeps their calibratedProbability equal to rawProbability, exactly as before.
 *
 * Returns null when either player has zero prior recorded matches, or this match's own
 * surface/format weren't resolved at import time -- there is no honest probability to produce in
 * either case, so the caller must treat it as "insufficient data" rather than a fabricated guess.
 */
export async function scoreHistoricalMatch(
  match: HistoricalMatchRow,
  context: HistoricalScoringContext,
  activeCalibrationOverride?: CalibrationKnot[] | null,
): Promise<{
  rawProbability: number;
  calibratedProbability: number;
  snapshot: LiveFeatureSnapshot;
  modelAgreement: string;
  upsetRiskTier: string;
  usedFallback: boolean | null;
  fallbackSources: FallbackSource[] | null;
} | null> {
  if (!match.surface || !match.matchFormat) return null;
  const surface = match.surface as Surface;
  const matchFormat = match.matchFormat as MatchFormat;

  // Winner-first slot fix: derive the engine's own player1/player2 from a deterministic,
  // outcome-independent ordering of the two ids, NOT from the stored (possibly winner-first)
  // historical_matches.player1_id/player2_id. See `determineNeutralSlotOrder`'s doc comment.
  // This line is the only place in the function that reads the stored slot columns for anything
  // other than post-prediction grading (the caller compares its predicted winner against
  // `match.winnerId`, never against these two ids directly) -- match.winnerId itself is never
  // read here at all, so this match's own outcome cannot reach the engine call below.
  const { firstId, secondId, swapped } = determineNeutralSlotOrder(match.player1Id, match.player2Id);
  const firstName = swapped ? match.player2Name : match.player1Name;
  const secondName = swapped ? match.player1Name : match.player2Name;

  const engineP1Matches = reconstructPlayerMatchHistory(context.matchHistory, firstId, match.cutoffAt);
  const engineP2Matches = reconstructPlayerMatchHistory(context.matchHistory, secondId, match.cutoffAt);
  if (engineP1Matches.length === 0 || engineP2Matches.length === 0) return null;

  const engineP1OpponentStrength = resolveOpponentStrengthFromIndex(engineP1Matches, context.eloHistory, context.identityIndex);
  const engineP2OpponentStrength = resolveOpponentStrengthFromIndex(engineP2Matches, context.eloHistory, context.identityIndex);
  const headToHead = reconstructHeadToHead(context.matchHistory, firstId, secondId, match.cutoffAt);
  // Task #65: previous-cycle specialist fit, never this cycle's own -- see the doc on
  // `HistoricalScoringContext.specialistRowsBySegmentKey`.
  // Shadow replay sets `context.isPointInTimeReplay = true` to suppress the specialist:
  // specialist calibration is always today's DB state, never the mapping in force at the match's
  // own cutoffAt, so mixing it with a per-match historical general calibration produces
  // inconsistent results. Walk-forward leaves isPointInTimeReplay false/undefined and continues
  // to apply the previous cycle's specialist fit (non-circular by design).
  //
  // NOTE: this intentionally does NOT gate on whether `activeCalibrationOverride` was supplied.
  // The shadow replay always suppresses specialists regardless of whether a calibration override
  // was resolved for a given match (the override can be null when no prior calibration artifact
  // predates that match's cutoffAt). Gating on the override presence would let specialist
  // behaviour silently diverge within a single replay run -- the pattern the
  // predictionengine-calibration-architecture.md doc explicitly forbids.
  const segment = context.isPointInTimeReplay
    ? null
    : resolveSegmentSpecialistInputSync(match.tour, surface, context.specialistRowsBySegmentKey);

  const output = await runPredictionEngine({
    player1: minimalProfile(firstId, firstName),
    player2: minimalProfile(secondId, secondName),
    player1Matches: engineP1Matches,
    player2Matches: engineP2Matches,
    headToHead,
    surface,
    matchFormat,
    player1OpponentElo: engineP1OpponentStrength.lookup,
    player2OpponentElo: engineP2OpponentStrength.lookup,
    tournamentName: match.tournamentName,
    weather: null,
    segment,
    simulatorAdoption: null,
    activeCalibration: activeCalibrationOverride ?? null,
    // Task #77: this is the walk-forward evaluation's own run-scoped scoring path -- the caller
    // (`walkForward.ts`) resets the fallback tracker once at the start of each run, so it's safe
    // to attribute events here. Live/paper-trading/ablation callers must NOT set this (see
    // `PredictionEngineInput.trackEloFallback`'s doc).
    trackEloFallback: true,
    // 2026-07-14 Fatigue asOfDate fix: measure Fatigue's 3/7/14-day windows against this match's
    // own frozen cutoffAt, not today's wall-clock time -- see `PredictionEngineInput.asOfDate`.
    asOfDate: match.cutoffAt,
  });

  // Winner-first slot fix: output.rawEnsembleProbability/output.calibratedProbability are
  // P(firstId wins) -- the swap-invariant engine (see swapInvariance.test.ts) guarantees
  // P(A wins | A=player1) + P(A wins | A=player2) == 100, so when the engine's own player1
  // (firstId) is NOT this row's stored player1Id, the probability every existing caller reads as
  // "P(match.player1Id wins)" must be re-oriented back by subtracting from 100 -- otherwise every
  // caller's `probability >= 0.5 ? match.player1Id : match.player2Id` grading logic (unchanged by
  // this fix) would silently read the wrong player's probability on every swapped row.
  const rawForStoredPlayer1 = swapped ? 100 - output.rawEnsembleProbability : output.rawEnsembleProbability;
  const calibratedForStoredPlayer1 = swapped ? 100 - output.calibratedProbability : output.calibratedProbability;

  const snapshot: LiveFeatureSnapshot = {
    modelVersion: LIVE_MODEL_VERSION,
    engine: output.engine,
    // Re-oriented to match.player1Id, consistent with the top-level rawProbability below -- see
    // engineSlotAssignment for how to interpret the still-engine-relative nested engine.* fields.
    preCalibrationProbability: rawForStoredPlayer1,
    dataQuality: output.dataQuality,
    isEliteTier: output.engine.isEliteTier,
    // Per-module weight trace: written forward-only; absent on rows scored before this field.
    moduleWeights: output.decisionTrace.modules,
    engineSlotAssignment: { enginePlayer1Id: firstId, enginePlayer2Id: secondId, swapped },
  };
  const fallback = extractFallbackInstrumentation({
    engine: output.engine,
    decisionTrace: output.decisionTrace,
  });

  return {
    // Both re-oriented to be "P(match.player1Id wins)", exactly as every existing caller already
    // assumes -- see the comment above. The engine itself was called with a deterministic,
    // outcome-independent slot assignment (determineNeutralSlotOrder), not match.player1Id/
    // player2Id directly.
    rawProbability: rawForStoredPlayer1 / 100,
    // Equal to rawProbability for every existing caller (no override passed): unchanged
    // behavior. Only differs when `activeCalibrationOverride` is supplied (shadow replay).
    calibratedProbability: calibratedForStoredPlayer1 / 100,
    snapshot,
    modelAgreement: output.engine.modelAgreement,
    upsetRiskTier: output.upsetRisk,
    usedFallback: fallback.usedFallback,
    fallbackSources: fallback.fallbackSources,
  };
}
