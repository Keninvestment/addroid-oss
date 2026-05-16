import test from "node:test";
import assert from "node:assert/strict";
import {
  GithubAdapterUnauthenticatedError,
  GithubMergeFailedError,
  GithubOAuthStateMismatchError,
  InMemoryOAuthTokenStore,
  MockGithubAdapter,
} from "../index.js";

const BOOTSTRAP_INPUT = {
  workspaceSlug: "default",
  workspaceDisplayName: "Default Workspace",
  initialAccountKey: "primary",
  initialAccountDisplayName: "Primary Account",
  desiredName: "addroid-ops",
};

test("MockGithubAdapter.completeOAuth rejects mismatched state (CSRF)", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({ tokenStore: store });
  await adapter.beginOAuth();
  await assert.rejects(
    () => adapter.completeOAuth({ code: "x", state: "wrong" }),
    GithubOAuthStateMismatchError
  );
});

test("MockGithubAdapter.completeOAuth persists a connection record", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({ tokenStore: store, mockAccount: "test-mock" });
  const begin = await adapter.beginOAuth();
  const conn = await adapter.completeOAuth({ code: "auth-code-1", state: begin.state });
  assert.equal(conn.provider, "github");
  assert.equal(conn.accountIdentifier, "test-mock");
  assert.ok(conn.scopes.includes("repo"));
  const stored = await store.loadOAuthToken("github");
  assert.ok(stored, "token store should have a record after completeOAuth");
  assert.equal(stored?.accountIdentifier, "test-mock");
  assert.match(stored?.accessTokenCiphertext ?? "", /auth-code-1/);
});

test("MockGithubAdapter.bootstrapOpsRepo requires an OAuth connection first", async () => {
  const adapter = new MockGithubAdapter({ tokenStore: new InMemoryOAuthTokenStore() });
  await assert.rejects(
    () => adapter.bootstrapOpsRepo(BOOTSTRAP_INPUT),
    GithubAdapterUnauthenticatedError
  );
});

test("MockGithubAdapter.bootstrapOpsRepo records ops repo with template files", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({ tokenStore: store, mockAccount: "test-mock" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.bootstrapOpsRepo(BOOTSTRAP_INPUT);
  assert.equal(result.owner, "test-mock");
  assert.equal(result.name, "addroid-ops");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.filesCommitted, 5);
  const snap = adapter.inspectRepo({
    owner: result.owner,
    name: result.name,
    defaultBranch: result.defaultBranch,
  });
  assert.ok(snap, "repo should be tracked in mock state");
});

test("MockGithubAdapter.pollPullRequests is unauthenticated when no token has been saved", async () => {
  const adapter = new MockGithubAdapter({ tokenStore: new InMemoryOAuthTokenStore() });
  await assert.rejects(
    () =>
      adapter.pollPullRequests(
        { owner: "x", name: "y", defaultBranch: "main" },
        {}
      ),
    GithubAdapterUnauthenticatedError
  );
});

test("MockGithubAdapter.pollPullRequests returns 304-equivalent when no fixture is enqueued", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({ tokenStore: store });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.pollPullRequests(
    { owner: "addroid-mock-user", name: "ops", defaultBranch: "main" },
    { etag: "prev-etag" }
  );
  assert.equal(result.notModified, true);
  assert.equal(result.etag, "prev-etag");
  assert.deepEqual(result.pullRequests, []);
});

test("MockGithubAdapter.pollPullRequests delivers enqueued fixtures and advances ETag", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({
    tokenStore: store,
    mockAccount: "mock-acct",
  });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  await adapter.bootstrapOpsRepo({ ...BOOTSTRAP_INPUT, desiredName: "ops" });
  adapter.enqueuePullRequests([
    {
      number: 1,
      title: "open one",
      state: "open",
      headSha: "sha-1",
      baseRef: "main",
      htmlUrl: "https://example.invalid/1",
      mergedAt: null,
    },
    {
      number: 2,
      title: "merged one",
      state: "merged",
      headSha: "sha-2",
      baseRef: "main",
      htmlUrl: "https://example.invalid/2",
      mergedAt: "2026-05-01T00:00:00.000Z",
    },
  ]);
  const result = await adapter.pollPullRequests(
    { owner: "mock-acct", name: "ops", defaultBranch: "main" },
    {}
  );
  assert.equal(result.notModified, false);
  assert.equal(result.pullRequests.length, 2);
  assert.match(result.etag ?? "", /^mock-etag-\d+$/);
});

test("MockGithubAdapter.mergePullRequest marks an open PR fixture as merged and returns a sha", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({ tokenStore: store, mockAccount: "mock-acct" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  await adapter.bootstrapOpsRepo({ ...BOOTSTRAP_INPUT, desiredName: "ops" });
  adapter.enqueuePullRequests([
    {
      number: 7,
      title: "open seven",
      state: "open",
      headSha: "sha-7",
      baseRef: "main",
      htmlUrl: "https://example.invalid/7",
      mergedAt: null,
    },
  ]);
  await adapter.pollPullRequests(
    { owner: "mock-acct", name: "ops", defaultBranch: "main" },
    {}
  );
  const result = await adapter.mergePullRequest({
    spec: { owner: "mock-acct", name: "ops", defaultBranch: "main" },
    number: 7,
    expectedHeadSha: "sha-7",
    mergeMethod: "merge",
  });
  assert.equal(result.merged, true);
  assert.match(result.sha, /^mock-merge-sha-/);
});

test("MockGithubAdapter.mergePullRequest rejects when expectedHeadSha mismatches the fixture", async () => {
  const store = new InMemoryOAuthTokenStore();
  const adapter = new MockGithubAdapter({ tokenStore: store, mockAccount: "mock-acct" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  await adapter.bootstrapOpsRepo({ ...BOOTSTRAP_INPUT, desiredName: "ops" });
  adapter.enqueuePullRequests([
    {
      number: 8,
      title: "open eight",
      state: "open",
      headSha: "sha-8",
      baseRef: "main",
      htmlUrl: "https://example.invalid/8",
      mergedAt: null,
    },
  ]);
  await adapter.pollPullRequests(
    { owner: "mock-acct", name: "ops", defaultBranch: "main" },
    {}
  );
  await assert.rejects(
    () =>
      adapter.mergePullRequest({
        spec: { owner: "mock-acct", name: "ops", defaultBranch: "main" },
        number: 8,
        expectedHeadSha: "stale",
      }),
    GithubMergeFailedError
  );
});
