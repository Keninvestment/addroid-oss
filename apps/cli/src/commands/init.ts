// `addroid init` — first-run wizard + ~/.addroid scaffold.
//
// 非 TTY / --non-interactive では従来どおり副作用を ~/.addroid に閉じた冪等
// scaffold として動作する。TTY では Project name / .env / DB setup / doctor までを
// 対話的に案内し、CLI リテラシー程度の利用者が手で .env を編集せずに進められる。
//
// Scaffold 動作:
//   1. ~/.addroid とサブディレクトリ (storage / logs / run) を mkdir -p
//   2. config.yaml が無ければ default を書き込み、あれば値を保持してスキーマ整形のみ
//   3. secrets.local.yaml が無ければ stub を作成 (gitignored)
//   4. database.urlRef を再評価 (DATABASE_URL の有無で更新)
//
// 再実行しても破壊的更新は行わない。slug / displayName / opsRepo 等の既存設定は保持する。

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readlineControl from "node:readline";
import readline from "node:readline/promises";
import {
  AddroidConfigSchema,
  ConfigParseError,
  defaultAddroidConfig,
  ensureAddroidPaths,
  readAddroidConfig,
  writeAddroidConfig,
  type AddroidConfig,
} from "@addroid/config";
import {
  checkMetaAdsCli,
  checkPlatform,
  checkPostgresVersion,
  checkPython312,
  checkUv,
  type CheckResult,
} from "../lib/checks.js";
import { resolveRepoRoot } from "../lib/paths.js";

const SECRETS_STUB =
  "# AdDroid OSS — local-only secrets. THIS FILE IS GITIGNORED.\n" +
  "# 例:\n" +
  "# github:\n" +
  "#   oauth:\n" +
  "#     clientId: \"...\"\n" +
  "#     clientSecret: \"...\"\n" +
  "# OAuth / API tokens are encrypted in oauth_tokens with ENCRYPTION_KEY.\n" +
  "# This file is local-only and chmod 0600; do not commit it.\n";

const DEFAULT_DATABASE_USER = "addroid";
const DEFAULT_DATABASE_NAME = "addroid";
const DEFAULT_DATABASE_HOST = "localhost";
const DEFAULT_DATABASE_PORT = "5432";
const META_ADS_CLI_PYTHON_VERSION = "3.13";
const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";
const DEFAULT_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CODEX_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_CODEX_MODEL = "gpt-4.1";
const DEFAULT_CODEX_SCOPES = "openid,profile,email,offline_access";
const UV_SH = [
  'uv_bin="$(command -v uv || true)"',
  'if [ -z "$uv_bin" ]; then uv_bin="$HOME/.local/bin/uv"; fi',
  'if [ ! -x "$uv_bin" ]; then echo "uv が見つかりません。先に uv のインストールを完了してください。" >&2; exit 127; fi',
].join("; ");

type PromptFn = (question: string, defaultValue?: string) => Promise<string>;
type ConfirmFn = (question: string, defaultYes?: boolean) => Promise<boolean>;
interface SelectOption {
  value: string;
  label: string;
  description: string;
}
type SelectFn = (
  question: string,
  options: readonly SelectOption[],
  defaultValue: string
) => Promise<string>;

export interface InitCommandOverrides {
  prompt?: PromptFn;
  confirm?: ConfirmFn;
  selectOption?: SelectFn;
  runAuthCommand?: (args: string[]) => Promise<number>;
  runCommand?: CommandRunner;
  readAuthState?: (env: NodeJS.ProcessEnv) => Promise<InitAuthState>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isTTY?: boolean;
  randomBytes?: (size: number) => Buffer;
}

interface InitOptions {
  interactive?: boolean;
  yes: boolean;
  installDeps: boolean;
  skipDeps: boolean;
  skipDbCreate: boolean;
  skipDbPush: boolean;
  dbPush: boolean;
  mockIntegrations: boolean;
  skipLinkCli: boolean;
  force: boolean;
  reauthMeta: boolean;
  reauthGithub: boolean;
  reauthLlm: boolean;
  noChat: boolean;
  projectName?: string;
  databaseUrl?: string;
  envFile?: string;
  help: boolean;
}

interface InitAuthState {
  checked: boolean;
  metaConnected: boolean;
  githubConnected?: boolean;
  opsRepoLinked?: boolean;
  llmProviders: string[];
  detail?: string;
}

type InitAuthPrismaClient = {
  oAuthToken: {
    findMany: (args: unknown) => Promise<Array<{ provider: string }>>;
  };
  workspace: {
    findFirst: (args: unknown) => Promise<{ opsRepoId: string | null } | null>;
  };
  $disconnect: () => Promise<void>;
};

interface ScaffoldOptions {
  projectName?: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    streamOutput?: boolean;
  }
) => CommandResult;

export async function runInit(
  args: string[],
  overrides: InitCommandOverrides = {}
): Promise<number> {
  let opts: InitOptions;
  try {
    opts = parseInitArgs(args);
  } catch (err) {
    process.stderr.write(`[addroid init] ${(err as Error).message}\n\n`);
    printInitHelp();
    return 2;
  }
  if (opts.help) {
    printInitHelp();
    return 0;
  }

  const env = overrides.env ?? process.env;
  const isTTY =
    overrides.isTTY ??
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && env.CI !== "true");
  const interactive = opts.interactive ?? isTTY;

  if (!interactive && hasReauthIntent(opts)) {
    process.stderr.write(
      "[addroid init] --reauth-* は対話入力またはブラウザ認証を伴います。`--interactive` で再実行してください。\n"
    );
    return 2;
  }

  if (interactive) {
    if (await shouldShortCircuitAlreadyInitialized(opts, overrides, env)) {
      const result = await safeScaffoldAddroid({ projectName: opts.projectName });
      if (!result) return 1;
      const auth = await readInitAuthState(env, overrides);
      printAlreadyInitializedResult(result, auth);
      return 0;
    }
    return runInteractiveInit(opts, overrides);
  }

  if (shouldRunNonInteractiveSetup(opts)) {
    return runNonInteractiveSetup(opts, overrides);
  }

  const result = await safeScaffoldAddroid({ projectName: opts.projectName });
  if (!result) return 1;
  printScaffoldResult(result);
  return 0;
}

function shouldRunNonInteractiveSetup(opts: InitOptions): boolean {
  return Boolean(
    opts.yes ||
      opts.installDeps ||
      opts.dbPush ||
      opts.projectName ||
      opts.databaseUrl ||
      opts.envFile ||
      opts.mockIntegrations ||
      opts.force
  );
}

function hasReauthIntent(opts: InitOptions): boolean {
  return opts.reauthMeta || opts.reauthGithub || opts.reauthLlm;
}

function hasSetupIntent(opts: InitOptions): boolean {
  return Boolean(
    opts.yes ||
      opts.installDeps ||
      opts.dbPush ||
      opts.projectName ||
      opts.databaseUrl ||
      opts.envFile ||
      opts.mockIntegrations ||
      opts.force ||
      hasReauthIntent(opts)
  );
}

async function shouldShortCircuitAlreadyInitialized(
  opts: InitOptions,
  overrides: InitCommandOverrides,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (opts.interactive === true || hasSetupIntent(opts)) return false;
  if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) return false;
  let existing: AddroidConfig | null = null;
  try {
    existing = await readAddroidConfig();
  } catch {
    return false;
  }
  if (!existing) return false;
  const auth = await readInitAuthState(env, overrides);
  return (
    auth.checked &&
    auth.metaConnected &&
    auth.githubConnected !== false &&
    auth.opsRepoLinked !== false &&
    auth.llmProviders.length > 0
  );
}

async function runNonInteractiveSetup(
  opts: InitOptions,
  overrides: InitCommandOverrides
): Promise<number> {
  const env = overrides.env ?? process.env;
  const runner = overrides.runCommand ?? defaultRunCommand;
  const lines: string[] = ["[addroid init]", "", "Running non-interactive setup."];

  if (!opts.skipDeps && opts.installDeps) {
    process.stdout.write(lines.join("\n") + "\n");
    lines.length = 0;
    const dep = await setupDependencies({ opts, env, runner });
    lines.push(...dep.lines);
    if (!dep.ok) {
      process.stdout.write(lines.join("\n") + "\n");
      return 1;
    }
  }
  if (!env.ADDROID_META_CLI_BIN) {
    const detected = detectMetaCliBin(runner, env);
    if (detected) env.ADDROID_META_CLI_BIN = detected;
  }

  const databaseUrl = resolveInitDatabaseUrl(opts, env, overrides);
  const key = env.ENCRYPTION_KEY ?? generateEncryptionKey(overrides);
  const envResult = await ensureEnvFile({
    env,
    envFile: opts.envFile,
    databaseUrl,
    encryptionKey: key,
    mockIntegrations: opts.mockIntegrations,
    forcePlaceholders: true,
  });
  lines.push(...formatEnvResult(envResult));

  const scaffold = await safeScaffoldAddroid({ projectName: opts.projectName });
  if (!scaffold) return 1;
  lines.push(...formatScaffoldResult(scaffold));

  if (!opts.skipDbCreate && opts.yes) {
    const db = maybeCreateLocalDatabase(databaseUrl, runner, env);
    lines.push(...formatCommandOutcome("local database", db));
  }
  if (opts.dbPush && !opts.skipDbPush) {
    const dbPush = runPrismaSetup(runner, env);
    lines.push(...formatCommandOutcome("Prisma schema", dbPush));
    if (!dbPush.ok) {
      process.stdout.write(lines.join("\n") + "\n");
      return 1;
    }
  }

  if (opts.mockIntegrations) {
    lines.push("");
    lines.push("Mock integrations are enabled in .env. Remove mock flags before real Meta / GitHub connections.");
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. addroid doctor");
  lines.push("  2. Meta Access Token を用意");
  lines.push("  3. addroid auth meta                    # token 入力 + Ad Account 選択");
  lines.push("  4. addroid auth llm --provider openai   # または anthropic / codex");
  lines.push("  5. addroid auth github                  # GitHub 認証 + ops repo 作成");
  lines.push("  6. addroid up");
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return 0;
}

async function runInteractiveInit(
  opts: InitOptions,
  overrides: InitCommandOverrides
): Promise<number> {
  const env = overrides.env ?? process.env;
  const runner = overrides.runCommand ?? defaultRunCommand;
  const prompt = overrides.prompt ?? defaultPrompt;
  const confirm = overrides.confirm ?? defaultConfirm;
  const selectOption =
    overrides.selectOption ??
    (overrides.prompt ? buildPromptSelect(prompt) : defaultSelectOption);
  const lines: string[] = [
    "[addroid init]",
    "",
    "AdDroid の初期セットアップを開始します。",
    "既存の config / secrets / .env は破壊せず、不足している値だけ作成します。",
    "",
  ];

  if (!opts.skipDeps) {
    const checks = [checkPlatform(), checkUv(), checkPython312(), checkMetaAdsCli(env), checkPostgresVersion()];
    lines.push("Dependency check:");
    for (const c of checks) lines.push(formatCheck(c));
    const failing = checks.filter(needsSetupAction);
    if (failing.length > 0) {
      lines.push("");
      lines.push("不足している依存があります。");
      for (const c of failing) {
        if (c.hint) lines.push(`  - ${c.name}: ${c.hint}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      lines.length = 0;
      const shouldInstall =
        opts.installDeps || opts.yes || (await confirm("不足依存を一つずつ確認してセットアップしますか?", true));
      if (shouldInstall) {
        const installResults = await installMissingDependencies(failing, runner, env, {
          assumeYes: opts.yes || opts.installDeps,
          confirm,
        });
        for (const r of installResults) {
          process.stdout.write(formatCommandOutcome(r.label, r.outcome).join("\n") + "\n");
          if (!r.outcome.ok) {
            process.stderr.write(
              `[addroid init] ${r.label} の自動セットアップに失敗しました。表示されたコマンドで手動解決してから再実行してください。\n`
            );
            return 1;
          }
        }
      }
    } else {
      lines.push("");
    }
  }

  let existing: AddroidConfig | null = null;
  try {
    existing = await readAddroidConfig();
  } catch (err) {
    if (err instanceof ConfigParseError) {
      process.stderr.write(formatConfigParseError(err));
      return 1;
    }
    throw err;
  }

  if (lines.length > 0) {
    process.stdout.write(lines.join("\n") + "\n");
    lines.length = 0;
  }

  const cliLinkLines = await maybeEnsureCliCommand({
    env,
    runner,
    confirm,
    skip: opts.skipLinkCli,
  });
  if (cliLinkLines.length > 0) {
    process.stdout.write(cliLinkLines.join("\n") + "\n");
  }

  const projectName =
    opts.projectName ??
    (await prompt(
      "この AdDroid インスタンスの名前",
      existing?.workspace.displayName ?? "addroid"
    ));
  const databaseUrl =
    opts.databaseUrl ??
    (await prompt("DATABASE_URL", resolveInitDatabaseUrl(opts, env, overrides)));
  const encryptionKey = env.ENCRYPTION_KEY ?? generateEncryptionKey(overrides);
  if (!env.ADDROID_META_CLI_BIN) {
    const detected = detectMetaCliBin(runner, env);
    if (detected) env.ADDROID_META_CLI_BIN = detected;
  }

  const envResult = await ensureEnvFile({
    env,
    envFile: opts.envFile,
    databaseUrl,
    encryptionKey,
    mockIntegrations: opts.mockIntegrations,
    forcePlaceholders: true,
  });
  const scaffold = await safeScaffoldAddroid({ projectName });
  if (!scaffold) return 1;

  const out: string[] = [];
  out.push(...formatEnvResult(envResult));
  if (opts.mockIntegrations) {
    out.push("  mock mode     : enabled (remove ADDROID_*_MOCK before real Meta / GitHub connections)");
  }
  out.push(...formatScaffoldResult(scaffold));

  const shouldCreateDb =
    !opts.skipDbCreate &&
    isDefaultLocalDatabase(databaseUrl) &&
    (opts.yes || (await confirm("ローカル PostgreSQL に addroid DB / role を作成しますか?", true)));
  if (shouldCreateDb) {
    const db = maybeCreateLocalDatabase(databaseUrl, runner, env);
    out.push(...formatCommandOutcome("local database", db));
    if (!db.ok) {
      out.push("  hint: PostgreSQL を起動し、権限のあるユーザーで再実行してください。");
    }
  }

  const shouldPush =
    !opts.skipDbPush &&
    (opts.dbPush || opts.yes || (await confirm("Prisma schema を DB に反映しますか?", true)));
  if (shouldPush) {
    const dbPush = runPrismaSetup(runner, env);
    out.push(...formatCommandOutcome("Prisma schema", dbPush));
    if (!dbPush.ok) {
      process.stdout.write(out.join("\n") + "\n");
      return 1;
    }
  }

  let metaCredentialReady = opts.mockIntegrations;
  let llmCredentialReady = opts.mockIntegrations;
  let githubCredentialReady = opts.mockIntegrations;
  let opsRepoReady = opts.mockIntegrations;
  if (!opts.mockIntegrations) {
    const auth = await readInitAuthState(env, overrides);
    if (auth.checked && auth.metaConnected && !opts.force && !opts.reauthMeta) {
      metaCredentialReady = true;
      out.push("");
      out.push("Meta Access Token setup:");
      out.push("  Meta Token    : already configured");
      out.push("                  再認証する場合は `addroid init --reauth-meta` または `addroid auth meta` を実行してください。");
    } else {
      const configured = await maybeConfigureMetaAccessToken({
        out,
        assumeYes: opts.yes,
      });
      if (configured && !opts.yes) {
        process.stdout.write(out.join("\n") + "\n");
        out.length = 0;
        const runAuthCommand =
          overrides.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
        const code = await withRuntimeEnv(env, () => runAuthCommand(["meta"]));
        out.push(`  Meta Token    : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
        metaCredentialReady = code === 0;
        if (code !== 0) {
          out.push("                  Meta Access Token は実利用に必須です。token と DB 設定を確認し、`addroid auth meta` を再実行してください。");
          process.stdout.write(out.join("\n") + "\n");
          return 1;
        }
      }
    }

    let llmConfigured = true;
    if (auth.checked && auth.llmProviders.length > 0 && !opts.force && !opts.reauthLlm) {
      llmCredentialReady = true;
      out.push("");
      out.push("LLM Provider setup:");
      out.push(`  LLM Provider  : already configured (${auth.llmProviders.join(", ")})`);
      out.push("                  再認証する場合は `addroid init --reauth-llm` で provider を選び直してください。");
    } else {
      llmConfigured = await maybeConfigureLLMProvider({
        prompt,
        selectOption,
        out,
        assumeYes: opts.yes,
        runAuthCommand: overrides.runAuthCommand,
        env,
        envFile: opts.envFile,
      });
      llmCredentialReady = llmConfigured && !opts.yes;
    }
    if (!llmConfigured) {
      process.stdout.write(out.join("\n") + "\n");
      return 1;
    }

    const githubAlreadyReady =
      auth.checked && auth.githubConnected !== false && auth.opsRepoLinked !== false;
    if (githubAlreadyReady && !opts.force && !opts.reauthGithub) {
      githubCredentialReady = true;
      opsRepoReady = true;
      out.push("");
      out.push("GitHub setup:");
      out.push("  GitHub       : already configured");
      out.push("                 ops repository は既に workspace に紐付いています。");
    } else {
      out.push("");
      out.push("GitHub setup:");
      out.push("  実際の入稿には ops repository が必要です。");
      out.push("  このまま GitHub Device Flow 認証に進み、認証後に ops repository を自動作成します。");
      process.stdout.write(out.join("\n") + "\n");
      out.length = 0;
      const runAuthCommand =
        overrides.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
      const code = await withRuntimeEnv(env, () => runAuthCommand(["github"]));
      out.push(`  GitHub       : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
      githubCredentialReady = code === 0;
      opsRepoReady = code === 0;
      if (code !== 0) {
        out.push("                 実際の入稿には GitHub 認証と ops repository が必須です。`addroid auth github` を再実行してください。");
        process.stdout.write(out.join("\n") + "\n");
        return 1;
      }
    }
  }

  out.push("");
  out.push("Ready.");
  out.push(...formatReadySteps({ metaCredentialReady, llmCredentialReady, githubCredentialReady, opsRepoReady }));
  out.push("");
  process.stdout.write(out.join("\n"));
  if (shouldAutoStartChatAfterInit(opts, overrides, { llmCredentialReady })) {
    const { runChatCommand } = await import("./chat.js");
    return await runChatCommand([], { env });
  }
  return 0;
}

function shouldAutoStartChatAfterInit(
  opts: InitOptions,
  overrides: InitCommandOverrides,
  state: { llmCredentialReady: boolean }
): boolean {
  if (!state.llmCredentialReady) return false;
  if (opts.noChat || opts.yes || opts.mockIntegrations) return false;
  if (overrides.isTTY === false) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function formatReadySteps(opts: {
  metaCredentialReady: boolean;
  llmCredentialReady: boolean;
  githubCredentialReady: boolean;
  opsRepoReady: boolean;
}): string[] {
  const steps: string[] = ["addroid doctor"];
  if (!opts.metaCredentialReady) {
    steps.push("addroid auth meta                    # Meta Access Token 入力 + Ad Account 選択");
  }
  if (!opts.llmCredentialReady) {
    steps.push("addroid auth llm --provider codex     # または openai / anthropic");
  }
  if (!opts.githubCredentialReady || !opts.opsRepoReady) {
    steps.push("addroid auth github                  # GitHub 認証 + ops repo 作成");
  }
  steps.push("addroid up");
  return steps.map((step, i) => `  ${i + 1}. ${step}`);
}

async function maybeEnsureCliCommand(opts: {
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  confirm: ConfirmFn;
  skip: boolean;
}): Promise<string[]> {
  if (opts.skip) {
    return [
      "CLI command setup:",
      "  addroid       : skipped (--skip-link-cli)",
      "                  後で `npm run link:cli` を実行すると `addroid doctor` の形で使えます。",
      "",
    ];
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch {
    return [];
  }

  const lookupEnv = {
    ...opts.env,
    PATH: stripNodeModulesBinFromPath(opts.env.PATH ?? process.env.PATH ?? ""),
  };
  const existing = opts.runner("sh", ["-c", "command -v addroid"], {
    cwd: repoRoot,
    env: lookupEnv,
    timeoutMs: 10_000,
  });
  const existingPath = existing.status === 0 ? existing.stdout.trim().split(/\r?\n/)[0] : "";
  if (existingPath) {
    return [
      "CLI command setup:",
      `  addroid       : available (${existingPath})`,
      "",
    ];
  }

  const shouldLink = await opts.confirm(
    "`addroid doctor` のように直接実行できるよう、この checkout の CLI をリンクしますか?",
    true
  );
  if (!shouldLink) {
    return [
      "CLI command setup:",
      "  addroid       : skipped",
      "                  後で `npm run link:cli` を実行すると `addroid doctor` の形で使えます。",
      "",
    ];
  }

  const linked = opts.runner("npm", ["link", "--workspace", "apps/cli"], {
    cwd: repoRoot,
    env: opts.env,
    timeoutMs: 120_000,
  });
  if (linked.status === 0) {
    return [
      "CLI command setup:",
      "  addroid       : linked",
      "                  以後は `npm run addroid -- doctor` ではなく `addroid doctor` を使えます。",
      "",
    ];
  }
  return [
    "CLI command setup:",
    `  addroid       : link failed - ${summarizeCommandFailure(linked)}`,
    "                  セットアップは続行します。後で `npm run link:cli` を再実行してください。",
    "",
  ];
}

async function maybeConfigureMetaAccessToken(opts: {
  out: string[];
  assumeYes: boolean;
}): Promise<boolean> {
  opts.out.push("");
  opts.out.push("Meta Access Token setup:");
  opts.out.push("  実際の Meta 広告アカウントを接続して Apply / Activate / レポート取得を行うには必須です。");
  opts.out.push("  AdDroid の標準設定は OAuth callback ではなく Access Token 入力方式です。");
  opts.out.push("  ローカル利用で HTTPS callback URL を用意する必要はありません。");
  opts.out.push("  Meta Business Suite / Graph API Explorer 等で token を発行し、この後の入力欄に貼り付けます。");
  opts.out.push("  必要な権限の目安: ads_read, ads_management, business_management。");
  opts.out.push("  token 入力後、AdDroid が取得できる Ad Account を表示し、利用するアカウントを選択します。");
  opts.out.push("  入力値は ENCRYPTION_KEY で暗号化し、平文では保存しません。");
  if (!opts.assumeYes) {
    opts.out.push("  このまま Meta Access Token の非表示入力に進みます。");
  }
  process.stdout.write(opts.out.join("\n") + "\n");
  opts.out.length = 0;

  if (opts.assumeYes) {
    opts.out.push("  Meta Token    : skipped (--yes では token 入力を省略)");
    opts.out.push("                  後で `addroid auth meta` を実行してください。");
    return false;
  }
  return true;
}

async function maybeConfigureLLMProvider(opts: {
  prompt: PromptFn;
  selectOption: SelectFn;
  out: string[];
  assumeYes: boolean;
  runAuthCommand?: (args: string[]) => Promise<number>;
  env: NodeJS.ProcessEnv;
  envFile?: string;
}): Promise<boolean> {
  if (opts.assumeYes) {
    opts.out.push("  LLM Provider  : skipped (--yes では API key / OAuth 入力を省略)");
    opts.out.push("                  実利用には LLM Provider が必須です。後で `addroid auth llm` を実行してください。");
    return true;
  }
  opts.out.push("");
  opts.out.push("LLM Provider setup:");
  opts.out.push("  AI workflow / レポート生成 / 改善提案には LLM Provider が必須です。");
  opts.out.push("  このまま provider 選択へ進みます。API key は ENCRYPTION_KEY で暗号化して保存します。");
  process.stdout.write(opts.out.join("\n") + "\n");
  opts.out.length = 0;
  const choice = (
    await opts.selectOption(
      "LLM Provider",
      [
        {
          value: "openai-api-key",
          label: "OpenAI API key",
          description: "OpenAI の API key を暗号化保存して使います",
        },
        {
          value: "anthropic-api-key",
          label: "Anthropic API key",
          description: "Anthropic の API key を暗号化保存して使います",
        },
        {
          value: "codex-oauth",
          label: "Codex OAuth",
          description: "ブラウザを開いて Codex OAuth 認証します",
        },
      ],
      "openai-api-key"
    )
  )
    .trim()
    .toLowerCase();

  if (choice === "skip" || choice === "none") {
    opts.out.push("  LLM Provider  : skipped");
    opts.out.push("                  実利用には LLM Provider が必須です。provider を選び直してください。");
    return false;
  }
  if (choice === "codex-oauth" || choice === "oauth" || choice === "codex") {
    const codexEnv = await ensureCodexOAuthEnvConfig({
      env: opts.env,
      envFile: opts.envFile,
      out: opts.out,
    });
    if (!codexEnv) return false;
    opts.out.push("  LLM Provider  : configuring Codex OAuth");
    opts.out.push("                  ブラウザが開きます。自動検出できない場合は callback URL を貼り付けて続行できます。");
    process.stdout.write(opts.out.join("\n") + "\n");
    opts.out.length = 0;
    const runAuthCommand =
      opts.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
    const code = await withRuntimeEnv(opts.env, () =>
      runAuthCommand(["llm", "--provider", "codex"])
    );
    opts.out.push(`  LLM Provider  : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
    if (code !== 0) {
      opts.out.push("                  実利用には LLM Provider が必須です。ADDROID_CODEX_* を確認し、`addroid auth llm --provider codex` を再実行してください。");
      return false;
    }
    return true;
  }

  const provider =
    choice === "anthropic" || choice === "anthropic-api-key"
      ? "anthropic"
      : choice === "openai" || choice === "openai-api-key"
        ? "openai"
        : null;
  if (!provider) {
    opts.out.push(`  LLM Provider  : unknown choice (${choice})`);
    opts.out.push("                  openai-api-key / anthropic-api-key / codex-oauth のいずれかを選んでください。");
    return false;
  }
  const defaultModel =
    provider === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4.1";
  const model = (await opts.prompt(`${provider} default model`, defaultModel)).trim() || defaultModel;
  opts.out.push(`  LLM Provider  : configuring ${provider} API key`);
  process.stdout.write(opts.out.join("\n") + "\n");
  opts.out.length = 0;
  const runAuthCommand =
    opts.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
  const code = await withRuntimeEnv(opts.env, () =>
    runAuthCommand(["llm", "--provider", provider, "--model", model])
  );
  opts.out.push(`  LLM Provider  : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
  if (code === 0 && provider === "openai") {
    opts.out.push("  Image Provider: OpenAI API key will also be used for GPT Image 2");
  }
  if (code === 0 && provider === "anthropic") {
    opts.out.push("  Image Provider: GPT Image 2 requires OpenAI API key or Codex app-server");
  }
  if (code !== 0) {
    opts.out.push(`                  実利用には LLM Provider が必須です。API key を確認し、\`addroid auth llm --provider ${provider}\` を再実行してください。`);
    return false;
  }
  return true;
}

async function ensureCodexOAuthEnvConfig(opts: {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  out: string[];
}): Promise<boolean> {
  const requiredDefaults: Record<string, string> = {
    ADDROID_CODEX_CLIENT_ID: DEFAULT_CODEX_CLIENT_ID,
    ADDROID_CODEX_AUTHORIZATION_URL: DEFAULT_CODEX_AUTHORIZATION_URL,
    ADDROID_CODEX_TOKEN_URL: DEFAULT_CODEX_TOKEN_URL,
    ADDROID_CODEX_CHAT_COMPLETIONS_URL: DEFAULT_CODEX_CHAT_COMPLETIONS_URL,
    ADDROID_CODEX_DEFAULT_MODEL: DEFAULT_CODEX_MODEL,
    ADDROID_CODEX_SCOPES: DEFAULT_CODEX_SCOPES,
  };
  if (opts.env.ADDROID_CODEX_CLIENT_ID?.trim()) {
    requiredDefaults.ADDROID_CODEX_CLIENT_ID = opts.env.ADDROID_CODEX_CLIENT_ID.trim();
  }
  const result = await ensureAdditionalEnvValues({
    env: opts.env,
    envFile: opts.envFile,
    updates: requiredDefaults,
  });
  if (result.updated.length > 0 || result.kept.length > 0) {
    opts.out.push(
      `  Codex config  : ${result.path} ${result.wrote ? "(updated)" : "(unchanged)"}`
    );
    opts.out.push(
      `                  updated: ${result.updated.length > 0 ? result.updated.join(", ") : "none"}${
        result.kept.length > 0 ? `; kept existing: ${result.kept.join(", ")}` : ""
      }`
    );
  }
  return true;
}

interface ScaffoldResult {
  paths: Awaited<ReturnType<typeof ensureAddroidPaths>>;
  configPath: string;
  configWrote: boolean;
  secretsCreated: boolean;
}

async function scaffoldAddroid(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const paths = await ensureAddroidPaths();

  let existing: AddroidConfig | null = null;
  try {
    existing = await readAddroidConfig();
  } catch (err) {
    if (err instanceof ConfigParseError) {
      process.stderr.write(formatConfigParseError(err));
      throw new InitAbort();
    }
    throw err;
  }

  const next = mergeWithDefaults(existing, opts);
  const result = await writeAddroidConfig(next);

  const secretsCreated = await ensureSecretsStub(paths.secretsFile);
  return {
    paths,
    configPath: result.path,
    configWrote: result.wrote,
    secretsCreated,
  };
}

async function safeScaffoldAddroid(opts: ScaffoldOptions): Promise<ScaffoldResult | null> {
  try {
    return await scaffoldAddroid(opts);
  } catch (err) {
    if (err instanceof InitAbort) return null;
    throw err;
  }
}

function mergeWithDefaults(
  existing: AddroidConfig | null,
  opts: ScaffoldOptions = {}
): AddroidConfig {
  const defaults = defaultAddroidConfig();
  const projectName = opts.projectName?.trim();
  if (!existing) {
    if (!projectName) return defaults;
    return AddroidConfigSchema.parse({
      ...defaults,
      workspace: {
        ...defaults.workspace,
        slug: slugify(projectName),
        displayName: projectName,
      },
    });
  }
  // 既存値を尊重しつつ、database.urlRef は環境に応じて再評価する。
  const next: AddroidConfig = {
    version: 1,
    workspace: {
      slug: projectName ? slugify(projectName) : existing.workspace.slug,
      displayName: projectName || existing.workspace.displayName,
      // Regression fix: 既に config.yaml に書かれた mode は再 init で
      // 黙って戻さない。未指定 (旧スキーマ) は schema default の "proposal" に倒す。
      executionMode:
        existing.workspace.executionMode ?? defaults.workspace.executionMode,
    },
    database: {
      // urlRef は env に追従させる (既存値は意図的に上書き)。
      // 例: 初回実行時に DATABASE_URL 未設定で ".env.local" が記録された後、
      // ユーザーが DATABASE_URL を export して再 init した場合、現在の env を
      // 反映して "(env)" に更新する。逆方向 ((env) → .env.local) も同様に追従する。
      urlRef: defaults.database.urlRef,
    },
    web: {
      hostname: existing.web?.hostname ?? defaults.web.hostname,
      port: existing.web?.port ?? defaults.web.port,
    },
    github: existing.github ?? {},
  };
  // 念のため再 validate (例外が出れば呼び出し側で fail)。
  return AddroidConfigSchema.parse(next);
}

class InitAbort extends Error {}

async function ensureSecretsStub(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return false;
  } catch {
    /* not present */
  }
  await fs.writeFile(file, SECRETS_STUB, { encoding: "utf8", mode: 0o600 });
  return true;
}

interface EnvEnsureOptions {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  databaseUrl: string;
  encryptionKey: string;
  mockIntegrations: boolean;
  forcePlaceholders: boolean;
}

interface EnvEnsureResult {
  path: string;
  wrote: boolean;
  updated: string[];
  kept: string[];
}

async function ensureEnvFile(opts: EnvEnsureOptions): Promise<EnvEnsureResult> {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : resolveDefaultEnvFile();
  const updates: Record<string, string> = {
    DATABASE_URL: opts.databaseUrl,
    ENCRYPTION_KEY: opts.encryptionKey,
  };
  if (opts.mockIntegrations) {
    updates.ADDROID_META_ADS_CLI_MOCK = "1";
    updates.ADDROID_GITHUB_OAUTH_MOCK = "1";
    updates.ADDROID_LLM_MOCK = "1";
  }
  if (opts.env.ADDROID_META_CLI_BIN?.trim()) {
    updates.ADDROID_META_CLI_BIN = opts.env.ADDROID_META_CLI_BIN.trim();
  }

  let text = "";
  try {
    text = await fs.readFile(envFile, "utf8");
  } catch {
    text =
      "# AdDroid OSS local environment. Generated by `addroid init`.\n" +
      "# This file is gitignored. Do not commit secrets.\n";
  }

  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const updated: string[] = [];
  const kept: string[] = [];
  const keptValues = new Map<string, string>();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const key = match[2]!;
    if (!(key in updates)) return line;
    seen.add(key);
    const current = stripEnvQuotes(match[4] ?? "");
    if (!opts.forcePlaceholders && current.trim().length > 0) {
      kept.push(key);
      keptValues.set(key, current);
      return line;
    }
    if (current.trim().length > 0 && !isPlaceholderEnvValue(key, current)) {
      kept.push(key);
      keptValues.set(key, current);
      return line;
    }
    updated.push(key);
    return `${match[1]}${key}${match[3]}${quoteEnv(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      if (next.length > 0 && next[next.length - 1] !== "") next.push("");
      next.push(`${key}=${quoteEnv(value)}`);
      updated.push(key);
    }
  }

  const finalText = next.join("\n").replace(/\n*$/, "\n");
  const wrote = finalText !== text;
  if (wrote) {
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await fs.writeFile(envFile, finalText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(envFile, 0o600).catch(() => undefined);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!opts.env[key] || isPlaceholderEnvValue(key, opts.env[key]!)) {
      opts.env[key] = keptValues.get(key) ?? value;
    }
  }

  return { path: envFile, wrote, updated, kept };
}

async function ensureAdditionalEnvValues(opts: {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  updates: Record<string, string>;
}): Promise<EnvEnsureResult> {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : resolveDefaultEnvFile();
  let text = "";
  try {
    text = await fs.readFile(envFile, "utf8");
  } catch {
    text =
      "# AdDroid OSS local environment. Generated by `addroid init`.\n" +
      "# This file is gitignored. Do not commit secrets.\n";
  }

  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const updated: string[] = [];
  const kept: string[] = [];
  const keptValues = new Map<string, string>();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const key = match[2]!;
    if (!(key in opts.updates)) return line;
    seen.add(key);
    const current = stripEnvQuotes(match[4] ?? "");
    if (current.trim().length > 0 && !isPlaceholderEnvValue(key, current)) {
      kept.push(key);
      keptValues.set(key, current);
      return line;
    }
    updated.push(key);
    return `${match[1]}${key}${match[3]}${quoteEnv(opts.updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(opts.updates)) {
    if (!seen.has(key)) {
      if (next.length > 0 && next[next.length - 1] !== "") next.push("");
      next.push(`${key}=${quoteEnv(value)}`);
      updated.push(key);
    }
  }

  const finalText = next.join("\n").replace(/\n*$/, "\n");
  const wrote = finalText !== text;
  if (wrote) {
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await fs.writeFile(envFile, finalText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(envFile, 0o600).catch(() => undefined);
  }

  for (const [key, value] of Object.entries(opts.updates)) {
    if (!opts.env[key] || isPlaceholderEnvValue(key, opts.env[key]!)) {
      opts.env[key] = keptValues.get(key) ?? value;
    }
  }

  return { path: envFile, wrote, updated, kept };
}

async function readInitAuthState(
  env: NodeJS.ProcessEnv,
  overrides: InitCommandOverrides
): Promise<InitAuthState> {
  if (overrides.readAuthState) return await overrides.readAuthState(env);
  if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) {
    return {
      checked: false,
      metaConnected: false,
      githubConnected: false,
      opsRepoLinked: false,
      llmProviders: [],
      detail: "DATABASE_URL or ENCRYPTION_KEY is not configured",
    };
  }
  let prisma: InitAuthPrismaClient | null = null;
  try {
    const imported = (await import("@addroid/db")) as {
      prisma: InitAuthPrismaClient;
    };
    prisma = imported.prisma;
    const rows = await prisma.oAuthToken.findMany({
      where: {
        provider: {
          in: ["meta", "github", "codex", "openai", "anthropic"],
        },
      },
      select: {
        provider: true,
      },
      orderBy: {
        connectedAt: "desc",
      },
    });
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { opsRepoId: true },
    });
    const providers = Array.from(new Set(rows.map((r) => r.provider)));
    return {
      checked: true,
      metaConnected: providers.includes("meta"),
      githubConnected: providers.includes("github"),
      opsRepoLinked: Boolean(ws?.opsRepoId),
      llmProviders: providers.filter((p) => p === "codex" || p === "openai" || p === "anthropic"),
    };
  } catch (err) {
    return {
      checked: false,
      metaConnected: false,
      githubConnected: false,
      opsRepoLinked: false,
      llmProviders: [],
      detail: (err as Error).message,
    };
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

function resolveDefaultEnvFile(): string {
  try {
    return path.join(resolveRepoRoot(), ".env");
  } catch {
    return path.resolve(process.cwd(), ".env");
  }
}

function resolveInitDatabaseUrl(
  opts: InitOptions,
  env: NodeJS.ProcessEnv,
  overrides: InitCommandOverrides
): string {
  if (opts.databaseUrl) return opts.databaseUrl;
  if (env.DATABASE_URL && !isPlaceholderEnvValue("DATABASE_URL", env.DATABASE_URL)) {
    return env.DATABASE_URL;
  }
  return buildDefaultDatabaseUrl(generateDatabasePassword(overrides));
}

function buildDefaultDatabaseUrl(password: string): string {
  const encodedUser = encodeURIComponent(DEFAULT_DATABASE_USER);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${DEFAULT_DATABASE_HOST}:${DEFAULT_DATABASE_PORT}/${DEFAULT_DATABASE_NAME}`;
}

function maybeCreateLocalDatabase(
  databaseUrl: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  if (!isDefaultLocalDatabase(databaseUrl)) {
    return { ok: true, detail: "custom DATABASE_URL のため DB 自動作成はスキップしました。" };
  }
  const parsed = new URL(databaseUrl);
  const password = decodeURIComponent(parsed.password);
  if (!password) {
    return {
      ok: false,
      detail: "local DATABASE_URL に password がありません。`addroid init` で生成した URL を使うか、password 付き URL を指定してください。",
    };
  }
  const sql = [
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'addroid') THEN",
    `    CREATE ROLE addroid LOGIN PASSWORD ${sqlLiteral(password)};`,
    "  ELSE",
    `    ALTER ROLE addroid WITH LOGIN PASSWORD ${sqlLiteral(password)};`,
    "  END IF;",
    "END",
    "$$;",
    "SELECT 'CREATE DATABASE addroid OWNER addroid'",
    "WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'addroid')\\gexec",
    "GRANT ALL PRIVILEGES ON DATABASE addroid TO addroid;",
    "\\connect addroid",
    "ALTER SCHEMA public OWNER TO addroid;",
    "GRANT ALL ON SCHEMA public TO addroid;",
    "",
  ].join("\n");
  const r = runner("psql", ["-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    env,
    input: sql,
    timeoutMs: 30_000,
  });
  if (r.status === 0) {
    return { ok: true, detail: "addroid role/database ready" };
  }
  return {
    ok: false,
    detail: summarizeCommandFailure(r),
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPrismaSetup(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (err) {
    return {
      ok: false,
      detail: `repo root を特定できません: ${(err as Error).message}`,
    };
  }
  const generate = runner("npm", ["run", "db:generate"], { cwd: repoRoot, env, timeoutMs: 120_000 });
  if (generate.status !== 0) return { ok: false, detail: summarizeCommandFailure(generate) };
  const push = runner("npm", ["run", "db:push", "--", "--accept-data-loss"], {
    cwd: repoRoot,
    env,
    timeoutMs: 180_000,
  });
  if (push.status !== 0) return { ok: false, detail: summarizeCommandFailure(push) };
  return { ok: true, detail: "Prisma client generated and schema pushed" };
}

async function installMissingDependencies(
  checks: CheckResult[],
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  opts: { assumeYes?: boolean; confirm?: ConfirmFn } = {}
): Promise<Array<{ label: string; outcome: { ok: boolean; detail: string } }>> {
  const out: Array<{ label: string; outcome: { ok: boolean; detail: string } }> = [];
  for (const check of checks) {
    if (check.name === "uv") {
      const command = "curl -LsSf https://astral.sh/uv/install.sh | sh";
      const approval = await confirmInstallCommand(opts, "uv", command, false);
      if (!approval.ok) {
        out.push({ label: "uv", outcome: approval.outcome });
        return out;
      }
      const r = runVisibleCommand("uv", command, runner, "sh", ["-c", command], {
        env,
        timeoutMs: 180_000,
      });
      const outcome = commandOutcome(r, "uv installed");
      if (outcome.ok) prependUvBinToPath(env);
      out.push({ label: "uv", outcome });
      if (!outcome.ok) return out;
    }
    if (check.name === "python3.12") {
      const command = `uv python install ${META_ADS_CLI_PYTHON_VERSION}`;
      const approval = await confirmInstallCommand(opts, "Python 3.12+", command, true);
      if (!approval.ok) {
        out.push({ label: "Python 3.12+", outcome: approval.outcome });
        return out;
      }
      const r = runVisibleCommand(
        "Python 3.12+",
        command,
        runner,
        "sh",
        [
          "-c",
          `${UV_SH}; "$uv_bin" python install ${META_ADS_CLI_PYTHON_VERSION}`,
        ],
        {
          env,
          timeoutMs: 180_000,
        }
      );
      out.push({
        label: "Python 3.12+",
        outcome: commandOutcome(r, `Python ${META_ADS_CLI_PYTHON_VERSION} installed`),
      });
      if (!out[out.length - 1]!.outcome.ok) return out;
    }
    if (check.name === "meta-ads-cli") {
      const command = `uv tool install meta-ads --python ${META_ADS_CLI_PYTHON_VERSION}`;
      const approval = await confirmInstallCommand(opts, "Meta Ads CLI", command, true);
      if (!approval.ok) {
        out.push({ label: "Meta Ads CLI", outcome: approval.outcome });
        return out;
      }
      const r = runVisibleCommand(
        "Meta Ads CLI",
        command,
        runner,
        "sh",
        [
          "-c",
          `${UV_SH}; "$uv_bin" python install ${META_ADS_CLI_PYTHON_VERSION} && "$uv_bin" tool install meta-ads --python ${META_ADS_CLI_PYTHON_VERSION}`,
        ],
        {
          env,
          timeoutMs: 180_000,
        }
      );
      const outcome = commandOutcome(r, "Meta Ads CLI installed");
      if (outcome.ok && !env.ADDROID_META_CLI_BIN) {
        prependUvBinToPath(env);
        const detected = detectMetaCliBin(runner, env);
        if (detected) {
          env.ADDROID_META_CLI_BIN = detected;
        } else {
          outcome.ok = false;
          outcome.detail = "Meta Ads CLI install command succeeded, but `meta` was not found on PATH.";
        }
      }
      out.push({ label: "Meta Ads CLI", outcome });
      if (!outcome.ok) return out;
    }
    if (check.name === "postgres-16") {
      const command =
        process.platform === "darwin"
          ? "brew install postgresql@16 && brew services start postgresql@16"
          : process.platform === "linux"
            ? "sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-client-16 (or dnf equivalent)"
            : "install PostgreSQL 16+ with your OS package manager";
      const approval = await confirmInstallCommand(opts, "PostgreSQL 16+", command, false);
      if (!approval.ok) {
        out.push({ label: "PostgreSQL 16+", outcome: approval.outcome });
        return out;
      }
      const outcome = installPostgres(runner, env);
      out.push({ label: "PostgreSQL 16+", outcome });
      if (!outcome.ok) return out;
    }
  }
  return out;
}

async function confirmInstallCommand(
  opts: { assumeYes?: boolean; confirm?: ConfirmFn },
  label: string,
  command: string,
  defaultYes: boolean
): Promise<{ ok: true } | { ok: false; outcome: { ok: false; detail: string } }> {
  if (opts.assumeYes || !opts.confirm) return { ok: true };
  const approved = await opts.confirm(`${label} を次のコマンドでインストールしますか? ${command}`, defaultYes);
  return approved ? { ok: true } : { ok: false, outcome: { ok: false, detail: "skipped by user" } };
}

async function setupDependencies(opts: {
  opts: InitOptions;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}): Promise<{ ok: boolean; lines: string[] }> {
  const checks = [
    checkPlatform(),
    checkUv(),
    checkPython312(),
    checkMetaAdsCli(opts.env),
    checkPostgresVersion(),
  ];
  const lines = ["", "Dependency setup:"];
  for (const c of checks) lines.push(formatCheck(c));
  const failing = checks.filter(needsSetupAction);
  if (failing.length === 0) {
    return { ok: true, lines };
  }
  process.stdout.write(lines.join("\n") + "\n");
  lines.length = 0;
  const installResults = await installMissingDependencies(failing, opts.runner, opts.env);
  for (const r of installResults) {
    lines.push(...formatCommandOutcome(r.label, r.outcome));
    if (!r.outcome.ok) {
      return { ok: false, lines };
    }
  }
  return { ok: true, lines };
}

function detectMetaCliBin(runner: CommandRunner, env: NodeJS.ProcessEnv): string | null {
  const r = runner("sh", ["-c", "command -v meta || command -v meta-ads || command -v meta_ads || command -v metaads"], {
    env,
    timeoutMs: 10_000,
  });
  if (r.status !== 0) return null;
  const first = (r.stdout || "").trim().split(/\r?\n/)[0]?.trim();
  return first || null;
}

function prependUvBinToPath(env: NodeJS.ProcessEnv): void {
  const binDir =
    env.UV_TOOL_BIN_DIR?.trim() ||
    path.join(env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir(), ".local", "bin");
  const pathValue = env.PATH ?? "";
  if (!pathValue.split(path.delimiter).includes(binDir)) {
    env.PATH = pathValue ? `${binDir}${path.delimiter}${pathValue}` : binDir;
  }
}

function installPostgres(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  if (process.platform === "darwin") {
    const brew = runner("brew", ["--version"], { env, timeoutMs: 10_000 });
    if (brew.status !== 0) {
      return { ok: false, detail: "Homebrew が見つかりません。brew install postgresql@16 を手動実行してください。" };
    }
    const install = runVisibleCommand(
      "PostgreSQL 16+",
      "brew install postgresql@16",
      runner,
      "brew",
      ["install", "postgresql@16"],
      { env, timeoutMs: 300_000 }
    );
    if (install.status !== 0) return { ok: false, detail: summarizeCommandFailure(install) };
    const start = runVisibleCommand(
      "PostgreSQL 16+",
      "brew services start postgresql@16",
      runner,
      "brew",
      ["services", "start", "postgresql@16"],
      { env, timeoutMs: 60_000 }
    );
    return commandOutcome(start, "PostgreSQL service started");
  }
  if (process.platform === "linux") {
    const apt = runner("sh", ["-c", "command -v apt-get >/dev/null 2>&1"], { env, timeoutMs: 10_000 });
    if (apt.status === 0) {
      const install = runVisibleCommand(
        "PostgreSQL 16+",
        "sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-client-16",
        runner,
        "sh",
        ["-c", "sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-client-16"],
        { env, timeoutMs: 300_000 }
      );
      return commandOutcome(install, "PostgreSQL packages installed");
    }
    const dnf = runner("sh", ["-c", "command -v dnf >/dev/null 2>&1"], { env, timeoutMs: 10_000 });
    if (dnf.status === 0) {
      const install = runVisibleCommand(
        "PostgreSQL 16+",
        "sudo dnf install -y postgresql-server postgresql",
        runner,
        "sh",
        ["-c", "sudo dnf install -y postgresql-server postgresql"],
        {
          env,
          timeoutMs: 300_000,
        }
      );
      return commandOutcome(install, "PostgreSQL packages installed");
    }
  }
  return { ok: false, detail: "このOSでは PostgreSQL の自動インストール手順を判定できませんでした。" };
}

function runVisibleCommand(
  label: string,
  commandForDisplay: string,
  runner: CommandRunner,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }
): CommandResult {
  const startedAt = Date.now();
  process.stdout.write(`  ${label}: running\n`);
  process.stdout.write(`    $ ${commandForDisplay}\n`);
  process.stdout.write("    インストール中です。数分かかる場合があります。コマンド出力をそのまま表示します。\n");
  const result = runner(cmd, args, { ...opts, streamOutput: true });
  const elapsed = formatElapsed(Date.now() - startedAt);
  process.stdout.write(`  ${label}: finished (${elapsed})\n`);
  return result;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function commandOutcome(r: CommandResult, success: string): { ok: boolean; detail: string } {
  if (r.status === 0) return { ok: true, detail: success };
  return { ok: false, detail: summarizeCommandFailure(r) };
}

function defaultRunCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    streamOutput?: boolean;
  } = {}
): CommandResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    encoding: "utf8",
    ...(opts.streamOutput
      ? { stdio: [opts.input === undefined ? "ignore" : "pipe", "inherit", "inherit"] as const }
      : {}),
    timeout: opts.timeoutMs ?? 120_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

function summarizeCommandFailure(r: CommandResult): string {
  if (r.error) return r.error.message;
  const detail = (r.stderr || r.stdout || "").trim();
  return `exit ${r.status ?? "unknown"}${detail ? `: ${detail.split(/\r?\n/).slice(-4).join(" ")}` : ""}`;
}

async function withRuntimeEnv<T>(
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>
): Promise<T> {
  if (env === process.env) return await fn();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function defaultPrompt(question: string, defaultValue = ""): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue} / Enterで既定]` : "";
  return rl.question(`? ${question}${suffix}: `).then((answer) => {
    rl.close();
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultValue;
  });
}

function buildPromptSelect(prompt: PromptFn): SelectFn {
  return async (question, options, defaultValue) => {
    const choices = options.map((o) => o.value).join(" / ");
    return await prompt(`${question} (${choices})`, defaultValue);
  };
}

function defaultSelectOption(
  question: string,
  options: readonly SelectOption[],
  defaultValue: string
): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    return buildPromptSelect(defaultPrompt)(question, options, defaultValue);
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const defaultIndex = Math.max(
      0,
      options.findIndex((o) => o.value === defaultValue)
    );
    let highlighted = defaultIndex;
    let selected = defaultIndex;
    let renderedLines = 0;

    const render = () => {
      if (renderedLines > 0) {
        readlineControl.moveCursor(process.stdout, 0, -renderedLines);
        readlineControl.cursorTo(process.stdout, 0);
        readlineControl.clearScreenDown(process.stdout);
      }
      const lines = [
        `? ${question} (↑/↓で移動、Spaceで選択、Enterで確定)`,
        ...options.map((option, i) => {
          const cursor = i === highlighted ? ">" : " ";
          const checked = i === selected ? "[x]" : "[ ]";
          return `${cursor} ${checked} ${option.label} - ${option.description}`;
        }),
      ];
      process.stdout.write(lines.join("\n") + "\n");
      renderedLines = lines.length;
    };

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (s === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("interrupted"));
        return;
      }
      if (s === "\r" || s === "\n") {
        cleanup();
        resolve(options[selected]?.value ?? defaultValue);
        return;
      }
      if (s === " ") {
        selected = highlighted;
        render();
        return;
      }
      if (s === "\u001b[A" || s === "k") {
        highlighted = (highlighted - 1 + options.length) % options.length;
        render();
        return;
      }
      if (s === "\u001b[B" || s === "j") {
        highlighted = (highlighted + 1) % options.length;
        render();
      }
    };

    render();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function defaultConfirm(question: string, defaultYes = false): Promise<boolean> {
  const answer = await defaultPrompt(`${question} ${defaultYes ? "(Y/n)" : "(y/N)"}`, "");
  if (!answer) return defaultYes;
  return /^(y|yes|はい|ok)$/i.test(answer.trim());
}

function generateEncryptionKey(overrides: InitCommandOverrides): string {
  const rb = overrides.randomBytes ?? randomBytes;
  return rb(32).toString("base64");
}

function generateDatabasePassword(overrides: InitCommandOverrides): string {
  const rb = overrides.randomBytes ?? randomBytes;
  return rb(18).toString("base64url");
}

function isDefaultLocalDatabase(databaseUrl: string): boolean {
  try {
    const u = new URL(databaseUrl);
    return (
      (u.protocol === "postgresql:" || u.protocol === "postgres:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.port === "" || u.port === "5432") &&
      u.pathname.replace(/^\//, "") === "addroid" &&
      u.username === "addroid"
    );
  } catch {
    return false;
  }
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@%?&=+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function stripNodeModulesBinFromPath(value: string): string {
  return value
    .split(path.delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin$/.test(entry))
    .join(path.delimiter);
}

function isPlaceholderEnvValue(key: string, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (key === "DATABASE_URL") {
    return /USER:PASSWORD|replace|placeholder/i.test(v);
  }
  if (key === "ENCRYPTION_KEY") {
    return /replace-with|placeholder|random-value/i.test(v) || v.length < 32;
  }
  return /replace|placeholder/i.test(v);
}

function printScaffoldResult(result: ScaffoldResult): void {
  const lines = ["[addroid init]", "", ...formatScaffoldResult(result), "", "Next steps:"];
  if (!process.env.DATABASE_URL) {
    lines.push("  1. addroid init --interactive    # .env / DB まで対話セットアップ");
    lines.push("  2. addroid doctor");
    lines.push("  3. Meta Access Token を用意");
    lines.push("  4. addroid auth meta             # token 入力 + Ad Account 選択");
    lines.push("  5. addroid auth github           # GitHub 認証 + ops repo 作成");
    lines.push("  6. addroid auth llm --provider openai");
    lines.push("  7. addroid up");
  } else {
    lines.push("  1. addroid doctor");
    lines.push("  2. Meta Access Token を用意");
    lines.push("  3. addroid auth meta             # token 入力 + Ad Account 選択");
    lines.push("  4. addroid auth github           # GitHub 認証 + ops repo 作成");
    lines.push("  5. addroid auth llm --provider openai");
    lines.push("  6. addroid up");
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function printAlreadyInitializedResult(result: ScaffoldResult, auth: InitAuthState): void {
  const lines = [
    "[addroid init]",
    "",
    "AdDroid is already initialized. Existing config / secrets / credentials were left as-is.",
    "",
    ...formatScaffoldResult(result),
    "",
    "Connected credentials:",
    `  Meta Token    : ${auth.metaConnected ? "configured" : "not detected"}`,
    `  GitHub       : ${auth.githubConnected ? "configured" : "not detected"}`,
    `  Ops Repo     : ${auth.opsRepoLinked ? "linked" : "not linked"}`,
    `  LLM Provider  : ${auth.llmProviders.length > 0 ? auth.llmProviders.join(", ") : "not detected"}`,
  ];
  if (!auth.checked && auth.detail) {
    lines.push(`  auth check    : skipped (${auth.detail})`);
  }
  lines.push("");
  lines.push("Maintenance:");
  lines.push("  addroid doctor");
  lines.push("  addroid init --interactive --force       # 初期セットアップを明示的に再実行");
  lines.push("  addroid init --interactive --reauth-meta # Meta token を再認証");
  lines.push("  addroid init --interactive --reauth-github # GitHub token / ops repo を再設定");
  lines.push("  addroid init --interactive --reauth-llm  # LLM provider を選び直して再認証");
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function formatScaffoldResult(result: ScaffoldResult): string[] {
  return [
    `  home          : ${result.paths.home}`,
    `  storage       : ${result.paths.storageDir}`,
    `  logs          : ${result.paths.logsDir}`,
    `  run           : ${result.paths.runDir}`,
    `  config        : ${result.configPath} ${result.configWrote ? "(updated)" : "(unchanged)"}`,
    `  secrets file  : ${result.paths.secretsFile} ${
      result.secretsCreated ? "(created stub)" : "(left as-is)"
    }`,
  ];
}

function formatEnvResult(result: EnvEnsureResult): string[] {
  const changed = result.updated.length > 0 ? result.updated.join(", ") : "none";
  const kept = result.kept.length > 0 ? `; kept existing: ${result.kept.join(", ")}` : "";
  return [`  env           : ${result.path} ${result.wrote ? "(updated)" : "(unchanged)"}`, `                  updated: ${changed}${kept}`];
}

function formatCommandOutcome(label: string, outcome: { ok: boolean; detail: string }): string[] {
  return [`  ${label.padEnd(14)}: ${outcome.ok ? "ok" : "error"} - ${outcome.detail}`];
}

function formatCheck(c: CheckResult): string {
  const state = c.state.padEnd(7);
  return `  [${state}] ${c.name.padEnd(17)} ${c.message}`;
}

function needsSetupAction(c: CheckResult): boolean {
  if (c.state === "error") return true;
  return c.name === "postgres-16" && c.state === "warn";
}

function formatConfigParseError(err: ConfigParseError): string {
  return [
    `[addroid init] 既存の ${err.file} がスキーマと一致しません:`,
    ...err.issues.map((m) => `  - ${m}`),
    "  既存ファイルを破壊しないため init を中断しました。手動で修正後に再実行してください。",
    "",
  ].join("\n");
}

function parseInitArgs(args: string[]): InitOptions {
  const opts: InitOptions = {
    yes: false,
    installDeps: false,
    skipDeps: false,
    skipDbCreate: false,
    skipDbPush: false,
    dbPush: false,
    mockIntegrations: false,
    skipLinkCli: false,
    force: false,
    reauthMeta: false,
    reauthGithub: false,
    reauthLlm: false,
    noChat: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const next = () => {
      const v = args[++i];
      if (!v) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--interactive") opts.interactive = true;
    else if (a === "--non-interactive" || a === "--no-interactive") opts.interactive = false;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--install-deps") opts.installDeps = true;
    else if (a === "--skip-deps") opts.skipDeps = true;
    else if (a === "--skip-db-create") opts.skipDbCreate = true;
    else if (a === "--skip-db-push") opts.skipDbPush = true;
    else if (a === "--db-push") opts.dbPush = true;
    else if (a === "--mock-integrations") opts.mockIntegrations = true;
    else if (a === "--skip-link-cli") opts.skipLinkCli = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--reauth-meta") opts.reauthMeta = true;
    else if (a === "--reauth-github") opts.reauthGithub = true;
    else if (a === "--reauth-llm") opts.reauthLlm = true;
    else if (a === "--no-chat") opts.noChat = true;
    else if (a === "--project-name") opts.projectName = next();
    else if (a.startsWith("--project-name=")) opts.projectName = a.slice("--project-name=".length);
    else if (a === "--database-url") opts.databaseUrl = next();
    else if (a.startsWith("--database-url=")) opts.databaseUrl = a.slice("--database-url=".length);
    else if (a === "--env-file") opts.envFile = next();
    else if (a.startsWith("--env-file=")) opts.envFile = a.slice("--env-file=".length);
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

function printInitHelp(): void {
  process.stdout.write(
    [
      "addroid init — first-run setup wizard",
      "",
      "Usage:",
      "  addroid init [--interactive]",
      "  addroid init --non-interactive --yes [--project-name NAME] [--database-url URL]",
      "",
      "Options:",
      "  --interactive          対話型ウィザードを強制",
      "  --non-interactive      対話せず実行。単独指定時は ~/.addroid scaffold のみ作成",
      "  --yes, -y              既定値で .env・DB を初期化し、確認を省略",
      "  --project-name NAME    workspace 名を設定",
      "  --database-url URL     .env に保存する DATABASE_URL",
      "  --env-file PATH        書き込み先 env file (既定: repo root の .env)",
      "  --install-deps         uv / Python / Meta Ads CLI / PostgreSQL の不足分を明示的にインストール",
      "  --skip-deps            依存診断をスキップ",
      "  --skip-db-create       ローカル DB / role 作成をスキップ",
      "  --db-push              npm run db:generate && npm run db:push を実行",
      "  --skip-db-push         Prisma schema 反映をスキップ",
      "  --mock-integrations    初回検証用に mock フラグを .env に追加",
      "  --skip-link-cli        `addroid` コマンドの checkout link をスキップ",
      "  --force                初期化済み検出を無視してセットアップ確認を再実行",
      "  --reauth-meta          既存 Meta token があっても `addroid auth meta` を実行",
      "  --reauth-github        既存 GitHub token / ops repo があっても `addroid auth github` を実行",
      "  --reauth-llm           既存 LLM credential があっても provider 選択から再認証",
      "  --no-chat              セットアップ完了後に `addroid chat` を自動起動しない",
      "",
      "Interactive setup:",
      "  実際の Meta 広告アカウントを利用するには Meta Access Token が必須です。",
      "  標準設定では OAuth callback を使わず、token 入力後に取得可能な Ad Account を表示します。",
      "  `addroid auth meta` で token を暗号化保存し、Ad Account を選択します。",
      "  OAuth callback を使う上級者向け経路は `addroid auth meta --oauth` です。",
      "  LLM Provider は openai-api-key / anthropic-api-key / codex-oauth から選択できます。",
      "  API key / Codex OAuth token は `addroid auth llm` 経由で ENCRYPTION_KEY により暗号化保存されます。",
      "",
    ].join("\n")
  );
}
