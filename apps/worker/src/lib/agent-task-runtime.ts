import cronParser from "cron-parser";
import {
  buildAgentContext,
  runAgentTurn,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import { Prisma, type PrismaClient } from "@addroid/db";
import type PgBoss from "pg-boss";
import {
  CRON_PRESETS,
  validateCronExpression,
  type CronPresetName,
} from "@addroid/queue";
import type { LLMProvider } from "@addroid/llm-provider";
import {
  createPrismaPlanStore,
  persistPlanRun,
  runPlanForRoot,
} from "./plan-runtime.js";

export interface RunDueAgentTasksOptions {
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
}

export interface AgentTasksSummary {
  status: "succeeded" | "partial_failure" | "failed";
  due: number;
  succeeded: number;
  failed: number;
}

export async function runDueAgentTasks(
  opts: RunDueAgentTasksOptions
): Promise<AgentTasksSummary> {
  const now = new Date();
  const tasks = await opts.prisma.agentTask.findMany({
    where: {
      workspaceId: opts.workspaceId,
      enabled: true,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { nextRunAt: "asc" },
    take: 10,
    select: {
      id: true,
      title: true,
      prompt: true,
      cron: true,
    },
  });
  let succeeded = 0;
  let failed = 0;
  for (const task of tasks) {
    const run = await opts.prisma.agentTaskRun.create({
      data: {
        workspaceId: opts.workspaceId,
        taskId: task.id,
        status: "running",
      },
      select: { id: true },
    });
    try {
      const agentContext = await buildAgentContext(process.env);
      const turn = await runAgentTurn({
        input: task.prompt,
        provider: opts.provider,
        agentContext,
        purpose: "worker:agent-task",
      });
      const executions = [];
      for (const tool of turn.toolResults) {
        executions.push(await executeWorkerAgentTool({
          tool,
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          boss: opts.boss,
          webUrl: agentContext.webUrl,
        }));
      }
      const hasFailure = executions.some((e) => e.status === "error");
      await opts.prisma.agentTaskRun.update({
        where: { id: run.id },
        data: {
          status: hasFailure ? "failed" : "succeeded",
          finishedAt: new Date(),
          message: turn.message,
          toolCalls: executions as Prisma.InputJsonValue,
          errorMessage: hasFailure
            ? executions.find((e) => e.status === "error")?.message ?? "agent task failed"
            : null,
        },
      });
      await opts.prisma.agentTask.update({
        where: { id: task.id },
        data: {
          lastRunAt: new Date(),
          lastState: hasFailure ? "failed" : "success",
          nextRunAt: computeNextRunAt(task.cron),
        },
      });
      if (hasFailure) failed += 1;
      else succeeded += 1;
    } catch (err) {
      failed += 1;
      await opts.prisma.agentTaskRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: (err as Error).message,
        },
      });
      await opts.prisma.agentTask.update({
        where: { id: task.id },
        data: {
          lastRunAt: new Date(),
          lastState: "failed",
          nextRunAt: safeNextRunAt(task.cron),
        },
      });
    }
  }
  const status =
    failed === 0 ? "succeeded" : succeeded > 0 ? "partial_failure" : "failed";
  return { status, due: tasks.length, succeeded, failed };
}

function computeNextRunAt(cron: string, currentDate = new Date()): Date {
  const validation = validateCronExpression(cron);
  if (!validation.ok) throw new Error(`cron 式が不正です: ${validation.reason}`);
  return cronParser.parseExpression(cron, { currentDate }).next().toDate();
}

function safeNextRunAt(cron: string): Date | null {
  try {
    return computeNextRunAt(cron);
  } catch {
    return null;
  }
}

async function executeWorkerAgentTool(opts: {
  tool: AgentToolResult;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
  webUrl: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const { tool } = opts;
  if (tool.status === "denied") {
    return { display: tool.toolName, status: "denied", message: tool.reason };
  }
  if (tool.status === "unsupported") {
    return { display: tool.toolName, status: "unsupported", message: tool.reason };
  }
  const readyTool = tool;
  try {
    switch (readyTool.tool) {
      case "open_web_ui":
        return { display: readyTool.display, status: "ok", message: opts.webUrl };
      case "check_status":
      case "diagnose":
        return { display: readyTool.display, status: "ok", message: "worker is running" };
      case "list_ad_accounts": {
        const accounts = await opts.prisma.adAccount.findMany({
          where: { workspaceId: opts.workspaceId, active: true },
          select: { key: true, displayName: true, metaAccountId: true },
          orderBy: { key: "asc" },
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `${accounts.length} 件の広告アカウントがあります。`,
          data: { accounts },
        };
      }
      case "get_report": {
        const preset = reportPreset(
          typeof readyTool.toolArgs.kind === "string" ? readyTool.toolArgs.kind : "daily"
        );
        const metricDate = readStringArg(readyTool.toolArgs, "metricDate", "metric_date");
        const jobId = await opts.boss.send(preset, {
          ...(metricDate ? { metricDate } : {}),
          manual: true,
          requestedBy: "agent:scheduled-task",
          requestedAt: new Date().toISOString(),
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `${preset} を enqueue しました。`,
          data: { jobId },
        };
      }
      case "manage_schedule":
        return await manageSchedule({ ...opts, tool: readyTool });
      case "check_submission":
        return await runSubmissionCheck({ ...opts, tool: readyTool });
      case "connect_service":
        return {
          display: readyTool.display,
          status: "unsupported",
          message: "scheduled task から接続フローは実行しません。Web UI または CLI で接続してください。",
        };
      default:
        return {
          display: readyTool.display,
          status: "unsupported",
          message: `scheduled task では未対応の tool です: ${readyTool.tool}`,
        };
    }
  } catch (err) {
    return {
      display: readyTool.display,
      status: "error",
      message: (err as Error).message,
    };
  }
}

async function manageSchedule(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const action =
    typeof opts.tool.toolArgs.action === "string" ? opts.tool.toolArgs.action : "list";
  if (action === "list" || action === "logs") {
    const schedules = await opts.prisma.cronSchedule.findMany({
      where: { workspaceId: opts.workspaceId },
      orderBy: { name: "asc" },
      select: { name: true, cron: true, enabled: true, lastRunState: true },
    });
    return {
      display: opts.tool.display,
      status: "ok",
      message: `${schedules.length} 件の schedule があります。`,
      data: { schedules },
    };
  }
  const preset = reportPreset(
    typeof opts.tool.toolArgs.preset === "string" ? opts.tool.toolArgs.preset : ""
  );
  if (action === "run") {
    const jobId = await opts.boss.send(preset, {
      manual: true,
      requestedBy: "agent:scheduled-task",
      requestedAt: new Date().toISOString(),
    });
    return {
      display: opts.tool.display,
      status: "ok",
      message: `${preset} を enqueue しました。`,
      data: { jobId },
    };
  }
  return {
    display: opts.tool.display,
    status: "unsupported",
    message: "scheduled task から schedule の変更は行いません。Web UI の Schedules で変更してください。",
  };
}

async function runSubmissionCheck(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const rootDir =
    typeof opts.tool.toolArgs.root === "string" && opts.tool.toolArgs.root.trim()
      ? opts.tool.toolArgs.root.trim()
      : process.env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || "";
  const baseDir =
    typeof opts.tool.toolArgs.base === "string" && opts.tool.toolArgs.base.trim()
      ? opts.tool.toolArgs.base.trim()
      : process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  if (!rootDir) {
    return {
      display: opts.tool.display,
      status: "error",
      message: "ADDROID_OPS_REPO_LOCAL_DIR が未設定です。",
    };
  }
  const result = runPlanForRoot({
    rootDir,
    baseDir,
    accountFilter:
      typeof opts.tool.toolArgs.account === "string" ? opts.tool.toolArgs.account : null,
  });
  const recorded = await persistPlanRun({
    store: createPrismaPlanStore(opts.prisma),
    workspaceId: opts.workspaceId,
    source: "agent-task",
    triggeredBy: "agent:scheduled-task",
    rootDir,
    baseDir,
    accountFilter:
      typeof opts.tool.toolArgs.account === "string" ? opts.tool.toolArgs.account : null,
    result,
  }).catch(() => null);
  return {
    display: opts.tool.display,
    status: result.ok ? "ok" : "error",
    message: result.ok ? "dry-run は OK です。" : "dry-run で問題があります。",
    data: { executionLogId: recorded?.id ?? null, result },
  };
}

function readStringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
