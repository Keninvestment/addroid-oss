// AdDroid OSS — `@addroid/github-adapter` barrel.
//
// adapter pattern の各実装と、OAuth/Token store の境界を集約して export する。
// 既存の `getGithubAdapter` / `injectGithubAdapter` / `resetGithubAdapter` API は
// apps/worker と queue 側の互換のため維持する。

import { StubGithubAdapter } from "./stub.js";
import type { GithubAdapter } from "./types.js";

export {
  GithubAdapterNotImplementedError,
  GithubAdapterUnauthenticatedError,
  GithubMergeFailedError,
  GithubOAuthStateMismatchError,
  type BootstrapOpsRepoInput,
  type BootstrapOpsRepoResult,
  type CreatePullRequestFile,
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

export { StubGithubAdapter } from "./stub.js";
export { MockGithubAdapter, type MockGithubAdapterOptions } from "./mock.js";
export {
  OctokitGithubAdapter,
  createDefaultGithubApiClient,
  wrapOctokitAsApiClient,
  type CryptoEncryptDecrypt,
  type GithubApiClient,
  type OctokitGithubAdapterDeps,
} from "./octokit-adapter.js";
export {
  ADDROID_REQUIRED_SCOPES,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  OAuthExchangeError,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generateOAuthState,
  type ExchangeCodeForTokenOptions,
  type ExchangedToken,
  type OAuthClientConfig,
} from "./oauth.js";
export {
  InMemoryOAuthTokenStore,
  type GithubTokenProvider,
  type OAuthTokenRecord,
  type OAuthTokenStore,
} from "./token-store.js";
export {
  buildTemplateFiles,
  templateFilesToTreeEntries,
  type TreeEntry,
} from "./template-commit.js";
export {
  selectGithubAdapter,
  type AdapterChoice,
  type AdapterSelection,
  type SelectGithubAdapterOptions,
} from "./factory.js";

// ---------------------------------------------------------------------
// 旧 API: グローバル singleton による adapter 注入。
// apps/worker は selectGithubAdapter の結果を `injectGithubAdapter` で差し込む。
// テストは `resetGithubAdapter` で StubGithubAdapter に戻す。
// ---------------------------------------------------------------------

let active: GithubAdapter = new StubGithubAdapter();

export function getGithubAdapter(): GithubAdapter {
  return active;
}

export function injectGithubAdapter(impl: GithubAdapter): void {
  active = impl;
}

export function resetGithubAdapter(): void {
  active = new StubGithubAdapter();
}
