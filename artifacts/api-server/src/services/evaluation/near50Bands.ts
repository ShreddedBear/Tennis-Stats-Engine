// Evaluation-only helper (P1 Package 4 follow-on: "50% analysis"). Pure, DB-free classification
// of a stored probability into the near-50% bands the live-ablation plan's 50% investigation asks
// for. Bands are nested (each wider band's membership implies every narrower band it contains),
// so this returns independent booleans rather than a single mutually-exclusive label -- a
// probability of exactly 50.0 is simultaneously "exact50", "within49to51", "within48to52", and
// "within47to53".
//
// This module does not invent, estimate, or default any probability -- it only classifies a
// number the caller already has (a stored `rawProbability`/`calibratedProbability`/per-model
// `player1Probability`, etc.). See `docs/live-ablation-execution-plan.md` §6 for how this feeds
// the exact/49-51/48-52/47-53 frequency tables that report expects.
export interface Near50Bands {
  exact50: boolean;
  within49to51: boolean;
  within48to52: boolean;
  within47to53: boolean;
}

/**
 * @param probability A player1 win probability on the 0-100 scale (matches how this engine stores
 *   `rawProbability`/`calibratedProbability`/`ModelVote.player1Probability` throughout).
 * @param exactTolerance Floating-point tolerance for "exact 50%" -- stored probabilities are
 *   `Math.round(x * 10) / 10` at several pipeline stages (see the root-cause report §6.3), so a
 *   true 50.0 can persist as 50.0 exactly; this tolerance exists only to absorb genuine
 *   floating-point representation error, not to widen what counts as "exact." Defaults to 1e-9.
 */
export function classifyNear50(probability: number, exactTolerance = 1e-9): Near50Bands {
  const distance = Math.abs(probability - 50);
  return {
    exact50: distance <= exactTolerance,
    within49to51: distance <= 1,
    within48to52: distance <= 2,
    within47to53: distance <= 3,
  };
}

export interface Near50BandCounts {
  n: number;
  exact50: number;
  within49to51: number;
  within48to52: number;
  within47to53: number;
}

function emptyCounts(): Near50BandCounts {
  return { n: 0, exact50: 0, within49to51: 0, within48to52: 0, within47to53: 0 };
}

/** Tallies `classifyNear50` over a list of probabilities. Skips `null`/`undefined`/non-finite values without counting them toward `n` -- never substitutes a default. */
export function tallyNear50Bands(probabilities: Array<number | null | undefined>): Near50BandCounts {
  const counts = emptyCounts();
  for (const p of probabilities) {
    if (p === null || p === undefined || !Number.isFinite(p)) continue;
    counts.n += 1;
    const bands = classifyNear50(p);
    if (bands.exact50) counts.exact50 += 1;
    if (bands.within49to51) counts.within49to51 += 1;
    if (bands.within48to52) counts.within48to52 += 1;
    if (bands.within47to53) counts.within47to53 += 1;
  }
  return counts;
}
