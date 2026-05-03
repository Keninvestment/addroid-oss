import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMetaTokenStore,
  MetaAdapterUnauthenticatedError,
  MetaOAuthExchangeError,
  MetaOAuthStateMismatchError,
  MetaTokenExpiredError,
  RealMetaAdapter,
  type CryptoEncryptDecrypt,
  type MetaOAuthClientConfig,
} from "../index.js";

const CLIENT: MetaOAuthClientConfig = {
  appId: "100000000000001",
  appSecret: "shh",
  redirectUri: "http://127.0.0.1:3000/api/oauth/meta/callback",
};

const CRYPTO: CryptoEncryptDecrypt = {
  encrypt: (s) => `enc::${s}`,
  decrypt: (s) => s.replace(/^enc::/, ""),
};

interface RequestCtx {
  /** request の URL。Meta token は **絶対に含まれない** ことを assert に使う。 */
  url: URL;
  method: string;
  /** form-urlencoded body をパースしたもの。GET 等で body がなければ空 URLSearchParams。 */
  body: URLSearchParams;
  /** Authorization ヘッダ (実装は `Bearer <token>` を入れる)。無ければ null。 */
  authorization: string | null;
}

interface RouteHandler {
  match: (ctx: RequestCtx) => boolean;
  respond: (ctx: RequestCtx) => Response;
}

function assertNoTokenInUrl(url: URL): void {
  // 機密パラメータ (access_token / input_token / fb_exchange_token / client_secret /
  // code) は URL クエリに置かない。万一見つかったら即座に失敗させる。
  for (const k of [
    "access_token",
    "input_token",
    "fb_exchange_token",
    "client_secret",
    "code",
  ]) {
    assert.equal(
      url.searchParams.get(k),
      null,
      `URL must not carry ${k}: ${url.toString()}`
    );
  }
  // 念のため、URL の文字列表現に EAA-style ユーザートークンが混入していないことも確認。
  assert.equal(
    /EAA[A-Za-z0-9_-]+/.test(url.toString()),
    false,
    `URL must not contain Meta access token fragment: ${url.toString()}`
  );
}

function makeFetch(handlers: RouteHandler[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    assertNoTokenInUrl(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body = new URLSearchParams();
    if (typeof init?.body === "string" && init.body.length > 0) {
      body = new URLSearchParams(init.body);
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization");
    const ctx: RequestCtx = { url, method, body, authorization };
    for (const h of handlers) {
      if (h.match(ctx)) return h.respond(ctx);
    }
    throw new Error(`unhandled fetch in test: ${method} ${url.toString()}`);
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("RealMetaAdapter completeOAuth succeeds: short-lived → long-lived → /me + /debug_token + /me/businesses + /me/adaccounts", async () => {
  const store = new InMemoryMetaTokenStore();
  const fakeFetch = makeFetch([
    {
      // first /oauth/access_token call (no grant_type) → short-lived
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/access_token") &&
        !body.has("grant_type"),
      respond: () =>
        jsonResponse({ access_token: "EAA-short", expires_in: 3600 }),
    },
    {
      // second /oauth/access_token call with grant_type=fb_exchange_token → long-lived
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/access_token") &&
        body.get("grant_type") === "fb_exchange_token",
      respond: () => jsonResponse({ access_token: "EAA-long" }),
    },
    {
      match: ({ url, authorization }) => {
        const isMe =
          url.pathname.endsWith("/me") &&
          !url.pathname.endsWith("/me/businesses") &&
          !url.pathname.endsWith("/me/adaccounts");
        if (!isMe) return false;
        // /me は Authorization: Bearer 経由でトークンを受け取る。
        assert.match(authorization ?? "", /^Bearer EAA-long$/);
        return true;
      },
      respond: () => jsonResponse({ id: "987654321", name: "Mock Owner" }),
    },
    {
      match: ({ url }) => url.pathname.endsWith("/debug_token"),
      respond: () =>
        jsonResponse({
          data: {
            user_id: "987654321",
            app_id: CLIENT.appId,
            scopes: ["ads_management", "ads_read", "business_management"],
            expires_at: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
            is_valid: true,
          },
        }),
    },
    {
      match: ({ url, authorization }) => {
        if (!url.pathname.endsWith("/me/businesses")) return false;
        assert.match(authorization ?? "", /^Bearer EAA-long$/);
        return true;
      },
      respond: () =>
        jsonResponse({
          data: [{ id: "B-1", name: "Biz One" }, { id: "B-2", name: "Biz Two" }],
        }),
    },
    {
      match: ({ url, authorization }) => {
        if (!url.pathname.endsWith("/me/adaccounts")) return false;
        assert.match(authorization ?? "", /^Bearer EAA-long$/);
        return true;
      },
      respond: () =>
        jsonResponse({
          data: [
            {
              id: "act_1234567890",
              account_id: "1234567890",
              name: "Account A",
              account_status: 1,
              currency: "JPY",
              timezone_name: "Asia/Tokyo",
              business: { id: "B-1", name: "Biz One" },
            },
          ],
        }),
    },
  ]);

  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });

  const begin = await adapter.beginOAuth();
  const conn = await adapter.completeOAuth({ code: "the-code", state: begin.state });
  assert.equal(conn.accountIdentifier, "987654321");
  assert.deepEqual(conn.scopes.sort(), ["ads_management", "ads_read", "business_management"].sort());
  assert.equal(conn.businesses.length, 2);
  assert.equal(conn.adAccounts.length, 1);
  assert.equal(conn.adAccounts[0]?.metaAccountId, "act_1234567890");
  assert.equal(conn.adAccounts[0]?.currency, "JPY");

  const stored = await store.loadOAuthToken("meta");
  assert.ok(stored);
  assert.equal(stored?.accessTokenCiphertext, "enc::EAA-long");
});

test("RealMetaAdapter completeOAuth bubbles up Meta auth errors", async () => {
  const store = new InMemoryMetaTokenStore();
  const fakeFetch = makeFetch([
    {
      match: ({ url }) => url.pathname.endsWith("/oauth/access_token"),
      respond: () =>
        jsonResponse({
          error: {
            message: "Invalid OAuth code",
            type: "OAuthException",
            code: 100,
          },
        }),
    },
  ]);
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });
  const begin = await adapter.beginOAuth();
  await assert.rejects(
    () => adapter.completeOAuth({ code: "bad", state: begin.state }),
    MetaOAuthExchangeError
  );
});

test("RealMetaAdapter rejects state mismatch as CSRF", async () => {
  const store = new InMemoryMetaTokenStore();
  const fakeFetch = makeFetch([
    { match: () => true, respond: () => jsonResponse({ access_token: "x" }) },
  ]);
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });
  await adapter.beginOAuth();
  await assert.rejects(
    () => adapter.completeOAuth({ code: "x", state: "tampered" }),
    MetaOAuthStateMismatchError
  );
});

test("RealMetaAdapter rejects callback when no pending state was issued (fail closed)", async () => {
  const store = new InMemoryMetaTokenStore();
  const fakeFetch = makeFetch([
    { match: () => true, respond: () => jsonResponse({ access_token: "x" }) },
  ]);
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });
  // No beginOAuth(): an attacker-supplied callback must still be rejected.
  await assert.rejects(
    () => adapter.completeOAuth({ code: "x", state: "any-state" }),
    MetaOAuthStateMismatchError
  );
  // Token store must remain empty — completeOAuth must not have proceeded to
  // the token-exchange phase.
  const stored = await store.loadOAuthToken("meta");
  assert.equal(stored, null);
});

test("RealMetaAdapter rejects replay after a successful completeOAuth (pendingState consumed)", async () => {
  const store = new InMemoryMetaTokenStore();
  const fakeFetch = makeFetch([
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/access_token") &&
        !body.has("grant_type"),
      respond: () =>
        jsonResponse({ access_token: "EAA-short", expires_in: 3600 }),
    },
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/access_token") &&
        body.get("grant_type") === "fb_exchange_token",
      respond: () => jsonResponse({ access_token: "EAA-long" }),
    },
    {
      match: ({ url }) =>
        url.pathname.endsWith("/me") &&
        !url.pathname.endsWith("/me/businesses") &&
        !url.pathname.endsWith("/me/adaccounts"),
      respond: () => jsonResponse({ id: "u-1", name: "U" }),
    },
    {
      match: ({ url }) => url.pathname.endsWith("/debug_token"),
      respond: () =>
        jsonResponse({
          data: {
            user_id: "u-1",
            app_id: CLIENT.appId,
            scopes: ["ads_read"],
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            is_valid: true,
          },
        }),
    },
    { match: ({ url }) => url.pathname.endsWith("/me/businesses"), respond: () => jsonResponse({ data: [] }) },
    { match: ({ url }) => url.pathname.endsWith("/me/adaccounts"), respond: () => jsonResponse({ data: [] }) },
  ]);
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  // Replaying the same state must now be rejected because pendingState was consumed.
  await assert.rejects(
    () => adapter.completeOAuth({ code: "c", state: begin.state }),
    MetaOAuthStateMismatchError
  );
});

test("RealMetaAdapter.refreshLongLivedToken updates ciphertext + expiresAt", async () => {
  const store = new InMemoryMetaTokenStore();
  await store.saveOAuthToken({
    provider: "meta",
    accountIdentifier: "987654321",
    scopes: ["ads_read"],
    accessTokenCiphertext: "enc::EAA-old",
    expiresAt: new Date(Date.now() - 10_000), // expired
    connectedAt: new Date(Date.now() - 86_400_000),
  });
  const newExpiresAt = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
  const fakeFetch = makeFetch([
    {
      match: ({ url, body }) =>
        url.pathname.endsWith("/oauth/access_token") &&
        body.get("grant_type") === "fb_exchange_token",
      respond: () => jsonResponse({ access_token: "EAA-new" }),
    },
    {
      match: ({ url }) => url.pathname.endsWith("/debug_token"),
      respond: () =>
        jsonResponse({
          data: {
            user_id: "987654321",
            app_id: CLIENT.appId,
            scopes: ["ads_read"],
            expires_at: newExpiresAt,
            is_valid: true,
          },
        }),
    },
  ]);
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });
  const refreshed = await adapter.refreshLongLivedToken();
  assert.equal(refreshed.provider, "meta");
  const after = await store.loadOAuthToken("meta");
  assert.equal(after?.accessTokenCiphertext, "enc::EAA-new");
  assert.ok(after?.expiresAt && after.expiresAt.getTime() > Date.now());
});

test("RealMetaAdapter.refreshLongLivedToken throws when no token is stored", async () => {
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: new InMemoryMetaTokenStore(),
    crypto: CRYPTO,
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(
    () => adapter.refreshLongLivedToken(),
    MetaAdapterUnauthenticatedError
  );
});

test("RealMetaAdapter.loadAccessTokenPlaintext throws MetaTokenExpiredError after expiry", async () => {
  const store = new InMemoryMetaTokenStore();
  await store.saveOAuthToken({
    provider: "meta",
    accountIdentifier: "u-1",
    scopes: ["ads_read"],
    accessTokenCiphertext: "enc::EAA-stored",
    expiresAt: new Date(Date.now() - 1000),
    connectedAt: new Date(Date.now() - 86_400_000),
  });
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: makeFetch([]),
  });
  await assert.rejects(
    () => adapter.loadAccessTokenPlaintext(),
    MetaTokenExpiredError
  );
});

test("RealMetaAdapter.fetchBusinesses uses the stored token without leaking it in errors", async () => {
  const store = new InMemoryMetaTokenStore();
  await store.saveOAuthToken({
    provider: "meta",
    accountIdentifier: "u-1",
    scopes: ["business_management"],
    accessTokenCiphertext: "enc::EAA-stored",
    expiresAt: new Date(Date.now() + 60_000),
    connectedAt: new Date(),
  });
  const fakeFetch = makeFetch([
    {
      match: ({ url, authorization }) => {
        if (!url.pathname.endsWith("/me/businesses")) return false;
        // 復号後の plaintext token は Authorization ヘッダ経由でのみ送られる。
        assert.match(authorization ?? "", /^Bearer EAA-stored$/);
        return true;
      },
      respond: () => jsonResponse({ data: [{ id: "B-1", name: "BizOne" }] }),
    },
  ]);
  const adapter = new RealMetaAdapter({
    oauthClient: CLIENT,
    tokenStore: store,
    crypto: CRYPTO,
    fetchImpl: fakeFetch,
  });
  const businesses = await adapter.fetchBusinesses();
  assert.deepEqual(businesses, [{ id: "B-1", name: "BizOne", role: null }]);
});
