// `addroid chat` — local CLI chat shell backed by the configured LLM provider.
//
// init で接続済みの Codex app-server / OpenAI / Anthropic credential を使い、
// AdDroid 専用の tool agent として自然文の操作を実行する。任意 shell は実行しない。

import readline from "node:readline/promises";
import * as readlineControl from "node:readline";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { resolveWebBinding } from "@addroid/config";
import type {
  LLMCompletionRequest,
  LLMProvider,
} from "@addroid/llm-provider";
import {
  buildAgentContext,
  runAgentTurn,
  type AgentContext,
} from "@addroid/agent-runtime";
import { runDoctor } from "./doctor.js";
import { runStatus } from "./status.js";
import { runLogs } from "./logs.js";
import { runDown } from "./down.js";
import { runActivateCommand } from "./activate.js";
import { runBackupCommand } from "./backup.js";
import {
  runAccountCommand,
  runConnectCommand,
  runReportCommand,
  runScheduleCommand,
  runSubmitCommand,
} from "./public.js";
import { ensureWebUiStarted } from "../lib/web-service.js";

type ChatCommandName =
  | "doctor"
  | "status"
  | "account"
  | "connect"
  | "schedule"
  | "report"
  | "submit"
  | "logs"
  | "stop"
  | "activate"
  | "backup";

type ChatToolName =
  | "diagnose"
  | "check_status"
  | "list_ad_accounts"
  | "sync_ad_accounts"
  | "select_ad_account"
  | "connect_service"
  | "get_report"
  | "check_submission"
  | "manage_schedule"
  | "show_logs"
  | "stop_services"
  | "start_delivery"
  | "backup_data"
  | "open_web_ui";

interface ChatToolCall {
  name: string;
  args?: Record<string, unknown>;
  why?: string;
}

interface ChatAgentResponse {
  message?: string;
  tools?: ChatToolCall[];
}

interface ChatCommandPlan {
  command: ChatCommandName;
  args?: string[];
  why?: string;
}

interface LegacyChatPlan {
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
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  agentContext?: AgentContext;
}

interface ResolvedTool {
  tool: ChatToolName;
  command: ChatCommandName | null;
  args: string[];
  display: string;
  why: string;
}

const ADDROID_BOT = [
  "          o",
  "          |",
  "      .---+---.",
  "  .---'       '---.",
  ".-'  [OO]   [OO]  '-.",
  "|        ___        |",
  "'-.   .-------.   .-'",
  "  '--'         '--'",
];

const SLASH_COMMANDS = [
  { command: "/help", description: "使い方と例を表示" },
  { command: "/status", description: "接続・起動状態を確認" },
  { command: "/report", description: "日次レポートを取得" },
  { command: "/submit", description: "入稿前チェックを実行" },
  { command: "/connect", description: "Meta / GitHub / AI / Slack を接続" },
  { command: "/account", description: "広告アカウントを確認・選択" },
  { command: "/schedule", description: "自動実行を確認・変更" },
  { command: "/open", description: "Web UI の URL を表示" },
  { command: "/stop", description: "Web UI と worker を停止" },
  { command: "/exit", description: "チャットを終了" },
] as const;

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
  const [providerResult, agentContext] = await Promise.all([
    resolveChatProvider(overrides, env),
    overrides.agentContext ? Promise.resolve(overrides.agentContext) : buildAgentContext(env),
  ]);
  if (!providerResult.ok) {
    out.write(`${providerResult.message}\n`);
    return 2;
  }

  if (parsed.once) {
    try {
      return await handleChatInput(parsed.once, {
        provider: providerResult.provider,
        out,
        model: parsed.model,
        runCommand: overrides.runCommand ?? defaultRunChatCommand,
        agentContext,
      });
    } finally {
      await providerResult.close?.();
    }
  }

  const web = await ensureWebUiStarted({ env });
  if (!web.running) {
    out.write(
      [
        `[addroid chat] Web UI を自動起動できませんでした: ${web.error ?? "unknown"}`,
        `  URL : ${web.url}`,
        `  log : ${web.logFile}`,
        "  `addroid status` と `addroid logs up` を確認してください。",
        "",
      ].join("\n")
    );
  }
  printSplash(out, providerResult, env);
  const inputStream = overrides.input ?? defaultStdin;
  const rl = shouldUseRichPrompt(inputStream, out)
    ? null
    : readline.createInterface({
        input: inputStream,
        output: out,
      });
  try {
    while (true) {
      const input = (
        rl
          ? await rl.question("addroid> ")
          : await readChatLine(inputStream, out)
      ).trim();
      if (!input) continue;
      if (isExitInput(input)) {
        out.write("bye\n");
        return 0;
      }
      if (input.startsWith("/")) {
        const slash = await handleSlashCommand(input, {
          out,
          runCommand: overrides.runCommand ?? defaultRunChatCommand,
          agentContext,
        });
        if (slash.exit) return slash.code;
        if (slash.handled) {
          if (slash.code !== 0) out.write(`tool exited with ${slash.code}\n`);
          continue;
        }
        out.write(`unknown slash command: ${input}\n`);
        continue;
      }
      const code = await handleChatInput(input, {
        provider: providerResult.provider,
        out,
        model: parsed.model,
        runCommand: overrides.runCommand ?? defaultRunChatCommand,
        agentContext,
      });
      if (code !== 0) out.write(`tool exited with ${code}\n`);
    }
  } finally {
    rl?.close();
    await providerResult.close?.();
  }
}

async function handleSlashCommand(
  input: string,
  opts: {
    out: NodeJS.WritableStream;
    runCommand: (command: ChatCommandName, args: string[]) => Promise<number>;
    agentContext: AgentContext;
  }
): Promise<{ handled: boolean; exit: boolean; code: number }> {
  const [command = "", ...args] = input.trim().split(/\s+/);
  switch (command) {
    case "/help":
      printChatHelp(opts.out);
      return { handled: true, exit: false, code: 0 };
    case "/exit":
    case "/quit":
      opts.out.write("bye\n");
      return { handled: true, exit: true, code: 0 };
    case "/status":
      return { handled: true, exit: false, code: await opts.runCommand("status", args) };
    case "/report":
      return { handled: true, exit: false, code: await opts.runCommand("report", args) };
    case "/submit":
      return { handled: true, exit: false, code: await opts.runCommand("submit", args) };
    case "/connect":
      return { handled: true, exit: false, code: await opts.runCommand("connect", args) };
    case "/account":
      return { handled: true, exit: false, code: await opts.runCommand("account", args) };
    case "/schedule":
      return { handled: true, exit: false, code: await opts.runCommand("schedule", args) };
    case "/open":
      opts.out.write(`${opts.agentContext.webUrl}\n`);
      return { handled: true, exit: false, code: 0 };
    case "/stop":
      return { handled: true, exit: false, code: await opts.runCommand("stop", args) };
    default:
      return { handled: false, exit: false, code: 0 };
  }
}

async function handleChatInput(
  input: string,
  opts: {
    provider: LLMProvider;
    out: NodeJS.WritableStream;
    model?: string;
    runCommand: (command: ChatCommandName, args: string[]) => Promise<number>;
    agentContext: AgentContext;
  }
): Promise<number> {
  const response = await runAgentTurn({
    input,
    provider: opts.provider,
    agentContext: opts.agentContext,
    model: opts.model,
    purpose: "cli:chat-agent",
  });
  if (response.message) opts.out.write(`${response.message}\n`);
  if (response.toolResults.length === 0) return 0;
  let lastCode = 0;
  for (const tool of response.toolResults) {
    if (tool.status === "denied") {
      opts.out.write(`denied: ${tool.toolName} (${tool.reason})\n`);
      continue;
    }
    if (tool.status === "unsupported") {
      opts.out.write(`unsupported tool: ${tool.toolName} (${tool.reason})\n`);
      continue;
    }
    opts.out.write(`> ${tool.display}${tool.why ? `  # ${tool.why}` : ""}\n`);
    if (tool.command === null) {
      opts.out.write(`${opts.agentContext.webUrl}\n`);
      continue;
    }
    const code = await opts.runCommand(tool.command as ChatCommandName, tool.args);
    if (code !== 0) {
      lastCode = code;
      break;
    }
  }
  return lastCode;
}

function safeResolveTool(
  tool: Required<ChatToolCall>,
  out: NodeJS.WritableStream
): ResolvedTool | null {
  try {
    const resolved = resolveTool(tool);
    if (!resolved) out.write(`unsupported tool: ${tool.name}\n`);
    return resolved;
  } catch (err) {
    out.write(`invalid tool: ${tool.name} (${(err as Error).message})\n`);
    return null;
  }
}

async function buildAgentResponseWithLlm(
  input: string,
  provider: LLMProvider,
  agentContext: AgentContext,
  model?: string
): Promise<ChatAgentResponse> {
  const req: LLMCompletionRequest = {
    ...(model ? { model } : {}),
    temperature: 0.2,
    maxOutputTokens: 1_500,
    purpose: "cli:chat-agent",
    messages: [
      {
        role: "system",
        content: buildChatSystemPrompt(agentContext),
      },
      {
        role: "user",
        content: input,
      },
    ],
  };
  const res = await provider.complete(req);
  return parseAgentResponse(res.content);
}

function buildChatSystemPrompt(agentContext: AgentContext): string {
  return [
    "You are AdDroid CLI chat agent.",
    "Respond in Japanese. Be concise and operational.",
    "You may answer normally when no tool is needed.",
    "When an AdDroid operation should run, return ONLY strict JSON with this schema:",
    '{"message":"short Japanese message","tools":[{"name":"get_report","args":{"kind":"daily"},"why":"short reason"}]}',
    "Do not wrap JSON in markdown.",
    "Available tool names:",
    "- diagnose: args {}",
    "- check_status: args {}",
    "- list_ad_accounts: args {json?: boolean}",
    "- sync_ad_accounts: args {selectDefault?: boolean,json?: boolean}",
    "- select_ad_account: args {adAccountId?: string,key?: string,json?: boolean}",
    "- connect_service: args {service:'meta'|'github'|'ai'|'slack', aiProvider?:'codex'|'openai'|'anthropic'}",
    "- get_report: args {kind?:'daily'|'budget'|'improvement'}",
    "- check_submission: args {root?: string,base?: string,account?: string,save?: boolean}",
    "- manage_schedule: args {action:'list'|'enable'|'disable'|'run'|'logs'|'set', preset?:'daily'|'budget'|'improvement'|'github'|'retention', cron?: string, limit?: number}",
    "- show_logs: args {target?:'up'|'web'|'worker'|'all', lines?: number}",
    "- stop_services: args {}",
    "- start_delivery: args {hierarchyId:string,note?:string,json?:boolean}",
    "- backup_data: args {}",
    "- open_web_ui: args {}",
    "Never request arbitrary shell, restore, destructive git, direct DB writes, direct Meta mutation outside audited paths, or secret display.",
    "Actual ad submission must go through ops repo validation, dry-run plan, GitHub PR review/merge, and worker apply.",
    "Agent context:",
    agentContext.content,
  ].join("\n");
}

function parseAgentResponse(content: string): ChatAgentResponse {
  const trimmed = content.trim();
  const jsonText = tryExtractJsonObject(trimmed);
  if (!jsonText) return { message: trimmed, tools: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return { message: trimmed, tools: [] };
  }
  if (isLegacyPlan(parsed)) return legacyPlanToAgentResponse(parsed);
  if (!isRecord(parsed)) return { message: trimmed, tools: [] };
  const message = typeof parsed.message === "string" ? parsed.message : "";
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.flatMap((t) => (isRecord(t) ? [toolFromRecord(t)] : []))
    : [];
  return { message, tools };
}

function tryExtractJsonObject(text: string): string | null {
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function isLegacyPlan(value: unknown): value is LegacyChatPlan {
  if (!isRecord(value)) return false;
  return value.type === "answer" || value.type === "commands";
}

function legacyPlanToAgentResponse(plan: LegacyChatPlan): ChatAgentResponse {
  if (plan.type === "answer") return { message: plan.message ?? "", tools: [] };
  return {
    message: plan.summary ?? "",
    tools: (plan.commands ?? []).map((c) => ({
      name: `legacy:${c.command}`,
      args: {
        args: Array.isArray(c.args) ? c.args : [],
      },
      why: c.why ?? "",
    })),
  };
}

function toolFromRecord(record: Record<string, unknown>): ChatToolCall {
  const args = isRecord(record.args) ? record.args : {};
  return {
    name: String(record.name ?? ""),
    args,
    why: typeof record.why === "string" ? record.why : "",
  };
}

function normalizeToolCall(tool: ChatToolCall): Required<ChatToolCall> {
  return {
    name: tool.name.trim(),
    args: sanitizeToolArgs(tool.args ?? {}),
    why: tool.why ?? "",
  };
}

function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = value.trim();
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map((v) => String(v));
  }
  return out;
}

function resolveTool(tool: Required<ChatToolCall>): ResolvedTool | null {
  if (tool.name.startsWith("legacy:")) {
    return resolveLegacyCommand(tool);
  }
  const name = normalizeToolName(tool.name);
  switch (name) {
    case "diagnose":
      return commandTool(name, "doctor", [], tool.why);
    case "check_status":
      return commandTool(name, "status", [], tool.why);
    case "list_ad_accounts":
      return commandTool(name, "account", boolArgs([], tool.args, ["json"]), tool.why);
    case "sync_ad_accounts":
      return commandTool(
        name,
        "account",
        boolArgs(["sync"], tool.args, ["selectDefault", "json"], {
          selectDefault: "--select-default",
        }),
        tool.why
      );
    case "select_ad_account":
      return commandTool(name, "account", buildSelectAccountArgs(tool.args), tool.why);
    case "connect_service":
      return commandTool(name, "connect", buildConnectArgs(tool.args), tool.why);
    case "get_report":
      return commandTool(name, "report", buildReportArgs(tool.args), tool.why);
    case "check_submission":
      return commandTool(name, "submit", buildSubmitArgs(tool.args), tool.why);
    case "manage_schedule":
      return commandTool(name, "schedule", buildScheduleArgs(tool.args), tool.why);
    case "show_logs":
      return commandTool(name, "logs", buildLogsArgs(tool.args), tool.why);
    case "stop_services":
      return commandTool(name, "stop", [], tool.why);
    case "start_delivery":
      return commandTool(name, "activate", buildActivateArgs(tool.args), tool.why);
    case "backup_data":
      return commandTool(name, "backup", [], tool.why);
    case "open_web_ui":
      return {
        tool: name,
        command: null,
        args: [],
        display: "open Web UI",
        why: tool.why,
      };
    default:
      return null;
  }
}

function resolveLegacyCommand(tool: Required<ChatToolCall>): ResolvedTool | null {
  const command = tool.name.slice("legacy:".length) as ChatCommandName;
  const args = Array.isArray(tool.args.args) ? tool.args.args.map(String) : [];
  const normalized = normalizeLegacyCommand(command, args);
  if (!normalized) return null;
  return commandTool(tool.name as ChatToolName, normalized.command, normalized.args, tool.why);
}

function normalizeLegacyCommand(
  command: ChatCommandName,
  args: string[]
): { command: ChatCommandName; args: string[] } | null {
  if (args.some(hasUnsafeShellChars)) return null;
  if (command === "activate") return args.length > 0 ? { command, args } : null;
  if (command === "backup") return args.length === 0 ? { command, args } : null;
  if (["doctor", "status", "logs", "stop", "submit", "schedule", "connect", "account", "report"].includes(command)) {
    return { command, args };
  }
  return null;
}

function commandTool(
  tool: ChatToolName,
  command: ChatCommandName,
  args: string[],
  why: string
): ResolvedTool {
  if (args.some(hasUnsafeShellChars)) {
    throw new Error(`unsafe characters in ${tool} args`);
  }
  return {
    tool,
    command,
    args,
    display: `addroid ${command}${args.length ? ` ${args.join(" ")}` : ""}`,
    why,
  };
}

function buildSelectAccountArgs(args: Record<string, unknown>): string[] {
  const out = boolArgs(["choose", "--yes"], args, ["json"]);
  pushOptionalString(out, "--ad-account-id", args, "adAccountId");
  pushOptionalString(out, "--key", args, "key");
  return out;
}

function buildConnectArgs(args: Record<string, unknown>): string[] {
  const service = requireEnum(args, "service", ["meta", "github", "ai", "slack"]);
  const out: string[] = [service];
  if (service === "ai") {
    const aiProvider = optionalEnum(args, "aiProvider", ["codex", "openai", "anthropic"]);
    if (aiProvider) out.push("--provider", aiProvider);
  }
  return out;
}

function buildReportArgs(args: Record<string, unknown>): string[] {
  const kind = optionalEnum(args, "kind", ["daily", "budget", "improvement"]);
  return kind ? [kind] : [];
}

function buildSubmitArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  pushOptionalString(out, "--root", args, "root");
  pushOptionalString(out, "--base", args, "base");
  pushOptionalString(out, "--account", args, "account");
  if (args.save === true) out.push("--save");
  return out;
}

function buildScheduleArgs(args: Record<string, unknown>): string[] {
  const action = requireEnum(args, "action", ["list", "enable", "disable", "run", "logs", "set"]);
  const out: string[] = [action];
  if (action !== "list") {
    out.push(requireEnum(args, "preset", ["daily", "budget", "improvement", "github", "retention"]));
  }
  if (action === "set") out.push(requireString(args, "cron"));
  const limit = optionalPositiveInt(args, "limit");
  if (limit !== null) out.push("--limit", String(limit));
  return out;
}

function buildLogsArgs(args: Record<string, unknown>): string[] {
  const target = optionalEnum(args, "target", ["up", "web", "worker", "all"]);
  const out: string[] = target ? [target] : [];
  const lines = optionalPositiveInt(args, "lines");
  if (lines !== null) out.push("--lines", String(lines));
  return out;
}

function buildActivateArgs(args: Record<string, unknown>): string[] {
  const out = [requireString(args, "hierarchyId")];
  pushOptionalString(out, "--note", args, "note");
  if (args.json === true) out.push("--json");
  return out;
}

function boolArgs(
  base: string[],
  args: Record<string, unknown>,
  keys: string[],
  aliases: Record<string, string> = {}
): string[] {
  const out = [...base];
  for (const key of keys) {
    if (args[key] === true) out.push(aliases[key] ?? `--${kebab(key)}`);
  }
  return out;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: T[]
): T {
  const value = requireString(args, key);
  if (!values.includes(value as T)) {
    throw new Error(`${key} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: T[]
): T | null {
  const value = args[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function optionalPositiveInt(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return Math.floor(n);
}

function pushOptionalString(
  out: string[],
  flag: string,
  args: Record<string, unknown>,
  key: string
): void {
  const value = args[key];
  if (typeof value === "string" && value.trim() !== "") {
    out.push(flag, value.trim());
  }
}

function hasUnsafeShellChars(value: string): boolean {
  return /[;&|`$<>]/.test(value);
}

function normalizeToolName(value: string): ChatToolName {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_") as ChatToolName;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultRunChatCommand(command: ChatCommandName, args: string[]): Promise<number> {
  try {
    switch (command) {
      case "doctor":
        return runDoctor(args);
      case "status":
        return runStatus(args);
      case "account":
        return runAccountCommand(args);
      case "connect":
        return runConnectCommand(args);
      case "schedule":
        return runScheduleCommand(args);
      case "report":
        return runReportCommand(args);
      case "submit":
        return runSubmitCommand(args);
      case "logs":
        return runLogs(args);
      case "stop":
        return runDown(args);
      case "activate":
        return runActivateCommand(args);
      case "backup":
        return runBackupCommand(args);
    }
  } catch (err) {
    process.stderr.write(`[addroid chat] tool failed: ${(err as Error).message}\n`);
    return 1;
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
        "[addroid chat] LLM credential が見つかりません。`addroid connect ai` で provider を選択して接続してください。",
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
  const width = terminalWidth(out);
  const title = "AdDroid";
  const subtitle = "Local AI operator for Meta ads";
  out.write("\n");
  out.write(color("╭" + "─".repeat(width - 2) + "╮\n", "frame", out));
  out.write(color(`│ ${padRight("◉  AdDroid Chat", width - 4)} │\n`, "frame", out));
  out.write(color("├" + "─".repeat(width - 2) + "┤\n", "frame", out));
  const botWidth = Math.max(...ADDROID_BOT.map(visibleLength));
  for (let i = 0; i < ADDROID_BOT.length; i += 1) {
    const bot = color(padRight(ADDROID_BOT[i] ?? "", botWidth), "robot", out);
    const text =
      i === 1
        ? color(title, "brand", out)
      : i === 2
          ? color(subtitle, "muted", out)
          : i === 4
            ? `Web UI  ${color(webUrl, "link", out)}`
            : i === 5
              ? `LLM     ${color(provider.choice, "accent", out)}`
              : "";
    out.write(`│  ${bot}  ${padRight(text, width - botWidth - 7)} │\n`);
  }
  out.write(color("├" + "─".repeat(width - 2) + "┤\n", "frame", out));
  out.write(`│ ${padRight('Try "日次レポートを取得", "入稿前チェック", or type /', width - 4)} │\n`);
  out.write(`│ ${padRight("/ でコマンド候補を表示、/exit で終了", width - 4)} │\n`);
  out.write(color("╰" + "─".repeat(width - 2) + "╯\n\n", "frame", out));
}

function shouldUseRichPrompt(
  input: NodeJS.ReadableStream,
  out: NodeJS.WritableStream
): boolean {
  return Boolean(
    (input as NodeJS.ReadStream).isTTY &&
      (out as NodeJS.WriteStream).isTTY &&
      typeof (input as NodeJS.ReadStream).setRawMode === "function"
  );
}

function readChatLine(
  input: NodeJS.ReadableStream,
  out: NodeJS.WritableStream
): Promise<string> {
  const stdin = input as NodeJS.ReadStream;
  const width = terminalWidth(out);
  const inner = width - 4;
  let value = "";
  let selected = 0;
  let renderedLines = 0;

  const slashMatches = () => {
    if (!value.startsWith("/")) return [];
    if (/\s/.test(value)) return [];
    const needle = value.trim().toLowerCase();
    if (needle === "/") return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter((item) => item.command.startsWith(needle));
  };

  const render = () => {
    if (renderedLines > 0) {
      readlineControl.moveCursor(out, 0, -renderedLines);
      readlineControl.cursorTo(out, 0);
      readlineControl.clearScreenDown(out);
    }
    const matches = slashMatches();
    if (selected >= matches.length) selected = Math.max(0, matches.length - 1);
    const lines: string[] = [];
    lines.push(color("╭─ addroid " + "─".repeat(Math.max(0, width - 12)) + "╮", "frame", out));
    const cursor = color("▌", "cursor", out);
    lines.push(color("│", "frame", out) + ` ${padRight(`${color(">", "muted", out)} ${value}${cursor}`, inner)} ` + color("│", "frame", out));
    lines.push(color("╰" + "─".repeat(width - 2) + "╯", "frame", out));
    if (matches.length > 0) {
      lines.push(color("  commands", "muted", out));
      for (let i = 0; i < Math.min(matches.length, 8); i += 1) {
        const item = matches[i]!;
        const marker = i === selected ? color("›", "accent", out) : " ";
        const command = i === selected ? color(item.command, "accent", out) : item.command;
        lines.push(`  ${marker} ${padRight(command, 14)} ${color(item.description, "muted", out)}`);
      }
    }
    out.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      if (renderedLines > 0) {
        readlineControl.moveCursor(out, 0, -renderedLines);
        readlineControl.cursorTo(out, 0);
        readlineControl.clearScreenDown(out);
      }
    };
    const finish = (answer: string) => {
      cleanup();
      out.write(`${color("addroid", "accent", out)} ${answer}\n`);
      resolve(answer);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        finish("/exit");
        return;
      }
      if (text === "\u0004") {
        finish("/exit");
        return;
      }
      if (text === "\r" || text === "\n") {
        const matches = slashMatches();
        if (matches.length > 0 && value.startsWith("/")) {
          finish(matches[selected]?.command ?? value);
        } else {
          finish(value);
        }
        return;
      }
      if (text === "\u001b[A") {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }
      if (text === "\u001b[B") {
        selected = Math.min(Math.max(0, slashMatches().length - 1), selected + 1);
        render();
        return;
      }
      if (text === "\t") {
        const matches = slashMatches();
        if (matches.length > 0) value = matches[selected]?.command ?? value;
        render();
        return;
      }
      if (text === "\u007f" || text === "\b") {
        value = Array.from(value).slice(0, -1).join("");
        selected = 0;
        render();
        return;
      }
      for (const ch of Array.from(text)) {
        if (ch >= " " && ch !== "\u007f") value += ch;
      }
      selected = 0;
      render();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

type ColorRole = "accent" | "brand" | "cursor" | "frame" | "link" | "muted" | "robot";

const ANSI_CODES: Record<ColorRole, string> = {
  accent: "\u001b[38;5;75m",
  brand: "\u001b[1;38;5;69m",
  cursor: "\u001b[1;38;5;81m",
  frame: "\u001b[38;5;60m",
  link: "\u001b[4;38;5;81m",
  muted: "\u001b[38;5;245m",
  robot: "\u001b[1;38;5;69m",
};

function color(text: string, role: ColorRole, out: NodeJS.WritableStream): string {
  if (!useColor(out)) return text;
  return `${ANSI_CODES[role]}${text}\u001b[0m`;
}

function useColor(out: NodeJS.WritableStream): boolean {
  return Boolean((out as NodeJS.WriteStream).isTTY) && !process.env.NO_COLOR;
}

function terminalWidth(out: NodeJS.WritableStream): number {
  const columns = (out as NodeJS.WriteStream).columns || 80;
  return Math.max(columns - 2, 48);
}

function padRight(value: string, width: number): string {
  const visible = visibleLength(value);
  if (visible >= width) return truncateVisible(value, width);
  return value + " ".repeat(width - visible);
}

function visibleLength(value: string): number {
  let width = 0;
  for (const char of Array.from(stripAnsi(value))) width += charWidth(char);
  return width;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function truncateVisible(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (visibleLength(plain) <= width) return value;
  let out = "";
  let used = 0;
  for (const char of Array.from(plain)) {
    const next = charWidth(char);
    if (used + next > Math.max(0, width - 1)) break;
    out += char;
    used += next;
  }
  return `${out}…`;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function printChatHelp(out: NodeJS.WritableStream): void {
  out.write(
    [
      "addroid chat — LLM-backed local agent chat",
      "",
      "Usage:",
      "  addroid chat",
      "  addroid chat --once \"日次レポートを取得\"",
      "",
      "Examples:",
      "  日次レポートを取得",
      "  入稿前チェックをして",
      "  GitHub を接続して ops repo を作って",
      "  AI を Codex app-server で再接続して",
      "  Web UI を開きたい",
      "",
      "Notes:",
      "  - init で接続済みの Codex app-server / OpenAI / Anthropic credential を使います。",
      "  - 入力欄で `/` を押すと利用できるコマンド候補を表示します。",
      "  - `/report`, `/submit`, `/connect github`, `/account`, `/schedule`, `/open`, `/status` を直接実行できます。",
      "  - LLM は AGENTS.md と主要 docs を参照して AdDroid tool を直接実行します。",
      "  - 任意 shell / restore / 破壊的 git / secret 表示 / approval 迂回の Meta 変更は拒否します。",
      "  - --yes は旧バージョン互換のため受け付けますが、chat では確認プロンプトを出しません。",
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
