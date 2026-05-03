// AdDroid OSS — Meta Ads CLI execution adapter.
//
// 単一の sanitize 済み runner interface を介して `meta-ads-cli` (または互換 CLI) を
// 子プロセスで実行する。the current implementation 受入基準:
//   - access token は **環境変数経由でのみ** CLI に渡す。argv / ログには絶対に乗せない。
//   - exit code を success / auth_error / rate_limit_error / unknown_error に分類する。
//   - command / args / stdout / stderr / exit_code / timestamps / throttle headers を
//     execution_logs に保存できる sanitized 形で返す。
//   - CLI バージョンを `--version` で検証し、最低要求バージョンに満たない場合は fail-closed。
//
// 本モジュールは Prisma を import せず、結果を `execution_logs` 行へ写像する純粋関数
// (`toExecutionLogInput`) のみを提供する。永続化は呼び出し側 (worker / web) が
// `CronOpsStore.recordExecutionLog` 経由で行う。

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export type MetaCliExitClass =
  | "success"
  | "auth_error"
  | "rate_limit_error"
  | "api_error"
  | "unknown_error";

/**
 * 1 回の Meta CLI 実行結果に対する宣言的な後処理ポリシー。
 *
 * `kind` は worker / web ハンドラが起動すべき副作用カテゴリを示す:
 *   - `none`               : 後処理なし (success)。
 *   - `notify_reauth`      : 再認証要求イベントを audit_logs に記録し、UI へ
 *                            "Meta 再認証が必要" の通知を出す (auth_error)。
 *                            この exit class は再試行しない (token を入れ替えない限り無意味)。
 *   - `retry_with_backoff` : 指定 backoff 後に再試行する (rate_limit_error)。
 *                            `maxAttempts` には初回試行を含めた合計試行回数を入れる。
 *   - `notify_api_error`   : Meta Marketing API が構造化エラーを返した (auth/rate
 *                            ではない非リトライ型 API 失敗) ことを audit に残し、
 *                            オペレータ通知を起動する (api_error)。
 *   - `fail_fast_notify`   : 再試行せず、execution_logs を error level で残し
 *                            オペレータ通知 (Toast / audit) を起動する (unknown_error)。
 *
 * the current implementation の "matching retry or notification behavior" 受入要件を、CLI runner
 * から呼び出し側に渡せる単一のデータとして表現する。値は `recommendActionForExit`
 * から決定論的に取得し、`MetaCliExecutionResult` と `execution_logs` の payload
 * に保存する (regression fix / regression fix)。
 *
 * 通知系 (`notify_reauth` / `notify_api_error` / `fail_fast_notify`) は必ず
 * `auditAction` を持つ — production 経路 (`CliApplyExecutor` →
 * `runExecuteApply`) は `result.exitClass` を switch せず、この `auditAction`
 * を直接 `audit_logs` に書く (regression fix)。
 */
export type MetaCliRecommendedAction =
  | {
      kind: "none";
      retry: false;
      notify: "none";
      logLevel: "info";
      reason: string;
    }
  | {
      kind: "notify_reauth";
      retry: false;
      notify: "reauth_required";
      logLevel: "error";
      auditAction: "oauth.meta.reauth_required";
      reason: string;
    }
  | {
      kind: "retry_with_backoff";
      retry: true;
      notify: "throttled";
      logLevel: "warn";
      maxAttempts: number;
      initialBackoffMs: number;
      maxBackoffMs: number;
      backoffStrategy: "exponential";
      reason: string;
    }
  | {
      kind: "notify_api_error";
      retry: false;
      notify: "api_error";
      logLevel: "error";
      auditAction: "meta.api_error";
      reason: string;
    }
  | {
      kind: "fail_fast_notify";
      retry: false;
      notify: "operator_alert";
      logLevel: "error";
      auditAction: "meta.cli_unknown_error";
      reason: string;
    };

/**
 * exit class から `MetaCliRecommendedAction` を返す pure function。
 * 値は固定方針 (リテラル) — 環境変数や DB 状態に依存させない。
 *
 * 方針:
 *   - success           : 後処理なし。
 *   - auth_error        : 再認証通知。再試行しない (token 差し替えなしには無意味)。
 *   - rate_limit_error  : 5s → 10s → 20s の指数 backoff で最大 3 回まで再試行。
 *   - api_error         : 構造化された Meta API 失敗 (auth/rate 以外)。再試行せず
 *                         `meta.api_error` audit を残してオペレータ調査を促す。
 *   - unknown_error     : 即時失敗 + オペレータ通知。手動調査が必要。
 */
export function recommendActionForExit(
  exitClass: MetaCliExitClass
): MetaCliRecommendedAction {
  switch (exitClass) {
    case "success":
      return {
        kind: "none",
        retry: false,
        notify: "none",
        logLevel: "info",
        reason: "Meta CLI exited 0",
      };
    case "auth_error":
      return {
        kind: "notify_reauth",
        retry: false,
        notify: "reauth_required",
        logLevel: "error",
        auditAction: "oauth.meta.reauth_required",
        reason:
          "Meta access token rejected by Marketing API; reauth required before any further apply/activate.",
      };
    case "rate_limit_error":
      return {
        kind: "retry_with_backoff",
        retry: true,
        notify: "throttled",
        logLevel: "warn",
        maxAttempts: 3,
        initialBackoffMs: 5_000,
        maxBackoffMs: 60_000,
        backoffStrategy: "exponential",
        reason:
          "Meta API rate limit / throttle; back off and retry the same invocation.",
      };
    case "api_error":
      return {
        kind: "notify_api_error",
        retry: false,
        notify: "api_error",
        logLevel: "error",
        auditAction: "meta.api_error",
        reason:
          "Meta Marketing API returned a structured error (non-auth, non-rate-limit); operator triage required.",
      };
    case "unknown_error":
    default:
      return {
        kind: "fail_fast_notify",
        retry: false,
        notify: "operator_alert",
        logLevel: "error",
        auditAction: "meta.cli_unknown_error",
        reason:
          "Meta CLI failed with an unrecognized exit class; manual operator triage required.",
      };
  }
}

/**
 * 1 回の Meta Ads CLI 呼び出しを表す入力。
 * `args` には access token を含めない (含まれた場合は redact してから spawn する)。
 */
export interface MetaCliInvocation {
  /** ad_account の安定キー (`ads/accounts/<key>`)。env var 名と監査ログの scoping に使う。 */
  accountKey: string;
  /**
   * Meta 側の ad account id。公式 `meta-ads` CLI は `AD_ACCOUNT_ID` を読む。
   * 未指定時は accountKey を fallback として渡す。
   */
  adAccountId?: string | null;
  /** Meta Ads CLI の subcommand + args。例: ["ads", "campaign", "list"]。 */
  args: string[];
  /** 作業ディレクトリ。既定は process.cwd()。 */
  cwd?: string;
  /** タイムアウト (ミリ秒)。指定時は SIGTERM 送付 + timedOut=true。 */
  timeoutMs?: number;
  /** 追加環境変数。token は内部で注入するのでここに書かない。 */
  extraEnv?: Record<string, string>;
  /**
   * 関連するエンティティ参照。後続の execution_logs 行に乗せるためのみ使う
   * (CLI 実行自体には影響しない)。
   */
  refs?: {
    refType?:
      | "apply_job"
      | "cron_run"
      | "ai_run"
      | "pull_request"
      | "approval_record"
      | "ads_hierarchy";
    refId?: string;
    pullRequestNumber?: number;
    approvalRecordId?: string;
  };
}

export interface MetaThrottleHeaders {
  /** `X-Business-Use-Case-Usage` の生 JSON 文字列。 */
  businessUseCase?: string;
  /** `X-App-Usage` の生 JSON 文字列。 */
  appUsage?: string;
  /** `X-Ad-Account-Usage` の生 JSON 文字列。 */
  adAccountUsage?: string;
}

export interface MetaCliExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitClass: MetaCliExitClass;
  /** Token-redacted stdout (結尾の改行は保持)。 */
  stdout: string;
  /** Token-redacted stderr。 */
  stderr: string;
  /** 表示・ログ向けに redact 済みの正準コマンド (`<binary> <arg1> ...`)。 */
  sanitizedCommand: string;
  /** redact 済み args の配列。 */
  sanitizedArgs: string[];
  /** CLI 出力から抽出した throttle ヘッダ (取得できれば)。 */
  throttleHeaders: MetaThrottleHeaders | null;
  /** 実行時間 (ms)。 */
  durationMs: number;
  /** ISO 8601 開始時刻。 */
  startedAt: string;
  /** ISO 8601 終了時刻。 */
  finishedAt: string;
  /** タイムアウトで中断された場合 true。 */
  timedOut: boolean;
  /** account_key (ログ用)。 */
  accountKey: string;
  /** 呼び出された binary 名 (パス込み)。 */
  binary: string;
  /**
   * exit class に対応する宣言的な retry/notification policy。
   * worker / web は exitClass を直接 switch せず、この値を参照して再試行・再認証要求・
   * オペレータ通知を起動する。`toExecutionLogInput` も同じ値を payload に保存する。
   */
  recommendedAction: MetaCliRecommendedAction;
}

export interface MetaCliVersionInfo {
  /** spawn -V または --version で取得した raw 文字列 (改行は trim 済み)。 */
  rawVersion: string;
  /** 抽出した正準 semver ("1.2.3")。抽出できなければ null。 */
  parsed: string | null;
}

export interface MetaCliVersionVerification {
  ok: boolean;
  actualVersion: string | null;
  minVersion: string | null;
  /** UI に出すための短い理由文。 */
  detail: string;
}

/**
 * runner が token を取得するための boundary。`MetaAdapter.loadAccessTokenPlaintext()`
 * を per-account にラップしたものを渡す想定。
 */
export interface MetaCliTokenLoader {
  (accountKey: string): Promise<{ accessToken: string } | null>;
}

export interface MetaCliRunnerOptions {
  /** Meta Ads CLI バイナリのパス (例: "/usr/local/bin/meta-ads-cli")。 */
  binaryPath: string;
  /** 1 invocation あたりのトークン取得関数。 */
  loadTokenForAccount: MetaCliTokenLoader;
  /** 最低要求バージョン (例: "0.5.0")。指定時のみ verifyVersion で利用。 */
  minVersion?: string;
  /** test seam: 子プロセス起動関数。 */
  spawnImpl?: typeof nodeSpawn;
  /** test seam: 既定の env (process.env)。 */
  baseEnv?: NodeJS.ProcessEnv;
  /** test seam: `--version` の出力を直接返す。指定すると spawn しない。 */
  versionResolver?: () => Promise<string>;
  /** stdout/stderr の最大保存サイズ (bytes 換算)。既定 64KB ずつ。超過時は末尾を切る。 */
  maxOutputBytes?: number;
  /** デフォルトのタイムアウト ms。invocation で上書き可。既定 5 分。 */
  defaultTimeoutMs?: number;
  /**
   * 実装時に動作確認済みの (resource, verb) マトリクス。
   * 既定は `META_CLI_SUPPORTED_OPERATIONS`。テスト / 別契約で代替の検証済み
   * セットを使う場合のみ上書きする。`run()` はこのマトリクスに無い操作を
   * spawn 前に `MetaCliUnsupportedOperationError` で拒否する (fail closed)。
   */
  supportedOperations?: readonly SupportedMetaCliOperation[];
  /**
   * regression fix: true のとき `run()` は `verifyVersion()` が呼ばれて
   * `ok=true` を返した後でなければ spawn しない。production 経路
   * (`resolveApplyExecutor` / `resolveActivateExecutor`) はこれを true に
   * 設定し、CLI バイナリ未設置や minVersion 未満の状態を fail-closed にする。
   * 既定は false (直接 runner を構築するユニットテストは検証フローを通過しない
   * ため、production factory が true を明示する)。
   */
  requireVerifiedVersion?: boolean;
}

export class MetaCliBinaryNotConfiguredError extends Error {
  constructor() {
    super(
      "MetaCliRunner cannot execute: binaryPath is empty. Configure Meta Ads CLI install path in ~/.addroid/config.yaml or ADDROID_META_CLI_BIN."
    );
    this.name = "MetaCliBinaryNotConfiguredError";
  }
}

export class MetaCliMissingTokenError extends Error {
  readonly accountKey: string;
  constructor(accountKey: string) {
    super(
      `MetaCliRunner cannot execute: no Meta access token found for ad_account "${accountKey}". Connect Meta from /accounts first.`
    );
    this.name = "MetaCliMissingTokenError";
    this.accountKey = accountKey;
  }
}

export class MetaCliUnsupportedOperationError extends Error {
  readonly attemptedResource: string | null;
  readonly attemptedVerb: string | null;
  constructor(attempted: { resource: string | null; verb: string | null }) {
    const label = `${attempted.resource ?? "(no-resource)"} ${attempted.verb ?? "(no-verb)"}`;
    super(
      `MetaCliRunner refuses to spawn unverified operation "${label}". ` +
        `Add it to META_CLI_SUPPORTED_OPERATIONS only after verifying real Meta Ads CLI coverage.`
    );
    this.name = "MetaCliUnsupportedOperationError";
    this.attemptedResource = attempted.resource;
    this.attemptedVerb = attempted.verb;
  }
}

/**
 * regression fix: `requireVerifiedVersion` を有効にした runner で、
 * `verifyVersion()` が一度も呼ばれていない、もしくは ok=false で完了している
 * 状態で `run()` が呼ばれたときに投げる。production の Apply/Activate 経路は
 * これをキャッチして「CLI 未検証で apply/activate を fail-closed にした」旨を
 * audit/notify として残し、Meta API には一切リクエストを送らない。
 */
export class MetaCliVersionUnverifiedError extends Error {
  readonly verification: MetaCliVersionVerification | null;
  constructor(verification: MetaCliVersionVerification | null) {
    const detail =
      verification === null
        ? "verifyVersion() was never called on this runner"
        : verification.ok
          ? "verifyVersion() previously returned ok=true (unexpected state)"
          : `verifyVersion() reported ok=false: ${verification.detail}`;
    super(
      `MetaCliRunner refuses to spawn: CLI version not verified (${detail}). ` +
        `Production callers must invoke verifyVersion() and confirm ok=true before run().`
    );
    this.name = "MetaCliVersionUnverifiedError";
    this.verification = verification;
  }
}

// ---------------------------------------------------------------------
// Verified operation matrix (regression fix)
// ---------------------------------------------------------------------

/**
 * 1 つの Meta Ads CLI 操作 (`<resource> <verb>`) が verified=true で実行可能で
 * あることを表すレコード。
 *
 * the current implementation 制約 (constraints.json):
 *   "Meta Ads CLI real coverage must be verified at implementation time and
 *    unsupported operations must fail closed."
 *
 * このマトリクスに無い (resource, verb) を `MetaCliRunner.run` は spawn せず
 * `MetaCliUnsupportedOperationError` を投げる。
 */
export interface SupportedMetaCliOperation {
  /** CLI の第 1 positional argument。例: "campaigns" */
  resource: string;
  /** CLI の第 2 positional argument。例: "list" */
  verb: string;
  /** Meta 側に副作用を起こす操作なら true。read-only なら false。 */
  mutates: boolean;
  /** 実装時に動作確認した CLI バージョンや検証メモの記録。 */
  verifiedAt?: string;
}

/**
 * 実装時に動作確認済みの (resource, verb) リスト。
 *
 * Ads YAML → plan → CLI で必要となる最小集合のみを列挙する。新しい操作を
 * 追加するときは:
 *   1. meta-ads-cli の対応バージョンで実機 / 録画テストにより成功を確認する。
 *   2. このマトリクスに行を追加し、対応する unit test (cli-runner.test.ts) で
 *      `isSupportedMetaCliOperation` がそれを許可することを確認する。
 *   3. `verifiedAt` を埋める。
 *
 * 列挙されていない操作は `MetaCliRunner.run` が spawn 前に拒否する (fail closed)。
 * 特に `delete_*` 系は本マトリクスに含めず、別契約で個別に検証してから追加する。
 *
 * `activate` は PAUSED として Apply 済みの
 * campaign / adset / ad を ACTIVE に遷移させる単独操作として検証された。Activate は
 * Apply とは別経路 (CLI / Web UI POST) からのみ起動でき、必ず actor / source / 対象
 * external_id が audit_logs に記録される。
 */
export const META_CLI_SUPPORTED_OPERATIONS: readonly SupportedMetaCliOperation[] = [
  { resource: "accounts", verb: "list", mutates: false, verifiedAt: "verified" },
  { resource: "accounts", verb: "get", mutates: false, verifiedAt: "verified" },

  { resource: "campaigns", verb: "list", mutates: false, verifiedAt: "verified" },
  { resource: "campaigns", verb: "get", mutates: false, verifiedAt: "verified" },
  { resource: "campaigns", verb: "create", mutates: true, verifiedAt: "verified" },
  { resource: "campaigns", verb: "update", mutates: true, verifiedAt: "verified" },
  { resource: "campaigns", verb: "activate", mutates: true, verifiedAt: "verified" },

  { resource: "adsets", verb: "list", mutates: false, verifiedAt: "verified" },
  { resource: "adsets", verb: "get", mutates: false, verifiedAt: "verified" },
  { resource: "adsets", verb: "create", mutates: true, verifiedAt: "verified" },
  { resource: "adsets", verb: "update", mutates: true, verifiedAt: "verified" },
  { resource: "adsets", verb: "activate", mutates: true, verifiedAt: "verified" },

  { resource: "ads", verb: "list", mutates: false, verifiedAt: "verified" },
  { resource: "ads", verb: "get", mutates: false, verifiedAt: "verified" },
  { resource: "ads", verb: "create", mutates: true, verifiedAt: "verified" },
  { resource: "ads", verb: "update", mutates: true, verifiedAt: "verified" },
  { resource: "ads", verb: "activate", mutates: true, verifiedAt: "verified" },

  { resource: "insights", verb: "get", mutates: false, verifiedAt: "verified" },

  { resource: "creatives", verb: "list", mutates: false, verifiedAt: "verified" },
  { resource: "creatives", verb: "get", mutates: false, verifiedAt: "verified" },
  { resource: "creatives", verb: "create", mutates: true, verifiedAt: "verified" },
  { resource: "creatives", verb: "update", mutates: true, verifiedAt: "verified" },
];

export interface MetaCliOperationCheckResult {
  supported: boolean;
  resource: string | null;
  verb: string | null;
  entry: SupportedMetaCliOperation | null;
}

/**
 * 公式 CLI 形 (`meta ads <resource> <verb>`) だけを許可し、`args[1]` を
 * resource、`args[2]` を verb として解釈する。`meta --output json ads ...`
 * のような公式グローバルオプションも許可するため、実際には先頭の `ads`
 * positional を探してから resource / verb を読む。
 */
export function isSupportedMetaCliOperation(
  args: readonly string[],
  matrix: readonly SupportedMetaCliOperation[] = META_CLI_SUPPORTED_OPERATIONS
): MetaCliOperationCheckResult {
  const adsIndex = args.findIndex((arg) => arg === "ads");
  if (adsIndex < 0) {
    return {
      supported: false,
      resource: pickPositional(args[0]),
      verb: pickPositional(args[1]),
      entry: null,
    };
  }
  const resource = pickPositional(args[adsIndex + 1]);
  const verb = pickPositional(args[adsIndex + 2]);
  if (!resource || !verb) {
    return { supported: false, resource, verb, entry: null };
  }
  const normalized = normalizeMetaCliResource(resource);
  const entry = matrix.find((m) => m.resource === normalized && m.verb === verb) ?? null;
  return { supported: entry !== null, resource, verb, entry };
}

function pickPositional(arg: string | undefined): string | null {
  if (typeof arg !== "string" || arg.length === 0) return null;
  if (arg.startsWith("-")) return null;
  return arg;
}

function normalizeMetaCliResource(resource: string): string {
  switch (resource) {
    case "adaccount":
      return "accounts";
    case "campaign":
      return "campaigns";
    case "adset":
      return "adsets";
    case "ad":
      return "ads";
    case "creative":
      return "creatives";
    case "accounts":
    case "campaigns":
    case "adsets":
    case "ads":
    case "creatives":
      return resource;
    default:
      return resource;
  }
}

// ---------------------------------------------------------------------
// Sanitization helpers (exposed for unit testing)
// ---------------------------------------------------------------------

const TOKEN_LIKE_PATTERNS: readonly RegExp[] = [
  // Meta long-lived user tokens / debug tokens (usually start with EAA followed by base64-ish chars).
  /EAA[A-Za-z0-9_-]{20,}/g,
  // `access_token=...` (URL-encoded or query string — strip until whitespace, &, " or ').
  /access[_-]?token=[^\s"'&]+/gi,
  // Authorization: Bearer <token>
  /Bearer\s+[A-Za-z0-9._\-]{8,}/g,
  // `app_id|app_secret` style app access token.
  /\b\d{6,}\|[A-Za-z0-9_-]{16,}\b/g,
];

/** access_token を含む env var 名 (値は redact)。 */
const TOKEN_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /^META(?:_[A-Z0-9_]+)?_ACCESS_TOKEN$/,
  /^FB(?:_[A-Z0-9_]+)?_ACCESS_TOKEN$/,
  /^ADDROID_META_(?:[A-Z0-9_]+_)?ACCESS_TOKEN$/,
  /^ACCESS_TOKEN$/,
];

/** Host 側の Meta CLI 設定は AdDroid 管理値で上書きする。 */
const META_CLI_MANAGED_ENV_PATTERNS: readonly RegExp[] = [
  ...TOKEN_ENV_NAME_PATTERNS,
  /^AD_ACCOUNT_ID$/,
  /^BUSINESS_ID$/,
];

/**
 * テキスト中の機微情報を `[REDACTED]` 化する。
 * - explicit secrets (今回の token) を最初に厳密一致で削除
 * - その後に既知の token-like パターンで二重防御
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 8) continue;
    out = splitReplaceAll(out, s, "[REDACTED]");
  }
  for (const re of TOKEN_LIKE_PATTERNS) {
    out = out.replace(re, (match) => {
      // access_token=foo → access_token=[REDACTED] を維持
      if (/^access[_-]?token=/i.test(match)) {
        return match.replace(/=.+$/, "=[REDACTED]");
      }
      if (/^Bearer\s/i.test(match)) return "Bearer [REDACTED]";
      return "[REDACTED]";
    });
  }
  return out;
}

function splitReplaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

/** argv から token-like 値を redact する。 */
export function redactArgv(args: readonly string[], secrets: readonly string[]): string[] {
  return args.map((a) => redactSecrets(a, secrets));
}

/** env から `[REDACTED]` 化済みのスナップショットを返す (display only)。 */
export function redactEnvForLog(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (TOKEN_ENV_NAME_PATTERNS.some((re) => re.test(k))) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Exit code / stderr classifier
// ---------------------------------------------------------------------

/** Meta Marketing API で auth 系を示すエラーコード。 */
const META_AUTH_ERROR_CODES = new Set<number>([102, 190, 200, 458, 459, 460, 463, 464, 467, 458]);
/** Meta Marketing API で rate-limit 系を示すエラーコード。 */
const META_RATE_LIMIT_ERROR_CODES = new Set<number>([
  4, 17, 32, 613,
  80000, 80001, 80002, 80003, 80004, 80014,
]);

const AUTH_TEXT_PATTERNS: readonly RegExp[] = [
  /OAuthException/i,
  /access[ _]token has expired/i,
  /Error validating access token/i,
  /token is invalid/i,
  /invalid_grant/i,
  /Session has expired/i,
  /Cannot parse access token/i,
];

const RATE_LIMIT_TEXT_PATTERNS: readonly RegExp[] = [
  /User request limit reached/i,
  /Application request limit reached/i,
  /Rate limit/i,
  /throttl/i,
  /Too many calls/i,
  /API_TOO_MANY_CALLS/i,
];

/**
 * Meta Marketing API が返した構造化エラーを示すテキスト・パターン。
 * auth/rate に該当しない API 失敗を `unknown_error` から切り分けるために使う
 * (regression fix)。新しい exception 型を見つけたら必要に応じて追加する。
 */
const API_ERROR_TEXT_PATTERNS: readonly RegExp[] = [
  /GraphMethodException/i,
  /GraphAPIException/i,
  /GraphBatchException/i,
  /Invalid parameter/i,
  /Unsupported (?:request|post request|get request)/i,
  /Permissions error/i,
  /\(#\d{2,5}\)/, // Meta が文章中に付ける `(#100)` 形式の API error tag
  /error_subcode/i,
  /Marketing API/i,
];

/** Meta が返す `{"error":{...}}` JSON ブロックを大まかに検出する。 */
const META_ERROR_JSON_PATTERN = /"error"\s*:\s*\{[^{}]*"(?:code|message|type|fbtrace_id)"/;

/**
 * exit code と stderr/stdout の中身から `MetaCliExitClass` を決める。
 *
 * 優先度:
 *   1. exit 0 + timeout 無し → success
 *   2. 抽出した Meta error code が auth set / rate-limit set に該当
 *   3. テキスト・パターンが auth / rate-limit に一致
 *   4. その他の Meta error code or 構造化 Meta error → api_error
 *      (auth/rate に該当しない API 失敗を unknown_error に紛れ込ませない)
 *   5. それ以外 → unknown_error (segfault / spawn 失敗 / non-Meta 由来)
 */
export function classifyExit(params: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}): MetaCliExitClass {
  if (params.exitCode === 0 && !params.timedOut) return "success";

  const haystack = `${params.stderr}\n${params.stdout}`;

  // 1) 明示的な Meta error code (`"code": 190` 等) を抽出
  const codes = extractMetaErrorCodes(haystack);
  for (const c of codes) {
    if (META_AUTH_ERROR_CODES.has(c)) return "auth_error";
    if (META_RATE_LIMIT_ERROR_CODES.has(c)) return "rate_limit_error";
  }

  // 2) テキスト・パターンマッチ (auth/rate-limit が優先)
  if (AUTH_TEXT_PATTERNS.some((re) => re.test(haystack))) return "auth_error";
  if (RATE_LIMIT_TEXT_PATTERNS.some((re) => re.test(haystack))) {
    return "rate_limit_error";
  }

  // 3) Meta API が構造化エラーを返している → api_error。auth/rate を取りこぼさない
  //    ようここまで届いた時点で、code 抽出できた残りの code、API error テキスト、
  //    あるいは `{"error":{...}}` 形式のいずれかが一つでもあれば確定する。
  if (codes.length > 0) return "api_error";
  if (API_ERROR_TEXT_PATTERNS.some((re) => re.test(haystack))) return "api_error";
  if (META_ERROR_JSON_PATTERN.test(haystack)) return "api_error";

  return "unknown_error";
}

function extractMetaErrorCodes(text: string): number[] {
  const out: number[] = [];
  // `"code": 190` / `"code":190` / `code=190`
  const re = /(?:"code"\s*:\s*|code\s*=\s*)(\d{1,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------
// Throttle header parsing
// ---------------------------------------------------------------------

const THROTTLE_PATTERN_BUSINESS = /X-Business-Use-Case-Usage:\s*(\{.+\})/i;
const THROTTLE_PATTERN_APP = /X-App-Usage:\s*(\{.+\})/i;
const THROTTLE_PATTERN_ACCOUNT = /X-Ad-Account-Usage:\s*(\{.+\})/i;
const THROTTLE_JSON_BLOCK = /"throttle"\s*:\s*(\{[^}]*\})/i;

/**
 * CLI の stdout/stderr に含まれる Meta throttle ヘッダを best-effort で抽出する。
 * ヘッダが含まれていない場合は null を返す。
 */
export function parseThrottleHeaders(stdout: string, stderr: string): MetaThrottleHeaders | null {
  const haystack = `${stdout}\n${stderr}`;
  const out: MetaThrottleHeaders = {};
  const m1 = THROTTLE_PATTERN_BUSINESS.exec(haystack);
  if (m1?.[1]) out.businessUseCase = m1[1].trim();
  const m2 = THROTTLE_PATTERN_APP.exec(haystack);
  if (m2?.[1]) out.appUsage = m2[1].trim();
  const m3 = THROTTLE_PATTERN_ACCOUNT.exec(haystack);
  if (m3?.[1]) out.adAccountUsage = m3[1].trim();
  if (!out.businessUseCase && !out.appUsage && !out.adAccountUsage) {
    const j = THROTTLE_JSON_BLOCK.exec(haystack);
    if (j?.[1]) out.businessUseCase = j[1].trim();
  }
  if (!out.businessUseCase && !out.appUsage && !out.adAccountUsage) {
    return null;
  }
  return out;
}

// ---------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------

/** `0.5.0` / `v1.2.3` / `meta-ads-cli 1.2.3 (build sha)` から数値配列を抽出。 */
export function parseSemver(raw: string): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return null;
  const major = Number(m[1] ?? 0);
  const minor = Number(m[2] ?? 0);
  const patch = Number(m[3] ?? 0);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return [major, minor, patch];
}

/** a >= b なら true。どちらか parse 不能なら false (fail closed)。 */
export function semverGte(a: string, b: string): boolean {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return false;
  for (let i = 0; i < 3; i++) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export class MetaCliRunner {
  private readonly binaryPath: string;
  private readonly loadToken: MetaCliTokenLoader;
  private readonly minVersion: string | null;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly versionResolver: (() => Promise<string>) | null;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly supportedOperations: readonly SupportedMetaCliOperation[];
  private readonly requireVerifiedVersion: boolean;
  private versionVerification: MetaCliVersionVerification | null = null;

  constructor(opts: MetaCliRunnerOptions) {
    if (!opts.binaryPath || !opts.binaryPath.trim()) {
      throw new MetaCliBinaryNotConfiguredError();
    }
    this.binaryPath = opts.binaryPath;
    this.loadToken = opts.loadTokenForAccount;
    this.minVersion = opts.minVersion ?? null;
    this.spawnImpl = opts.spawnImpl ?? nodeSpawn;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.versionResolver = opts.versionResolver ?? null;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.supportedOperations =
      opts.supportedOperations ?? META_CLI_SUPPORTED_OPERATIONS;
    this.requireVerifiedVersion = opts.requireVerifiedVersion ?? false;
  }

  /**
   * 直近の `verifyVersion()` 結果。一度も呼ばれていなければ null。
   * production caller は selection を audit / 通知メッセージに使う。
   */
  getVersionVerification(): MetaCliVersionVerification | null {
    return this.versionVerification;
  }

  /**
   * `--version` を実行し、minVersion (任意) と比較する。
   * minVersion 未指定時でも CLI が起動しバージョンを返せれば ok: true。
   *
   * regression fix: 結果を runner 内部にキャッシュし、`requireVerifiedVersion`
   * が true の場合は `run()` がこのキャッシュを参照して fail-closed にする。
   */
  async verifyVersion(): Promise<MetaCliVersionVerification> {
    const result = await this.computeVersionVerification();
    this.versionVerification = result;
    return result;
  }

  private async computeVersionVerification(): Promise<MetaCliVersionVerification> {
    let raw: string;
    try {
      raw = this.versionResolver
        ? await this.versionResolver()
        : await this.spawnVersion();
    } catch (err) {
      return {
        ok: false,
        actualVersion: null,
        minVersion: this.minVersion,
        detail: `meta-ads-cli not runnable: ${(err as Error).message}`,
      };
    }
    const parsed = parseSemver(raw);
    const actualVersion = parsed ? parsed.join(".") : raw.trim();
    if (!parsed) {
      return {
        ok: false,
        actualVersion,
        minVersion: this.minVersion,
        detail: `meta-ads-cli --version did not return a recognizable version (got "${raw.trim()}")`,
      };
    }
    if (this.minVersion) {
      const ok = semverGte(actualVersion, this.minVersion);
      return {
        ok,
        actualVersion,
        minVersion: this.minVersion,
        detail: ok
          ? `meta-ads-cli ${actualVersion} >= ${this.minVersion}`
          : `meta-ads-cli ${actualVersion} is older than required ${this.minVersion}`,
      };
    }
    return {
      ok: true,
      actualVersion,
      minVersion: null,
      detail: `meta-ads-cli ${actualVersion}`,
    };
  }

  /**
   * 1 回の Meta Ads CLI 呼び出しを行う。token は env 経由でのみ渡し、
   * argv に混入していた場合は redact してから spawn する。
   */
  async run(invocation: MetaCliInvocation): Promise<MetaCliExecutionResult> {
    // regression fix: refuse unverified operations before any I/O.
    // Constraint: "Meta Ads CLI real coverage must be verified at implementation
    // time and unsupported operations must fail closed."
    const support = isSupportedMetaCliOperation(
      invocation.args,
      this.supportedOperations
    );
    if (!support.supported) {
      throw new MetaCliUnsupportedOperationError({
        resource: support.resource,
        verb: support.verb,
      });
    }

    // regression fix: refuse to spawn the CLI binary unless its version has been
    // verified. Production callers (resolveApplyExecutor / resolveActivateExecutor)
    // set requireVerifiedVersion=true and must call verifyVersion() once before
    // any executeAction. If verifyVersion() never ran or returned ok=false we
    // fail closed here — the executor catches MetaCliVersionUnverifiedError and
    // surfaces it as an audited unknown_error rather than mock-falling-back.
    if (this.requireVerifiedVersion && !this.versionVerification?.ok) {
      throw new MetaCliVersionUnverifiedError(this.versionVerification);
    }

    const lease = await this.loadToken(invocation.accountKey);
    if (!lease) throw new MetaCliMissingTokenError(invocation.accountKey);
    const accessToken = lease.accessToken;

    // sanity: argv から token を取り除く (上位レイヤーが誤って渡しても fail-safe)
    const sanitizedArgs = redactArgv(invocation.args, [accessToken]);

    const timeoutMs = invocation.timeoutMs ?? this.defaultTimeoutMs;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    const env = this.buildSpawnEnv({
      accountKey: invocation.accountKey,
      adAccountId: invocation.adAccountId,
      accessToken,
      extraEnv: invocation.extraEnv,
    });

    const spawnOpts: SpawnOptions = {
      cwd: invocation.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };

    const child = this.spawnImpl(this.binaryPath, sanitizedArgs, spawnOpts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const max = this.maxOutputBytes;

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = max - stdoutBytes;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = max - stderrBytes;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });

    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    }

    const exitInfo = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError: Error | null;
    }>((resolve) => {
      let settled = false;
      const settle = (v: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        spawnError: Error | null;
      }) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(v);
      };
      child.on("error", (err) => {
        settle({ exitCode: null, signal: null, spawnError: err });
      });
      child.on("close", (code, signal) => {
        settle({
          exitCode: typeof code === "number" ? code : null,
          signal: (signal as NodeJS.Signals | null) ?? null,
          spawnError: null,
        });
      });
    });

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();

    const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
    const rawStderr =
      Buffer.concat(stderrChunks).toString("utf8") +
      (exitInfo.spawnError
        ? `\n[runner] spawn error: ${exitInfo.spawnError.message}`
        : "");

    const stdout = redactSecrets(rawStdout, [accessToken]);
    const stderr = redactSecrets(rawStderr, [accessToken]);

    const exitClass = classifyExit({
      exitCode: exitInfo.exitCode,
      signal: exitInfo.signal,
      stderr,
      stdout,
      timedOut,
    });
    const recommendedAction = recommendActionForExit(exitClass);

    const throttleHeaders = parseThrottleHeaders(stdout, stderr);

    const sanitizedCommand =
      [this.binaryPath, ...sanitizedArgs]
        .map((p) => redactSecrets(p, [accessToken]))
        .join(" ");

    return {
      exitCode: exitInfo.exitCode,
      signal: exitInfo.signal,
      exitClass,
      stdout,
      stderr,
      sanitizedCommand,
      sanitizedArgs,
      throttleHeaders,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      startedAt,
      finishedAt,
      timedOut,
      accountKey: invocation.accountKey,
      binary: this.binaryPath,
      recommendedAction,
    };
  }

  private buildSpawnEnv(params: {
    accountKey: string;
    adAccountId?: string | null;
    accessToken: string;
    extraEnv?: Record<string, string>;
  }): NodeJS.ProcessEnv {
    // Next.js 環境では `NodeJS.ProcessEnv` 型に `NODE_ENV` が必須化されているため、
    // 構築中は plain Record 型で扱い、最後に NodeJS.ProcessEnv へキャストする。
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.baseEnv)) {
      if (META_CLI_MANAGED_ENV_PATTERNS.some((re) => re.test(k))) continue;
      if (typeof v === "string") clean[k] = v;
    }

    const adAccountId = params.adAccountId?.trim() || params.accountKey;
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(params.extraEnv ?? {})) {
      if (META_CLI_MANAGED_ENV_PATTERNS.some((re) => re.test(k))) continue;
      extra[k] = v;
    }
    const merged: Record<string, string> = {
      ...clean,
      ...extra,
      // 公式 meta-ads CLI は ACCESS_TOKEN / AD_ACCOUNT_ID を読む。
      ACCESS_TOKEN: params.accessToken,
      AD_ACCOUNT_ID: adAccountId,
    };
    return merged as unknown as NodeJS.ProcessEnv;
  }

  private async spawnVersion(): Promise<string> {
    const child = this.spawnImpl(this.binaryPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(typeof c === "number" ? c : null));
    });
    if (code !== 0) {
      throw new Error(
        `meta-ads-cli --version exited with code ${code ?? "null"}: ${Buffer.concat(err).toString("utf8").trim()}`
      );
    }
    const text = Buffer.concat(out).toString("utf8") || Buffer.concat(err).toString("utf8");
    return text.trim();
  }
}

// ---------------------------------------------------------------------
// execution_logs payload mapper
// ---------------------------------------------------------------------

/**
 * `MetaCliExecutionResult` を `CronOpsStore.recordExecutionLog` に渡せる
 * 形に整形する。ここで保存される `payload` は UI の `ExecutionLogPanel` で
 * sanitize 表示される想定 — 値はすべて redact 済み。
 */
export interface MetaCliExecutionLogInput {
  kind: "meta_cli";
  level: "info" | "warn" | "error";
  message: string;
  refType?: string;
  refId?: string;
  payload: {
    accountKey: string;
    binary: string;
    sanitizedCommand: string;
    sanitizedArgs: string[];
    exitCode: number | null;
    signal: string | null;
    exitClass: MetaCliExitClass;
    /**
     * exit class から決定した宣言的な後処理ポリシー。
     * worker / web は execution_logs を読み返すだけで「再認証要求された」「rate-limit
     * backoff 中」「unknown_error で operator alert を出した」等を再構成できる。
     */
    recommendedAction: MetaCliRecommendedAction;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    throttleHeaders: MetaThrottleHeaders | null;
    pullRequestNumber?: number;
    approvalRecordId?: string;
  };
}

export function toExecutionLogInput(
  result: MetaCliExecutionResult,
  refs?: MetaCliInvocation["refs"]
): MetaCliExecutionLogInput {
  // log level は宣言的 policy から取得し、exit class -> level の二重定義を避ける。
  const level = result.recommendedAction.logLevel;

  const actionTag =
    result.recommendedAction.kind === "none"
      ? ""
      : ` [action=${result.recommendedAction.kind}]`;
  const message =
    result.exitClass === "success"
      ? `meta-cli ${result.sanitizedArgs[0] ?? "(noop)"}: success (exit 0, ${result.durationMs}ms)`
      : `meta-cli ${result.sanitizedArgs[0] ?? "(noop)"}: ${result.exitClass} (exit ${result.exitCode ?? "null"}${result.timedOut ? ", timed out" : ""})${actionTag}`;

  const payload: MetaCliExecutionLogInput["payload"] = {
    accountKey: result.accountKey,
    binary: result.binary,
    sanitizedCommand: result.sanitizedCommand,
    sanitizedArgs: result.sanitizedArgs,
    exitCode: result.exitCode,
    signal: result.signal,
    exitClass: result.exitClass,
    recommendedAction: result.recommendedAction,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    throttleHeaders: result.throttleHeaders,
  };
  if (refs?.pullRequestNumber !== undefined) {
    payload.pullRequestNumber = refs.pullRequestNumber;
  }
  if (refs?.approvalRecordId !== undefined) {
    payload.approvalRecordId = refs.approvalRecordId;
  }

  const out: MetaCliExecutionLogInput = {
    kind: "meta_cli",
    level,
    message,
    payload,
  };
  if (refs?.refType) out.refType = refs.refType;
  if (refs?.refId) out.refId = refs.refId;
  return out;
}

// child_process 型の再 export (test seam の typed mock 用)。
export type { ChildProcess };
