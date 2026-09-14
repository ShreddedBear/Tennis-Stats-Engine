// ----------------------------------------------------------------------------
// Point-by-point retrieval classification.
//
// The distinction these tests defend is the one the whole evidence layer rests on: whether
// the provider was ASKED AND HAD NOTHING, or was never successfully asked at all. Those are
// different facts about the world, and collapsing them lets an unconfigured credential or a
// slow network be recorded as evidence of absence -- a metric confidently reporting "no
// data exists" about a question nobody put to the provider.
// ----------------------------------------------------------------------------
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  describeTally, emptyTally, fetchPbpClassified, pbpRequestTimeoutMs, recordOutcome,
  sourcePacketBudgetMs,
} from "./bsd-pbp-fetch.js";

const UA = "test/1.0";
const ENV_KEYS = ["BSD_TENNIS_API_KEY", "AUDIT_SOURCE_PACKET_BUDGET_MS", "AUDIT_PBP_REQUEST_TIMEOUT_MS"] as const;

describe("BSD point-by-point retrieval is classified, never collapsed", () => {
  const saved = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
  });

  const respondWith = (init: () => Promise<Response> | Response) => {
    globalThis.fetch = (async () => init()) as typeof fetch;
  };

  test("a missing credential is PROVIDER_NOT_CONFIGURED, never absence of data", async () => {
    delete process.env["BSD_TENNIS_API_KEY"];
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;

    const result = await fetchPbpClassified(123, { userAgent: UA });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "PROVIDER_NOT_CONFIGURED");
    // The provider must not even be contacted, and the outcome must not read as "no data".
    assert.equal(called, false);
    assert.notEqual(result.ok === false && result.reason, "NO_QUALIFYING_DATA");
  });

  test("an HTTP error is a provider failure, carrying its status", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    respondWith(() => new Response("nope", { status: 502, statusText: "Bad Gateway" }));
    const result = await fetchPbpClassified(1, { userAgent: UA });
    assert.equal(result.ok === false && result.reason, "PROVIDER_HTTP_ERROR");
    assert.equal(result.ok === false && result.status, 502);
  });

  test("a 429 stays a provider failure rather than becoming absence", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    respondWith(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    const result = await fetchPbpClassified(1, { userAgent: UA });
    assert.equal(result.ok === false && result.reason, "PROVIDER_HTTP_ERROR");
    assert.equal(result.ok === false && result.status, 429);
  });

  test("a timeout is PROVIDER_TIMEOUT, distinct from a transport failure", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    globalThis.fetch = (async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }) as typeof fetch;
    const result = await fetchPbpClassified(1, { userAgent: UA });
    assert.equal(result.ok === false && result.reason, "PROVIDER_TIMEOUT");
  });

  test("a transport failure is a provider failure, not a timeout", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const result = await fetchPbpClassified(1, { userAgent: UA });
    assert.equal(result.ok === false && result.reason, "PROVIDER_HTTP_ERROR");
  });

  test("unparseable JSON is PARSING_FAILED, not absence", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    respondWith(() => new Response("<html>not json</html>", { status: 200 }));
    const result = await fetchPbpClassified(1, { userAgent: UA });
    assert.equal(result.ok === false && result.reason, "PARSING_FAILED");
  });

  test("the provider answering available:false IS genuine absence", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    respondWith(() => new Response(JSON.stringify({ available: false }), { status: 200 }));
    const result = await fetchPbpClassified(1, { userAgent: UA });
    // This is the ONE outcome that says something about the data itself.
    assert.equal(result.ok === false && result.reason, "NO_QUALIFYING_DATA");
  });

  test("a real payload comes back intact", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "t";
    respondWith(() => new Response(JSON.stringify({ available: true, sets: [{ games: [] }] }), { status: 200 }));
    const result = await fetchPbpClassified(1, { userAgent: UA });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.payload["sets"], [{ games: [] }]);
  });

  test("the credential is sent as a token header and never in the URL", async () => {
    process.env["BSD_TENNIS_API_KEY"] = "secret-key";
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url);
      seenAuth = String(init?.headers?.Authorization ?? "");
      return new Response(JSON.stringify({ available: true }), { status: 200 });
    }) as typeof fetch;
    await fetchPbpClassified("m-1", { userAgent: UA });
    assert.equal(seenAuth, "Token secret-key");
    assert.ok(!seenUrl.includes("secret-key"), "the key must never travel in the URL");
  });
});

describe("retrieval timeouts are coherent and configurable", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => { for (const key of ENV_KEYS) saved.set(key, process.env[key]); });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("the stage budget defaults to 7s and is configurable", () => {
    delete process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"];
    assert.equal(sourcePacketBudgetMs(), 7_000);
    process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"] = "45000";
    assert.equal(sourcePacketBudgetMs(), 45_000);
  });

  test("a retrieval longer than the old hardcoded 7s is allowed once the budget is raised", () => {
    process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"] = "40000";
    process.env["AUDIT_PBP_REQUEST_TIMEOUT_MS"] = "20000";
    // The specific failure this guards: a valid retrieval discarded purely because the
    // whole operation exceeded a fixed 7s deadline.
    assert.ok(sourcePacketBudgetMs() > 7_000);
    assert.equal(pbpRequestTimeoutMs(), 20_000);
  });

  test("a per-request timeout can never exceed the stage budget it runs inside", () => {
    // The original defect: a 12s request timeout inside a 7s stage budget, so a request was
    // allowed to outlive the stage that would discard its result.
    process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"] = "7000";
    process.env["AUDIT_PBP_REQUEST_TIMEOUT_MS"] = "12000";
    assert.equal(pbpRequestTimeoutMs(), 7_000);
  });

  test("the budget is bounded at both ends, so it can neither be zero nor unbounded", () => {
    process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"] = "0";
    assert.equal(sourcePacketBudgetMs(), 1_000);
    process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"] = "99999999";
    assert.equal(sourcePacketBudgetMs(), 120_000);
  });

  test("a non-numeric setting falls back rather than disabling the bound", () => {
    process.env["AUDIT_SOURCE_PACKET_BUDGET_MS"] = "soon";
    assert.equal(sourcePacketBudgetMs(), 7_000);
  });
});

describe("the retrieval tally keeps the reasons distinguishable", () => {
  test("counts each outcome separately and says so", () => {
    const tally = emptyTally();
    recordOutcome(tally, { ok: true, payload: {} });
    recordOutcome(tally, { ok: false, reason: "NO_QUALIFYING_DATA", detail: "" });
    recordOutcome(tally, { ok: false, reason: "PROVIDER_TIMEOUT", detail: "" });
    recordOutcome(tally, { ok: false, reason: "PROVIDER_TIMEOUT", detail: "" });

    assert.equal(tally.ok, 1);
    assert.equal(tally.NO_QUALIFYING_DATA, 1);
    assert.equal(tally.PROVIDER_TIMEOUT, 2);
    const summary = describeTally(tally);
    assert.ok(summary.includes("1 retrieved"));
    assert.ok(summary.includes("2 PROVIDER_TIMEOUT"));
    assert.ok(summary.includes("1 NO_QUALIFYING_DATA"));
  });

  test("no candidates at all is stated as such, not as an absence of data", () => {
    // Nothing was retrieved because nothing was attempted -- which is not evidence.
    assert.equal(describeTally(emptyTally()), "no candidate matches to retrieve");
  });
});
