import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isProviderSkippable,
  recordSuccess,
  recordPermanentFailure,
  recordTransientFailure,
  getAllProviderHealth,
  resetProviderHealth,
} from "./providerHealthMonitor";

/**
 * OCR reliability audit (P0 Package 3) — regression coverage for the provider health state
 * machine, which previously had zero tests. Verifies that quota/auth (permanent) failures are
 * tracked distinctly from rate-limit/timeout (transient) failures, so a provider quota outage
 * is never mistaken for — or auto-retried like — a transient blip. See OCR_RELIABILITY_REPORT.md.
 */

test("isProviderSkippable: an unknown/never-tried provider is not skippable", () => {
  assert.equal(isProviderSkippable("NeverSeenProvider"), false);
});

test("recordPermanentFailure(quota_exhausted): marks the provider skippable and distinct from transient", () => {
  recordPermanentFailure("TestOpenAI", "quota_exhausted");
  assert.equal(isProviderSkippable("TestOpenAI"), true);
  const h = getAllProviderHealth().find((p) => p.label === "TestOpenAI");
  assert.equal(h?.status, "quota_exhausted");
  assert.equal(h?.permanentFailures, 1);
});

test("recordPermanentFailure(auth_failed): marks the provider skippable until restart", () => {
  recordPermanentFailure("TestGemini", "auth_failed");
  assert.equal(isProviderSkippable("TestGemini"), true);
  const h = getAllProviderHealth().find((p) => p.label === "TestGemini");
  assert.equal(h?.status, "auth_failed");
});

test("recordTransientFailure: rate-limit/timeout failures are NOT counted as permanent failures", () => {
  recordTransientFailure("TestAnthropic");
  const h = getAllProviderHealth().find((p) => p.label === "TestAnthropic");
  assert.equal(h?.status, "rate_limited");
  assert.equal(h?.permanentFailures, 0, "a transient failure must never increment permanentFailures");
  assert.equal(h?.transientFailures, 1);
  assert.equal(isProviderSkippable("TestAnthropic"), true, "suppressed within the 5-minute rate-limit window");
});

test("recordSuccess: clears transient failures and restores healthy status (recovery path)", () => {
  recordTransientFailure("TestRecovery");
  recordSuccess("TestRecovery");
  const h = getAllProviderHealth().find((p) => p.label === "TestRecovery");
  assert.equal(h?.status, "healthy");
  assert.equal(h?.transientFailures, 0);
  assert.equal(isProviderSkippable("TestRecovery"), false);
});

test("a success on one provider does not clear another provider's independent quota failure", () => {
  recordPermanentFailure("TestIsolationA", "quota_exhausted");
  recordSuccess("TestIsolationB");
  assert.equal(isProviderSkippable("TestIsolationA"), true, "unrelated provider's success must not affect this one");
});

test("resetProviderHealth: admin reset clears a quota/auth mark back to healthy", () => {
  recordPermanentFailure("TestReset", "quota_exhausted");
  assert.equal(isProviderSkippable("TestReset"), true);
  resetProviderHealth("TestReset");
  assert.equal(isProviderSkippable("TestReset"), false);
});
