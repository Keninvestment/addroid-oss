// `addroid auth <provider>` — provider 別の OAuth/トークン登録 CLI。
//
// Meta Access Token / OAuth と Slack token 登録を CLI から実行する。
//
// `addroid auth slack`:
//   入力: --xoxb / --xapp / --channel フラグ、または環境変数
//         (SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_NOTIFICATION_CHANNEL_ID)。
//   流れ:
//     1. トークン形式 (xoxb-* / xapp-* / Cxxxx) を検証 (DB / Slack 接続を起動する前に行う)。
//     2. Slack `auth.test` で xoxb トークンの真正性を確認し team_id を取得。
//     3. Slack `apps.connections.open` で xapp トークン (Socket Mode) の有効性を確認。
//        本 CLI は WebSocket 接続を保持しない (worker プロセスが持続接続する責務)。
//     4. Slack `chat.postMessage` で通知チャンネルに「AdDroid 接続テスト」メッセージを送信。
//     5. `oauth_tokens` 行 (provider='slack', accountIdentifier=<team_id>) を upsert。
//        - accessTokenCiphertext  ← xoxb (encrypted)
//        - refreshTokenCiphertext ← xapp (encrypted) — UI 設計の規約に従い同一 envelope を再利用
//        - metadata.* には team / channel / 直近テスト時刻のみ (機微値は **入れない**)
//
// 不変条件:
//   - Slack 連携は完全に任意。`addroid auth slack` を実行しない限り Slack 通信は走らない。
//   - 平文トークンはサブプロセスや shell 経由で扱わない (command injection 不要)。
//   - --json 指定時は機械可読 JSON を出すが、出力にも平文トークンを **絶対に** 含めない。
//   - DATABASE_URL / ENCRYPTION_KEY 未設定 / 形式エラーは Slack 通信前に exit 2 で返す。
//   - Slack 通信失敗は exit 1 (CLI 自身の異常ではないため code 2 ではない)。

import { spawnSync } from "node:child_process";
import http from "node:http";
import * as readlineControl from "node:readline";
import readline from "node:readline/promises";
import {
  buildSlackInstallationMetadata,
  CryptoNotConfiguredError,
  defaultAddroidConfig,
  getCryptoBoundary,
  readAddroidConfig,
  readLocalSecrets,
  resolveWebBinding,
  postSlackMessage,
  redactSecretTail,
  SlackApiError,
  SlackTokenValidationError,
  validateSlackInputs,
  verifyBotToken,
  verifySocketModeConnection,
  type SlackAuthInputs,
  type SlackAuthTestResponse,
  type SlackFetch,
  type SocketModeChannelOpener,
} from "@addroid/config";
import {
  buildAppAccessToken,
  debugToken,
  fetchAdAccounts,
  fetchMeProfile,
  MetaAdapterNotImplementedError,
  MetaOAuthStateMismatchError,
  MetaOAuthExchangeError,
  type MetaAdAccount,
  type MetaOAuthConnection,
} from "@addroid/meta-adapter";
import {
  defaultApiKeyChatUrl,
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  selectLLMProvider,
  type ApiKeyLLMProviderName,
  type LLMConnectionMeta,
} from "@addroid/llm-provider";
import {
  ADDROID_REQUIRED_SCOPES,
  MockGithubAdapter,
  OctokitGithubAdapter,
  createDefaultGithubApiClient,
  pollDeviceToken,
  requestDeviceCode,
  type ExchangedToken,
} from "@addroid/github-adapter";
import {
  buildPrismaMetaAdapterSelection,
  createPrismaMetaTokenStore,
  loadMetaOAuthClientFromEnv,
} from "../../../worker/src/lib/meta-runtime.js";
import {
  createPrismaOAuthTokenStore,
} from "../../../worker/src/lib/github-adapter-wiring.js";
import {
  persistOpsRepoBootstrap,
} from "../../../worker/src/lib/prisma-stores.js";
import {
  createPrismaLLMProviderTokenStore,
  loadCodexLLMClientFromEnv,
} from "../../../worker/src/lib/llm-runtime.js";
import {
  ensureCliWorkspace,
  formatAccountLine,
  setDefaultAccount,
  syncMetaAdAccounts,
  type MetaAccountsPrisma,
  type RegisteredAccount,
} from "../lib/meta-accounts.js";

const DEFAULT_CODEX_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_CODEX_MODEL = "gpt-4.1";
const DEFAULT_CODEX_CLI_REDIRECT_URI = "http://localhost:1455/auth/callback";

const TEST_MESSAGE_TEXT =
  "AdDroid 接続テスト — Socket Mode が確立しました。本メッセージは `addroid auth slack` から送信されています。";

interface ParsedSlackArgs {
  kind: "slack";
  inputs: Partial<SlackAuthInputs>;
  asJson: boolean;
}

interface ParsedMetaArgs {
  kind: "meta";
  mode: "token" | "oauth";
  accessToken?: string;
  asJson: boolean;
  openBrowser: boolean;
  selectDefault: boolean;
  timeoutMs: number;
}

interface ParsedLlmArgs {
  kind: "llm";
  provider: ApiKeyLLMProviderName | "codex";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  disconnect: boolean;
  asJson: boolean;
  openBrowser: boolean;
  timeoutMs: number;
}

interface ParsedGithubArgs {
  kind: "github";
  asJson: boolean;
  openBrowser: boolean;
  timeoutMs: number;
  clientId?: string;
  bootstrap: boolean;
}

type ParsedAction =
  | ParsedSlackArgs
  | ParsedMetaArgs
  | ParsedLlmArgs
  | ParsedGithubArgs
  | { kind: "help" }
  | { kind: "error"; code: number; stderr?: string; stdoutHelp?: boolean };

export interface SlackAuthRunOptions {
  /**
   * Slack Web API 用の fetch 注入。テストでモックする。未指定なら Node 22+ 内蔵の
   * グローバル fetch を使う。
   */
  slackFetch?: SlackFetch;
  /**
   * Socket Mode WebSocket の開設に使うファクトリ (テスト用)。未指定なら
   * グローバル `WebSocket` を使う実 WebSocket。
   */
  socketModeOpener?: SocketModeChannelOpener;
  /**
   * Socket Mode WebSocket 開設後、Slack の `hello` イベント受信を待つ最大時間 (ms)。
   * 未指定なら `verifySocketModeConnection` の既定 (10s) を使う。
   */
  socketModeTimeoutMs?: number;
  /**
   * Prisma クライアントの注入 (テスト用)。未指定なら `@addroid/db` の singleton を使う。
   */
  prismaOverride?: unknown;
  /**
   * `now()` 注入 (テストで決定的にする用途)。
   */
  now?: () => Date;
  /** Meta Graph API 用 fetch 注入。テストでモックする。 */
  metaFetch?: typeof fetch;
  /** Codex OAuth token exchange 用 fetch 注入。テストでモックする。 */
  llmFetch?: typeof fetch;
  /** GitHub OAuth Device Flow 用 fetch 注入。テストでモックする。 */
  githubFetch?: typeof fetch;
  /** GitHub device flow の polling sleep 注入。 */
  githubSleep?: (ms: number) => Promise<void>;
}

export async function runAuthCommand(
  args: string[],
  opts: SlackAuthRunOptions = {}
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.kind === "error") {
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    if (parsed.stdoutHelp) printHelp();
    return parsed.code;
  }
  if (parsed.kind === "help") {
    printHelp();
    return 0;
  }
  if (parsed.kind === "meta") {
    return await runAuthMeta(parsed, opts);
  }
  if (parsed.kind === "llm") {
    return await runAuthLlm(parsed, opts);
  }
  if (parsed.kind === "github") {
    return await runAuthGithub(parsed, opts);
  }
  return await runAuthSlack(parsed, opts);
}

function parseArgs(args: string[]): ParsedAction {
  const [provider, ...rest] = args;
  if (
    provider === undefined ||
    provider === "--help" ||
    provider === "-h" ||
    provider === "help"
  ) {
    return { kind: "help" };
  }
  if (provider === "meta") {
    let mode: "token" | "oauth" = "token";
    let accessToken: string | undefined;
    let asJson = false;
    let openBrowser = true;
    let selectDefault = true;
    let timeoutMs = 180_000;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a === "--help" || a === "-h") {
        return { kind: "help" };
      }
      if (a === "--json") {
        asJson = true;
      } else if (a === "--oauth") {
        mode = "oauth";
      } else if (a === "--token" || a === "--manual") {
        mode = "token";
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
          accessToken = next;
          i += 1;
        }
      } else if (a.startsWith("--token=")) {
        mode = "token";
        accessToken = a.slice("--token=".length);
      } else if (a === "--access-token") {
        mode = "token";
        const next = rest[i + 1];
        if (!next) return optionMissing("auth meta", a);
        accessToken = next;
        i += 1;
      } else if (a.startsWith("--access-token=")) {
        mode = "token";
        accessToken = a.slice("--access-token=".length);
      } else if (a === "--no-open") {
        openBrowser = false;
      } else if (a === "--no-select-default") {
        selectDefault = false;
      } else if (a === "--timeout-ms") {
        const next = rest[i + 1];
        if (!next) return optionMissing("auth meta", a);
        timeoutMs = Number(next);
        i += 1;
      } else if (a.startsWith("--timeout-ms=")) {
        timeoutMs = Number(a.slice("--timeout-ms=".length));
      } else if (a.startsWith("--")) {
        return {
          kind: "error",
          code: 2,
          stderr: `[addroid auth meta] 未知のオプション: ${a}\n`,
          stdoutHelp: true,
        };
      } else {
        return {
          kind: "error",
          code: 2,
          stderr: `[addroid auth meta] 余分な引数: ${a}\n`,
          stdoutHelp: true,
        };
      }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
      return {
        kind: "error",
        code: 2,
        stderr: "[addroid auth meta] --timeout-ms は 10000 以上のミリ秒で指定してください\n",
        stdoutHelp: true,
      };
    }
    return {
      kind: "meta",
      mode,
      ...(accessToken !== undefined ? { accessToken } : {}),
      asJson,
      openBrowser,
      selectDefault,
      timeoutMs,
    };
  }

  if (provider === "llm") {
    const env = process.env;
    let llmProvider: ApiKeyLLMProviderName | "codex" | null = null;
    let apiKey: string | undefined;
    let model: string | undefined;
    let baseUrl: string | undefined;
    let disconnect = false;
    let asJson = false;
    let openBrowser = true;
    let timeoutMs = 180_000;

    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      const take = () => {
        const v = rest[i + 1];
        if (!v) throw new Error(`${a} requires a value`);
        i += 1;
        return v;
      };
      try {
        if (a === "--help" || a === "-h") return { kind: "help" };
        if (a === "--json") asJson = true;
        else if (a === "--disconnect") disconnect = true;
        else if (a === "--provider") llmProvider = requireLLMAuthProvider(take());
        else if (a.startsWith("--provider=")) llmProvider = requireLLMAuthProvider(a.slice("--provider=".length));
        else if (a === "--api-key") apiKey = take();
        else if (a.startsWith("--api-key=")) apiKey = a.slice("--api-key=".length);
        else if (a === "--model") model = take();
        else if (a.startsWith("--model=")) model = a.slice("--model=".length);
        else if (a === "--base-url") baseUrl = take();
        else if (a.startsWith("--base-url=")) baseUrl = a.slice("--base-url=".length);
        else if (a === "--no-open") openBrowser = false;
        else if (a === "--timeout-ms") {
          timeoutMs = Number(take());
        } else if (a.startsWith("--timeout-ms=")) timeoutMs = Number(a.slice("--timeout-ms=".length));
        else if (a.startsWith("--")) {
          return {
            kind: "error",
            code: 2,
            stderr: `[addroid auth llm] 未知のオプション: ${a}\n`,
            stdoutHelp: true,
          };
        } else {
          return {
            kind: "error",
            code: 2,
            stderr: `[addroid auth llm] 余分な引数: ${a}\n`,
            stdoutHelp: true,
          };
        }
      } catch (err) {
        return {
          kind: "error",
          code: 2,
          stderr: `[addroid auth llm] ${(err as Error).message}\n`,
          stdoutHelp: true,
        };
      }
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
      return {
        kind: "error",
        code: 2,
        stderr: "[addroid auth llm] --timeout-ms は 10000 以上のミリ秒で指定してください\n",
        stdoutHelp: true,
      };
    }

    llmProvider ??= parseLLMAuthProvider(env.ADDROID_LLM_PROVIDER) ?? "openai";
    if (!apiKey && llmProvider !== "codex") {
      apiKey =
        llmProvider === "anthropic"
          ? env.ANTHROPIC_API_KEY
          : env.OPENAI_API_KEY;
    }
    return {
      kind: "llm",
      provider: llmProvider,
      ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      disconnect,
      asJson,
      openBrowser,
      timeoutMs,
    };
  }

  if (provider === "github") {
    let asJson = false;
    let openBrowser = true;
    let timeoutMs = 180_000;
    let clientId: string | undefined;
    let bootstrap = true;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a === "--help" || a === "-h") return { kind: "help" };
      if (a === "--json") asJson = true;
      else if (a === "--no-open") openBrowser = false;
      else if (a === "--no-bootstrap") bootstrap = false;
      else if (a === "--bootstrap") bootstrap = true;
      else if (a === "--client-id") {
        const next = rest[i + 1];
        if (!next) return optionMissing("auth github", a);
        clientId = next;
        i += 1;
      } else if (a.startsWith("--client-id=")) {
        clientId = a.slice("--client-id=".length);
      } else if (a === "--timeout-ms") {
        const next = rest[i + 1];
        if (!next) return optionMissing("auth github", a);
        timeoutMs = Number(next);
        i += 1;
      } else if (a.startsWith("--timeout-ms=")) {
        timeoutMs = Number(a.slice("--timeout-ms=".length));
      } else if (a.startsWith("--")) {
        return {
          kind: "error",
          code: 2,
          stderr: `[addroid auth github] 未知のオプション: ${a}\n`,
          stdoutHelp: true,
        };
      } else {
        return {
          kind: "error",
          code: 2,
          stderr: `[addroid auth github] 余分な引数: ${a}\n`,
          stdoutHelp: true,
        };
      }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
      return {
        kind: "error",
        code: 2,
        stderr: "[addroid auth github] --timeout-ms は 10000 以上のミリ秒で指定してください\n",
        stdoutHelp: true,
      };
    }
    return {
      kind: "github",
      asJson,
      openBrowser,
      timeoutMs,
      bootstrap,
      ...(clientId ? { clientId } : {}),
    };
  }

  if (provider !== "slack") {
    return {
      kind: "error",
      code: 2,
      stderr: `[addroid auth] 未対応のプロバイダ: ${provider}\n  対応プロバイダ: meta, github, slack, llm\n`,
      stdoutHelp: true,
    };
  }

  // env defaults — フラグ未指定時のフォールバック。
  const env = process.env;
  const inputs: Partial<SlackAuthInputs> = {};
  if (env.SLACK_BOT_TOKEN) inputs.botToken = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) inputs.appToken = env.SLACK_APP_TOKEN;
  if (env.SLACK_NOTIFICATION_CHANNEL_ID)
    inputs.notificationChannelId = env.SLACK_NOTIFICATION_CHANNEL_ID;

  let asJson = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") {
      return { kind: "help" };
    } else if (a === "--json") {
      asJson = true;
    } else if (a.startsWith("--xoxb=")) {
      inputs.botToken = a.slice("--xoxb=".length);
    } else if (a === "--xoxb") {
      const next = rest[i + 1];
      if (!next) return optionMissing(a);
      inputs.botToken = next;
      i += 1;
    } else if (a.startsWith("--xapp=")) {
      inputs.appToken = a.slice("--xapp=".length);
    } else if (a === "--xapp") {
      const next = rest[i + 1];
      if (!next) return optionMissing(a);
      inputs.appToken = next;
      i += 1;
    } else if (a.startsWith("--channel=")) {
      inputs.notificationChannelId = a.slice("--channel=".length);
    } else if (a === "--channel") {
      const next = rest[i + 1];
      if (!next) return optionMissing(a);
      inputs.notificationChannelId = next;
      i += 1;
    } else if (a.startsWith("--")) {
      return {
        kind: "error",
        code: 2,
        stderr: `[addroid auth slack] 未知のオプション: ${a}\n`,
        stdoutHelp: true,
      };
    } else {
      return {
        kind: "error",
        code: 2,
        stderr: `[addroid auth slack] 余分な引数: ${a}\n`,
        stdoutHelp: true,
      };
    }
  }
  return { kind: "slack", inputs, asJson };
}

function optionMissing(commandOrOpt: string, maybeOpt?: string): ParsedAction {
  const command = maybeOpt ? commandOrOpt : "auth slack";
  const opt = maybeOpt ?? commandOrOpt;
  return {
    kind: "error",
    code: 2,
    stderr: `[addroid ${command}] ${opt} に値がありません\n`,
    stdoutHelp: true,
  };
}

function parseApiKeyProvider(value: string | undefined): ApiKeyLLMProviderName | null {
  const v = value?.trim().toLowerCase();
  if (v === "openai" || v === "anthropic") return v;
  return null;
}

function parseLLMAuthProvider(value: string | undefined): ApiKeyLLMProviderName | "codex" | null {
  const v = value?.trim().toLowerCase();
  if (v === "codex" || v === "codex-oauth") return "codex";
  return parseApiKeyProvider(v);
}

function requireLLMAuthProvider(value: string | undefined): ApiKeyLLMProviderName | "codex" {
  const parsed = parseLLMAuthProvider(value);
  if (!parsed) throw new Error("--provider は openai / anthropic / codex を指定してください");
  return parsed;
}

function defaultModelForApiKeyProvider(provider: ApiKeyLLMProviderName): string {
  return provider === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4.1";
}

async function runAuthLlm(
  parsed: ParsedLlmArgs,
  opts: SlackAuthRunOptions
): Promise<number> {
  let crypto: ReturnType<typeof getCryptoBoundary>;
  try {
    crypto = getCryptoBoundary();
  } catch (err) {
    if (err instanceof CryptoNotConfiguredError) {
      process.stderr.write(
        `[addroid auth llm] ENCRYPTION_KEY が利用できません: ${err.message}\n`
      );
      return 2;
    }
    throw err;
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid auth llm] DATABASE_URL が設定されていません。先に `addroid init` と DB setup を完了してください。\n"
    );
    return 2;
  }

  const { prisma } = (opts.prismaOverride
    ? { prisma: opts.prismaOverride as { oAuthToken: { upsert: Function; deleteMany: Function }; $disconnect: () => Promise<void> } }
    : await import("@addroid/db")) as {
    prisma: {
      oAuthToken: {
        upsert: (args: unknown) => Promise<unknown>;
        deleteMany: (args: unknown) => Promise<{ count: number }>;
      };
      $disconnect: () => Promise<void>;
    };
  };

  try {
    if (parsed.disconnect) {
      const result = await prisma.oAuthToken.deleteMany({
        where: { provider: parsed.provider },
      });
      if (parsed.asJson) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, provider: parsed.provider, removed: result.count }, null, 2)}\n`
        );
      } else {
        process.stdout.write(
          `[addroid auth llm]\n\n  provider      : ${parsed.provider}\n  disconnected  : ${result.count} credential(s) removed\n`
        );
      }
      return 0;
    }

    if (parsed.provider === "codex") {
      return await runAuthLlmCodexOAuth({ ...parsed, provider: "codex" }, {
        prisma: prisma as never,
        crypto,
        fetchImpl: opts.llmFetch,
      });
    }

    const apiKey = parsed.apiKey ?? (await promptSecret(`${parsed.provider} API key`));
    if (!apiKey.trim()) {
      process.stderr.write("[addroid auth llm] API key が未入力です。\n");
      return 2;
    }
    if (!looksLikeApiKey(parsed.provider, apiKey)) {
      process.stderr.write(
        `[addroid auth llm] ${parsed.provider} API key の形式が想定と異なります。入力値を確認してください。\n`
      );
      return 2;
    }
    const model = parsed.model?.trim() || defaultModelForApiKeyProvider(parsed.provider);
    const baseUrl = parsed.baseUrl?.trim() || defaultApiKeyChatUrl(parsed.provider);
    if (!/^https:\/\//i.test(baseUrl)) {
      process.stderr.write("[addroid auth llm] --base-url は https URL で指定してください。\n");
      return 2;
    }
    const now = opts.now ?? (() => new Date());
    const connectedAt = now();
    const accountIdentifier = `${parsed.provider}-api-key`;
    await prisma.oAuthToken.upsert({
      where: {
        provider_accountIdentifier: {
          provider: parsed.provider,
          accountIdentifier,
        },
      },
      update: {
        scopes: [],
        accessTokenCiphertext: crypto.encrypt(apiKey),
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt,
        metadata: {
          authKind: "api_key",
          defaultModel: model,
          apiBaseUrl: baseUrl,
        },
      },
      create: {
        provider: parsed.provider,
        accountIdentifier,
        scopes: [],
        accessTokenCiphertext: crypto.encrypt(apiKey),
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt,
        metadata: {
          authKind: "api_key",
          defaultModel: model,
          apiBaseUrl: baseUrl,
        },
      },
    });
    if (parsed.asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            provider: parsed.provider,
            authKind: "api_key",
            accountIdentifier,
            defaultModel: model,
            apiBaseUrl: baseUrl,
            connectedAt: connectedAt.toISOString(),
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write(
        [
          "[addroid auth llm]",
          "",
          `  provider      : ${parsed.provider}`,
          "  auth          : api_key",
          `  model         : ${model}`,
          `  endpoint      : ${baseUrl}`,
          "  api key       : encrypted (oauth_tokens.accessTokenCiphertext)",
          "",
        ].join("\n")
      );
    }
    return 0;
  } finally {
    if (!opts.prismaOverride) {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
}

async function runAuthLlmCodexOAuth(
  parsed: ParsedLlmArgs & { provider: "codex" },
  opts: {
    prisma: Parameters<typeof createPrismaLLMProviderTokenStore>[0];
    crypto: ReturnType<typeof getCryptoBoundary>;
    fetchImpl?: typeof fetch;
  }
): Promise<number> {
  const redirectUri = resolveCodexCliRedirectUri();
  if (!redirectUri) return 2;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ADDROID_LLM_PROVIDER: "codex",
    ADDROID_CODEX_OAUTH_REDIRECT_URI: redirectUri.toString(),
  };
  const codexClient = loadCodexLLMClientFromEnv(env);
  const chatCompletionsUrl =
    env.ADDROID_CODEX_CHAT_COMPLETIONS_URL?.trim() || DEFAULT_CODEX_CHAT_COMPLETIONS_URL;
  const defaultModel =
    parsed.model?.trim() || env.ADDROID_CODEX_DEFAULT_MODEL?.trim() || DEFAULT_CODEX_MODEL;
  const tokenStore = createPrismaLLMProviderTokenStore(opts.prisma);
  const selection = selectLLMProvider({
    env,
    tokenStore,
    crypto: opts.crypto,
    codexClient,
    chatCompletionsUrl,
    defaultModel: defaultModel ?? undefined,
    fetchImpl: opts.fetchImpl,
    stubProvider: "codex",
  });

  if (selection.choice === "stub") {
    process.stderr.write(
      "[addroid auth llm] Codex OAuth が未設定です。\n" +
        `  reason: ${selection.reason}\n` +
        "  Codex OAuth の内蔵設定を使えませんでした。ADDROID_CODEX_* の上書き値を確認してください。\n"
    );
    return 2;
  }
  if (selection.choice !== "codex") {
    process.stderr.write(
      `[addroid auth llm] Codex OAuth ではなく ${selection.choice} が選択されました。ADDROID_LLM_PROVIDER=codex で再実行してください。\n`
    );
    return 2;
  }

  let authorizationUrl: string;
  try {
    authorizationUrl = (await selection.provider.beginOAuth()).authorizationUrl;
  } catch (err) {
    if (err instanceof LLMNotImplementedError) {
      process.stderr.write(`[addroid auth llm] ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (!parsed.asJson) {
    process.stdout.write("[addroid auth llm]\n\n");
    process.stdout.write("  provider      : codex\n");
    process.stdout.write("  auth          : oauth\n");
    process.stdout.write(`  OAuth URL     : ${authorizationUrl}\n`);
    process.stdout.write(`  Callback      : ${redirectUri.toString()}\n`);
    process.stdout.write("  ブラウザで Codex OAuth 認証を完了してください。\n");
    process.stdout.write("  自動検出できない場合は、認証後の callback URL を端末に貼り付けて Enter してください。\n\n");
  }

  let callback: Awaited<ReturnType<typeof waitForLLMOAuthCallback>> | null = null;
  let connection: LLMConnectionMeta;
  try {
    callback = await waitForLLMOAuthCallback({
      redirectUri,
      timeoutMs: parsed.timeoutMs,
      complete: async (code, state) => selection.provider.completeOAuth({ code, state }),
      manualPrompt: !parsed.asJson && Boolean(process.stdin.isTTY),
    });
    if (parsed.openBrowser) openUrl(authorizationUrl);
    connection = await callback.connection;
  } catch (err) {
    if (err instanceof LLMOAuthStateMismatchError) {
      process.stderr.write("[addroid auth llm] OAuth state mismatch (possible CSRF).\n");
      return 1;
    }
    process.stderr.write(`[addroid auth llm] ${(err as Error).message}\n`);
    return 1;
  } finally {
    callback?.server.close();
  }

  if (parsed.asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          provider: "codex",
          authKind: "oauth",
          accountIdentifier: connection.accountIdentifier,
          scopes: connection.scopes,
          connectedAt: connection.connectedAt,
          expiresAt: connection.expiresAt,
          defaultModel: connection.defaultModel,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(`  connected     : ${connection.accountIdentifier}\n`);
    process.stdout.write(`  model         : ${connection.defaultModel}\n`);
    process.stdout.write(`  scopes        : ${connection.scopes.join(", ") || "none"}\n`);
    process.stdout.write(`  expires       : ${connection.expiresAt ?? "unknown"}\n`);
    process.stdout.write("  token         : encrypted (oauth_tokens.accessTokenCiphertext)\n");
  }
  return 0;
}

async function runAuthGithub(
  parsed: ParsedGithubArgs,
  opts: SlackAuthRunOptions = {}
): Promise<number> {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid auth github] DATABASE_URL が設定されていません。先に `addroid init` を実行してください。\n"
    );
    return 2;
  }

  let crypto: ReturnType<typeof getCryptoBoundary>;
  try {
    crypto = getCryptoBoundary(process.env);
  } catch (err) {
    const message =
      err instanceof CryptoNotConfiguredError
        ? err.message
        : `ENCRYPTION_KEY の初期化に失敗しました: ${(err as Error).message}`;
    process.stderr.write(`[addroid auth github] ${message}\n`);
    return 2;
  }

  const { prisma } = (opts.prismaOverride
    ? { prisma: opts.prismaOverride as { $disconnect: () => Promise<void> } }
    : await import("@addroid/db")) as {
    prisma: { $disconnect: () => Promise<void> };
  };

  try {
    const tokenStore = createPrismaOAuthTokenStore(prisma as never);
    const fetchImpl = opts.githubFetch ?? fetch;
    let connection: {
      accountIdentifier: string;
      scopes: string[];
      connectedAt: Date;
      expiresAt: Date | null;
    };
    let adapter: MockGithubAdapter | OctokitGithubAdapter;

    if (process.env.ADDROID_GITHUB_OAUTH_MOCK === "1") {
      const mock = new MockGithubAdapter({ tokenStore });
      const begin = await mock.beginOAuth();
      const connected = await mock.completeOAuth({
        code: `mock-${begin.state}`,
        state: begin.state,
      });
      connection = {
        accountIdentifier: connected.accountIdentifier,
        scopes: connected.scopes,
        connectedAt: new Date(connected.connectedAt),
        expiresAt: null,
      };
      adapter = mock;
    } else {
      const clientId = await resolveGithubClientId(parsed.clientId);
      if (!clientId) {
        process.stderr.write(
          "[addroid auth github] GitHub OAuth client id が未設定です。\n" +
            "  `~/.addroid/secrets.local.yaml` の github.oauth.clientId、または ADDROID_GITHUB_CLIENT_ID を設定してください。\n" +
            "  Web UI OAuth Code Flow も維持する場合は github.oauth.clientSecret も設定してください。\n"
        );
        return 2;
      }

      const device = await requestDeviceCode({
        clientId,
        scopes: ADDROID_REQUIRED_SCOPES,
        fetchImpl,
      });
      if (!parsed.asJson) {
        process.stdout.write("[addroid auth github]\n\n");
        process.stdout.write("  auth          : device flow\n");
        process.stdout.write(`  URL           : ${device.verificationUri}\n`);
        process.stdout.write(`  code          : ${device.userCode}\n`);
        process.stdout.write("  ブラウザで GitHub 認証を完了してください。\n\n");
      }
      if (parsed.openBrowser) openUrl(device.verificationUri);

      const exchanged = await waitForGithubDeviceToken({
        clientId,
        deviceCode: device.deviceCode,
        intervalSeconds: device.intervalSeconds,
        timeoutMs: Math.min(parsed.timeoutMs, device.expiresInSeconds * 1000),
        fetchImpl,
        sleep: opts.githubSleep,
      });
      const api = await createDefaultGithubApiClient(exchanged.accessToken);
      const login = await api.getAuthenticatedUserLogin();
      const connectedAt = opts.now?.() ?? new Date();
      const expiresAt = exchanged.expiresInSeconds
        ? new Date(connectedAt.getTime() + exchanged.expiresInSeconds * 1000)
        : null;
      const scopes = exchanged.grantedScopes.length
        ? exchanged.grantedScopes
        : [...ADDROID_REQUIRED_SCOPES];
      await tokenStore.saveOAuthToken({
        provider: "github",
        accountIdentifier: login,
        scopes,
        accessTokenCiphertext: crypto.encrypt(exchanged.accessToken),
        ...(exchanged.refreshToken
          ? { refreshTokenCiphertext: crypto.encrypt(exchanged.refreshToken) }
          : {}),
        ...(expiresAt ? { expiresAt } : {}),
        connectedAt,
      });
      connection = { accountIdentifier: login, scopes, connectedAt, expiresAt };
      adapter = new OctokitGithubAdapter({
        oauthClient: {
          clientId,
          clientSecret: "unused-by-device-flow",
          redirectUri: "http://127.0.0.1/unused",
        },
        tokenStore,
        crypto,
        apiClientFactory: (accessToken) => lazyGithubApiClient(accessToken),
      });
    }

    const bootstrap = parsed.bootstrap
      ? await bootstrapOpsRepoFromCli(prisma as never, adapter)
      : { status: "skipped" as const, reason: "--no-bootstrap" };

    if (parsed.asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            provider: "github",
            accountIdentifier: connection.accountIdentifier,
            scopes: connection.scopes,
            connectedAt: connection.connectedAt.toISOString(),
            expiresAt: connection.expiresAt?.toISOString() ?? null,
            bootstrap,
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write("[addroid auth github]\n\n");
      process.stdout.write(`  connected     : ${connection.accountIdentifier}\n`);
      process.stdout.write(`  scopes        : ${connection.scopes.join(", ") || "none"}\n`);
      process.stdout.write("  token         : encrypted (oauth_tokens.accessTokenCiphertext)\n");
      if (bootstrap.status === "created") {
        process.stdout.write(`  ops repo      : ${bootstrap.owner}/${bootstrap.name}\n`);
        process.stdout.write(`  default branch: ${bootstrap.defaultBranch}\n`);
      } else {
        process.stdout.write(`  ops repo      : ${bootstrap.status} (${bootstrap.reason})\n`);
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`[addroid auth github] ${(err as Error).message}\n`);
    return 1;
  } finally {
    if (!opts.prismaOverride) {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
}

async function resolveGithubClientId(explicit?: string): Promise<string | null> {
  const fromArgs = explicit?.trim();
  if (fromArgs) return fromArgs;
  const fromEnv =
    process.env.ADDROID_GITHUB_CLIENT_ID?.trim() ||
    process.env.ADDROID_GITHUB_OAUTH_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  const secrets = await readLocalSecrets().catch(() => null);
  return secrets?.github?.oauth?.clientId?.trim() || null;
}

async function waitForGithubDeviceToken(opts: {
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ExchangedToken> {
  const started = Date.now();
  let intervalMs = Math.max(1, opts.intervalSeconds) * 1000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (Date.now() - started < opts.timeoutMs) {
    await sleep(intervalMs);
    const result = await pollDeviceToken({
      clientId: opts.clientId,
      deviceCode: opts.deviceCode,
      fetchImpl: opts.fetchImpl,
    });
    if ("accessToken" in result) return result;
    if (result.slowDownSeconds) intervalMs += result.slowDownSeconds * 1000;
  }
  throw new Error("Timed out waiting for GitHub device authorization.");
}

function lazyGithubApiClient(accessToken: string) {
  let cached: Awaited<ReturnType<typeof createDefaultGithubApiClient>> | null = null;
  const resolve = async () => {
    cached ??= await createDefaultGithubApiClient(accessToken);
    return cached;
  };
  return {
    async getAuthenticatedUserLogin() {
      return (await resolve()).getAuthenticatedUserLogin();
    },
    async createUserRepo(
      input: Parameters<Awaited<ReturnType<typeof createDefaultGithubApiClient>>["createUserRepo"]>[0]
    ) {
      return (await resolve()).createUserRepo(input);
    },
    async commitTemplateFiles(
      input: Parameters<Awaited<ReturnType<typeof createDefaultGithubApiClient>>["commitTemplateFiles"]>[0]
    ) {
      return (await resolve()).commitTemplateFiles(input);
    },
    async setBranchProtection(
      input: Parameters<Awaited<ReturnType<typeof createDefaultGithubApiClient>>["setBranchProtection"]>[0]
    ) {
      return (await resolve()).setBranchProtection(input);
    },
    async listPullRequests(
      input: Parameters<Awaited<ReturnType<typeof createDefaultGithubApiClient>>["listPullRequests"]>[0]
    ) {
      return (await resolve()).listPullRequests(input);
    },
    async createPullRequest(
      input: Parameters<Awaited<ReturnType<typeof createDefaultGithubApiClient>>["createPullRequest"]>[0]
    ) {
      return (await resolve()).createPullRequest(input);
    },
    async mergePullRequest(
      input: Parameters<Awaited<ReturnType<typeof createDefaultGithubApiClient>>["mergePullRequest"]>[0]
    ) {
      return (await resolve()).mergePullRequest(input);
    },
  };
}

async function bootstrapOpsRepoFromCli(
  prisma: {
    workspace: {
      findUnique(args: unknown): Promise<{
        opsRepoId?: string | null;
        opsRepo?: { owner: string; name: string } | null;
      } | null>;
    };
    adAccount: {
      findFirst(args: unknown): Promise<{ key: string; displayName: string } | null>;
    };
  },
  adapter: MockGithubAdapter | OctokitGithubAdapter
): Promise<
  | {
      status: "created";
      owner: string;
      name: string;
      defaultBranch: string;
      filesCommitted: number;
      branchProtectionApplied: boolean;
    }
  | { status: "skipped"; reason: string }
> {
  const workspace = await ensureCliWorkspace(prisma as never);
  const existing = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: {
      opsRepoId: true,
      opsRepo: { select: { owner: true, name: true } },
    },
  });
  if (existing?.opsRepoId) {
    return {
      status: "skipped",
      reason: existing.opsRepo
        ? `${existing.opsRepo.owner}/${existing.opsRepo.name} already linked`
        : "ops repo already linked",
    };
  }
  const config = (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  const desiredName = config.github?.opsRepo?.name ?? `addroid-ops-${config.workspace.slug}`;
  const defaultBranch = config.github?.opsRepo?.defaultBranch ?? "main";
  const account = await prisma.adAccount.findFirst({
    where: { active: true },
    orderBy: [{ createdAt: "asc" }],
    select: { key: true, displayName: true },
  });
  const result = await adapter.bootstrapOpsRepo({
    workspaceSlug: config.workspace.slug,
    workspaceDisplayName: config.workspace.displayName,
    initialAccountKey: account?.key ?? "default",
    initialAccountDisplayName: account?.displayName ?? "Default Account",
    desiredName,
    defaultBranch,
    visibility: "private",
  });
  await persistOpsRepoBootstrap(prisma as never, {
    workspaceId: workspace.id,
    owner: result.owner,
    name: result.name,
    defaultBranch: result.defaultBranch,
    bootstrappedAt: new Date(result.bootstrappedAt),
    filesCommitted: result.filesCommitted,
    branchProtectionApplied: result.branchProtectionApplied,
  });
  return {
    status: "created",
    owner: result.owner,
    name: result.name,
    defaultBranch: result.defaultBranch,
    filesCommitted: result.filesCommitted,
    branchProtectionApplied: result.branchProtectionApplied,
  };
}

function looksLikeApiKey(provider: ApiKeyLLMProviderName, apiKey: string): boolean {
  const v = apiKey.trim();
  if (provider === "openai") return /^sk-[A-Za-z0-9_\-]{8,}/.test(v);
  return /^sk-ant-[A-Za-z0-9_\-]{8,}/.test(v);
}

function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(`? ${question}: `).then((answer) => {
      rl.close();
      return answer.trim();
    });
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const renderMask = () => {
      const visibleStars = Math.min(value.length, 24);
      const suffix = value.length > visibleStars ? ` (${value.length} chars)` : "";
      readlineControl.clearLine(process.stdout, 0);
      readlineControl.cursorTo(process.stdout, 0);
      process.stdout.write(`? ${question}: ${"*".repeat(visibleStars)}${suffix}`);
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      let changed = false;
      for (const ch of s) {
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("interrupted"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          changed = true;
          continue;
        }
        if (ch >= " ") {
          value += ch;
          changed = true;
        }
      }
      if (changed) renderMask();
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    renderMask();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function runAuthMeta(
  parsed: ParsedMetaArgs,
  opts: SlackAuthRunOptions = {}
): Promise<number> {
  if (parsed.mode === "token") {
    return runAuthMetaToken(parsed, opts);
  }
  return runAuthMetaOAuth(parsed);
}

async function runAuthMetaToken(
  parsed: ParsedMetaArgs,
  opts: SlackAuthRunOptions = {}
): Promise<number> {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid auth meta] DATABASE_URL が設定されていません。先に `addroid init` を実行してください。\n"
    );
    return 2;
  }

  let crypto: ReturnType<typeof getCryptoBoundary>;
  try {
    crypto = getCryptoBoundary(process.env);
  } catch (err) {
    const message =
      err instanceof CryptoNotConfiguredError
        ? err.message
        : `ENCRYPTION_KEY の初期化に失敗しました: ${(err as Error).message}`;
    process.stderr.write(`[addroid auth meta] ${message}\n`);
    return 2;
  }

  const { prisma } = (await import("@addroid/db")) as {
    prisma: MetaAccountsPrisma & { $disconnect: () => Promise<void> };
  };
  try {
    const accessToken = (parsed.accessToken ?? (await promptSecret("Meta Access Token"))).trim();
    if (!looksLikeMetaAccessToken(accessToken)) {
      process.stderr.write(
        "[addroid auth meta] Meta Access Token が空、または形式が不自然です。\n"
      );
      return 2;
    }

    const fetchImpl = opts.metaFetch ?? fetch;
    const workspace = await ensureCliWorkspace(prisma);
    const [me, adAccounts] = await Promise.all([
      fetchMeProfile({ accessToken, fetchImpl }).catch(() => null),
      fetchAdAccounts({ accessToken, fetchImpl, limit: 100 }),
    ]);
    if (adAccounts.length === 0) {
      process.stderr.write(
        "[addroid auth meta] この token で取得できる Ad Account がありません。ads_read / ads_management / business_management 権限と Business 側の割り当てを確認してください。\n"
      );
      return 1;
    }

    const debug = await tryDebugManualMetaToken(accessToken, fetchImpl);
    const scopes = debug?.scopes ?? [];
    const expiresAt =
      typeof debug?.expiresAt === "number" && debug.expiresAt > 0
        ? new Date(debug.expiresAt * 1000)
        : null;
    const missingScopes = requiredMetaScopesMissing(scopes);
    const connectedAt = opts.now?.() ?? new Date();
    const accountIdentifier = debug?.userId || me?.id || me?.name || "meta-token";
    const tokenStore = createPrismaMetaTokenStore(prisma as never);
    await tokenStore.saveOAuthToken({
      provider: "meta",
      accountIdentifier,
      scopes,
      accessTokenCiphertext: crypto.encrypt(accessToken),
      expiresAt,
      connectedAt,
    });

    const synced = await syncMetaAdAccounts(
      prisma,
      workspace.id,
      adAccounts as readonly MetaAdAccount[]
    );
    const defaultAccount =
      parsed.selectDefault && synced.accounts.length > 0
        ? await chooseAndSetMetaDefault(prisma, workspace.id, synced.accounts)
        : null;

    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:meta-token",
        action: "oauth.meta.connected",
        target: `oauth_tokens:meta:${accountIdentifier}`,
        ref: accountIdentifier,
        metadata: {
          authMethod: "manual_access_token",
          scopes,
          connectedAt: connectedAt.toISOString(),
          expiresAt: expiresAt?.toISOString() ?? null,
          adAccountsFetched: adAccounts.length,
          adAccountsRegistered: synced.registered,
          adAccountsUpdated: synced.updated,
          missingRecommendedScopes: missingScopes,
        },
      },
    });

    if (parsed.asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            provider: "meta",
            authMethod: "manual_access_token",
            accountIdentifier,
            adAccounts: adAccounts.length,
            registered: synced.registered,
            updated: synced.updated,
            defaultAccount,
            scopes,
            missingRecommendedScopes: missingScopes,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write("[addroid auth meta]\n\n");
      process.stdout.write("  auth method   : manual access token\n");
      process.stdout.write(`  connected     : ${accountIdentifier}\n`);
      process.stdout.write(`  ad accounts   : ${adAccounts.length}\n`);
      process.stdout.write(`  registered    : ${synced.registered}\n`);
      process.stdout.write(`  updated       : ${synced.updated}\n`);
      process.stdout.write(
        `  default       : ${defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "unset"}\n`
      );
      process.stdout.write(`  expires       : ${expiresAt?.toISOString() ?? "unknown / never"}\n`);
      if (scopes.length > 0) process.stdout.write(`  scopes        : ${scopes.join(", ")}\n`);
      if (missingScopes.length > 0) {
        process.stdout.write(
          `  warning       : 推奨権限が不足している可能性があります (${missingScopes.join(", ")})\n`
        );
      }
      process.stdout.write("  token         : encrypted (oauth_tokens.accessTokenCiphertext)\n");
    }
    return 0;
  } catch (err) {
    process.stderr.write(`[addroid auth meta] ${(err as Error).message}\n`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function runAuthMetaOAuth(parsed: ParsedMetaArgs): Promise<number> {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid auth meta] DATABASE_URL が設定されていません。先に `addroid init` を実行してください。\n"
    );
    return 2;
  }

  const redirectUri = resolveCliRedirectUri();
  if (!redirectUri) return 2;

  const { prisma } = (await import("@addroid/db")) as {
    prisma: MetaAccountsPrisma & { $disconnect: () => Promise<void> };
  };
  let callbackServer: http.Server | null = null;
  try {
    const workspace = await ensureCliWorkspace(prisma);
    const adapterSelection = await buildPrismaMetaAdapterSelection({
      prisma: prisma as never,
      env: {
        ...process.env,
        ADDROID_META_OAUTH_REDIRECT_URI: redirectUri.toString(),
      },
    });
    if (adapterSelection.choice === "stub") {
      process.stderr.write(
        `[addroid auth meta] Meta OAuth が未設定です: ${adapterSelection.reason}\n` +
          "  通常は `addroid auth meta` で Access Token を入力してください。OAuth callback 経路を使う場合のみ Meta OAuth client を環境変数または secrets.local.yaml に設定してください。\n"
      );
      return 2;
    }

    const { authorizationUrl } = await adapterSelection.adapter.beginOAuth();
    const callback = await waitForMetaCallback({
      redirectUri,
      timeoutMs: parsed.timeoutMs,
      complete: async (code, state) => adapterSelection.adapter.completeOAuth({ code, state }),
    });
    callbackServer = callback.server;

    if (!parsed.asJson) {
      process.stdout.write("[addroid auth meta]\n\n");
      process.stdout.write(`  OAuth URL     : ${authorizationUrl}\n`);
      process.stdout.write(`  Callback      : ${redirectUri.toString()}\n`);
      process.stdout.write("  ブラウザで Meta 認証を完了してください。\n\n");
    }
    if (parsed.openBrowser) openUrl(authorizationUrl);

    const connection = await callback.connection;
    const synced = await syncMetaAdAccounts(
      prisma,
      workspace.id,
      connection.adAccounts as readonly MetaAdAccount[]
    );
    const defaultAccount =
      parsed.selectDefault && synced.accounts.length > 0
        ? await chooseAndSetMetaDefault(prisma, workspace.id, synced.accounts)
        : null;

    if (parsed.asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            provider: "meta",
            accountIdentifier: connection.accountIdentifier,
            businesses: connection.businesses.length,
            adAccounts: connection.adAccounts.length,
            registered: synced.registered,
            updated: synced.updated,
            defaultAccount,
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write(`  connected     : ${connection.accountIdentifier}\n`);
      process.stdout.write(`  businesses    : ${connection.businesses.length}\n`);
      process.stdout.write(`  ad accounts   : ${connection.adAccounts.length}\n`);
      process.stdout.write(`  registered    : ${synced.registered}\n`);
      process.stdout.write(`  updated       : ${synced.updated}\n`);
      process.stdout.write(
        `  default       : ${defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "unset"}\n`
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof MetaAdapterNotImplementedError) {
      process.stderr.write(`[addroid auth meta] ${err.message}\n`);
      return 2;
    }
    if (err instanceof MetaOAuthStateMismatchError) {
      process.stderr.write("[addroid auth meta] OAuth state mismatch (possible CSRF).\n");
      return 1;
    }
    process.stderr.write(`[addroid auth meta] ${(err as Error).message}\n`);
    return 1;
  } finally {
    callbackServer?.close();
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function tryDebugManualMetaToken(
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<{ userId: string; scopes: string[]; expiresAt: number } | null> {
  const client = await loadMetaOAuthClientFromEnv(process.env);
  if (!client) return null;
  try {
    const info = await debugToken({
      appAccessToken: buildAppAccessToken(client),
      inputToken: accessToken,
      fetchImpl,
    });
    if (!info.isValid) throw new MetaOAuthExchangeError("debugToken: token is not valid");
    return { userId: info.userId, scopes: info.scopes, expiresAt: info.expiresAt };
  } catch {
    return null;
  }
}

function looksLikeMetaAccessToken(value: string): boolean {
  return value.trim().length >= 20 && !/\s/.test(value.trim());
}

function requiredMetaScopesMissing(scopes: readonly string[]): string[] {
  if (scopes.length === 0) return [];
  const set = new Set(scopes);
  return ["ads_read", "ads_management", "business_management"].filter(
    (scope) => !set.has(scope)
  );
}

function resolveCliRedirectUri(): URL | null {
  const explicit = process.env.ADDROID_META_OAUTH_REDIRECT_URI;
  const binding = resolveWebBinding(process.env);
  let uri: URL;
  try {
    uri = new URL(
      explicit ??
        `http://${binding.hostname}:${binding.port}/api/oauth/meta/callback`
    );
  } catch (err) {
    process.stderr.write(
      `[addroid auth meta] redirect URI が不正です: ${(err as Error).message}\n`
    );
    return null;
  }
  const hostname = uri.hostname.replace(/^\[(.*)\]$/, "$1");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(hostname)) {
    process.stderr.write(
      "[addroid auth meta] CLI OAuth callback は localhost の redirect URI のみ利用できます。\n" +
        "  ADDROID_META_OAUTH_REDIRECT_URI を http://127.0.0.1:<port>/api/oauth/meta/callback に設定してください。\n"
    );
    return null;
  }
  if (uri.pathname !== "/api/oauth/meta/callback") {
    process.stderr.write(
      "[addroid auth meta] redirect URI の path は /api/oauth/meta/callback にしてください。\n"
    );
    return null;
  }
  return uri;
}

function waitForMetaCallback(opts: {
  redirectUri: URL;
  timeoutMs: number;
  complete: (code: string, state: string) => Promise<MetaOAuthConnection>;
}): { server: http.Server; connection: Promise<MetaOAuthConnection> } {
  let settled = false;
  let timeout: NodeJS.Timeout;
  let resolveConnection: (v: MetaOAuthConnection) => void;
  let rejectConnection: (err: unknown) => void;
  const connection = new Promise<MetaOAuthConnection>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", opts.redirectUri.origin);
    if (req.method !== "GET" || reqUrl.pathname !== opts.redirectUri.pathname) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const code = reqUrl.searchParams.get("code");
    const state = reqUrl.searchParams.get("state");
    const error = reqUrl.searchParams.get("error_description") ?? reqUrl.searchParams.get("error");
    if (!code || !state || error) {
      const message = error ?? "Missing code or state in callback URL.";
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(renderOAuthHtml("Meta OAuth failed", message));
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectConnection(new Error(message));
      }
      return;
    }
    try {
      const result = await opts.complete(code, state);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderOAuthHtml("Meta OAuth connected", "You can return to the terminal."));
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolveConnection(result);
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(renderOAuthHtml("Meta OAuth failed", (err as Error).message));
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectConnection(err);
      }
    }
  });

  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectConnection(new Error("Timed out waiting for Meta OAuth callback."));
    server.close();
  }, opts.timeoutMs);
  timeout.unref?.();

  const port = Number(opts.redirectUri.port || (opts.redirectUri.protocol === "https:" ? 443 : 80));
  const host = opts.redirectUri.hostname.replace(/^\[(.*)\]$/, "$1");
  server.listen(port, host);
  server.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    rejectConnection(
      new Error(
        `OAuth callback server failed on ${opts.redirectUri.origin}: ${(err as Error).message}`
      )
    );
  });
  return { server, connection };
}

function resolveCodexCliRedirectUri(): URL | null {
  const explicit = process.env.ADDROID_CODEX_OAUTH_REDIRECT_URI;
  let uri: URL;
  try {
    uri = new URL(explicit ?? DEFAULT_CODEX_CLI_REDIRECT_URI);
  } catch (err) {
    process.stderr.write(
      `[addroid auth llm] Codex redirect URI が不正です: ${(err as Error).message}\n`
    );
    return null;
  }
  const hostname = uri.hostname.replace(/^\[(.*)\]$/, "$1");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(hostname)) {
    process.stderr.write(
      "[addroid auth llm] CLI Codex OAuth callback は localhost の redirect URI のみ利用できます。\n" +
        "  ADDROID_CODEX_OAUTH_REDIRECT_URI を http://localhost:<port>/auth/callback に設定してください。\n"
    );
    return null;
  }
  if (uri.pathname !== "/auth/callback" && uri.pathname !== "/api/oauth/codex/callback") {
    process.stderr.write(
      "[addroid auth llm] Codex redirect URI の path は /auth/callback にしてください。\n"
    );
    return null;
  }
  return uri;
}

function waitForLLMOAuthCallback(opts: {
  redirectUri: URL;
  timeoutMs: number;
  complete: (code: string, state: string) => Promise<LLMConnectionMeta>;
  manualPrompt: boolean;
}): { server: http.Server; connection: Promise<LLMConnectionMeta> } {
  let settled = false;
  let manualPromptStarted = false;
  let timeout: NodeJS.Timeout;
  let resolveConnection: (v: LLMConnectionMeta) => void;
  let rejectConnection: (err: unknown) => void;
  const connection = new Promise<LLMConnectionMeta>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });

  const finishWithUrl = async (rawUrl: string) => {
    const parsed = parseOAuthCallbackUrl(rawUrl, opts.redirectUri);
    if ("error" in parsed) throw new Error(parsed.error);
    return opts.complete(parsed.code, parsed.state);
  };
  const resolveOnce = (result: LLMConnectionMeta) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveConnection(result);
  };
  const rejectOnce = (err: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    rejectConnection(err);
  };
  const askForCallbackUrl = (reason: string) => {
    if (!opts.manualPrompt || manualPromptStarted || settled) return false;
    manualPromptStarted = true;
    process.stdout.write(`\n  ${reason}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    void rl
      .question("? Codex OAuth callback URL を貼り付けて Enter: ")
      .then(async (answer) => {
        rl.close();
        if (settled) return;
        if (!answer.trim()) {
          rejectOnce(
            new Error(
              "Callback URL が未入力です。もう一度 `addroid auth llm --provider codex` を実行してください。"
            )
          );
          return;
        }
        resolveOnce(await finishWithUrl(answer.trim()));
      })
      .catch((err) => {
        rl.close();
        rejectOnce(err);
      });
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", opts.redirectUri.origin);
    if (req.method !== "GET" || reqUrl.pathname !== opts.redirectUri.pathname) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const code = reqUrl.searchParams.get("code");
    const state = reqUrl.searchParams.get("state");
    const error =
      reqUrl.searchParams.get("error_description") ?? reqUrl.searchParams.get("error");
    if (!code || !state || error) {
      const message = error ?? "Missing code or state in callback URL.";
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(renderOAuthHtml("Codex OAuth failed", message));
      rejectOnce(new Error(message));
      return;
    }
    try {
      const result = await opts.complete(code, state);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderOAuthHtml("Codex OAuth connected", "You can return to the terminal."));
      resolveOnce(result);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(renderOAuthHtml("Codex OAuth failed", (err as Error).message));
      rejectOnce(err);
    }
  });

  timeout = setTimeout(() => {
    if (settled) return;
    if (
      askForCallbackUrl(
        "localhost callback を時間内に検出できませんでした。ブラウザに表示された callback URL を貼り付けると続行できます。"
      )
    ) {
      return;
    }
    rejectOnce(new Error("Timed out waiting for Codex OAuth callback."));
    server.close();
  }, opts.timeoutMs);
  timeout.unref?.();

  const port = Number(
    opts.redirectUri.port || (opts.redirectUri.protocol === "https:" ? 443 : 80)
  );
  const host = opts.redirectUri.hostname.replace(/^\[(.*)\]$/, "$1");
  server.listen(port, host);
  server.on("error", (err) => {
    if (settled) return;
    if (
      askForCallbackUrl(
        `localhost callback server を開始できませんでした (${(err as Error).message})。手動貼り付けに切り替えます。`
      )
    ) {
      return;
    }
    rejectOnce(
      new Error(
        `OAuth callback server failed on ${opts.redirectUri.origin}: ${(err as Error).message}`
      )
    );
  });
  return { server, connection };
}

function parseOAuthCallbackUrl(
  rawUrl: string,
  redirectUri: URL
): { code: string; state: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return {
      error:
        "callback URL は code と state を含む完全な URL を貼り付けてください。",
    };
  }
  if (url.pathname !== redirectUri.pathname) {
    return {
      error: `callback URL の path が違います。${redirectUri.pathname} を含む URL を貼り付けてください。`,
    };
  }
  const providerError =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) return { error: providerError };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return {
      error:
        "callback URL に code または state がありません。ブラウザのアドレスバーに表示された URL 全体を貼り付けてください。",
    };
  }
  return { code, state };
}

function openUrl(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  spawnSync(cmd, args, { stdio: "ignore" });
}

async function chooseAndSetMetaDefault(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  accounts: RegisteredAccount[]
): Promise<RegisteredAccount | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1 || !process.stdin.isTTY || !process.stdout.isTTY) {
    return setDefaultAccount(prisma, workspaceId, accounts[0]!.id, "user:cli");
  }
  process.stdout.write("\n");
  accounts.forEach((a, i) => {
    process.stdout.write(`  ${String(i + 1).padStart(2)}. ${formatAccountLine(a)}\n`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("? Default Meta Ad Account [1]: ");
    const n = answer.trim() ? Number(answer.trim()) : 1;
    if (!Number.isInteger(n) || n < 1 || n > accounts.length) {
      throw new Error("Invalid selection.");
    }
    return setDefaultAccount(prisma, workspaceId, accounts[n - 1]!.id, "user:cli");
  } finally {
    rl.close();
  }
}

function renderOAuthHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function runAuthSlack(
  parsed: ParsedSlackArgs,
  opts: SlackAuthRunOptions
): Promise<number> {
  // 1) 形式バリデーション (DB / Slack 通信前)。
  let normalized: SlackAuthInputs;
  try {
    normalized = validateSlackInputs(parsed.inputs);
  } catch (err) {
    if (err instanceof SlackTokenValidationError) {
      process.stderr.write(`[addroid auth slack] ${err.message}\n`);
      process.stderr.write(
        "  --xoxb / --xapp / --channel か、SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_NOTIFICATION_CHANNEL_ID 環境変数で渡してください。\n"
      );
      return 2;
    }
    throw err;
  }

  // 2) ENCRYPTION_KEY 検証 (Slack 通信前に fail-fast)。
  let crypto: ReturnType<typeof getCryptoBoundary>;
  try {
    crypto = getCryptoBoundary();
  } catch (err) {
    if (err instanceof CryptoNotConfiguredError) {
      process.stderr.write(
        `[addroid auth slack] ENCRYPTION_KEY が利用できません: ${err.message}\n`
      );
      return 2;
    }
    throw err;
  }

  // 3) DATABASE_URL 検証 (Slack 通信前に fail-fast)。
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid auth slack] DATABASE_URL が設定されていません。`.env.local` を作成し再実行してください。\n"
    );
    return 2;
  }

  // 4) Slack auth.test → apps.connections.open → chat.postMessage の順で確認。
  const fetchImpl = opts.slackFetch;
  const now = opts.now ?? (() => new Date());

  const lines: string[] = [];
  lines.push("[addroid auth slack]");
  lines.push("");

  let authTest: SlackAuthTestResponse;
  try {
    authTest = await verifyBotToken(normalized.botToken, fetchImpl);
  } catch (err) {
    return reportSlackError("auth.test", err, parsed.asJson);
  }
  lines.push(`  team          : ${authTest.team} (${authTest.team_id})`);
  lines.push(`  bot user      : ${authTest.user} (${authTest.user_id})`);
  lines.push(`  xoxb token    : ${redactSecretTail(normalized.botToken)}`);

  // Socket Mode は HTTP の apps.connections.open だけでは「URL が取れただけ」で、
  // 実際にネットワーク経路 (TLS / WebSocket upgrade) が通り Slack 側が
  // hello イベントを送れる状態かは未確認になる。the current implementation acceptance の
  // 「Slack auth setup ... verifies Socket Mode connection」を満たすため、
  // ここで実 WebSocket を一度開いて hello を受け取ったうえで閉じる。失敗時は
  // fail-closed (oauth_tokens を書かずに exit 1)。
  try {
    await verifySocketModeConnection(normalized.appToken, {
      fetchImpl,
      openChannel: opts.socketModeOpener,
      timeoutMs: opts.socketModeTimeoutMs,
    });
  } catch (err) {
    return reportSlackError("apps.connections.open", err, parsed.asJson);
  }
  const socketOkAt = now();
  lines.push(`  socket mode   : ok (websocket handshake + hello)`);
  lines.push(`  xapp token    : ${redactSecretTail(normalized.appToken)}`);

  // chat.postMessage は永続化前に必須。失敗時はトークンを upsert せずに exit する
  // (fail-closed: contract D の「Slack auth setup ... verifies Socket Mode connection
  // with a test message」要件)。
  let testMessageOkAt: Date;
  try {
    await postSlackMessage(
      normalized.botToken,
      normalized.notificationChannelId,
      TEST_MESSAGE_TEXT,
      fetchImpl
    );
    testMessageOkAt = now();
    lines.push(
      `  test message  : sent to ${normalized.notificationChannelId}`
    );
  } catch (err) {
    return reportSlackError("chat.postMessage", err, parsed.asJson);
  }

  // 5) 永続化。
  const metadata = buildSlackInstallationMetadata({
    authTest,
    notificationChannelId: normalized.notificationChannelId,
    socketModeOkAt: socketOkAt,
    testMessageOkAt,
  });

  const accessTokenCiphertext = crypto.encrypt(normalized.botToken);
  const refreshTokenCiphertext = crypto.encrypt(normalized.appToken);

  // Prisma を遅延 import (DB 不要のヘルプ表示で読み込まないため、また activate.ts と同規約)。
  const { prisma } = (opts.prismaOverride
    ? { prisma: opts.prismaOverride as { oAuthToken: { upsert: Function }; $disconnect: () => Promise<void> } }
    : await import("@addroid/db")) as {
    prisma: {
      oAuthToken: {
        upsert: (args: unknown) => Promise<unknown>;
      };
      $disconnect: () => Promise<void>;
    };
  };

  try {
    await prisma.oAuthToken.upsert({
      where: {
        provider_accountIdentifier: {
          provider: "slack",
          accountIdentifier: authTest.team_id,
        },
      },
      update: {
        scopes: [],
        accessTokenCiphertext,
        refreshTokenCiphertext,
        connectedAt: socketOkAt,
        metadata,
      },
      create: {
        provider: "slack",
        accountIdentifier: authTest.team_id,
        scopes: [],
        accessTokenCiphertext,
        refreshTokenCiphertext,
        connectedAt: socketOkAt,
        metadata,
      },
    });
  } catch (err) {
    process.stderr.write(
      `[addroid auth slack] DB への保存に失敗しました: ${(err as Error).message}\n`
    );
    if (parsed.asJson) {
      process.stdout.write(
        `${JSON.stringify(
          { ok: false, stage: "persist", error: (err as Error).message },
          null,
          2
        )}\n`
      );
    }
    return 1;
  } finally {
    if (!opts.prismaOverride) {
      await (prisma as { $disconnect: () => Promise<void> })
        .$disconnect()
        .catch(() => undefined);
    }
  }

  lines.push(`  persisted     : oauth_tokens (provider=slack, team_id=${authTest.team_id})`);
  lines.push("");
  lines.push(
    "  Slack 連携が有効になりました。/adops コマンドや通知は worker 側 (Socket Mode) で配信されます。"
  );
  lines.push("");

  if (parsed.asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          provider: "slack",
          teamId: authTest.team_id,
          teamName: authTest.team,
          botUserId: authTest.user_id,
          botUser: authTest.user,
          notificationChannelId: normalized.notificationChannelId,
          socketModeOkAt: socketOkAt.toISOString(),
          testMessageOkAt: testMessageOkAt.toISOString(),
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(lines.join("\n"));
  }
  return 0;
}

function reportSlackError(
  endpoint: string,
  err: unknown,
  asJson: boolean
): number {
  if (err instanceof SlackApiError) {
    const slackErr = err.slackError ?? "(no error code)";
    process.stderr.write(
      `[addroid auth slack] Slack ${endpoint} に失敗しました: ${err.message}\n`
    );
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            stage: endpoint,
            slackError: err.slackError,
            httpStatus: err.status,
            message: err.message,
          },
          null,
          2
        )}\n`
      );
    }
    if (slackErr === "invalid_auth" || slackErr === "not_authed") {
      process.stderr.write(
        "  トークンが無効か期限切れです。Slack App 管理画面から再生成してください。\n"
      );
    } else if (slackErr === "channel_not_found") {
      process.stderr.write(
        "  通知チャンネルが見つかりません。Bot がチャンネルに参加しているかを確認してください。\n"
      );
    } else if (slackErr === "not_in_channel") {
      process.stderr.write(
        "  Bot が対象チャンネルに参加していません。Slack 上で /invite @<bot> を実行してください。\n"
      );
    }
    return 1;
  }
  process.stderr.write(
    `[addroid auth slack] Slack ${endpoint} で予期しないエラー: ${(err as Error).message}\n`
  );
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          stage: endpoint,
          message: (err as Error).message,
        },
        null,
        2
      )}\n`
    );
  }
  return 1;
}

function printHelp() {
  process.stdout.write(
    [
      "addroid auth — provider 別の OAuth/トークン登録",
      "",
      "Usage:",
      "  addroid auth meta [--token <access_token>] [--no-select-default] [--json]",
      "  addroid auth meta --oauth [--no-open] [--no-select-default] [--timeout-ms <ms>] [--json]",
      "  addroid auth github [--client-id <id>] [--no-open] [--no-bootstrap] [--timeout-ms <ms>] [--json]",
      "  addroid auth slack [--xoxb <token>] [--xapp <token>] [--channel <id>] [--json]",
      "  addroid auth llm --provider <openai|anthropic> [--api-key <key>] [--model <model>] [--base-url <url>] [--json]",
      "  addroid auth llm --provider codex [--no-open] [--timeout-ms <ms>] [--json]",
      "  addroid auth llm --provider <openai|anthropic|codex> --disconnect [--json]",
      "",
      "Options:",
      "  --token <token>    Meta Access Token。未指定時は非表示入力",
      "  --access-token <token> --token と同じ",
      "  --oauth            上級者向け: Meta OAuth callback 経路を使う",
      "  --client-id <id>   GitHub OAuth App client id (未指定時は secrets.local.yaml / env)",
      "  --no-open          OAuth URL をブラウザで自動オープンしない",
      "  --no-bootstrap     GitHub 認証後の ops repository 自動作成をスキップ",
      "  --no-select-default Meta Ad Account 既定選択をスキップ",
      "  --timeout-ms <ms>  OAuth callback / device flow 待機時間 (既定 180000)",
      "  --xoxb <token>     Slack Bot User OAuth Token (xoxb-*)",
      "  --xapp <token>     Slack App-Level Token (xapp-*, Socket Mode 用)",
      "  --channel <id>     通知先チャンネル ID (Cxxxx / Gxxxx / Dxxxx)",
      "  --provider <name>  LLM provider (openai / anthropic / codex)",
      "  --api-key <key>    LLM API key。未指定時は OPENAI_API_KEY / ANTHROPIC_API_KEY または非表示入力",
      "  --model <model>    LLM 既定 model",
      "  --base-url <url>   LLM endpoint override (https のみ)",
      "  --disconnect       指定 LLM provider の保存済み credential を削除",
      "  --json             機械可読 JSON で結果を出力",
      "  --help, -h         このヘルプ",
      "",
      "Environment fallbacks (フラグ未指定時に参照):",
      "  SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_NOTIFICATION_CHANNEL_ID",
      "  ADDROID_GITHUB_CLIENT_ID, ADDROID_GITHUB_OAUTH_CLIENT_ID",
      "  OPENAI_API_KEY, ANTHROPIC_API_KEY, ADDROID_LLM_PROVIDER",
      "",
      "Notes:",
      "  - Meta の標準経路は Access Token 入力です。HTTPS callback URL は不要です。",
      "  - token 入力後は取得できた Ad Account を ad_accounts に同期し、CLI で既定アカウントを選択できます。",
      "  - OAuth callback は `addroid auth meta --oauth` の上級者向け経路として残しています。",
      "  - GitHub は CLI では Device Flow、Web UI では既存の OAuth Code Flow を使います。どちらも provider=github として暗号化保存します。",
      "  - GitHub 認証後、未連携なら private ops repository を作成し workspace に紐付けます。",
      "  - Codex OAuth は `addroid auth llm --provider codex` でブラウザ認証を開始し、localhost callback または callback URL 貼り付けで完了します。",
      "  - Slack 連携は完全に任意です。本コマンドを実行しない限り AdDroid は Slack 通信を行いません。",
      "  - Socket Mode 専用。public な webhook URL や request URL は登録しません。",
      "  - 平文トークンは ENCRYPTION_KEY (AES-256-GCM) で暗号化し oauth_tokens に保存します。",
      "  - LLM API key も OAuth token と同じ暗号化境界で保存されます。.env への恒久保存は不要です。",
      "  - 既存の slack 行 (同 team_id) は上書きされます。切断は別コマンドで実装予定。",
      "",
    ].join("\n")
  );
}
