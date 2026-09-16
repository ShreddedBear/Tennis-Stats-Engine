# ENGINE SEPARATION REPORT — Prediction Engine / Parlay Builder Boundary Audit

**Scope:** `artifacts/api-server/src/services/parlayBuilder/`, `routes/adminParlay.ts`,
`scripts/checkParlayBoundary.ts`, shared research/provider services, `artifacts/tennis-predictor/src/pages/AdminParlayBuilder.tsx`.

**Objective under audit:** the only intentional shared prediction signal between the two
systems should be **Cross-Engine Agreement** (a boolean "did the two engines pick the same
player"). No other Prediction Engine output — `calibratedProbability`, `dataQuality`,
`upsetRisk`, `modelAgreement`, the calibration curve itself, or its underlying DB rows — should
reach the Parlay Builder.

**Verdict: the boundary is violated in four independent ways**, two of which are invisible to
the project's own enforcement script. The stated principle ("Parlay Builder NEVER uses
calibratedProbability, safetyScore, or any Prediction Engine output") is **not currently true**
of the code as it stands.

---

## 1. Dependency graph

```
                         ┌─────────────────────────────┐
                         │   routes/predictions.ts      │  (Prediction Engine HTTP surface)
                         └───────────────┬───────────────┘
                                         │
                 ┌───────────────────────┼────────────────────────┐
                 ▼                                                 ▼
   services/predictionEngine/*                     services/evaluation/predictionSnapshot.ts
   (surfaceElo, serveReturn, ensemble,                       │
    calibration, simulator, ...)                             │  getActiveCalibration()
                 ▲                                            ▼
                 │ VIOLATION 1                    services/evaluation/calibrationCache.ts
                 │ (direct import)                            │  reads calibration_models table
                 │                                             │
   services/parlayBuilder/builderScoringService.ts ───────────┘
                 │        ▲                          VIOLATION 2 (shared calibration curve)
                 │        │
                 │        │ VIOLATION 3 (reverse dep, via "shared" shim)
                 │        │
                 │   services/shared/webResearchProvider.ts
                 │        │  (re-exports parlayBuilder/webResearchService.ts)
                 │        ▲
                 │        │ imported by
                 │   services/predictionEngine/availability.ts
                 │
                 ▼
   services/tennisData/compositeProvider.ts  ◄── imports parlayBuilder/sofascoreProvider.ts
                 ▲                                          VIOLATION 4 (reverse dep)
                 │  used by
     ┌───────────┼─────────────────┬──────────────────┐
     ▼           ▼                 ▼                  ▼
routes/       evaluation/      screenshotImport/   parlayBuilder/
predictions.ts ledgerGrading.ts ScreenshotImportSvc  builderProviderFetch.ts
(Prediction Engine live path)

   ┌───────────────────────────────────────────────────────────┐
   │  routes/adminParlay.ts                                     │
   │   POST /admin/parlay/evaluate  → reads predictions &       │
   │        evaluation_predictions tables directly (calibrated_ │
   │        probability, data_quality, upset_risk,              │
   │        model_agreement) — labelled "legacy", still mounted │
   │        and reachable.  VIOLATION 0 (not import-level, DB-  │
   │        level; most direct violation of the four)           │
   │   POST /admin/parlay/validate  → BuilderSnapshot only      │
   │        (player IDs, surface, market odds) — clean payload  │
   │   POST /admin/parlay/engine-agreement → predicted_winner_id│
   │        only — this IS the intended Cross-Engine Agreement  │
   │        pathway, correctly scoped                           │
   └───────────────────────────────────────────────────────────┘

   ┌───────────────────────────────────────────────────────────┐
   │  AdminParlayBuilder.tsx (frontend)                          │
   │   analyzeParlay(): Phase 1 calls /api/predictions per leg,  │
   │   reads calibratedProbability, auto-sets                    │
   │   selectedSide = (calibP1 >= 50 ? "1" : "2")                │
   │   → Phase 2 /validate is then run ONLY on the side the      │
   │   Prediction Engine already favored.  WORKFLOW COUPLING     │
   │   (payload itself stays clean; the leg-selection logic      │
   │   does not)                                                 │
   └───────────────────────────────────────────────────────────┘

   services/screenshotImport/ + services/tennisData/screenshotMatchupResolver.ts
   → genuinely neutral, used by both engines, no cross-imports. CLEAN.
```

---

## 2. Violations found

### Violation 0 — `/admin/parlay/evaluate` reads Prediction Engine DB tables directly (highest severity)
`routes/adminParlay.ts` contains **two evaluation paths** in the same file:

- `POST /admin/parlay/validate` — the Task 105 "Independent Validation Engine," which is what
  the current frontend actually calls.
- `POST /admin/parlay/evaluate` — described in the file's own header comment as *"legacy path
  using Prediction Engine stored signals"*. Its handler runs raw SQL against `predictions` and
  `evaluation_predictions`, selecting `calibrated_probability`, `data_quality`,
  `data_quality_label`, `upset_risk`, `model_agreement`, and feeds them straight into
  `computeSafetyScore()`.

This route is **mounted and live** (`routes/index.ts:19,41` — `adminParlayRouter` is registered
unconditionally). The current `AdminParlayBuilder.tsx` no longer calls `/evaluate` (a comment at
line 147 calls it "kept for /evaluate fallback only"), but the endpoint is reachable by any
authenticated admin client, old cached frontend bundle, or direct API call, and it directly
contradicts the "never reads predictions table or engine output" guarantee stated in the very
same file's docstring.

### Violation 1 — Parlay Builder imports Prediction Engine modules directly
`services/parlayBuilder/builderScoringService.ts:32-33`:
```ts
import { computeSurfaceEloModule } from "../predictionEngine/surfaceElo.js";
import { computeServeReturnModule } from "../predictionEngine/serveReturn.js";
```
These two modules are stateless, DB-free computation functions (Elo math, serve/return point
stats) — they don't themselves leak `calibratedProbability`. But this is a direct, physical
import of files that live inside, and are conceptually owned by, `services/predictionEngine/`.
It means Parlay Builder cannot build or run if the `predictionEngine/` directory is removed,
refactored, or independently versioned — the two are not deployable as separate modules despite
the design intent.

**This is exactly the violation `checkParlayBoundary.ts` was written to catch, and it does catch
it** — see §5.

### Violation 2 — Parlay Builder shares the Prediction Engine's calibration model (undetectable by the boundary script)
`services/parlayBuilder/builderScoringService.ts:34-35, 1993-2002`:
```ts
import { applyCalibrationOriented } from "../evaluation/calibration.js";
import { getActiveCalibration } from "../evaluation/calibrationCache.js";
...
// Apply the same calibration function the Prediction Engine uses to convert the
// [raw validation score] ... If no active calibration model exists, fall back to raw score.
const { mapping } = await getActiveCalibration();
...
const calibrated01 = applyCalibrationOriented(knots, validationScore / 100);
```
`getActiveCalibration()` (`services/evaluation/calibrationCache.ts`) reads the single active row
of `calibration_models` — the exact table `checkParlayBoundary.ts` forbids Parlay Builder from
referencing. That table is fit by `jobs/runCalibrationRefitJob.ts` against
`evaluation_predictions` ledger rows that were **scored by the Prediction Engine** (the code's
own comments reference "tie-break cascade," "engine breakdown," and "the current engine" as the
source of the training rows).

`getActiveCalibration` has exactly two production callers in the whole codebase:
`services/evaluation/predictionSnapshot.ts` (the Prediction Engine's live scoring path, reached
from `routes/predictions.ts`) and `services/parlayBuilder/builderScoringService.ts`. **Both
consumers calibrate against the same active model**, meaning the Parlay Builder's final
`validationScore` is mathematically entangled with a curve fit on Prediction Engine output, even
though no single field named `calibratedProbability` is copied across.

This is invisible to `checkParlayBoundary.ts` because the forbidden literal
(`calibrationModelsTable`) never appears in a file physically located under
`services/parlayBuilder/` — it appears in `services/evaluation/calibrationCache.ts`, one hop
away. The script does a same-file string scan; it has no import-graph awareness, so any
violation routed through an intermediate module is structurally invisible to it.

### Violation 3 — Reverse dependency: Prediction Engine → "shared" shim → Parlay Builder-owned file
`services/shared/webResearchProvider.ts` is the project's one "neutral shared" file. It reads:
```ts
/** Re-exports the Parlay Builder's webResearchService so it can be consumed by the Prediction
 *  Engine's availability module without creating a circular dependency. ... */
export { researchPlayerMatchup, ... } from "../parlayBuilder/webResearchService.js";
```
`services/predictionEngine/availability.ts` and `services/predictionEngine/types.ts` import from
this shim. The implementation still physically lives inside `services/parlayBuilder/` — the
"shared" layer is a re-export, not a real move to a neutral home. Deleting or restructuring
`services/parlayBuilder/` breaks `predictionEngine/availability.ts`. This is precisely the
"reverse dependency where Prediction Engine imports something owned by Parlay Builder" the audit
was asked to find. The module's own comment acknowledges the coupling exists and just relabels
the import path — it does not remove the dependency.

### Violation 4 — Reverse dependency, systemic: shared data provider layer pulls in Parlay Builder's Sofascore client
`services/tennisData/compositeProvider.ts` — the app-wide `getTennisDataProvider()` used by
`routes/predictions.ts` (the live prediction endpoint), `services/evaluation/*`, and
`services/screenshotImport/*` — imports:
```ts
import { fetchFromSofascore } from "../parlayBuilder/sofascoreProvider.js";
```
`sofascoreProvider.ts`'s own header says it exists *"for the Parlay Builder Validation Engine"*
and is *"called directly from builderProviderFetch.ts as a second-tier fallback."* It has since
been wired in as the **tertiary fixture fallback for the entire app's primary data provider**,
including the live `/api/predictions` route. Functionally the module is generic (no
parlay-specific logic), but it is filed under, owned by, and documented as belonging to Parlay
Builder — so the Prediction Engine's main data path now depends on a Parlay Builder module to
build and run.

### Workflow coupling (not an import/DB violation, but undermines the "independent" guarantee)
`AdminParlayBuilder.tsx`, `analyzeParlay()`:
- **Phase 1** calls `/api/predictions` for every leg, reads `calibratedProbability`, and sets
  `predictedWinnerSide = calibP1 >= 50 ? "1" : "2"`.
- **Phase 2** calls `/api/admin/parlay/validate` using `selectedPlayerId` derived from that
  `predictedWinnerSide`.

The `/validate` request payload itself is clean (only IDs, surface, market odds — no scores), so
the *scoring computation* is genuinely blind to the engine's numbers. But *which side gets
scored* is chosen entirely by the Prediction Engine's calibrated probability by default. A user
can manually flip `selectedSide`, but the automated "Analyze Parlay" flow — the primary UX path —
always feeds the builder the engine's own pick to validate. This doesn't leak data across the
boundary, but it does mean the two systems are not being exercised independently in normal
product use; "cross-engine agreement" is close to guaranteed by construction unless a user
manually overrides a leg.

### Confusingly-named, low-severity: `computeCrossEngineAgreement` in `builderScoringService.ts`
`services/parlayBuilder/builderScoringService.ts:2039-2045` defines:
```ts
export function computeCrossEngineAgreement(builderDecision: BuilderResult["decision"]): boolean | null {
  if (builderDecision === "KEEP" || builderDecision === "BORDERLINE") return true;
  if (builderDecision === "REMOVE") return false;
  return null;
}
```
Despite the name, this does **not** compare the Builder's pick against the Prediction Engine's
pick — it's a pure function of the Builder's own decision. The actual engine-vs-engine
comparison happens elsewhere (see §4, the real pathway is client-side in `AdminParlayBuilder.tsx`
using `/admin/parlay/engine-agreement`). This function is dead weight that will mislead the next
engineer who greps for "cross engine agreement" expecting to find the real comparison logic here.
It's also imported into the standalone research scripts `scripts/validateCrossEngineAgreement.ts`
and `scripts/backfillCrossEngineAgreement.ts` under that same misleading premise.

---

## 3. Shared components — who's actually neutral

| Component | Verdict |
|---|---|
| `services/screenshotImport/` (`ScreenshotImportService.ts`, `providerHealthMonitor.ts`, `imageHashCache.ts`, `ocrSpaceProvider.ts`) | **Clean.** Explicitly documented as "the single global entry point for ALL screenshot OCR... Every module that needs to import a screenshot (Prediction Engine, Parlay Builder, Batch Import, etc.) must call this service." No imports from `predictionEngine/` or `parlayBuilder/`. This is the correct pattern for a shared service. |
| `services/tennisData/` (types, `playerIdentity.ts`, `screenshotMatchupResolver.ts`, `surfaceMap.ts`, `dbHistoryFallback.ts`, `bsdTennisProvider.ts`) | Neutral **except** `compositeProvider.ts`, which pulls in `parlayBuilder/sofascoreProvider.ts` (Violation 4). Everything else in the directory is genuinely shared infrastructure. |
| `services/shared/webResearchProvider.ts` | **Not actually neutral** — a re-export shim over a Parlay-Builder-owned file (Violation 3). Should be treated as "shared in name only." |
| `services/evaluation/` (`calibration.ts`, `calibrationCache.ts`, `predictionSnapshot.ts`, ledger/backtest tooling) | **Not neutral.** This is the Prediction Engine's own evaluation/calibration harness (fits against `evaluation_predictions`, feeds `routes/predictions.ts`). Parlay Builder pulling from here (Violation 2) is Parlay Builder depending on Prediction Engine infrastructure, not a legitimate shared layer. |
| `scripts/validateCrossEngineAgreement.ts`, `scripts/backfillCrossEngineAgreement.ts`, `scripts/backfillParlayLegOutcomes.ts`, `scripts/verifyScoringFix.ts` | Standalone offline analysis/tooling scripts that legitimately import both engines' internals for research purposes. They are outside the runtime request path and outside `checkParlayBoundary.ts`'s scan scope (`services/parlayBuilder/` only). Acceptable as tooling, but worth flagging that they are proof the two modules' internals are not opaque to each other even at the source level. |

---

## 4. Cross-Engine Agreement — the one pathway that's correctly scoped

`POST /admin/parlay/engine-agreement` (`routes/adminParlay.ts:1272-1304`) is the actual,
correctly-designed shared-signal pathway:
```sql
SELECT predicted_winner_id
  FROM predictions
 WHERE (player1_id = $1 AND player2_id = $2) OR (player1_id = $2 AND player2_id = $1)
 ORDER BY created_at DESC LIMIT 1
```
It returns **only** `predicted_winner_id` — a bare player-ID label, never `calibrated_probability`,
`data_quality`, `upset_risk`, or any other engine internals. `AdminParlayBuilder.tsx` fetches this
separately from `/validate` and compares it client-side against the Builder's own
`builderPickedPlayerId` to render the "engine agrees" badge. This is the one place in the codebase
that matches the intended design: a single boolean-shaped signal, no numeric leakage, computed
by comparing two independently-produced picks rather than by one engine consuming the other's
internals.

**Recommendation:** this is the pattern the other four violations should be refactored toward —
expose only opaque, already-decided outputs (a winner ID, a boolean) across the boundary, never
shared code, shared tables, or shared calibration curves.

---

## 5. Boundary-test results

`scripts/checkParlayBoundary.ts` (Task #111) was run against the current `HEAD` of
`claude/engine-parlay-separation-87oghq`:

```
$ npx tsx src/scripts/checkParlayBoundary.ts
❌  Parlay Builder import-boundary violations:
  src/services/parlayBuilder/builderScoringService.ts:32  (import from predictionEngine/)
    import { computeSurfaceEloModule } from "../predictionEngine/surfaceElo.js";

  src/services/parlayBuilder/builderScoringService.ts:33  (import from predictionEngine/)
    import { computeServeReturnModule } from "../predictionEngine/serveReturn.js";

2 violation(s) detected. Fix before committing.
```

**The project's own guard rail currently fails.** This is not a hypothetical risk raised by this
audit — it is a live, reproducible, exit-code-1 failure on the current codebase, produced by
running the exact command documented in the script's own usage comment
(`pnpm exec tsx src/scripts/checkParlayBoundary.ts`, or `pnpm run check:parlay-boundary`).

Further, **this check is not wired into CI.** There is no `.github/workflows/` directory
anywhere in the repository, and no other automation references
`check:parlay-boundary`/`checkParlayBoundary`. The script and its regression-guard test suite
(`checkParlayBoundary.test.ts`, which also currently fails its first assertion — "clean codebase
passes with exit code 0" — because the codebase is not clean) exist but are never executed
automatically. They only run if a developer remembers to invoke them by hand.

Additionally, as documented in §2 Violation 2, **the script has a structural blind spot**: it
only scans the literal contents of files physically located under `services/parlayBuilder/`. A
violation reached through one level of indirection (Parlay Builder → `evaluation/` →
`calibration_models` table) is invisible to it, regardless of enforcement. Making the check
transitive (walk the import graph, not just grep one directory) would be required to catch
Violation 2 or a future `shared/`-shim-style violation like Violation 3.

---

## 6. Required fixes, in priority order

1. **Remove or gate `/admin/parlay/evaluate`.** It is the single most direct violation — live,
   DB-reachable, and directly contradicts the module's own stated guarantee. If it must stay for
   some legacy reason, it needs to be removed from `routes/adminParlay.ts` entirely (delete
   dead code) or explicitly feature-flagged off with a comment explaining why it still exists;
   right now it is simply unguarded, mounted code.

2. **Break the shared calibration dependency (Violation 2).** Either give Parlay Builder its own
   independently-fit calibration curve (its own table/row, fit against `builder_decision_log`
   outcomes, not `evaluation_predictions`), or drop calibration entirely and ship the raw
   `validationScore`. Sharing the Prediction Engine's `calibration_models` row is the deepest and
   least visible violation found in this audit.

3. **Fix `checkParlayBoundary.ts`'s two live violations** (Violation 1): either inline the two
   pure math functions (`computeSurfaceEloModule`, `computeServeReturnModule`) into
   `services/parlayBuilder/` as builder-owned copies, or move them to a genuinely neutral
   `services/shared/` (or `services/mathModels/`) location that both engines import from
   symmetrically — not one importing from the other's directory.

4. **Wire `check:parlay-boundary` into CI**, and extend it to walk the import graph transitively
   (not just grep files under `services/parlayBuilder/`) so it also catches Violation 2 and
   Violation 3-style indirection through `shared/` re-export shims. Until this runs on every PR,
   this exact class of regression will keep landing silently — as it evidently already has.

5. **Move `sofascoreProvider.ts` out of `services/parlayBuilder/`** into `services/tennisData/`
   (Violation 4). It is generic infrastructure now serving the main prediction data path; its
   current location and ownership documentation are simply wrong given how it's actually used.

6. **Move `webResearchService.ts`'s real implementation** out of `services/parlayBuilder/` into
   `services/shared/`, and make `services/shared/webResearchProvider.ts` the actual
   implementation rather than a re-export shim (Violation 3).

7. **Decouple the frontend's leg-selection workflow from `calibratedProbability`.** Either let
   the user pick each leg's side before any prediction call runs, or clearly label the
   auto-selection step in the UI as "Prediction Engine's suggested side" so it's understood as a
   convenience default rather than part of the "independent validation."

8. **Rename or remove `computeCrossEngineAgreement` in `builderScoringService.ts`.** It doesn't
   do what its name says and risks misleading future maintenance of the real agreement pathway
   (§4). The real comparison logic should either be centralized server-side (compute agreement in
   `/admin/parlay/engine-agreement` itself, returning a boolean, instead of leaving the comparison
   to the frontend) or the misnamed function should be deleted.

---

## 7. Summary

| # | Finding | Direction | Caught by `checkParlayBoundary.ts`? |
|---|---|---|---|
| 0 | `/admin/parlay/evaluate` reads `predictions`/`evaluation_predictions` directly | Parlay Builder route → Prediction Engine DB | No (route-level, not scanned) |
| 1 | `builderScoringService.ts` imports `predictionEngine/surfaceElo.ts`, `serveReturn.ts` | Parlay Builder → Prediction Engine | **Yes** (currently red) |
| 2 | Parlay Builder reuses Prediction Engine's `calibration_models` via `evaluation/calibrationCache.ts` | Parlay Builder → Prediction Engine (indirect) | **No** (blind spot) |
| 3 | `predictionEngine/availability.ts` imports `shared/webResearchProvider.ts` → `parlayBuilder/webResearchService.ts` | Prediction Engine → Parlay Builder (reverse) | No (reverse direction unscanned) |
| 4 | `tennisData/compositeProvider.ts` imports `parlayBuilder/sofascoreProvider.ts` | Shared layer → Parlay Builder (reverse, systemic) | No (reverse direction unscanned) |
| — | Frontend auto-selects leg side from `calibratedProbability` before validating | Workflow-level coupling | N/A (not code-boundary) |
| — | `computeCrossEngineAgreement` misnamed / dead relative to its name | Naming/clarity | N/A |
| — | Cross-Engine Agreement pathway (`/admin/parlay/engine-agreement`) | Correctly scoped | N/A — this is the model to replicate |

Prediction Engine currently **cannot** build/run independently of Parlay Builder (Violations 3,
4). Parlay Builder currently **cannot** produce a validation score independent of Prediction
Engine output (Violations 1, 2, and — when reached — Violation 0). The stated architectural
guarantee is not met by the code as it stands, and the automated check meant to enforce it is
both currently failing and not run anywhere in CI.
