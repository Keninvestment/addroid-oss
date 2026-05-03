// AdDroid OSS — PlanAction → MetaActionExecutor adapter (apps/worker side).
//
// `runExecuteApply` から渡される 1 つの PlanAction を Meta CLI runner の
// invocation に翻訳して実行し、`ExecuteActionResult` (sanitized) に再構成する。
//
// 動作モード:
//   - cli         : `ADDROID_META_CLI_BIN` が設定されている本番経路。
//                   `MetaCliRunner.run` が token を環境変数経由で注入し、
//                   stdout/stderr は token-redacted で返す。token 未連携 / 期限切れは
//                   CliApplyExecutor 内部で auth_error + reauth notify に変換される。
//   - mock        : `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK=1`
//                   の場合に限り選ばれる、明示的なローカルテストシミュレーション経路。
//                   Meta API には一切リクエストせず即 success を返す (the current implementation の
//                   "mocked equivalent in local tests" 受入要件に対応)。
//   - fail_closed : `ADDROID_META_CLI_BIN` 未設定かつ `ADDROID_META_ADS_CLI_MOCK`
//                   も立っていない場合の既定フェイルクローズド経路。Apply は
//                   PAUSED 作成であっても Meta API に副作用を出す可能性があり、
//                   CLI 未設定状態で「mock success」を装うと PR がマージされた
//                   だけで `apply.executed` が記録されてしまうため、CLI 不在は
//                   常に unknown_error + meta.cli_unknown_error notify として
//                   失敗扱いにする (regression fix)。
//
// 本ファイルは Prisma を import しない。token は MetaAdapter から都度復号して
// 取得し、メソッドスコープでのみ保持する。

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
  ExecuteActionInput,
  ExecuteActionResult,
  JsonValue,
  MetaActionExecutor,
} from "@addroid/queue";
import type { PlanAction } from "@addroid/yaml-schemas";

// ---------------------------------------------------------------------
// regression fix: canonical pre-spawn payload shape
//
// Spawned MetaCli runs persist a payload with a fixed set of evidence fields
// (stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/throttleHeaders/
// exitClass/recommendedAction). Pre-spawn failures (CLI not configured, version
// not verified, token missing/expired) used to omit those fields entirely, which
// made `execution_logs` rows for failed-before-spawn invocations structurally
// different from spawned invocations and broke uniform consumers (UI panels,
// log analytics).
//
// `prefailedPayloadEnvelope` returns the canonical envelope with
// null/empty/zero values so callers only have to merge their own
// failure-specific fields (mode, stage, errorName, etc.) on top.
// ---------------------------------------------------------------------

interface PreSpawnPayloadEnvelopeInput {
  exitClass: MetaCliExitClass;
  /** Sanitized 1 行説明。stderr スロットに格納される (token を含めないこと)。 */
  stderr: string;
  /** Meta CLI binary path (resolved 時は env、未 resolve 時は null)。 */
  binary: string | null;
  accountKey: string;
  sanitizedCommand: string;
  sanitizedArgs: string[];
  /**
   * regression fix: spawned 経路では `toExecutionLogInput` が
   * `refs.pullRequestNumber` / `refs.approvalRecordId` を payload に焼き付ける。
   * pre-spawn 失敗時もこれらを含めることで、execution_logs を横断するコンシューマ
   * (UI ExecutionLogPanel / 監査トレース) が「失敗パスだけ PR / 承認境界が分からない」
   * 状態に陥らないようにする。`undefined` は payload に含めない。
   */
  pullRequestNumber?: number;
  approvalRecordId?: string;
}

function prefailedPayloadEnvelope(
  input: PreSpawnPayloadEnvelopeInput
): Record<string, JsonValue> {
  const now = new Date().toISOString();
  const out: Record<string, JsonValue> = {
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
  if (input.pullRequestNumber !== undefined) {
    out.pullRequestNumber = input.pullRequestNumber;
  }
  if (input.approvalRecordId !== undefined) {
    out.approvalRecordId = input.approvalRecordId;
  }
  return out;
}

// ---------------------------------------------------------------------
// regression fix: canonical mock-success payload shape
//
// MockApplyExecutor は実 Meta CLI を spawn しないため、`toExecutionLogInput` の
// 出力 (stdout/stderr/exitCode/startedAt/finishedAt/durationMs/timedOut/
// throttleHeaders/exitClass/recommendedAction) を経由しない。`/apply/[id]` の
// ExecutionLogPanel など payload 形状に依存するコンシューマが mock 経路だけ
// 評価分岐しなくて済むよう、success payload にも canonical 形状を込める。
// 値は実 CLI 成功時に対応する確定値 (exitCode=0, exitClass="success",
// throttleHeaders=null) で埋める。
// ---------------------------------------------------------------------

interface MockSuccessPayloadEnvelopeInput {
  accountKey: string;
  sanitizedCommand: string;
  sanitizedArgs: string[];
  /** 表示用の 1 行説明 (token を含めないこと)。 */
  stdout: string;
}

function mockSuccessPayloadEnvelope(
  input: MockSuccessPayloadEnvelopeInput
): Record<string, JsonValue> {
  const now = new Date().toISOString();
  return {
    accountKey: input.accountKey,
    binary: null,
    sanitizedCommand: input.sanitizedCommand,
    sanitizedArgs: input.sanitizedArgs,
    exitCode: 0,
    signal: null,
    exitClass: "success",
    recommendedAction: recommendActionForExit(
      "success"
    ) as unknown as JsonValue,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    timedOut: false,
    stdout: input.stdout,
    stderr: "",
    throttleHeaders: null,
  };
}

// ---------------------------------------------------------------------
// PlanAction → CLI args
// ---------------------------------------------------------------------

/**
 * 1 つの PlanAction を公式 `meta ads <resource> <verb> ...` 形式の CLI args に変換する。
 *
 * - resource/verb は `META_CLI_SUPPORTED_OPERATIONS` のマトリクスに含まれるもののみ使う。
 *   experiment 系はマトリクスに無いため、現契約では skipped を返し、別契約での
 *   検証後に追加する (fail closed)。
 * - access token / ad account id は決して args に乗せない。CLI runner 側が公式
 *   CLI 互換 env (`ACCESS_TOKEN` / `AD_ACCOUNT_ID`) として注入する。
 */
function planActionToCliArgs(action: PlanAction): {
  args: string[];
  resource: string;
  verb: string;
} | null {
  switch (action.kind) {
    case "create_campaign":
      return {
        resource: "campaigns",
        verb: "create",
        args: [
          "ads",
          "campaign",
          "create",
          "--id",
          action.campaignId,
          "--name",
          action.name,
          "--objective",
          action.objective,
          "--initial-state",
          action.initialState,
          ...budgetFlags(action.budget),
        ],
      };
    case "update_campaign":
      return {
        resource: "campaigns",
        verb: "update",
        args: [
          "ads",
          "campaign",
          "update",
          "--id",
          action.campaignId,
          "--changes",
          JSON.stringify(action.changes),
        ],
      };
    case "create_adset":
      return {
        resource: "adsets",
        verb: "create",
        args: [
          "ads",
          "adset",
          "create",
          "--campaign",
          action.campaignId,
          "--id",
          action.adsetId,
          "--name",
          action.name,
          "--initial-state",
          action.initialState,
          ...(action.budget ? budgetFlags(action.budget) : []),
          "--targeting",
          JSON.stringify(action.targeting),
        ],
      };
    case "update_adset":
      return {
        resource: "adsets",
        verb: "update",
        args: [
          "ads",
          "adset",
          "update",
          "--campaign",
          action.campaignId,
          "--id",
          action.adsetId,
          "--changes",
          JSON.stringify(action.changes),
        ],
      };
    case "create_ad":
      return {
        resource: "ads",
        verb: "create",
        args: [
          "ads",
          "ad",
          "create",
          "--campaign",
          action.campaignId,
          "--adset",
          action.adsetId,
          "--id",
          action.adId,
          "--name",
          action.name,
          "--creative",
          action.creativeRef,
          "--initial-state",
          action.initialState,
        ],
      };
    case "update_ad":
      return {
        resource: "ads",
        verb: "update",
        args: [
          "ads",
          "ad",
          "update",
          "--campaign",
          action.campaignId,
          "--adset",
          action.adsetId,
          "--id",
          action.adId,
          "--changes",
          JSON.stringify(action.changes),
        ],
      };
    case "create_creative":
      return {
        resource: "creatives",
        verb: "create",
        args: [
          "ads",
          "creative",
          "create",
          "--id",
          action.creativeId,
          "--name",
          action.name,
          "--media-type",
          action.mediaType,
          ...(action.headline ? ["--headline", action.headline] : []),
          ...(action.primaryText ? ["--primary-text", action.primaryText] : []),
          ...(action.callToAction ? ["--cta", action.callToAction] : []),
        ],
      };
    case "update_creative":
      return {
        resource: "creatives",
        verb: "update",
        args: [
          "ads",
          "creative",
          "update",
          "--id",
          action.creativeId,
          "--changes",
          JSON.stringify(action.changes),
        ],
      };
    // delete_* / experiment_* は META_CLI_SUPPORTED_OPERATIONS に未登録 (fail closed)。
    default:
      return null;
  }
}

function budgetFlags(b: { dailyUsd?: number; lifetimeUsd?: number }): string[] {
  const out: string[] = [];
  if (b.dailyUsd !== undefined) out.push("--daily-usd", String(b.dailyUsd));
  if (b.lifetimeUsd !== undefined) out.push("--lifetime-usd", String(b.lifetimeUsd));
  return out;
}

// ---------------------------------------------------------------------
// regression fix: external_id surfacing on Apply success
// ---------------------------------------------------------------------

/**
 * Apply success が ads_hierarchy 永続化のために external_id を必須とする
 * PlanAction kinds (= Activate 経路がこの行を読むため)。
 *
 * - `create_campaign` / `create_adset` / `create_ad` は新規 row を生成するため
 *   external_id 無しで永続化すると Activate が「external_id 未確定」で永久に
 *   拒否される。
 * - `create_creative` は ads_hierarchy 対象外 (creatives テーブル管轄)。
 * - `update_*` は既存 row 上書きで external_id を保持できるため対象外。
 */
function isCreateRequiringExternalId(kind: PlanAction["kind"]): boolean {
  return (
    kind === "create_campaign" ||
    kind === "create_adset" ||
    kind === "create_ad"
  );
}

/**
 * Meta CLI の sanitized stdout から作成された Meta オブジェクトの external_id を
 * best-effort で抽出する。CLI は通常 `{"id":"<numeric>"}` 系の JSON を返す
 * (Meta Graph API の create response をそのまま吐く実装が多い) ため、まず
 * stdout 全体 → 各行の順で JSON 解析を試み、`externalId` / `external_id` /
 * `id` のいずれかが string/number で見つかればそれを採用する。JSON で取れない
 * ときは regex で `"id":"…"` 等のパターンを拾う。token は redact 済みの
 * stdout を入力に取る前提なので、この関数自体は redaction を行わない。
 *
 * 抽出できなかった場合は undefined。呼び出し側 (CliApplyExecutor) は
 * undefined のまま ExecuteActionResult を返し、queue 側 runExecuteApply が
 * create_* かつ external_id 欠落のケースを fail-closed する。
 */
export function extractExternalIdFromCliStdout(
  stdout: string
): string | undefined {
  if (!stdout) return undefined;
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;

  const fromWhole = tryExtractIdFromJsonText(trimmed);
  if (fromWhole) return fromWhole;

  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const fromLine = tryExtractIdFromJsonText(t);
    if (fromLine) return fromLine;
  }

  // 最後の砦: 自由形式テキストに `"id":"..."` 等が紛れているケース。
  const m = stdout.match(
    /"(externalId|external_id|id)"\s*:\s*"([^"\\]+)"/
  );
  if (m && m[2]) return m[2];
  const numeric = stdout.match(
    /"(externalId|external_id|id)"\s*:\s*(\d+)/
  );
  if (numeric && numeric[2]) return numeric[2];
  return undefined;
}

function tryExtractIdFromJsonText(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return extractIdField(parsed);
}

function extractIdField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["externalId", "external_id", "id"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * MockApplyExecutor が create_* / update_* に対して返す決定的な mocked external_id。
 *
 * Activate (PAUSED → ACTIVE) は ads_hierarchy.externalId を読んで Meta CLI を
 * 叩くため、`ADDROID_META_ADS_CLI_MOCK=1` の local-test simulation 経路でも
 * external_id が空だと Activate が永久に拒否される。Mock は実 Meta API を
 * 叩かないため、accountKey と YAML 上の id を組み合わせた決定的な値を返す。
 *
 * `creative` は ads_hierarchy 対象外だが、payload の可観測性のため同じ規則で
 * 値を返す。
 */
function deterministicMockExternalId(action: PlanAction): string | undefined {
  switch (action.kind) {
    case "create_campaign":
    case "update_campaign":
      return `mock-${action.account}-cmp-${action.campaignId}`;
    case "create_adset":
    case "update_adset":
      return `mock-${action.account}-as-${action.adsetId}`;
    case "create_ad":
    case "update_ad":
      return `mock-${action.account}-ad-${action.adId}`;
    case "create_creative":
    case "update_creative":
      return `mock-${action.account}-cr-${action.creativeId}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------
// MockApplyExecutor — explicit local-test simulation only
// ---------------------------------------------------------------------

/**
 * Meta API には一切触れず即 success を返す executor。
 * `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK=1` の組み合わせで
 * 明示的にローカルテストシミュレーションを要求された場合のみ選ばれる
 * (the current implementation 「mocked equivalent in local tests」受入要件)。
 *
 * regression fix: 環境変数 1 本だけで暗黙に有効にしてはならない。CLI 未設定で
 * MOCK フラグも立っていない既定状態は `FailClosedApplyExecutor` 経路に倒す。
 */
export class MockApplyExecutor implements MetaActionExecutor {
  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const args = planActionToCliArgs(input.action);
    if (!args) {
      return {
        status: "skipped",
        message: `unsupported action kind ${input.action.kind} skipped (verified ops matrix)`,
        logPayload: { reason: "unsupported_action", actionKind: input.action.kind },
      };
    }
    // regression fix: local-test simulation でも create_* の external_id を
    // 確定させないと、後続の Activate が ads_hierarchy.externalId 未設定で
    // 永久に拒否され、mocked equivalent としての受入要件を満たさなくなる。
    const mockedExternalId = deterministicMockExternalId(input.action);
    const sanitizedCommand = `meta-ads-cli ${args.args.join(" ")}`;
    // regression fix: mock 経路でも spawned 実行と同じ canonical command-evidence
    // shape (stdout/stderr/exitCode/timestamps/durationMs/timedOut/throttleHeaders/
    // exitClass/recommendedAction) を logPayload に含める。値は実 CLI 成功時の確定値
    // (exitCode=0, exitClass="success", throttleHeaders=null) で埋める。
    const envelope = mockSuccessPayloadEnvelope({
      accountKey: input.action.account,
      sanitizedCommand,
      sanitizedArgs: args.args,
      stdout: `mock-applied ${args.resource} ${args.verb} (PAUSED-by-default)`,
    });
    const approvalRecordId = input.context.approvalRecordId;
    if (typeof approvalRecordId === "string" && approvalRecordId.length > 0) {
      envelope.approvalRecordId = approvalRecordId;
    }
    if (typeof input.context.prNumber === "number") {
      envelope.pullRequestNumber = input.context.prNumber;
    }
    const out: ExecuteActionResult = {
      status: "success",
      message: `mock-applied ${args.resource} ${args.verb} (PAUSED-by-default)`,
      logPayload: {
        ...envelope,
        mode: "mock",
        resource: args.resource,
        verb: args.verb,
        action: JSON.parse(JSON.stringify(input.action)) as JsonValue,
        externalId: mockedExternalId ?? null,
      } satisfies JsonValue,
    };
    if (mockedExternalId) out.externalId = mockedExternalId;
    return out;
  }
}

// ---------------------------------------------------------------------
// FailClosedApplyExecutor — default when Meta CLI is not configured
// ---------------------------------------------------------------------

/**
 * regression fix: `ADDROID_META_CLI_BIN` が未設定で、`ADDROID_META_ADS_CLI_MOCK=1`
 * による明示的なローカルテストシミュレーションも要求されていないときの既定経路。
 *
 * Apply は PAUSED-by-default で Meta オブジェクトを作成する操作のため、CLI が
 * 未設定の状態で `MockApplyExecutor` 経由で success を返すと、PR がマージされた
 * だけで `apply.executed` が audit に積まれ、外部観察上は「Meta 側に PAUSED
 * リソースが作られた」ように見えてしまう (実際には何も作られていない)。
 *
 * よって本 executor は常に `unknown_error` + `meta.cli_unknown_error` notify を
 * 返し、`runExecuteApply` 側は `apply_jobs.state=failed` + `apply.failed` audit
 * を記録する。アクション単位の `execution_logs` には sanitized command/args と
 * 失敗理由が残る。
 */
export class FailClosedApplyExecutor implements MetaActionExecutor {
  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const args = planActionToCliArgs(input.action);
    if (!args) {
      return {
        status: "skipped",
        message: `unsupported action kind ${input.action.kind} skipped (verified ops matrix)`,
        logPayload: { reason: "unsupported_action", actionKind: input.action.kind },
      };
    }
    const detail =
      "ADDROID_META_CLI_BIN is not configured and ADDROID_META_ADS_CLI_MOCK is not set; apply refuses to fall back to mock success outside explicit local-test simulation";
    // regression fix: pre-spawn failure でも spawned 実行と同じ canonical
    // command-evidence shape (stdout/stderr/exitCode/timestamps/throttleHeaders)
    // を logPayload に含める。null/sanitized 値で埋めることで、execution_logs を
    // 横断するコンシューマ (UI panel / log 解析) が失敗パスを特別扱いせずに済む。
    // regression fix: Cli pre-spawn 失敗と同じく refs.pullRequestNumber /
    // refs.approvalRecordId を payload に焼き付け、失敗パスでも PR / 承認境界の
    // 紐付けを保つ。
    const ctxApprovalRecordId = input.context.approvalRecordId;
    const envelope = prefailedPayloadEnvelope({
      exitClass: "unknown_error",
      stderr: detail,
      binary: null,
      accountKey: input.action.account,
      sanitizedCommand: `meta-ads-cli ${args.args.join(" ")}`,
      sanitizedArgs: args.args,
      pullRequestNumber: input.context.prNumber,
      ...(typeof ctxApprovalRecordId === "string" && ctxApprovalRecordId.length > 0
        ? { approvalRecordId: ctxApprovalRecordId }
        : {}),
    });
    return {
      status: "unknown_error",
      message: `apply ${args.resource} ${args.verb} aborted: Meta Ads CLI is not configured`,
      logPayload: {
        ...envelope,
        mode: "fail_closed",
        stage: "resolve_executor",
        reason: "cli_not_configured",
        resource: args.resource,
        verb: args.verb,
      } satisfies JsonValue,
      notify: {
        auditAction: "meta.cli_unknown_error",
        detail,
      },
    };
  }
}

// ---------------------------------------------------------------------
// CliApplyExecutor — Meta Ads CLI 経由
// ---------------------------------------------------------------------

export interface CliApplyExecutorOptions {
  runner: MetaCliRunner;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null>;
}

export class CliApplyExecutor implements MetaActionExecutor {
  private readonly runner: MetaCliRunner;
  private readonly resolveAdAccountId?: (accountKey: string) => Promise<string | null>;
  constructor(opts: CliApplyExecutorOptions) {
    this.runner = opts.runner;
    this.resolveAdAccountId = opts.resolveAdAccountId;
  }

  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const args = planActionToCliArgs(input.action);
    if (!args) {
      return {
        status: "skipped",
        message: `unsupported action kind ${input.action.kind} (not in META_CLI_SUPPORTED_OPERATIONS)`,
        logPayload: { reason: "unsupported_action", actionKind: input.action.kind },
      };
    }
    // regression fix: Apply 経路の MetaCli invocation refs に approvalRecordId を
    // 載せる。runExecuteApply は revalidation 成功時に
    // `ApplyJobContext.approvalRecordId` を `loadApplyApprovalSnapshot` から
    // 焼き付けており、この値が `toExecutionLogInput` 経由で execution_logs の
    // payload に保存され、Apply の各 CLI 実行を承認境界 (approval_records) と
    // 結び付ける。snapshot から取れなかった場合 (型上 null/undefined) は refs に
    // 載せない (toExecutionLogInput が undefined を skip する)。
    const refs: NonNullable<MetaCliInvocation["refs"]> = {
      refType: "apply_job",
      refId: input.context.applyJobId,
      pullRequestNumber: input.context.prNumber,
    };
    const approvalRecordId = input.context.approvalRecordId;
    if (typeof approvalRecordId === "string" && approvalRecordId.length > 0) {
      refs.approvalRecordId = approvalRecordId;
    }
    const invocation: MetaCliInvocation = {
      accountKey: input.action.account,
      adAccountId: this.resolveAdAccountId
        ? await this.resolveAdAccountId(input.action.account)
        : input.action.account,
      args: args.args,
      refs,
    };
    // regression fix: pre-spawn failure paths (version_unverified / load_token /
    // unsupported_op など) は spawned 実行と同じ canonical command-evidence shape
    // (stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/throttleHeaders/
    // exitClass/recommendedAction) を logPayload に含める。null/sanitized 値で埋め、
    // 失敗ステージ固有のフィールド (mode/stage/errorName/verification 等) を envelope の
    // 上にマージする。
    const sanitizedCommand = `meta-ads-cli ${args.args.join(" ")}`;

    // regression fix: Meta token が無い / 期限切れ / 復号失敗 の場合、
    // runner.run() は loadTokenForAccount から MetaCliMissingTokenError /
    // MetaTokenExpiredError / MetaAdapterUnauthenticatedError を伝播させる。
    // これは「mock fallback」ではなく auth_error / reauth として扱う必要があるため、
    // ExecuteActionResult に直接マップして runExecuteApply の reauth audit 経路を駆動する。
    //
    // regression fix: CLI binary/version が未検証の場合、runner.run() は
    // MetaCliVersionUnverifiedError を投げて spawn を拒否する。auth と同様に
    // mock fallback ではなく unknown_error + meta.cli_unknown_error notify として
    // 扱い、運用者に CLI のインストール / アップグレードを促す。
    let result;
    try {
      result = await this.runner.run(invocation);
    } catch (err) {
      if (err instanceof MetaCliVersionUnverifiedError) {
        const detail = err.message;
        const verification = err.verification;
        // regression fix: pre-spawn 失敗でも spawned 実行 (toExecutionLogInput) と
        // 同じく refs.pullRequestNumber / refs.approvalRecordId を payload に焼き付け、
        // 失敗パスだけ承認境界 / PR 紐付けが欠落しないようにする。
        const envelope = prefailedPayloadEnvelope({
          exitClass: "unknown_error",
          stderr: detail,
          binary: null,
          accountKey: input.action.account,
          sanitizedCommand,
          sanitizedArgs: args.args,
          pullRequestNumber: input.context.prNumber,
          ...(typeof approvalRecordId === "string" && approvalRecordId.length > 0
            ? { approvalRecordId }
            : {}),
        });
        return {
          status: "unknown_error",
          message: `meta-ads-cli ${args.resource} ${args.verb} aborted before spawn: CLI version not verified`,
          logPayload: {
            ...envelope,
            mode: "cli",
            stage: "verify_version",
            errorName: err.name,
            errorMessage: detail,
            resource: args.resource,
            verb: args.verb,
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
        // regression fix: 同上。auth_error 経路でも refs を payload に焼き付ける。
        const envelope = prefailedPayloadEnvelope({
          exitClass: "auth_error",
          stderr: detail,
          binary: null,
          accountKey: input.action.account,
          sanitizedCommand,
          sanitizedArgs: args.args,
          pullRequestNumber: input.context.prNumber,
          ...(typeof approvalRecordId === "string" && approvalRecordId.length > 0
            ? { approvalRecordId }
            : {}),
        });
        return {
          status: "auth_error",
          message: `meta-ads-cli ${args.resource} ${args.verb} aborted before spawn: ${detail}`,
          logPayload: {
            ...envelope,
            mode: "cli",
            stage: "load_token",
            errorName: err.name,
            errorMessage: detail,
            resource: args.resource,
            verb: args.verb,
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

    // regression fix: status mapping は MetaCliExitClass を 1:1 で射影する。
    // exit class は cli-runner の `classifyExit` が auth/rate/api/unknown に
    // 区別済みなので、ここで再分類しない (recommendedAction が retry/notify を
    // 駆動する単一情報源になる)。
    const status: ExecuteActionResult["status"] =
      result.exitClass === "success"
        ? "success"
        : result.exitClass === "auth_error"
          ? "auth_error"
          : result.exitClass === "rate_limit_error"
            ? "rate_limit_error"
            : result.exitClass === "api_error"
              ? "api_error"
              : "unknown_error";

    const out: ExecuteActionResult = {
      status,
      message: logInput.message,
      logPayload: logInput.payload as unknown as JsonValue,
    };

    // regression fix: success かつ create_* のときは Meta CLI stdout から
    // external_id を抽出して result に乗せる。queue 側 runExecuteApply は
    // ここで externalId が undefined のままだと create_* を fail-closed して
    // ads_hierarchy に null externalId 行を作らないため、抽出可否がそのまま
    // Activate 経路の可用性を決める。
    if (status === "success" && isCreateRequiringExternalId(input.action.kind)) {
      const ext = extractExternalIdFromCliStdout(result.stdout);
      if (ext) out.externalId = ext;
    }

    // regression fix: production 経路は recommendedAction を読み、
    //   - retry_with_backoff → ExecuteActionResult.retry を埋める
    //   - notify_reauth / notify_api_error / fail_fast_notify → notify を埋める
    // ことでオーケストレータに「何を再試行し、何を通知するか」を伝える。
    // exit class を switch する従来の経路を廃止し、recommendedAction を
    // 単一情報源にする。
    const rec = result.recommendedAction;
    if (rec.kind === "retry_with_backoff") {
      const attempt = input.attempt;
      const delay = Math.min(
        rec.maxBackoffMs,
        rec.initialBackoffMs * Math.pow(2, attempt)
      );
      out.retry = {
        delayMs: delay,
        maxAttempts: rec.maxAttempts,
      };
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
    return out;
  }
}

// ---------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------

/**
 * regression fix: Apply 経路で要求する Meta Ads CLI の最低バージョン。
 * `META_CLI_SUPPORTED_OPERATIONS` の `verifiedAt` で
 * 動作確認した CLI のフロアと整合させる。`verifyVersion()` がこの値より
 * 古い CLI を返した場合、production は spawn を fail-closed にする。
 */
export const META_CLI_MIN_VERSION = "0.5.0";

export interface ResolveApplyExecutorOptions {
  env?: NodeJS.ProcessEnv;
  metaAdapter: MetaAdapter;
  /**
   * accountKey (`ads/accounts/<key>`) から Meta 公式 CLI が要求する
   * `AD_ACCOUNT_ID` (`act_<digits>`) を解決する。未指定時は accountKey を fallback。
   */
  resolveAdAccountId?: (accountKey: string) => Promise<string | null>;
  /** test seam: 子プロセス起動関数。production は nodeSpawn。 */
  spawnImpl?: typeof nodeSpawn;
  /**
   * test seam: `verifyVersion()` が呼ぶ `--version` の出力を直接返す。
   * production では使わず、real CLI を spawn して検証する。
   */
  versionResolver?: () => Promise<string>;
}

export interface ApplyExecutorSelection {
  executor: MetaActionExecutor;
  mode: "cli" | "mock" | "fail_closed";
  reason: string;
  /**
   * regression fix: cli モードで実施した version verification の結果。
   * mock / fail_closed モードでは undefined。`ok=false` のときも mode は "cli"
   * のままで、executeAction が MetaCliVersionUnverifiedError → unknown_error
   * として fail-closed する (mock fallback は許可しない)。
   */
  versionVerification?: MetaCliVersionVerification;
}

/**
 * env と Meta OAuth 状態から、apply に使う executor を決定する。
 *
 * - `ADDROID_META_CLI_BIN` 設定 → CliApplyExecutor。token が現時点で読めるか
 *   どうかでは分岐しない:
 *     - token は per-invocation で `metaAdapter.loadAccessTokenPlaintext()`
 *       から再取得するので、reauth/refresh の結果が次の execute_apply に反映される
 *       (worker 起動時の lease に固定されない)。
 *     - token が無い / 期限切れ / 復号失敗の場合、`CliApplyExecutor.executeAction`
 *       が auth_error + `oauth.meta.reauth_required` notify として返し、
 *       `runExecuteApply` が reauth audit を残して中断する (regression fix)。
 *       Mock fallback は使わない。
 * - `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK=1` → MockApplyExecutor
 *   (the current implementation 「mocked equivalent in local tests」経路。ローカル / browser
 *    test を成立させるための明示的シミュレーション)。
 * - `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK` 未設定 →
 *   FailClosedApplyExecutor (regression fix)。CLI 未設定なのに `apply.executed`
 *   が audit に積まれる「mock サイレント成功」状態を防ぐため、unknown_error +
 *   `meta.cli_unknown_error` notify として失敗扱いにする。
 *
 * regression fix: CLI モードの runner には `minVersion` と
 * `requireVerifiedVersion: true` を必ず渡し、ここで `verifyVersion()` を 1 回
 * 呼んでバイナリの存在と minVersion 充足を検査する。検査に失敗した場合も
 * mode は "cli" のままで、後続の executeAction が
 * `MetaCliVersionUnverifiedError` を unknown_error + `meta.cli_unknown_error`
 * notify として返す (mock fallback で実 Meta API 操作を装わない)。
 */
export async function resolveApplyExecutor(
  opts: ResolveApplyExecutorOptions
): Promise<ApplyExecutorSelection> {
  const env = opts.env ?? process.env;
  const binaryPath = env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) {
    // regression fix: CLI 未設定時に明示的な local-test simulation を要求された
    // ときだけ MockApplyExecutor を選ぶ。フラグ無しで暗黙に mock success を
    // 返すと、CLI 未設定の本番ワーカが `apply.executed` を audit に積んで
    // しまい、Meta に何も反映していないのに反映済みのように見える事故を招く。
    if (env.ADDROID_META_ADS_CLI_MOCK === "1") {
      return {
        executor: new MockApplyExecutor(),
        mode: "mock",
        reason:
          "ADDROID_META_CLI_BIN is not set; ADDROID_META_ADS_CLI_MOCK=1 selects the local-test mock executor",
      };
    }
    return {
      executor: new FailClosedApplyExecutor(),
      mode: "fail_closed",
      reason:
        "ADDROID_META_CLI_BIN is not set and ADDROID_META_ADS_CLI_MOCK is not '1'; apply will fail closed (Meta Ads CLI not configured)",
    };
  }
  const adapter = opts.metaAdapter;
  const runnerOpts: MetaCliRunnerOptions = {
    binaryPath,
    spawnImpl: opts.spawnImpl ?? nodeSpawn,
    minVersion: META_CLI_MIN_VERSION,
    requireVerifiedVersion: true,
    // regression fix: per-invocation token load. 例外 (MetaTokenExpiredError 等) は
    // catch せず runner.run() 経由で CliApplyExecutor.executeAction に伝播させ、
    // そこで auth_error/reauth path に変換する。
    loadTokenForAccount: async () => {
      const lease = await adapter.loadAccessTokenPlaintext();
      if (!lease) return null;
      return { accessToken: lease.accessToken };
    },
    ...(opts.versionResolver ? { versionResolver: opts.versionResolver } : {}),
  };
  const runner = new MetaCliRunner(runnerOpts);
  // regression fix: verify the CLI binary/version once at factory time.
  // 結果は runner にキャッシュされ、後続の `run()` がそれを参照して spawn を
  // 許可/拒否する (cli-runner.ts のフェイルクローズドゲート)。
  const verification = await runner.verifyVersion();
  const reason = verification.ok
    ? `using meta-ads-cli at ${binaryPath} (${verification.detail}; token loaded per invocation from MetaAdapter)`
    : `meta-ads-cli at ${binaryPath} failed version verification (${verification.detail}); apply will fail closed until the CLI is installed/upgraded`;
  return {
    executor: new CliApplyExecutor({
      runner,
      ...(opts.resolveAdAccountId ? { resolveAdAccountId: opts.resolveAdAccountId } : {}),
    }),
    mode: "cli",
    reason,
    versionVerification: verification,
  };
}
