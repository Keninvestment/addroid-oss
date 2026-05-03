// AdDroid OSS — /adops slash command boundary (Implementation item).
//
// 本モジュールは Slack Socket Mode から流入した `/adops <subcommand> [args]`
// に対し、3 秒以内 ack → pg-boss にキュー → response_url で結果返信、を実現する
// 純粋な層を提供する。Slack 連携は完全に任意であり、本モジュールは Slack 通信
// (Socket Mode WebSocket) を一切張らない: 入口で渡される Slack request payload
// と、出口の response_url POST だけを取り扱う。
//
// 役割分担:
//   1. {@link parseSlashCommand}     — Slack の form-encoded payload を正規化
//   2. {@link buildAckMessage}       — 3 秒以内に Slack に返す即時 ack テキスト
//   3. {@link enqueueSlackCommandJob} — pg-boss に `slack_command` を送出
//   4. {@link runSlackCommandJob}    — 非同期ハンドラ (worker から呼ぶ)
//   5. {@link postSlackResponse}     — response_url に最終結果を sanitized で返す
//
// 設計原則:
//   - Prisma / pg-boss / Slack SDK / fetch を直接 import しない (test seam)。
//   - 失敗が GitOps polling / Apply / Cron に伝播してはいけない契約 (acceptance)。
//     このため runSlackCommandJob は throw せず `SlashCommandJobResult` を返す。
//   - sanitize-on-render: response_url に出すテキスト / Block Kit body は
//     {@link sanitizeForSlack} を 1 度通す (二重防御として呼び出し前に既に
//     sanitize 済みでも改めて redactor を通す)。
//   - PR 承認の主経路は GitHub merge / Web UI。Slack `/adops` は通知 + 簡易
//     クエリ + 別操作の audited Activate のみを担う (UI plan §0.18)。

// ---------------------------------------------------------------------
// 1) pg-boss job 名 + Slack slash command 定数
// ---------------------------------------------------------------------

/** pg-boss queue 名。execute_apply と並ぶ単独 work キュー。 */
export const SLACK_COMMAND_JOB_NAME = "slack_command" as const;

/**
 * AdDroid が登録する root slash command。`@addroid/config` 側
 * (`SLACK_SLASH_COMMAND`) と同値で必ず一致する必要がある — manifest と
 * 実行時 parser の両側でドリフトしていないかは型ではなくテストで担保する
 * (`__tests__/slack-command.test.ts` に対称性チェックがある)。
 *
 * 文字列を分かれて持つのは、`@addroid/queue` から `@addroid/config` への
 * 依存追加を契約上避けたいため (dependency manifest の変更は要承認)。
 */
export const SLACK_SLASH_COMMAND = "/adops" as const;

/**
 * `/adops` 配下のサブコマンド。`@addroid/config/SLACK_SLASH_SUBCOMMANDS`
 * と同集合で必ず一致する。
 */
export const SLACK_SLASH_SUBCOMMANDS = [
  "report",
  "budget",
  "improve",
  "status",
  "accounts",
  "activate",
] as const;

export type SlashSubcommand = (typeof SLACK_SLASH_SUBCOMMANDS)[number];

/** Slack `/adops` POST が運ぶ form-encoded フィールド (関心のあるもの)。 */
export interface RawSlackSlashCommandRequest {
  /** 例: "/adops"。 */
  command: string;
  /** subcommand と引数。例: "report" / "activate camp_123"。 */
  text: string;
  /** Slack ユーザ ID (例: "U012ABC"). actor 表示と audit_logs 用。 */
  user_id: string;
  /** Slack ユーザ名 (handle, 既に Slack 側で sanitize 済み)。 */
  user_name?: string;
  /** チャンネル ID (例: "C012ABC")。 */
  channel_id: string;
  /** Team / workspace の Slack 側 ID。 */
  team_id?: string;
  /** 30 分有効な Slack response_url。 */
  response_url: string;
  /** Slack が一意に振る trigger_id (本実装ではログ用のみ)。 */
  trigger_id?: string;
}

export type SlashCommandParseError =
  | "wrong_command"
  | "empty_subcommand"
  | "unknown_subcommand"
  | "activate_missing_target";

export interface SlashCommandParseFailure {
  ok: false;
  reason: SlashCommandParseError;
  message: string;
}

export interface ParsedSlashCommand {
  ok: true;
  subcommand: SlashSubcommand;
  /** activate 時の対象 (ads_hierarchy.id または external id)。それ以外は空文字。 */
  target: string;
  /** 余剰引数 (将来拡張で `--mode auto_apply` 等を受ける枠)。本タスクでは未使用。 */
  rest: string[];
  /** sanitize 済み元テキスト。audit_logs に保存できる短い人読みフォーマット。 */
  rawText: string;
}

export type SlashCommandParseResult =
  | ParsedSlashCommand
  | SlashCommandParseFailure;

// ---------------------------------------------------------------------
// 3) Parser
// ---------------------------------------------------------------------

/**
 * Slack 入口で `/adops report ...` を構造体に正規化する。
 *
 * - `request.command` が `/adops` でなければ `wrong_command` で拒否。
 * - text が空 / 未対応 subcommand のときは `empty_subcommand` /
 *   `unknown_subcommand` を返し、ack 段階で usage を見せる。
 * - `activate` のみ第 2 引数を必須とし、欠落時は `activate_missing_target`。
 */
export function parseSlashCommand(
  request: RawSlackSlashCommandRequest
): SlashCommandParseResult {
  if (typeof request.command !== "string" || request.command !== SLACK_SLASH_COMMAND) {
    return {
      ok: false,
      reason: "wrong_command",
      message: `Unsupported slash command: ${typeof request.command === "string" ? request.command : "<missing>"}`,
    };
  }
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (text.length === 0) {
    return {
      ok: false,
      reason: "empty_subcommand",
      message: `${SLACK_SLASH_COMMAND} に subcommand が指定されていません。${USAGE_HINT}`,
    };
  }
  const tokens = text.split(/\s+/u).filter((t) => t.length > 0);
  const head = tokens[0]!.toLowerCase();
  if (!isKnownSubcommand(head)) {
    return {
      ok: false,
      reason: "unknown_subcommand",
      message: `${SLACK_SLASH_COMMAND} ${head} は未対応です。${USAGE_HINT}`,
    };
  }
  const rest = tokens.slice(1);
  let target = "";
  if (head === "activate") {
    if (rest.length === 0 || !rest[0]) {
      return {
        ok: false,
        reason: "activate_missing_target",
        message: `${SLACK_SLASH_COMMAND} activate <ads_hierarchy_id> の形式で対象を指定してください。`,
      };
    }
    target = rest[0]!;
  }
  return {
    ok: true,
    subcommand: head,
    target,
    rest,
    rawText: text,
  };
}

const USAGE_HINT =
  `使い方: ${SLACK_SLASH_COMMAND} ` +
  "report | budget | improve | status | accounts | activate <ads_hierarchy_id>";

function isKnownSubcommand(s: string): s is SlashSubcommand {
  return (SLACK_SLASH_SUBCOMMANDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------
// 4) Ack message (3 秒以内に Slack へ即時応答)
// ---------------------------------------------------------------------

export interface SlashCommandAckMessage {
  /** Slack の `ephemeral` (= 自分にしか見えない) 応答。 */
  response_type: "ephemeral";
  /** mrkdwn 風の sanitize 済みテキスト。 */
  text: string;
}

/**
 * 即時 ack を組み立てる。Parse 失敗時は usage / エラー文を、成功時は
 * "受け付けました。バックグラウンドで処理しています。" を返す。
 *
 * Slack 側は 3 秒以内に HTTP 200 が必要であり、内部で I/O を行わない (即時 return)。
 */
export function buildAckMessage(
  parsed: SlashCommandParseResult
): SlashCommandAckMessage {
  if (!parsed.ok) {
    return { response_type: "ephemeral", text: parsed.message };
  }
  const { subcommand, target } = parsed;
  let detail = "";
  switch (subcommand) {
    case "report":
      detail = "daily_report をバックグラウンドで実行します。";
      break;
    case "budget":
      detail = "budget_guard をバックグラウンドで評価します。";
      break;
    case "improve":
      detail = "improvement_pr をバックグラウンドで起動します。";
      break;
    case "status":
      detail = "現在の AdDroid 状態を取得しています。";
      break;
    case "accounts":
      detail = "ad_accounts の一覧を取得しています。";
      break;
    case "activate":
      detail = `activate を ads_hierarchy=${target} に対して audited で起動します。`;
      break;
  }
  return {
    response_type: "ephemeral",
    text: `${SLACK_SLASH_COMMAND} ${subcommand}${target ? ` ${target}` : ""} を受け付けました。${detail} 結果は同じスレッドに返信します。`,
  };
}

// ---------------------------------------------------------------------
// 5) Pg-boss enqueue
// ---------------------------------------------------------------------

/** pg-boss `send` に渡すオプション。execute_apply 同様 singletonKey を受ける。 */
export interface SlackCommandSendOptions {
  singletonKey?: string;
}

export interface SlackCommandBoss {
  send(
    name: string,
    data: unknown,
    options?: SlackCommandSendOptions
  ): Promise<string | null>;
}

/**
 * pg-boss に保存される job payload。worker 側は本 shape を {@link runSlackCommandJob}
 * に渡す。`response_url` は 30 分有効な Slack 提供 URL であり、平文のまま保持されるが
 * 公開 URL 文字列以外の機微情報を含まない。
 */
export interface SlackCommandJobPayload {
  subcommand: SlashSubcommand;
  target: string;
  rest: string[];
  rawText: string;
  slackUserId: string;
  slackUserName: string;
  slackChannelId: string;
  slackTeamId: string;
  responseUrl: string;
  enqueuedAt: string;
}

export interface EnqueueSlackCommandOptions {
  boss: SlackCommandBoss;
  parsed: ParsedSlashCommand;
  request: RawSlackSlashCommandRequest;
  /** singletonKey 上書き。未指定時は subcommand + user で自動生成される。 */
  singletonKey?: string;
  /** test seam: ISO timestamp 注入。 */
  now?: () => Date;
}

export interface EnqueueSlackCommandResult {
  jobId: string | null;
  payload: SlackCommandJobPayload;
  singletonKey: string;
}

/**
 * `/adops` の重複連打 (例: ユーザが Slack で 1 秒間に同じコマンドを 2 回叩いた)
 * を抑止するため、subcommand + slack_user_id で singletonKey を組む。activate は
 * target 単位で隔離する (同じ user が異なる target を続けて叩くケースのため)。
 */
export function buildSlackCommandSingletonKey(input: {
  subcommand: SlashSubcommand;
  slackUserId: string;
  target?: string;
}): string {
  const sub = sanitizeKeySegment(input.subcommand);
  const user = sanitizeKeySegment(input.slackUserId || "_");
  if (input.subcommand === "activate") {
    const tgt = sanitizeKeySegment(input.target ?? "_");
    return `slack_command:activate:${user}:${tgt}`;
  }
  return `slack_command:${sub}:${user}`;
}

function sanitizeKeySegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-");
  return cleaned.length > 0 ? cleaned.slice(0, 96) : "_";
}

export async function enqueueSlackCommandJob(
  opts: EnqueueSlackCommandOptions
): Promise<EnqueueSlackCommandResult> {
  const now = opts.now ?? (() => new Date());
  const payload: SlackCommandJobPayload = {
    subcommand: opts.parsed.subcommand,
    target: opts.parsed.target,
    rest: opts.parsed.rest,
    rawText: opts.parsed.rawText,
    slackUserId: opts.request.user_id ?? "",
    slackUserName: opts.request.user_name ?? "",
    slackChannelId: opts.request.channel_id ?? "",
    slackTeamId: opts.request.team_id ?? "",
    responseUrl: opts.request.response_url,
    enqueuedAt: now().toISOString(),
  };
  const singletonKey =
    opts.singletonKey ??
    buildSlackCommandSingletonKey({
      subcommand: payload.subcommand,
      slackUserId: payload.slackUserId,
      target: payload.target,
    });
  const jobId = await opts.boss.send(SLACK_COMMAND_JOB_NAME, payload, {
    singletonKey,
  });
  return { jobId, payload, singletonKey };
}

// ---------------------------------------------------------------------
// 6) Async dispatch / handlers (worker から呼ばれる)
// ---------------------------------------------------------------------

/**
 * 各 subcommand を実行するハンドラ群。worker (apps/worker) が Prisma /
 * runDailyReportOnce / runBudgetGuardOnce / runImprovementPrOnce / runActivate
 * を背景に持つ実装を注入する。テストでは in-memory fake を渡す。
 *
 * - 各ハンドラは throw せず `SlashHandlerOutcome` を返す契約。throw した場合は
 *   {@link runSlackCommandJob} が catch して `state="failed"` の終端結果を Slack に返す。
 */
export interface SlashCommandHandlers {
  report(input: SlashHandlerInput): Promise<SlashHandlerOutcome>;
  budget(input: SlashHandlerInput): Promise<SlashHandlerOutcome>;
  improve(input: SlashHandlerInput): Promise<SlashHandlerOutcome>;
  status(input: SlashHandlerInput): Promise<SlashHandlerOutcome>;
  accounts(input: SlashHandlerInput): Promise<SlashHandlerOutcome>;
  activate(input: SlashHandlerInput): Promise<SlashHandlerOutcome>;
}

export interface SlashHandlerInput {
  payload: SlackCommandJobPayload;
}

/** ハンドラが Slack に返したい構造化された 1 行サマリ。 */
export interface SlashHandlerOutcome {
  /** 成功 / 失敗の運用ラベル。Slack 通知の dot 色判定 + audit_logs に流す。 */
  state: "succeeded" | "failed";
  /** Slack に出す 1 行サマリ (既に sanitize 済みでなくてよい — dispatcher が再 sanitize)。 */
  text: string;
  /** Web UI への deep link を 1 つ付けたいときの URL (任意)。 */
  detailUrl?: string;
  /** 任意の機械可読メタ (audit / execution_logs に保存可)。 */
  metadata?: Record<string, unknown>;
  /** 失敗時に Slack に追加表示する短いコード (sanitize される)。 */
  errorCode?: string;
}

export type SlashCommandJobState = "succeeded" | "failed";

export interface SlashCommandJobResult {
  subcommand: SlashSubcommand;
  state: SlashCommandJobState;
  /** response_url POST が ok を返したかどうか。Slack 側の到達を観測するため。 */
  postedToResponseUrl: boolean;
  /** response_url POST 失敗時のエラーラベル (sanitize 済み)。 */
  postError?: string;
  /** ハンドラ自体が返した outcome (テスト/audit 用)。throw だった場合は null。 */
  handlerOutcome: SlashHandlerOutcome | null;
  /** ハンドラが throw した場合に詰める sanitized エラー文。 */
  handlerError?: string;
  /** ack→完了の所要 ms (ack latency 観測用)。 */
  durationMs: number;
}

// ---------------------------------------------------------------------
// 7) Response URL poster
// ---------------------------------------------------------------------

/** Slack response_url に流す `fetch` 互換シグネチャ (テストで注入)。 */
export type SlackResponseFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

export interface SlackResponseMessage {
  /** "ephemeral" のとき、コマンド実行ユーザにのみ表示される。 */
  response_type: "ephemeral" | "in_channel";
  /** sanitize 済み 1 行テキスト (Slack 通知センター fallback)。 */
  text: string;
  /** mrkdwn パラ + ボタン (任意)。 */
  blocks?: SlashResponseBlock[];
  /** 直前の ack を上書きする場合 true。本モジュールでは上書きしない (false 既定)。 */
  replace_original?: boolean;
}

export type SlashResponseBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | {
      type: "actions";
      elements: {
        type: "button";
        text: { type: "plain_text"; text: string };
        url: string;
      }[];
    };

/**
 * response_url に POST する。response_url は Slack が発行する一時 URL なので
 * `https://hooks.slack.com/...` の形式を期待するが、本モジュールは外形上 https
 * のみを許可し、それ以外 (空文字 / file: / http:) は `failed` で抜ける。
 *
 * **本関数は throw しない**。Slack 通知の失敗は GitOps / Apply / Cron に伝播
 * させない契約。失敗は `{ ok: false, ... }` で返す。
 */
export async function postSlackResponse(opts: {
  responseUrl: string;
  message: SlackResponseMessage;
  fetchImpl?: SlackResponseFetch;
}): Promise<{ ok: boolean; status: number; errorCode?: string; errorMessage?: string }> {
  const fetchImpl =
    opts.fetchImpl ??
    ((globalThis as { fetch?: SlackResponseFetch }).fetch as
      | SlackResponseFetch
      | undefined);
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      status: 0,
      errorCode: "fetch_unavailable",
      errorMessage: "fetch が利用できません (Node 22+ で実行してください)",
    };
  }
  const url = (opts.responseUrl ?? "").trim();
  if (!/^https:\/\//i.test(url)) {
    return {
      ok: false,
      status: 0,
      errorCode: "invalid_response_url",
      errorMessage: "response_url が不正です (https のみ許可されます)",
    };
  }
  const sanitized = sanitizeResponseMessage(opts.message);
  const body = JSON.stringify(sanitized);
  let res: Awaited<ReturnType<SlackResponseFetch>>;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorCode: "network_error",
      errorMessage: sanitizeText((err as Error).message ?? String(err)),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      errorCode: `http_${res.status}`,
      errorMessage: `Slack response_url が HTTP ${res.status} を返しました`,
    };
  }
  return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------
// 8) Sanitizer (response_url に出すテキスト)
// ---------------------------------------------------------------------

const RESPONSE_TEXT_MAX_BYTES = 2900;

/**
 * `@addroid/config` の sanitizeForSlack と同思想の自前 redactor。
 *
 * - `@addroid/queue` から `@addroid/config` へ依存を作らないために自前実装する。
 * - パターンは config 側と同じ (xoxb / xapp / xoxp / sk- / EAA / Bearer / 環境変数代入)。
 *   片方だけが追加された場合に相互の網羅性を確認する責任は呼び出し側にある。
 */
export function sanitizeText(value: string): string {
  if (typeof value !== "string") return "";
  let out = value;
  out = out.replace(/xoxb-[A-Za-z0-9-]{8,}/g, "xoxb-[REDACTED]");
  out = out.replace(/xapp-[A-Za-z0-9-]{8,}/g, "xapp-[REDACTED]");
  out = out.replace(/xoxp-[A-Za-z0-9-]{8,}/g, "xoxp-[REDACTED]");
  out = out.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-[REDACTED]");
  out = out.replace(/EAA[A-Za-z0-9]{20,}/g, "EAA[REDACTED]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  out = out.replace(
    /(META_[A-Z0-9_]*TOKEN|OPENAI_[A-Z0-9_]*KEY|CODEX_[A-Z0-9_]*TOKEN|ANTHROPIC_[A-Z0-9_]*KEY|GITHUB_[A-Z0-9_]*TOKEN|SLACK_[A-Z0-9_]*TOKEN|SLACK_[A-Z0-9_]*SECRET)\s*=\s*\S+/g,
    "$1=[REDACTED]"
  );
  out = out.replace(
    /"(access_token|refresh_token|id_token|api_key|client_secret|signing_secret)"\s*:\s*"[^"]+"/gi,
    '"$1":"[REDACTED]"'
  );
  if (out.length > RESPONSE_TEXT_MAX_BYTES) {
    out = out.slice(0, RESPONSE_TEXT_MAX_BYTES) + "…[truncated]";
  }
  return out;
}

function sanitizeResponseMessage(
  message: SlackResponseMessage
): SlackResponseMessage {
  const sanitizedBlocks: SlashResponseBlock[] | undefined = message.blocks
    ? message.blocks.map((b) => sanitizeBlock(b))
    : undefined;
  const out: SlackResponseMessage = {
    response_type: message.response_type,
    text: sanitizeText(message.text),
  };
  if (sanitizedBlocks) out.blocks = sanitizedBlocks;
  if (message.replace_original !== undefined)
    out.replace_original = message.replace_original;
  return out;
}

function sanitizeBlock(block: SlashResponseBlock): SlashResponseBlock {
  if (block.type === "section") {
    return {
      type: "section",
      text: { type: "mrkdwn", text: sanitizeText(block.text.text) },
    };
  }
  if (block.type === "context") {
    return {
      type: "context",
      elements: block.elements.map((e) => ({
        type: "mrkdwn",
        text: sanitizeText(e.text),
      })),
    };
  }
  // actions
  return {
    type: "actions",
    elements: block.elements
      .filter((e) => /^https?:\/\//i.test(e.url) && !/[<>|]/.test(e.url))
      .map((e) => ({
        type: "button",
        text: { type: "plain_text", text: sanitizeText(e.text.text) },
        url: sanitizeText(e.url),
      })),
  };
}

// ---------------------------------------------------------------------
// 9) Audit writer (implementation item)
//
// Slash command 実行の audit_logs 書き込みは worker 側 Prisma 実装が担う
// (queue 層から prisma を import しないため)。runSlackCommandJob は実行終了時に
// 1 度だけ audit writer を呼び、actor=`slack:<user_id>` で 1 行残す。
// ---------------------------------------------------------------------

/**
 * runSlackCommandJob が 1 回の slash command 実行終了時に audit writer に渡す
 * shape。`response_url` 利用結果と slack_user_id を必ず含める (implementation item の
 * "slack_user_id、response_url 利用結果を紐づける" 受入)。
 *
 * - `action` は `activate` のみ `activate.via_slack`、それ以外は `slash_command.completed`
 *   または `slash_command.failed`。UI design plan §0.20 の actor 帰属可視化に対応。
 * - `metadata` は sanitize 済みの軽量 JSON。Slack 平文 token は決して含めない
 *   (上流の sanitizer を経由した値だけが入る)。
 */
export interface SlackCommandAuditInput {
  action:
    | "slash_command.completed"
    | "slash_command.failed"
    | "activate.via_slack";
  /** `slack:<user_id>`。空の slackUserId は `slack:_` に丸める。 */
  actor: string;
  /** ref で 1 行サマリ表示できる "<subcommand>[ <target>]" 形式。 */
  ref: string;
  /** target は audit_logs.target 列にそのまま入る `slack_command:<subcommand>` 文字列。 */
  target: string;
  subcommand: SlashSubcommand;
  /** activate の対象 ads_hierarchy id 等。それ以外は空文字。 */
  subcommandTarget: string;
  slackUserId: string;
  slackUserName: string;
  slackChannelId: string;
  slackTeamId: string;
  state: SlashCommandJobState;
  /** response_url POST が成功したか。 */
  postedToResponseUrl: boolean;
  /** sanitized response_url 失敗理由 (POST が失敗した場合のみ)。 */
  postError?: string;
  /** sanitized handler 例外メッセージ (handler が throw した場合のみ)。 */
  handlerError?: string;
  /** handler が返した state (`succeeded` / `failed`)。throw のときは null。 */
  handlerState: "succeeded" | "failed" | null;
  /** handler が返した errorCode。失敗時のみ。 */
  errorCode?: string;
  /** ack→完了の所要 ms。 */
  durationMs: number;
  /** ISO timestamp。runSlackCommandJob の終了時刻。 */
  finishedAt: string;
}

/**
 * Slack slash command の実行を audit_logs に 1 行残す境界。
 *
 * - 実装は throw しない契約 (Slack 失敗が GitOps polling / Apply / Cron に
 *   伝播しないため)。throw した場合でも runSlackCommandJob は飲み込んで
 *   SlashCommandJobResult を返す (= worker は再キューしない)。
 * - 実装は worker 側 Prisma で `prisma.auditLog.create` を 1 回呼ぶだけ。
 */
export interface SlackCommandAuditWriter {
  recordSlashCommandExecution(input: SlackCommandAuditInput): Promise<void>;
}

// ---------------------------------------------------------------------
// 10) Orchestrator
// ---------------------------------------------------------------------

export interface RunSlackCommandJobOptions {
  payload: SlackCommandJobPayload;
  handlers: SlashCommandHandlers;
  /** test seam: response_url POST 用 fetch。 */
  fetchImpl?: SlackResponseFetch;
  /** test seam: 決定的時刻。 */
  now?: () => Date;
  /**
   * 実行終了時に 1 度だけ呼ばれる audit_logs 書き込み境界 (implementation item)。
   * 未指定時は audit を書かない (= 単体テスト or Slack ハンドラ未配線環境)。
   */
  audit?: SlackCommandAuditWriter;
}

/**
 * pg-boss handler の本体。subcommand に応じてハンドラを 1 つ呼び、結果を
 * response_url に POST する。throw しないため、worker 側で繰り返し再キューイング
 * される心配がない (= Slack 失敗が cron / Apply に伝播しない)。
 *
 * 失敗時 (ハンドラが throw / response_url 失敗 / unknown subcommand) でも
 * `SlashCommandJobResult` を返し、worker 側で execution_logs / audit_logs に
 * 沿った形で保存できるようにする。
 */
export async function runSlackCommandJob(
  opts: RunSlackCommandJobOptions
): Promise<SlashCommandJobResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().getTime();
  const { payload, handlers } = opts;

  let outcome: SlashHandlerOutcome | null = null;
  let handlerError: string | undefined;

  try {
    outcome = await dispatchHandler(payload, handlers);
  } catch (err) {
    handlerError = sanitizeText((err as Error).message ?? String(err));
  }

  const responseMessage = buildFinalResponseMessage({
    payload,
    outcome,
    handlerError,
  });
  const post = await postSlackResponse({
    responseUrl: payload.responseUrl,
    message: responseMessage,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const finishedAtDate = now();
  const finishedAt = finishedAtDate.getTime();
  const durationMs = Math.max(0, finishedAt - startedAt);
  const state: SlashCommandJobState =
    !handlerError && outcome?.state === "succeeded" ? "succeeded" : "failed";

  const result: SlashCommandJobResult = {
    subcommand: payload.subcommand,
    state,
    postedToResponseUrl: post.ok,
    handlerOutcome: outcome,
    durationMs,
  };
  if (post.errorMessage) result.postError = post.errorMessage;
  if (handlerError) result.handlerError = handlerError;

  if (opts.audit) {
    // implementation item: 1 回の slash command 実行につき audit_logs を 1 行書く。
    // Slack failure を GitOps / Apply / Cron に伝播させないため、
    // audit writer の例外は飲み込み、SlashCommandJobResult は元のまま返す。
    const auditInput = buildSlackCommandAuditInput({
      payload,
      result,
      finishedAtIso: finishedAtDate.toISOString(),
      outcome,
    });
    try {
      await opts.audit.recordSlashCommandExecution(auditInput);
    } catch {
      /* swallow — audit failure must not poison job result */
    }
  }

  return result;
}

function buildSlackCommandAuditInput(args: {
  payload: SlackCommandJobPayload;
  result: SlashCommandJobResult;
  finishedAtIso: string;
  outcome: SlashHandlerOutcome | null;
}): SlackCommandAuditInput {
  const { payload, result, finishedAtIso, outcome } = args;
  const slackUserId = (payload.slackUserId ?? "").trim();
  const actor = slackUserId.length > 0 ? `slack:${slackUserId}` : "slack:_";
  // activate のみ別 action にして cron/audit 上で per-operation で抽出可能にする
  // (UI design plan §1: `activate.via_slack`)。
  const action: SlackCommandAuditInput["action"] =
    payload.subcommand === "activate" && result.state === "succeeded"
      ? "activate.via_slack"
      : result.state === "succeeded"
        ? "slash_command.completed"
        : "slash_command.failed";
  const ref =
    payload.target.length > 0
      ? `${payload.subcommand} ${payload.target}`
      : payload.subcommand;
  const target = `slack_command:${payload.subcommand}`;
  const out: SlackCommandAuditInput = {
    action,
    actor,
    ref,
    target,
    subcommand: payload.subcommand,
    subcommandTarget: payload.target,
    slackUserId,
    slackUserName: payload.slackUserName ?? "",
    slackChannelId: payload.slackChannelId ?? "",
    slackTeamId: payload.slackTeamId ?? "",
    state: result.state,
    postedToResponseUrl: result.postedToResponseUrl,
    handlerState: outcome ? outcome.state : null,
    durationMs: result.durationMs,
    finishedAt: finishedAtIso,
  };
  if (result.postError) out.postError = result.postError;
  if (result.handlerError) out.handlerError = result.handlerError;
  if (outcome?.errorCode) out.errorCode = outcome.errorCode;
  return out;
}

async function dispatchHandler(
  payload: SlackCommandJobPayload,
  handlers: SlashCommandHandlers
): Promise<SlashHandlerOutcome> {
  const input: SlashHandlerInput = { payload };
  switch (payload.subcommand) {
    case "report":
      return handlers.report(input);
    case "budget":
      return handlers.budget(input);
    case "improve":
      return handlers.improve(input);
    case "status":
      return handlers.status(input);
    case "accounts":
      return handlers.accounts(input);
    case "activate":
      return handlers.activate(input);
    default: {
      const _exhaustive: never = payload.subcommand;
      void _exhaustive;
      throw new Error(
        `[slack-command] 未対応の subcommand: ${(payload as { subcommand?: string }).subcommand ?? "<unknown>"}`
      );
    }
  }
}

function buildFinalResponseMessage(input: {
  payload: SlackCommandJobPayload;
  outcome: SlashHandlerOutcome | null;
  handlerError?: string;
}): SlackResponseMessage {
  const { payload, outcome, handlerError } = input;
  const headLine = `${SLACK_SLASH_COMMAND} ${payload.subcommand}${payload.target ? ` ${payload.target}` : ""}`;

  if (handlerError || !outcome) {
    const detail = handlerError ?? "ハンドラが結果を返しませんでした";
    return {
      response_type: "ephemeral",
      text: `${headLine}: 失敗しました — ${detail}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${headLine}*: 失敗しました\n\`\`\`${detail}\`\`\``,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "GitOps polling / Apply / Cron は通常通り稼働しています。詳細は `/logs` を確認してください。",
            },
          ],
        },
      ],
    };
  }

  const success = outcome.state === "succeeded";
  const lead = success ? "完了しました" : "失敗しました";
  const blocks: SlashResponseBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${headLine}*: ${lead}\n${outcome.text}`,
      },
    },
  ];
  if (!success && outcome.errorCode) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `error_code: ${outcome.errorCode}` },
      ],
    });
  }
  if (outcome.detailUrl && /^https?:\/\//i.test(outcome.detailUrl)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Web UI で確認" },
          url: outcome.detailUrl,
        },
      ],
    });
  }
  return {
    response_type: "ephemeral",
    text: `${headLine}: ${lead} — ${outcome.text}`,
    blocks,
  };
}
