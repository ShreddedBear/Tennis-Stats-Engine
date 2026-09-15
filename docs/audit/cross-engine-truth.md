# Cross-Engine Agreement — What It Does vs. What It Claims (Phase 0)

**Scope:** `computeCrossEngineAgreement()` and everything that names itself "agreement" between the
Parlay Builder and the Prediction Engine. Read-only audit — no code changed.

## 1. What `computeCrossEngineAgreement` actually does

The full function, `builderScoringService.ts:2039-2045`:

```ts
export function computeCrossEngineAgreement(
  builderDecision: BuilderResult["decision"],
): boolean | null {
  if (builderDecision === "KEEP" || builderDecision === "BORDERLINE") return true;
  if (builderDecision === "REMOVE") return false;
  return null;
}
```

It takes **one argument**: the Builder's own decision. It does not take a Prediction Engine
prediction, a predicted winner, a probability, or any input from the other engine at all. It cannot
compare two engines because it only ever sees one. What it computes is: *"did the Builder engine
itself land on KEEP or BORDERLINE (→ true), REMOVE (→ false), or DATA_UNAVAILABLE (→ null)."* That
is a relabeling of the Builder's own decision field into a boolean, not an agreement measurement.
This is the P0 honesty bug named in the brief, and the code confirms it exactly as described —
there's no ambiguity or nuance to add here.

There are no unit tests for this function (`grep`'d `builderScoringService.test.ts` for
`computeCrossEngineAgreement` — zero hits), which is consistent with it never having been exercised
against a real "did engine A agree with engine B" scenario.

## 2. The two places this function is actually called both feed it a self-referential setup, and both discard the one field that would have been real agreement

`src/scripts/backfillCrossEngineAgreement.ts:65-76`:

```ts
const result = computeCrossEngineAgreement((await computeBuilderScore({
  selectedPlayerId: row.predictedWinnerId,        // <- the Prediction Engine's OWN pick
  selectedPlayerName: row.predictedWinnerName,
  opponentId: row.predictedWinnerId === row.player1Id ? row.player2Id : row.player1Id,
  ...
})).decision);
```

This script reads a stored `predictions` row and passes the **Prediction Engine's own predicted
winner** in as `selectedPlayerId` — i.e. it asks the Builder "if you were told to validate the
Prediction Engine's pick, would you KEEP it?" and stores the true/false/null result as
`predictions.crossEngineAgreement`. That is a real, computable question, but it is not "did these
two engines independently arrive at the same winner" — it's "does the Builder's validation logic,
when pointed at the PE's own output, clear it." A PE pick could get `crossEngineAgreement = true`
here while the Builder's own independently-favored player (see §3) is the *other* player, and this
function would never surface that.

**The part that makes this worse than a naming mismatch:** `computeBuilderScore` already computes
the exact comparison this doc's task description asks for, in the same call, and the script throws
it away. See next section.

`src/scripts/validateCrossEngineAgreement.ts` consumes the resulting `predictions.crossEngineAgreement`
column to test whether it "correlates with meaningfully higher real accuracy" of the **Prediction
Engine's own pick** (`fetchRealRows()`, `validateCrossEngineAgreement.ts:103-126`: `wasCorrect =
predictedWinnerId === actualWinnerId`). So even the validation script for this signal is measuring
"does Builder-clears-PE's-pick predict PE accuracy," not measuring genuine two-engine agreement
against real outcomes. (I also note this script has a `--mock` mode that generates synthetic rows
with a hand-picked accuracy gap baked in — `generateMockEntries`, lines 52-99 — which is fine as a
harness self-test but is not evidence of anything about the real signal; I did not find any
committed output from a real, non-mock run of this script.)

## 3. The real signal already exists in the code, under a different name, and is never wired to `computeCrossEngineAgreement`

`computeBuilderScore` independently computes which player its own evidence favors, at
`builderScoringService.ts:2009-2012`:

```ts
// Independent winner selection: the engine picks the player it favors on its own,
// independently of the caller's selection. Used to measure engine accuracy over time.
const builderPickedPlayerId = builderCalibratedProbability >= 50 ? selectedPlayerId : opponentId;
const callerAgreesWithEngine = builderPickedPlayerId === selectedPlayerId;
```

`builderPickedPlayerId` is a genuine independent judgment: `validationScore`/
`builderCalibratedProbability` is a comparative score of `selectedPlayerId` vs. `opponentId` built
entirely from the Builder's own factor set (surface Elo, serve/return, rankings, H2H, etc. — never
touching `predictions` or `calibratedProbability`, per the file's own header comment at line 4-7).
When `backfillCrossEngineAgreement.ts` calls this with `selectedPlayerId = row.predictedWinnerId`,
**`callerAgreesWithEngine` is, precisely, "did the Builder's own independent pick match the
Prediction Engine's own independent pick."** That is real cross-engine agreement, correctly scoped,
already computed, on the `BuilderResult` object the script has in hand (`result.callerAgreesWithEngine`)
— and the script ignores it, extracting only `result.decision` to feed into
`computeCrossEngineAgreement` instead.

So the fix for Phase 1(a) is close to free: the honest signal is one field away, not a redesign.

## 4. A third, differently-scoped "agreement" concept exists in the live UI, and it's neither of the above

`AdminParlayBuilder.tsx`'s "🤝 Engine Agreement" toggle (`toggleEngineAgreement`, lines 1992-2029)
calls `POST /admin/parlay/engine-agreement` (`adminParlay.ts:1272-1304`), a **read-only bridge** that
looks up the most recent `predictions.predicted_winner_id` for each leg's player pair — it does not
call `computeBuilderScore` or touch the Parlay Builder engine at all. The frontend then compares that
stored PE pick against **whichever side the user selected** for that leg (`leg.player1Id`/`player2Id`
vs. `predictedWinnerId`) and uses it purely as a display filter (`agreementOnly` in
`filteredResultLegs`, line 1989) — it does not affect `decision`, does not affect what gets saved,
and is not the same comparison as either §2 or §3.

So, as of this audit, there are **three different things in this codebase called "agreement,"
answering three different questions, none of which is "did the Builder's independent pick match the
Prediction Engine's independent pick, displayed alongside both engines' full reasoning":**

| Name | What it actually compares | Where |
|---|---|---|
| `computeCrossEngineAgreement` | Builder's own decision, relabeled (KEEP/BORDERLINE→true, REMOVE→false) | `builderScoringService.ts:2039` |
| `callerAgreesWithEngine` | Builder's independent pick vs. whatever `selectedPlayerId` was passed in (= PE's pick, *only* in the one script that happens to set it that way) | `builderScoringService.ts:2012`, used correctly only in `backfillCrossEngineAgreement.ts`'s discarded return value |
| "🤝 Engine Agreement" UI toggle | PE's stored pick vs. the *user's* selected side (not the Builder's pick at all) | `AdminParlayBuilder.tsx:1992`, `adminParlay.ts:1272` |

None of these three currently produces or stores: Builder's decision + Builder's confidence +
Builder's evidence, alongside PE's decision + PE's confidence + PE's evidence, side by side, with an
explicit `DISAGREEMENT` state when they differ.

## 5. Spec for a real agreement layer

Per the sequencing constraint in the brief (do not make KEEP conditional on agreement until agreement
has a measured historical edge), this section is a **design only** — nothing here should be
implemented before Phase 1(a), and Phase 1(a) itself is report-only per the brief ("no scoring
change").

**Principle:** preserve both engines' full output; compute a comparison as a derived, additional
field; never let the comparison overwrite either engine's own verdict.

```ts
export interface EngineOpinion {
  engine: "prediction" | "builder";
  pickedPlayerId: string;
  confidence: number;        // 0-100, each engine's own scale
  reasons: string[];         // each engine's own evidence, untouched
}

export type AgreementState =
  | "AGREE"          // both engines independently picked the same player
  | "DISAGREEMENT"   // engines picked different players — terminal, no forced winner
  | "INCOMPARABLE";  // one side is null/DATA_UNAVAILABLE/no stored PE prediction — not the same as DISAGREEMENT

export interface CrossEngineComparison {
  state: AgreementState;
  prediction: EngineOpinion | null;   // null when no PE prediction exists for this matchup
  builder: EngineOpinion;             // builder always has an opinion when decision !== DATA_UNAVAILABLE
}

export function compareEngines(
  predictionPick: { playerId: string; calibratedProbability: number; reasons: string[] } | null,
  builderResult: BuilderResult,
): CrossEngineComparison {
  const builderOpinion: EngineOpinion = {
    engine: "builder",
    pickedPlayerId: builderResult.builderPickedPlayerId,
    confidence: builderResult.builderCalibratedProbability,
    reasons: builderResult.reasons,
  };
  if (builderResult.decision === "DATA_UNAVAILABLE" || predictionPick == null) {
    return { state: "INCOMPARABLE", prediction: predictionPick ? { engine: "prediction", pickedPlayerId: predictionPick.playerId, confidence: predictionPick.calibratedProbability, reasons: predictionPick.reasons } : null, builder: builderOpinion };
  }
  const predictionOpinion: EngineOpinion = {
    engine: "prediction",
    pickedPlayerId: predictionPick.playerId,
    confidence: predictionPick.calibratedProbability,
    reasons: predictionPick.reasons,
  };
  const state: AgreementState = predictionOpinion.pickedPlayerId === builderOpinion.pickedPlayerId ? "AGREE" : "DISAGREEMENT";
  return { state, prediction: predictionOpinion, builder: builderOpinion };
}
```

Notes on why this shape, tied to concrete findings above:

- `builderOpinion` is built from fields that already exist and are already correctly computed
  (`builderPickedPlayerId`, `builderCalibratedProbability`) — §3 showed this is real, not new work.
- The 3-state enum (`AGREE`/`DISAGREEMENT`/`INCOMPARABLE`) is deliberately not a boolean, unlike
  today's `boolean | null` — collapsing "the engines disagreed" and "there's no PE prediction to
  compare against" into the same `null` (as `computeCrossEngineAgreement` currently does for
  `DATA_UNAVAILABLE`) is itself a small instance of the "collapse missing evidence into a forced
  value" anti-pattern the brief warns against generally. `INCOMPARABLE` is not `DISAGREEMENT`.
- Nothing here computes a merged score, overwrites `BuilderResult.decision`, or lets `DISAGREEMENT`
  change what the Builder itself reports — both engines' `reasons` and confidence stay intact and
  visible. This satisfies "overwrites nothing" and "DISAGREEMENT as a terminal state with no forced
  winner" directly.
- This is *not* wired into `toDecision()` or any KEEP/BORDERLINE/REMOVE gating. Per the sequencing
  constraint, whether `AGREE`/`DISAGREEMENT` should ever influence the decision is a Phase-1(c)-or-later
  question that requires the measured historical edge check `validateCrossEngineAgreement.ts` was
  trying (and, per §2, failing) to do correctly.

This is a Phase 0 specification for Phase 1(a) planning, not a commitment to a particular
implementation timeline or file layout — that's for the approved plan to decide.
