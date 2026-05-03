// AdDroid OSS — MockGithubAdapter.
//
// `ADDROID_GITHUB_OAUTH_MOCK=1` のときに採用される、ネットワークを一切使わない
// 実装。the current implementation の test seam でもあり、PR ポーリングのフィクスチャを差し込んで
// merged PR 検知の挙動を本番と同じコードパスで検証できる。
//
// 重要 — ハードコードされた個人 GitHub アカウント名は使わない。
// 既定 owner は "addroid-mock-user" のような汎用ラベルで、テストや UI から
// 上書きできる。

import {
  GithubAdapterUnauthenticatedError,
  GithubMergeFailedError,
  GithubOAuthStateMismatchError,
  type BootstrapOpsRepoInput,
  type BootstrapOpsRepoResult,
  type CreatePullRequestInput,
  type CreatePullRequestResult,
  type GithubAdapter,
  type MergePullRequestInput,
  type MergePullRequestResult,
  type OAuthConnection,
  type OpsRepoSpec,
  type PullRequestPollResult,
  type PullRequestSummary,
} from "./types.js";
import {
  ADDROID_REQUIRED_SCOPES,
  generateOAuthState,
} from "./oauth.js";
import type { OAuthTokenStore } from "./token-store.js";

export interface MockGithubAdapterOptions {
  tokenStore: OAuthTokenStore;
  /** owner として記録する mock アカウント名。既定 "addroid-mock-user"。 */
  mockAccount?: string;
  /** PR フィクスチャ (`pollPullRequests` の応答列)。テストで上書きする。 */
  pullRequestSequence?: PullRequestSummary[][];
  /** `pollPullRequests` の戻り ETag。既定では呼び出しごとにインクリメントする。 */
  etagSeed?: string;
  /** 暗号化された access token として保存する文字列 (test seam)。
   *  既定は `"mock-encrypted::<random>"`。本物の暗号化器を呼ばずに ciphertext 形を満たす。 */
  fakeCiphertext?: string;
}

const DEFAULT_MOCK_ACCOUNT = "addroid-mock-user";
const MOCK_AUTH_BASE = "https://addroid.invalid/mock-oauth/authorize";

export class MockGithubAdapter implements GithubAdapter {
  private readonly tokenStore: OAuthTokenStore;
  private readonly mockAccount: string;
  private readonly fakeCiphertextSeed: string;
  private prSequence: PullRequestSummary[][];
  private repos = new Map<string, { spec: OpsRepoSpec; bootstrappedAt: string; files: number; protectionApplied: boolean; prState: PullRequestSummary[] }>();
  private etagCounter = 0;
  private lastEtag: string;
  private pendingState: string | null = null;
  private prCounter = 0;
  private createdPullRequests: Array<
    CreatePullRequestInput & { number: number; headSha: string; htmlUrl: string }
  > = [];

  constructor(opts: MockGithubAdapterOptions) {
    this.tokenStore = opts.tokenStore;
    this.mockAccount = opts.mockAccount ?? DEFAULT_MOCK_ACCOUNT;
    this.fakeCiphertextSeed = opts.fakeCiphertext ?? "mock-encrypted";
    this.prSequence = opts.pullRequestSequence
      ? [...opts.pullRequestSequence]
      : [];
    this.lastEtag = opts.etagSeed ?? "mock-etag-0";
  }

  async beginOAuth(): Promise<{ authorizationUrl: string; state: string }> {
    const state = generateOAuthState();
    this.pendingState = state;
    const params = new URLSearchParams({
      state,
      account: this.mockAccount,
      scope: ADDROID_REQUIRED_SCOPES.join(" "),
    });
    return {
      authorizationUrl: `${MOCK_AUTH_BASE}?${params.toString()}`,
      state,
    };
  }

  async completeOAuth(params: { code: string; state: string }): Promise<OAuthConnection> {
    if (this.pendingState && params.state !== this.pendingState) {
      throw new GithubOAuthStateMismatchError();
    }
    this.pendingState = null;
    const connectedAt = new Date();
    const ciphertext = `${this.fakeCiphertextSeed}::${params.code}`;
    await this.tokenStore.saveOAuthToken({
      provider: "github",
      accountIdentifier: this.mockAccount,
      scopes: [...ADDROID_REQUIRED_SCOPES],
      accessTokenCiphertext: ciphertext,
      connectedAt,
    });
    return {
      provider: "github",
      accountIdentifier: this.mockAccount,
      scopes: [...ADDROID_REQUIRED_SCOPES],
      connectedAt: connectedAt.toISOString(),
    };
  }

  async bootstrapOpsRepo(input: BootstrapOpsRepoInput): Promise<BootstrapOpsRepoResult> {
    const token = await this.tokenStore.loadOAuthToken("github");
    if (!token) throw new GithubAdapterUnauthenticatedError("bootstrap ops repo");
    const owner = token.accountIdentifier;
    const defaultBranch = input.defaultBranch ?? "main";
    const spec: OpsRepoSpec = { owner, name: input.desiredName, defaultBranch };
    const bootstrappedAt = new Date().toISOString();
    const fileCount = countTemplateFiles(input);
    this.repos.set(repoKey(spec), {
      spec,
      bootstrappedAt,
      files: fileCount,
      protectionApplied: true,
      prState: [],
    });
    return {
      owner,
      name: input.desiredName,
      defaultBranch,
      bootstrappedAt,
      filesCommitted: fileCount,
      branchProtectionApplied: true,
    };
  }

  async pollPullRequests(
    spec: OpsRepoSpec,
    prev: { etag?: string }
  ): Promise<PullRequestPollResult> {
    const token = await this.tokenStore.loadOAuthToken("github");
    if (!token) throw new GithubAdapterUnauthenticatedError("poll pull requests");
    // フィクスチャがあれば 1 件ずつ消費。空ならば 304 (notModified) を返す。
    const next = this.prSequence.shift();
    if (next === undefined) {
      return {
        notModified: true,
        etag: prev.etag,
        pullRequests: [],
      };
    }
    this.etagCounter += 1;
    this.lastEtag = `mock-etag-${this.etagCounter}`;
    const repo = this.repos.get(repoKey(spec));
    if (repo) repo.prState = next;
    return {
      notModified: false,
      etag: this.lastEtag,
      pullRequests: next,
    };
  }

  async createPullRequest(
    input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult> {
    const token = await this.tokenStore.loadOAuthToken("github");
    if (!token) throw new GithubAdapterUnauthenticatedError("create pull request");
    this.prCounter += 1;
    const number = this.prCounter;
    const headSha = `mock-sha-${this.prCounter.toString(16).padStart(40, "0")}`;
    const htmlUrl = `https://addroid.invalid/${input.spec.owner}/${input.spec.name}/pull/${number}`;
    this.createdPullRequests.push({
      ...input,
      number,
      headSha,
      htmlUrl,
    });
    return { number, htmlUrl, headSha };
  }

  async mergePullRequest(
    input: MergePullRequestInput
  ): Promise<MergePullRequestResult> {
    const token = await this.tokenStore.loadOAuthToken("github");
    if (!token) throw new GithubAdapterUnauthenticatedError("merge pull request");
    const repo = this.repos.get(repoKey(input.spec));
    if (!repo) {
      throw new GithubMergeFailedError(
        404,
        `mock: repo ${input.spec.owner}/${input.spec.name} is not bootstrapped.`
      );
    }
    const target = repo.prState.find((pr) => pr.number === input.number);
    if (!target) {
      throw new GithubMergeFailedError(
        404,
        `mock: PR #${input.number} not found in ${input.spec.owner}/${input.spec.name}.`
      );
    }
    if (target.state === "merged") {
      throw new GithubMergeFailedError(
        405,
        `mock: PR #${input.number} is already merged.`
      );
    }
    if (target.state === "closed") {
      throw new GithubMergeFailedError(
        409,
        `mock: PR #${input.number} is closed and cannot be merged.`
      );
    }
    if (
      input.expectedHeadSha !== undefined &&
      input.expectedHeadSha !== target.headSha
    ) {
      throw new GithubMergeFailedError(
        409,
        `mock: PR #${input.number} HEAD changed (expected ${input.expectedHeadSha}, got ${target.headSha}).`
      );
    }
    target.state = "merged";
    target.mergedAt = new Date().toISOString();
    const sha = `mock-merge-sha-${input.number.toString(16).padStart(40, "0")}`;
    return {
      sha,
      merged: true,
      message: `mock merged via ${input.mergeMethod ?? "merge"}`,
    };
  }

  // ---- test helpers (本番コードからは使わない) ----

  /** 後続呼び出しの戻り値となる PR フィクスチャを enqueue する。 */
  enqueuePullRequests(pulls: PullRequestSummary[]): void {
    this.prSequence.push(pulls);
  }

  /** 直近に bootstrap した repo のスナップショットを返す (テスト用)。 */
  inspectRepo(spec: OpsRepoSpec) {
    return this.repos.get(repoKey(spec)) ?? null;
  }

  /** 直近の createPullRequest 呼び出しを返す (テスト用)。 */
  listCreatedPullRequests(): ReadonlyArray<
    CreatePullRequestInput & { number: number; headSha: string; htmlUrl: string }
  > {
    return this.createdPullRequests;
  }
}

function repoKey(spec: OpsRepoSpec): string {
  return `${spec.owner}/${spec.name}`;
}

function countTemplateFiles(input: BootstrapOpsRepoInput): number {
  // ops-template が出力する 5 ファイルを表す。実装が変わっても adapter のテストが
  // 壊れないよう、ここでは固定値ではなく input を使ってカウントする方が望ましいが、
  // input には template ファイルが含まれないため固定 5 を採用する。
  void input;
  return 5;
}
