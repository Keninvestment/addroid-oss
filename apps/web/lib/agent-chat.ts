import fs from "node:fs";
import {
  buildAgentContext,
  runAgentTurn,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import { Prisma } from "@addroid/db";
import { CRON_PRESETS, type CronPresetName } from "@addroid/queue";
import { prisma } from "./prisma";
import { ensureWebWorkspace } from "./github-runtime";
import { loadDashboardStatus } from "./status";
import {
  runCronNow,
  setCronSchedule,
  toggleCron,
} from "./cron-actions";
import { selectLLMProviderForWorker } from "../../worker/src/lib/llm-runtime";
import {
  createPrismaPlanStore,
  persistPlanRun,
  runPlanForRoot,
} from "../../worker/src/lib/plan-runtime";

export interface WebAgentExecution {
  display: string;
  status: "ok" | "error" | "denied" | "unsupported";
  message: string;
  data?: unknown;
}

export interface WebAgentReply {
  ok: boolean;
  message: string;
  executions: WebAgentExecution[];
}

export async function runWebAgentChat(input: string): Promise<WebAgentReply> {
  const text = input.trim();
  if (!text) {
    return { ok: false, message: "入力が空です。", executions: [] };
  }
  const workspace = await ensureWebWorkspace();
  const selection = await selectLLMProviderForWorker(process.env, { prisma });
  const connection = await selection.provider.getConnection().catch(() => null);
  if (!connection && selection.choice !== "mock") {
    return {
      ok: false,
      message: "LLM credential が見つかりません。/ai から接続してください。",
      executions: [],
    };
  }

  const agentContext = await buildAgentContext(process.env);
  const turn = await runAgentTurn({
    input: text,
    provider: selection.provider,
    agentContext,
    purpose: "web:dashboard-chat",
  });

  const executions: WebAgentExecution[] = [];
  for (const tool of turn.toolResults) {
    executions.push(await executeWebAgentTool(tool, agentContext.webUrl, workspace.id));
  }
  await recordAgentAudit(workspace.id, "agent.chat_via_web", {
    input: text,
    message: turn.message,
    executions: executions.map((e) => ({
      display: e.display,
      status: e.status,
      message: e.message,
    })),
  });
  return {
    ok: executions.every((e) => e.status !== "error"),
    message: turn.message,
    executions,
  };
}

export async function executeWebAgentTool(
  tool: AgentToolResult,
  webUrl: string,
  workspaceId: string
): Promise<WebAgentExecution> {
  if (tool.status === "denied") {
    return {
      display: tool.toolName,
      status: "denied",
      message: tool.reason,
    };
  }
  if (tool.status === "unsupported") {
    return {
      display: tool.toolName,
      status: "unsupported",
      message: tool.reason,
    };
  }

  try {
    switch (tool.tool) {
      case "open_web_ui":
        return {
          display: tool.display,
          status: "ok",
          message: webUrl,
          data: { url: webUrl },
        };
      case "check_status": {
        const status = await loadDashboardStatus();
        return {
          display: tool.display,
          status: "ok",
          message: `config=${status.config.state}, db=${status.database.state}, worker=${status.worker.state}, github=${status.github.state}`,
          data: status,
        };
      }
      case "diagnose":
        return {
          display: tool.display,
          status: "ok",
          message: "Web UI では主要ステータスを確認しました。詳細診断は `addroid doctor` を実行してください。",
          data: await loadDashboardStatus(),
        };
      case "list_ad_accounts":
      case "sync_ad_accounts": {
        const accounts = await prisma.adAccount.findMany({
          where: { workspaceId, active: true },
          orderBy: { key: "asc" },
          select: {
            id: true,
            key: true,
            displayName: true,
            metaAccountId: true,
            currency: true,
          },
        });
        return {
          display: tool.display,
          status: "ok",
          message: accounts.length
            ? `${accounts.length} 件の広告アカウントがあります。`
            : "広告アカウントが未登録です。/accounts から接続・同期してください。",
          data: { accounts },
        };
      }
      case "select_ad_account":
        return await selectDefaultAccount(workspaceId, tool.toolArgs, tool.display);
      case "connect_service":
        return connectServiceResult(tool.toolArgs, tool.display);
      case "get_report":
        return await runReportTool(tool.toolArgs, tool.display);
      case "manage_schedule":
        return await manageScheduleTool(tool.toolArgs, tool.display);
      case "check_submission":
        return await runSubmissionCheck(workspaceId, tool.toolArgs, tool.display);
      case "show_logs":
        return await showRecentLogs(tool.toolArgs, tool.display);
      case "start_delivery":
      case "stop_services":
      case "backup_data":
        return {
          display: tool.display,
          status: "unsupported",
          message: "この操作は Web chat からはまだ実行せず、既存の専用 UI / CLI 経路を使ってください。",
        };
      default:
        return {
          display: tool.display,
          status: "unsupported",
          message: `未対応の tool: ${tool.tool}`,
        };
    }
  } catch (err) {
    return {
      display: tool.display,
      status: "error",
      message: (err as Error).message,
    };
  }
}

async function selectDefaultAccount(
  workspaceId: string,
  args: Record<string, unknown>,
  display: string
): Promise<WebAgentExecution> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const adAccountId =
    typeof args.adAccountId === "string" ? args.adAccountId.trim() : "";
  if (!key && !adAccountId) {
    return {
      display,
      status: "unsupported",
      message: "選択する広告アカウントが指定されていません。/accounts で選択してください。",
    };
  }
  const account = await prisma.adAccount.findFirst({
    where: {
      workspaceId,
      active: true,
      ...(adAccountId ? { metaAccountId: adAccountId } : { key }),
    },
    select: { id: true, key: true, displayName: true, metaAccountId: true },
  });
  if (!account) {
    return {
      display,
      status: "error",
      message: "該当する広告アカウントが見つかりません。",
    };
  }
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { defaultAdAccountId: account.id },
  });
  await recordAgentAudit(workspaceId, "agent.default_account_selected", {
    accountKey: account.key,
    metaAccountId: account.metaAccountId,
  });
  return {
    display,
    status: "ok",
    message: `${account.displayName} をデフォルト広告アカウントにしました。`,
    data: { account },
  };
}

function connectServiceResult(
  args: Record<string, unknown>,
  display: string
): WebAgentExecution {
  const service = typeof args.service === "string" ? args.service : "";
  const path =
    service === "meta"
      ? "/accounts"
      : service === "github"
        ? "/github"
        : service === "ai"
          ? "/ai"
          : service === "slack"
            ? "/setup"
            : "/setup";
  return {
    display,
    status: "ok",
    message: `${service || "service"} の接続画面を開いてください: ${path}`,
    data: { path },
  };
}

async function runReportTool(
  args: Record<string, unknown>,
  display: string
): Promise<WebAgentExecution> {
  const preset = reportPreset(typeof args.kind === "string" ? args.kind : "daily");
  const result = await runCronNow(preset);
  if (!result.ok) {
    return {
      display,
      status: "error",
      message: result.error,
    };
  }
  return {
    display,
    status: "ok",
    message: result.jobId
      ? `${preset} を実行キューに積みました。job=${result.jobId}`
      : `${preset} を実行キューに積みました。`,
    data: result,
  };
}

async function manageScheduleTool(
  args: Record<string, unknown>,
  display: string
): Promise<WebAgentExecution> {
  const action = typeof args.action === "string" ? args.action : "list";
  if (action === "list" || action === "logs") {
    const schedules = await prisma.cronSchedule.findMany({
      orderBy: { name: "asc" },
      select: { name: true, cron: true, enabled: true, lastRunState: true, nextRunAt: true },
    });
    const runs = action === "logs"
      ? await prisma.cronRun.findMany({
          orderBy: { startedAt: "desc" },
          take: typeof args.limit === "number" ? Math.max(1, Math.min(50, args.limit)) : 10,
          select: { id: true, name: true, state: true, startedAt: true, errorMessage: true },
        })
      : [];
    return {
      display,
      status: "ok",
      message: action === "logs"
        ? `${runs.length} 件の実行履歴を取得しました。`
        : `${schedules.length} 件の schedule があります。`,
      data: { schedules, runs },
    };
  }

  const preset = reportPreset(typeof args.preset === "string" ? args.preset : "");
  if (action === "run") {
    const result = await runCronNow(preset);
    return result.ok
      ? { display, status: "ok", message: `${preset} を実行キューに積みました。`, data: result }
      : { display, status: "error", message: result.error };
  }
  if (action === "enable" || action === "disable") {
    const result = await toggleCron(preset, action === "enable");
    return result.ok
      ? { display, status: "ok", message: `${preset} を ${result.enabled ? "ON" : "OFF"} にしました。`, data: result }
      : { display, status: "error", message: result.error };
  }
  if (action === "set") {
    const cron = typeof args.cron === "string" ? args.cron : "";
    const result = await setCronSchedule(preset, cron);
    return result.ok
      ? { display, status: "ok", message: `${preset} の schedule を ${result.cron} にしました。`, data: result }
      : { display, status: "error", message: result.error };
  }
  return {
    display,
    status: "unsupported",
    message: `未対応の schedule 操作です: ${action}`,
  };
}

async function runSubmissionCheck(
  workspaceId: string,
  args: Record<string, unknown>,
  display: string
): Promise<WebAgentExecution> {
  const rootDir =
    typeof args.root === "string" && args.root.trim()
      ? args.root.trim()
      : process.env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || "";
  const baseDir =
    typeof args.base === "string" && args.base.trim()
      ? args.base.trim()
      : process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  if (!rootDir) {
    return {
      display,
      status: "error",
      message: "ADDROID_OPS_REPO_LOCAL_DIR が未設定です。",
    };
  }
  if (!fs.existsSync(rootDir)) {
    return {
      display,
      status: "error",
      message: `ops repo が見つかりません: ${rootDir}`,
    };
  }
  const result = runPlanForRoot({
    rootDir,
    baseDir,
    accountFilter: typeof args.account === "string" ? args.account : null,
  });
  const store = createPrismaPlanStore(prisma);
  const recorded = await persistPlanRun({
    store,
    workspaceId,
    source: "web-chat",
    triggeredBy: "agent:web-chat",
    rootDir,
    baseDir,
    accountFilter: typeof args.account === "string" ? args.account : null,
    result,
  }).catch(() => null);
  return {
    display,
    status: result.ok ? "ok" : "error",
    message: result.ok
      ? `dry-run は OK です。+${result.totalCounts.creates} ~${result.totalCounts.updates} -${result.totalCounts.deletes}`
      : `dry-run で問題があります。errors=${result.validationErrors.length + result.totalCounts.errors}`,
    data: { result, executionLogId: recorded?.id ?? null },
  };
}

async function showRecentLogs(
  args: Record<string, unknown>,
  display: string
): Promise<WebAgentExecution> {
  const limit =
    typeof args.lines === "number" ? Math.max(1, Math.min(50, args.lines)) : 20;
  const logs = await prisma.executionLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      createdAt: true,
      kind: true,
      level: true,
      message: true,
    },
  });
  return {
    display,
    status: "ok",
    message: `${logs.length} 件の execution log を取得しました。`,
    data: { logs },
  };
}

function reportPreset(value: string): CronPresetName {
  const v = value.trim().toLowerCase().replace(/-/g, "_");
  const name =
    v === "daily" || v === "report" || v === "daily_report"
      ? "daily_report"
      : v === "budget" || v === "budget_guard"
        ? "budget_guard"
        : v === "improvement" || v === "improvements" || v === "improvement_pr"
          ? "improvement_pr"
          : v === "github" || v === "github_poll"
            ? "github_poll"
            : v === "retention" || v === "retention_sweep"
              ? "retention_sweep"
              : "";
  if (CRON_PRESETS.some((p) => p.name === name)) return name as CronPresetName;
  return "daily_report";
}

async function recordAgentAudit(
  workspaceId: string,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        workspaceId,
        actor: "agent:web-ui",
        action,
        target: "agent:web-chat",
        metadata: metadata as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}
