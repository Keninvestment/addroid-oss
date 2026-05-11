import cronParser from "cron-parser";
import { Prisma } from "@addroid/db";
import { resolveCronScheduleTimeZone, validateCronExpression } from "@addroid/queue";
import { prisma } from "./prisma";
import { ensureWebWorkspace } from "./github-runtime";
import { getQueueBoss } from "./queue-runtime";
import {
  createOrReuseAgentTask,
  normalizeAgentTaskPrompt,
} from "../../worker/src/lib/agent-task-store";
import {
  cancelAgentTaskNextRun as cancelScheduledAgentTaskRun,
  enqueueAgentTaskNow as enqueueScheduledAgentTaskNow,
  scheduleAgentTaskNextRun as scheduleScheduledAgentTaskRun,
} from "../../worker/src/lib/agent-task-runtime";

export interface CreateAgentTaskInput {
  title?: string;
  prompt: string;
  cron: string;
  createdBy?: string;
  nextRunAt?: Date;
}

export function computeNextRunAt(cron: string, currentDate = new Date()): Date {
  const interval = cronParser.parseExpression(cron, {
    currentDate,
    tz: resolveCronScheduleTimeZone(),
  });
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
  const boss = await getQueueBoss();
  const normalizedPrompt = normalizeAgentTaskPrompt(prompt);
  const title = input.title?.trim() || deriveTaskTitle(normalizedPrompt);
  const nextRunAt = input.nextRunAt ?? computeNextRunAt(cron);
  const { task, created } = await createOrReuseAgentTask(prisma as never, {
    workspaceId: workspace.id,
    title,
    prompt: normalizedPrompt,
    cron,
    nextRunAt,
    createdBy: input.createdBy ?? "user:web-ui",
  });
  const scheduled = await scheduleScheduledAgentTaskRun({
    prisma,
    boss,
    workspaceId: workspace.id,
    taskId: task.id,
  });
  await prisma.auditLog
    .create({
      data: {
        workspaceId: workspace.id,
        actor: input.createdBy ?? "user:web-ui",
        action: created ? "agent_task.created" : "agent_task.reused",
        target: `agent_task:${task.id}`,
        metadata: {
          title,
          cron,
          prompt: normalizedPrompt,
          created,
          scheduledJobId: scheduled?.jobId ?? null,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return task;
}

export async function setAgentTaskEnabled(id: string, enabled: boolean) {
  const workspace = await ensureWebWorkspace();
  const boss = await getQueueBoss();
  if (!enabled) {
    await cancelScheduledAgentTaskRun({
      prisma,
      boss,
      workspaceId: workspace.id,
      taskId: id,
    });
  }
  const task = await prisma.agentTask.update({
    where: { id },
    data: { enabled },
    select: {
      id: true,
      title: true,
      prompt: true,
      cron: true,
      enabled: true,
      nextRunAt: true,
    },
  });
  const scheduled = enabled
    ? await scheduleScheduledAgentTaskRun({
        prisma,
        boss,
        workspaceId: workspace.id,
        taskId: id,
      })
    : null;
  await prisma.auditLog
    .create({
      data: {
        workspaceId: workspace.id,
        actor: "user:web-ui",
        action: enabled ? "agent_task.enabled" : "agent_task.disabled",
        target: `agent_task:${id}`,
        metadata: {
          enabled,
          scheduledJobId: scheduled?.jobId ?? null,
        } as Prisma.InputJsonValue,
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
  const boss = await getQueueBoss();
  const jobId = await enqueueScheduledAgentTaskNow({
    boss,
    taskId: task.id,
    requestedBy: "user:web-ui",
  });
  return { jobId, taskId: task.id };
}

function deriveTaskTitle(prompt: string): string {
  const first = prompt.replace(/\s+/g, " ").trim();
  if (first.length <= 40) return first;
  return `${first.slice(0, 39)}…`;
}
