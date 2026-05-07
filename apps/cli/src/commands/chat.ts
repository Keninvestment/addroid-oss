// `addroid chat` — local CLI chat shell backed by the configured LLM provider.
//
// init で保存済みの Codex OAuth / OpenAI / Anthropic credential を使い、自然文を
// allowlist 済みの addroid コマンド列へ変換して実行する。任意 shell は実行しない。

import readline from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { resolveWebBinding } from "@addroid/config";
import type {
  LLMCompletionRequest,
  LLMProvider,
} from "@addroid/llm-provider";
import { runDoctor } from "./doctor.js";
import { runStatus } from "./status.js";
import { runAccountsCommand } from "./accounts.js";
import { runAuthCommand } from "./auth.js";
import { runCronCommand } from "./cron.js";
import { runLogs } from "./logs.js";
import { runDown } from "./down.js";
import { runValidate } from "./validate.js";
import { runPlan } from "./plan.js";
import { runActivateCommand } from "./activate.js";
import { runBackupCommand } from "./backup.js";

type ChatCommandName =
  | "doctor"
  | "status"
  | "accounts"
  | "auth"
  | "cron"
  | "logs"
  | "down"
  | "validate"
  | "plan"
  | "activate"
  | "backup";

interface ChatCommandPlan {
  command: ChatCommandName;
  args?: string[];
  why?: string;
}

interface ChatPlan {
  type: "answer" | "commands";
  message?: string;
  summary?: string;
  commands?: ChatCommandPlan[];
}

interface ParsedChatArgs {
  help: boolean;
  once?: string;
  yes: boolean;
  model?: string;
}

export interface ChatCommandOverrides {
  provider?: LLMProvider;
  runCommand?: (command: ChatCommandName, args: string[]) => Promise<number>;
  confirm?: (question: string) => Promise<boolean>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

const SAFE_COMMANDS = new Set<ChatCommandName>([
  "doctor",
  "status",
  "accounts",
  "logs",
  "validate",
  "plan",
]);

const ALLOWED_COMMANDS = new Set<ChatCommandName>([
  ...SAFE_COMMANDS,
  "auth",
  "cron",
  "down",
  "activate",
  "backup",
]);

const ADDROID_BOT = [
  "      .-.",
  "     (o o)",
  "  .--| - |--.",
  " /  _|___|_  \\",
  " \\_/  |_|  \\_/",
];

export async function runChatCommand(
  args: string[],
  overrides: ChatCommandOverrides = {}
): Promise<number> {
  let parsed: ParsedChatArgs;
  try {
    parsed = parseChatArgs(args);
  } catch (err) {
    const out = overrides.output ?? defaultStdout;
    out.write(`[addroid chat] ${(err as Error).message}\n`);
    printChatHelp(out);
    return 2;
  }
  if (parsed.help) {
    printChatHelp(overrides.output ?? defaultStdout);
    return 0;
  }

  const out = overrides.output ?? defaultStdout;
  const env = overrides.env ?? process.env;
  const providerResult = await resolveChatProvider(overrides, env);
  if (!providerResult.ok) {
    out.write(`${providerResult.message}\n`);
    return 2;
  }

  if (parsed.once) {
    try {
      return await handleChatInput(parsed.once, {
        provider: providerResult.provider,
        out,
        yes: parsed.yes,
        model: parsed.model,
        runCommand: overrides.runCommand ?? defaultRunChatCommand,
        confirm: overrides.confirm,
      });
    } finally {
      await providerResult.close?.();
    }
  }

  printSplash(out, providerResult, env);
  const rl = readline.createInterface({
    input: overrides.input ?? defaultStdin,
    output: out,
  });
  try {
    while (true) {
      const input = (await rl.question("addroid> ")).trim();
      if (!input) continue;
      if (isExitInput(input)) {
        out.write("bye\n");
        return 0;
      }
      if (input === "/help") {
        printChatHelp(out);
        continue;
      }
      const code = await handleChatInput(input, {
        provider: providerResult.provider,
        out,
        yes: parsed.yes,
        model: parsed.model,
        runCommand: overrides.runCommand ?? defaultRunChatCommand,
        confirm: overrides.confirm ?? ((q) => confirmOnTty(q, rl)),
      });
      if (code !== 0) out.write(`command exited with ${code}\n`);
    }
  } finally {
    rl.close();
    await providerResult.close?.();
  }
}

async function handleChatInput(
  input: string,
  opts: {
    provider: LLMProvider;
    out: NodeJS.WritableStream;
    yes: boolean;
    model?: string;
    runCommand: (command: ChatCommandName, args: string[]) => Promise<number>;
    confirm?: (question: string) => Promise<boolean>;
  }
): Promise<number> {
  const plan = await buildPlanWithLlm(input, opts.provider, opts.model).catch((err) => ({
    type: "answer" as const,
    message: `LLM による解釈に失敗しました: ${(err as Error).message}`,
  }));
  if (plan.type === "answer") {
    opts.out.write(`${plan.message ?? "実行できる操作として解釈できませんでした。"}\n`);
    return 0;
  }
  const commands = sanitizePlan(plan);
  if (commands.length === 0) {
    opts.out.write("実行可能な addroid コマンドに変換できませんでした。\n");
    return 0;
  }
  if (plan.summary) opts.out.write(`${plan.summary}\n`);
  for (const c of commands) {
    const rendered = `addroid ${c.command}${c.args.length ? ` ${c.args.join(" ")}` : ""}`;
    opts.out.write(`> ${rendered}${c.why ? `  # ${c.why}` : ""}\n`);
    if (!opts.yes && requiresConfirmation(c)) {
      const ok = opts.confirm ? await opts.confirm(`実行しますか? ${rendered}`) : false;
      if (!ok) {
        opts.out.write("skipped\n");
        continue;
      }
    }
    const code = await opts.runCommand(c.command, c.args);
    if (code !== 0) return code;
  }
  return 0;
}

async function buildPlanWithLlm(
  input: string,
  provider: LLMProvider,
  model?: string
): Promise<ChatPlan> {
  const req: LLMCompletionRequest = {
    ...(model ? { model } : {}),
    temperature: 0,
    maxOutputTokens: 900,
    purpose: "cli:chat",
    messages: [
      {
        role: "system",
        content: CHAT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: input,
      },
    ],
  };
  const res = await provider.complete(req);
  return parsePlan(res.content);
}

const CHAT_SYSTEM_PROMPT = [
  "You are AdDroid CLI chat planner. Return ONLY strict JSON.",
  "Never execute shell. Never include secrets. Do not invent unsupported commands.",
  "Allowed command names: doctor, status, accounts, auth, cron, logs, down, validate, plan, activate, backup.",
  "Schema for command execution:",
  '{"type":"commands","summary":"short Japanese summary","commands":[{"command":"cron","args":["run","daily_report"],"why":"short reason"}]}',
  "Schema for answer only:",
  '{"type":"answer","message":"Japanese answer"}',
  "Important mappings:",
  "- レポート取得 / daily report => cron run daily_report",
  "- 予算チェック / budget guard => cron run budget_guard",
  "- 改善案 / PR 作成 / improvement => cron run improvement_pr",
  "- 状態確認 => status",
  "- 診断 => doctor",
  "- GitHub 認証 / ops repo 作成 => auth github",
  "- Meta 接続 => auth meta",
  "- LLM 再認証 => auth llm --provider codex",
  "- 入稿前確認 / dry run / シミュレーション => validate then plan --dry-run",
  "- 実際の入稿は GitHub PR merge 後に worker が Apply する。直接 Meta mutation を要求されたら answer でこの境界を説明する。",
  "- restore and arbitrary shell commands are unsupported; answer with a safe manual instruction.",
].join("\n");

function parsePlan(content: string): ChatPlan {
  const trimmed = content.trim();
  const jsonText = trimmed.startsWith("{") ? trimmed : extractFirstJsonObject(trimmed);
  const parsed = JSON.parse(jsonText) as ChatPlan;
  if (parsed.type !== "answer" && parsed.type !== "commands") {
    throw new Error("LLM response did not contain a supported plan type");
  }
  return parsed;
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM response did not contain JSON");
  return text.slice(start, end + 1);
}

function sanitizePlan(plan: ChatPlan): Array<Required<ChatCommandPlan>> {
  const out: Array<Required<ChatCommandPlan>> = [];
  for (const raw of plan.commands ?? []) {
    if (!ALLOWED_COMMANDS.has(raw.command)) continue;
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const normalized = normalizeCommand(raw.command, args);
    if (!normalized) continue;
    out.push({
      command: normalized.command,
      args: normalized.args,
      why: raw.why ?? "",
    });
  }
  return out;
}

function normalizeCommand(
  command: ChatCommandName,
  args: string[]
): { command: ChatCommandName; args: string[] } | null {
  if (args.some((a) => /[;&|`$<>]/.test(a))) return null;
  if (command === "plan" && !args.includes("--dry-run")) {
    return { command, args: [...args, "--dry-run"] };
  }
  if (command === "cron") {
    const sub = args[0];
    const preset = args[1];
    const okSub = ["list", "run", "enable", "disable", "logs"].includes(sub ?? "");
    const okPreset =
      !preset || ["github_poll", "daily_report", "budget_guard", "improvement_pr", "retention_sweep"].includes(preset);
    return okSub && okPreset ? { command, args } : null;
  }
  if (command === "auth") {
    const provider = args[0];
    return provider && ["meta", "github", "llm", "slack"].includes(provider)
      ? { command, args }
      : null;
  }
  if (command === "accounts") {
    const sub = args[0];
    return !sub || ["list", "select", "sync", "default"].includes(sub)
      ? { command, args }
      : null;
  }
  if (command === "activate") return args.length > 0 ? { command, args } : null;
  if (command === "backup") return args.length === 0 || args[0] === "--json" ? { command, args } : null;
  if (["doctor", "status", "logs", "down", "validate"].includes(command)) return { command, args };
  return SAFE_COMMANDS.has(command) ? { command, args } : null;
}

function requiresConfirmation(c: Required<ChatCommandPlan>): boolean {
  if (!SAFE_COMMANDS.has(c.command)) return true;
  if (c.command === "cron" && c.args[0] !== "list" && c.args[0] !== "logs") return true;
  if (c.command === "plan" || c.command === "validate" || c.command === "status" || c.command === "doctor") return false;
  return false;
}

async function defaultRunChatCommand(command: ChatCommandName, args: string[]): Promise<number> {
  switch (command) {
    case "doctor":
      return runDoctor(args);
    case "status":
      return runStatus(args);
    case "accounts":
      return runAccountsCommand(args);
    case "auth":
      return runAuthCommand(args);
    case "cron":
      return runCronCommand(args);
    case "logs":
      return runLogs(args);
    case "down":
      return runDown(args);
    case "validate":
      return runValidate(args);
    case "plan":
      return runPlan(args);
    case "activate":
      return runActivateCommand(args);
    case "backup":
      return runBackupCommand(args);
  }
}

async function resolveChatProvider(
  overrides: ChatCommandOverrides,
  env: NodeJS.ProcessEnv
): Promise<
  | { ok: true; provider: LLMProvider; choice: string; reason: string; close?: () => Promise<void> }
  | { ok: false; message: string }
> {
  if (overrides.provider) {
    return { ok: true, provider: overrides.provider, choice: overrides.provider.name, reason: "injected" };
  }
  if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) {
    return {
      ok: false,
      message:
        "[addroid chat] DATABASE_URL / ENCRYPTION_KEY が未設定です。先に `addroid init` を完了してください。",
    };
  }
  const [{ prisma }, { selectLLMProviderForWorker }] = await Promise.all([
    import("@addroid/db"),
    import("../../../worker/src/lib/llm-runtime.js"),
  ]);
  const selection = await selectLLMProviderForWorker(env, { prisma });
  const connection = await selection.provider.getConnection().catch(() => null);
  if (!connection && selection.choice !== "mock") {
    await prisma.$disconnect().catch(() => undefined);
    return {
      ok: false,
      message:
        "[addroid chat] LLM credential が見つかりません。`addroid auth llm --provider codex` などで接続してください。",
    };
  }
  return {
    ok: true,
    provider: selection.provider,
    choice: selection.choice,
    reason: selection.reason,
    close: () => prisma.$disconnect().catch(() => undefined),
  };
}

function printSplash(
  out: NodeJS.WritableStream,
  provider: { choice: string; reason: string },
  env: NodeJS.ProcessEnv
): void {
  const binding = resolveWebBinding(env);
  const webUrl = `http://${binding.hostname}:${binding.port}`;
  out.write("\n");
  for (const line of ADDROID_BOT) out.write(`${line}\n`);
  out.write("\n");
  out.write("  AdDroid Chat\n");
  out.write(`  Web UI: ${webUrl}\n`);
  out.write(`  LLM   : ${provider.choice}\n`);
  out.write("\n");
  out.write('  Try "日次レポートを取得", "入稿前チェック", "GitHubを接続", or /help\n');
  out.write("  /exit で終了\n\n");
}

function printChatHelp(out: NodeJS.WritableStream): void {
  out.write(
    [
      "addroid chat — LLM-backed local command chat",
      "",
      "Usage:",
      "  addroid chat",
      "  addroid chat --once \"日次レポートを取得\" [--yes]",
      "",
      "Examples:",
      "  日次レポートを取得",
      "  入稿前チェックをして",
      "  GitHub を接続して ops repo を作って",
      "  LLM を Codex OAuth で再認証して",
      "",
      "Notes:",
      "  - init で保存済みの Codex OAuth / OpenAI / Anthropic credential を使います。",
      "  - 実行先は allowlist 済み addroid コマンドだけです。任意 shell は実行しません。",
      "  - cron run / auth / activate / backup など副作用のある操作は確認します。",
      "",
    ].join("\n")
  );
}

function parseChatArgs(args: string[]): ParsedChatArgs {
  const parsed: ParsedChatArgs = { help: false, yes: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") parsed.help = true;
    else if (a === "--yes" || a === "-y") parsed.yes = true;
    else if (a === "--once") {
      const next = args[++i];
      if (!next) throw new Error("--once requires a value");
      parsed.once = next;
    } else if (a.startsWith("--once=")) {
      parsed.once = a.slice("--once=".length);
    } else if (a === "--model") {
      const next = args[++i];
      if (!next) throw new Error("--model requires a value");
      parsed.model = next;
    } else if (a.startsWith("--model=")) {
      parsed.model = a.slice("--model=".length);
    } else if (!a.startsWith("--") && !parsed.once) {
      parsed.once = [a, ...args.slice(i + 1)].join(" ");
      break;
    } else {
      throw new Error(`unknown option: ${a}`);
    }
  }
  return parsed;
}

function isExitInput(input: string): boolean {
  return ["/exit", "/quit", "exit", "quit", "終了"].includes(input.trim().toLowerCase());
}

async function confirmOnTty(question: string, rl: readline.Interface): Promise<boolean> {
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
