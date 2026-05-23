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
  const sourceContextDefaults = promotionDefaultsFromSourceCreative(sourceCreative.parameters);
  const promotionInput = mergePromotionDefaults(opts.input, sourceContextDefaults);
  const promotionAttemptId = makePromotionAttemptId();
  const promotedCreativeName = withPromotionAttemptSuffix(
    promotionInput.creativeName ?? sourceCreative.displayName ?? sourceCreative.key,
    promotionAttemptId
  );
  const promotedAdName = withPromotionAttemptSuffix(
    promotionInput.adName ?? `${sourceCreative.displayName ?? sourceCreative.key} ad`,
    promotionAttemptId
  );
  const callToAction =
    promotionInput.callToAction ??
    inferInstagramProfileCallToAction(promotionInput) ??
    adText?.callToAction ??
    undefined;
  const submissionInput: CreativeSubmissionInput = {
    ...promotionInput,
    accountKey: promotionInput.accountKey ?? sourceCreative.account.key,
    creativeName: promotedCreativeName,
    adName: promotedAdName,
    prompt: sourceCreative.prompt ?? undefined,
    headline: promotionInput.headline ?? adText?.headline ?? undefined,
    primaryText: promotionInput.primaryText ?? adText?.primaryText ?? undefined,
    description: promotionInput.description ?? adText?.description ?? undefined,
    callToAction,
    mediaType: uploadedMedia.length > 0 ? mediaTypeFromStoredCreative(sourceCreative.mediaType) : "text",
    uploadedMedia: uploadedMedia.length > 0 ? uploadedMedia : undefined,
    rationale:
      promotionInput.rationale ??
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
    placementMode: readPlacementMode(args.placementMode ?? args.placement_mode ?? args.submissionPlacementMode) ?? undefined,
    inheritFromCampaignId: readString(
      args.inheritFromCampaignId ?? args.inherit_from_campaign_id ?? args.sourceCampaignId ?? args.source_campaign_id
    ) ?? undefined,
    inheritFromAdsetId: readString(
      args.inheritFromAdsetId ?? args.inherit_from_adset_id ?? args.sourceAdsetId ?? args.source_adset_id
    ) ?? undefined,
    inheritFromAdId: readString(
      args.inheritFromAdId ?? args.inherit_from_ad_id ?? args.sourceAdId ?? args.source_ad_id ?? args.existingAdId ?? args.existing_ad_id
    ) ?? undefined,
    creativeName: readString(args.creativeName) ?? undefined,
    adName: readString(args.adName) ?? undefined,
    headline: readString(args.headline) ?? undefined,
    primaryText: readString(args.primaryText) ?? undefined,
    callToAction: readMetaEnumToken(args.callToAction) ?? undefined,
    pageId: readString(args.pageId) ?? undefined,
    title: readString(args.title) ?? undefined,
    body: readString(args.body) ?? undefined,
    linkUrl: readString(args.linkUrl ?? args.destinationUrl) ?? undefined,
    description: readString(args.description) ?? undefined,
    instagramUserId: readString(args.instagramUserId) ?? undefined,
    instagramActorId: readString(args.instagramActorId) ?? undefined,
    instagramAppLink: readString(args.instagramAppLink) ?? undefined,
    campaignId: readString(args.campaignId) ?? undefined,
    adsetId: readString(args.adsetId) ?? undefined,
    campaignName: readString(args.campaignName) ?? undefined,
    adsetName: readString(args.adsetName) ?? undefined,
    objective: (readString(args.objective) ?? undefined) as CreativePromotionInput["objective"] | undefined,
    dailyBudget: readNumber(args.dailyBudget) ?? undefined,
    lifetimeBudget: readNumber(args.lifetimeBudget) ?? undefined,
    campaignDailyBudget: readNumber(args.campaignDailyBudget ?? args.campaign_daily_budget) ?? undefined,
    campaignLifetimeBudget: readNumber(args.campaignLifetimeBudget ?? args.campaign_lifetime_budget) ?? undefined,
    adsetDailyBudget: readNumber(args.adsetDailyBudget ?? args.adset_daily_budget) ?? undefined,
    adsetLifetimeBudget: readNumber(args.adsetLifetimeBudget ?? args.adset_lifetime_budget) ?? undefined,
    adsetBudgetSharing: readBoolean(args.adsetBudgetSharing ?? args.adset_budget_sharing) ?? undefined,
    campaignBidStrategy: readMetaEnumToken(args.campaignBidStrategy ?? args.campaign_bid_strategy) ?? undefined,
    campaignSpendCap: readNumber(args.campaignSpendCap ?? args.campaign_spend_cap) ?? undefined,
    campaignStartTime: readString(args.campaignStartTime ?? args.campaign_start_time) ?? undefined,
    campaignStopTime: readString(args.campaignStopTime ?? args.campaign_stop_time) ?? undefined,
    specialAdCategoryCountry: readStringArray(args.specialAdCategoryCountry ?? args.special_ad_category_country),
    isAdsetBudgetSharingEnabled: readBoolean(args.isAdsetBudgetSharingEnabled ?? args.is_adset_budget_sharing_enabled) ?? undefined,
    campaignPacingType: readStringArray(args.campaignPacingType ?? args.campaign_pacing_type),
    optimizationGoal: readMetaEnumToken(args.optimizationGoal ?? args.optimization_goal) ?? undefined,
    optimizationSubEvent: readMetaEnumToken(args.optimizationSubEvent ?? args.optimization_sub_event) ?? undefined,
    billingEvent: readMetaEnumToken(args.billingEvent ?? args.billing_event) ?? undefined,
    adsetBidStrategy: readMetaEnumToken(args.adsetBidStrategy ?? args.adset_bid_strategy ?? args.bidStrategy ?? args.bid_strategy) ?? undefined,
    bidAmount: readNumber(args.bidAmount) ?? undefined,
    bidConstraints: readRecord(args.bidConstraints ?? args.bid_constraints) ?? undefined,
    startTime: readString(args.startTime) ?? undefined,
    endTime: readString(args.endTime) ?? undefined,
    attributionSpec: readRecordArray(args.attributionSpec ?? args.attribution_spec),
    destinationType: readMetaEnumToken(args.destinationType ?? args.destination_type) ?? undefined,
    frequencyControlSpecs: readRecordArray(args.frequencyControlSpecs ?? args.frequency_control_specs),
    adsetSchedule: readRecordArray(args.adsetSchedule ?? args.adset_schedule),
    adsetPacingType: readStringArray(args.adsetPacingType ?? args.adset_pacing_type),
    dailySpendCap: readNumber(args.dailySpendCap ?? args.daily_spend_cap) ?? undefined,
    lifetimeSpendCap: readNumber(args.lifetimeSpendCap ?? args.lifetime_spend_cap) ?? undefined,
    dailyMinSpendTarget: readNumber(args.dailyMinSpendTarget ?? args.daily_min_spend_target) ?? undefined,
    lifetimeMinSpendTarget: readNumber(args.lifetimeMinSpendTarget ?? args.lifetime_min_spend_target) ?? undefined,
    isDynamicCreative: readBoolean(args.isDynamicCreative ?? args.is_dynamic_creative) ?? undefined,
    pixelId: readString(args.pixelId) ?? undefined,
    customEventType: (readString(args.customEventType) ?? undefined) as CreativePromotionInput["customEventType"] | undefined,
    objectStorySpec: readRecord(args.objectStorySpec ?? args.object_story_spec) ?? undefined,
    assetFeedSpec: readRecord(args.assetFeedSpec ?? args.asset_feed_spec) ?? undefined,
    degreesOfFreedomSpec: readRecord(args.degreesOfFreedomSpec ?? args.degrees_of_freedom_spec) ?? undefined,
    urlTags: readString(args.urlTags ?? args.url_tags) ?? undefined,
    platformCustomizations: readRecord(args.platformCustomizations ?? args.platform_customizations) ?? undefined,
    videoId: readString(args.videoId ?? args.video_id) ?? undefined,
    productSetId: readString(args.productSetId ?? args.product_set_id) ?? undefined,
    destinationSetId: readString(args.destinationSetId ?? args.destination_set_id) ?? undefined,
    adPixelId: readString(args.adPixelId) ?? undefined,
    conversionSpecs: readRecord(args.conversionSpecs ?? args.conversion_specs) ?? readRecordArray(args.conversionSpecs ?? args.conversion_specs) ?? undefined,
    conversionDomain: readString(args.conversionDomain ?? args.conversion_domain) ?? undefined,
    creativeAssetGroupsSpec: readRecord(args.creativeAssetGroupsSpec ?? args.creative_asset_groups_spec) ?? undefined,
    engagementAudience: readBoolean(args.engagementAudience ?? args.engagement_audience) ?? undefined,
    trackingSpecs: readRecord(args.trackingSpecs ?? args.tracking_specs) ?? readRecordArray(args.trackingSpecs ?? args.tracking_specs) ?? undefined,
    countries: readStringArray(args.countries),
    ageMin: readNumber(args.ageMin) ?? undefined,
    ageMax: readNumber(args.ageMax) ?? undefined,
    targeting: readRecord(args.targeting) ?? undefined,
    geoLocations: readRecord(args.geoLocations ?? args.geo_locations) ?? undefined,
    campaignGraphPayload: readRecord(args.campaignGraphPayload ?? args.campaign_graph_payload) ?? undefined,
    adsetGraphPayload: readRecord(args.adsetGraphPayload ?? args.adset_graph_payload) ?? undefined,
    creativeGraphPayload: readRecord(args.creativeGraphPayload ?? args.creative_graph_payload) ?? undefined,
    adGraphPayload: readRecord(args.adGraphPayload ?? args.ad_graph_payload) ?? undefined,
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

function promotionDefaultsFromSourceCreative(parameters: unknown): Partial<CreativeSubmissionInput> {
  const root = jsonObject(parameters);
  const creativeContext = jsonObject(root.creativeContext);
  const target = jsonObject(creativeContext.target);
  const creative = jsonObject(target.creative);
  const targetHierarchy = readString(target.hierarchy)?.toLowerCase();
  const sourceAdId =
    targetHierarchy === "ad"
      ? readString(target.externalId ?? target.external_id ?? target.nodeKey ?? target.node_key)
      : null;
  return {
    pageId: readString(creative.pageId) ?? undefined,
    linkUrl: readString(creative.linkUrl) ?? undefined,
    instagramUserId: readString(creative.instagramUserId) ?? undefined,
    inheritFromAdId: sourceAdId ?? undefined,
  };
}

function mergePromotionDefaults(
  input: CreativePromotionInput,
  defaults: Partial<CreativeSubmissionInput>
): CreativePromotionInput {
  return {
    ...input,
    pageId: input.pageId?.trim() || defaults.pageId,
    linkUrl: input.linkUrl?.trim() || defaults.linkUrl,
    instagramUserId: input.instagramUserId?.trim() || defaults.instagramUserId,
    inheritFromAdId: input.inheritFromAdId?.trim() || defaults.inheritFromAdId,
  };
}

function inferInstagramProfileCallToAction(input: CreativePromotionInput): string | undefined {
  const destinationType = readString(input.destinationType)?.toUpperCase();
  const linkUrl = readString(input.linkUrl)?.toLowerCase();
  const hasInstagramActor = Boolean(input.instagramActorId || input.instagramUserId || input.instagramAppLink);
  if (destinationType === "INSTAGRAM_PROFILE") return "VIEW_INSTAGRAM_PROFILE";
  if (hasInstagramActor && input.instagramAppLink) return "VIEW_INSTAGRAM_PROFILE";
  if (hasInstagramActor && linkUrl && /(^https?:\/\/)?(www\.)?instagram\.com\//.test(linkUrl)) {
    return "VIEW_INSTAGRAM_PROFILE";
  }
  return undefined;
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

function readPlacementMode(value: unknown): CreativePromotionInput["placementMode"] | null {
  const normalized = readString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "existing_adset" || normalized === "existing_ad_set") return "existing_adset";
  if (normalized === "new_adset" || normalized === "new_ad_set") return "new_adset";
  if (normalized === "new_campaign") return "new_campaign";
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

function readRecordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(isRecord);
  return out.length > 0 ? out : undefined;
}

function readMetaEnumToken(value: unknown): string | undefined {
  const v = readString(value)?.toUpperCase();
  return v && /^[A-Z][A-Z0-9_]*$/.test(v) ? v : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
