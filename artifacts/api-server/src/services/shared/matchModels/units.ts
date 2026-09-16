/**
 * Shared scale-branded number types for the prediction engine.
 *
 * Why this exists: the WIN PROB (ELO) display bug happened because
 * `surfaceElo.eloWinProbabilityPlayer1` is already on the 0-100 scale, but the frontend assumed
 * it was a 0-1 decimal and multiplied by 100 again. Nothing in the type system distinguished
 * "0-100 percentage" from "0-1 decimal fraction" -- both were just `number`, so the mistake only
 * showed up as a wrong number on screen, not a type error or a review flag.
 *
 * Convention (applies to every prediction-engine module, not just surfaceElo.ts): any
 * probability/confidence/reliability/share/weight/risk-style field must be typed as one of the
 * two branded aliases below rather than plain `number`, and the module doc comment for that
 * field should say which one and why. A branded value is still a plain JS number at runtime
 * (this costs nothing and changes no behavior) -- the brand only exists so:
 *   1. A function that expects one scale (e.g. `formatPercentage(value: Percentage)`) rejects a
 *      value of the other scale at compile time instead of silently accepting it.
 *   2. A reviewer sees which explicit conversion helper was used (`asPercentage` vs
 *      `fractionToPercentage`) at the call site, instead of an unmarked inline `* 100`.
 *
 * These brands are erased once a value crosses the JSON API boundary (JSON literals can't carry
 * TS-only type metadata), so they protect engine-internal TypeScript code, not the frontend
 * directly. The frontend enforces the same convention independently, via its own parallel
 * branded types in `tennis-predictor/src/lib/percentage.ts` -- see that file for how a value
 * must be explicitly wrapped as one scale or the other before it can be formatted for display.
 */

declare const PercentageBrand: unique symbol;
declare const FractionBrand: unique symbol;

/** A value on the 0-100 scale, e.g. a win probability already expressed as a percentage (72.4 means 72.4%). Render directly -- never multiply by 100 again. */
export type Percentage = number & { readonly [PercentageBrand]: true };

/** A value on the 0-1 scale, e.g. a raw probability or blend weight expressed as a decimal fraction (0.724 means 72.4%). Must go through `fractionToPercentage` before display. */
export type Fraction = number & { readonly [FractionBrand]: true };

/** Assert that a raw number is already on the 0-100 scale. Use at the one place a value is computed/received on that scale -- never re-derive or re-guess the scale downstream. */
export function asPercentage(value0to100: number): Percentage {
  return value0to100 as Percentage;
}

/** Assert that a raw number is already on the 0-1 scale. */
export function asFraction(value0to1: number): Fraction {
  return value0to1 as Fraction;
}

/** Convert a 0-1 fraction to the 0-100 percentage scale used for display. */
export function fractionToPercentage(value: Fraction): Percentage {
  return (value * 100) as Percentage;
}

/** Convert a 0-100 percentage back to the 0-1 fraction scale, e.g. when feeding a probability into further logistic/statistical math. */
export function percentageToFraction(value: Percentage): Fraction {
  return (value / 100) as Fraction;
}
