import test from "node:test";
import assert from "node:assert/strict";
import {
  GithubAdapterUnauthenticatedError,
  GithubOAuthStateMismatchError,
  InMemoryOAuthTokenStore,
  OctokitGithubAdapter,
  type GithubApiClient,
  type CryptoEncryptDecrypt,
  type OAuthClientConfig,
  type PullRequestSummary,
} from "../index.js";
import type { OpsTemplateFile } from "@addroid/ops-template";

type PollScriptEntry =
  | { status: 200; etag?: string; lastModified?: string; pullRequests: PullRequestSummary[] }
  | { status: 304; etag?: string };

const CLIENT: OAuthClientConfig = {
  clientId: "Iv1.example",
  clientSecret: "shhh",
  redirectUri: "http://127.0.0.1:3000/api/oauth/github/callback",
};

class FakeCrypto implements CryptoEncryptDecrypt {
  encrypt(plaintext: string): string {
    return `enc::${plaintext}`;
  }
  decrypt(ciphertext: string): string {
    if (!ciphertext.startsWith("enc::")) throw new Error("bad ciphertext");
    return ciphertext.slice("enc::".length);
  }
}

interface FakeApiCalls {
  authedAs?: string;
  createdRepo?: { name: string; isPrivate: boolean; defaultBranch: string };
  templateCommits: {
    owner: string;
    repo: string;
    branch: string;
    files: OpsTemplateFile[];
    message: string;
  }[];
  polls: { owner: string; repo: string; etag?: string }[];
  reads: { owner: string; repo: string; path: string; ref: string }[];
}

class FakeApiClient implements GithubApiClient {
  calls: FakeApiCalls = { templateCommits: [], polls: [], reads: [] };
  constructor(
    private readonly accessToken: string,
    private readonly login: string,
    private readonly options: {
      pollScript?: PollScriptEntry[];
    } = {}
  ) {}

  /** test-only — verify the token was actually plumbed through. */
  observedToken(): string {
    return this.accessToken;
  }

  async getAuthenticatedUserLogin(): Promise<string> {
    this.calls.authedAs = this.login;
    return this.login;
  }

  async createUserRepo(input: { name: string; isPrivate: boolean; defaultBranch: string }) {
    this.calls.createdRepo = { ...input };
    return { owner: this.login, name: input.name, defaultBranch: input.defaultBranch };
  }

  async commitTemplateFiles(input: {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: OpsTemplateFile[];
  }) {
    this.calls.templateCommits.push({ ...input });
    return { commitSha: "fake-sha", filesCommitted: input.files.length };
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    branch: string;
    baseRef: string;
    title: string;
    body: string;
    files: { path: string; diff: string; action: "create" | "update" | "delete" }[];
    commitMessage: string;
  }) {
    void input;
    return {
      number: 1,
      htmlUrl: `https://addroid.invalid/${input.owner}/${input.repo}/pull/1`,
      headSha: "fake-pr-head-sha",
    };
  }

  async readFileAtRef(input: { owner: string; repo: string; path: string; ref: string }) {
    this.calls.reads.push(input);
    return { content: "exact proposal bytes\n" };
  }

  async mergePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    expectedHeadSha?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
  }) {
    void input;
    return {
      sha: `fake-merge-sha-${input.number}`,
      merged: true,
      message: "fake merged",
    };
  }

  async listPullRequests(input: { owner: string; repo: string; etag?: string }) {
    this.calls.polls.push({ ...input });
    const next = (this.options.pollScript ?? []).shift();
    if (!next) {
      return { status: 200, pullRequests: [] };
    }
    if (next.status === 304) {
      const out: {
        status: number;
        etag?: string;
        pullRequests: never[];
      } = { status: 304, pullRequests: [] };
      if (next.etag !== undefined) out.etag = next.etag;
      return out;
    }
    const out: {
      status: number;
      etag?: string;
      lastModified?: string;
      pullRequests: typeof next.pullRequests;
    } = { status: 200, pullRequests: next.pullRequests };
    if (next.etag !== undefined) out.etag = next.etag;
    if (next.lastModified !== undefined) out.lastModified = next.lastModified;
    return out;
  }
}

const BOOTSTRAP_INPUT = {
  workspaceSlug: "default",
  workspaceDisplayName: "Default Workspace",
  initialAccountKey: "primary",
  initialAccountDisplayName: "Primary Account",
  desiredName: "addroid-ops",
};

function makeAdapter(opts: {
  login?: string;
  pollScript?: PollScriptEntry[];
} = {}) {
  const tokenStore = new InMemoryOAuthTokenStore();
  const crypto = new FakeCrypto();
  let lastApi: FakeApiClient | null = null;
  const adapter = new OctokitGithubAdapter({
    oauthClient: CLIENT,
    tokenStore,
    crypto,
    apiClientFactory: (accessToken) => {
      lastApi = new FakeApiClient(accessToken, opts.login ?? "octo-test-user", {
        ...(opts.pollScript !== undefined ? { pollScript: opts.pollScript } : {}),
      });
      return lastApi;
    },
    exchangeCode: async ({ code }) => ({
      accessToken: `gho_${code}`,
      grantedScopes: ["repo"],
    }),
  });
  return { adapter, tokenStore, crypto, getLastApi: () => lastApi };
}

test("OctokitGithubAdapter.completeOAuth state mismatch is rejected", async () => {
  const { adapter } = makeAdapter();
  await adapter.beginOAuth();
  await assert.rejects(
    () => adapter.completeOAuth({ code: "x", state: "stale" }),
    GithubOAuthStateMismatchError
  );
});

test("OctokitGithubAdapter.completeOAuth encrypts the access token before persisting", async () => {
  const { adapter, tokenStore } = makeAdapter({ login: "octo-test-user" });
  const begin = await adapter.beginOAuth();
  const conn = await adapter.completeOAuth({ code: "the-code", state: begin.state });
  assert.equal(conn.accountIdentifier, "octo-test-user");
  const stored = await tokenStore.loadOAuthToken("github");
  assert.ok(stored);
  // Token store must never see the plaintext.
  assert.equal(stored?.accessTokenCiphertext, "enc::gho_the-code");
  assert.equal(/^gho_/.test(stored?.accessTokenCiphertext ?? ""), false);
});

test("OctokitGithubAdapter.bootstrapOpsRepo creates a private repo and commits the template files", async () => {
  const { adapter, getLastApi } = makeAdapter({ login: "octo-test-user" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.bootstrapOpsRepo(BOOTSTRAP_INPUT);
  assert.equal(result.owner, "octo-test-user");
  assert.equal(result.name, "addroid-ops");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.filesCommitted, 8);
  const api = getLastApi();
  assert.ok(api);
  assert.equal(api?.calls.createdRepo?.isPrivate, true);
  // Template should include the required files plus the managed policy files.
  const paths = api?.calls.templateCommits[0]?.files.map((f) => f.path).sort() ?? [];
  assert.deepEqual(paths.sort(), [
    ".addroid/project.yaml",
    ".github/workflows/addroid-validate.yml",
    "README.md",
    "operations/.gitkeep",
    "workflows/automation-rules.yaml",
    "workflows/budget-guard.yaml",
    "workflows/cron.yaml",
    "workflows/guards.yaml",
  ].sort());
});

test("OctokitGithubAdapter.bootstrapOpsRepo keeps template account-independent", async () => {
  const { adapter, getLastApi } = makeAdapter({ login: "octo-test-user" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.bootstrapOpsRepo({
    ...BOOTSTRAP_INPUT,
    initialAccounts: [
      { key: "primary", displayName: "Primary Account" },
      { key: "act_222", displayName: "Second Account" },
      { key: "act_333", displayName: "Third Account" },
    ],
  });
  assert.equal(result.filesCommitted, 8);
  const paths = getLastApi()?.calls.templateCommits[0]?.files.map((f) => f.path).sort() ?? [];
  assert.ok(paths.includes("operations/.gitkeep"));
  const legacyAccountsPrefix = ["ads", "accounts"].join("/") + "/";
  assert.equal(paths.some((p) => p.startsWith(legacyAccountsPrefix)), false);
});

test("OctokitGithubAdapter.bootstrapOpsRepo refuses without a connected token", async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(
    () => adapter.bootstrapOpsRepo(BOOTSTRAP_INPUT),
    GithubAdapterUnauthenticatedError
  );
});

test("OctokitGithubAdapter.pollPullRequests forwards previous ETag and surfaces 304", async () => {
  const { adapter, getLastApi } = makeAdapter({
    login: "octo-test-user",
    pollScript: [{ status: 304, etag: "etag-prev" }],
  });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.pollPullRequests(
    { owner: "octo-test-user", name: "addroid-ops", defaultBranch: "main" },
    { etag: "etag-prev" }
  );
  assert.equal(result.notModified, true);
  assert.equal(result.etag, "etag-prev");
  const api = getLastApi();
  assert.equal(api?.calls.polls[0]?.etag, "etag-prev");
});

test("OctokitGithubAdapter.pollPullRequests returns the API's PR list and ETag on 200", async () => {
  const pull = {
    number: 11,
    title: "ops update",
    state: "merged" as const,
    headSha: "sha-11",
    baseRef: "main",
    htmlUrl: "https://example.invalid/11",
    mergedAt: "2026-05-01T01:00:00.000Z",
  };
  const { adapter } = makeAdapter({
    login: "octo-test-user",
    pollScript: [{ status: 200, etag: "etag-new", pullRequests: [pull] }],
  });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.pollPullRequests(
    { owner: "octo-test-user", name: "addroid-ops", defaultBranch: "main" },
    {}
  );
  assert.equal(result.notModified, false);
  assert.equal(result.etag, "etag-new");
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.pullRequests[0]?.state, "merged");
});

test("OctokitGithubAdapter.pollPullRequests refuses without a token", async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(
    () =>
      adapter.pollPullRequests(
        { owner: "x", name: "y", defaultBranch: "main" },
        {}
      ),
    GithubAdapterUnauthenticatedError
  );
});

test("OctokitGithubAdapter reads proposal bytes from the exact requested PR head", async () => {
  const { adapter, getLastApi } = makeAdapter({ login: "octo-test-user" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });

  const result = await adapter.readPullRequestFile({
    spec: { owner: "octo-test-user", name: "addroid-ops", defaultBranch: "main" },
    number: 17,
    path: "proposals/automation/rule/proposal.json",
    expectedHeadSha: "exact-head-sha",
  });

  assert.deepEqual(result, { content: "exact proposal bytes\n", headSha: "exact-head-sha" });
  assert.deepEqual(getLastApi()?.calls.reads, [{
    owner: "octo-test-user",
    repo: "addroid-ops",
    path: "proposals/automation/rule/proposal.json",
    ref: "exact-head-sha",
  }]);
});
