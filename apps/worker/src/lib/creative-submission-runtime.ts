import fs from "node:fs";
import path from "node:path";
import { LocalDiskStorage } from "@addroid/config";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import {
  fetchMetaAssetReadiness,
  META_GRAPH_API_VERSION,
  type MetaAssetIdentityCandidate,
} from "@addroid/meta-adapter";
import {
  DEFAULT_CREATIVE_QA_POLICY,
  extractJsonFromLlmContent,
  generateAndQaCreative,
  persistCreativeAssets,
  type CreativeQaPolicy,
  type ImageReferenceInput,
  type ImageProvider,
  type LLMProvider,
} from "@addroid/llm-provider";
import type {
  ImprovementPrCreativeGenerationContext,
  ImprovementPrCreativeNodeContext,
} from "@addroid/queue";
import { loadRecentPerformanceSnapshotContext } from "./improvement-pr-performance-context.js";
import { landingPageUrlForPrompt } from "./creative-landing-page-context.js";
import { enrichCreativeGenerationContext } from "./creative-generation-context.js";
import { selectImageProviderForWorker } from "./image-runtime.js";
import { buildPrismaMetaAdapterSelection } from "./meta-runtime.js";
import {
  createOpsChangeProposal,
  type OperationProposalAction,
} from "./ops-proposal-runtime.js";

export type CreativeSubmissionSource =
  | "web"
  | "web-chat"
  | "cli-chat"
  | "slack-chat"
  | "agent-task";

export interface UploadedCreativeMedia {
  filename: string;
  bytes: Uint8Array;
  mimeType?: string | null;
}

export interface CreativeSubmissionInput {
  accountKey?: string;
  creativeName?: string;
  adName?: string;
  prompt?: string;
  headline?: string;
  primaryText?: string;
  callToAction?: string;
  mediaType?: "image" | "video" | "carousel" | "text";
  localMediaPaths?: string[];
  uploadedMedia?: UploadedCreativeMedia[];
  referenceImagePaths?: string[];
  uploadedReferenceMedia?: UploadedCreativeMedia[];
  generateImage?: boolean;
  pageId?: string;
  title?: string;
  body?: string;
  linkUrl?: string;
  description?: string;
  instagramUserId?: string;
  instagramActorId?: string;
  images?: string[];
  videos?: string[];
  titles?: string[];
  bodies?: string[];
  descriptions?: string[];
  callToActions?: CreativeSubmissionInput["callToAction"][];
  campaignId?: string;
  adsetId?: string;
  campaignName?: string;
  adsetName?: string;
  objective?:
    | "OUTCOME_AWARENESS"
    | "OUTCOME_TRAFFIC"
    | "OUTCOME_ENGAGEMENT"
    | "OUTCOME_LEADS"
    | "OUTCOME_APP_PROMOTION"
    | "OUTCOME_SALES";
  /** Account-currency major units. */
  dailyBudget?: number;
  lifetimeBudget?: number;
  adsetBudgetSharing?: boolean;
  optimizationGoal?: string;
  billingEvent?: string;
  /** Account-currency major units. */
  bidAmount?: number;
  startTime?: string;
  endTime?: string;
  pixelId?: string;
  customEventType?:
    | "ADD_PAYMENT_INFO"
    | "ADD_TO_CART"
    | "ADD_TO_WISHLIST"
    | "COMPLETE_REGISTRATION"
    | "CONTACT"
    | "CONTENT_VIEW"
    | "CUSTOMIZE_PRODUCT"
    | "DONATE"
    | "FIND_LOCATION"
    | "INITIATED_CHECKOUT"
    | "LEAD"
    | "OTHER"
    | "PURCHASE"
    | "SCHEDULE"
    | "SEARCH"
    | "START_TRIAL"
    | "SUBMIT_APPLICATION"
    | "SUBSCRIBE";
  adPixelId?: string;
  trackingSpecs?: Record<string, unknown>;
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  requestedUnsupportedFields?: string[];
  rationale?: string;
  urgency?: "low" | "normal" | "high";
}

export interface CreativeSubmissionResult {
  prNumber: number;
  htmlUrl: string;
  pullRequestId: string;
  headSha: string;
  accountKey: string;
  creativeId: string;
  adId: string;
  mediaType: "image" | "video" | "carousel" | "text";
  storageKeys: string[];
  generatedImage: boolean;
  planOk: boolean;
  planSummary: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const CLI_OPTIMIZATION_GOALS = new Set([
  "APP_INSTALLS",
  "CONVERSATIONS",
  "EVENT_RESPONSES",
  "IMPRESSIONS",
  "LANDING_PAGE_VIEWS",
  "LEAD_GENERATION",
  "LINK_CLICKS",
  "OFFSITE_CONVERSIONS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "REACH",
  "THRUPLAY",
  "VALUE",
]);
const CLI_BILLING_EVENTS = new Set([
  "APP_INSTALLS",
  "CLICKS",
  "IMPRESSIONS",
  "LINK_CLICKS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "THRUPLAY",
]);
const CLI_CREATIVE_CALL_TO_ACTIONS = new Set([
  "APPLY_NOW",
  "BOOK_TRAVEL",
  "BUY_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "GET_OFFER",
  "GET_QUOTE",
  "LEARN_MORE",
  "NO_BUTTON",
  "OPEN_LINK",
  "SHOP_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
  "WATCH_MORE",
]);
const DEFAULT_GENERATED_CTA = "LEARN_MORE";
const META_TEXT_RECOMMENDED_LIMITS = {
  primaryText: 125,
  headline: 40,
  description: 30,
} as const;

export interface CreativeGenerationInput {
  accountKey?: string;
  prompt?: string;
  creativeName?: string;
  linkUrl?: string;
  destinationUrl?: string;
  referenceImagePaths?: string[];
  uploadedReferenceMedia?: UploadedCreativeMedia[];
  variantCount?: number;
}

export interface CreativeGenerationResult {
  accountKey: string;
  accountDisplayName: string;
  creativeIds: string[];
  generatedImage: boolean;
  provider: string | null;
  model: string | null;
  status: string;
  message: string;
}

export type CreativeGenerationSource = "web-chat" | "cli-chat" | "slack-chat" | "agent-task";
type ReferenceImageUsageMode = "abstract_visual_brief" | "direct_image_reference";

interface CreativeTextVariant {
  primaryText: string;
  headline: string;
  description: string;
  callToAction: string;
  rationale: string | null;
}

interface CreativeTextGenerationResult {
  source: "llm" | "fallback";
  variants: CreativeTextVariant[];
  error: string | null;
}

export function normalizeCreativeGenerationInput(args: Record<string, unknown>): CreativeGenerationInput {
  return {
    accountKey: readString(args.accountKey) ?? undefined,
    prompt: readString(args.prompt) ?? undefined,
    creativeName: readString(args.creativeName) ?? undefined,
    linkUrl: readString(args.linkUrl ?? args.destinationUrl) ?? undefined,
    destinationUrl: readString(args.destinationUrl) ?? undefined,
    referenceImagePaths: readStringArray(args.referenceImagePaths),
    variantCount: readPositiveInteger(args.variantCount) ?? undefined,
  };
}

export async function createStandaloneCreativeGeneration(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  input: CreativeGenerationInput;
  actor: string;
  source: CreativeGenerationSource;
  env?: NodeJS.ProcessEnv;
  imageProvider?: ImageProvider | null;
  llmProvider?: LLMProvider | null;
  creativeQaPolicy?: CreativeQaPolicy | null;
}): Promise<CreativeGenerationResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      defaultAdAccount: {
        select: { id: true, key: true, displayName: true, currency: true, timezoneName: true },
      },
    },
  });
  const accountKey = readAccountKey(
    { accountKey: opts.input.accountKey },
    workspace?.defaultAdAccount?.key ?? null
  );
  const account = await opts.prisma.adAccount.findUnique({
    where: { workspaceId_key: { workspaceId: opts.workspaceId, key: accountKey } },
    select: { id: true, key: true, displayName: true, currency: true, timezoneName: true, metaAccountId: true },
  });
  if (!account) {
    throw new Error(`広告アカウント ${accountKey} が登録されていません。先に account sync/select を完了してください。`);
  }
  const userPrompt = opts.input.prompt?.trim();
  if (!userPrompt) throw new Error("生成したいクリエイティブの意図を入力してください。");

  const storage = new LocalDiskStorage({ env });
  await storage.ensureRoot();
  const creativeContext = await loadCreativeContextForSubmission(opts.prisma, {
    accountId: account.id,
    timeZone: account.timezoneName ?? workspace?.defaultAdAccount?.timezoneName ?? "UTC",
  });
  const userReferenceImages = await loadSubmissionReferenceImages({
    referenceImagePaths: opts.input.referenceImagePaths,
    uploadedReferenceMedia: opts.input.uploadedReferenceMedia,
  });
  const enrichedContext = await enrichCreativeGenerationContext({
    provider: opts.llmProvider ?? null,
    storage,
    creativeContext,
    userReferenceImages,
    explicitUrls: [
      { label: "requested landing page", url: opts.input.linkUrl },
      { label: "requested destination URL", url: opts.input.destinationUrl },
    ],
  });
  const referenceImages = enrichedContext.referenceImages;
  const referenceImageUsageMode = referenceImageUsageModeForPrompt(userPrompt);
  const generationReferenceImages =
    referenceImageUsageMode === "direct_image_reference" ? referenceImages : [];
  const creativeContextWithLanding = enrichedContext.creativeContext;
  const variantCount = Math.max(1, Math.min(4, opts.input.variantCount ?? 3));
  const generatedText = await generateCreativeTextVariants({
    provider: opts.llmProvider ?? null,
    prompt: userPrompt,
    accountDisplayName: account.displayName || accountKey,
    linkUrl: opts.input.linkUrl ?? opts.input.destinationUrl,
    creativeContext: creativeContextWithLanding,
    variantCount,
  });
  const firstText = generatedText.variants[0];
  const contextualPrompt = buildCreativeSubmissionImagePrompt({
    input: {
      prompt: userPrompt,
      creativeName: opts.input.creativeName,
      headline: firstText?.headline,
      primaryText: firstText?.primaryText,
      description: firstText?.description,
      callToAction: firstText?.callToAction,
      linkUrl: opts.input.linkUrl ?? opts.input.destinationUrl,
      mediaType: "image",
      generateImage: true,
      referenceImagePaths: opts.input.referenceImagePaths,
      uploadedReferenceMedia: opts.input.uploadedReferenceMedia,
    },
    accountKey,
    accountDisplayName: account.displayName || accountKey,
    accountCurrency: account.currency ?? workspace?.defaultAdAccount?.currency ?? null,
    creativeContext: creativeContextWithLanding,
    referenceImageUsageMode,
  });
  if (!contextualPrompt) throw new Error("画像生成プロンプトを作成できませんでした。");

  const llmConnection = opts.llmProvider
    ? await opts.llmProvider.getConnection().catch(() => null)
    : null;
  const selected =
    opts.imageProvider ??
    (await selectImageProviderForWorker(env, {
      prisma: opts.prisma,
      preferCodex: llmConnection?.provider === "codex",
    })).provider;
  const variationConditions = Array.from({ length: variantCount }, (_, i) => ({
    width: 1080,
    height: 1080,
    format: "png" as const,
    variantKey: `variant-${i}`,
  }));
  const now = new Date();
  const imageRun = await opts.prisma.aiRun.create({
    data: {
      workspaceId: opts.workspaceId,
      agent: "image_prompt",
      workflow: "creative_generation",
      provider: llmConnection?.provider ?? "local",
      model: llmConnection?.defaultModel ?? "rule",
      status: "succeeded",
      prompt: { prompt: userPrompt } as Prisma.InputJsonValue,
      inputs: {
        source: opts.source,
        accountKey,
        referenceImageCount: referenceImages.length,
        generationReferenceImageCount: generationReferenceImages.length,
        referenceImageUsageMode,
        creativeContext: creativeContextToMetadata(creativeContextWithLanding),
      } as Prisma.InputJsonValue,
      outputs: {
        prompt: contextualPrompt,
        variantCount,
        generatedText,
        metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
      } as unknown as Prisma.InputJsonValue,
      decision: "generate",
      startedAt: now,
      finishedAt: now,
    },
    select: { id: true },
  });
  const generated = await generateAndQaCreative({
    provider: selected,
    request: {
      prompt: contextualPrompt,
      purpose: `creative_generation:${opts.source}`,
      referenceImages: generationReferenceImages,
      variationConditions,
    },
    variants: variationConditions.map((condition) => ({
      variantKey: condition.variantKey,
      prompt: contextualPrompt,
      negativePrompt: "",
      styleNotes: "",
      width: condition.width,
      height: condition.height,
      format: condition.format,
    })),
    policy: opts.creativeQaPolicy ?? DEFAULT_CREATIVE_QA_POLICY,
  });
  const qaRun = await opts.prisma.aiRun.create({
    data: {
      workspaceId: opts.workspaceId,
      agent: "creative_qa",
      workflow: "creative_generation",
      provider: "local",
      model: "deterministic",
      status: generated.qa ? "succeeded" : "failed",
      prompt: Prisma.JsonNull,
      inputs: {
        imagePromptAiRunId: imageRun.id,
        referenceImageCount: referenceImages.length,
        generationReferenceImageCount: generationReferenceImages.length,
        referenceImageUsageMode,
      } as Prisma.InputJsonValue,
      outputs: generated.qa
        ? (generated.qa as unknown as Prisma.InputJsonValue)
        : ({ providerError: generated.providerError, outcome: generated.outcome } as Prisma.InputJsonValue),
      decision: generated.outcome,
      errorMessage: generated.providerError,
      startedAt: now,
      finishedAt: new Date(),
    },
    select: { id: true },
  });

  if (!generated.generation || !generated.qa) {
    const textVariant = generatedText.variants[0] ?? fallbackCreativeTextVariant(userPrompt, account.displayName || accountKey);
    const created = await opts.prisma.creative.create({
      data: {
        accountId: account.id,
        hierarchyId: creativeContextWithLanding?.target?.hierarchyId ?? null,
        aiRunId: imageRun.id,
        creativeQaAiRunId: qaRun.id,
        key: `image_${imageRun.id}_fallback`,
        displayName: opts.input.creativeName || "Chat generated creative prompt",
        mediaType: "image",
        status: "fallback_text_only",
        prompt: contextualPrompt,
        provider: null,
        model: null,
        parameters: {
          source: opts.source,
          referenceImageCount: referenceImages.length,
          generationReferenceImageCount: generationReferenceImages.length,
          referenceImageUsageMode,
          providerError: generated.providerError,
          creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        } as unknown as Prisma.InputJsonValue,
        spec: {
          prompt: contextualPrompt,
          adText: textVariant,
          textVariants: generatedText.variants,
          metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
          rationale: userPrompt,
          qa: {
            aiRunId: qaRun.id,
            recommendation: "fallback_text_only",
            issues: [],
            rationale: generated.providerError,
          },
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await opts.prisma.auditLog.create({
      data: {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        action: "creative.generated_via_web_chat",
        target: `creative:${created.id}`,
        metadata: {
          source: opts.source,
          accountKey,
          creativeIds: [created.id],
          generatedImage: false,
          referenceImageCount: referenceImages.length,
          generationReferenceImageCount: generationReferenceImages.length,
          referenceImageUsageMode,
        } as Prisma.InputJsonValue,
      },
    });
    return {
      accountKey,
      accountDisplayName: account.displayName || accountKey,
      creativeIds: [created.id],
      generatedImage: false,
      provider: null,
      model: null,
      status: "fallback_text_only",
      message: "画像 Provider が利用できないため、生成プロンプトのみ creatives に保存しました。",
    };
  }

  const persisted = await persistCreativeAssets({
    storage,
    accountKey,
    creativeId: `imgrun_${imageRun.id}`,
    generation: generated.generation,
    qa: generated.qa,
    links: { imagePromptAiRunId: imageRun.id, creativeQaAiRunId: qaRun.id },
  });
  const assetByKey = new Map(persisted.assets.map((asset) => [asset.variantKey, asset]));
  const creativeIds: string[] = [];
  for (let i = 0; i < variationConditions.length; i += 1) {
    const condition = variationConditions[i]!;
    const asset = assetByKey.get(condition.variantKey) ?? null;
    const textVariant = generatedText.variants[i] ?? generatedText.variants[0] ?? fallbackCreativeTextVariant(userPrompt, account.displayName || accountKey);
    const created = await opts.prisma.creative.create({
      data: {
        accountId: account.id,
        hierarchyId: creativeContextWithLanding?.target?.hierarchyId ?? null,
        aiRunId: imageRun.id,
        creativeQaAiRunId: qaRun.id,
        key: `image_${imageRun.id}_v${i + 1}`,
        displayName: opts.input.creativeName || `Chat image variant ${i + 1}`,
        mediaType: "image",
        status: asset?.qaOverall ?? "qa_warned",
        prompt: contextualPrompt,
        provider: generated.generation.meta.provider,
        model: generated.generation.meta.model,
        parameters: ({
          ...generated.generation.meta.parameters,
          source: opts.source,
          referenceImageCount: referenceImages.length,
          generationReferenceImageCount: generationReferenceImages.length,
          referenceImageUsageMode,
          creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        } as unknown) as Prisma.InputJsonValue,
        storagePath: asset?.storageKey ?? null,
        storageRef: asset ? persisted.baseStorageRef : null,
        spec: {
          prompt: contextualPrompt,
          adText: textVariant,
          textVariants: generatedText.variants,
          metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
          negativePrompt: null,
          styleNotes: `Generated from ${opts.source} references and account creative context.`,
          rationale: userPrompt,
          variantIndex: i,
          qa: {
            aiRunId: qaRun.id,
            recommendation: generated.qa.overall,
            issues: generated.qa.assets.flatMap((qaAsset) =>
              qaAsset.checks
                .filter((check) => check.outcome !== "pass")
                .map((check) => ({
                  severity: check.severity,
                  category: check.kind,
                  message: check.detail,
                }))
            ),
            rationale: generated.qa.overall,
          },
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    creativeIds.push(created.id);
  }
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "creative.generated_via_web_chat",
      target: `creative:${creativeIds[0] ?? imageRun.id}`,
      metadata: {
        source: opts.source,
        accountKey,
        creativeIds,
        generatedImage: true,
        referenceImageCount: referenceImages.length,
        generationReferenceImageCount: generationReferenceImages.length,
        referenceImageUsageMode,
        provider: generated.generation.meta.provider,
        model: generated.generation.meta.model,
      } as Prisma.InputJsonValue,
    },
  });
  return {
    accountKey,
    accountDisplayName: account.displayName || accountKey,
    creativeIds,
    generatedImage: true,
    provider: generated.generation.meta.provider,
    model: generated.generation.meta.model,
    status: generated.qa.overall,
    message: `${creativeIds.length} 件の生成クリエイティブ画像と広告テキスト案を /creatives に保存しました。`,
  };
}

export async function createCreativeSubmissionProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: CreativeSubmissionInput;
  actor: string;
  source: CreativeSubmissionSource;
  env?: NodeJS.ProcessEnv;
  imageProvider?: ImageProvider | null;
  llmProvider?: LLMProvider | null;
  creativeQaPolicy?: CreativeQaPolicy | null;
}): Promise<CreativeSubmissionResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      opsRepoId: true,
      defaultAdAccount: {
        select: { id: true, key: true, displayName: true, currency: true, timezoneName: true },
      },
    },
  });
  if (!workspace?.opsRepoId) {
    throw new Error("ops repo が未接続です。GitHub 接続と ops repo bootstrap を完了してください。");
  }
  const repo = await opts.prisma.githubRepo.findUnique({
    where: { id: workspace.opsRepoId },
    select: { id: true, owner: true, name: true, defaultBranch: true },
  });
  if (!repo) throw new Error(`ops repo ${workspace.opsRepoId} が github_repos に見つかりません。`);

  const accountKey = readAccountKey(opts.input, workspace.defaultAdAccount?.key ?? null);
  const account = await opts.prisma.adAccount.findUnique({
    where: { workspaceId_key: { workspaceId: opts.workspaceId, key: accountKey } },
    select: {
      id: true,
      key: true,
      displayName: true,
      currency: true,
      timezoneName: true,
      metaAccountId: true,
    },
  });
  if (!account) {
    throw new Error(`広告アカウント ${accountKey} が登録されていません。先に account sync/select を完了してください。`);
  }

  const draftState: Record<string, unknown> = { creatives: [], campaigns: [] };

  const normalized = { ...opts.input };
  await inferCreativeIdentity({
    prisma: opts.prisma,
    accountKey,
    adAccountId: account.metaAccountId ?? account.key,
    state: draftState,
    input: normalized,
  });
  await inferInstagramActorIdForCli({
    prisma: opts.prisma,
    adAccountId: account.metaAccountId ?? account.key,
    input: normalized,
  });
  validateCreativeSubmissionInput(normalized);
  validateCreativeSubmissionCliCompatibility(normalized);
  const draftId = makeStableId(normalized.creativeName || normalized.adName || normalized.headline || "creative");
  const creativeId = uniqueId(ensureArray(draftState, "creatives"), draftId);
  const adId = uniqueNestedAdId(draftState, makeStableId(normalized.adName || normalized.creativeName || "ad"));
  const storage = new LocalDiskStorage({ env });
  await storage.ensureRoot();
  const creativeContext = await loadCreativeContextForSubmission(opts.prisma, {
    accountId: account.id,
    timeZone: account.timezoneName ?? workspace.defaultAdAccount?.timezoneName ?? "UTC",
  });
  const userReferenceImages = await loadSubmissionReferenceImages(normalized);
  const enrichedContext = await enrichCreativeGenerationContext({
    provider: opts.llmProvider ?? null,
    storage,
    creativeContext,
    userReferenceImages,
    explicitUrls: [{ label: "requested landing page", url: normalized.linkUrl }],
  });
  const referenceImages = enrichedContext.referenceImages;
  const referenceImageUsageMode = referenceImageUsageModeForPrompt(normalized.prompt);
  const generationReferenceImages =
    referenceImageUsageMode === "direct_image_reference" ? referenceImages : [];
  const creativeContextWithLanding = enrichedContext.creativeContext;
  const generatedSubmissionText =
    normalized.prompt && needsGeneratedCreativeText(normalized)
      ? await generateCreativeTextVariants({
          provider: opts.llmProvider ?? null,
          prompt: normalized.prompt,
          accountDisplayName: account.displayName || accountKey,
          linkUrl: normalized.linkUrl,
          creativeContext: creativeContextWithLanding,
          variantCount: 3,
        })
      : null;
  if (generatedSubmissionText) {
    applyGeneratedTextToSubmissionInput(normalized, generatedSubmissionText.variants[0]);
  }
  const llmConnection = opts.llmProvider
    ? await opts.llmProvider.getConnection().catch(() => null)
    : null;

  const preparedMedia = await prepareMedia({
    input: normalized,
    accountKey,
    accountDisplayName: account.displayName || accountKey,
    accountCurrency: account.currency ?? workspace.defaultAdAccount?.currency ?? null,
    creativeId,
    storage,
    prisma: opts.prisma,
    env,
    imageProvider: opts.imageProvider ?? null,
    creativeQaPolicy: opts.creativeQaPolicy ?? null,
    creativeContext: creativeContextWithLanding,
    referenceImages: generationReferenceImages,
    referenceImageUsageMode,
    preferCodexImageProvider: llmConnection?.provider === "codex",
  });

  const mediaType = preparedMedia.mediaType;
  const creative = removeUndefined({
    id: creativeId,
    name: normalized.creativeName || normalized.adName || normalized.headline || creativeId,
    mediaType,
    headline: normalized.headline,
    primaryText: normalized.primaryText || normalized.prompt,
    callToAction: normalized.callToAction,
    pageId: normalized.pageId,
    title: normalized.title,
    body: normalized.body,
    linkUrl: normalized.linkUrl,
    description: normalized.description,
    instagramUserId: normalized.instagramUserId,
    instagramActorId: normalized.instagramActorId,
    images: normalized.images,
    videos: normalized.videos,
    titles: normalized.titles,
    bodies: normalized.bodies,
    descriptions: normalized.descriptions,
    callToActions: normalized.callToActions,
    storageKey: preparedMedia.storageKeys[0],
  });
  ensureArray(draftState, "creatives").push(creative);
  const placement = placeAdDraft(draftState, {
    input: normalized,
    creativeId,
    adId,
  });

  const operations = buildCreativeSubmissionOperations({
    input: normalized,
    accountKey,
    accountCurrency: account.currency ?? workspace.defaultAdAccount?.currency ?? "USD",
    creativeId,
    adId,
    placement,
    creative,
    preparedStorageKeys: preparedMedia.storageKeys,
    storage,
  });
  const proposal = await createOpsChangeProposal({
    prisma: opts.prisma,
    githubAdapter: opts.githubAdapter,
    workspaceId: opts.workspaceId,
    input: {
      intent: "other",
      accountKey,
      operations,
      rationale: normalized.rationale ?? "Creative submission from AdDroid.",
      urgency: normalized.urgency ?? "normal",
    },
    actor: opts.actor,
    source: opts.source,
    env,
  });
  const prRow = { id: proposal.pullRequestId };

  await opts.prisma.creative.create({
    data: {
      accountId: account.id,
      pullRequestId: prRow.id,
      key: `evidence/creatives/${accountKey}/${creativeId}`,
      displayName: String(creative.name),
      mediaType,
      status: "attached_to_pr",
      prompt: normalized.prompt ?? null,
      provider: preparedMedia.provider,
      model: preparedMedia.model,
      parameters: {
        source: opts.source,
        proposalSource: "creative_submission",
        generatedImage: preparedMedia.generatedImage,
        creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        localMediaCount: (normalized.localMediaPaths?.length ?? 0) + (normalized.uploadedMedia?.length ?? 0),
      } as Prisma.InputJsonValue,
      storagePath: preparedMedia.storageKeys[0] ?? null,
      storageRef: preparedMedia.storageKeys[0] ? `storage://${preparedMedia.storageKeys[0]}` : null,
      spec: {
        adText: generatedSubmissionText?.variants[0] ?? creativeTextVariantFromSubmissionInput(normalized),
        metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
        rationale: normalized.rationale ?? null,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "creative_submission.pr_opened",
      target: `github_pull_request:${prRow.id}`,
      ref: String(proposal.prNumber),
      metadata: {
        source: opts.source,
        accountKey,
        creativeId,
        adId,
        mediaType,
        storageKeyCount: preparedMedia.storageKeys.length,
        generatedImage: preparedMedia.generatedImage,
        creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        planSummary: proposal.planSummary,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    prNumber: proposal.prNumber,
    htmlUrl: proposal.htmlUrl,
    pullRequestId: prRow.id,
    headSha: proposal.headSha,
    accountKey,
    creativeId,
    adId,
    mediaType,
    storageKeys: preparedMedia.storageKeys,
    generatedImage: preparedMedia.generatedImage,
    planOk: proposal.planOk,
    planSummary: proposal.planSummary,
  };
}

export function normalizeCreativeSubmissionInput(args: Record<string, unknown>): CreativeSubmissionInput {
  const input: CreativeSubmissionInput = {
    accountKey: readString(args.accountKey) ?? undefined,
    creativeName: readString(args.creativeName) ?? undefined,
    adName: readString(args.adName) ?? undefined,
    prompt: readString(args.prompt) ?? undefined,
    headline: readString(args.headline) ?? undefined,
    primaryText: readString(args.primaryText) ?? undefined,
    callToAction: readCallToAction(args.callToAction) ?? undefined,
    mediaType: readMediaType(args.mediaType) ?? undefined,
    localMediaPaths: readStringArray(args.localMediaPaths),
    referenceImagePaths: readStringArray(args.referenceImagePaths),
    generateImage: args.generateImage === true,
    pageId: readString(args.pageId) ?? undefined,
    title: readString(args.title) ?? undefined,
    body: readString(args.body) ?? undefined,
    linkUrl: readString(args.linkUrl ?? args.destinationUrl) ?? undefined,
    description: readString(args.description) ?? undefined,
    instagramUserId: readString(args.instagramUserId) ?? undefined,
    instagramActorId: readString(args.instagramActorId) ?? undefined,
    images: readStringArray(args.images),
    videos: readStringArray(args.videos),
    titles: readStringArray(args.titles),
    bodies: readStringArray(args.bodies),
    descriptions: readStringArray(args.descriptions),
    callToActions: readCallToActionArray(args.callToActions),
    campaignId: readString(args.campaignId) ?? undefined,
    adsetId: readString(args.adsetId) ?? undefined,
    campaignName: readString(args.campaignName) ?? undefined,
    adsetName: readString(args.adsetName) ?? undefined,
    objective: readObjective(args.objective) ?? undefined,
    dailyBudget: readNumber(args.dailyBudget) ?? undefined,
    lifetimeBudget: readNumber(args.lifetimeBudget) ?? undefined,
    adsetBudgetSharing: readBoolean(args.adsetBudgetSharing) ?? undefined,
    optimizationGoal: readOptimizationGoal(args.optimizationGoal) ?? undefined,
    billingEvent: readBillingEvent(args.billingEvent) ?? undefined,
    bidAmount: readNumber(args.bidAmount) ?? undefined,
    startTime: readString(args.startTime) ?? undefined,
    endTime: readString(args.endTime) ?? undefined,
    pixelId: readString(args.pixelId) ?? undefined,
    customEventType: readCustomEventType(args.customEventType) ?? undefined,
    adPixelId: readString(args.adPixelId) ?? undefined,
    trackingSpecs: readRecord(args.trackingSpecs) ?? undefined,
    countries: readCountries(args.countries),
    ageMin: readInteger(args.ageMin) ?? undefined,
    ageMax: readInteger(args.ageMax) ?? undefined,
    requestedUnsupportedFields: detectRequestedUnsupportedFields(args),
    rationale: readString(args.rationale) ?? undefined,
    urgency: readUrgency(args.urgency) ?? undefined,
  };
  validateCreativeSubmissionInput(input);
  return input;
}

function validateCreativeSubmissionCliCompatibility(input: CreativeSubmissionInput): void {
  const issues: string[] = [];
  const requestedUnsupported = input.requestedUnsupportedFields ?? [];
  if (requestedUnsupported.length > 0) {
    issues.push(
      `Meta Ads CLI 2026/04/29 では ${requestedUnsupported.join("、")} は入稿時に反映できません。ターゲティングは国コード（targeting-countries）のみ対応です。`
    );
  }
  if (input.ageMin !== undefined || input.ageMax !== undefined) {
    issues.push("Meta Ads CLI 2026/04/29 では年齢指定を入稿時に反映できません。");
  }
  if (input.callToAction && !CLI_CREATIVE_CALL_TO_ACTIONS.has(input.callToAction)) {
    issues.push(
      `CTA ${input.callToAction} は Meta Ads CLI 2026/04/29 の creative create では使えません。対応CTA: ${joinCliValues(CLI_CREATIVE_CALL_TO_ACTIONS)}`
    );
  }
  const invalidDcoCtas = (input.callToActions ?? []).filter(
    (cta): cta is string => typeof cta === "string" && !CLI_CREATIVE_CALL_TO_ACTIONS.has(cta)
  );
  if (invalidDcoCtas.length > 0) {
    issues.push(
      `DCO CTA ${Array.from(new Set(invalidDcoCtas)).join("、")} は Meta Ads CLI 2026/04/29 では使えません。`
    );
  }
  const createsAdset = !input.adsetId;
  if (createsAdset) {
    if (!input.optimizationGoal) {
      issues.push("新しい広告セットを作る場合、Meta Ads CLI の必須項目として optimizationGoal が必要です。");
    } else if (!CLI_OPTIMIZATION_GOALS.has(input.optimizationGoal)) {
      issues.push(
        `optimizationGoal ${input.optimizationGoal} は Meta Ads CLI 2026/04/29 の adset create では使えません。対応値: ${joinCliValues(CLI_OPTIMIZATION_GOALS)}`
      );
    }
    if (!input.billingEvent) {
      issues.push("新しい広告セットを作る場合、Meta Ads CLI の必須項目として billingEvent が必要です。");
    } else if (!CLI_BILLING_EVENTS.has(input.billingEvent)) {
      issues.push(
        `billingEvent ${input.billingEvent} は Meta Ads CLI 2026/04/29 の adset create では使えません。対応値: ${joinCliValues(CLI_BILLING_EVENTS)}`
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(
      [
        "Meta Ads CLI で反映できる範囲外の設定が含まれているため、PR は作成しません。",
        ...issues.map((issue) => `- ${issue}`),
        "コピー元と完全一致させるのではなく、CLI対応範囲に置き換えてから再実行してください。",
      ].join("\n")
    );
  }
}

function validateCreativeSubmissionInput(input: CreativeSubmissionInput): void {
  if (!input.headline && !input.primaryText && !input.prompt) {
    throw new Error("見出し、本文、または生成プロンプトのいずれかが必要です。");
  }
  if (requiresDestinationUrlForCurrentCreativeApply(input) && !input.linkUrl) {
    throw new Error(
      "現在の Meta Ads CLI / Graph apply で反映できるクリエイティブ形式はリンク広告として作成するため、linkUrl または destinationUrl が必要です。キャンペーン種別ではなく、入稿するクリエイティブ形式に対する必須項目です。"
    );
  }
  if (input.campaignId) {
    if (input.adsetId) {
      return;
    }
    if (!input.adsetName) {
      throw new Error(
        "既存キャンペーン配下に入稿する場合は、既存広告セットへ入れるなら adsetId、新しい広告セットを作るなら adsetName が必要です。"
      );
    }
    return;
  }
  if (input.adsetId) {
    throw new Error("adsetId を指定する場合は campaignId も必要です。");
  }
  if (
    !input.campaignName ||
    !input.adsetName ||
    !input.objective ||
    (dailyBudget(input) === undefined && lifetimeBudget(input) === undefined)
  ) {
    throw new Error(
      "新規キャンペーンから入稿するには campaignName、adsetName、objective、dailyBudget または lifetimeBudget が必要です。予算は広告アカウント通貨の金額で指定してください。既存キャンペーン配下に入れる場合は campaignId と adsetName、既存広告セットに入れる場合は campaignId と adsetId を指定してください。"
    );
  }
}

function requiresDestinationUrlForCurrentCreativeApply(input: CreativeSubmissionInput): boolean {
  if (input.mediaType === "image" || input.mediaType === "video" || input.mediaType === "carousel") return true;
  if ((input.localMediaPaths?.length ?? 0) > 0 || (input.uploadedMedia?.length ?? 0) > 0) return true;
  if (input.generateImage === true) return true;
  if ((input.images?.length ?? 0) > 0 || (input.videos?.length ?? 0) > 0) return true;
  if (
    (input.titles?.length ?? 0) > 0 ||
    (input.bodies?.length ?? 0) > 0 ||
    (input.descriptions?.length ?? 0) > 0 ||
    (input.callToActions?.length ?? 0) > 0
  ) {
    return true;
  }
  return Boolean(input.callToAction && input.callToAction !== "NO_BUTTON");
}

async function loadCreativeContextForSubmission(
  prisma: PrismaClient,
  input: { accountId: string; timeZone: string }
): Promise<ImprovementPrCreativeGenerationContext | null> {
  try {
    const context = await loadRecentPerformanceSnapshotContext(prisma, {
      accountId: input.accountId,
      timeZone: input.timeZone,
      includeToday: true,
    });
    return context.creativeContext;
  } catch {
    return null;
  }
}

function buildCreativeSubmissionImagePrompt(input: {
  input: CreativeSubmissionInput;
  accountKey: string;
  accountDisplayName: string;
  accountCurrency: string | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  referenceImageUsageMode?: ReferenceImageUsageMode;
}): string | null {
  const source = input.input.prompt?.trim();
  const safeLinkUrl = landingPageUrlForPrompt(input.input.linkUrl);
  const copyLines = [
    input.input.headline ? `headline=${input.input.headline}` : null,
    input.input.primaryText ? `primaryText=${input.input.primaryText}` : null,
    input.input.description ? `description=${input.input.description}` : null,
    input.input.callToAction ? `cta=${input.input.callToAction}` : null,
    safeLinkUrl ? `linkUrl=${safeLinkUrl}` : null,
    input.input.rationale ? `requestRationale=${input.input.rationale}` : null,
  ].filter((line): line is string => line !== null);

  const sections = [
    "Create a Meta ad image for the connected account.",
    `Account: ${input.accountDisplayName} (${input.accountKey})`,
    input.accountCurrency ? `Account currency: ${input.accountCurrency}` : null,
    source ? `User prompt: ${source}` : null,
    copyLines.length > 0 ? `Requested copy/context:\n${copyLines.map((line) => `- ${line}`).join("\n")}` : null,
    formatCreativeContextForImagePrompt(input.creativeContext),
    formatReferenceImageAdaptationRules(
      input.input,
      input.referenceImageUsageMode,
      hasReferenceImageEvidence(input.input, input.creativeContext)
    ),
    [
      "Rules:",
      "- Use winning reference creatives as positive seeds when present.",
      "- Preserve the winning message structure and visual logic, then adapt it to this request.",
      "- Do not invent unrelated industries, products, people, locations, account names, claims, or logos.",
      "- If evidence is sparse, stay product-neutral and account-specific rather than adding arbitrary subject matter.",
      "- Avoid text-heavy layouts; leave room for Meta ad copy outside the image.",
    ].join("\n"),
  ].filter((section): section is string => typeof section === "string" && section.trim().length > 0);

  if (!source && copyLines.length === 0 && !input.creativeContext) return null;
  return sections.join("\n\n");
}

function formatReferenceImageAdaptationRules(
  input: CreativeSubmissionInput,
  explicitMode: ReferenceImageUsageMode | undefined,
  hasReferenceEvidence: boolean
): string | null {
  if (!hasReferenceEvidence) return null;
  const mode = explicitMode ?? referenceImageUsageModeForPrompt(input.prompt);
  const modeLine =
    mode === "direct_image_reference"
      ? "Reference image handling: direct image reference mode. The user explicitly asked to base/edit/match the image, so image references may guide structure and material fidelity."
      : "Reference image handling: abstract visual brief mode. Use reference images only as planning evidence; do not use them as a template or recreate the same image.";
  const lines = [
    modeLine,
    mode === "direct_image_reference"
      ? "- Even in direct mode, produce a new ad creative rather than a near duplicate; change at least one major element."
      : "- Do not reproduce the same object arrangement, crop, camera distance, lens angle, light placement, or background layout.",
    "- Change at least two of: main subject, camera distance, composition, background setting, light direction, color accent, CTA framing, or offer framing.",
    "- Anchor the result to the connected account and improvement target; add a concrete improvement angle such as profile visit, store atmosphere, product experience, visit motivation, or premium relaxation value.",
    "- For multiple variants, make each concept materially distinct rather than minor redraws of one reference image.",
  ];
  return lines.join("\n");
}

function hasReferenceImageEvidence(
  input: CreativeSubmissionInput,
  context: ImprovementPrCreativeGenerationContext | null
): boolean {
  if (hasUserReferenceImages(input)) return true;
  if ((context?.references?.length ?? 0) > 0) return true;
  return (context?.notes ?? []).some((note) =>
    /Reference image visual analysis/i.test(note)
  );
}

function hasUserReferenceImages(input: CreativeSubmissionInput): boolean {
  return (
    (input.referenceImagePaths?.length ?? 0) > 0 ||
    (input.uploadedReferenceMedia?.length ?? 0) > 0
  );
}

function referenceImageUsageModeForPrompt(prompt: string | null | undefined): ReferenceImageUsageMode {
  const text = (prompt ?? "").toLowerCase();
  const directPatterns = [
    /この画像を(?:ベース|元|土台)に/,
    /元画像を(?:ベース|土台)に/,
    /画像を(?:ベース|元|土台)に/,
    /画像を加工/,
    /素材を加工/,
    /同じ構図/,
    /構図をそのまま/,
    /この画像をそのまま/,
    /ほぼ同じ/,
    /edit this image/,
    /use this image as (?:the )?base/,
    /base (?:it|the creative) on this image/,
    /same composition/,
    /keep the same composition/,
  ];
  return directPatterns.some((pattern) => pattern.test(text))
    ? "direct_image_reference"
    : "abstract_visual_brief";
}

function formatCreativeContextForImagePrompt(
  context: ImprovementPrCreativeGenerationContext | null
): string | null {
  if (!context) return null;
  const lines = [
    "Creative performance context:",
    `- strategy=${context.strategy}`,
    context.target ? `- target=${formatCreativeNodeForPrompt(context.target)}` : null,
  ].filter((line): line is string => line !== null);
  if (context.references.length > 0) {
    lines.push(
      context.strategy === "refresh_underperformer"
        ? "- references:"
        : "- winning references:"
    );
    for (const reference of context.references.slice(0, 3)) {
      lines.push(`  - ${formatCreativeNodeForPrompt(reference)}`);
    }
  }
  if (context.notes?.length) {
    lines.push(`- notes=${context.notes.join(" / ")}`);
  }
  return lines.join("\n");
}

function formatCreativeNodeForPrompt(node: ImprovementPrCreativeNodeContext): string {
  const creative = node.creative;
  const safeLinkUrl = landingPageUrlForPrompt(creative?.linkUrl);
  const parts = [
    `${node.hierarchy}:${node.displayName}`,
    `status=${node.status ?? "unknown"}`,
    `ctr=${formatMetric(node.current.ctr)}`,
    `conversions=${formatMetric(node.current.conversions)}`,
    `cpa=${formatMetric(node.current.cpa)}`,
    creative?.displayName ? `creativeName=${creative.displayName}` : null,
    creative?.mediaType ? `mediaType=${creative.mediaType}` : null,
    creative?.headline ? `headline=${creative.headline}` : null,
    creative?.primaryText ? `primaryText=${creative.primaryText}` : null,
    creative?.callToAction ? `cta=${creative.callToAction}` : null,
    safeLinkUrl ? `linkUrl=${safeLinkUrl}` : null,
    creative?.storageRef ? `storageRef=${creative.storageRef}` : null,
    creative?.images?.length ? `images=${creative.images.join(",")}` : null,
    node.rationale ? `rationale=${node.rationale}` : null,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.join("; ");
}

function formatMetric(value: number | undefined): string {
  if (value === undefined) return "0";
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(4)).toString();
}

function needsGeneratedCreativeText(input: CreativeSubmissionInput): boolean {
  return !input.headline || !input.primaryText || !input.description || !input.callToAction;
}

function applyGeneratedTextToSubmissionInput(
  input: CreativeSubmissionInput,
  variant: CreativeTextVariant | undefined
): void {
  if (!variant) return;
  input.headline = input.headline ?? variant.headline;
  input.primaryText = input.primaryText ?? variant.primaryText;
  input.description = input.description ?? variant.description;
  input.callToAction = input.callToAction ?? variant.callToAction;
}

function creativeTextVariantFromSubmissionInput(input: CreativeSubmissionInput): CreativeTextVariant | null {
  const primaryText = input.primaryText ?? input.prompt ?? input.headline ?? input.description ?? null;
  const headline = input.headline ?? input.creativeName ?? input.adName ?? primaryText;
  const description = input.description ?? "詳しくはこちら";
  if (!primaryText && !headline && !description) return null;
  return {
    primaryText: truncateChars(primaryText ?? "", META_TEXT_RECOMMENDED_LIMITS.primaryText),
    headline: truncateChars(headline ?? "", META_TEXT_RECOMMENDED_LIMITS.headline),
    description: truncateChars(description, META_TEXT_RECOMMENDED_LIMITS.description),
    callToAction: input.callToAction ?? DEFAULT_GENERATED_CTA,
    rationale: input.rationale ?? null,
  };
}

async function generateCreativeTextVariants(input: {
  provider: LLMProvider | null;
  prompt: string;
  accountDisplayName: string;
  linkUrl?: string | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  variantCount: number;
}): Promise<CreativeTextGenerationResult> {
  const count = Math.max(1, Math.min(4, input.variantCount));
  const fallback = fillTextVariants(
    [fallbackCreativeTextVariant(input.prompt, input.accountDisplayName)],
    count
  );
  if (!input.provider) {
    return { source: "fallback", variants: fallback, error: "LLM Provider が未設定です。" };
  }
  try {
    const completion = await input.provider.complete({
      purpose: "creative_text_generation",
      maxOutputTokens: 1600,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: [
            "You generate Meta ad copy to accompany generated image creatives.",
            "Return JSON only. Do not use Markdown.",
            "Required output shape: {\"variants\":[{\"primaryText\":\"...\",\"headline\":\"...\",\"description\":\"...\",\"callToAction\":\"LEARN_MORE\",\"rationale\":\"...\"}]}",
            "Generate materially distinct variants, not minor rewrites.",
            `Respect recommended display lengths: primaryText <= ${META_TEXT_RECOMMENDED_LIMITS.primaryText} characters, headline <= ${META_TEXT_RECOMMENDED_LIMITS.headline}, description <= ${META_TEXT_RECOMMENDED_LIMITS.description}.`,
            `callToAction must be one of: ${joinCliValues(CLI_CREATIVE_CALL_TO_ACTIONS)}.`,
            "Do not invent unsupported claims, rankings, prices, guarantees, medical/safety claims, unrelated products, unrelated locations, or unrelated brands.",
            "Use landing page and creative performance context when provided.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            accountDisplayName: input.accountDisplayName,
            userPrompt: input.prompt,
            linkUrl: landingPageUrlForPrompt(input.linkUrl),
            variantCount: count,
            creativeContext: input.creativeContext ? creativeContextToMetadata(input.creativeContext) : null,
            requiredFields: ["primaryText", "headline", "description", "callToAction"],
            recommendedLengths: META_TEXT_RECOMMENDED_LIMITS,
          }),
        },
      ],
    });
    const parsed = extractJsonFromLlmContent(completion.content);
    const variants = parseCreativeTextVariants(parsed, input.prompt, input.accountDisplayName);
    return { source: "llm", variants: fillTextVariants(variants, count), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: "fallback", variants: fallback, error: message };
  }
}

function parseCreativeTextVariants(
  parsed: unknown,
  prompt: string,
  accountDisplayName: string
): CreativeTextVariant[] {
  const root = isRecord(parsed) ? parsed : {};
  const rawVariants = Array.isArray(root.variants) ? root.variants : [];
  const variants = rawVariants
    .filter(isRecord)
    .map((item) => normalizeCreativeTextVariant(item))
    .filter((item): item is CreativeTextVariant => item !== null);
  return variants.length > 0 ? variants : [fallbackCreativeTextVariant(prompt, accountDisplayName)];
}

function normalizeCreativeTextVariant(item: Record<string, unknown>): CreativeTextVariant | null {
  const primaryText = readString(item.primaryText) ?? readString(item.message);
  const headline = readString(item.headline) ?? readString(item.name) ?? readString(item.title);
  const description = readString(item.description);
  if (!primaryText && !headline && !description) return null;
  const cta = readCallToAction(item.callToAction) ?? readCallToAction(item.cta) ?? DEFAULT_GENERATED_CTA;
  return {
    primaryText: truncateChars(primaryText ?? headline ?? description ?? "", META_TEXT_RECOMMENDED_LIMITS.primaryText),
    headline: truncateChars(headline ?? primaryText ?? description ?? "", META_TEXT_RECOMMENDED_LIMITS.headline),
    description: truncateChars(description ?? "詳しくはこちら", META_TEXT_RECOMMENDED_LIMITS.description),
    callToAction: CLI_CREATIVE_CALL_TO_ACTIONS.has(cta) ? cta : DEFAULT_GENERATED_CTA,
    rationale: readString(item.rationale),
  };
}

function fallbackCreativeTextVariant(prompt: string, accountDisplayName: string): CreativeTextVariant {
  const fallbackHeadline = accountDisplayName || "詳しく見る";
  return {
    primaryText: truncateChars(prompt || `${fallbackHeadline}の魅力を詳しく見る`, META_TEXT_RECOMMENDED_LIMITS.primaryText),
    headline: truncateChars(fallbackHeadline, META_TEXT_RECOMMENDED_LIMITS.headline),
    description: truncateChars("詳しくはこちら", META_TEXT_RECOMMENDED_LIMITS.description),
    callToAction: DEFAULT_GENERATED_CTA,
    rationale: "LLMコピー生成が使えない場合のフォールバック",
  };
}

function fillTextVariants(variants: CreativeTextVariant[], count: number): CreativeTextVariant[] {
  const out = variants.slice(0, count);
  const fallback = variants[0] ?? fallbackCreativeTextVariant("", "詳しく見る");
  while (out.length < count) out.push({ ...fallback });
  return out;
}

function truncateChars(value: string, max: number): string {
  const chars = Array.from(value.trim().replace(/\s+/g, " "));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

async function prepareMedia(input: {
  input: CreativeSubmissionInput;
  accountKey: string;
  accountDisplayName: string;
  accountCurrency: string | null;
  creativeId: string;
  storage: LocalDiskStorage;
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  imageProvider: ImageProvider | null;
  creativeQaPolicy: CreativeQaPolicy | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  referenceImages: ImageReferenceInput[];
  referenceImageUsageMode: ReferenceImageUsageMode;
  preferCodexImageProvider?: boolean;
}): Promise<{
  mediaType: "image" | "video" | "carousel" | "text";
  storageKeys: string[];
  generatedImage: boolean;
  provider: string | null;
  model: string | null;
}> {
  const uploaded = input.input.uploadedMedia ?? [];
  if (uploaded.length > 0) {
    const stored = await storeUploadedMedia(input.storage, input.accountKey, input.creativeId, uploaded);
    return {
      mediaType: input.input.mediaType ?? stored.mediaType,
      storageKeys: stored.storageKeys,
      generatedImage: false,
      provider: null,
      model: null,
    };
  }
  if (input.input.localMediaPaths && input.input.localMediaPaths.length > 0) {
    const stored = await storeLocalMedia(input.storage, input.accountKey, input.creativeId, input.input.localMediaPaths);
    return {
      mediaType: input.input.mediaType ?? stored.mediaType,
      storageKeys: stored.storageKeys,
      generatedImage: false,
      provider: null,
      model: null,
    };
  }
  const wantsImage = input.input.generateImage || input.input.mediaType === "image";
  const contextualPrompt = buildCreativeSubmissionImagePrompt({
    input: input.input,
    accountKey: input.accountKey,
    accountDisplayName: input.accountDisplayName,
    accountCurrency: input.accountCurrency,
    creativeContext: input.creativeContext,
    referenceImageUsageMode: input.referenceImageUsageMode,
  });
  if (wantsImage && contextualPrompt) {
    const selected =
      input.imageProvider ??
      (await selectImageProviderForWorker(input.env, {
        prisma: input.prisma,
        preferCodex: input.preferCodexImageProvider === true,
      })).provider;
    const generated = await generateAndQaCreative({
      provider: selected,
      request: {
        prompt: contextualPrompt,
        purpose: "creative_submission",
        referenceImages: input.referenceImages,
        variationConditions: [
          {
            width: 1080,
            height: 1080,
            format: "png",
            variantKey: "feed_square",
          },
        ],
      },
      policy: input.creativeQaPolicy ?? DEFAULT_CREATIVE_QA_POLICY,
    });
    if (generated.generation && generated.qa) {
      const persisted = await persistCreativeAssets({
        storage: input.storage,
        accountKey: input.accountKey,
        creativeId: input.creativeId,
        generation: generated.generation,
        qa: generated.qa,
        links: { pullRequestNumber: null },
      });
      return {
        mediaType: "image",
        storageKeys: persisted.assets.map((a) => a.storageKey),
        generatedImage: true,
        provider: generated.generation.meta.provider,
        model: generated.generation.meta.model,
      };
    }
  }
  return {
    mediaType: input.input.mediaType ?? "text",
    storageKeys: [],
    generatedImage: false,
    provider: null,
    model: null,
  };
}

async function storeUploadedMedia(
  storage: LocalDiskStorage,
  accountKey: string,
  creativeId: string,
  media: UploadedCreativeMedia[]
): Promise<{ storageKeys: string[]; mediaType: "image" | "video" | "carousel" }> {
  const storageKeys: string[] = [];
  let detected: "image" | "video" = "image";
  for (const item of media) {
    const safe = safeFilename(item.filename);
    const kind = detectMediaKind(safe, item.mimeType ?? null);
    detected = kind;
    if (item.bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new Error(`${safe} は 100MB を超えるため取り込めません。`);
    }
    const key = `creative-submissions/${accountKey}/${creativeId}/${safe}`;
    await storage.write(key, item.bytes);
    storageKeys.push(key);
  }
  return { storageKeys, mediaType: storageKeys.length > 1 ? "carousel" : detected };
}

async function storeLocalMedia(
  storage: LocalDiskStorage,
  accountKey: string,
  creativeId: string,
  mediaPaths: string[]
): Promise<{ storageKeys: string[]; mediaType: "image" | "video" | "carousel" }> {
  const storageKeys: string[] = [];
  let detected: "image" | "video" = "image";
  for (const rawPath of mediaPaths) {
    const abs = path.resolve(rawPath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`素材ファイルではありません: ${rawPath}`);
    if (stat.size > MAX_MEDIA_BYTES) throw new Error(`${rawPath} は 100MB を超えるため取り込めません。`);
    const filename = safeFilename(path.basename(abs));
    detected = detectMediaKind(filename, null);
    const key = `creative-submissions/${accountKey}/${creativeId}/${filename}`;
    await storage.write(key, fs.readFileSync(abs));
    storageKeys.push(key);
  }
  return { storageKeys, mediaType: storageKeys.length > 1 ? "carousel" : detected };
}

async function loadSubmissionReferenceImages(
  input: CreativeSubmissionInput
): Promise<ImageReferenceInput[]> {
  const refs: ImageReferenceInput[] = [];
  for (const item of input.uploadedReferenceMedia ?? []) {
    const filename = safeFilename(item.filename);
    const mimeType = referenceMimeType(filename, item.mimeType);
    if (!mimeType) continue;
    if (item.bytes.byteLength === 0 || item.bytes.byteLength > MAX_MEDIA_BYTES) continue;
    refs.push({
      bytes: item.bytes,
      mimeType,
      filename,
      sourceRef: `upload://${filename}`,
    });
  }
  for (const rawPath of input.referenceImagePaths ?? []) {
    const abs = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MEDIA_BYTES) continue;
    const filename = safeFilename(path.basename(abs));
    const mimeType = referenceMimeType(filename, null);
    if (!mimeType) continue;
    refs.push({
      bytes: new Uint8Array(fs.readFileSync(abs)),
      mimeType,
      filename,
      sourceRef: abs,
      localPath: abs,
    });
  }
  return refs;
}

function referenceMimeType(
  filename: string,
  mimeType: string | null | undefined
): ImageReferenceInput["mimeType"] | null {
  const lowerMime = mimeType?.toLowerCase() ?? "";
  if (lowerMime === "image/png") return "image/png";
  if (lowerMime === "image/jpeg" || lowerMime === "image/jpg") return "image/jpeg";
  if (lowerMime === "image/webp") return "image/webp";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return null;
}

function detectMediaKind(filename: string, mimeType: string | null): "image" | "video" {
  const lowerMime = mimeType?.toLowerCase() ?? "";
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.startsWith("video/")) return "video";
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  throw new Error(`対応していない素材形式です: ${filename}`);
}

function placeAdDraft(
  brand: Record<string, unknown>,
  opts: {
    input: CreativeSubmissionInput;
    creativeId: string;
    adId: string;
  }
): {
  campaignId: string;
  adsetId: string;
  createdCampaign: boolean;
  createdAdset: boolean;
  adoptedCampaign: boolean;
  adoptedAdset: boolean;
} {
  const ad = {
    id: opts.adId,
    name: opts.input.adName || opts.input.creativeName || opts.adId,
    creativeRef: opts.creativeId,
    initialState: "paused",
    ...removeUndefined({
      pixelId: opts.input.adPixelId,
      trackingSpecs: opts.input.trackingSpecs,
    }),
  };
  const adsetOptions = buildAdsetOptions(opts.input);
  const campaigns = ensureArray(brand, "campaigns");
  if (opts.input.campaignId && opts.input.adsetId) {
    for (const campaign of campaigns) {
      if (!isRecord(campaign) || campaign.id !== opts.input.campaignId) continue;
      const adsets = ensureArray(campaign, "adsets");
      for (const adset of adsets) {
        if (!isRecord(adset) || adset.id !== opts.input.adsetId) continue;
        ensureArray(adset, "ads").push(ad);
        return {
          campaignId: opts.input.campaignId,
          adsetId: opts.input.adsetId,
          createdCampaign: false,
          createdAdset: false,
          adoptedCampaign: false,
          adoptedAdset: false,
        };
      }
      adsets.push(importedExistingAdset(opts.input, ad));
      return {
        campaignId: opts.input.campaignId,
        adsetId: opts.input.adsetId,
        createdCampaign: false,
        createdAdset: false,
        adoptedCampaign: false,
        adoptedAdset: true,
      };
    }
    campaigns.push(importedExistingCampaign(opts.input, ad));
    return {
      campaignId: opts.input.campaignId,
      adsetId: opts.input.adsetId,
      createdCampaign: false,
      createdAdset: false,
      adoptedCampaign: true,
      adoptedAdset: true,
    };
  }
  if (opts.input.campaignId && opts.input.adsetName) {
    for (const campaign of campaigns) {
      if (!isRecord(campaign) || campaign.id !== opts.input.campaignId) continue;
      const adsets = ensureArray(campaign, "adsets");
      const adsetId = uniqueId(adsets, makeStableId(opts.input.adsetName));
      adsets.push(newAdsetDraft(opts.input, ad, adsetId, adsetOptions));
      return {
        campaignId: opts.input.campaignId,
        adsetId,
        createdCampaign: false,
        createdAdset: true,
        adoptedCampaign: false,
        adoptedAdset: false,
      };
    }
    const adsetId = makeStableId(opts.input.adsetName);
    campaigns.push(importedExistingCampaign(opts.input, ad, newAdsetDraft(opts.input, ad, adsetId, adsetOptions)));
    return {
      campaignId: opts.input.campaignId,
      adsetId,
      createdCampaign: false,
      createdAdset: true,
      adoptedCampaign: true,
      adoptedAdset: false,
    };
  }

  const campaignId = uniqueId(campaigns, makeStableId(opts.input.campaignName ?? "campaign"));
  const adsetId = makeStableId(opts.input.adsetName ?? "adset");
  campaigns.push({
    id: campaignId,
    name: opts.input.campaignName,
    objective: opts.input.objective,
    initialState: "paused",
    budget: removeUndefined({
      dailyBudget: dailyBudget(opts.input),
      lifetimeBudget: lifetimeBudget(opts.input),
    }),
    ...(opts.input.adsetBudgetSharing !== undefined ? { adsetBudgetSharing: opts.input.adsetBudgetSharing } : {}),
    adsets: [
      {
        id: adsetId,
        name: opts.input.adsetName,
        initialState: "paused",
        ...adsetOptions,
        targeting: removeUndefined({
          countries: opts.input.countries ?? [],
          ageMin: opts.input.ageMin,
          ageMax: opts.input.ageMax,
          interests: [],
          customAudiences: [],
        }),
        ads: [ad],
      },
    ],
  });
  return {
    campaignId,
    adsetId,
    createdCampaign: true,
    createdAdset: true,
    adoptedCampaign: false,
    adoptedAdset: false,
  };
}

function importedExistingCampaign(
  input: CreativeSubmissionInput,
  ad: Record<string, unknown>,
  adset: Record<string, unknown> = importedExistingAdset(input, ad)
) {
  return {
    id: input.campaignId!,
    externalId: input.campaignId!,
    importedExisting: true,
    name: input.campaignName || `Existing campaign ${input.campaignId}`,
    objective: input.objective ?? "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: removeUndefined({
      dailyBudget: dailyBudget(input) ?? 1,
      lifetimeBudget: lifetimeBudget(input),
    }),
    adsets: [adset],
  };
}

function newAdsetDraft(
  input: CreativeSubmissionInput,
  ad: Record<string, unknown>,
  adsetId: string,
  adsetOptions = buildAdsetOptions(input)
) {
  return {
    id: adsetId,
    name: input.adsetName!,
    initialState: "paused",
    ...(dailyBudget(input) !== undefined || lifetimeBudget(input) !== undefined
      ? {
          budget: removeUndefined({
            dailyBudget: dailyBudget(input),
            lifetimeBudget: lifetimeBudget(input),
          }),
        }
      : {}),
    ...adsetOptions,
    targeting: removeUndefined({
      countries: input.countries ?? [],
      ageMin: input.ageMin,
      ageMax: input.ageMax,
      interests: [],
      customAudiences: [],
    }),
    ads: [ad],
  };
}

function importedExistingAdset(input: CreativeSubmissionInput, ad: Record<string, unknown>) {
  return {
    id: input.adsetId!,
    externalId: input.adsetId!,
    importedExisting: true,
    name: input.adsetName || `Existing adset ${input.adsetId}`,
    initialState: "paused",
    targeting: removeUndefined({
      countries: input.countries ?? [],
      interests: [],
      customAudiences: [],
    }),
    ads: [ad],
  };
}

function buildAdsetOptions(input: CreativeSubmissionInput): Record<string, unknown> {
  return removeUndefined({
    optimizationGoal: input.optimizationGoal,
    billingEvent: input.billingEvent,
    bidAmount: bidAmount(input),
    startTime: input.startTime,
    endTime: input.endTime,
    pixelId: input.pixelId,
    customEventType: input.customEventType,
  });
}

function buildCreativeSubmissionOperations(input: {
  input: CreativeSubmissionInput;
  accountKey: string;
  accountCurrency: string;
  creativeId: string;
  adId: string;
  placement: {
    campaignId: string;
    adsetId: string;
    createdCampaign: boolean;
    createdAdset: boolean;
  };
  creative: Record<string, unknown>;
  preparedStorageKeys: string[];
  storage: LocalDiskStorage;
}): OperationProposalAction[] {
  const mediaPath = input.preparedStorageKeys[0]
    ? input.storage.resolve(input.preparedStorageKeys[0])
    : null;
  const creativeArgs = [
    "ads",
    "creative",
    "create",
    "--name",
    String(input.creative.name ?? input.creativeId),
    ...flagIfString("--page-id", input.input.pageId),
    ...(mediaPath && input.input.mediaType !== "video" ? ["--image", mediaPath] : []),
    ...(mediaPath && input.input.mediaType === "video" ? ["--video", mediaPath] : []),
    ...flagIfString("--body", input.input.body ?? input.input.primaryText ?? input.input.prompt),
    ...flagIfString("--title", input.input.title ?? input.input.headline),
    ...flagIfString("--link-url", input.input.linkUrl),
    ...flagIfString("--description", input.input.description),
    ...flagIfString("--call-to-action", input.input.callToAction ? cliValue(input.input.callToAction) : undefined),
    ...flagIfString("--instagram-actor-id", input.input.instagramActorId),
    ...repeatFlags("--titles", input.input.titles),
    ...repeatFlags("--bodies", input.input.bodies),
    ...repeatFlags("--descriptions", input.input.descriptions),
    ...repeatFlags("--call-to-actions", input.input.callToActions?.map((v) => v ? cliValue(v) : "")),
  ];

  const operations: OperationProposalAction[] = [
    {
      resource: "creative",
      verb: "create",
      args: creativeArgs,
      entity: {
        nodeType: "creative",
        nodeKey: input.creativeId,
        displayName: String(input.creative.name ?? input.creativeId),
      },
      externalIdRequired: true,
    },
  ];

  let campaignRef = input.input.campaignId ?? input.placement.campaignId;
  if (input.placement.createdCampaign) {
    operations.push({
      resource: "campaign",
      verb: "create",
      args: [
        "ads",
        "campaign",
        "create",
        "--name",
        input.input.campaignName ?? input.placement.campaignId,
        "--objective",
        cliValue(input.input.objective ?? "OUTCOME_TRAFFIC"),
        "--status",
        "paused",
        ...budgetFlagsForOperations(input.input, input.accountCurrency),
        ...(input.input.adsetBudgetSharing !== undefined
          ? [input.input.adsetBudgetSharing ? "--adset-budget-sharing" : "--no-adset-budget-sharing"]
          : []),
      ],
      entity: {
        nodeType: "campaign",
        nodeKey: input.placement.campaignId,
        displayName: input.input.campaignName ?? input.placement.campaignId,
        status: "paused",
      },
      externalIdRequired: true,
    });
    campaignRef = operationRef("campaign", input.placement.campaignId);
  }

  let adsetRef = input.input.adsetId ?? input.placement.adsetId;
  if (input.placement.createdAdset) {
    operations.push({
      resource: "adset",
      verb: "create",
      args: [
        "ads",
        "adset",
        "create",
        campaignRef,
        "--name",
        input.input.adsetName ?? input.placement.adsetId,
        "--status",
        "paused",
        ...flagIfString("--optimization-goal", input.input.optimizationGoal ? cliValue(input.input.optimizationGoal) : undefined),
        ...flagIfString("--billing-event", input.input.billingEvent ? cliValue(input.input.billingEvent) : undefined),
        ...budgetFlagsForOperations(input.input, input.accountCurrency),
        ...(input.input.bidAmount !== undefined
          ? ["--bid-amount", amountToMinorUnitsForOperations(input.input.bidAmount, input.accountCurrency)]
          : []),
        ...flagIfString("--start-time", input.input.startTime),
        ...flagIfString("--end-time", input.input.endTime),
        ...((input.input.countries ?? []).length > 0
          ? ["--targeting-countries", (input.input.countries ?? []).join(",")]
          : []),
        ...flagIfString("--pixel-id", input.input.pixelId),
        ...flagIfString("--custom-event-type", input.input.customEventType ? cliValue(input.input.customEventType) : undefined),
      ],
      entity: {
        nodeType: "adset",
        nodeKey: input.placement.adsetId,
        displayName: input.input.adsetName ?? input.placement.adsetId,
        parentNodeType: "campaign",
        parentNodeKey: input.placement.campaignId,
        status: "paused",
      },
      externalIdRequired: true,
    });
    adsetRef = operationRef("adset", input.placement.adsetId);
  }

  operations.push({
    resource: "ad",
    verb: "create",
    args: [
      "ads",
      "ad",
      "create",
      adsetRef,
      "--name",
      input.input.adName ?? input.input.creativeName ?? input.adId,
      "--creative-id",
      operationRef("creative", input.creativeId),
      "--status",
      "paused",
      ...flagIfString("--pixel-id", input.input.adPixelId),
      ...(input.input.trackingSpecs ? ["--tracking-specs", JSON.stringify(input.input.trackingSpecs)] : []),
    ],
    entity: {
      nodeType: "ad",
      nodeKey: input.adId,
      displayName: input.input.adName ?? input.input.creativeName ?? input.adId,
      parentNodeType: "adset",
      parentNodeKey: input.placement.adsetId,
      status: "paused",
    },
    externalIdRequired: true,
  });

  return operations;
}

function operationRef(nodeType: string, nodeKey: string): string {
  return `{{${nodeType}:${nodeKey}}}`;
}

function flagIfString(flag: string, value: unknown): string[] {
  return typeof value === "string" && value.trim().length > 0 ? [flag, value.trim()] : [];
}

function repeatFlags(flag: string, values: readonly string[] | undefined): string[] {
  return (values ?? []).filter((value) => value.trim().length > 0).flatMap((value) => [flag, value]);
}

function budgetFlagsForOperations(input: CreativeSubmissionInput, accountCurrency: string): string[] {
  const out: string[] = [];
  const daily = dailyBudget(input);
  const lifetime = lifetimeBudget(input);
  if (daily !== undefined) out.push("--daily-budget", amountToMinorUnitsForOperations(daily, accountCurrency));
  if (lifetime !== undefined) out.push("--lifetime-budget", amountToMinorUnitsForOperations(lifetime, accountCurrency));
  return out;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function amountToMinorUnitsForOperations(value: number, accountCurrency: string): string {
  const currency = accountCurrency.trim().toUpperCase();
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return String(Math.round(value * multiplier));
}

function cliValue(value: string): string {
  return value.trim().toLowerCase();
}

function creativeContextToMetadata(
  context: ImprovementPrCreativeGenerationContext | null
): Prisma.InputJsonValue {
  if (!context) return null as unknown as Prisma.InputJsonValue;
  return {
    strategy: context.strategy,
    target: context.target ? creativeNodeToMetadata(context.target) : null,
    references: context.references.slice(0, 3).map(creativeNodeToMetadata),
    notes: context.notes ?? [],
  } as Prisma.InputJsonValue;
}

function creativeNodeToMetadata(node: ImprovementPrCreativeNodeContext): Record<string, unknown> {
  return {
    hierarchyId: node.hierarchyId,
    hierarchy: node.hierarchy,
    nodeKey: node.nodeKey,
    displayName: node.displayName,
    status: node.status,
    current: node.current,
    rationale: node.rationale,
    creative: node.creative ?? null,
  };
}

function readAccountKey(input: CreativeSubmissionInput, fallback: string | null): string {
  const key = input.accountKey?.trim() || fallback;
  if (!key) throw new Error("accountKey が未指定で、デフォルト広告アカウントも未設定です。");
  return key;
}

async function inferCreativeIdentity(input: {
  prisma: PrismaClient;
  accountKey: string;
  adAccountId: string;
  state: Record<string, unknown>;
  input: CreativeSubmissionInput;
}): Promise<void> {
  if (input.input.pageId && input.input.instagramUserId) return;
  const candidates = [
    ...identityCandidatesFromState(input.state),
    ...(await identityCandidatesFromMeta(input.prisma, input.adAccountId)),
  ];
  const chosen = chooseIdentityCandidate(candidates, input.input);
  if (!input.input.pageId && chosen?.pageId) input.input.pageId = chosen.pageId;
  if (!input.input.instagramUserId && chosen?.instagramUserId) {
    input.input.instagramUserId = chosen.instagramUserId;
  }
}

async function inferInstagramActorIdForCli(input: {
  prisma: PrismaClient;
  adAccountId: string;
  input: CreativeSubmissionInput;
}): Promise<void> {
  if (input.input.instagramActorId || !input.input.instagramUserId) return;
  const actorId = await resolveInstagramActorIdForCli({
    prisma: input.prisma,
    adAccountId: input.adAccountId,
    instagramUserId: input.input.instagramUserId,
  });
  if (actorId) input.input.instagramActorId = actorId;
}

async function resolveInstagramActorIdForCli(input: {
  prisma: PrismaClient;
  adAccountId: string;
  instagramUserId: string;
}): Promise<string | null> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma: input.prisma }).catch(() => null);
  if (!selection || selection.choice === "stub") return null;
  const lease = await selection.adapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease) return null;
  const accountId = input.adAccountId.startsWith("act_")
    ? input.adAccountId
    : `act_${input.adAccountId}`;
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/instagram_accounts`);
  url.searchParams.set("fields", "id,ig_id");
  url.searchParams.set("limit", "100");
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${lease.accessToken}`,
    },
  }).catch(() => null);
  if (!response?.ok) return null;
  const json = (await response.json().catch(() => null)) as unknown;
  const rows = isRecord(json) && Array.isArray(json.data) ? json.data.filter(isRecord) : [];
  const matched = rows.find((row) => readString(row.id) === input.instagramUserId);
  return readString(matched?.ig_id);
}

function identityCandidatesFromState(state: Record<string, unknown>): MetaAssetIdentityCandidate[] {
  const creatives = Array.isArray(state.creatives) ? state.creatives.filter(isRecord) : [];
  return creatives
    .slice()
    .reverse()
    .map((creative) => ({
      source: "creative_object_story_spec" as const,
      pageId: readString(creative.pageId),
      instagramUserId: readString(creative.instagramUserId),
    }))
    .filter((candidate) => candidate.pageId || candidate.instagramUserId);
}

async function identityCandidatesFromMeta(
  prisma: PrismaClient,
  adAccountId: string
): Promise<MetaAssetIdentityCandidate[]> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma }).catch(() => null);
  if (!selection || selection.choice === "stub") return [];
  const lease = await selection.adapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease) return [];
  const report = await fetchMetaAssetReadiness({
    accessToken: lease.accessToken,
    adAccountId,
    limit: 100,
  });
  return report.candidates;
}

function chooseIdentityCandidate(
  candidates: readonly MetaAssetIdentityCandidate[],
  input: CreativeSubmissionInput
): MetaAssetIdentityCandidate | null {
  const pageId = input.pageId?.trim() || null;
  const instagramUserId = input.instagramUserId?.trim() || null;
  const withBoth = candidates.filter((candidate) => candidate.pageId && candidate.instagramUserId);
  if (pageId && instagramUserId) {
    return withBoth.find((candidate) => candidate.pageId === pageId && candidate.instagramUserId === instagramUserId) ?? null;
  }
  if (pageId) {
    return withBoth.find((candidate) => candidate.pageId === pageId) ??
      candidates.find((candidate) => candidate.pageId === pageId) ??
      null;
  }
  if (instagramUserId) {
    return withBoth.find((candidate) => candidate.instagramUserId === instagramUserId) ??
      candidates.find((candidate) => candidate.instagramUserId === instagramUserId) ??
      null;
  }
  const firstWithBoth = withBoth[0];
  if (firstWithBoth) return firstWithBoth;
  const uniquePages = uniqueNonNull(candidates.map((candidate) => candidate.pageId));
  const uniqueInstagramUsers = uniqueNonNull(candidates.map((candidate) => candidate.instagramUserId));
  if (uniquePages.length === 1 || uniqueInstagramUsers.length === 1) {
    return {
      source: "creative_object_story_spec",
      pageId: uniquePages[0] ?? null,
      instagramUserId: uniqueInstagramUsers[0] ?? null,
    };
  }
  return null;
}

function uniqueNonNull(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function ensureArray(parent: Record<string, unknown>, key: string): Record<string, unknown>[] {
  if (!Array.isArray(parent[key])) parent[key] = [];
  const arr = (parent[key] as unknown[]).filter(isRecord) as Record<string, unknown>[];
  parent[key] = arr;
  return arr;
}

function uniqueId(existing: Record<string, unknown>[], base: string): string {
  let candidate = base && ID_RE.test(base) ? base : "draft";
  const taken = new Set(existing.map((item) => readString(item.id)).filter((v): v is string => Boolean(v)));
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${candidate}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${Date.now().toString(36)}`;
}

function uniqueNestedAdId(brand: Record<string, unknown>, base: string): string {
  const taken = new Set<string>();
  for (const campaign of ensureArray(brand, "campaigns")) {
    for (const adset of ensureArray(campaign, "adsets")) {
      for (const ad of ensureArray(adset, "ads")) {
        const id = readString(ad.id);
        if (id) taken.add(id);
      }
    }
  }
  return uniqueId([...taken].map((id) => ({ id })), base);
}

function makeStableId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ID_RE.test(normalized) ? normalized : `draft-${Date.now().toString(36)}`;
}

function safeFilename(value: string): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!base || base === "." || base === ".." || base.includes(path.sep)) {
    throw new Error(`素材ファイル名が不正です: ${value}`);
  }
  return base;
}

function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function dailyBudget(input: CreativeSubmissionInput): number | undefined {
  return input.dailyBudget;
}

function lifetimeBudget(input: CreativeSubmissionInput): number | undefined {
  return input.lifetimeBudget;
}

function bidAmount(input: CreativeSubmissionInput): number | undefined {
  return input.bidAmount;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes" || v === "1") return true;
    if (v === "false" || v === "no" || v === "0") return false;
  }
  return null;
}

function readInteger(value: unknown): number | null {
  const n = readNumber(value);
  return n === null ? null : Math.trunc(n);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    const s = readString(item);
    return s ? [s] : [];
  });
  return out.length > 0 ? out : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  const n = readInteger(value);
  return n !== null && n > 0 ? n : null;
}

function readCallToActionArray(value: unknown): CreativeSubmissionInput["callToActions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    const cta = readCallToAction(item);
    return cta ? [cta] : [];
  });
  return out.length > 0 ? out : undefined;
}

function readCountries(value: unknown): string[] | undefined {
  const arr = readStringArray(value);
  if (!arr) return undefined;
  const out = arr.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return out.length > 0 ? out : undefined;
}

function readMediaType(value: unknown): CreativeSubmissionInput["mediaType"] | null {
  const v = readString(value);
  if (v === "image" || v === "video" || v === "carousel" || v === "text") return v;
  return null;
}

function readCallToAction(value: unknown): CreativeSubmissionInput["callToAction"] | null {
  return readMetaEnumToken(value);
}

function readObjective(value: unknown): CreativeSubmissionInput["objective"] | null {
  const v = readString(value)?.toUpperCase();
  if (
    v === "OUTCOME_AWARENESS" ||
    v === "OUTCOME_TRAFFIC" ||
    v === "OUTCOME_ENGAGEMENT" ||
    v === "OUTCOME_LEADS" ||
    v === "OUTCOME_APP_PROMOTION" ||
    v === "OUTCOME_SALES"
  ) return v;
  return null;
}

function readOptimizationGoal(value: unknown): CreativeSubmissionInput["optimizationGoal"] | null {
  return readMetaEnumToken(value);
}

function readBillingEvent(value: unknown): CreativeSubmissionInput["billingEvent"] | null {
  return readMetaEnumToken(value);
}

function readMetaEnumToken(value: unknown): string | null {
  const v = readString(value)?.trim().toUpperCase();
  if (v && /^[A-Z][A-Z0-9_]*$/.test(v)) return v;
  return null;
}

function detectRequestedUnsupportedFields(args: Record<string, unknown>): string[] | undefined {
  const labels: Array<[string, string]> = [
    ["targeting", "詳細ターゲティング"],
    ["geoLocations", "地域半径・都市指定"],
    ["geo_locations", "地域半径・都市指定"],
    ["excludedGeoLocations", "除外地域"],
    ["excluded_geo_locations", "除外地域"],
    ["publisherPlatforms", "配信面"],
    ["publisher_platforms", "配信面"],
    ["facebookPositions", "Facebook配置"],
    ["facebook_positions", "Facebook配置"],
    ["instagramPositions", "Instagram配置"],
    ["instagram_positions", "Instagram配置"],
    ["messengerPositions", "Messenger配置"],
    ["messenger_positions", "Messenger配置"],
    ["audienceNetworkPositions", "Audience Network配置"],
    ["audience_network_positions", "Audience Network配置"],
    ["devicePlatforms", "デバイス指定"],
    ["device_platforms", "デバイス指定"],
    ["userDevice", "端末指定"],
    ["user_device", "端末指定"],
    ["userOs", "OS指定"],
    ["user_os", "OS指定"],
    ["genders", "性別指定"],
    ["locales", "言語指定"],
    ["customAudiences", "カスタムオーディエンス"],
    ["custom_audiences", "カスタムオーディエンス"],
    ["excludedCustomAudiences", "除外カスタムオーディエンス"],
    ["excluded_custom_audiences", "除外カスタムオーディエンス"],
    ["flexibleSpec", "詳細ターゲティング条件"],
    ["flexible_spec", "詳細ターゲティング条件"],
    ["exclusions", "除外詳細ターゲティング"],
    ["behaviors", "行動ターゲティング"],
    ["lifeEvents", "ライフイベント"],
    ["life_events", "ライフイベント"],
    ["advantageAudience", "Advantage audience"],
    ["advantage_audience", "Advantage audience"],
    ["targetingAutomation", "Advantage audience"],
    ["targeting_automation", "Advantage audience"],
  ];
  const out: string[] = [];
  for (const [key, label] of labels) {
    if (hasNonEmptyValue(args[key])) out.push(label);
  }
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function hasNonEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function joinCliValues(values: Set<string>): string {
  return Array.from(values).sort().join(" / ");
}

function readCustomEventType(value: unknown): CreativeSubmissionInput["customEventType"] | null {
  const v = readString(value)?.toUpperCase();
  if (
    v === "ADD_PAYMENT_INFO" ||
    v === "ADD_TO_CART" ||
    v === "ADD_TO_WISHLIST" ||
    v === "COMPLETE_REGISTRATION" ||
    v === "CONTACT" ||
    v === "CONTENT_VIEW" ||
    v === "CUSTOMIZE_PRODUCT" ||
    v === "DONATE" ||
    v === "FIND_LOCATION" ||
    v === "INITIATED_CHECKOUT" ||
    v === "LEAD" ||
    v === "OTHER" ||
    v === "PURCHASE" ||
    v === "SCHEDULE" ||
    v === "SEARCH" ||
    v === "START_TRIAL" ||
    v === "SUBMIT_APPLICATION" ||
    v === "SUBSCRIBE"
  ) return v;
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readUrgency(value: unknown): CreativeSubmissionInput["urgency"] | null {
  const v = readString(value);
  if (v === "low" || v === "normal" || v === "high") return v;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
