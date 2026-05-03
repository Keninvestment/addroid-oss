// AdDroid OSS — StubGithubAdapter.
//
// 何も設定されていない状態 (OAuth 未設定 + mock も無効) で `getGithubAdapter()` から
// 返される既定実装。すべてのメソッドが GithubAdapterNotImplementedError を投げ、
// UI と worker がエラーメッセージから次のアクションを案内できるようにする。

import {
  GithubAdapter,
  GithubAdapterNotImplementedError,
  type BootstrapOpsRepoInput,
  type BootstrapOpsRepoResult,
  type CreatePullRequestInput,
  type CreatePullRequestResult,
  type MergePullRequestInput,
  type MergePullRequestResult,
  type OAuthConnection,
  type OpsRepoSpec,
  type PullRequestPollResult,
} from "./types.js";

export class StubGithubAdapter implements GithubAdapter {
  beginOAuth(): Promise<{ authorizationUrl: string; state: string }> {
    return Promise.reject(new GithubAdapterNotImplementedError("beginOAuth"));
  }
  completeOAuth(_params: { code: string; state: string }): Promise<OAuthConnection> {
    return Promise.reject(new GithubAdapterNotImplementedError("completeOAuth"));
  }
  bootstrapOpsRepo(_input: BootstrapOpsRepoInput): Promise<BootstrapOpsRepoResult> {
    return Promise.reject(new GithubAdapterNotImplementedError("bootstrapOpsRepo"));
  }
  pollPullRequests(
    _spec: OpsRepoSpec,
    _prev: { etag?: string }
  ): Promise<PullRequestPollResult> {
    return Promise.reject(new GithubAdapterNotImplementedError("pollPullRequests"));
  }
  createPullRequest(
    _input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult> {
    return Promise.reject(new GithubAdapterNotImplementedError("createPullRequest"));
  }
  mergePullRequest(
    _input: MergePullRequestInput
  ): Promise<MergePullRequestResult> {
    return Promise.reject(new GithubAdapterNotImplementedError("mergePullRequest"));
  }
}
