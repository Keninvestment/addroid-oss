import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMetaTokenStore,
  MetaAdapterNotImplementedError,
  MockMetaAdapter,
  RealMetaAdapter,
  StubMetaAdapter,
  StoredTokenMetaAdapter,
  selectMetaAdapter,
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

test("selectMetaAdapter prefers the mock adapter when ADDROID_META_OAUTH_MOCK=1", () => {
  const sel = selectMetaAdapter({
    env: { ADDROID_META_OAUTH_MOCK: "1" },
    tokenStore: new InMemoryMetaTokenStore(),
    oauthClient: CLIENT,
    crypto: CRYPTO,
  });
  assert.equal(sel.choice, "mock");
  assert.ok(sel.adapter instanceof MockMetaAdapter);
});

test("selectMetaAdapter chooses Real when oauthClient + crypto are configured", () => {
  const sel = selectMetaAdapter({
    env: {},
    tokenStore: new InMemoryMetaTokenStore(),
    oauthClient: CLIENT,
    crypto: CRYPTO,
  });
  assert.equal(sel.choice, "real");
  assert.ok(sel.adapter instanceof RealMetaAdapter);
});

test("selectMetaAdapter falls back to the stub when OAuth is not configured", async () => {
  const sel = selectMetaAdapter({
    env: {},
    tokenStore: new InMemoryMetaTokenStore(),
  });
  assert.equal(sel.choice, "stub");
  assert.ok(sel.adapter instanceof StubMetaAdapter);
  await assert.rejects(() => sel.adapter.beginOAuth(), MetaAdapterNotImplementedError);
});

test("selectMetaAdapter chooses stored-token adapter when crypto is configured without OAuth client", () => {
  const sel = selectMetaAdapter({
    env: {},
    tokenStore: new InMemoryMetaTokenStore(),
    crypto: CRYPTO,
  });
  assert.equal(sel.choice, "token");
  assert.ok(sel.adapter instanceof StoredTokenMetaAdapter);
});

test("selectMetaAdapter mock adapter inherits a custom mockUserId", async () => {
  const sel = selectMetaAdapter({
    env: { ADDROID_META_OAUTH_MOCK: "1" },
    tokenStore: new InMemoryMetaTokenStore(),
    mock: { mockUserId: "my-mock-user" },
  });
  assert.equal(sel.choice, "mock");
  const begin = await sel.adapter.beginOAuth();
  const conn = await sel.adapter.completeOAuth({ code: "c", state: begin.state });
  assert.equal(conn.accountIdentifier, "my-mock-user");
});
