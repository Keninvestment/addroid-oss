import test from "node:test";
import assert from "node:assert/strict";
import {
  GithubAdapterNotImplementedError,
  InMemoryOAuthTokenStore,
  MockGithubAdapter,
  OctokitGithubAdapter,
  StubGithubAdapter,
  selectGithubAdapter,
  type CryptoEncryptDecrypt,
  type OAuthClientConfig,
} from "../index.js";

const CLIENT: OAuthClientConfig = {
  clientId: "Iv1.example",
  clientSecret: "shh",
  redirectUri: "http://127.0.0.1:3000/api/oauth/github/callback",
};

const CRYPTO: CryptoEncryptDecrypt = {
  encrypt: (s) => `enc::${s}`,
  decrypt: (s) => s.replace(/^enc::/, ""),
};

test("selectGithubAdapter prefers the mock adapter when ADDROID_GITHUB_OAUTH_MOCK=1", () => {
  const sel = selectGithubAdapter({
    env: { ADDROID_GITHUB_OAUTH_MOCK: "1" },
    tokenStore: new InMemoryOAuthTokenStore(),
    oauthClient: CLIENT,
    crypto: CRYPTO,
  });
  assert.equal(sel.choice, "mock");
  assert.ok(sel.adapter instanceof MockGithubAdapter);
});

test("selectGithubAdapter chooses the Octokit adapter when oauthClient + crypto are configured", () => {
  const sel = selectGithubAdapter({
    env: {},
    tokenStore: new InMemoryOAuthTokenStore(),
    oauthClient: CLIENT,
    crypto: CRYPTO,
  });
  assert.equal(sel.choice, "octokit");
  assert.ok(sel.adapter instanceof OctokitGithubAdapter);
});

test("selectGithubAdapter chooses the Octokit adapter for a stored token without OAuth client", async () => {
  const sel = selectGithubAdapter({
    env: {},
    tokenStore: new InMemoryOAuthTokenStore(),
    storedTokenAvailable: true,
    crypto: CRYPTO,
  });
  assert.equal(sel.choice, "octokit");
  assert.equal(sel.reason, "stored GitHub OAuth token + crypto boundary configured");
  assert.ok(sel.adapter instanceof OctokitGithubAdapter);
  await assert.rejects(() => sel.adapter.beginOAuth(), GithubAdapterNotImplementedError);
});

test("selectGithubAdapter falls back to the stub when OAuth is not configured", async () => {
  const sel = selectGithubAdapter({
    env: {},
    tokenStore: new InMemoryOAuthTokenStore(),
  });
  assert.equal(sel.choice, "stub");
  assert.ok(sel.adapter instanceof StubGithubAdapter);
  await assert.rejects(() => sel.adapter.beginOAuth(), GithubAdapterNotImplementedError);
});
