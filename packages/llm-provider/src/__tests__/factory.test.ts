import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexLLMProvider,
  InMemoryLLMProviderTokenStore,
  LLMProviderNotConfiguredError,
  MockLLMProvider,
  StubLLMProvider,
  selectLLMProvider,
  type CodexOAuthClientConfig,
  type CryptoEncryptDecrypt,
} from "../index.js";

const CLIENT: CodexOAuthClientConfig = {
  clientId: "id",
  redirectUri: "http://127.0.0.1:3000/api/oauth/codex/callback",
  authorizationUrl: "https://auth.example.test/oauth/authorize",
  tokenUrl: "https://auth.example.test/oauth/token",
};

const CRYPTO: CryptoEncryptDecrypt = {
  encrypt: (s) => `enc::${s}`,
  decrypt: (s) => s.replace(/^enc::/, ""),
};

test("selectLLMProvider prefers MockLLMProvider when ADDROID_LLM_MOCK=1", () => {
  const sel = selectLLMProvider({
    env: { ADDROID_LLM_MOCK: "1" },
    tokenStore: new InMemoryLLMProviderTokenStore(),
    codexClient: CLIENT,
    crypto: CRYPTO,
    chatCompletionsUrl: "https://api.example.test/v1/chat/completions",
    defaultModel: "gpt-4.1",
  });
  assert.equal(sel.choice, "mock");
  assert.ok(sel.provider instanceof MockLLMProvider);
});

test("selectLLMProvider chooses CodexLLMProvider when all required deps are present", () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
    codexClient: CLIENT,
    crypto: CRYPTO,
    chatCompletionsUrl: "https://api.example.test/v1/chat/completions",
    defaultModel: "gpt-4.1",
  });
  assert.equal(sel.choice, "codex");
  assert.ok(sel.provider instanceof CodexLLMProvider);
});

test("selectLLMProvider falls back to StubLLMProvider when codex client is missing", async () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
    crypto: CRYPTO,
    chatCompletionsUrl: "https://api.example.test/v1/chat/completions",
    defaultModel: "gpt-4.1",
  });
  assert.equal(sel.choice, "stub");
  assert.ok(sel.provider instanceof StubLLMProvider);
  await assert.rejects(
    () => sel.provider.complete({ messages: [{ role: "user", content: "x" }] }),
    LLMProviderNotConfiguredError
  );
});

test("selectLLMProvider's stub falls back to a sensible default model when none provided", () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
  });
  assert.equal(sel.choice, "stub");
  assert.equal(sel.provider.name, "codex");
  assert.equal(sel.provider.defaultModel, "gpt-4.1");
});

test("selectLLMProvider mock inherits options from `mock`", async () => {
  const sel = selectLLMProvider({
    env: { ADDROID_LLM_MOCK: "1" },
    tokenStore: new InMemoryLLMProviderTokenStore(),
    mock: {
      accountIdentifier: "custom-mock-user",
      defaultModel: "mock-large",
    },
  });
  assert.equal(sel.choice, "mock");
  const begin = await sel.provider.beginOAuth();
  const conn = await sel.provider.completeOAuth({ code: "c", state: begin.state });
  assert.equal(conn.accountIdentifier, "custom-mock-user");
  assert.equal(conn.defaultModel, "mock-large");
});

test("selectLLMProvider stub records a reason that names every missing dep", () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
  });
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /codexClient/);
  assert.match(sel.reason, /crypto/);
  assert.match(sel.reason, /chatCompletionsUrl/);
  assert.match(sel.reason, /defaultModel/);
});
