import {
  buildAgentContext,
  buildAgentLoopInput,
  runAgentTurn,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import {
  LocalDiskStorage,
  downloadSlackPrivateFile,
  getSlackFileInfo,
  postSlackMessage,
  type SlackFetch,
} from "@addroid/config";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import type { LLMProvider } from "@addroid/llm-provider";
import path from "node:path";
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
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
  };
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
    const referenceImagePaths = await loadSlackReferenceImages(opts);
    const agentInput = appendSlackReferenceImageContext(
      opts.payload.text,
      referenceImagePaths
    );
    const seenTools = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const turn = await runAgentTurn({
        input: buildAgentLoopInput(agentInput, executions),
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
            provider: opts.provider,
            referenceImagePaths,
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

const SLACK_REFERENCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
async function loadSlackReferenceImages(opts: RunSlackAgentJobOptions): Promise<string[]> {
  const files = opts.payload.files ?? [];
  if (files.length === 0) {
    if (opts.payload.text.includes("添付") || opts.payload.text.includes("画像")) {
      opts.logger?.warn(
        `[worker] slack_agent reference images: no Slack files in payload (${opts.payload.eventType} ${opts.payload.slackChannelId}:${opts.payload.eventTs})`
      );
    }
    return [];
  }
  opts.logger?.info(
    `[worker] slack_agent reference images: ${files.length} Slack file(s) in payload (${opts.payload.eventType} ${opts.payload.slackChannelId}:${opts.payload.eventTs})`
  );
  const storage = new LocalDiskStorage({ env: process.env });
  await storage.ensureRoot();
  const dir = `slack-agent-uploads/${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const paths: string[] = [];
  for (const fileRef of files.slice(0, 4)) {
    try {
      const info = await getSlackFileInfo(
        opts.botToken,
        fileRef.id,
        opts.slackFetch ?? (globalThis.fetch as unknown as SlackFetch)
      );
      const mimeType = normalizeSlackImageMime(info.mimetype ?? fileRef.mimetype ?? null);
      if (!mimeType) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: unsupported mime file=${fileRef.id} mime=${info.mimetype ?? fileRef.mimetype ?? "unknown"}`
        );
        continue;
      }
      const size = typeof info.size === "number" ? info.size : fileRef.size;
      if (typeof size === "number" && size > SLACK_REFERENCE_IMAGE_MAX_BYTES) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: too large file=${fileRef.id} size=${size}`
        );
        continue;
      }
      const url = info.url_private_download ?? info.url_private;
      if (!url) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: no private URL file=${fileRef.id}`
        );
        continue;
      }
      const downloaded = await downloadSlackPrivateFile(
        opts.botToken,
        url,
        opts.slackFetch ?? (globalThis.fetch as unknown as SlackFetch)
      );
      if (downloaded.bytes.byteLength > SLACK_REFERENCE_IMAGE_MAX_BYTES) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: downloaded too large file=${fileRef.id} size=${downloaded.bytes.byteLength}`
        );
        continue;
      }
      const downloadedMime = normalizeSlackImageMime(downloaded.contentType) ?? mimeType;
      const filename = safeSlackFilename(
        info.name ?? info.title ?? fileRef.name ?? fileRef.id,
        extensionForMime(downloadedMime)
      );
      const key = `${dir}/${filename}`;
      const written = await storage.write(key, downloaded.bytes);
      paths.push(written.path);
      opts.logger?.info(
        `[worker] slack_agent reference image saved: file=${fileRef.id} path=${written.path}`
      );
    } catch (err) {
      opts.logger?.warn(
        `[worker] slack_agent reference image failed: file=${fileRef.id} error=${(err as Error).message}`
      );
      continue;
    }
  }
  if (paths.length === 0) {
    opts.logger?.warn(
      `[worker] slack_agent reference images: no usable image files (${opts.payload.eventType} ${opts.payload.slackChannelId}:${opts.payload.eventTs})`
    );
  }
  return paths;
}

function appendSlackReferenceImageContext(input: string, paths: string[]): string {
  if (paths.length === 0) return input;
  return [
    input,
    "",
    "Slack 添付画像はこのローカルパスに保存済みです。",
    "新しいクリエイティブ案だけを生成する場合は generate_creatives の referenceImagePaths にこの配列を指定してください。",
    "/creatives の Creative ID を指定して入稿PRに回す場合は promote_creative_submission を使ってください。配信先や既存広告と同じページ/遷移先が未確定なら、先に resolve_creative_submission_context を使ってください。",
    "広告作成・入稿・PR作成を明示された場合は propose_creative_submission の referenceImagePaths に指定してください。",
    "遷移先URLが依頼文にある場合は generate_creatives / propose_creative_submission / promote_creative_submission の linkUrl または destinationUrl に指定してください。",
    "添付そのものを最終広告素材として入稿する場合だけ localMediaPaths に指定してください。",
    JSON.stringify(paths),
  ].join("\n");
}

function normalizeSlackImageMime(value: string | null | undefined): "image/png" | "image/jpeg" | "image/webp" | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/png") return "image/png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "image/jpeg";
  if (mime === "image/webp") return "image/webp";
  return null;
}

function extensionForMime(mime: "image/png" | "image/jpeg" | "image/webp"): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

function safeSlackFilename(value: string, fallbackExtension: string): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!base || base === "." || base === ".." || base.includes(path.sep)) {
    return `slack-reference-${Date.now().toString(36)}${fallbackExtension}`;
  }
  return /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `${base}${fallbackExtension}`;
}

function formatSlackAgentReply(
  message: string,
  executions: Array<{ display: string; status: string; message: string }>,
  failed: boolean
): string {
  const lines = [failed ? "完了しましたが、一部の処理で問題がありました。" : "完了しました。"];
  if (message.trim()) lines.push("", sanitizeText(message.trim()));
  const visibleExecutions = executions.filter(isSlackVisibleExecution);
  if (visibleExecutions.length > 0) {
    lines.push("", "実行内容:");
    for (const execution of visibleExecutions.slice(0, 8)) {
      lines.push(
        `- ${sanitizeText(execution.display)}: ${execution.status} - ${sanitizeText(execution.message)}`
      );
    }
    if (visibleExecutions.length > 8) {
      lines.push(`- ...ほか ${visibleExecutions.length - 8} 件`);
    }
  }
  const text = lines.join("\n");
  return text.length > 3500 ? `${text.slice(0, 3490)}...` : text;
}

function isSlackVisibleExecution(execution: { display: string; status: string }): boolean {
  if (execution.status !== "ok") return true;
  return execution.display !== "Meta Ads CLI read-only query";
}
