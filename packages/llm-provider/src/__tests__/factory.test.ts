import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexAppServerLLMProvider,
  InMemoryLLMProviderTokenStore,
  MockLLMProvider,
  selectLLMProvider,
  type ApiKeyCryptoBoundary,
} from "../index.js";

const CRYPTO: ApiKeyCryptoBoundary = {
  encrypt: (s) => `enc::${s}`,
  decrypt: (s) => s.replace(/^enc::/, ""),
};

test("selectLLMProvider prefers MockLLMProvider when ADDROID_LLM_MOCK=1", () => {
  const sel = selectLLMProvider({
    env: { ADDROID_LLM_MOCK: "1" },
    tokenStore: new InMemoryLLMProviderTokenStore(),
    crypto: CRYPTO,
    defaultModel: "gpt-4.1",
  });
  assert.equal(sel.choice, "mock");
  assert.ok(sel.provider instanceof MockLLMProvider);
});

test("selectLLMProvider chooses CodexAppServerLLMProvider for the codex route", () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
  });
  assert.equal(sel.choice, "codex");
  assert.ok(sel.provider instanceof CodexAppServerLLMProvider);
});

test("selectLLMProvider can still produce a stub for explicit non-codex missing routes", async () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
    stubProvider: "openai",
  });
  assert.equal(sel.choice, "stub");
  assert.equal(sel.provider.name, "openai");
});

test("selectLLMProvider's codex route falls back to a sensible default model", () => {
  const sel = selectLLMProvider({
    env: {},
    tokenStore: new InMemoryLLMProviderTokenStore(),
  });
  assert.equal(sel.choice, "codex");
  assert.equal(sel.provider.name, "codex");
  assert.equal(sel.provider.defaultModel, "codex-app-server");
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
    stubProvider: "openai",
  });
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /crypto/);
  assert.match(sel.reason, /defaultModel/);
});
