// AdDroid OSS — Activate 用の Meta CLI executor.
//
// `runActivate` (queue) から呼ばれる ActivateExecutor の本番 / mock 実装。
// apply-meta-executor.ts と同じパターンで、production は `MetaCliRunner.run` を
// 経由し、access token は env のみで CLI に渡す (argv / ログ非露出)。
//
// モード:
//   - cli  : `ADDROID_META_CLI_BIN` 設定済 → CliActivateExecutor。token は per-invocation
//            で MetaAdapter から再取得し、未連携 / 期限切れ / 復号失敗は auth_error
//            + oauth.meta.reauth_required notify として返す (regression fix)。
//   - mock : `ADDROID_META_CLI_BIN` 未設定時のフェイルクローズド経路。Activate は
//            Apply と異なり実 Meta API へ副作用 (PAUSED → ACTIVE による課金開始) を
//            出すため、CLI 未設定状態で mock success を返してはならない。
//            `MockActivateExecutor` は unknown_error + meta.cli_unknown_error notify
//            を返し、`runActivate` は markHierarchyActive を呼ばず activate.rejected
//            を記録する (regression fix)。
//
// 本ファイルは Prisma を import しない。ActivateStore は呼び出し側で生成して注入する。

import { spawn as nodeSpawn } from "node:child_process";
import {
  MetaAdapterUnauthenticatedError,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliVersionUnverifiedError,
  MetaTokenExpiredError,
  recommendActionForExit,
  toExecutionLogInput,
  type MetaAdapter,
  type MetaCliExitClass,
  type MetaCliInvocation,
  type MetaCliRunnerOptions,
  type MetaCliVersionVerification,
} from "@addroid/meta-adapter";
import type {
  ActivateExecuteInput,
  ActivateExecuteResult,
  ActivateExecutor,
  ActivateNodeSnapshot,
  JsonValue,
} from "@addroid/queue";

import { META_CLI_MIN_VERSION } from "./apply-meta-executor.js";

// ---------------------------------------------------------------------
// PlanAction 同等の args ビルダ
// ---------------------------------------------------------------------

/**
 * `nodeType + external_id + accountKey` から公式 `meta ads <resource> ...` 形の args を返す。
 * 未対応 nodeType は null (executor 側で skipped に倒す)。
 */
function activateNodeToCliArgs(node: ActivateNodeSnapshot): {
  args: string[];
  resource: "campaigns" | "adsets" | "ads";
} | null {
  if (!node.externalId) return null;
  const resource =
    node.nodeType === "campaign"
      ? "campaigns"
      : node.nodeType === "adset"
        ? "adsets"
        : node.nodeType === "ad"
          ? "ads"
          : null;
  if (!resource) return null;
  return {
    resource,
    args: [
      "ads",
      resource === "campaigns" ? "campaign" : resource === "adsets" ? "adset" : "ad",
      "activate",
      "--id",
      node.externalId,
    ],
  };
}

// ---------------------------------------------------------------------
// regression fix: canonical pre-spawn payload shape (Activate)
//
// Spawned MetaCli activate runs persist a payload with a fixed set of evidence
// fields (stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/
// throttleHeaders/exitClass/recommendedAction) via `toExecutionLogInput`.
// Pre-spawn failures (CLI version not verified, token missing/expired/decrypt
// failure) used to omit those fields entirely, which made `execution_logs` rows
// for failed-before-spawn Activate invocations structurally different from
// spawned invocations and broke uniform consumers (UI ExecutionLogPanel, log
// analytics).
//
// `prefailedActivatePayloadEnvelope` returns the canonical envelope with
// null/empty/zero values so callers only have to merge their own
// failure-specific fields (mode, stage, errorName, etc.) on top. Mirrors
// `prefailedPayloadEnvelope` in apply-meta-executor.ts.
// ---------------------------------------------------------------------

interface PreSpawnActivatePayloadEnvelopeInput {
  exitClass: MetaCliExitClass;
  /** Sanitized 1 行説明。stderr スロットに格納される (token を含めないこと)。 */
  stderr: string;
  /** Meta CLI binary path (resolved 時は env、未 resolve 時は null)。 */
  binary: string | null;
  accountKey: string;
  sanitizedCommand: string;
  sanitizedArgs: string[];
}

function prefailedActivatePayloadEnvelope(
  input: PreSpawnActivatePayloadEnvelopeInput
): Record<string, JsonValue> {
  const now = new Date().toISOString();
  return {
    accountKey: input.accountKey,
    binary: input.binary,
    sanitizedCommand: input.sanitizedCommand,
    sanitizedArgs: input.sanitizedArgs,
    exitCode: null,
    signal: null,
    exitClass: input.exitClass,
    recommendedAction: recommendActionForExit(
      input.exitClass
    ) as unknown as JsonValue,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    timedOut: false,
    stdout: "",
    stderr: input.stderr,
    throttleHeaders: null,
  };
}

// ---------------------------------------------------------------------
// MockActivateExecutor
// ---------------------------------------------------------------------

/**
 * regression fix: `ADDROID_META_CLI_BIN` 未設定時に factory が返す fail-closed
 * 経路。Activate は PAUSED → ACTIVE で実 Meta API に課金を開始させる最終操作の
 * ため、CLI 未設定で mock success を返してはならない (Apply の MockApplyExecutor
 * と非対称)。
 *
 * 本 executor は常に `unknown_error` + `meta.cli_unknown_error` notify を返し、
 * `runActivate` 側は markHierarchyActive を呼ばず activate.rejected を audit に
 * 記録する。`runActivate` の defensive guard (`appliedRemotely` 未設定 success)
 * とは独立に動作する二重防御。
 */
export class MockActivateExecutor implements ActivateExecutor {
  async executeActivate(input: ActivateExecuteInput): Promise<ActivateExecuteResult> {
    const built = activateNodeToCliArgs(input.node);
    if (!built) {
      return {
        status: "skipped",
        message: `cannot activate: nodeType=${input.node.nodeType} externalId=${input.node.externalId ?? "null"}`,
        logPayload: {
          mode: "mock",
          reason: !input.node.externalId
            ? "no_external_id"
            : "unsupported_node_type",
          nodeType: input.node.nodeType,
        } satisfies JsonValue,
      };
    }
    const detail =
      "ADDROID_META_CLI_BIN is not configured; Activate refuses to fall back to mock success because PAUSED → ACTIVE has real-money side effects";
    // regression fix / regression fix: spawned 経路 (toExecutionLogInput) と同じ
    // canonical command-evidence shape (stdout/stderr/exitCode/signal/timestamps/
    // durationMs/timedOut/throttleHeaders/exitClass/recommendedAction) を
    // logPayload に含める。null/empty/zero 値で正規化することで execution_logs を
    // 横断するコンシューマが mock fail-closed パスを特別扱いせずに済む。
    const envelope = prefailedActivatePayloadEnvelope({
      exitClass: "unknown_error",
      stderr: detail,
      binary: null,
      accountKey: input.node.accountKey,
      sanitizedCommand: `meta-ads-cli ${built.args.join(" ")}`,
      sanitizedArgs: built.args,
    });
    return {
      status: "unknown_error",
      message: `activate ${built.resource} ${input.node.externalId ?? "?"} aborted: Meta Ads CLI is not configured`,
      logPayload: {
        ...envelope,
        mode: "mock",
        stage: "resolve_executor",
        reason: "cli_not_configured",
        resource: built.resource,
        externalId: input.node.externalId,
      } satisfies JsonValue,
      notify: {
        auditAction: "meta.cli_unknown_error",
        detail,
      },
    };
  }
}

// ---------------------------------------------------------------------
// CliActivateExecutor
// ---------------------------------------------------------------------

export interface CliActivateExecutorOptions {
  runner: MetaCliRunner;
}

/**
 * `MetaCliRunner` 経由で `<resource> activate` を実行する本番経路。
 *
 * - argv に access token を載せない (runner 側で env 注入のみ)
 * - exit class は MetaCliRunner.classifyExit によって success / auth_error /
 *   rate_limit_error / api_error / unknown_error に分類されたものをそのまま採用
 * - `recommendedAction` から retry / notify ヒントを ExecuteResult に詰めて返す
 */
export class CliActivateExecutor implements ActivateExecutor {
  private readonly runner: MetaCliRunner;
  constructor(opts: CliActivateExecutorOptions) {
    this.runner = opts.runner;
  }

  async executeActivate(input: ActivateExecuteInput): Promise<ActivateExecuteResult> {
    const built = activateNodeToCliArgs(input.node);
    if (!built) {
      return {
        status: "skipped",
        message: `cannot activate: nodeType=${input.node.nodeType} externalId=${input.node.externalId ?? "null"}`,
        logPayload: {
          reason: !input.node.externalId
            ? "no_external_id"
            : "unsupported_node_type",
          nodeType: input.node.nodeType,
        } satisfies JsonValue,
      };
    }

    const invocation: MetaCliInvocation = {
      accountKey: input.node.accountKey,
      adAccountId: input.node.metaAccountId ?? input.node.accountKey,
      args: built.args,
      refs: {
        refType: "ads_hierarchy",
        refId: input.node.hierarchyId,
      },
    };

    // regression fix: CLI binary/version 未検証で spawn が拒否された場合、
    // mock fallback ではなく unknown_error + meta.cli_unknown_error notify として
    // 返す。Activate は実 Meta API への副作用を起こす最終操作なので、CLI の
    // 動作確認が完了するまで Meta には一切リクエストを出さない。
    //
    // regression fix: Meta token が無い / 期限切れ / 復号失敗の場合も同様に
    // mock fallback ではなく auth_error + oauth.meta.reauth_required notify
    // として返す (apply 側の regression fix と同じ思想)。token は per-invocation
    // で再取得するため、再認証が完了すれば次の Activate 要求から自然に成功する。
    // regression fix: pre-spawn failure paths (version_unverified / load_token)
    // も spawned 経路 (toExecutionLogInput) / MockActivateExecutor / Apply 側
    // pre-spawn 失敗 (prefailedPayloadEnvelope) と同じ canonical command-evidence
    // shape を logPayload に含める。失敗ステージ固有のフィールド (mode/stage/
    // errorName/verification 等) を envelope の上にマージする。
    const sanitizedCommand = `meta-ads-cli ${built.args.join(" ")}`;

    let result;
    try {
      result = await this.runner.run(invocation);
    } catch (err) {
      if (err instanceof MetaCliVersionUnverifiedError) {
        const detail = err.message;
        const verification = err.verification;
        const envelope = prefailedActivatePayloadEnvelope({
          exitClass: "unknown_error",
          stderr: detail,
          binary: null,
          accountKey: input.node.accountKey,
          sanitizedCommand,
          sanitizedArgs: built.args,
        });
        return {
          status: "unknown_error",
          message: `meta-ads-cli ${built.resource} activate aborted before spawn: CLI version not verified`,
          logPayload: {
            ...envelope,
            mode: "cli",
            stage: "verify_version",
            errorName: err.name,
            errorMessage: detail,
            resource: built.resource,
            verification: verification
              ? {
                  ok: verification.ok,
                  actualVersion: verification.actualVersion,
                  minVersion: verification.minVersion,
                  detail: verification.detail,
                }
              : null,
          } satisfies JsonValue,
          notify: {
            auditAction: "meta.cli_unknown_error",
            detail,
          },
        };
      }
      if (
        err instanceof MetaCliMissingTokenError ||
        err instanceof MetaTokenExpiredError ||
        err instanceof MetaAdapterUnauthenticatedError
      ) {
        const detail = err.message;
        const envelope = prefailedActivatePayloadEnvelope({
          exitClass: "auth_error",
          stderr: detail,
          binary: null,
          accountKey: input.node.accountKey,
          sanitizedCommand,
          sanitizedArgs: built.args,
        });
        return {
          status: "auth_error",
          message: `meta-ads-cli ${built.resource} activate aborted before spawn: ${detail}`,
          logPayload: {
            ...envelope,
            mode: "cli",
            stage: "load_token",
            errorName: err.name,
            errorMessage: detail,
            resource: built.resource,
          } satisfies JsonValue,
          notify: {
            auditAction: "oauth.meta.reauth_required",
            detail,
          },
        };
      }
      throw err;
    }
    const logInput = toExecutionLogInput(result, invocation.refs);

    const status: ActivateExecuteResult["status"] =
      result.exitClass === "success"
        ? "success"
        : result.exitClass === "auth_error"
          ? "auth_error"
          : result.exitClass === "rate_limit_error"
            ? "rate_limit_error"
            : result.exitClass === "api_error"
              ? "api_error"
              : "unknown_error";

    const out: ActivateExecuteResult = {
      status,
      message: logInput.message,
      logPayload: logInput.payload as unknown as JsonValue,
    };

    const rec = result.recommendedAction;
    if (rec.kind === "retry_with_backoff") {
      const attempt = input.attempt;
      const delay = Math.min(
        rec.maxBackoffMs,
        rec.initialBackoffMs * Math.pow(2, attempt)
      );
      out.retry = { delayMs: delay, maxAttempts: rec.maxAttempts };
    } else if (
      rec.kind === "notify_reauth" ||
      rec.kind === "notify_api_error" ||
      rec.kind === "fail_fast_notify"
    ) {
      out.notify = {
        auditAction: rec.auditAction,
        detail: rec.reason,
      };
    }
    if (status === "success") {
      // regression fix: defensive marker for runActivate. Only a real Meta CLI
      // success (this branch) is allowed to mark the local hierarchy ACTIVE
      // and write activate.committed. MockActivateExecutor never sets this.
      out.appliedRemotely = true;
      if (input.node.externalId) {
        out.externalId = input.node.externalId;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------

export interface ResolveActivateExecutorOptions {
  env?: NodeJS.ProcessEnv;
  metaAdapter: MetaAdapter;
  /** test seam: 子プロセス起動関数。production は nodeSpawn。 */
  spawnImpl?: typeof nodeSpawn;
  /** test seam: `--version` 出力を直接返す。指定時は real spawn しない。 */
  versionResolver?: () => Promise<string>;
}

export interface ActivateExecutorSelection {
  executor: ActivateExecutor;
  mode: "cli" | "mock";
  reason: string;
  /**
   * regression fix: cli モードでの version verification 結果。`ok=false` でも
   * mode は "cli" のままで、後続 executeActivate が unknown_error fail-closed
   * を返す (mock fallback では Meta に副作用を出さない最終操作を装わない)。
   */
  versionVerification?: MetaCliVersionVerification;
}

/**
 * env と Meta token 状態から、Activate に使う executor を決定する。
 *
 * - `ADDROID_META_CLI_BIN` 未設定 → fail-closed `MockActivateExecutor`
 *   (Activate は実 Meta API への副作用を起こす最終操作なので、CLI 未設定状態で
 *    mock success を返してはならない。本 mock は unknown_error +
 *    `meta.cli_unknown_error` notify を返す — regression fix)。
 * - `ADDROID_META_CLI_BIN` 設定 → CliActivateExecutor。token が現時点で読めるか
 *   どうかでは分岐しない:
 *     - token は per-invocation で `metaAdapter.loadAccessTokenPlaintext()` から
 *       再取得するので、reauth/refresh の結果が次の Activate に反映される。
 *     - token が無い / 期限切れ / 復号失敗の場合、`CliActivateExecutor.executeActivate`
 *       が auth_error + `oauth.meta.reauth_required` notify として返し、
 *       runActivate が reauth audit を残して中断する (regression fix)。Mock fallback
 *       は使わない (apply 経路の regression fix と同じ思想)。
 *
 * regression fix: cli モードでは runner に `minVersion` と
 * `requireVerifiedVersion: true` を渡し、ここで `verifyVersion()` を 1 回呼ぶ。
 * 検証失敗時も mode は "cli" のままにし、`MetaCliVersionUnverifiedError` を
 * `CliActivateExecutor.executeActivate` が unknown_error として返す。
 */
export async function resolveActivateExecutor(
  opts: ResolveActivateExecutorOptions
): Promise<ActivateExecutorSelection> {
  const env = opts.env ?? process.env;
  const binaryPath = env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) {
    return {
      executor: new MockActivateExecutor(),
      mode: "mock",
      reason:
        "ADDROID_META_CLI_BIN is not set; activate will fail closed (Meta CLI not configured)",
    };
  }
  const adapter = opts.metaAdapter;
  const runnerOpts: MetaCliRunnerOptions = {
    binaryPath,
    spawnImpl: opts.spawnImpl ?? nodeSpawn,
    minVersion: META_CLI_MIN_VERSION,
    requireVerifiedVersion: true,
    // regression fix: per-invocation token load. 例外
    // (MetaTokenExpiredError / MetaAdapterUnauthenticatedError) は catch せず
    // runner.run() 経由で CliActivateExecutor.executeActivate に伝播させ、
    // そこで auth_error + oauth.meta.reauth_required notify に変換する。
    loadTokenForAccount: async () => {
      const lease = await adapter.loadAccessTokenPlaintext();
      if (!lease) return null;
      return { accessToken: lease.accessToken };
    },
    ...(opts.versionResolver ? { versionResolver: opts.versionResolver } : {}),
  };
  const runner = new MetaCliRunner(runnerOpts);
  const verification = await runner.verifyVersion();
  const reason = verification.ok
    ? `using meta-ads-cli at ${binaryPath} for activate (${verification.detail}; token loaded per invocation from MetaAdapter)`
    : `meta-ads-cli at ${binaryPath} failed version verification (${verification.detail}); activate will fail closed until the CLI is installed/upgraded`;
  return {
    executor: new CliActivateExecutor({ runner }),
    mode: "cli",
    reason,
    versionVerification: verification,
  };
}
