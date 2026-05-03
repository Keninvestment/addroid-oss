import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiKeyLLMProvider,
  InMemoryLLMProviderTokenStore,
  type LLMProviderTokenRecord,
} from "../index.js";

const crypto = {
  encrypt(plaintext: string) {
    return `enc:${plaintext}`;
  },
  decrypt(ciphertext: string) {
    return ciphertext.replace(/^enc:/, "");
  },
};

test("ApiKeyLLMProvider sends OpenAI API key in Authorization header only", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const record: LLMProviderTokenRecord = {
    provider: "openai",
    authKind: "api_key",
    accountIdentifier: "openai-api-key",
    scopes: [],
    accessTokenCiphertext: crypto.encrypt("sk-test-openai-key"),
    connectedAt: new Date("2026-05-04T00:00:00Z"),
    defaultModel: "gpt-4.1",
  };
  await store.saveOAuthToken(record);
  const captured: Array<{ url: string; headers: HeadersInit; body: string }> = [];
  const provider = new ApiKeyLLMProvider({
    provider: "openai",
    tokenStore: store,
    crypto,
    defaultModel: "gpt-4.1",
    fetchImpl: async (url, init) => {
      captured.push({
        url: String(url),
        headers: init?.headers ?? {},
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
          model: "gpt-4.1",
        }),
        { status: 200, headers: { "x-request-id": "req_openai" } }
      );
    },
  });
  const result = await provider.complete({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(result.content, "ok");
  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.requestId, "req_openai");
  const got = captured[0];
  assert.ok(got);
  assert.equal(got.url.includes("sk-test-openai-key"), false);
  assert.equal(got.body.includes("sk-test-openai-key"), false);
  assert.equal((got.headers as Record<string, string>).Authorization, "Bearer sk-test-openai-key");
});

test("ApiKeyLLMProvider maps Anthropic messages response", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "anthropic",
    authKind: "api_key",
    accountIdentifier: "anthropic-api-key",
    scopes: [],
    accessTokenCiphertext: crypto.encrypt("sk-ant-test-key"),
    connectedAt: new Date("2026-05-04T00:00:00Z"),
    defaultModel: "claude-3-5-sonnet-latest",
  });
  let apiKeyHeader = "";
  const provider = new ApiKeyLLMProvider({
    provider: "anthropic",
    tokenStore: store,
    crypto,
    defaultModel: "claude-3-5-sonnet-latest",
    fetchImpl: async (_url, init) => {
      apiKeyHeader = (init?.headers as Record<string, string>)["x-api-key"] ?? "";
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "anthropic ok" }],
          usage: { input_tokens: 7, output_tokens: 11 },
          model: "claude-3-5-sonnet-latest",
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "request-id": "req_anthropic" } }
      );
    },
  });
  const result = await provider.complete({
    messages: [
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ],
  });
  assert.equal(apiKeyHeader, "sk-ant-test-key");
  assert.equal(result.content, "anthropic ok");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.meta.requestId, "req_anthropic");
});
