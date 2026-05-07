import cronParser from "cron-parser";
import { Prisma } from "@addroid/db";
import { validateCronExpression } from "@addroid/queue";
import { prisma } from "./prisma";
import { ensureWebWorkspace } from "./github-runtime";
import { runWebAgentChat } from "./agent-chat";

export interface CreateAgentTaskInput {
  title?: string;
  prompt: string;
  cron: string;
}

export function computeNextRunAt(cron: string, currentDate = new Date()): Date {
  const interval = cronParser.parseExpression(cron, { currentDate });
  return interval.next().toDate();
}

export async function createAgentTask(input: CreateAgentTaskInput) {
  const prompt = input.prompt.trim();
  const cron = input.cron.trim();
  if (!prompt) throw new Error("実行内容が空です。");
  const validation = validateCronExpression(cron);
  if (!validation.ok) {
    throw new Error(`cron 式が不正です: ${validation.reason}`);
  }
  const workspace = await ensureWebWorkspace();
  const title = input.title?.trim() || deriveTaskTitle(prompt);
  const nextRunAt = computeNextRunAt(cron);
  const task = await prisma.agentTask.create({
    data: {
      workspaceId: workspace.id,
      title,
      prompt,
      cron,
      enabled: true,
      nextRunAt,
      createdBy: "user:web-ui",
    },
    select: {
      id: true,
      title: true,
      prompt: true,
      cron: true,
      enabled: true,
      nextRunAt: true,
    },
  });
  await prisma.auditLog
    .create({
      data: {
        workspaceId: workspace.id,
        actor: "user:web-ui",
        action: "agent_task.created",
        target: `agent_task:${task.id}`,
        metadata: { title, cron, prompt } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return task;
}

export async function setAgentTaskEnabled(id: string, enabled: boolean) {
  const workspace = await ensureWebWorkspace();
  const data = enabled
    ? { enabled, nextRunAt: computeNextRunAt((await loadTaskCron(id, workspace.id)) ?? "* * * * *") }
    : { enabled, nextRunAt: null };
  const task = await prisma.agentTask.update({
    where: { id },
    data,
    select: {
      id: true,
      title: true,
      prompt: true,
      cron: true,
      enabled: true,
      nextRunAt: true,
    },
  });
  await prisma.auditLog
    .create({
      data: {
        workspaceId: workspace.id,
        actor: "user:web-ui",
        action: enabled ? "agent_task.enabled" : "agent_task.disabled",
        target: `agent_task:${id}`,
        metadata: { enabled } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return task;
}

export async function runAgentTaskNow(id: string) {
  const workspace = await ensureWebWorkspace();
  const task = await prisma.agentTask.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true, title: true, prompt: true, cron: true },
  });
  if (!task) throw new Error("Agent task が見つかりません。");
  const run = await prisma.agentTaskRun.create({
    data: {
      workspaceId: workspace.id,
      taskId: task.id,
      status: "running",
    },
    select: { id: true },
  });
  try {
    const result = await runWebAgentChat(task.prompt);
    const failed = !result.ok || result.executions.some((e) => e.status === "error");
    await prisma.agentTaskRun.update({
      where: { id: run.id },
      data: {
        status: failed ? "failed" : "succeeded",
        finishedAt: new Date(),
        message: result.message,
        toolCalls: result.executions as unknown as Prisma.InputJsonValue,
        errorMessage: failed
          ? result.executions.find((e) => e.status === "error")?.message ?? "agent task failed"
          : null,
      },
    });
    await prisma.agentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: new Date(),
        lastState: failed ? "failed" : "success",
        nextRunAt: computeNextRunAt(task.cron),
      },
    });
    return { runId: run.id, ...result };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.agentTaskRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: message,
      },
    });
    await prisma.agentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: new Date(),
        lastState: "failed",
        nextRunAt: computeNextRunAt(task.cron),
      },
    });
    throw err;
  }
}

async function loadTaskCron(id: string, workspaceId: string): Promise<string | null> {
  const row = await prisma.agentTask.findFirst({
    where: { id, workspaceId },
    select: { cron: true },
  });
  return row?.cron ?? null;
}

function deriveTaskTitle(prompt: string): string {
  const first = prompt.replace(/\s+/g, " ").trim();
  if (first.length <= 40) return first;
  return `${first.slice(0, 39)}…`;
}
