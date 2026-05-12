import cronParser from "cron-parser";
import {
  buildAgentContext,
  buildAgentLoopInput,
  runAgentTurn,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import { Prisma, type PrismaClient } from "@addroid/db";
import type PgBoss from "pg-boss";
import type { GithubAdapter } from "@addroid/github-adapter";
import {
  CRON_PRESETS,
  SCHEDULED_TASK_JOB_NAME,
  resolveCronScheduleTimeZone,
  validateCronExpression,
  type CronPresetName,
} from "@addroid/queue";
import type { LLMProvider } from "@addroid/llm-provider";
import {
  createPrismaPlanStore,
  persistPlanRun,
  runPlanForRoot,
} from "./plan-runtime.js";
import { runMetaAdsReadOnlyQuery } from "./meta-ads-readonly-runtime.js";
import {
  createOpsChangeProposal,
  type OpsChangeProposalInput,
} from "./ops-proposal-runtime.js";
import {
  createAutomationRuleProposal,
  type AutomationRuleProposalInput,
} from "./automation-rule-proposal-runtime.js";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "./ops-repo-local.js";

export interface RunDueAgentTasksOptions {
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
  githubAdapter?: GithubAdapter;
}

export interface AgentTasksSummary {
  status: "succeeded" | "partial_failure" | "failed";
  due: number;
  succeeded: number;
  failed: number;
}

export interface ScheduledAgentTaskPayload {
  taskId: string;
  manual?: boolean;
  requestedBy?: string;
  requestedAt?: string;
}

interface AgentTaskExecutionOptions extends RunDueAgentTasksOptions {
  taskId: string;
  jobId?: string;
  manual?: boolean;
}

export async function scheduleAgentTaskNextRun(opts: {
  prisma: PrismaClient;
  boss: PgBoss;
  taskId: string;
  workspaceId?: string;
  now?: Date;
}): Promise<{ jobId: string | null; nextRunAt: Date } | null> {
  const task = await opts.prisma.agentTask.findFirst({
    where: {
      id: opts.taskId,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
    select: {
      id: true,
      workspaceId: true,
      cron: true,
      enabled: true,
      scheduledJobId: true,
    },
  });
  if (!task || !task.enabled) return null;
  const nextRunAt = computeNextRunAt(task.cron, opts.now ?? new Date());
  if (task.scheduledJobId) {
    await opts.boss
      .cancel(SCHEDULED_TASK_JOB_NAME, task.scheduledJobId)
      .catch(() => undefined);
  }
  const jobId = await opts.boss.send(
    SCHEDULED_TASK_JOB_NAME,
    {
      taskId: task.id,
      requestedBy: "system:scheduler",
      requestedAt: new Date().toISOString(),
    },
    { startAfter: nextRunAt, singletonKey: task.id }
  );
  await opts.prisma.agentTask.update({
    where: { id: task.id },
    data: { nextRunAt, scheduledJobId: jobId },
  });
  return { jobId, nextRunAt };
}

export async function cancelAgentTaskNextRun(opts: {
  prisma: PrismaClient;
  boss: PgBoss;
  taskId: string;
  workspaceId?: string;
}): Promise<void> {
  const task = await opts.prisma.agentTask.findFirst({
    where: {
      id: opts.taskId,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
    select: { id: true, scheduledJobId: true },
  });
  if (!task) return;
  if (task.scheduledJobId) {
    await opts.boss
      .cancel(SCHEDULED_TASK_JOB_NAME, task.scheduledJobId)
      .catch(() => undefined);
  }
  await opts.prisma.agentTask.update({
    where: { id: task.id },
    data: { scheduledJobId: null, nextRunAt: null },
  });
}

export async function enqueueAgentTaskNow(opts: {
  boss: PgBoss;
  taskId: string;
  requestedBy: string;
}): Promise<string | null> {
  return opts.boss.send(SCHEDULED_TASK_JOB_NAME, {
    taskId: opts.taskId,
    manual: true,
    requestedBy: opts.requestedBy,
    requestedAt: new Date().toISOString(),
  });
}

export async function rescheduleEnabledAgentTasks(opts: {
  prisma: PrismaClient;
  boss: PgBoss;
  workspaceId: string;
}): Promise<{ scheduled: number }> {
  const tasks = await opts.prisma.agentTask.findMany({
    where: { workspaceId: opts.workspaceId, enabled: true },
    select: { id: true },
    orderBy: { nextRunAt: "asc" },
  });
  let scheduled = 0;
  for (const task of tasks) {
    const result = await scheduleAgentTaskNextRun({
      prisma: opts.prisma,
      boss: opts.boss,
      workspaceId: opts.workspaceId,
      taskId: task.id,
    });
    if (result) scheduled += 1;
  }
  return { scheduled };
}

export async function runScheduledAgentTaskJob(
  opts: AgentTaskExecutionOptions
): Promise<{ status: "succeeded" | "failed"; runId: string; message?: string }> {
  const task = await opts.prisma.agentTask.findFirst({
    where: { id: opts.taskId, workspaceId: opts.workspaceId },
    select: {
      id: true,
      title: true,
      prompt: true,
      cron: true,
      enabled: true,
      scheduledJobId: true,
    },
  });
  if (!task) throw new Error(`Agent task not found: ${opts.taskId}`);
  if (!opts.manual && !task.enabled) {
    throw new Error(`Agent task is disabled: ${opts.taskId}`);
  }
  if (!opts.manual && opts.jobId && task.scheduledJobId && task.scheduledJobId !== opts.jobId) {
    throw new Error(`Agent task job is stale: ${opts.taskId}`);
  }

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
    const executions = [];
    const seenTools = new Set<string>();
    let message = "";
    for (let i = 0; i < 4; i += 1) {
      const turn = await runAgentTurn({
        input: buildAgentLoopInput(task.prompt, executions),
        provider: opts.provider,
        agentContext,
        purpose: "worker:agent-task",
        surface: "scheduled-agent",
      });
      if (turn.message) message = turn.message;
      if (turn.toolResults.length === 0) break;
      let executedAny = false;
      for (const tool of turn.toolResults) {
        const signature = toolSignature(tool);
        if (signature && seenTools.has(signature)) {
          executions.push({
            display: signature,
            status: "unsupported",
            message: "duplicate tool call skipped",
          });
          continue;
        }
        if (signature) seenTools.add(signature);
        executions.push(await executeWorkerAgentTool({
          tool,
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          boss: opts.boss,
          webUrl: agentContext.webUrl,
          githubAdapter: opts.githubAdapter,
        }));
        executedAny = true;
      }
      if (!executedAny) break;
    }
    const hasFailure = executions.some((e) =>
      e.status === "error" || e.status === "denied" || e.status === "unsupported"
    );
    await opts.prisma.agentTaskRun.update({
      where: { id: run.id },
      data: {
        status: hasFailure ? "failed" : "succeeded",
        finishedAt: new Date(),
        message,
        toolCalls: executions as Prisma.InputJsonValue,
        errorMessage: hasFailure
          ? executions.find((e) =>
              e.status === "error" || e.status === "denied" || e.status === "unsupported"
            )?.message ?? "agent task failed"
          : null,
      },
    });
    await opts.prisma.agentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: new Date(),
        lastState: hasFailure ? "failed" : "success",
        ...(opts.manual ? {} : { scheduledJobId: null }),
      },
    });
    if (!opts.manual && task.enabled) {
      await scheduleAgentTaskNextRun({
        prisma: opts.prisma,
        boss: opts.boss,
        workspaceId: opts.workspaceId,
        taskId: task.id,
      });
    }
    return { status: hasFailure ? "failed" : "succeeded", runId: run.id, message };
  } catch (err) {
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
        ...(opts.manual ? {} : { scheduledJobId: null }),
      },
    });
    if (!opts.manual && task.enabled) {
      await scheduleAgentTaskNextRun({
        prisma: opts.prisma,
        boss: opts.boss,
        workspaceId: opts.workspaceId,
        taskId: task.id,
      }).catch(() => undefined);
    }
    throw err;
  }
}

function computeNextRunAt(cron: string, currentDate = new Date()): Date {
  const validation = validateCronExpression(cron);
  if (!validation.ok) throw new Error(`cron 式が不正です: ${validation.reason}`);
  return cronParser
    .parseExpression(cron, {
      currentDate,
      tz: resolveCronScheduleTimeZone(),
    })
    .next()
    .toDate();
}

async function executeWorkerAgentTool(opts: {
  tool: AgentToolResult;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
  webUrl: string;
  githubAdapter?: GithubAdapter;
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
        const metricDate = resolveMetricDateArg(readyTool.toolArgs);
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
      case "query_meta_ads": {
        const result = await runMetaAdsReadOnlyQuery({
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          args: readyTool.toolArgs,
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: result.message,
          data: { label: result.label, rowCount: result.rowCount, rows: result.rows.slice(0, 20) },
        };
      }
      case "propose_ops_change": {
        if (!opts.githubAdapter) {
          return {
            display: readyTool.display,
            status: "error",
            message: "GitHub adapter が worker に注入されていません。",
          };
        }
        const result = await createOpsChangeProposal({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          input: normalizeOpsProposalInput(readyTool.toolArgs),
          actor: "agent:scheduled-task",
          source: "scheduled-agent",
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `GitOps PR #${result.prNumber} を作成しました。`,
          data: result,
        };
      }
      case "propose_automation_rule": {
        if (!opts.githubAdapter) {
          return {
            display: readyTool.display,
            status: "error",
            message: "GitHub adapter が worker に注入されていません。",
          };
        }
        const result = await createAutomationRuleProposal({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          input: normalizeAutomationRuleProposalInput(readyTool.toolArgs),
          actor: "agent:scheduled-task",
          source: "scheduled-agent",
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `自動化ルール PR #${result.prNumber} を作成しました。`,
          data: result,
        };
      }
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

function toolSignature(tool: AgentToolResult): string | null {
  if (tool.status !== "ready") return null;
  try {
    return `${tool.tool}:${JSON.stringify(tool.toolArgs)}`;
  } catch {
    return tool.tool;
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
  let rootDir =
    typeof opts.tool.toolArgs.root === "string" && opts.tool.toolArgs.root.trim()
      ? opts.tool.toolArgs.root.trim()
      : "";
  if (!rootDir) {
    const checkout = await ensureOpsRepoLocalCheckout({
      prisma: opts.prisma as never,
      workspaceId: opts.workspaceId,
    }).catch(() => null);
    rootDir =
      checkout?.rootDir ??
      (await resolveOpsRepoLocalDirForWorkspace({
        prisma: opts.prisma as never,
        workspaceId: opts.workspaceId,
      })).rootDir ??
      "";
  }
  const baseDir =
    typeof opts.tool.toolArgs.base === "string" && opts.tool.toolArgs.base.trim()
      ? opts.tool.toolArgs.base.trim()
      : process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  if (!rootDir) {
    return {
      display: opts.tool.display,
      status: "error",
      message: "ops repo の local checkout を解決できません。",
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

function normalizeOpsProposalInput(args: Record<string, unknown>): OpsChangeProposalInput {
  const intentRaw = readStringArg(args, "intent")?.toLowerCase().replace(/-/g, "_");
  const intent: OpsChangeProposalInput["intent"] =
    intentRaw === "activate" ||
    intentRaw === "status_change" ||
    intentRaw === "budget_change" ||
    intentRaw === "other"
      ? intentRaw
      : "pause";
  const targets: NonNullable<OpsChangeProposalInput["targets"]> = Array.isArray(args.targets)
    ? args.targets.flatMap((item) => {
        if (!isRecord(item)) return [];
        const level = typeof item.level === "string" ? item.level : "";
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
        if (!id || (level !== "campaign" && level !== "adset" && level !== "ad")) return [];
        return [{ level, id }];
      })
    : [];
  const targetIds = Array.isArray(args.targetIds)
    ? args.targetIds.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
    : [];
  const desiredChanges = isRecord(args.desiredChanges) ? args.desiredChanges : undefined;
  const urgencyRaw = readStringArg(args, "urgency");
  const urgency =
    urgencyRaw === "low" || urgencyRaw === "high" || urgencyRaw === "normal"
      ? urgencyRaw
      : undefined;
  const accountKey = readStringArg(args, "accountKey", "account_key");
  const rationale = readStringArg(args, "rationale");
  return {
    intent,
    ...(accountKey ? { accountKey } : {}),
    ...(targets.length > 0 ? { targets } : {}),
    ...(targetIds.length > 0 ? { targetIds } : {}),
    ...(desiredChanges ? { desiredChanges } : {}),
    ...(rationale ? { rationale } : {}),
    ...(urgency ? { urgency } : {}),
  };
}

function normalizeAutomationRuleProposalInput(
  args: Record<string, unknown>
): AutomationRuleProposalInput {
  const sourceText = readStringArg(args, "sourceText", "source_text", "prompt");
  const rule = isRecord(args.rule) ? args.rule : undefined;
  const rationale = readStringArg(args, "rationale");
  const title = readStringArg(args, "title");
  return {
    ...(sourceText ? { sourceText } : {}),
    ...(rule ? { rule } : {}),
    ...(rationale ? { rationale } : {}),
    ...(title ? { title } : {}),
  };
}

function resolveMetricDateArg(args: Record<string, unknown>): string | null {
  const explicit = readStringArg(args, "metricDate", "metric_date");
  if (explicit) return explicit;
  const relative = readStringArg(args, "metricDateRelative", "metric_date_relative");
  if (!relative) return null;
  const normalized = relative.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "today") return dateStringInRuntimeTimeZone(0);
  if (normalized === "yesterday") return dateStringInRuntimeTimeZone(-1);
  throw new Error("metricDateRelative は today / yesterday のいずれかで指定してください");
}

function dateStringInRuntimeTimeZone(offsetDays: number): string {
  const timeZone =
    process.env.ADDROID_USER_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")?.value ?? "1970");
  const m = Number(parts.find((p) => p.type === "month")?.value ?? "01");
  const d = Number(parts.find((p) => p.type === "day")?.value ?? "01");
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

function reportPreset(value: string): CronPresetName {
  const v = value.trim().toLowerCase().replace(/-/g, "_");
  const name =
    v === "daily" || v === "report" || v === "daily_report"
      ? "daily_report"
      : v === "today" || v === "current" || v === "today_report"
        ? "today_report"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
