import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryOAuthTokenStore } from "../index.js";

test("InMemoryOAuthTokenStore upserts by provider+account and reads back the latest", async () => {
  const store = new InMemoryOAuthTokenStore();
  const t0 = new Date("2026-05-01T00:00:00Z");
  const t1 = new Date("2026-05-01T00:01:00Z");
  await store.saveOAuthToken({
    provider: "github",
    accountIdentifier: "alice",
    scopes: ["repo"],
    accessTokenCiphertext: "enc::v1",
    connectedAt: t0,
  });
  await store.saveOAuthToken({
    provider: "github",
    accountIdentifier: "alice",
    scopes: ["repo"],
    accessTokenCiphertext: "enc::v2",
    connectedAt: t1,
  });
  assert.equal(store.size(), 1, "same provider+account should upsert in place");
  const loaded = await store.loadOAuthToken("github");
  assert.equal(loaded?.accessTokenCiphertext, "enc::v2");
});

test("InMemoryOAuthTokenStore.loadOAuthToken returns null when nothing is stored", async () => {
  const store = new InMemoryOAuthTokenStore();
  assert.equal(await store.loadOAuthToken("github"), null);
});

test("InMemoryOAuthTokenStore returns the most recently connected account when multiple exist", async () => {
  const store = new InMemoryOAuthTokenStore();
  await store.saveOAuthToken({
    provider: "github",
    accountIdentifier: "alice",
    scopes: ["repo"],
    accessTokenCiphertext: "enc::a",
    connectedAt: new Date("2026-05-01T00:00:00Z"),
  });
  await store.saveOAuthToken({
    provider: "github",
    accountIdentifier: "bob",
    scopes: ["repo"],
    accessTokenCiphertext: "enc::b",
    connectedAt: new Date("2026-05-01T00:05:00Z"),
  });
  const loaded = await store.loadOAuthToken("github");
  assert.equal(loaded?.accountIdentifier, "bob");
});
