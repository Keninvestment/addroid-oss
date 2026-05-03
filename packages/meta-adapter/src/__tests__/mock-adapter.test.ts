import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDROID_META_REQUIRED_SCOPES,
  InMemoryMetaTokenStore,
  MetaAdapterUnauthenticatedError,
  MetaOAuthStateMismatchError,
  MockMetaAdapter,
} from "../index.js";

test("MockMetaAdapter completes a happy-path OAuth round-trip and persists token", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({ tokenStore: store });
  const begin = await adapter.beginOAuth();
  assert.match(begin.authorizationUrl, /^https:\/\/addroid\.invalid\/mock-meta-oauth\/authorize/);
  assert.ok(begin.state.length > 16);
  const conn = await adapter.completeOAuth({ code: "the-code", state: begin.state });
  assert.equal(conn.provider, "meta");
  assert.equal(conn.accountIdentifier, "mock-meta-user");
  assert.deepEqual(conn.scopes, [...ADDROID_META_REQUIRED_SCOPES]);
  assert.ok(conn.businesses.length >= 1);
  assert.ok(conn.adAccounts.length >= 1);
  assert.ok(conn.expiresAt && new Date(conn.expiresAt).getTime() > Date.now());

  const stored = await store.loadOAuthToken("meta");
  assert.ok(stored);
  assert.equal(stored?.provider, "meta");
  assert.match(stored!.accessTokenCiphertext, /mock-meta-encrypted::the-code/);
});

test("MockMetaAdapter rejects state mismatch as CSRF", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({ tokenStore: store });
  await adapter.beginOAuth();
  await assert.rejects(
    () => adapter.completeOAuth({ code: "the-code", state: "tampered" }),
    MetaOAuthStateMismatchError
  );
});

test("MockMetaAdapter raises auth_failed mode on completeOAuth", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({ tokenStore: store, failureMode: "auth_failed" });
  const begin = await adapter.beginOAuth();
  await assert.rejects(
    () => adapter.completeOAuth({ code: "x", state: begin.state }),
    /invalid_grant/
  );
});

test("MockMetaAdapter.refreshLongLivedToken updates expiresAt and ciphertext", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({ tokenStore: store, expiresInSeconds: 3600 });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c1", state: begin.state });
  const before = await store.loadOAuthToken("meta");
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await adapter.refreshLongLivedToken();
  const after = await store.loadOAuthToken("meta");
  assert.ok(after?.expiresAt && before?.expiresAt);
  assert.ok(after!.expiresAt!.getTime() >= before!.expiresAt!.getTime());
  assert.notEqual(after?.accessTokenCiphertext, before?.accessTokenCiphertext);
  assert.equal(refreshed.provider, "meta");
  assert.equal(refreshed.accountIdentifier, "mock-meta-user");
});

test("MockMetaAdapter.refreshLongLivedToken throws when not yet authenticated", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({ tokenStore: store });
  await assert.rejects(
    () => adapter.refreshLongLivedToken(),
    MetaAdapterUnauthenticatedError
  );
});

test("MockMetaAdapter.fetchBusinesses / fetchAdAccounts fail closed when unauthenticated", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({ tokenStore: store });
  await assert.rejects(() => adapter.fetchBusinesses(), MetaAdapterUnauthenticatedError);
  await assert.rejects(() => adapter.fetchAdAccounts(), MetaAdapterUnauthenticatedError);
});

test("MockMetaAdapter respects custom businesses / adAccounts fixtures", async () => {
  const store = new InMemoryMetaTokenStore();
  const adapter = new MockMetaAdapter({
    tokenStore: store,
    businesses: [{ id: "B-X", name: "Custom Biz", role: "ADMIN" }],
    adAccounts: [
      {
        accountId: "11",
        metaAccountId: "act_11",
        name: "Custom Account",
        currency: "EUR",
        timezoneName: "Europe/Berlin",
        businessId: "B-X",
        accountStatus: 1,
      },
    ],
  });
  const begin = await adapter.beginOAuth();
  const conn = await adapter.completeOAuth({ code: "c", state: begin.state });
  assert.equal(conn.businesses.length, 1);
  assert.equal(conn.businesses[0]?.id, "B-X");
  assert.equal(conn.adAccounts.length, 1);
  assert.equal(conn.adAccounts[0]?.metaAccountId, "act_11");
});
