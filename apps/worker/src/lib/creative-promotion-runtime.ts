import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalDiskStorage } from "@addroid/config";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import type { LLMProvider } from "@addroid/llm-provider";
import {
  createCreativeSubmissionProposal,
  type CreativeSubmissionInput,
  type CreativeSubmissionResult,
  type CreativeSubmissionSource,
  type UploadedCreativeMedia,
} from "./creative-submission-runtime.js";

export interface CreativePromotionInput extends Omit<CreativeSubmissionInput, "uploadedMedia" | "localMediaPaths" | "uploadedReferenceMedia" | "referenceImagePaths" | "generateImage" | "prompt"> {
  creativeId: string;
}

export interface CreativePromotionResult extends CreativeSubmissionResult {
  sourceCreativeId: string;
}

export interface CreativePromotionBatchInput extends Omit<CreativePromotionInput, "creativeId"> {
  creativeIds: string[];
}

export interface CreativePromotionBatchResult {
  sourceCreativeIds: string[];
  results: CreativePromotionResult[];
  count: number;
  prNumbers: number[];
  htmlUrls: string[];
}

export async function createCreativePromotionProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: CreativePromotionInput;
  actor: string;
  source: CreativeSubmissionSource;
  env?: NodeJS.ProcessEnv;
  llmProvider?: LLMProvider | null;
}): Promise<CreativePromotionResult> {
  const env = opts.env ?? process.env;
  const sourceCreative = await opts.prisma.creative.findFirst({
    where: {
      id: opts.input.creativeId,
      account: { workspaceId: opts.workspaceId },
    },
    select: {
      id: true,
      accountId: true,
      pullRequestId: true,
      key: true,
      displayName: true,
      mediaType: true,
      status: true,
      prompt: true,
      parameters: true,
      storagePath: true,
      spec: true,
      account: {
        select: { key: true, displayName: true },
      },
      pullRequest: {
        select: { number: true, htmlUrl: true },
      },
    },
  });

  if (!sourceCreative) {
    throw new Error(`Creative ${opts.input.creativeId} が見つかりません。`);
  }
  if (sourceCreative.status === "qa_failed") {
    throw new Error("QA failed の生成クリエイティブは入稿PRに回せません。別案を選ぶか再生成してください。");
  }

  const adText = parseCreativeAdText(sourceCreative.spec);
  const uploadedMedia = await loadSourceCreativeMedia({
    storagePath: sourceCreative.storagePath,
    mediaType: sourceCreative.mediaType,
    env,
  });
  const promotionAttemptId = makePromotionAttemptId();
  const promotedCreativeName = withPromotionAttemptSuffix(
    opts.input.creativeName ?? sourceCreative.displayName ?? sourceCreative.key,
    promotionAttemptId
  );
  const promotedAdName = withPromotionAttemptSuffix(
    opts.input.adName ?? `${sourceCreative.displayName ?? sourceCreative.key} ad`,
    promotionAttemptId
  );
  const submissionInput: CreativeSubmissionInput = {
    ...opts.input,
    accountKey: opts.input.accountKey ?? sourceCreative.account.key,
    creativeName: promotedCreativeName,
    adName: promotedAdName,
    prompt: sourceCreative.prompt ?? undefined,
    headline: opts.input.headline ?? adText?.headline ?? undefined,
    primaryText: opts.input.primaryText ?? adText?.primaryText ?? undefined,
    description: opts.input.description ?? adText?.description ?? undefined,
    callToAction: opts.input.callToAction ?? adText?.callToAction ?? undefined,
    mediaType: uploadedMedia.length > 0 ? mediaTypeFromStoredCreative(sourceCreative.mediaType) : "text",
    uploadedMedia: uploadedMedia.length > 0 ? uploadedMedia : undefined,
    rationale:
      opts.input.rationale ??
      `Generated creative ${sourceCreative.id} (${sourceCreative.displayName}) promoted to a GitOps submission PR.`,
  };

  const result = await createCreativeSubmissionProposal({
    prisma: opts.prisma,
    githubAdapter: opts.githubAdapter,
    workspaceId: opts.workspaceId,
    input: submissionInput,
    actor: opts.actor,
    source: opts.source,
    env,
    llmProvider: opts.llmProvider ?? null,
  });

  const promotedAt = new Date().toISOString();
  const promotionRecord = {
    prNumber: result.prNumber,
    pullRequestId: result.pullRequestId,
    submissionCreativeId: result.creativeId,
    submissionAdId: result.adId,
    promotedAt,
  };
  await opts.prisma.creative.update({
    where: { id: sourceCreative.id },
    data: {
      pullRequestId: result.pullRequestId,
      status: "attached_to_pr",
      parameters: appendPromotionHistory(sourceCreative.parameters, promotionRecord) as Prisma.InputJsonValue,
    },
  });
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "creative.promoted_to_submission_pr",
      target: `creative:${sourceCreative.id}`,
      ref: String(result.prNumber),
      metadata: {
        source: opts.source,
        accountKey: submissionInput.accountKey,
        sourceCreativeId: sourceCreative.id,
        submissionCreativeId: result.creativeId,
        submissionAdId: result.adId,
        pullRequestId: result.pullRequestId,
        prNumber: result.prNumber,
        previousPullRequestId: sourceCreative.pullRequestId,
        mediaType: result.mediaType,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    ...result,
    sourceCreativeId: sourceCreative.id,
  };
}

export async function createCreativePromotionProposals(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: CreativePromotionBatchInput;
  actor: string;
  source: CreativeSubmissionSource;
  env?: NodeJS.ProcessEnv;
  llmProvider?: LLMProvider | null;
}): Promise<CreativePromotionBatchResult> {
  const ids = Array.from(new Set(opts.input.creativeIds)).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("入稿PRに回す creativeIds が必要です。");
  }
  const results: CreativePromotionResult[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const creativeId = ids[i]!;
    const batchSuffix = ids.length > 1 ? ` ${i + 1}` : "";
    const { creativeIds: _creativeIds, ...baseInput } = opts.input;
    const result = await createCreativePromotionProposal({
      prisma: opts.prisma,
      githubAdapter: opts.githubAdapter,
      workspaceId: opts.workspaceId,
      input: {
        ...baseInput,
        creativeId,
        creativeName: opts.input.creativeName ? `${opts.input.creativeName}${batchSuffix}` : undefined,
        adName: opts.input.adName ? `${opts.input.adName}${batchSuffix}` : undefined,
      },
      actor: opts.actor,
      source: opts.source,
      env: opts.env,
      llmProvider: opts.llmProvider ?? null,
    });
    results.push(result);
  }
  return {
    sourceCreativeIds: ids,
    results,
    count: results.length,
    prNumbers: results.map((result) => result.prNumber),
    htmlUrls: results.map((result) => result.htmlUrl),
  };
}

export function normalizeCreativePromotionInput(args: Record<string, unknown>): CreativePromotionInput {
  const creativeId = readString(args.creativeId ?? args.id);
  if (!creativeId) {
    throw new Error("入稿PRに回す creativeId が必要です。");
  }
  return {
    creativeId,
    accountKey: readString(args.accountKey) ?? undefined,
    creativeName: readString(args.creativeName) ?? undefined,
    adName: readString(args.adName) ?? undefined,
    headline: readString(args.headline) ?? undefined,
    primaryText: readString(args.primaryText) ?? undefined,
    callToAction: (readString(args.callToAction) ?? undefined) as CreativePromotionInput["callToAction"] | undefined,
    pageId: readString(args.pageId) ?? undefined,
    title: readString(args.title) ?? undefined,
    body: readString(args.body) ?? undefined,
    linkUrl: readString(args.linkUrl ?? args.destinationUrl) ?? undefined,
    description: readString(args.description) ?? undefined,
    instagramUserId: readString(args.instagramUserId) ?? undefined,
    campaignId: readString(args.campaignId) ?? undefined,
    adsetId: readString(args.adsetId) ?? undefined,
    campaignName: readString(args.campaignName) ?? undefined,
    adsetName: readString(args.adsetName) ?? undefined,
    objective: (readString(args.objective) ?? undefined) as CreativePromotionInput["objective"] | undefined,
    dailyBudget: readNumber(args.dailyBudget) ?? undefined,
    lifetimeBudget: readNumber(args.lifetimeBudget) ?? undefined,
    adsetBudgetSharing: readBoolean(args.adsetBudgetSharing) ?? undefined,
    optimizationGoal: readString(args.optimizationGoal) ?? undefined,
    billingEvent: readString(args.billingEvent) ?? undefined,
    bidAmount: readNumber(args.bidAmount) ?? undefined,
    startTime: readString(args.startTime) ?? undefined,
    endTime: readString(args.endTime) ?? undefined,
    pixelId: readString(args.pixelId) ?? undefined,
    customEventType: (readString(args.customEventType) ?? undefined) as CreativePromotionInput["customEventType"] | undefined,
    adPixelId: readString(args.adPixelId) ?? undefined,
    trackingSpecs: readRecord(args.trackingSpecs) ?? undefined,
    countries: readStringArray(args.countries),
    ageMin: readNumber(args.ageMin) ?? undefined,
    ageMax: readNumber(args.ageMax) ?? undefined,
    requestedUnsupportedFields: readStringArray(args.requestedUnsupportedFields),
    rationale: readString(args.rationale) ?? undefined,
    urgency: (readString(args.urgency) ?? undefined) as CreativePromotionInput["urgency"] | undefined,
  };
}

export function normalizeCreativePromotionBatchInput(args: Record<string, unknown>): CreativePromotionBatchInput {
  const creativeIds = readCreativeIds(args);
  if (creativeIds.length === 0) {
    throw new Error("入稿PRに回す creativeId または creativeIds が必要です。");
  }
  const single = normalizeCreativePromotionInput({ ...args, creativeId: creativeIds[0] });
  const { creativeId: _creativeId, ...rest } = single;
  return {
    ...rest,
    creativeIds,
  };
}

function mergeJsonObject(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...extra };
}

function appendPromotionHistory(
  parameters: unknown,
  record: Record<string, unknown>
): Record<string, unknown> {
  const base = jsonObject(parameters);
  const existingHistory = Array.isArray(base.promotedToSubmissionPrHistory)
    ? base.promotedToSubmissionPrHistory.filter(isRecord)
    : [];
  const legacyLatest = isRecord(base.promotedToSubmissionPr) ? [base.promotedToSubmissionPr] : [];
  return mergeJsonObject(base, {
    promotedToSubmissionPr: record,
    promotedToSubmissionPrHistory: uniquePromotionHistory([...existingHistory, ...legacyLatest, record]).slice(-50),
  });
}

function uniquePromotionHistory(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const history: Record<string, unknown>[] = [];
  for (const item of items) {
    const key = promotionHistoryKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    history.push(item);
  }
  return history;
}

function promotionHistoryKey(item: Record<string, unknown>): string {
  const pullRequestId = readString(item.pullRequestId);
  if (pullRequestId) return `pullRequestId:${pullRequestId}`;
  const submissionCreativeId = readString(item.submissionCreativeId);
  if (submissionCreativeId) return `submissionCreativeId:${submissionCreativeId}`;
  if (typeof item.prNumber === "number" && Number.isFinite(item.prNumber)) {
    return `prNumber:${item.prNumber}`;
  }
  return JSON.stringify(item);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function makePromotionAttemptId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function withPromotionAttemptSuffix(value: string, attemptId: string): string {
  const base = value.trim() || "creative";
  return `${base} submission ${attemptId}`;
}

async function loadSourceCreativeMedia(input: {
  storagePath: string | null;
  mediaType: string;
  env: NodeJS.ProcessEnv;
}): Promise<UploadedCreativeMedia[]> {
  if (!input.storagePath) return [];
  const mediaType = mediaTypeFromStoredCreative(input.mediaType);
  if (mediaType !== "image" && mediaType !== "video") return [];
  const storage = new LocalDiskStorage({ env: input.env });
  const bytes = await storage.read(input.storagePath);
  return [
    {
      filename: path.posix.basename(input.storagePath),
      mimeType: mimeTypeForFilename(input.storagePath),
      bytes,
    },
  ];
}

function mediaTypeFromStoredCreative(mediaType: string): "image" | "video" | "carousel" | "text" {
  if (mediaType === "image" || mediaType === "video" || mediaType === "carousel") return mediaType;
  return "text";
}

interface CreativeAdText {
  primaryText?: string | null;
  headline?: string | null;
  description?: string | null;
  callToAction?: string | null;
}

function parseCreativeAdText(spec: unknown): CreativeAdText | null {
  if (!isRecord(spec)) return null;
  const adText = isRecord(spec.adText) ? spec.adText : spec;
  const primaryText = readString(adText.primaryText);
  const headline = readString(adText.headline);
  const description = readString(adText.description);
  const callToAction = readString(adText.callToAction);
  if (!primaryText && !headline && !description && !callToAction) return null;
  return { primaryText, headline, description, callToAction };
}

function mimeTypeForFilename(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCreativeIds(args: Record<string, unknown>): string[] {
  const ids = readStringArray(args.creativeIds) ?? readStringArray(args.creativeId) ?? readStringArray(args.id) ?? [];
  return Array.from(new Set(ids)).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof value === "string") {
    const arr = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
