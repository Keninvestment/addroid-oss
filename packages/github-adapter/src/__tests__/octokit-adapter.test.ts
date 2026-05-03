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
  protections: { owner: string; repo: string; branch: string }[];
  polls: { owner: string; repo: string; etag?: string }[];
}

class FakeApiClient implements GithubApiClient {
  calls: FakeApiCalls = { templateCommits: [], protections: [], polls: [] };
  constructor(
    private readonly accessToken: string,
    private readonly login: string,
    private readonly options: {
      protectionWillFail?: boolean;
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

  async setBranchProtection(input: { owner: string; repo: string; branch: string }) {
    this.calls.protections.push({ ...input });
    if (this.options.protectionWillFail) {
      return { applied: false, reason: "test-forbidden" };
    }
    return { applied: true };
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
  protectionWillFail?: boolean;
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
        ...(opts.protectionWillFail !== undefined ? { protectionWillFail: opts.protectionWillFail } : {}),
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

test("OctokitGithubAdapter.bootstrapOpsRepo creates a private repo, commits the template files, and applies branch protection", async () => {
  const { adapter, getLastApi } = makeAdapter({ login: "octo-test-user" });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.bootstrapOpsRepo(BOOTSTRAP_INPUT);
  assert.equal(result.owner, "octo-test-user");
  assert.equal(result.name, "addroid-ops");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.filesCommitted, 7);
  assert.equal(result.branchProtectionApplied, true);
  const api = getLastApi();
  assert.ok(api);
  assert.equal(api?.calls.createdRepo?.isPrivate, true);
  // Template should include the required files plus the
  // this implementation budget_guard policy.
  const paths = api?.calls.templateCommits[0]?.files.map((f) => f.path).sort() ?? [];
  assert.deepEqual(paths.sort(), [
    ".addroid/project.yaml",
    ".github/workflows/addroid-validate.yml",
    "README.md",
    "ads/accounts/primary/brand.yaml",
    "workflows/automation-rules.yaml",
    "workflows/budget-guard.yaml",
    "workflows/cron.yaml",
  ].sort());
  assert.equal(api?.calls.protections.length, 1);
});

test("OctokitGithubAdapter.bootstrapOpsRepo reports branch protection failure as fail-soft", async () => {
  const { adapter } = makeAdapter({ login: "octo-test-user", protectionWillFail: true });
  const begin = await adapter.beginOAuth();
  await adapter.completeOAuth({ code: "c", state: begin.state });
  const result = await adapter.bootstrapOpsRepo(BOOTSTRAP_INPUT);
  assert.equal(result.branchProtectionApplied, false);
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
