import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSurfaceEloModule } from "./surfaceElo";
import type { MatchRecord } from "../../tennisData/types";

function baseMatch(
  id: string,
  i: number,
  surface: MatchRecord["surface"],
  result: "W" | "L",
  overrides: Partial<Pick<MatchRecord, "date" | "tournamentLevel">> = {},
): MatchRecord {
  return {
    id,
    date: overrides.date ?? `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    tournamentName: null,
    tournamentLevel: overrides.tournamentLevel ?? null,
    round: null,
    matchFormat: null,
    surface,
    indoor: null,
    opponentId: `opp${i}`,
    opponentName: `Opponent ${i}`,
    opponentRank: null,
    result,
    score: null,
    retired: false,
    walkover: false,
    stats: null,
    opponentStats: null,
    setGameMargins: [],
  };
}

function wins(count: number, surface: MatchRecord["surface"] = "Hard", tournamentLevel: MatchRecord["tournamentLevel"] = null): MatchRecord[] {
  return Array.from({ length: count }, (_, i) => baseMatch(`w${i}`, i, surface, "W", { tournamentLevel }));
}

function losses(count: number, surface: MatchRecord["surface"] = "Hard", tournamentLevel: MatchRecord["tournamentLevel"] = null): MatchRecord[] {
  return Array.from({ length: count }, (_, i) => baseMatch(`l${i}`, i, surface, "L", { tournamentLevel }));
}

test("eloWinProbabilityPlayer1 stays within [0, 100] for a roughly even matchup", () => {
  const result = computeSurfaceEloModule(wins(10), wins(10), "Hard");
  assert.ok(result.eloWinProbabilityPlayer1 >= 0 && result.eloWinProbabilityPlayer1 <= 100);
  assert.ok(Math.abs(result.eloWinProbabilityPlayer1 - 50) < 5);
});

test("eloWinProbabilityPlayer1 never exceeds 100 or drops below 0, even for a very large rating gap", () => {
  // One player with a long, dominant win streak vs. one with a long losing streak produces the
  // largest realistic Elo gap this module can generate.
  const dominant = computeSurfaceEloModule(wins(200), losses(200), "Hard");
  assert.ok(dominant.eloWinProbabilityPlayer1 <= 100, `expected <= 100, got ${dominant.eloWinProbabilityPlayer1}`);
  assert.ok(dominant.eloWinProbabilityPlayer1 >= 0, `expected >= 0, got ${dominant.eloWinProbabilityPlayer1}`);
  assert.ok(dominant.eloWinProbabilityPlayer1 > 90, "expected the heavily favored player to show a very high, but still <= 100, probability");

  const underdog = computeSurfaceEloModule(losses(200), wins(200), "Hard");
  assert.ok(underdog.eloWinProbabilityPlayer1 <= 100, `expected <= 100, got ${underdog.eloWinProbabilityPlayer1}`);
  assert.ok(underdog.eloWinProbabilityPlayer1 >= 0, `expected >= 0, got ${underdog.eloWinProbabilityPlayer1}`);
  assert.ok(underdog.eloWinProbabilityPlayer1 < 10, "expected the heavily disfavored player to show a very low, but still >= 0, probability");
});

test("a player with a thin surface sample blends toward their overall (cross-surface) Elo instead of relying on the surface-only rating alone", () => {
  // Player 1 has a long, dominant record OVERALL, but only 2 matches on Clay specifically (one win, one loss --
  // roughly neutral on Clay alone). Player 2 has no data at all. The overall-Elo fallback should pull
  // player 1's effective Clay rating up well above a neutral/starting value, and the blend weight should be high.
  const thinClaySample: MatchRecord[] = [...wins(30, "Hard"), ...wins(1, "Clay"), ...losses(1, "Clay")];
  const result = computeSurfaceEloModule(thinClaySample, [], "Clay");

  assert.ok(result.player1BlendWeight > 0.3, `expected a high blend weight for a thin 2-match Clay sample, got ${result.player1BlendWeight}`);
  assert.ok(result.player1OverallElo > 1550, `expected a strong overall Elo from the 30-match Hard win streak, got ${result.player1OverallElo}`);
  assert.ok(
    result.player1SurfaceElo > result.player1SurfaceOnlyElo,
    `expected the blended rating (${result.player1SurfaceElo}) to sit above the thin surface-only rating (${result.player1SurfaceOnlyElo})`,
  );
  assert.ok(result.effectiveSampleSizePlayer1 < result.sampleSizePlayer1 + 1, "effective sample size should not exceed the raw match count");
});

test("the blend weight fades toward zero once a player has a deep surface-specific sample", () => {
  const deepClaySample = wins(40, "Clay");
  const result = computeSurfaceEloModule(deepClaySample, [], "Clay");
  assert.ok(result.player1BlendWeight < 0.1, `expected a near-zero blend weight for a 40-match Clay sample, got ${result.player1BlendWeight}`);
});

test("a recent high-level win moves the rating more than an old low-level win of the same shape", () => {
  const recentSlamWin: MatchRecord[] = [baseMatch("m1", 0, "Hard", "W", { date: "2026-07-01", tournamentLevel: "GrandSlam" })];
  const oldItfWin: MatchRecord[] = [baseMatch("m1", 0, "Hard", "W", { date: "2022-01-01", tournamentLevel: "ITF" })];

  const recentResult = computeSurfaceEloModule(recentSlamWin, [], "Hard");
  const oldResult = computeSurfaceEloModule(oldItfWin, [], "Hard");

  assert.ok(
    recentResult.player1SurfaceOnlyElo > oldResult.player1SurfaceOnlyElo,
    `expected a recent Grand Slam win (${recentResult.player1SurfaceOnlyElo}) to move the surface-only rating more than an old ITF win (${oldResult.player1SurfaceOnlyElo})`,
  );
});

test("swapping player1/player2 mirrors the win probability exactly (order symmetry)", () => {
  const p1 = [...wins(15, "Hard"), ...losses(5, "Hard")];
  const p2 = [...wins(6, "Hard"), ...losses(12, "Hard")];

  const forward = computeSurfaceEloModule(p1, p2, "Hard");
  const reversed = computeSurfaceEloModule(p2, p1, "Hard");

  assert.ok(
    Math.abs(forward.eloWinProbabilityPlayer1 - (100 - reversed.eloWinProbabilityPlayer1)) < 0.15,
    `expected forward (${forward.eloWinProbabilityPlayer1}) and reversed (${reversed.eloWinProbabilityPlayer1}) probabilities to mirror around 50`,
  );
  assert.ok(
    Math.abs(forward.rawEloWinProbabilityPlayer1 - (100 - reversed.rawEloWinProbabilityPlayer1)) < 0.15,
    "raw (un-shrunk) probability must mirror too",
  );
  assert.equal(forward.eloDifference, -reversed.eloDifference, "the rating gap must flip sign exactly when the players are swapped");
});

test("identical histories for both players land at exactly 50/50", () => {
  const identical = [...wins(10, "Hard", "ATP250"), ...losses(4, "Hard", "ATP250")];
  const result = computeSurfaceEloModule(identical, [...identical], "Hard");
  assert.equal(result.eloWinProbabilityPlayer1, 50, `expected exactly 50, got ${result.eloWinProbabilityPlayer1}`);
  assert.equal(result.eloDifference, 0);
});

test("a missing-opponent lower-level (ITF) win no longer inflates a player's rating as if they'd beaten a tour-average (1500) opponent", () => {
  // No opponentElo lookup is supplied (empty map -- every opponent is "unresolved"), so every
  // match falls back to the level-aware baseline. An ITF-level win streak should land BELOW what
  // the exact same win streak would score if it had (incorrectly) used the flat, level-blind
  // STARTING_ELO=1500 fallback, since the real ITF-level baseline (1522) is used for the *expected
  // score* calc -- but more importantly, the tour-level-credibility shrink should keep the whole
  // rating close to the corpus baseline rather than letting it run away upward.
  const itfWinStreak = wins(20, "Hard", "ITF");
  const result = computeSurfaceEloModule(itfWinStreak, [], "Hard");

  assert.ok(result.player1TourLevelShare === 0, "an all-ITF history has zero genuine tour-level share");
  // Even after 20 straight (unresolved-opponent) wins, the sub-tour shrink keeps the rating from
  // running far above the real corpus baseline the way an unshrunk flat-1500-fallback Elo would.
  assert.ok(
    result.player1SurfaceElo < 1620,
    `expected the sub-tour-shrunk rating (${result.player1SurfaceElo}) to stay well below what an unshrunk 20-match win streak would reach`,
  );
});

test("tour-level credibility shrinks a rating's deviation from baseline monotonically as tour-level share increases", () => {
  const baseline = 1520; // CORPUS_BASELINE_ELO
  const allItf = computeSurfaceEloModule(wins(20, "Hard", "ITF"), [], "Hard");
  const mixed = computeSurfaceEloModule([...wins(10, "Hard", "ITF"), ...wins(10, "Hard", "ATP250")], [], "Hard");
  const allTour = computeSurfaceEloModule(wins(20, "Hard", "ATP250"), [], "Hard");

  const devAllItf = Math.abs(allItf.player1SurfaceElo - baseline);
  const devMixed = Math.abs(mixed.player1SurfaceElo - baseline);
  const devAllTour = Math.abs(allTour.player1SurfaceElo - baseline);

  assert.ok(allItf.player1TourLevelShare < mixed.player1TourLevelShare, "mixed history must show a higher tour-level share than all-ITF");
  assert.ok(mixed.player1TourLevelShare < allTour.player1TourLevelShare, "all-tour-level history must show a higher tour-level share than mixed");
  assert.ok(
    devAllItf <= devMixed + 0.5 && devMixed <= devAllTour + 0.5,
    `expected monotonically increasing trust in the rating's deviation from baseline as tour-level share grows: allItf=${devAllItf}, mixed=${devMixed}, allTour=${devAllTour}`,
  );
});

test("reliability (confidence) grows with effective sample size and shrinks the win probability toward 50 when thin", () => {
  const thin = computeSurfaceEloModule(wins(2, "Clay"), losses(2, "Clay"), "Clay");
  const deep = computeSurfaceEloModule(wins(30, "Clay"), losses(30, "Clay"), "Clay");

  assert.ok(thin.reliability < deep.reliability, `expected thin-sample reliability (${thin.reliability}) < deep-sample reliability (${deep.reliability})`);

  // Same-shaped, more decisive matchup with a genuinely thin sample should stay closer to 50 than the
  // deep-sample equivalent, and never exceed its own raw (un-shrunk) probability's distance from 50.
  const lopsidedThin = computeSurfaceEloModule(wins(2, "Clay"), losses(2, "Clay"), "Clay");
  assert.ok(
    Math.abs(lopsidedThin.eloWinProbabilityPlayer1 - 50) <= Math.abs(lopsidedThin.rawEloWinProbabilityPlayer1 - 50) + 0.1,
    "the confidence-shrunk probability should never be pulled further from 50 than the raw probability",
  );
});

test("eloDifference's sign always agrees with which of the two DISPLAYED (rounded) Elo numbers is higher, even for a razor-thin raw gap", () => {
  // Regression test for the "favors the wrong player" bug: eloDifference used to be rounded
  // independently from player1SurfaceElo/player2SurfaceElo (each rounded from the raw, unrounded
  // blendedElo). When the true gap was small enough to straddle a rounding boundary on one or
  // both sides (e.g. a raw gap of ~0.2-0.9), the *sign* of the rounded difference could disagree
  // with which rounded display number was actually higher -- e.g. displayed 1500 vs 1500 (tied)
  // while eloDifference still read +1 or -1, or player1's rounded number reading higher while
  // eloDifference's sign said player2 was favored. Sweep a range of near-tie matchups (varying
  // small win/loss imbalances) to hit that boundary and assert the invariant holds every time.
  for (let extraWins = 0; extraWins <= 6; extraWins++) {
    const p1 = [...wins(10, "Hard"), ...wins(extraWins, "Hard")];
    const p2 = wins(10, "Hard");
    const result = computeSurfaceEloModule(p1, p2, "Hard");

    const displayedDiff = result.player1SurfaceElo - result.player2SurfaceElo;
    assert.equal(
      result.eloDifference,
      displayedDiff,
      `eloDifference (${result.eloDifference}) must exactly equal the difference of the two displayed Elo numbers ` +
        `(${result.player1SurfaceElo} - ${result.player2SurfaceElo} = ${displayedDiff}) for extraWins=${extraWins}`,
    );

    // The "favors X" sign (eloDifference >= 0 means player1) must never contradict which
    // displayed number is actually higher.
    if (result.player1SurfaceElo > result.player2SurfaceElo) {
      assert.ok(result.eloDifference > 0, `player1's displayed Elo is higher but eloDifference (${result.eloDifference}) doesn't favor player1`);
    } else if (result.player1SurfaceElo < result.player2SurfaceElo) {
      assert.ok(result.eloDifference < 0, `player2's displayed Elo is higher but eloDifference (${result.eloDifference}) doesn't favor player2`);
    } else {
      assert.equal(result.eloDifference, 0, `displayed Elo numbers are tied (${result.player1SurfaceElo}) but eloDifference (${result.eloDifference}) is nonzero`);
    }
  }
});
