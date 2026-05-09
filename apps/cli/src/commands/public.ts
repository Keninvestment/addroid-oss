import { spawnSync } from "node:child_process";
import {
  defaultAddroidConfig,
  ensureAddroidPaths,
  readAddroidConfig,
  resolveWebBinding,
} from "@addroid/config";
import { runAccountsCommand } from "./accounts.js";
import { runAuthCommand } from "./auth.js";
import { runCronCommand } from "./cron.js";
import { runPlan } from "./plan.js";
import { runValidate } from "./validate.js";
import { ensureWebUiStarted } from "../lib/web-service.js";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "../../../worker/src/lib/ops-repo-local.js";

type CronPreset =
  | "github_poll"
  | "daily_report"
  | "budget_guard"
  | "automation_rules"
  | "improvement_pr"
  | "retention_sweep"
  | "agent_tasks";

export async function runOpenCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printOpenHelp();
    return 0;
  }
  const noOpen = args.includes("--no-open");
  const binding = resolveWebBinding(process.env);
  const url = `http://${binding.hostname}:${binding.port}`;
  process.stdout.write(`[addroid open]\n\n  Web UI: ${url}\n`);
  const web = await ensureWebUiStarted({ env: process.env });
  if (web.running) {
    process.stdout.write(`  status: ${web.started ? "started" : "running"}\n`);
  } else {
    process.stderr.write(
      [
        "  status: not reachable",
        `  log   : ${web.logFile}`,
        `  reason: ${web.error ?? "unknown"}`,
        "  `addroid status` と `addroid logs up` を確認してください。",
        "",
      ].join("\n")
    );
    return 1;
  }
  if (!noOpen) openUrl(url);
  return 0;
}

export async function runConnectCommand(args: string[]): Promise<number> {
  const [service, ...rest] = args;
  if (!service || service === "--help" || service === "-h" || service === "help") {
    printConnectHelp();
    return 0;
  }
  const normalized = normalizeService(service);
  if (!normalized) {
    process.stderr.write(`[addroid connect] 未対応の接続先: ${service}\n`);
    printConnectHelp();
    return 2;
  }
  return await runAuthCommand([normalized, ...rest]);
}

export async function runAccountCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === "--help" || action === "-h" || action === "help") {
    printAccountHelp();
    return 0;
  }
  if (!action) return await runAccountsCommand(["list"]);
  const normalized = normalizeAccountAction(action);
  if (!normalized) {
    process.stderr.write(`[addroid account] 未対応の操作: ${action}\n`);
    printAccountHelp();
    return 2;
  }
  return await runAccountsCommand([normalized, ...rest]);
}

export async function runReportCommand(args: string[]): Promise<number> {
  const [kind, ...rest] = args;
  if (kind === "--help" || kind === "-h" || kind === "help") {
    printReportHelp();
    return 0;
  }
  const preset = reportPreset(kind ?? "daily");
  if (!preset) {
    process.stderr.write(`[addroid report] 未対応のレポート: ${kind}\n`);
    printReportHelp();
    return 2;
  }
  return await runCronCommand(["run", preset, ...rest]);
}

export async function runScheduleCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === "--help" || action === "-h" || action === "help") {
    printScheduleHelp();
    return 0;
  }
  if (!action) return await runCronCommand(["list"]);
  const normalized = normalizeScheduleAction(action);
  if (!normalized) {
    process.stderr.write(`[addroid schedule] 未対応の操作: ${action}\n`);
    printScheduleHelp();
    return 2;
  }
  return await runCronCommand([normalized, ...rest.map(normalizeSchedulePresetArg)]);
}

export async function runSubmitCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printSubmitHelp();
    return 0;
  }
  const parsed = parseSubmitArgs(args, await resolveDefaultSubmitRoot(process.env));
  if (!parsed.ok) {
    process.stderr.write(`[addroid submit] ${parsed.error}\n`);
    printSubmitHelp();
    return 2;
  }
  process.stdout.write("[addroid submit]\n\n  step 1/2: 入稿ファイルをチェックします\n\n");
  const validateCode = await runValidate(parsed.validateArgs);
  if (validateCode !== 0) {
    process.stderr.write("\n[addroid submit] チェックで問題が見つかったため、変更予定の確認を中断しました。\n");
    return validateCode;
  }
  process.stdout.write("\n  step 2/2: Meta に反映される変更予定を確認します\n\n");
  return await runPlan(parsed.planArgs);
}

function parseSubmitArgs(args: string[], defaultRoot: string | null):
  | { ok: true; validateArgs: string[]; planArgs: string[] }
  | { ok: false; error: string } {
  const validateArgs: string[] = [];
  const planArgs: string[] = ["--dry-run"];
  let hasRoot = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--root" || a === "-r" || a === "--base" || a === "--account") {
      const next = args[i + 1];
      if (!next) return { ok: false, error: `${a} に値がありません` };
      if (a === "--root" || a === "-r") hasRoot = true;
      if (a !== "--account") validateArgs.push(a, next);
      planArgs.push(a, next);
      i += 1;
    } else if (a.startsWith("--root=") || a.startsWith("--base=")) {
      if (a.startsWith("--root=")) hasRoot = true;
      validateArgs.push(a);
      planArgs.push(a);
    } else if (a.startsWith("--account=")) {
      planArgs.push(a);
    } else if (a === "--save") {
      planArgs.push("--persist", "--source", "cli");
    } else {
      return { ok: false, error: `未知のオプション: ${a}` };
    }
  }
  if (!hasRoot && defaultRoot) {
    validateArgs.unshift("--root", defaultRoot);
    planArgs.splice(1, 0, "--root", defaultRoot);
  }
  return { ok: true, validateArgs, planArgs };
}

async function resolveDefaultSubmitRoot(env: NodeJS.ProcessEnv): Promise<string | null> {
  const envRoot = env.ADDROID_OPS_REPO_LOCAL_DIR?.trim();
  if (envRoot) return envRoot;
  if (!env.DATABASE_URL) return null;
  try {
    const [{ prisma }, stores] = await Promise.all([
      import("@addroid/db"),
      import("../../../worker/src/lib/prisma-stores.js"),
    ]);
    const paths = await ensureAddroidPaths(env);
    const config = (await readAddroidConfig(env).catch(() => null)) ?? defaultAddroidConfig(env);
    const workspace = await stores.ensureWorkspace(prisma, {
      slug: config.workspace.slug,
      displayName: config.workspace.displayName,
      configPath: paths.configFile,
      storageDir: paths.storageDir,
      databaseUrlRef: config.database.urlRef,
    });
    const checkout = await ensureOpsRepoLocalCheckout({
      prisma: prisma as never,
      workspaceId: workspace.id,
      env,
    }).catch(() => null);
    return (
      checkout?.rootDir ??
      (await resolveOpsRepoLocalDirForWorkspace({
        prisma: prisma as never,
        workspaceId: workspace.id,
        env,
      })).rootDir
    );
  } catch {
    return null;
  }
}

function normalizeService(value: string): "meta" | "github" | "llm" | "slack" | null {
  const v = value.trim().toLowerCase();
  if (v === "ai" || v === "llm") return "llm";
  if (v === "meta" || v === "github" || v === "slack") return v;
  return null;
}

function normalizeAccountAction(value: string): "list" | "refresh" | "add" | "select" | null {
  const v = value.trim().toLowerCase();
  if (v === "list" || v === "show") return "list";
  if (v === "refresh" || v === "sync") return "refresh";
  if (v === "add" || v === "register") return "add";
  if (v === "select" || v === "choose" || v === "default") return "select";
  return null;
}

function normalizeScheduleAction(value: string): "list" | "enable" | "disable" | "set" | "run" | "logs" | null {
  const v = value.trim().toLowerCase();
  if (v === "list" || v === "show") return "list";
  if (v === "enable" || v === "on") return "enable";
  if (v === "disable" || v === "off") return "disable";
  if (v === "set") return "set";
  if (v === "run" || v === "now") return "run";
  if (v === "logs" || v === "history") return "logs";
  return null;
}

function normalizeSchedulePresetArg(value: string): string {
  return reportPreset(value) ?? value;
}

function reportPreset(value: string): CronPreset | null {
  const v = value.trim().toLowerCase().replace(/-/g, "_");
  if (v === "daily" || v === "report" || v === "daily_report") return "daily_report";
  if (v === "budget" || v === "budget_guard") return "budget_guard";
  if (v === "automation" || v === "automation_rules" || v === "autopilot") return "automation_rules";
  if (v === "improvement" || v === "improvements" || v === "improvement_pr") return "improvement_pr";
  if (v === "github" || v === "github_poll") return "github_poll";
  if (v === "retention" || v === "retention_sweep") return "retention_sweep";
  if (v === "agent" || v === "agent_task" || v === "agent_tasks") return "agent_tasks";
  return null;
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawnSync(command, args, { stdio: "ignore" });
}

function printOpenHelp(): void {
  process.stdout.write(
    [
      "addroid open — Web UI を開く",
      "",
      "Usage:",
      "  addroid open [--no-open]",
      "",
      "Options:",
      "  --no-open   ブラウザを開かず URL だけ表示",
      "",
    ].join("\n")
  );
}

function printConnectHelp(): void {
  process.stdout.write(
    [
      "addroid connect — 外部サービスを接続・再接続",
      "",
      "Usage:",
      "  addroid connect meta",
      "  addroid connect github",
      "  addroid connect ai",
      "  addroid connect slack",
      "",
      "Notes:",
      "  - ai は Codex app-server / OpenAI API key / Claude API key の選択から開始します。",
      "",
    ].join("\n")
  );
}

function printAccountHelp(): void {
  process.stdout.write(
    [
      "addroid account — 利用する Meta 広告アカウントを確認・選択",
      "",
      "Usage:",
      "  addroid account",
      "  addroid account sync [--select-default]",
      "  addroid account choose [--ad-account-id act_123 | --key primary]",
      "",
    ].join("\n")
  );
}

function printReportHelp(): void {
  process.stdout.write(
    [
      "addroid report — レポート・改善チェックを今すぐ実行",
      "",
      "Usage:",
      "  addroid report [daily]",
      "  addroid report budget",
      "  addroid report improvement",
      "",
    ].join("\n")
  );
}

function printScheduleHelp(): void {
  process.stdout.write(
    [
      "addroid schedule — 自動実行の確認・変更",
      "",
      "Usage:",
      "  addroid schedule",
      "  addroid schedule enable daily",
      "  addroid schedule disable budget",
      "  addroid schedule run improvement",
      "  addroid schedule logs daily [--limit N]",
      "",
    ].join("\n")
  );
}

function printSubmitHelp(): void {
  process.stdout.write(
    [
      "addroid submit — 入稿前チェックと変更予定の確認",
      "",
      "Usage:",
      "  addroid submit [--root <ops-repo>] [--base <previous-repo>] [--account <key>] [--save]",
      "",
      "Options:",
      "  --root <dir>     チェック対象の ops repo (既定: ADDROID_OPS_REPO_LOCAL_DIR、未設定なら現在のディレクトリ)",
      "  --base <dir>     比較元の ops repo",
      "  --account <key>  特定アカウントだけ変更予定を表示",
      "  --save           結果を履歴に保存",
      "",
      "Notes:",
      "  - Meta への直接反映は行いません。検証と dry-run のみ実行します。",
      "",
    ].join("\n")
  );
}
