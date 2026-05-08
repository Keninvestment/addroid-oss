import type { LLMCompletionRequest, LLMProvider } from "@addroid/llm-provider";
import type { AgentContext } from "./context.js";
import {
  evaluateAgentToolPolicy,
  isDeniedAgentRequest,
  type AgentPolicyDecision,
} from "./policy.js";

export type AgentCommandName =
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

export type AgentToolName =
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
  | "open_web_ui"
  | "query_meta_ads";

export interface AgentToolCall {
  name: string;
  args?: Record<string, unknown>;
  why?: string;
}

export interface AgentResponse {
  message: string;
  toolResults: AgentToolResult[];
}

export type AgentToolResult =
  | {
      status: "ready";
      tool: AgentToolName;
      command: AgentCommandName | null;
      args: string[];
      toolArgs: Record<string, unknown>;
      display: string;
      why: string;
    }
  | {
      status: "denied";
      toolName: string;
      reason: string;
    }
  | {
      status: "unsupported";
      toolName: string;
      reason: string;
    };

interface ChatAgentResponse {
  message?: string;
  tools?: AgentToolCall[];
}

interface ChatCommandPlan {
  command: AgentCommandName;
  args?: string[];
  why?: string;
}

interface LegacyChatPlan {
  type: "answer" | "commands";
  message?: string;
  summary?: string;
  commands?: ChatCommandPlan[];
}

export const SLASH_COMMANDS = [
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

export async function runAgentTurn(opts: {
  input: string;
  provider: LLMProvider;
  agentContext: AgentContext;
  model?: string;
  purpose?: string;
}): Promise<AgentResponse> {
  const requestPolicy = isDeniedAgentRequest(opts.input);
  if (!requestPolicy.allowed) {
    return {
      message:
        `その操作は安全ポリシーにより実行できません: ${requestPolicy.reason}\n` +
        "AdDroid では validate / dry-run / GitHub PR / worker apply の経路を使ってください。",
      toolResults: [],
    };
  }

  const response = await buildAgentResponseWithLlm(opts).catch((err) =>
    buildFallbackAgentResponse(opts.input, err)
  );

  const toolResults: AgentToolResult[] = [];
  for (const rawTool of response.tools ?? []) {
    const normalized = normalizeToolCall(rawTool);
    const policy = evaluateAgentToolPolicy(normalized.name, normalized.args);
    if (!policy.allowed) {
      toolResults.push({
        status: "denied",
        toolName: normalized.name,
        reason: policy.reason ?? "policy denied",
      });
      continue;
    }
    const resolved = safeResolveTool(normalized);
    toolResults.push(resolved);
  }

  return {
    message: response.message ?? "",
    toolResults,
  };
}

export { evaluateAgentToolPolicy, isDeniedAgentRequest, type AgentPolicyDecision };

async function buildAgentResponseWithLlm(opts: {
  input: string;
  provider: LLMProvider;
  agentContext: AgentContext;
  model?: string;
  purpose?: string;
}): Promise<ChatAgentResponse> {
  const req: LLMCompletionRequest = {
    ...(opts.model ? { model: opts.model } : {}),
    temperature: 0.2,
    maxOutputTokens: 1_500,
    purpose: opts.purpose ?? "agent:chat",
    messages: [
      {
        role: "system",
        content: buildAgentSystemPrompt(opts.agentContext),
      },
      {
        role: "user",
        content: opts.input,
      },
    ],
  };
  const res = await opts.provider.complete(req);
  return parseAgentResponse(res.content);
}

function buildFallbackAgentResponse(input: string, err: unknown): ChatAgentResponse {
  void input;
  const errorMessage = formatLlmFailure(err);
  return {
    message:
      `LLM による解釈に失敗したため、操作は実行しませんでした: ${errorMessage}\n` +
      "少し待って同じ内容をもう一度送るか、接続状態を確認してください。",
    tools: [],
  };
}

function formatLlmFailure(err: unknown): string {
  const error = err as Error & { status?: number; code?: string };
  const status = typeof error.status === "number" ? ` HTTP ${error.status}` : "";
  const code = typeof error.code === "string" ? ` (${error.code})` : "";
  const message = error.message || String(err);
  return `${message}${status}${code}`;
}

export function buildAgentSystemPrompt(agentContext: AgentContext): string {
  return [
    "You are AdDroid local agent.",
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
    "- get_report: args {kind?:'daily'|'budget'|'improvement', metricDate?:'YYYY-MM-DD'}",
    "- check_submission: args {root?: string,base?: string,account?: string,save?: boolean}",
    "- manage_schedule: args {action:'list'|'enable'|'disable'|'run'|'logs'|'set', preset?:'daily'|'budget'|'improvement'|'github'|'retention', cron?: string, limit?: number}",
    "- show_logs: args {target?:'up'|'web'|'worker'|'all', lines?: number}",
    "- stop_services: args {}",
    "- start_delivery: args {hierarchyId:string,note?:string,json?:boolean}",
    "- backup_data: args {}",
    "- open_web_ui: args {}",
    "- query_meta_ads: read-only Meta Ads CLI query. args {resource:'insights'|'adaccount'|'campaign'|'adset'|'ad'|'creative'|'catalog'|'dataset'|'page'|'product_feed'|'product_item'|'product_set', action?:'get'|'list'|'current', accountKey?:string, businessId?:string, catalogId?:string, since?:'YYYY-MM-DD', until?:'YYYY-MM-DD', datePreset?:'today'|'yesterday'|'last_3d'|'last_7d'|'last_14d'|'last_30d'|'last_90d'|'this_month'|'last_month', timeIncrement?:'daily'|'weekly'|'monthly'|'all_days', breakdowns?:string[], fields?:string[], campaignId?:string, adsetId?:string, adId?:string, id?:string, limit?:number}",
    "Users may also type slash shortcuts such as /status, /report, /submit, /connect, /account, /schedule, and /open. Interpret those as normal user intent and choose the appropriate tool.",
    "Choose tools by user intent and recent chat context. Use get_report for user-facing daily, budget, and improvement reports because it returns the standard AdDroid summary/commentary format. Use metricDate as YYYY-MM-DD when the user asks for a specific or relative report date. Use query_meta_ads for raw read-only Meta Ads inspection, hierarchy lookup, and specific field/object checks.",
    "Meta Ads CLI capability note: supported read path is `meta --output json ads ...`. `insights get` supports --date-preset/--since/--until/--time-increment/--breakdown/--fields/--campaign-id/--adset-id/--ad-id/--sort/--limit. For hierarchy detail, list campaign/adset/ad IDs first, then query insights by the ID filter. Product feed/item/set list requires catalogId. Catalog and dataset list can use businessId.",
    "For performance analysis, request the fields needed for the user's question. For frequency ask for frequency. For CPA/CV/conversion checks request spend plus actions and, when useful, cost_per_action_type/action_values. Do not rely on display text for automation decisions; tool executors keep raw structured rows.",
    "Meta Ads CLI also has mutation commands such as campaign/adset/ad/creative/catalog/product create/update/delete and dataset connect/disconnect/assign-user, but chat must not run those directly. Use check_submission for dry-run review and start_delivery only for the audited activation path.",
    "Never request arbitrary shell, restore, destructive git, direct DB writes, direct Meta mutation outside audited paths, or secret display.",
    "Actual ad submission must go through ops repo validation, dry-run plan, GitHub PR review/merge, and worker apply.",
    "For recurring scheduled tasks, keep flexibility: interpret the saved natural-language task at runtime and choose tools based on current state.",
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

function toolFromRecord(record: Record<string, unknown>): AgentToolCall {
  const args = isRecord(record.args) ? record.args : {};
  return {
    name: String(record.name ?? ""),
    args,
    why: typeof record.why === "string" ? record.why : "",
  };
}

function normalizeToolCall(tool: AgentToolCall): Required<AgentToolCall> {
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

function safeResolveTool(tool: Required<AgentToolCall>): AgentToolResult {
  try {
    const resolved = resolveTool(tool);
    if (!resolved) {
      return {
        status: "unsupported",
        toolName: tool.name,
        reason: "unsupported tool",
      };
    }
    return { status: "ready", ...resolved };
  } catch (err) {
    return {
      status: "unsupported",
      toolName: tool.name,
      reason: (err as Error).message,
    };
  }
}

function resolveTool(
  tool: Required<AgentToolCall>
): Omit<Extract<AgentToolResult, { status: "ready" }>, "status"> | null {
  if (tool.name.startsWith("legacy:")) {
    return resolveLegacyCommand(tool);
  }
  const name = normalizeToolName(tool.name);
  switch (name) {
    case "diagnose":
      return commandTool(name, "doctor", [], tool.args, tool.why);
    case "check_status":
      return commandTool(name, "status", [], tool.args, tool.why);
    case "list_ad_accounts":
      return commandTool(name, "account", boolArgs([], tool.args, ["json"]), tool.args, tool.why);
    case "sync_ad_accounts":
      return commandTool(
        name,
        "account",
        boolArgs(["sync"], tool.args, ["selectDefault", "json"], {
          selectDefault: "--select-default",
        }),
        tool.args,
        tool.why
      );
    case "select_ad_account":
      return commandTool(name, "account", buildSelectAccountArgs(tool.args), tool.args, tool.why);
    case "connect_service":
      return commandTool(name, "connect", buildConnectArgs(tool.args), tool.args, tool.why);
    case "get_report":
      return commandTool(name, "report", buildReportArgs(tool.args), tool.args, tool.why);
    case "check_submission":
      return commandTool(name, "submit", buildSubmitArgs(tool.args), tool.args, tool.why);
    case "manage_schedule":
      return commandTool(name, "schedule", buildScheduleArgs(tool.args), tool.args, tool.why);
    case "show_logs":
      return commandTool(name, "logs", buildLogsArgs(tool.args), tool.args, tool.why);
    case "stop_services":
      return commandTool(name, "stop", [], tool.args, tool.why);
    case "start_delivery":
      return commandTool(name, "activate", buildActivateArgs(tool.args), tool.args, tool.why);
    case "backup_data":
      return commandTool(name, "backup", [], tool.args, tool.why);
    case "open_web_ui":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "open Web UI",
        why: tool.why,
      };
    case "query_meta_ads":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "Meta Ads CLI read-only query",
        why: tool.why,
      };
    default:
      return null;
  }
}

function resolveLegacyCommand(
  tool: Required<AgentToolCall>
): Omit<Extract<AgentToolResult, { status: "ready" }>, "status"> | null {
  const command = tool.name.slice("legacy:".length) as AgentCommandName;
  const args = Array.isArray(tool.args.args) ? tool.args.args.map(String) : [];
  const normalized = normalizeLegacyCommand(command, args);
  if (!normalized) return null;
  return commandTool(tool.name as AgentToolName, normalized.command, normalized.args, tool.args, tool.why);
}

function normalizeLegacyCommand(
  command: AgentCommandName,
  args: string[]
): { command: AgentCommandName; args: string[] } | null {
  if (args.some(hasUnsafeShellChars)) return null;
  if (command === "activate") return args.length > 0 ? { command, args } : null;
  if (command === "backup") return args.length === 0 ? { command, args } : null;
  if (["doctor", "status", "logs", "stop", "submit", "schedule", "connect", "account", "report"].includes(command)) {
    return { command, args };
  }
  return null;
}

function commandTool(
  tool: AgentToolName,
  command: AgentCommandName,
  args: string[],
  toolArgs: Record<string, unknown>,
  why: string
): Omit<Extract<AgentToolResult, { status: "ready" }>, "status"> {
  if (args.some(hasUnsafeShellChars)) {
    throw new Error(`unsafe characters in ${tool} args`);
  }
  return {
    tool,
    command,
    args,
    toolArgs,
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

function normalizeToolName(value: string): AgentToolName {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_") as AgentToolName;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
