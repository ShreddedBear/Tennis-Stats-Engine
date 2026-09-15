# Silent Fallbacks — Phase 0 Audit

**Scope:** Statistical Prediction Engine, `Tennis-Stats-Engine` repo, branch `claude/engine-audit-phase-zero-5fj00z`.
**No live DB access this session** — every "how often did this fire in the last 30 days" question is answered with the SQL query the human should run, not a fabricated count. Do not treat any number in this document as a live frequency unless it is explicitly cited from an existing repo doc.

---

## 0. Top-line finding: the fallback-tracking instrumentation covers a small fraction of the real fallback surface

There are **two disconnected fallback-tracking systems**, and neither captures most of what's below.

**(A) `eloFallbackTracker`** (`predictionEngine/fallbackTracking.ts`) — an in-memory, run-scoped singleton counting how often `surfaceElo.ts`'s `replayElo` used `levelBaselineElo()` for an opponent whose Elo history couldn't be resolved. Logs a structured line per event; exposes aggregate `totalAttempts/fallbackCount/fallbackRate`. Only read/reset by three offline scripts (`eloOpponentResolutionRebuild.ts`, `walkForward.ts`, `bridgeRescore.ts`) — **never read by the live prediction path**, and **never written into the persisted `used_fallback`/`fallback_sources` columns**. In the live server process it accumulates indefinitely across all concurrent traffic (never reset outside batch scripts), so any aggregate rate read from a live process is contaminated across unrelated matches.

**(B) `extractFallbackInstrumentation()`** (`evaluation/fallbackInstrumentation.ts`) — the *only* code that populates the persisted `used_fallback`(boolean) / `fallback_sources`(jsonb) columns on `predictions` and `evaluation_predictions`. It recognizes **exactly three** sources, by pattern-matching already-computed output rather than any module reporting its own fallback state:

| Source string | Trigger | file:line |
|---|---|---|
| `"serveReturn"` | `engine.serveReturn.note` **string-contains** "ratings are derived from real set/game score margins" | `fallbackInstrumentation.ts:38` |
| `"recentForm"` | either player's `recentForm.player1/2OpponentAdjustedCoverage < 100` | `fallbackInstrumentation.ts:45` |
| `"index"` | `decisionTrace.pipeline.calibrationMethod === "fallback"` | `fallbackInstrumentation.ts:50` |

This function has **zero unit tests anywhere in the repo** (confirmed: no `fallbackInstrumentation.test.ts`; no `usedFallback`/`fallbackSources`/`extractFallbackInstrumentation` references in any `*.test.ts` under `services/evaluation`).

It never inspects: surfaceElo's per-opponent level-baseline substitution, availability's `NEUTRAL=60` path, fatigue's match-count-only fallback, headToHead's `defaulted`, styleMatchup's ambiguous "no dominant surface signal" tag, matchLoadRecovery's `score=0` fallback, or the `ZERO_HISTORY_MODULE_FLOOR` reliability injection. All of these are silent with respect to `used_fallback`/`fallback_sources`.

**Downstream exposure**: grepped the entire `routes` tree and the `tennis-predictor` frontend for `usedFallback`/`fallbackSources`/`used_fallback`/`fallback_sources` — **zero matches**. These columns are write-only: populated on insert, never read back by any API route or UI. The only place they're queried is ad hoc SQL in `docs/audit-*.md` files. **Even the narrow 3-source signal that *is* computed is invisible to any live caller** — a client, or the ensemble itself, has no way to know a fallback fired.

`docs/audit-prediction-accuracy-complete.md:186` asserts *"The instrument (used_fallback, fallback_sources) is fully populated and verified"* and reports a 71.9% fallback rate across 195,987 rows (line 649). **That claim should be read against the fact that the instrument only tracks 3 narrow, partly string-matched conditions and is untested.** The re-verification query (also used in `docs/audit-live-verification-121.md:146-147`):
```sql
SELECT fallback_sources, COUNT(*) FROM evaluation_predictions GROUP BY fallback_sources ORDER BY 2 DESC;
```

---

## 1. serveReturn.ts

**1.1 — margin-proxy zero-sample default** (`serveReturn.ts:183`): `if (withMargins.length === 0) return { serve: 50, ret: 50, sample: 0, coverage: 0 };`
Trigger: neither player has any match with usable real set/game margins. **Flagged partially**: `sample:0` floors `reliability` to 5, a warning fires when `minSample<5`, and `defaulted=true` (line 322) feeds `index.ts`'s `defaultedInputs`. **Gap**: `used_fallback`/`fallback_sources` derive this from string-matching the `note` field rather than reading `serveReturn.defaulted`/`sample===0` directly — a maintenance hazard: if the note's wording ever changes, DB-level fallback detection silently breaks.

**1.2 — real-stats coverage <50% → opponent-neutral weighting, warning only** (`serveReturn.ts:262-264,310-312`): matches with unresolved opponent Elo are weighted `strengthFactor=1` (neutral) instead of strength-adjusted. Flagged via `warnings` only — **not** reflected in `defaulted`, `used_fallback`, or `fallback_sources` at all. A match with heavy opponent-unresolved weighting can show `defaulted=false` and never appear as a fallback source.

## 2. recentForm.ts

**2.1 — zero-match window → hardcoded neutral** (`recentForm.ts:133`): `if (recent.length === 0) return { form: 50, trend: "stable", sample: 0, coverage: 0, ... };`
**Flagged well**: `defaulted=true` feeds `defaultedInputs`, reliability floors to 10, a warning fires, and it's **explicitly tested** (`recentForm.test.ts:43-49`, "form and trend stay stable/neutral defaults with no match history") — one of the few honestly-tested defaults in the codebase. Also coincidentally caught by the DB-level `fallback_sources` "recentForm" trigger since coverage(0)<100.

**2.2 — opponent-unresolved outcome falls back to plain win/loss** (`recentForm.ts:152`): `p.performanceDelta !== null ? 0.5 + p.performanceDelta/2 : p.actualScore`. This is the honest design (real win/loss, not a fabricated strength-adjusted number) — flagged via `coverage` and a warning when coverage<0.5. Listed for completeness, not a defect.

**2.3 — empty trend half-window → silent 0.5** (`recentForm.ts:191`): `return total > 0 ? sum / total : 0.5;`. Effectively unreachable given `TREND_MIN_SAMPLE=6` gates its only caller — but if ever hit, fires with no warning or flag. Low priority; worth a defensive log if the gating condition ever changes.

**2.4 — tour-level-share shrink toward neutral** (`recentForm.ts:172-177`, floor 0.35): well-instrumented (explicit warning + exposed share fields) — listed for completeness as a "substituted toward neutral" pattern, not a silent gap.

## 3. index.ts / ensemble & calibration wiring

**3.1 — `defaultedInputs` only covers 4 of ~8 modules** (`index.ts:563-568`): array only checks `surfaceElo.defaulted`, `serveReturn.defaulted`, `recentForm.defaulted`, `headToHead.defaulted`. Fatigue, Availability, MatchLoadRecovery, StyleMatchup have **no `defaulted` field on their result types at all** — structurally invisible to this array even in principle. This array drives the `DATA_INCOMPLETE` recommendation label, so it is blind to fallback conditions in half the wired modules. **Recommended fix**: add a `defaulted`/`neutralValueUsed` boolean to all four result types.

**3.2 — `ZERO_HISTORY_MODULE_FLOOR` silently *raises* reliability for zero-history players** (`index.ts:604-616`):
```ts
const ZERO_HISTORY_MODULE_FLOOR = 40;
if ((p1ZeroHistory || p2ZeroHistory) && (m.key==="surfaceElo"||m.key==="recentForm"||m.key==="serveReturn")) {
  reliability = Math.max(reliability, ZERO_HISTORY_MODULE_FLOOR);
}
```
This is the **opposite** of the usual "fallback lowers confidence" pattern: it floors (raises) reliability for the Data Quality blend specifically to at least 40, even though each module's own real reliability at zero sample is near 0-10 (recentForm floors to 10, serveReturn to 5). Stated rationale: avoid "one structural data gap counting five times" — but the mechanism manufactures a Data Quality number *higher* than what the modules actually measured, and this is **not flagged to the caller** — `dataQualityLabel` is returned as an ordinary value with no trace that 3 module reliabilities were overridden upward. **Recommended fix**: either don't floor DQ inputs and let the score legitimately read low, or expose an explicit `dataQualityFloorApplied: boolean` on `EngineBreakdown`.

**3.3 — market-consensus vig-normalization silent 0.5** (`index.ts:517`): `const normP1 = totalImplied > 0 ? rawP1/totalImplied : 0.5;` — edge case requiring degenerate odds despite an upstream `>1` guard; silent if ever hit. Low priority — verify reachability, remove or guard explicitly if dead.

**3.4 — hard clamp [0.6, 99.4]**: deliberate documented business rule, not a missing-data fallback. Not a defect.

**3.5 — `matchLoadRecovery.warnings` never reaches `engine.warnings`** (`index.ts:1033-1039`): the aggregated warnings array includes surfaceElo/serveReturn/recentForm/fatigue/availability but **not** matchLoadRecovery — its fallback disclosures ("recovery risk defaults to 0") exist only in the nested `engine.matchLoadRecovery.warnings` object, never in the flat array most UI/consumers would read. **Recommended fix**: add it to the aggregation.

## 4. fatigue.ts

**4.1 — fixed `reliability=70` constant, not a real per-match signal** (`fatigue.ts:85`): always fires, unconditionally. Well-governed: documented in `dataQuality.ts:27-29`, and the consequence is neutralized by excluding fatigue from both ensemble and Data Quality (see feature-trace.md §4) after the inverted-signal finding (54.9-61.7% the "fatigued" player actually wins).

**4.2 — missing set-score data → match-count-only fallback** (`fatigue.ts:41,70-72`): flagged via `warnings`, which *do* reach `engine.warnings` and `upsetRiskUncertaintyWarnings`. Reasonably honest. Not reflected in `used_fallback`/`fallback_sources` (fatigue is entirely outside that instrument's scope).

## 5. availability.ts

**5.1 — hardcoded `NEUTRAL=60` baseline** (`availability.ts:122-123`): fires for every player every time; when nothing resolves (no prior match, no travel data, no confirmed concern), the score is exactly 60, unadjusted. **No `defaulted` field exists on `AvailabilityResult`** — cannot ever appear in `defaultedInputs`. Test (`availability.test.ts:129-136`) asserts the score stays neutral and equal between players but does not assert the specific value 60 or check any flag (there isn't one). Since availability is excluded from ensemble and DQ (feature-trace.md §6), this doesn't move `calibratedProbability` — but it IS displayed on the card as if a real per-match signal, with no marker distinguishing "genuinely neutral because it washed out" from "defaulted because nothing resolved." **Recommended fix**: add `defaulted: boolean` (true when nothing resolved for either player) and pipe into `defaultedInputs` for consistency.

**5.2 — unresolved travel distance is deliberately un-warned** (`availability.ts:151-153,216-218`): explicit code comment — "expected/common and not surfaced as a user-facing warning." A documented product decision, not an oversight. Reflected in reliability weighting (`TRAVEL_SIGNAL_WEIGHT=0.1`), consistent with the design.

**5.3 — web-research injury discount**: honestly gated (only discounts when `riskLevel>=60`, always warns) — not a defect. (Note: per feature-trace.md §6, this whole code path is currently dead on the live route since `webResearch` is never passed in.)

## 6. matchLoadRecovery.ts

**6.1 — no prior match → score defaults to 0** (`matchLoadRecovery.ts:66`, "unknown, not assumed fresh"): warning pushed, but per §3.5 never reaches `engine.warnings`. No `defaulted` field on the result type.

**6.2 — unresolved went-distance falls back to 0** (`matchLoadRecovery.ts:91-93,55-63,74`): `wentDistance` is `null` when unresolvable; `const score = wentDistance ? WENT_DISTANCE_RISK : 0;` — `null` is falsy in JS, so a genuinely-unknown state and a confirmed-short-match state produce **numerically identical** output (score=0). Only the warning string distinguishes them, and (per §3.5) that warning never reaches the top-level output. **Recommended fix**: distinct sentinel value, or at minimum route the warning to `engine.warnings`.

## 7. headToHead.ts

**7.1 — zero-meetings → `weightedEdge=0`, `defaulted=true`** (`headToHead.ts:58,79`): one of the **best-instrumented** fallbacks in the codebase — `defaulted` flag feeds `defaultedInputs`, a warning distinguishes "no meetings" from "only one meeting," reliability floors to 5, and headToHead is deliberately excluded from the Data Quality blend specifically because "no meetings yet" is the *normal* case (a considered design decision, not an oversight). Only gap: never wired into `used_fallback`/`fallback_sources` despite having a clean `defaulted` field ready to read.

## 8. styleMatchup.ts

**8.1 — thin-sample surfaces get a hardcoded generic tag, not a null** (`styleMatchup.ts:31`): `if (tags.length===0) tags.push("All-court, no dominant surface signal yet");` — a player with genuinely zero surface data and a player with plenty of balanced 50/50 data both get the identical string. Flagged via `warnings` when `sampleBreadth<=2` and via reliability scaling; no `defaulted` field. Since this module doesn't vote (feature-trace.md §8), the ambiguity is cosmetic today, but would matter if styleMatchup is ever wired into scoring.

## 9. surfaceElo.ts — the flagship fallback (Task #76/#77 lineage)

**9.1 — per-match opponent-unresolved fallback to level-aware baseline Elo** (`surfaceElo.ts:200,221`): `const usedFallback = knownOpponentElo === undefined; const opponentReference = knownOpponentElo ?? levelBaselineElo(match.tournamentLevel);`. Genuinely well-designed substitute (a corpus-measured, level-specific average — GrandSlam=1523, Masters1000=1537, etc., derived from a documented ~29.4k-row query — not a naive flat 1500). **Flagged per-event** via `eloFallbackTracker.record()`, which does fire on the live path and does log a structured line — but (per §0(A)) this tracker is never wired into `used_fallback`/`fallback_sources`, and its live aggregate is contaminated across unrelated concurrent traffic since it's never reset outside batch scripts. At the module-result level, `defaulted` only flags *total* absence of surface matches (zero-sample case) — **not** the "plenty of matches, mostly against unresolved opponents" case, which can have `defaulted=false` and be invisible everywhere.

**9.2 — `opponentCoverage` is computed internally, then discarded, never surfaced** (`surfaceElo.ts:244,293,296`): a genuinely useful "how much of this rating came from real vs. baseline opponents" signal is computed inside `replayElo` and never placed on `PlayerSurfaceEloResult` or the final `SurfaceEloResult`. serveReturn.ts computes and *does* expose the analogous concept (driving a real warning) — surfaceElo computes it and throws it away. **Recommended fix**: expose `opponentCoverage` on the result and drive a warning/flag from it, matching serveReturn's pattern.

## 10. Ensemble / disagreement / calibration — positive and historical findings

**10.1 — market absence does not synthesize a neutral vote** (positive finding): confirmed by `index.test.ts:255` — genuinely honest design, the opposite of a silent 0.5 injection.

**10.2 — disagreement.ts zero-weight fix** (`disagreement.ts:125-136`, historical, now fixed): an empty/all-zero-weight model list used to fabricate 100% support for player 2 via an `|| 1` fallback bug; now returns a neutral 50/50 reading instead. Cited as a precedent for the pattern the other findings above should follow ("honestly degrade to neutral," not "fabricate a leader").

**10.3 — calibration.ts fallback shrink curve** (`calibration.ts:47-62`): explicitly documented as a stand-in before a real fitted calibration model exists — and correctly wired to its true trigger (`calibrationMethod==="fallback"`, a structured field, not a string match). The one source in `extractFallbackInstrumentation` that's correctly wired — though it conflates a *systemic* condition (no fitted model exists yet, server-wide) with a *per-match* data gap when reported under the same `used_fallback` flag as the other two sources.

## 11. Test coverage summary

**Modules WITH explicit test coverage of their neutral/default paths**: `recentForm.test.ts` (zero-history defaults, tour-share shrink), `availability.test.ts` (neutral-when-nothing-resolves, but not the specific NEUTRAL=60 constant or any flag), `opponentStrength.test.ts` (confirms the *lookup* itself stays honestly unresolved — but not the level-baseline substitution one layer up in surfaceElo.ts), `serveReturn.test.ts` (proxy path doesn't crash, but doesn't assert the specific 50/50 default by name), `disagreement.test.ts` (the fixed zero-weight bug, good regression coverage), `index.test.ts` (Market Consensus honest-absence).

**Modules/mechanisms with NO test coverage of fallback behavior**: `extractFallbackInstrumentation()` (zero tests of any kind), `eloFallbackTracker`/`levelBaselineElo()` per-match substitution and its rate/threshold logic, `matchLoadRecovery.ts`'s score=0 null-vs-false collapse (Finding 6.2 — worth a follow-up read of `matchLoadRecovery.test.ts`, which exists but wasn't confirmed to cover this), `styleMatchup.ts`'s ambiguous tag (Finding 8.1), `ZERO_HISTORY_MODULE_FLOOR` (not confirmed tested in `index.test.ts`), the `used_fallback`/`fallback_sources` DB round-trip (`savePrediction.test.ts` has zero references to fallback logic).

---

## Recommended follow-ups for Phase 1

1. **Highest priority**: rewrite `extractFallbackInstrumentation` to read structured fields (`surfaceElo.defaulted`, a new `availability.defaulted`, matchLoadRecovery's null-vs-zero distinction, `eloFallbackTracker`'s per-request event data) instead of string-matching a `note` field and a broad coverage<100 threshold. The current 71.9%-fallback-rate figure in `docs/audit-prediction-accuracy-complete.md` should be treated as measuring only 3 narrow conditions, not the true fallback surface.
2. Surface `ZERO_HISTORY_MODULE_FLOOR`'s application as an explicit boolean on `EngineBreakdown`.
3. Restore `matchLoadRecovery.warnings` into `engine.warnings` (currently silently dropped).
4. Add `defaulted` fields to `AvailabilityResult`, `FatigueResult`, `MatchLoadRecoveryResult`, `StyleMatchupResult` for consistency with the four modules that already have one.
5. Once DB access is available, re-verify the 71.9% figure and cross-tabulate `used_fallback=false` rows against `eloFallbackTracker` log lines (requires log-aggregation access, not available this session) to see how many rows had a silent surfaceElo level-baseline fallback fire without it being recorded anywhere queryable.
