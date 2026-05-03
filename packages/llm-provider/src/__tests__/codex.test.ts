import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexLLMProvider,
  InMemoryLLMProviderTokenStore,
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
  LLMTokenExpiredError,
  type CodexOAuthClientConfig,
  type CryptoEncryptDecrypt,
} from "../index.js";

const CLIENT: CodexOAuthClientConfig = {
  clientId: "addroid-codex-cli",
  redirectUri: "http://127.0.0.1:3000/api/oauth/codex/callback",
  authorizationUrl: "https://auth.example.test/oauth/authorize",
  tokenUrl: "https://auth.example.test/oauth/token",
  tokenAuthMethod: "pkce_s256",
};

const CRYPTO: CryptoEncryptDecrypt = {
  encrypt: (s) => `enc::${s}`,
  decrypt: (s) => s.replace(/^enc::/, ""),
};

const COMPLETIONS_URL = "https://api.example.test/v1/chat/completions";

interface RequestCtx {
  url: URL;
  method: string;
  body: URLSearchParams | string;
  authorization: string | null;
  contentType: string | null;
}

function makeFetch(handlers: Array<{ match: (c: RequestCtx) => boolean; respond: (c: RequestCtx) => Response }>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    // Sensitive params must NEVER be on the URL.
    for (const k of [
      "access_token",
      "refresh_token",
      "client_secret",
      "code",
      "code_verifier",
      "id_token",
    ]) {
      assert.equal(url.searchParams.get(k), null, `URL must not carry ${k}: ${url.toString()}`);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const ct = headers.get("Content-Type");
    let body: URLSearchParams | string = "";
    const raw = typeof init?.body === "string" ? init.body : "";
    if (ct?.startsWith("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(raw);
    } else {
      body = raw;
    }
    const ctx: RequestCtx = {
      url,
      method,
      body,
      authorization: headers.get("Authorization"),
      contentType: ct,
    };
    for (const h of handlers) {
      if (h.match(ctx)) return h.respond(ctx);
    }
    throw new Error(`unhandled fetch in test: ${method} ${url}`);
  };
}

function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function makeIdToken(payload: { sub?: string; email?: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.unsigned`;
}

test("CodexLLMProvider.completeOAuth exchanges code, stores ciphertext, and returns connection meta", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const idToken = makeIdToken({ email: "owner@example.test", sub: "user-1" });
  const fakeFetch = makeFetch([
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/token") &&
        body instanceof URLSearchParams &&
        body.get("grant_type") === "authorization_code",
      respond: ({ body }) => {
        assert.ok(body instanceof URLSearchParams);
        // PKCE verifier must be present in the body
        assert.ok((body as URLSearchParams).get("code_verifier"));
        // client_secret must NOT be sent for PKCE clients
        assert.equal((body as URLSearchParams).get("client_secret"), null);
        return jsonResponse({
          access_token: "atk-1",
          refresh_token: "rtk-1",
          expires_in: 3600,
          scope: "openai offline_access",
          id_token: idToken,
        });
      },
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  const begin = await provider.beginOAuth();
  // PKCE verifier must NOT leak through the public begin result — it is kept
  // inside the provider's pending state and only sent on the token exchange.
  assert.equal((begin as { codeVerifier?: unknown }).codeVerifier, undefined);
  const conn = await provider.completeOAuth({ code: "the-code", state: begin.state });
  assert.equal(conn.provider, "codex");
  assert.equal(conn.accountIdentifier, "owner@example.test");
  assert.equal(conn.defaultModel, "gpt-4.1");
  assert.deepEqual(conn.scopes.sort(), ["offline_access", "openai"]);

  const stored = await store.loadOAuthToken("codex");
  assert.ok(stored);
  assert.equal(stored?.accessTokenCiphertext, "enc::atk-1");
  assert.equal(stored?.refreshTokenCiphertext, "enc::rtk-1");
});

test("CodexLLMProvider rejects callback when no pending state was issued (fail closed)", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(
    () => provider.completeOAuth({ code: "x", state: "any" }),
    LLMOAuthStateMismatchError
  );
  assert.equal(await store.loadOAuthToken("codex"), null);
});

test("CodexLLMProvider rejects state replay after a successful completeOAuth", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  const fakeFetch = makeFetch([
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/token") &&
        body instanceof URLSearchParams &&
        body.get("grant_type") === "authorization_code",
      respond: () =>
        jsonResponse({
          access_token: "atk",
          refresh_token: "rtk",
          expires_in: 3600,
          scope: "openai",
        }),
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });
  await assert.rejects(
    () => provider.completeOAuth({ code: "c", state: begin.state }),
    LLMOAuthStateMismatchError
  );
});

test("CodexLLMProvider.refreshToken rotates ciphertext and updates expiresAt", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "user-1",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::old-atk",
    refreshTokenCiphertext: "enc::old-rtk",
    expiresAt: new Date(Date.now() - 10_000),
    connectedAt: new Date(Date.now() - 86_400_000),
    defaultModel: "gpt-4.1",
  });
  const fakeFetch = makeFetch([
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/token") &&
        body instanceof URLSearchParams &&
        body.get("grant_type") === "refresh_token",
      respond: ({ body }) => {
        // Old refresh token must be sent in body, not URL
        assert.equal((body as URLSearchParams).get("refresh_token"), "old-rtk");
        return jsonResponse({
          access_token: "new-atk",
          refresh_token: "new-rtk",
          expires_in: 3600,
          scope: "openai",
        });
      },
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  const refreshed = await provider.refreshToken();
  assert.equal(refreshed.provider, "codex");
  const after = await store.loadOAuthToken("codex");
  assert.equal(after?.accessTokenCiphertext, "enc::new-atk");
  assert.equal(after?.refreshTokenCiphertext, "enc::new-rtk");
  assert.ok(after?.expiresAt && after.expiresAt.getTime() > Date.now());
});

test("CodexLLMProvider.refreshToken throws when no token is stored", async () => {
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: new InMemoryLLMProviderTokenStore(),
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(() => provider.refreshToken(), LLMProviderUnauthenticatedError);
});

test("CodexLLMProvider.complete sends Bearer token in header and never in URL or body", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "user-1",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::stored-atk",
    refreshTokenCiphertext: "enc::stored-rtk",
    expiresAt: new Date(Date.now() + 60_000),
    connectedAt: new Date(),
    defaultModel: "gpt-4.1",
  });
  const fakeFetch = makeFetch([
    {
      match: ({ url }) => url.toString() === COMPLETIONS_URL,
      respond: ({ body, authorization }) => {
        assert.match(authorization ?? "", /^Bearer stored-atk$/);
        // body is JSON for completion
        const parsed = JSON.parse(body as string);
        assert.equal(parsed.model, "gpt-4.1");
        // Token must NOT appear inside the JSON body either
        assert.equal(JSON.stringify(parsed).includes("stored-atk"), false);
        return jsonResponse(
          {
            choices: [
              { message: { role: "assistant", content: "hello back" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
            model: "gpt-4.1",
          },
          200,
          { "x-request-id": "req-1234" }
        );
      },
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  const result = await provider.complete({
    messages: [{ role: "user", content: "hello" }],
    purpose: "test",
  });
  assert.equal(result.content, "hello back");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.meta.provider, "codex");
  assert.equal(result.meta.model, "gpt-4.1");
  assert.equal(result.meta.requestId, "req-1234");
  assert.equal(result.meta.accountIdentifier, "user-1");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 });
  // gpt-4.1 has known pricing
  assert.ok(result.costUsd > 0);
});

test("CodexLLMProvider.complete auto-refreshes when token is expired and refresh_token is available", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "user-1",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::stale-atk",
    refreshTokenCiphertext: "enc::stale-rtk",
    expiresAt: new Date(Date.now() - 1000),
    connectedAt: new Date(Date.now() - 86_400_000),
    defaultModel: "gpt-4.1",
  });
  const fakeFetch = makeFetch([
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/token") &&
        body instanceof URLSearchParams &&
        body.get("grant_type") === "refresh_token",
      respond: () =>
        jsonResponse({
          access_token: "fresh-atk",
          refresh_token: "fresh-rtk",
          expires_in: 3600,
          scope: "openai",
        }),
    },
    {
      match: ({ url }) => url.toString() === COMPLETIONS_URL,
      respond: ({ authorization }) => {
        assert.match(authorization ?? "", /^Bearer fresh-atk$/);
        return jsonResponse({
          choices: [
            { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: "gpt-4.1",
        });
      },
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  const result = await provider.complete({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.content, "ok");
  const after = await store.loadOAuthToken("codex");
  assert.equal(after?.accessTokenCiphertext, "enc::fresh-atk");
});

test("CodexLLMProvider.complete throws LLMTokenExpiredError when no refresh_token stored", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "user-1",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::stale-atk",
    refreshTokenCiphertext: null,
    expiresAt: new Date(Date.now() - 1000),
    connectedAt: new Date(Date.now() - 86_400_000),
    defaultModel: "gpt-4.1",
  });
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    LLMTokenExpiredError
  );
});

test("CodexLLMProvider.complete redacts the token from upstream HTTP errors", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "user-1",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::sk-supersecrettoken123456",
    refreshTokenCiphertext: "enc::rtk",
    expiresAt: new Date(Date.now() + 60_000),
    connectedAt: new Date(),
    defaultModel: "gpt-4.1",
  });
  const fakeFetch = makeFetch([
    {
      match: ({ url }) => url.toString() === COMPLETIONS_URL,
      respond: () =>
        new Response(
          'echoing back: Bearer sk-supersecrettoken123456',
          { status: 502, headers: { "Content-Type": "text/plain" } }
        ),
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  let captured: LLMProviderError | null = null;
  try {
    await provider.complete({ messages: [{ role: "user", content: "x" }] });
  } catch (err) {
    if (err instanceof LLMProviderError) captured = err;
  }
  assert.ok(captured);
  const text = JSON.stringify(captured!.payload);
  assert.equal(text.includes("sk-supersecrettoken123456"), false, "raw token must not appear in error payload");
  assert.equal(captured!.message.includes("sk-supersecrettoken123456"), false);
});

test("CodexLLMProvider.complete redacts credentials echoed back in JSON error.message and error.code", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "user-1",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::sk-jsonerrortoken9876543210",
    refreshTokenCiphertext: "enc::rtk",
    expiresAt: new Date(Date.now() + 60_000),
    connectedAt: new Date(),
    defaultModel: "gpt-4.1",
  });
  const fakeFetch = makeFetch([
    {
      match: ({ url }) => url.toString() === COMPLETIONS_URL,
      respond: () =>
        jsonResponse(
          {
            error: {
              message:
                'invalid_grant: provided Bearer sk-jsonerrortoken9876543210 was rejected',
              code: 'sk-jsonerrortoken9876543210',
            },
          },
          200
        ),
    },
  ]);
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: fakeFetch,
  });
  let captured: LLMProviderError | null = null;
  try {
    await provider.complete({ messages: [{ role: "user", content: "x" }] });
  } catch (err) {
    if (err instanceof LLMProviderError) captured = err;
  }
  assert.ok(captured);
  assert.equal(
    captured!.message.includes("sk-jsonerrortoken9876543210"),
    false,
    "raw token must not appear in error.message"
  );
  assert.equal(
    (captured!.code ?? "").includes("sk-jsonerrortoken9876543210"),
    false,
    "raw token must not appear in error.code"
  );
  assert.match(captured!.message, /\[REDACTED\]/);
  assert.match(captured!.code ?? "", /\[REDACTED\]/);
});

test("CodexLLMProvider.complete rejects empty messages", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "u",
    scopes: [],
    accessTokenCiphertext: "enc::a",
    refreshTokenCiphertext: null,
    expiresAt: new Date(Date.now() + 60_000),
    connectedAt: new Date(),
    defaultModel: "gpt-4.1",
  });
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(
    () => provider.complete({ messages: [] }),
    LLMProviderError
  );
});

test("CodexLLMProvider.disconnect removes the stored token", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "u",
    scopes: [],
    accessTokenCiphertext: "enc::a",
    refreshTokenCiphertext: "enc::r",
    expiresAt: null,
    connectedAt: new Date(),
    defaultModel: "gpt-4.1",
  });
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  assert.equal(await provider.disconnect(), true);
  assert.equal(await store.loadOAuthToken("codex"), null);
  assert.equal(await provider.disconnect(), false);
});

test("CodexLLMProvider.generateImage and embed are not implemented yet (future extension hook)", async () => {
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: new InMemoryLLMProviderTokenStore(),
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(
    () => provider.generateImage({ prompt: "x" }),
    LLMNotImplementedError
  );
  await assert.rejects(
    () => provider.embed({ inputs: ["x"] }),
    LLMNotImplementedError
  );
});

test("CodexLLMProvider.getConnection returns metadata without exposing ciphertext", async () => {
  const store = new InMemoryLLMProviderTokenStore();
  await store.saveOAuthToken({
    provider: "codex",
    accountIdentifier: "u@example.test",
    scopes: ["openai"],
    accessTokenCiphertext: "enc::DO-NOT-LEAK",
    refreshTokenCiphertext: "enc::DO-NOT-LEAK-RTK",
    expiresAt: new Date(Date.now() + 60_000),
    connectedAt: new Date(),
    defaultModel: "gpt-4.1",
  });
  const provider = new CodexLLMProvider({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    chatCompletionsUrl: COMPLETIONS_URL,
    defaultModel: "gpt-4.1",
    fetchImpl: makeFetch([]),
  });
  const conn = await provider.getConnection();
  assert.ok(conn);
  const text = JSON.stringify(conn);
  assert.equal(text.includes("DO-NOT-LEAK"), false);
  assert.equal(conn!.accountIdentifier, "u@example.test");
  assert.equal(conn!.defaultModel, "gpt-4.1");
});
