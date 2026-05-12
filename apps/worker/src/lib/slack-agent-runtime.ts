import {
  buildAgentContext,
  buildAgentLoopInput,
  runAgentTurn,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import { postSlackMessage, type SlackFetch } from "@addroid/config";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import type { LLMProvider } from "@addroid/llm-provider";
import type PgBoss from "pg-boss";
import {
  sanitizeText,
  type SlackAgentJobPayload,
} from "@addroid/queue";
import { executeWorkerAgentTool } from "./agent-task-runtime.js";

export interface RunSlackAgentJobOptions {
  payload: SlackAgentJobPayload;
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
  botToken: string;
  githubAdapter?: GithubAdapter;
  slackFetch?: SlackFetch;
  webUrl?: string;
}

export interface SlackAgentJobResult {
  status: "succeeded" | "failed";
  durationMs: number;
  postedProcessing: boolean;
  postedFinal: boolean;
}

export async function runSlackAgentJob(
  opts: RunSlackAgentJobOptions
): Promise<SlackAgentJobResult> {
  const started = Date.now();
  let postedProcessing = false;
  let postedFinal = false;
  const threadTs = opts.payload.threadTs || opts.payload.eventTs;
  const actor = `slack:${opts.payload.slackUserId}`;

  try {
    await postSlackMessage(
      opts.botToken,
      opts.payload.slackChannelId,
      "受け付けました。AdDroid Agent が確認しています...",
      {
        threadTs,
        ...(opts.slackFetch ? { fetchImpl: opts.slackFetch } : {}),
      }
    );
    postedProcessing = true;
  } catch {
    postedProcessing = false;
  }

  const executions: Array<{
    display: string;
    status: string;
    message: string;
    data?: unknown;
  }> = [];
  let message = "";
  let failed = false;
  try {
    const agentContext = await buildAgentContext(process.env);
    const webUrl = opts.webUrl ?? agentContext.webUrl;
    const seenTools = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const turn = await runAgentTurn({
        input: buildAgentLoopInput(opts.payload.text, executions),
        provider: opts.provider,
        agentContext,
        purpose: "worker:slack-chat",
        surface: "slack-chat",
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
            message: "同じ tool call の繰り返しを防止しました。",
          });
          continue;
        }
        if (signature) seenTools.add(signature);
        executions.push(
          await executeWorkerAgentTool({
            tool,
            prisma: opts.prisma,
            workspaceId: opts.workspaceId,
            boss: opts.boss,
            webUrl,
            githubAdapter: opts.githubAdapter,
            actor,
            source: "slack-chat",
          })
        );
        executedAny = true;
      }
      if (!executedAny) break;
    }
    failed = executions.some((e) =>
      e.status === "error" || e.status === "denied" || e.status === "unsupported"
    );
  } catch (err) {
    failed = true;
    message = `Slack からの Agent 実行に失敗しました: ${(err as Error).message}`;
  }

  const finalText = formatSlackAgentReply(message, executions, failed);
  try {
    await postSlackMessage(
      opts.botToken,
      opts.payload.slackChannelId,
      finalText,
      {
        threadTs,
        ...(opts.slackFetch ? { fetchImpl: opts.slackFetch } : {}),
      }
    );
    postedFinal = true;
  } catch {
    postedFinal = false;
  }

  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      action: "agent.chat_via_slack",
      actor,
      target: `slack:${opts.payload.slackChannelId}:${threadTs}`,
      metadata: {
        eventType: opts.payload.eventType,
        slackTeamId: opts.payload.slackTeamId ?? null,
        slackChannelId: opts.payload.slackChannelId,
        slackUserId: opts.payload.slackUserId,
        threadTs,
        input: sanitizeText(opts.payload.text),
        message: sanitizeText(message),
        executions: executions.map((e) => ({
          display: e.display,
          status: e.status,
          message: e.message,
        })),
        postedProcessing,
        postedFinal,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    status: failed ? "failed" : "succeeded",
    durationMs: Date.now() - started,
    postedProcessing,
    postedFinal,
  };
}

function toolSignature(tool: AgentToolResult): string | null {
  if (tool.status !== "ready") return null;
  try {
    return `${tool.tool}:${JSON.stringify(tool.toolArgs)}`;
  } catch {
    return tool.tool;
  }
}

function formatSlackAgentReply(
  message: string,
  executions: Array<{ display: string; status: string; message: string }>,
  failed: boolean
): string {
  const lines = [failed ? "完了しましたが、一部の処理で問題がありました。" : "完了しました。"];
  if (message.trim()) lines.push("", sanitizeText(message.trim()));
  if (executions.length > 0) {
    lines.push("", "実行内容:");
    for (const execution of executions.slice(0, 8)) {
      lines.push(
        `- ${sanitizeText(execution.display)}: ${execution.status} - ${sanitizeText(execution.message)}`
      );
    }
    if (executions.length > 8) {
      lines.push(`- ...ほか ${executions.length - 8} 件`);
    }
  }
  const text = lines.join("\n");
  return text.length > 3500 ? `${text.slice(0, 3490)}...` : text;
}
