# Rejection Power — Can the Builder Actually Stop a Leg the Prediction Engine Likes? (Phase 0)

**Scope:** every code path between `computeBuilderScore` returning `decision: "REMOVE"` and any
consumer of that result. Read-only audit — no code changed.

## Short answer

**No.** I traced every consumer of a Builder `decision` value in both the backend routes and the
admin frontend. `REMOVE` is computed, persisted, and displayed — full stop. Nothing in the
codebase reads `decision === "REMOVE"` and uses it to prevent a leg from being added to, kept in,
saved as part of, or submitted within a parlay. This is the P0 finding the brief predicted: the
engine, as wired today, is decorative in the specific sense of "advisory-only, with zero
enforcement," and I did not find a code path where that isn't true.

## What I checked

### 1. The independence of the decision itself — genuinely real

Before showing rejection has no teeth, it's worth confirming the *decision* itself is honestly
independent — otherwise "can it reject a PE-liked leg" would be moot for a different reason.
`builderScoringService.ts`'s header comment (line 4-7) states the service "NEVER reads from the
predictions table, NEVER uses calibratedProbability, safetyScore, or any Prediction Engine output,"
and I did not find a violation of this while reading the full `computeBuilderScore` function
(`builderScoringService.ts:1025-2037`) — every input is either the caller-supplied `BuilderSnapshot`
or `historical_matches`/live-provider data. So the Builder genuinely *can* land on REMOVE for a leg
the Prediction Engine would score highly, since it never sees the Prediction Engine's score. The
question is what happens next.

### 2. `POST /admin/parlay/validate` — the live decision endpoint

`adminParlay.ts:399-562`. This is the only live entry point to `computeBuilderScore`. It:

- computes `results` for every submitted leg (line 411-445),
- computes summary counts `keepCount`/`borderlineCount`/`removeCount` (line 447-449),
- writes every leg — REMOVE included — to `parlay_leg_outcomes` (line 473-510) and
  `builder_decision_log` (line 528-553),
- returns `{ legs: results, summary }` to the caller (line 555-558).

**It never filters, drops, or blocks a leg based on `decision`.** A REMOVE leg is returned to the
client exactly like a KEEP leg, just with a different `decision` string in the payload. Nothing in
this handler prevents the response from being used to build a parlay containing the REMOVE leg.

### 3. The frontend — advisory display only, confirmed by absence of any blocking code

`AdminParlayBuilder.tsx` renders `decision` as a color (`border-success` for KEEP,
`border-destructive` for REMOVE, `border-warning` for BORDERLINE — lines 631, 796-798) and supports
filtering the *displayed* list by decision (`slipView`, line 1989). I searched specifically for any
mechanism that would turn REMOVE into an actual block:

- `grep`'d for `disabled` near decision checks: the only `disabled` props in the file gate loading
  spinners and pagination buttons (`disabled={loading}`, `disabled={triggering...}`,
  `disabled={offset === 0 || loading}`, etc.) — none of them are conditioned on
  `decision === "REMOVE"`.
- `grep`'d for `confirm(`, `window.confirm`, or any "block"/"prevent" pattern near REMOVE handling:
  **zero matches.** There is no confirmation dialog, no warning modal, no submit-time guard.
- The one place REMOVE *does* actively do something is `autoSelected` (line 2284), which
  auto-**checks** only `decision === "KEEP"` legs as a convenience default — but this is an opt-in
  UI shortcut the user can freely override by manually checking a REMOVE leg; it is not an
  enforcement mechanism, and the code makes no attempt to stop a REMOVE leg from being checked.
- `parlay_saved_legs` (bookmarking, `adminParlay.ts:1134-1171`) and `parlay_active_session`
  (`adminParlay.ts:1186-1214`) both accept an arbitrary JSON payload with no server-side validation
  of `decision` at all — a REMOVE leg can be saved or persisted as the active session exactly like
  any other.

### 4. The other "safety" path (`/admin/parlay/evaluate`) — same shape, also advisory, and not even this engine

Worth naming explicitly since it's easy to conflate: `POST /admin/parlay/evaluate`
(`adminParlay.ts:178-391`, `computeSafetyScore`/`getDecision`) is the **legacy path that reads
Prediction Engine stored signals directly** (`predictions`/`evaluation_predictions` tables,
`calibratedProbability`, `dataQuality`, etc. — see the file's own header comment, line 4-9,
explicitly distinguishing it from `/validate`). It produces its own `Approved`/`Caution`/`Remove`
labels via `getDecision()` (line 159-163), sorted worst-first (line 361-363) — but this is a
Prediction-Engine-derived safety filter, not the independent Validation Engine this audit is about,
and it has the exact same property: `getDecision`'s output is returned in the response and never
used to strip a leg. I'm noting it only so it isn't mistaken for evidence that *some* rejection
mechanism exists somewhere in the parlay flow — it doesn't, in either path.

### 5. `/admin/parlay/backtest` — measures what enforcement *would* do, proving today it does nothing

`adminParlay.ts:595-674` computes `lossCaptureRate`/`falseRemovalRate`/`survivalImprovement` — i.e.
it retroactively simulates "what if we had filtered out Remove-decision legs" on already-settled
`evaluation_predictions` rows. The existence of this simulation is itself evidence for the finding:
it's a backtest of a filter that isn't applied anywhere live. If REMOVE already blocked leg
inclusion, this endpoint would be measuring a no-op. It measures a real hypothetical, which means
the enforcement doesn't exist yet in the live path it's modeled on either.

## Why this matters beyond "it's a UI gap"

The brief's framing is right: if REMOVE never blocks anything, the entire scoring pipeline — factor
weights, closeness floor, thin-data floor, calibration — is computing a label that a user can freely
ignore with zero friction, and the codebase provides no evidence anyone consuming this engine's
output today has agreed to be blocked by it. Whatever value the KEEP/BORDERLINE/REMOVE distinction
has (and `builder-baseline.md` covers how well-measured that value actually is) currently reaches
the user only as a suggestion with a red border. That is a legitimate design choice for a *v1*
advisory tool, but it directly contradicts calling this a "validation" or "rejection" capability
without qualification, and it means Phase 1(b)'s "make rejection possible if it isn't" has a clear,
unambiguous starting state: it isn't, anywhere, and needs to be built from zero rather than fixed.

## What Phase 1(b) would need to decide (not decided here)

Not a recommendation, just naming the open questions this audit surfaces for the approved-plan
discussion: (a) should rejection be a hard block (leg cannot be added/submitted) or a friction gate
(explicit override required, logged); (b) does it apply per-leg or does one REMOVE leg affect
`getSlipFragility`'s "Extreme" outcome (`adminParlay.ts:170`, which today only *labels* fragility,
also without blocking); (c) should `/admin/parlay/evaluate`'s legacy `Remove` get the same treatment,
given it's Prediction-Engine-derived and a different signal from this engine's own REMOVE. All three
require a product decision this audit doesn't make.
