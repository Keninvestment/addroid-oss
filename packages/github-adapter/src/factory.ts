// AdDroid OSS — adapter factory.
//
// 実行環境に応じて GithubAdapter 実装を選択する。優先度:
//   1. ADDROID_GITHUB_OAUTH_MOCK=1   → MockGithubAdapter
//   2. OAuth client config が揃う    → OctokitGithubAdapter
//   3. それ以外                       → StubGithubAdapter (= 旧来の skeleton 挙動)
//
// 個人アカウント名や client secret はこの関数の引数 / 環境変数からのみ流入し、
// コード内に literal を残さない。

import type { OpsTemplateFile } from "@addroid/ops-template";
import { MockGithubAdapter, type MockGithubAdapterOptions } from "./mock.js";
import {
  OctokitGithubAdapter,
  createDefaultGithubApiClient,
  type CryptoEncryptDecrypt,
  type GithubApiClient,
} from "./octokit-adapter.js";
import type { OAuthClientConfig } from "./oauth.js";
import { StubGithubAdapter } from "./stub.js";
import type { OAuthTokenStore } from "./token-store.js";
import type {
  CreatePullRequestFile,
  GithubAdapter,
  PullRequestSummary,
} from "./types.js";

export interface SelectGithubAdapterOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore: OAuthTokenStore;
  /**
   * `getCryptoBoundary()` 由来のオブジェクトを渡す。Octokit adapter のみが利用する。
   * 未設定で Octokit を選ぶ条件を満たした場合、設定要求エラーを投げる代わりに Stub を返す。
   */
  crypto?: CryptoEncryptDecrypt;
  /**
   * OAuth client (clientId / clientSecret / redirectUri)。secrets.local.yaml から
   * 解決して渡すのが想定。無い場合でも storedTokenAvailable=true なら
   * GitHub API 操作用の Octokit パスを選べる。
   */
  oauthClient?: OAuthClientConfig | null;
  /**
   * CLI / gh device flow で既に暗号化済み GitHub token が保存されている場合は、
   * Web OAuth client が無くても GitHub API 操作用の Octokit adapter を選べる。
   */
  storedTokenAvailable?: boolean;
  /**
   * Mock adapter の追加オプション (テストや UI demo の制御用)。
   */
  mock?: Omit<MockGithubAdapterOptions, "tokenStore">;
}

export type AdapterChoice = "mock" | "octokit" | "stub";

export interface AdapterSelection {
  adapter: GithubAdapter;
  choice: AdapterChoice;
  reason: string;
}

export function selectGithubAdapter(opts: SelectGithubAdapterOptions): AdapterSelection {
  const env = opts.env ?? process.env;
  if (env.ADDROID_GITHUB_OAUTH_MOCK === "1") {
    return {
      adapter: new MockGithubAdapter({ tokenStore: opts.tokenStore, ...(opts.mock ?? {}) }),
      choice: "mock",
      reason: "ADDROID_GITHUB_OAUTH_MOCK=1",
    };
  }
  if ((opts.oauthClient || opts.storedTokenAvailable) && opts.crypto) {
    return {
      adapter: new OctokitGithubAdapter({
        oauthClient: opts.oauthClient ?? null,
        tokenStore: opts.tokenStore,
        crypto: opts.crypto,
        apiClientFactory: (accessToken) =>
          new LazyGithubApiClient(() => createDefaultGithubApiClient(accessToken)),
      }),
      choice: "octokit",
      reason: opts.oauthClient
        ? "OAuth client + crypto boundary configured"
        : "stored GitHub OAuth token + crypto boundary configured",
    };
  }
  return {
    adapter: new StubGithubAdapter(),
    choice: "stub",
    reason: missingReason(opts),
  };
}

function missingReason(opts: SelectGithubAdapterOptions): string {
  const missing: string[] = [];
  if (!opts.oauthClient && !opts.storedTokenAvailable) missing.push("oauthClient");
  if (!opts.crypto) missing.push("crypto");
  return `OAuth not configured (missing: ${missing.join(", ") || "n/a"})`;
}

// ---------------------------------------------------------------------
// LazyGithubApiClient — `createDefaultGithubApiClient` は `@octokit/rest` を
// dynamic import するため Promise を返す。OctokitGithubAdapter の同期的な
// `apiClientFactory` interface を満たすために、各メソッドで解決を遅延する。
// ---------------------------------------------------------------------

class LazyGithubApiClient implements GithubApiClient {
  private cached: Promise<GithubApiClient> | null = null;
  constructor(private readonly factory: () => Promise<GithubApiClient>) {}
  private resolve(): Promise<GithubApiClient> {
    if (!this.cached) this.cached = this.factory();
    return this.cached;
  }
  async getAuthenticatedUserLogin(): Promise<string> {
    return (await this.resolve()).getAuthenticatedUserLogin();
  }
  async createUserRepo(input: {
    name: string;
    isPrivate: boolean;
    defaultBranch: string;
  }): Promise<{ owner: string; name: string; defaultBranch: string }> {
    return (await this.resolve()).createUserRepo(input);
  }
  async commitTemplateFiles(input: {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: OpsTemplateFile[];
  }): Promise<{ commitSha: string; filesCommitted: number }> {
    return (await this.resolve()).commitTemplateFiles(input);
  }
  async listPullRequests(input: {
    owner: string;
    repo: string;
    etag?: string;
  }): Promise<{
    status: number;
    etag?: string;
    lastModified?: string;
    pullRequests: PullRequestSummary[];
  }> {
    return (await this.resolve()).listPullRequests(input);
  }
  async createPullRequest(input: {
    owner: string;
    repo: string;
    branch: string;
    baseRef: string;
    title: string;
    body: string;
    files: CreatePullRequestFile[];
    commitMessage: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }> {
    return (await this.resolve()).createPullRequest(input);
  }
  async readFileAtRef(input: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<{ content: string }> {
    const client = await this.resolve();
    if (!client.readFileAtRef) {
      throw new Error("GitHub API client cannot read files at an exact ref");
    }
    return client.readFileAtRef(input);
  }
  async listPullRequestFiles(input: {
    owner: string;
    repo: string;
    number: number;
  }) {
    const client = await this.resolve();
    if (!client.listPullRequestFiles) {
      throw new Error("GitHub API client cannot list complete PR files");
    }
    return client.listPullRequestFiles(input);
  }
  async mergePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    expectedHeadSha?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
  }): Promise<{ sha: string; merged: boolean; message: string }> {
    return (await this.resolve()).mergePullRequest(input);
  }
}
