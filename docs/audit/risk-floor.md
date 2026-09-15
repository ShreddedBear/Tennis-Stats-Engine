# Closeness Risk Floor — Audit (Phase 0)

**Scope:** `closenessRiskFloor()`, `thinDataRiskFloor()`, and their application in
`computeBuilderScore` (`builderScoringService.ts`). Read-only audit — no code changed.

**Same DB constraint as `builder-baseline.md` applies here**: no `DATABASE_URL` in this session, no
route to production Postgres. I could not run `analyzeClosenessFloors.ts` or query
`parlay_leg_outcomes` myself. Everything below is either directly readable from the source
(the floor functions themselves, and what they do or don't write to the DB) or quoted from the
existing script/comments with an explicit note that I did not re-run it.

---

## 1. The floor mechanism, as it exists in code today

Two independent floors, both applied to `riskScore`, in this order (`builderScoringService.ts:1737-1849`):

```
preClosenessRisk  = clamp(risk, 0, 100)                          // heuristic risk score (win rate, market, rest days, etc.)
closenessScore    = avg of up to 4 independent "how close is this matchup" signals   // 0-100, 50=neutral if no signals
riskFloor         = closenessRiskFloor(closenessScore)
postClosenessRisk = max(preClosenessRisk, riskFloor)              // <- THE FLOOR: can only raise risk, never lower it
thinDataFloor      = thinDataRiskFloor(min(sel.total, opp.total))
riskScore (final) = thinDataFloorFired ? thinDataFloor : postClosenessRisk
```

`closenessRiskFloor()` (the function actually running today, `builderScoringService.ts:327-331`):

```ts
function closenessRiskFloor(cs: number): number {
  if (cs <= 50) return 0;
  if (cs <= 80) return Math.round(((cs - 50) / 30) * 40);   // 50→0 … 80→40
  return Math.round(40 + ((cs - 80) / 20) * 15);             // 80→40 … 100→55
}
```

This is a **smooth ramp**: 0 at cs≤50, rising linearly to 40 at cs=80, then rising more slowly to a
ceiling of 55 that is only reached at cs=100 exactly. At cs=80 the floor is 40, not 55.

## 2. Finding: the validation comment sitting directly above this code validates a *different, older* function — a hard two-step cliff, not the ramp

`builderScoringService.ts:1772-1796`, immediately preceding the closeness-floor application code,
reads:

```
// Threshold constants validated 2026-07-31 against 1,500 graded backfill legs (2022–2026).
// See src/scripts/analyzeClosenessFloors.ts for the full reproducible analysis.
//
//   Reconstructed closeness band │  n   │ accuracy │ verdict
//   ─────────────────────────────┼──────┼──────────┼────────────────────────────────
//   ≥ 80  (very close / c-flip)  │ 1404 │  52.9 %  │ riskFloor=55 ✓ (genuine coin-flip)
//   65–79 (close)                │   44 │  56.8 %  │ riskFloor=40 ✓ (above coin-flip)
//   50–64 (moderate separation)  │   47 │  57.4 %  │ no floor     ✓
//   < 50  (clearly separated)    │    5 │  80.0 %  │ no floor     ✓
```

That table describes a **hard two-step cliff**: floor jumps straight to 55 at cs≥80, and straight to
40 at cs≥65 — exactly the design the earlier comment block in the same file
(`builderScoringService.ts:321-326`, "Closeness risk floor — smooth ramp **replacing** the old
two-step cliff") says was replaced. The two comment blocks contradict each other, and the code that
actually runs is the ramp, not the cliff the n=1,500 validation table describes.

Concretely: a row with cs=80 today gets `riskFloor=40`, not `riskFloor=55` as the validation
table's own verdict column claims for that band. The 52.9%-accuracy, n=1,404 finding cited to
justify "riskFloor=55" for the ≥80 band was measured against a formula that no longer exists in
this file. **The smooth-ramp formula currently in production has never been validated against real
graded rows in this repository** — the n=1,500/2022-2026 validation on file is for the predecessor
function, not the current one. This is precisely the "closure doc that preceded the code it claimed
to verify" pattern called out as a known failure mode for this repo, just found inside a code
comment rather than a standalone doc.

`src/scripts/analyzeClosenessFloors.ts` (the script the comment cites) reinforces this: its own
file-header comment (lines 25-35) documents the same hard-cliff table (`riskFloor = 40` / `riskFloor
= 55`), and its bucket logic (`analyzeClosenessFloors.ts:146-152`) labels rows `floor55Applied` /
`floor40Applied` using those hard thresholds, not the ramp. Even if I could run it today (I
cannot — no DB), **its own logic would mis-describe what the current `closenessRiskFloor()`
actually computes.** It needs to be rewritten before it validates anything about the live code.

## 3. Finding: pre-floor risk is never persisted — you cannot reconstruct "how often the floor swallowed a real signal" from stored rows at all

`ensureEvaluationSchema.ts`'s `parlay_leg_outcomes` DDL (`ensureEvaluationSchema.ts:521-553`) stores
exactly one risk-related column: `risk_score INTEGER NOT NULL` — the **final** value, after both the
closeness floor and the thin-data floor have already been applied
(`riskScore` at `builderScoringService.ts:1849`). Neither `preClosenessRisk`
nor `postClosenessRisk` (the two intermediate values computed at lines 1770 and 1834) is written
anywhere. `matchup_closeness` (the `closenessScore` input to the floor) is stored, added later via
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS matchup_closeness INTEGER` — so it's nullable and absent on
rows written before that column existed — but the raw pre-floor risk number the floor is supposed to
override is gone the moment the row lands in the database.

This means the audit task's request — "pre-floor vs post-floor pairs from real rows" — **cannot be
answered from stored data, at any n, with any DB access.** `analyzeClosenessFloors.ts` works around
this by inferring `floor55Applied`/`floor40Applied` from `risk_score < <hard-cliff-threshold>` given
`matchup_closeness`, which conflates two different failures:

- it cannot distinguish "the floor fired and raised risk" from "the floor didn't need to fire because
  `preClosenessRisk` was already above the floor" — both produce `postClosenessRisk >= floor`, and
  without `preClosenessRisk` stored there is no way to tell which happened;
- it uses the wrong (superseded) floor thresholds regardless, per Finding 2 above;
- for rows predating the `matchup_closeness` column it falls back to reconstructing closeness from
  the `overallAdvantage`/`surfaceAdvantage` **factor score details** stored in the `factor_scores`
  JSONB blob, via regex extraction (`analyzeClosenessFloors.ts:96-98` and the min-match-count
  extraction at `197-217`, which explicitly gives up and counts a row `unclassified` when its regex
  doesn't match the stored detail-string format) — a fragile proxy, not the real signal, and the
  script's own summary print treats "unclassified" rows as silently excluded rather than flagged.

## 4. What "how often the floor swallows a real risk signal" would actually require

Since `preClosenessRisk` isn't stored, answering this cleanly requires one of:

1. **Instrument the code** to also persist `preClosenessRisk` and `postClosenessRisk` (two new
   columns or a JSONB debug field) going forward, then wait for enough freshly-backfilled/live rows
   to accumulate before this can be measured — not retroactively fixable for existing rows.
2. **Recompute from scratch**: re-run every existing leg's full `computeBuilderScore` pipeline
   against the historical match data at its original `asOfDate` (the backfill script already knows
   how to do this — `adminParlay.ts:961-967` calls `computeBuilderScore` with `asOfDate` per row) and
   capture the intermediate values this time. This is possible in principle — the raw
   `historical_matches` data these figures are derived from is still there — but requires DB access
   and a script change (not existing today) to expose the two intermediate risk values, then a full
   re-backfill run.

Neither is a Phase-0 (read-only) deliverable. I am reporting what's missing rather than
approximating it, per the standing instruction that "insufficient evidence" is a valid output.

## 5. What IS defensible from the current evidence, stated carefully

- The general *shape* of the design — a closeness signal used as a `max()` floor rather than an
  additive adjustment, so a favorable-looking heuristic risk score can't override a genuinely close
  matchup — is sound reasoning and matches a real bug that was found and documented
  (`builderScoringService.ts:1774`, the K. Day vs. M. Hontama WTA 125 Vancouver case, July 2026).
  That bug report is a specific, falsifiable incident, not a vague justification, and I have no
  reason to doubt it happened.
- The *thin-data* floor (`thinDataRiskFloor`, keyed on match count, not closeness) is a different
  mechanism from the closeness floor and is not affected by Finding 2 — its constants (n≤2→45, n=3→30,
  n=4→15, n≥5→0) are the same in both the current code (`builderScoringService.ts:348-353`) and the
  validation script/comment (`builderScoringService.ts:300-318`, `analyzeClosenessFloors.ts:219-223`).
  I did not find a formula mismatch for this one — only the closeness floor has the stale-validation
  problem.
- But: whether the *current, running* closeness-floor ramp constants (0→40 over cs 50-80, 40→55 over
  cs 80-100) are well-calibrated against real outcomes is **an open question this audit cannot close**
  — the only validation on file is for a formula that no longer runs.

## 6. Recommendation for Phase 1 scoping (not decided here)

Before any weight/formula changes to the closeness floor: (a) correct or remove the stale
`builderScoringService.ts:1772-1796` comment block so it stops asserting a validation that doesn't
apply to the running code — this is a report-only, no-scoring-change fix in the spirit of Phase 1(a);
(b) add persistence for `preClosenessRisk`/`postClosenessRisk` so future rows support a real
pre/post analysis; (c) rewrite `analyzeClosenessFloors.ts` to test the actual ramp formula, not the
retired cliff, once (b) has accumulated enough rows.
