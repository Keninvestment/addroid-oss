import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryLLMProviderTokenStore,
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
  MockLLMProvider,
  runAnalystAgent,
  type AnalystAgentInput,
} from "../index.js";

test("MockLLMProvider OAuth flow stores a record and getConnection reflects it", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({ tokenStore: store });
  const begin = await provider.beginOAuth();
  // PKCE verifier must not be exposed on the public begin result.
  assert.equal((begin as { codeVerifier?: unknown }).codeVerifier, undefined);
  const conn = await provider.completeOAuth({ code: "c", state: begin.state });
  assert.equal(conn.provider, "mock");
  assert.equal(conn.accountIdentifier, "mock-codex-user");

  const refetched = await provider.getConnection();
  assert.ok(refetched);
  assert.equal(refetched!.accountIdentifier, "mock-codex-user");
});

test("MockLLMProvider rejects state mismatch", async () => {
  const provider = new MockLLMProvider({ tokenStore: new InMemoryLLMProviderTokenStore() });
  await provider.beginOAuth();
  await assert.rejects(
    () => provider.completeOAuth({ code: "c", state: "wrong" }),
    LLMOAuthStateMismatchError
  );
});

test("MockLLMProvider.complete returns deterministic content + provider/model meta", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({
    tokenStore: store,
    completionResponder: (req) => `RESP:${req.purpose ?? "none"}`,
  });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });
  const result = await provider.complete({
    messages: [{ role: "user", content: "hi" }],
    purpose: "agent:analyst",
  });
  assert.equal(result.content, "RESP:agent:analyst");
  assert.equal(result.meta.provider, "mock");
  assert.equal(result.meta.model, "mock-small");
  assert.equal(result.meta.accountIdentifier, "mock-codex-user");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 24);
  // mock pricing is 0
  assert.equal(result.costUsd, 0);
});

test("MockLLMProvider.complete throws when no token stored", async () => {
  const provider = new MockLLMProvider({ tokenStore: new InMemoryLLMProviderTokenStore() });
  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    LLMProviderUnauthenticatedError
  );
});

test("MockLLMProvider.failureMode='completion_failed' surfaces LLMProviderError", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({
    tokenStore: store,
    failureMode: "completion_failed",
  });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });
  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    (err) => {
      assert.ok(err instanceof LLMProviderError);
      assert.equal((err as LLMProviderError).code, "mock_failure");
      return true;
    }
  );
});

test("MockLLMProvider.disconnect clears stored record", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({ tokenStore: store });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });
  assert.equal(await provider.disconnect(), true);
  assert.equal(await store.loadOAuthToken("mock"), null);
});

test("MockLLMProvider future extensions throw LLMNotImplementedError", async () => {
  const provider = new MockLLMProvider({ tokenStore: new InMemoryLLMProviderTokenStore() });
  await assert.rejects(() => provider.generateImage({ prompt: "x" }), LLMNotImplementedError);
  await assert.rejects(() => provider.embed({ inputs: ["a"] }), LLMNotImplementedError);
});

test("MockLLMProvider default responder returns analyst-parseable JSON for purpose='agent:analyst'", async () => {
  // ADDROID_LLM_MOCK=1 の daily_report が成功するためには、Mock の default
  // completion が analyst parser を通過する JSON でなければならない
  // (regression fix)。runAnalystAgent を end-to-end で走らせて検証する。
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({ tokenStore: store });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });

  const input: AnalystAgentInput = {
    accountId: "act_mock",
    periodStart: "2026-04-25",
    periodEnd: "2026-04-30",
    snapshotIds: ["snap-mock-1"],
    current: { spend: 1000, impressions: 10000, clicks: 100, conversions: 5 },
  };
  const result = await runAnalystAgent(
    { provider, workspaceId: "ws-1", workflow: "daily_report" },
    input
  );
  assert.equal(result.error, null);
  assert.ok(result.output);
  assert.equal(result.aiRunInput.status, "succeeded");
  assert.equal(result.aiRunInput.decision, "report_only");
  assert.ok(result.output!.commentary.length > 0);
  assert.ok(result.output!.topImprovements.length >= 1);
  assert.ok(result.output!.topImprovements.length <= 3);
});

test("MockLLMProvider default responder still returns echo text for non-agent purposes", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({ tokenStore: store });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });
  const result = await provider.complete({
    messages: [{ role: "user", content: "hello world" }],
    purpose: "workflow:daily_report",
  });
  assert.match(result.content, /^\[mock:workflow:daily_report\] echo: /);
});
