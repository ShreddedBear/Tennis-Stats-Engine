# OCR / Screenshot Import Reliability Report

**P0 Package 3 — OCR / Screenshot Import Audit**
Scope: Upload → extraction → segmentation → OCR → parsing → validation → normalization →
Prediction Engine, plus Parlay Builder OCR.

Repo: `Tennis-Stats-Engine` (all screenshot-import code lives here; the sibling
`tennis-truth-engine-8ecc1270` repo has no OCR/screenshot pipeline and required no changes).

Method: full read of every file in scope, three parallel deep-dive audits (recognition layer,
resolver layer, batch/UI layer) cross-checked against the source, and executable mock/local
tests exercising the pure-logic modules (no live provider keys, no DB, no real screenshots —
per the "test with local/mock data first" instruction). New regression tests are committed
alongside this report; a 150-item batch-concurrency simulation was run standalone (see
"Batch behavior" below).

---

## Executive summary — why visually similar screenshots succeed or fail inconsistently

There is no single cause. Four independent failure mechanisms combine, and which one fires
depends on which OCR path handles a given image and which two players are on it:

1. **The OCR.Space text-fallback parser silently drops real player names** whose name starts
   with a month abbreviation (`Jan`, `Mar`, `May`, `Jun`, `Aug`, `Oct`, `Dec`, …) — including the
   men's world No. 1, Jannik **Sinner**. This only affects the fallback path (used when every
   vision-AI provider is down/quota-exhausted), which is exactly why the *same* matchup can
   succeed one day (vision AI healthy) and silently mis-pair or drop a player the next (fallback
   engaged).
2. **The vision-AI JSON path has no plausibility validation** on extracted names beyond an
   incomplete sportsbook-junk blocklist, so garbled OCR or UI chrome can be accepted as a
   "successful" matchup with no error and no warning.
3. **Error classification between "provider is down" and "this image/request is bad" is fragile
   in three separate places** (screenshotRecognition's status-code checks, the log-scraping
   regex in `applyHealthFromDebugLog`, and the client's message-substring sniffing), so a quota
   outage can be mis-suppressed as a 5-minute transient blip, or a genuinely permanent error can
   be filed as "quota_exhausted" and suppressed for an hour for the wrong reason.
4. **Nothing in the pipeline de-duplicates a resolved matchup**, and one high-volume batch UI
   (`BulkMatchupPredictor`) **loses already-successful rows when you retry the failed ones**,
   which is the direct mechanism behind "processed successfully once, then appears to lose
   results on a retry."

None of these are provider flakiness — they are deterministic code paths. The same screenshot,
run twice through the same code path, produces the same (right or wrong) result every time; the
*appearance* of nondeterminism comes from which provider happens to answer that request (vision
AI vs. OCR.Space fallback) and which of the two player names happens to collide with a bug.

---

## Failure categories, root causes, and affected files

### 1. Player names silently dropped by the raw-text fallback parser — **HIGH**

**File/function:** `artifacts/api-server/src/services/screenshotImport/rawTextParser.ts`,
`SKIP_PATTERNS` (lines 21–41), used by `isNameLike()` (line 43) inside `parseOcrText()`
(strategy 2, lines 84–92).

**Root cause:** The month-abbreviation filter `/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i`
has no word boundary — it matches as a **prefix**, not a whole word. It is meant to reject OCR'd
date lines like "Jan 26" but instead rejects any line that merely *starts with* those three
letters.

**Reproduced and confirmed** with real, current top-ranked players:

| Player | False positive? |
|---|---|
| Jannik Sinner (ATP #1) | ✅ dropped |
| Maria Sakkari (WTA top-10 at various points) | ✅ dropped |
| Marta Kostyuk | ✅ dropped |
| Marcos Giron | ✅ dropped |
| Marton Fucsovics | ✅ dropped |
| Janice Tjen | ✅ dropped |

**Effect:** This path only runs when OCR.Space (the free text-extraction fallback) is used —
i.e., exactly when all vision-AI providers are unavailable, the highest-value moment for the
pipeline to *not* fail. When one of the two names in a "consecutive name lines" pair is dropped,
`nameLines` shifts and the pairing algorithm either produces zero matchups or pairs the
*surviving* name with an unrelated adjacent line (e.g., a different match's player), producing a
wrong-but-plausible-looking matchup with no warning.

**Recommended fix:** anchor the regex to a full month name/abbreviation followed by a digit or
end-of-string, e.g. `/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s*\d/i`, or require
the whole trimmed line to be date-shaped (`/^(mon|tue|...)?\s*(jan|feb|...)\.?\s*\d{1,2}(,?\s*\d{2,4})?$/i`).
A committed, currently-`skip`'d regression test
(`rawTextParser.test.ts` — "player names starting with a month abbreviation are NOT dropped")
reproduces this exactly and should be un-skipped once fixed.

---

### 2. No plausibility validation on vision-AI extracted names — **HIGH**

**File/function:** `artifacts/api-server/src/services/tennisData/screenshotRecognition.ts`,
`cleanEntry`/junk-filtering around lines 208–261.

**Root cause:** Two related gaps:
- The code comment (lines 208–210) claims junk-term matching is "equals OR starts with," but the
  implementation only does an exact `Set.has()` plus two narrow regexes. A multi-word UI label
  that *starts* with a blocklisted single word ("PARLAY 3 TEAMS", "CONTINUE BUTTON", "VIEW ALL
  PICKS") is not caught and can pass through as a "player name."
- There is no minimum-length check, no letters-present check, and no rejection of garbled
  single-character/digit-only fragments beyond what the blocklist happens to catch. A vision-AI
  response can return `matchups.length > 0` with no thrown error even when the underlying text
  was noise.
- Tour-label junk terms the system prompt tells the model to exclude (`ATP250`, `WTA`, `ITF`,
  `MASTERS`, `SLAM` — prompt line ~63) have **no matching code-side entry** in
  `SPORTSBOOK_JUNK_TERMS` (lines 212–229) — enforcement is prompt-only, with no fallback if the
  model doesn't comply.

**Effect:** malformed OCR can silently become a "successful," confidently-returned matchup
instead of a `not-found`/`unreadable` result — the single most direct mechanism for "OCR doesn't
silently turn failures into bad matches" being violated.

**Recommended fix:** add a code-side plausibility gate before accepting any `player1Name`/
`player2Name`: reject if either candidate name has no letters, is <3 or >60 chars, matches any
junk term as a **prefix** (not just exact-match), or if `player1Name === player2Name`. Add the
missing tour-label terms to `SPORTSBOOK_JUNK_TERMS` as a code-side backstop to the prompt.

---

### 3. Provider failure classification is fragile in three independent places — **MEDIUM–HIGH**

**3a. Log-scraping regex conflates unrelated permanent errors into "quota_exhausted"**
File/function: `ScreenshotImportService.ts`, `applyHealthFromDebugLog()` (lines 78–104).
The classifier only distinguishes "quota" (string `"quota"` in the log line) vs. "auth"/"key"
(strings `"auth"`/`"key"`); **any other permanent error falls into the `quota_exhausted` bucket
by default** (line 97). Reproduced with synthetic log lines: `"[SKIP] Anthropic: permanent error
(unsupported image mime type)"` and `"[SKIP] Replit: permanent error (model has been retired)"`
both get recorded as `quota_exhausted`, silently suppressing that provider for a full hour for a
reason that has nothing to do with quota and will never resolve itself by waiting.

**3b. "non-retryable" errors are recorded as *transient* and retried anyway**
Same function, lines 100–102: a line the recognizer explicitly labeled `non-retryable` (implying
retrying is futile) is passed to `recordTransientFailure()`, which only suppresses for 5 minutes
before retrying. This directly contradicts the label's own semantics.

**3c. Upstream error-shape checks are incomplete**
File/function: `screenshotRecognition.ts`:
- `isPermanentProviderError` (lines 489–497) checks OpenAI-SDK-specific `.code` values
  (`insufficient_quota`, `invalid_api_key`) and HTTP 401/403. **Anthropic credit exhaustion
  typically returns HTTP 400 `invalid_request_error`**, which matches neither this check nor the
  retry check below — it falls through to "non-retryable" (see 3b: recorded as transient), so a
  dead Anthropic key is retried indefinitely every 5 minutes instead of being suppressed for an
  hour with the correct `auth_failed`/`quota_exhausted` status.
- `isRateLimitError` (lines 499–504) only checks `status === 429` or `status >= 500`. **A network
  timeout, `AbortError`, or DNS failure has no `.status` field**, so `(e?.status ?? 0) >= 500`
  evaluates to `false` — a purely transient network blip is misclassified as non-retryable and
  the provider is abandoned after one attempt instead of retried with backoff.
- Gemini's model-chain exhaustion (lines 450–454) stamps `code = "quota_exhausted"` from
  whichever model failed *last* in the chain, even if that last failure was actually a 404
  "model not found," causing an incorrect 1-hour Gemini suppression.

**Effect on the audit's specific verification target — "provider quota failures aren't mistaken
for parser failures":** partially true (genuine 429/401/403 with the expected error shape *are*
classified correctly, verified in tests below) but **not true in general** — several realistic
permanent- and transient-error shapes are misclassified in both directions.

**Recommended fix:** replace the free-text log-scraping in `applyHealthFromDebugLog` with a
typed result object returned from `recognizeMatchupScreenshot` (provider label + classified
reason as an enum), rather than parsing debug strings with regex. Add an explicit "no `.status`
= network error = retryable" branch to `isRateLimitError`. Add an Anthropic-specific check
(`error.type === "invalid_request_error"` combined with a credit/billing message substring, or
the SDK's typed error class) to `isPermanentProviderError`.

---

### 4. No duplicate-matchup detection anywhere in the pipeline — **HIGH**

**File/function:** `screenshotMatchupResolver.ts` (whole file) and `ScreenshotImportService.ts`
(whole file) — confirmed by grep, no dedup logic exists at the matchup level. The only existing
dedup is `imageHashCache.ts`'s exact-byte MD5 cache (1-hour TTL, 200-entry LRU), which only
catches literally-identical image bytes — a second screenshot of the same match (different crop,
compression, or timestamp) hashes differently and is treated as brand new.

**Effect:** the same match appearing twice in a batch (re-uploaded screenshot, or listed twice
in a bracket image) produces two independent, unlinked resolved entries and, if both proceed to
Predict, two separate prediction/ledger records with no warning.

**Recommended fix:** add a resolved-matchup dedup key (normalized `player1Id`+`player2Id`
order-independent, plus tournament/date if available) at the `ScreenshotImportService` or batch
level, checked against both the current batch and (for the single-upload path) a short-lived
recent-resolutions cache.

---

### 5. Player-name matching can silently resolve to the wrong player — **HIGH**

**File/function:** `screenshotMatchupResolver.ts`, `wordsMatch()` (lines 519–533) and
`resolvePlayerMatch()` (lines 811–819).

**Root cause (a):** `wordsMatch` allows a **1-character substitution for any two same-length
words ≥4 characters**, and this runs inside the "confident" auto-resolve path (no warning
surfaced), not just the disclosed `best-guess` fuzzy fallback. Two distinct real players with
same-length surnames differing by one letter risk being treated as interchangeable if only one
appears in a given provider search result set.

**Root cause (b):** a single confident candidate always auto-resolves (line 817–819), including
for single-initial OCR reads like "G. Castro," bypassing the weak-identity ambiguity guard. If
the underlying provider search happens to return exactly one "G. X"-matching candidate (e.g. due
to pagination/index limits), it silently resolves with zero disambiguation warning even though a
single-initial key is inherently weak evidence.

**Root cause (c) — hyphenated-surname truncation-equivalent bug:** `normalizeName()` (line 159)
strips all non-alphanumeric characters, **including hyphens, without substituting a space**:
`"Auger-Aliassime"` → `"augeraliassime"` (one token), while a DB record stored with a space
(`"Auger Aliassime"`) normalizes to two tokens. Since matching is token-by-token, this breaks
bijective matching for any hyphenated surname where OCR and DB formatting disagree — a real,
common pattern (Auger-Aliassime is a top-20 ATP player).

**Recommended fix:** (a) restrict the 1-char-substitution tolerance in `wordsMatch` to the
`best-guess` fuzzy path only, never the silent "confident" auto-resolve path. (b) require
single-initial confident-resolution to also check that the search returned a reasonably complete
candidate set (or surface a low-confidence warning even when `confident.length === 1`). (c) in
`normalizeName`, replace hyphens with a space before stripping punctuation:
`.replace(/[-–—]/g, " ")` prior to the punctuation-strip line.

---

### 6. Vision-AI output-token cap can silently drop trailing matchups on long screenshots — **MEDIUM**

**File/function:** `screenshotRecognition.ts` — `max_completion_tokens: 2000` (OpenAI, ~line
330), `maxOutputTokens: 2000` (Gemini, ~line 378), `max_tokens: 2000` (Anthropic, ~line 461),
with brace-balance JSON recovery at lines 288–319.

**Root cause:** a long, scrollable screenshot with many stacked match cards (explicitly a target
scenario in this audit) can produce a JSON response that exceeds the 2000-token budget mid-array.
The brace-balance recovery salvages whichever matchup objects completed before the cutoff, but
matchups cut off after the limit are **dropped with only a `logger.warn`** (line 314) — no
warning is surfaced to `ImportScreenshotResult.warnings`, so the user sees a smaller-than-expected
result set with no indication that data was truncated.

**Recommended fix:** raise the token cap for this specific call, and/or detect a
non-`stop`/truncated finish reason and append a warning ("results may be incomplete — this
screenshot may contain more matchups than were extracted") to the returned `warnings[]`.

---

### 7. No PDF support anywhere in the pipeline — **INFORMATIONAL / CAPABILITY GAP**

Confirmed by exhaustive case-insensitive grep for `pdf` across the entire `api-server` and
`tennis-predictor` trees: **zero matches**. No PDF parsing library is a dependency of either
package. `ScreenshotMatchupUpload.tsx` (line ~129) restricts the file input to
`accept="image/png,image/jpeg,image/webp"` only.

This means the audit's "text PDFs" and "scanned PDFs" local/mock test categories are **not
applicable as separate code paths** — there is no PDF branch to test, because none exists. If
PDF upload support is actually expected by users of this feature (the task brief names it
explicitly), it is a missing feature, not a reliability bug: it needs new code (PDF→image/text
extraction, page segmentation) rather than a fix to existing logic. Flagging this distinction
because it changes the remediation from "bug fix" to "net-new feature," and no page-segmentation
logic exists to audit for per-page failure isolation, since pages/PDFs never enter the pipeline.

---

### 8. `BulkMatchupPredictor` retry-failed flow can silently discard already-successful results — **HIGH (data loss)**

**File/function:** `artifacts/tennis-predictor/src/components/BulkMatchupPredictor.tsx`,
`handleFiles()` (lines 413–426).

**Root cause:** `handleFiles` unconditionally does `setItems(initialItems)` — a full
**replacement**, not an append — every time it runs, and it is the only entry point for adding
files (including re-selecting files to retry). There is a working `handleRetryFailed` (lines
805–816), but it **only retries prediction-stage failures**, not OCR-stage failures
(`status === "read-error"`/`"unresolved"`); the only UI action on an OCR-failed row is delete.
If a user tries to "retry the failed screenshots" by re-selecting just those files through the
file picker, `handleFiles` wipes every already-resolved and already-predicted row from the batch
unless the *entire* original file set is re-selected together.

**Contrast:** `AdminParlayBuilder.tsx` (lines 1744–1761) does the equivalent operation correctly
via `setLegs(prev => [...prev, ...initialLegs])` (append) — this is an inconsistency between the
two batch UIs, not an inherent constraint.

**Recommended fix:** change `BulkMatchupPredictor.handleFiles` to append to `items` instead of
replacing, and add a per-row OCR retry action (re-run just that one item through
`recognizeMatchupScreenshot`) alongside the existing delete button, mirroring
`ScreenshotMatchupUpload.tsx`'s working single-image `handleRetry`.

---

### 9. Provider-outage vs. "couldn't read this image" not visually distinguished in the batch UI — **MEDIUM**

**File/function:** `ScreenshotImportService.importScreenshot()` returns HTTP 200 (not an
exception) with `diagnostics.ocrProvider === "all_failed"` when every OCR provider is
unavailable (`ScreenshotImportService.ts` lines 209–231). `BulkMatchupPredictor.tsx`'s catch
block (lines 505–522) has quota/auth-specific message classification (`isQuota`, `isAuth`), but
that classification is effectively **dead code for this exact scenario**, because the "all
providers exhausted" condition never throws — it returns normally and lands in the
`status: "unresolved"` branch (line 474) using `result.warnings[0]` verbatim instead. Both a
provider outage and a genuine "no matchup found" case render as the same "SKIPPED"-style badge
(`ItemStatusBadge`), differing only in the small warning text underneath — there's no distinct
icon/CTA steering the user toward the correct remedy (wait and retry vs. upload a clearer image).

**Recommended fix:** thread `diagnostics.ocrProvider === "all_failed"` (or a boolean derived
from it) through to a distinct `BatchItem` status (e.g. `"provider-unavailable"`) with its own
badge and a "retry" CTA rather than "remove," instead of relying on warning-text sniffing.

---

## Batch behavior (100–150 item workload)

**No batch endpoint exists server-side** — `routes/matchups.ts` exposes only a single-image
`POST /api/matchups/from-screenshot`. All batching is client-side, calling that single-image
endpoint once per file through a bounded worker pool:

- `BulkMatchupPredictor.tsx`: `RESOLVE_CONCURRENCY = 12`, `MAX_FILES = 150`.
- `AdminParlayBuilder.tsx`: `RESOLVE_CONCURRENCY = 4`, `MAX_FILES = 150`.

Both use the same `runWithConcurrency()` pattern — a recursive self-refilling worker pool over a
shared `nextIndex` counter, not `Promise.all` over all 150 items at once. This is genuinely
bounded, not unbounded parallelism.

**Verification performed:** I extracted this exact `runWithConcurrency` implementation and ran
it standalone against a synthetic 150-item workload with injected failure types matching this
report's failure categories (transient 5xx, quota-exhausted, malformed/0-matchup OCR, an
uncaught resolver exception, and a status-less network timeout), each wrapped in the same
per-item try/catch pattern used in `handleFiles`:

```
Total items: 150
Max concurrent in-flight OCR calls observed: 12 (limit=12)
All items reached a terminal state: true
Outcome breakdown: { 'resolved-call-ok': 142, 'read-error': 8 }
resolver_throw items (8) all isolated as read-error, batch did not abort: true
Successful items preserved despite interleaved failures: 142/142
OVERALL: PASS — bounded concurrency, no dropped items, failures isolated
```

This confirms, for the `runWithConcurrency`/per-item-try-catch pattern itself: concurrency stays
capped at the configured limit (no unbounded fan-out, no simultaneous-rate-limit self-inflicted
storm), no item is silently dropped, and one item throwing does not abort sibling items already
in flight or not-yet-started. This is a **strength**, not a bug — but it is undermined at the
application layer by Finding 8 above (the retry-driven full-replace data loss), which can still
discard a completed 150-item batch's results even though the concurrency mechanics themselves are
sound.

**Secondary note on memory:** `imageHashCache`'s 200-entry cap means a single 150-image batch can
consume 75% of the global process-wide cache, evicting other users'/sessions' recently-cached
results. Not a correctness bug, but worth sizing up if batch imports become routine — either raise
`MAX_ENTRIES` or scope the cache per-session.

**Not tested (requires infrastructure unavailable in this environment):** the actual React
components end-to-end (need a browser/DOM + real network), the live vision-AI/OCR.Space providers
(need real API keys and network egress to those services), and the Postgres-backed player/DB
resolution path (`@workspace/db` — no database is provisioned here). The `pnpm install` for this
workspace was not run (large monorepo, would require populating `node_modules` across many
packages); pure-logic modules were instead executed directly via Node's built-in TypeScript
stripping (`node --experimental-strip-types`), which is why the committed tests target only the
dependency-free modules (`rawTextParser`, `imageHashCache`, `providerHealthMonitor`) rather than
the full `ScreenshotImportService` orchestration or resolver DB-lookup paths.

---

## Provider behavior — summary

- **Failover order actually implemented** (`screenshotRecognition.ts` `resolveAllKeys`, lines
  156–173): `SCREENSHOT_AI_KEY` (any provider by prefix) → `ANTHROPIC_API_KEY` → `GEMINI_API_KEY`/
  `GOOGLE_API_KEY` → `AI_INTEGRATIONS_OPENAI_API_KEY` (Replit proxy) → (caller) OCR.Space. This
  **contradicts the doc comments** in both `screenshotRecognition.ts` (lines 9–14, omits Gemini
  entirely) and `ScreenshotImportService.ts` (line 10, claims "OpenAI → Gemini → Anthropic →
  Replit"). Low functional risk (the loop mechanically visits every configured provider either
  way — verified: permanent-error and non-retryable both `break` to the next provider, nothing
  gets stuck), but the stale docs will mislead the next engineer debugging a failover issue.
- **Health-state machine itself is correct** (`providerHealthMonitor.ts`) — verified via the
  committed test suite: quota/auth failures are tracked as `permanentFailures` distinct from
  `transientFailures`; a transient failure never increments `permanentFailures`; success on one
  provider never clears another provider's unrelated failure; admin reset correctly restores
  healthy status. The bugs are entirely in what gets fed into this state machine (Findings 3a–3c),
  not in the state machine itself.
- **Gemini-specific quirks are already documented** in `.agents/memory/gemini-screenshot-provider.md`
  (model-alias quota differences, `AQ.*` key auth, retry-delay-based 429 classification) and
  appear correctly implemented in the current code.

## Retry behavior — summary

- **Within a single `recognizeMatchupScreenshot()` call:** retries are correctly gated to
  429/5xx-shaped errors only (Finding 3c aside for the status-less-error gap); permanent errors
  never retry.
- **At the `ScreenshotImportService` layer:** a resolver-level exception correctly skips caching
  the failed result (see `.agents/memory/screenshot-resolver-circuit-breaker.md` — this was a
  previously-fixed bug; verified still present and correct at `ScreenshotImportService.ts` lines
  244–279 via the `resolutionThrew` flag).
- **At the batch UI layer:** per-item retry is inconsistent — `ScreenshotMatchupUpload.tsx`
  (single upload) has a working retry; `BulkMatchupPredictor.tsx` only retries prediction-stage
  failures and risks data loss on OCR-stage retry (Finding 8); `AdminParlayBuilder.tsx` appends
  correctly but shares the same "no per-item OCR retry" gap.

## Tests performed

All executed locally against the pure-logic modules using synthetic/mock data — no real
screenshots, no live provider keys, no database. Committed as permanent regression coverage
(previously these three files had zero tests):

- `artifacts/api-server/src/services/screenshotImport/rawTextParser.test.ts` — 12 cases: inline
  `vs`/`def.` patterns, consecutive-name-line pairing, malformed/garbage text, missing-field
  (dangling single name), hyphenated surnames, seed-number stripping, identical-name rejection,
  multiple stacked matchups (long-screenshot simulation), sportsbook odds/currency noise
  filtering, and one `skip`-marked reproduction of Finding 1 (month-prefix false positive).
- `artifacts/api-server/src/services/screenshotImport/imageHashCache.test.ts` — 6 cases: hash
  stability across `data:` prefix and declared mime type (duplicate-screenshot detection),
  distinct images hash differently, cache round-trip, and LRU eviction at the 200-entry cap.
- `artifacts/api-server/src/services/screenshotImport/providerHealthMonitor.test.ts` — 7 cases:
  quota vs. auth vs. transient state isolation, cross-provider independence, success-driven
  recovery, and admin reset.
- Standalone (not committed — ad hoc verification, not a code-path this repo owns): the
  `applyHealthFromDebugLog` regex classifier and the `BulkMatchupPredictor` `runWithConcurrency`
  150-item simulation described above, both run via `node --experimental-strip-types`.

Run with: `pnpm --filter @workspace/api-server run test:screenshotImport` (new script added to
`artifacts/api-server/package.json`), or directly via
`node --experimental-strip-types --test <file>` if `tsx` isn't installed.

**Result:** 23 passed, 1 correctly skipped (documents Finding 1 pending a fix), 0 failed.

## Explicitly NOT run

Per instructions, the 100–150 **real** screenshot workload was not run. The local/mock tests
above are the prerequisite gate; several of the findings in this report (3, 5, 6) should be fixed
first, since they affect correctness silently (no crash, no error) and would not be caught by
volume-testing alone — only by a human reviewing individual outputs, or by the plausibility
checks recommended in Findings 2 and 5 once implemented.

## Recommended fix priority

1. Finding 2 (no plausibility validation) and Finding 5a/5c (silent wrong-player match, hyphen
   bug) — these produce *wrong-but-confident* results, the worst failure mode.
2. Finding 1 (month-prefix drop) — trivial regex fix, high real-world hit rate (affects a
   world-No.-1 player).
3. Finding 8 (BulkMatchupPredictor data loss on retry) — straightforward append-not-replace fix.
4. Finding 4 (no dedup) and Finding 3a/3b/3c (classification fragility) — moderate effort, clear
   scope.
5. Finding 6 (token-cap silent truncation) and Finding 9 (UI differentiation) — polish/UX.
6. Finding 7 (PDF support) — scope as a separate feature request, not a bug fix.
