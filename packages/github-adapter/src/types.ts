// AdDroid OSS — GitHub adapter shared types.
//
// `GithubAdapter` インタフェースとそのフローで使う型を集約する。
// 実装 (Stub / Mock / Octokit) はそれぞれ別ファイルに分離し、本ファイルは
// 型のみを公開することでテストや UI からの import を最小化する。

export interface PullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  baseRef: string;
  htmlUrl: string;
  mergedAt: string | null;
  mergedBy?: string | null;
}

export interface PullRequestPollResult {
  /** 304 Not Modified 応答 (ETag 一致) の場合は true。 */
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  pullRequests: PullRequestSummary[];
}

export interface OAuthConnection {
  provider: "github";
  /** 表示用の安定識別子 (例: GitHub login)。機微ではない。 */
  accountIdentifier: string;
  scopes: string[];
  connectedAt: string;
}

export interface OpsRepoSpec {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface BootstrapOpsRepoInput {
  /** ops template 展開時に使う workspace メタ。 */
  workspaceSlug: string;
  workspaceDisplayName: string;
  initialAccountKey: string;
  initialAccountDisplayName: string;
  /**
   * 初期 bootstrap 時に同時に用意する Meta ad accounts。
   * 複数アカウント連携済みの場合、各 account の brand.yaml を作る。
   */
  initialAccounts?: { key: string; displayName: string }[];
  /** 作成する repo 名。owner は OAuth 接続済みアカウント。 */
  desiredName: string;
  /** 既定 "main"。 */
  defaultBranch?: string;
  /** 既定 "private"。public は明示指定が必要。 */
  visibility?: "private" | "public";
}

export interface BootstrapOpsRepoResult {
  owner: string;
  name: string;
  defaultBranch: string;
  /** ISO 8601 string. */
  bootstrappedAt: string;
  /** template から書き出したファイル数 (audit 用)。 */
  filesCommitted: number;
}

export interface CreatePullRequestFile {
  /** repo-relative path (例: "ads/accounts/act_123/campaigns/cmp_456.yaml")。 */
  path: string;
  /** unified diff string (sanitize は呼び出し側で済んでいる前提)。 */
  diff: string;
  /** "create" | "update" | "delete". delete のときファイル本体を削除する。 */
  action: "create" | "update" | "delete";
}

export interface CreatePullRequestInput {
  /** ops repo "owner/name" を分解した spec。 */
  spec: OpsRepoSpec;
  /** PR タイトル (sanitize 済み)。 */
  title: string;
  /** PR body (markdown, sanitize 済み)。 */
  body: string;
  /** 新規 branch 名 (kebab-case ascii, "addroid/" prefix 推奨)。 */
  branchName: string;
  /** 変更ファイル群 (gitops agent が出した diff を再構成して渡す)。 */
  files: CreatePullRequestFile[];
  /** PR base ref。既定は spec.defaultBranch。 */
  baseRef?: string;
}

export interface CreatePullRequestResult {
  number: number;
  htmlUrl: string;
  /** branch HEAD の commit sha (PR の headSha と一致)。 */
  headSha: string;
}

export interface MergePullRequestInput {
  spec: OpsRepoSpec;
  /** 対象 PR 番号。 */
  number: number;
  /**
   * 期待する HEAD sha。GitHub merge API の `sha` クエリに渡し、ポーリング以降に
   * 後続 commit が積まれていた場合 422 で失敗させる (race-condition guard)。
   * 既存ローカル状態の `github_pull_requests.headSha` を渡す想定。
   */
  expectedHeadSha?: string;
  /** "merge" | "squash" | "rebase". 既定 "merge". */
  mergeMethod?: "merge" | "squash" | "rebase";
  /** マージコミット件名 (sanitize 済み)。未指定時は GitHub 既定。 */
  commitTitle?: string;
  /** マージコミット本文 (sanitize 済み)。未指定時は GitHub 既定。 */
  commitMessage?: string;
}

export interface MergePullRequestResult {
  /** マージ後の commit sha (PR ベースブランチに乗ったマージ commit)。 */
  sha: string;
  merged: boolean;
  message: string;
}

export class GithubMergeFailedError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GithubMergeFailedError";
  }
}

export interface GithubAdapter {
  /**
   * OAuth 開始 URL を返す。`state` は CSRF 防止用のランダム値で、callback で同値検証する。
   */
  beginOAuth(): Promise<{ authorizationUrl: string; state: string }>;

  /**
   * OAuth コールバック完了。code を access token に交換し、暗号化境界越しに保存する。
   * 返り値は表示用の接続メタのみで、token そのものは含めない。
   */
  completeOAuth(params: { code: string; state: string }): Promise<OAuthConnection>;

  /**
   * private な ops リポジトリを作成し、ops-template を初期コミットする。
   * ハードコードされた owner を使わず、OAuth 接続済みアカウントの権限で作成する。
   */
  bootstrapOpsRepo(input: BootstrapOpsRepoInput): Promise<BootstrapOpsRepoResult>;

  /**
   * ETag-aware に PR を取得する。前回 ETag を渡すと 304 で `notModified=true` を返す。
   */
  pollPullRequests(spec: OpsRepoSpec, prev: { etag?: string }): Promise<PullRequestPollResult>;

  /**
   * improvement_pr ワークフローが組み立てた YAML 変更を新規 branch に commit し、
   * `baseRef` に対して PR を開く。失敗時は throw する。
   */
  createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>;

  /**
   * Web UI からの "PR をマージする (Web UI)" 操作で呼ばれる。GitHub merge API
   * (PUT /repos/{owner}/{repo}/pulls/{number}/merge) を呼び、merge commit sha を
   * 返す。merge 不可 (state=open のままコンフリクト /
   * conflict 等) は `GithubMergeFailedError` を throw する。
   */
  mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult>;
}

export class GithubAdapterNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `GithubAdapter.${method} is not configured. Provide GitHub OAuth credentials in secrets.local.yaml or set ADDROID_GITHUB_OAUTH_MOCK=1 to use the mock adapter.`
    );
    this.name = "GithubAdapterNotImplementedError";
  }
}

export class GithubOAuthStateMismatchError extends Error {
  constructor() {
    super("OAuth state did not match the value issued by beginOAuth (possible CSRF).");
    this.name = "GithubOAuthStateMismatchError";
  }
}

export class GithubAdapterUnauthenticatedError extends Error {
  constructor(operation: string) {
    super(
      `GithubAdapter cannot ${operation}: no OAuth token found. Connect GitHub from /github first.`
    );
    this.name = "GithubAdapterUnauthenticatedError";
  }
}
