import type { PrismaClient } from "@addroid/db";
import { META_GRAPH_API_VERSION } from "@addroid/meta-adapter";
import { runMetaAdsReadOnlyQuery } from "./meta-ads-readonly-runtime.js";
import { buildPrismaMetaAdapterSelection } from "./meta-runtime.js";

const SUPPORTED_CTA = new Set([
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
  "VIEW_INSTAGRAM_PROFILE",
  "WATCH_MORE",
]);

export interface CreativeSubmissionContextResolverInput {
  creativeId: string;
  accountKey?: string;
  campaignId?: string;
  adsetId?: string;
  preferActiveCampaign?: boolean;
  sameAsExistingAd?: boolean;
}

export interface CreativeSubmissionContextResolverResult {
  ready: boolean;
  message: string;
  missing: string[];
  warnings: string[];
  creative: {
    id: string;
    displayName: string | null;
    status: string | null;
    accountKey: string | null;
  } | null;
  campaign: MetaObjectSummary | null;
  adset: MetaObjectSummary | null;
  existingAd: MetaObjectSummary | null;
  existingCreative: {
    id: string | null;
    name: string | null;
    pageId: string | null;
    instagramUserId: string | null;
    instagramActorId: string | null;
    instagramAppLink: string | null;
    linkUrl: string | null;
    callToAction: string | null;
  } | null;
  suggestedPromotionArgs: Record<string, unknown>;
}

interface MetaObjectSummary {
  id: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
}

export function normalizeCreativeSubmissionContextResolverInput(
  args: Record<string, unknown>
): CreativeSubmissionContextResolverInput {
  const creativeId = readString(args.creativeId ?? args.id);
  if (!creativeId) throw new Error("確認する Creative ID が必要です。");
  return {
    creativeId,
    accountKey: readString(args.accountKey) ?? undefined,
    campaignId: readString(args.campaignId) ?? undefined,
    adsetId: readString(args.adsetId) ?? undefined,
    preferActiveCampaign: readBoolean(args.preferActiveCampaign) ?? true,
    sameAsExistingAd: readBoolean(args.sameAsExistingAd) ?? true,
  };
}

export async function resolveCreativeSubmissionContext(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  input: CreativeSubmissionContextResolverInput;
  env?: NodeJS.ProcessEnv;
}): Promise<CreativeSubmissionContextResolverResult> {
  const env = opts.env ?? process.env;
  const creative = await opts.prisma.creative.findFirst({
    where: {
      id: opts.input.creativeId,
      account: { workspaceId: opts.workspaceId },
    },
    select: {
      id: true,
      displayName: true,
      status: true,
      account: { select: { key: true } },
    },
  });

  const missing: string[] = [];
  const warnings: string[] = [];
  if (!creative) missing.push("creativeId");
  if (creative?.status === "qa_failed") {
    warnings.push("QA failed の生成クリエイティブは入稿PRに回せません。別案を選ぶか再生成してください。");
  }

  const accountKey = opts.input.accountKey ?? creative?.account.key;
  const campaign = await resolveCampaign(opts, accountKey, env, missing);
  const adset = campaign
    ? await resolveAdset(opts, accountKey, campaign.id, env, missing)
    : null;
  const existingAd = adset
    ? await resolveExistingAd(opts, accountKey, adset.id, env, missing)
    : null;
  const existingCreative = existingAd
    ? await resolveExistingCreative(opts, accountKey, existingAd, env, warnings)
    : null;

  const pageId = existingCreative?.pageId ?? null;
  const instagramUserId = existingCreative?.instagramUserId ?? null;
  const instagramActorId = existingCreative?.instagramActorId ?? null;
  const instagramAppLink = existingCreative?.instagramAppLink ?? null;
  const linkUrl = existingCreative?.linkUrl ?? null;
  const cta = normalizeSupportedCta(existingCreative?.callToAction, warnings);
  if (!campaign) missing.push("campaignId");
  if (!adset) missing.push("adsetId");
  if (!pageId) missing.push("pageId");
  if (!instagramUserId) missing.push("instagramUserId");
  if (!linkUrl) missing.push("linkUrl");
  if (isInstagramLinkUrl(linkUrl) && !instagramActorId) missing.push("instagramActorId");

  const suggestedPromotionArgs: Record<string, unknown> = {
    creativeId: opts.input.creativeId,
    ...(accountKey ? { accountKey } : {}),
    ...(campaign ? { campaignId: campaign.id } : {}),
    ...(adset ? { adsetId: adset.id } : {}),
    ...(pageId ? { pageId } : {}),
    ...(instagramUserId ? { instagramUserId } : {}),
    ...(instagramActorId ? { instagramActorId } : {}),
    ...(instagramAppLink ? { instagramAppLink } : {}),
    ...(linkUrl ? { linkUrl } : {}),
    ...(cta ? { callToAction: cta } : {}),
  };

  const uniqueMissing = [...new Set(missing)];
  const ready = Boolean(
    creative &&
      creative.status !== "qa_failed" &&
      campaign &&
      adset &&
      pageId &&
      instagramUserId &&
      linkUrl &&
      (!isInstagramLinkUrl(linkUrl) || instagramActorId)
  );

  return {
    ready,
    message: formatResolverMessage({
      ready,
      missing: uniqueMissing,
      warnings,
      campaign,
      adset,
      existingAd,
      existingCreative,
      suggestedPromotionArgs,
    }),
    missing: uniqueMissing,
    warnings,
    creative: creative
      ? {
          id: creative.id,
          displayName: creative.displayName,
          status: creative.status,
          accountKey: creative.account.key,
        }
      : null,
    campaign,
    adset,
    existingAd,
    existingCreative,
    suggestedPromotionArgs,
  };
}

async function resolveCampaign(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    input: CreativeSubmissionContextResolverInput;
  },
  accountKey: string | undefined,
  env: NodeJS.ProcessEnv,
  missing: string[]
): Promise<MetaObjectSummary | null> {
  if (opts.input.campaignId) {
    const rows = await readMetaRows(opts, accountKey, env, {
      resource: "campaign",
      action: "get",
      campaignId: opts.input.campaignId,
    });
    return summarizeMetaObject(rows[0]);
  }
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "campaign",
    action: "list",
    limit: 100,
  });
  const active = rows.map(summarizeMetaObject).filter((row): row is MetaObjectSummary =>
    Boolean(row && isActiveMetaObject(row))
  );
  if (active.length === 1) return active[0]!;
  if (active.length === 0) return null;
  missing.push("campaignId");
  return null;
}

async function resolveAdset(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    input: CreativeSubmissionContextResolverInput;
  },
  accountKey: string | undefined,
  campaignId: string,
  env: NodeJS.ProcessEnv,
  missing: string[]
): Promise<MetaObjectSummary | null> {
  if (opts.input.adsetId) {
    const rows = await readMetaRows(opts, accountKey, env, {
      resource: "adset",
      action: "get",
      adsetId: opts.input.adsetId,
    });
    return summarizeMetaObject(rows[0]);
  }
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "adset",
    action: "list",
    campaignId,
    limit: 100,
  }).catch(async (err) => {
    if (!isRateLimitLikeError(err)) throw err;
    const fallback = await resolveAdsetFromLocalMirror(opts, accountKey, campaignId, env);
    return fallback ? [fallback] : [];
  });
  const active = rows.map(summarizeMetaObject).filter((row): row is MetaObjectSummary =>
    Boolean(row && isActiveMetaObject(row))
  );
  if (active.length === 1) return active[0]!;
  if (active.length === 0) return null;
  missing.push("adsetId");
  return null;
}

async function resolveExistingAd(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    input: CreativeSubmissionContextResolverInput;
  },
  accountKey: string | undefined,
  adsetId: string,
  env: NodeJS.ProcessEnv,
  missing: string[]
): Promise<MetaObjectSummary | null> {
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "ad",
    action: "list",
    adsetId,
    limit: 100,
  }).catch(async (err) => {
    if (!isRateLimitLikeError(err)) throw err;
    const fallback = await resolveExistingAdFromLocalMirror(opts, accountKey, adsetId, env);
    return fallback ? [fallback] : [];
  });
  const summarized = rows.map(summarizeMetaObject).filter((row): row is MetaObjectSummary =>
    Boolean(row)
  );
  const active = summarized.find(isActiveMetaObject);
  const selected = active ?? summarized[0] ?? null;
  if (!selected) missing.push("existingAd");
  return selected;
}

async function resolveAdsetFromLocalMirror(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    input: CreativeSubmissionContextResolverInput;
  },
  accountKey: string | undefined,
  campaignId: string,
  env: NodeJS.ProcessEnv
): Promise<MetaObjectSummary | null> {
  const account = await findAdAccount(opts.prisma, opts.workspaceId, accountKey);
  if (!account) return null;
  const campaign = await opts.prisma.adsHierarchyNode.findFirst({
    where: {
      accountId: account.id,
      nodeType: "campaign",
      externalId: campaignId,
    },
    select: { id: true },
  });
  if (!campaign) return null;
  const candidates = await opts.prisma.adsHierarchyNode.findMany({
    where: {
      accountId: account.id,
      parentId: campaign.id,
      nodeType: "adset",
      status: "active",
      externalId: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      externalId: true,
      displayName: true,
      status: true,
    },
  });
  if (candidates.length !== 1 || !candidates[0]?.externalId) return null;
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "adset",
    action: "get",
    adsetId: candidates[0].externalId,
  }).catch(() => []);
  const live = summarizeMetaObject(rows[0]);
  if (live && isActiveMetaObject(live)) return live;
  return {
    id: candidates[0].externalId,
    name: candidates[0].displayName,
    status: candidates[0].status,
    effectiveStatus: candidates[0].status,
  };
}

async function resolveExistingAdFromLocalMirror(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    input: CreativeSubmissionContextResolverInput;
  },
  accountKey: string | undefined,
  adsetId: string,
  env: NodeJS.ProcessEnv
): Promise<MetaObjectSummary | null> {
  const account = await findAdAccount(opts.prisma, opts.workspaceId, accountKey);
  if (!account) return null;
  const adset = await opts.prisma.adsHierarchyNode.findFirst({
    where: {
      accountId: account.id,
      nodeType: "adset",
      externalId: adsetId,
    },
    select: { id: true },
  });
  if (!adset) return null;
  const candidates = await opts.prisma.adsHierarchyNode.findMany({
    where: {
      accountId: account.id,
      parentId: adset.id,
      nodeType: "ad",
      status: "active",
      externalId: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      externalId: true,
      displayName: true,
      status: true,
    },
  });
  const candidate = candidates[0];
  if (!candidate?.externalId) return null;
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "ad",
    action: "get",
    adId: candidate.externalId,
  }).catch(() => []);
  const live = summarizeMetaObject(rows[0]);
  if (live && isActiveMetaObject(live)) return live;
  return {
    id: candidate.externalId,
    name: candidate.displayName,
    status: candidate.status,
    effectiveStatus: candidate.status,
  };
}

async function resolveExistingCreative(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    input: CreativeSubmissionContextResolverInput;
  },
  accountKey: string | undefined,
  ad: MetaObjectSummary,
  env: NodeJS.ProcessEnv,
  warnings: string[]
): Promise<CreativeSubmissionContextResolverResult["existingCreative"]> {
  const adRows = await readMetaRows(opts, accountKey, env, {
    resource: "ad",
    action: "get",
    adId: ad.id,
  }).catch(() => []);
  const creativeId = extractCreativeIdFromMetaAd(adRows[0]) ?? extractCreativeIdFromMetaAd(ad);
  if (!creativeId) {
    warnings.push("既存広告からクリエイティブIDを確認できませんでした。");
    return null;
  }
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "creative",
    action: "get",
    creativeId,
  });
  const summarized = summarizeCreativeForSubmission(rows[0], creativeId);
  if (!summarized?.instagramUserId) return summarized;
  const graphActorId = await resolveInstagramActorIdForCli({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    accountKey,
    instagramUserId: summarized.instagramUserId,
  });
  return {
    ...summarized,
    instagramActorId: graphActorId ?? summarized.instagramActorId,
  };
}

async function readMetaRows(
  opts: { prisma: PrismaClient; workspaceId: string },
  accountKey: string | undefined,
  env: NodeJS.ProcessEnv,
  args: Record<string, unknown>
): Promise<unknown[]> {
  const result = await runMetaAdsReadOnlyQuery({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    args: {
      ...args,
      ...(accountKey ? { accountKey } : {}),
    },
    env,
  });
  return result.rows;
}

async function findAdAccount(
  prisma: PrismaClient,
  workspaceId: string,
  accountKey: string | undefined
): Promise<{ id: string; key: string; metaAccountId: string | null } | null> {
  if (accountKey) {
    return await prisma.adAccount.findFirst({
      where: {
        workspaceId,
        OR: [{ key: accountKey }, { metaAccountId: accountKey }],
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, key: true, metaAccountId: true },
    });
  }
  return await prisma.adAccount.findFirst({
    where: { workspaceId, active: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, key: true, metaAccountId: true },
  });
}

async function resolveInstagramActorIdForCli(input: {
  prisma: PrismaClient;
  workspaceId: string;
  accountKey: string | undefined;
  instagramUserId: string;
}): Promise<string | null> {
  const account = await findAdAccount(input.prisma, input.workspaceId, input.accountKey);
  const rawAccountId = account?.metaAccountId ?? account?.key ?? input.accountKey;
  if (!rawAccountId) return null;
  const selection = await buildPrismaMetaAdapterSelection({ prisma: input.prisma }).catch(() => null);
  if (!selection || selection.choice === "stub") return null;
  const lease = await selection.adapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease) return null;
  const accountId = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/instagram_accounts`);
  url.searchParams.set("fields", "id,ig_id,username");
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
  const matched = rows.find((row) =>
    readString(row.id) === input.instagramUserId || readString(row.ig_id) === input.instagramUserId
  );
  return readString(matched?.id);
}

function isRateLimitLikeError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return /API error \(17\)|User request limit reached|Application request limit reached/i.test(message);
}

function summarizeMetaObject(value: unknown): MetaObjectSummary | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  return {
    id,
    name: readString(value.name),
    status: readString(value.status),
    effectiveStatus: readString(value.effective_status ?? value.effectiveStatus),
  };
}

function isActiveMetaObject(value: MetaObjectSummary): boolean {
  const status = (value.effectiveStatus ?? value.status ?? "").toUpperCase();
  return status === "ACTIVE";
}

export function summarizeCreativeForSubmission(
  value: unknown,
  fallbackId: string
): CreativeSubmissionContextResolverResult["existingCreative"] {
  const root = parseMetaCliObjectRecord(value);
  if (!root) {
    return {
      id: fallbackId,
      name: null,
      pageId: null,
      instagramUserId: null,
      instagramActorId: null,
      instagramAppLink: null,
      linkUrl: null,
      callToAction: null,
    };
  }
  const storySpec = recordAt(root, "object_story_spec");
  const linkData = recordAt(storySpec, "link_data");
  const videoData = recordAt(storySpec, "video_data");
  const templateData = recordAt(storySpec, "template_data");
  const linkCta = recordAt(linkData, "call_to_action");
  const videoCta = recordAt(videoData, "call_to_action");
  const templateCta = recordAt(templateData, "call_to_action");
  return {
    id: readString(root.id) ?? fallbackId,
    name: readString(root.name),
    pageId: readString(storySpec?.page_id ?? root.page_id),
    instagramUserId: readString(
      storySpec?.instagram_user_id ??
        root.instagram_user_id ??
        recordAt(root, "asset_feed_spec")?.instagram_user_ids
    ),
    instagramActorId: readString(root.instagram_actor_id),
    instagramAppLink:
      readNestedString(linkCta, ["value", "app_link"]) ??
      readNestedString(videoCta, ["value", "app_link"]) ??
      readNestedString(templateCta, ["value", "app_link"]),
    linkUrl:
      readString(root.object_url) ??
      readString(root.template_url) ??
      readNestedString(linkCta, ["value", "link"]) ??
      readNestedString(videoCta, ["value", "link"]) ??
      readNestedString(templateCta, ["value", "link"]) ??
      readString(linkData?.link) ??
      readString(templateData?.link),
    callToAction:
      readString(linkCta?.type) ??
      readString(videoCta?.type) ??
      readString(templateCta?.type) ??
      readString(root.call_to_action_type),
  };
}

function normalizeSupportedCta(value: string | null | undefined, warnings: string[]): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (!normalized) return null;
  if (SUPPORTED_CTA.has(normalized)) return normalized;
  warnings.push(
    `既存広告のCTA ${normalized} は現在の入稿PR反映範囲では使えないため、LEARN_MORE を候補にします。`
  );
  return "LEARN_MORE";
}

export function extractCreativeIdFromMetaAd(value: unknown): string | null {
  const record = parseMetaCliObjectRecord(value);
  if (!record) return null;
  return (
    readString(record.creative_id ?? record.creativeId) ??
    readString(recordAt(record, "creative")?.id) ??
    readString(recordAt(record, "creative")?.creative_id)
  );
}

function formatResolverMessage(input: {
  ready: boolean;
  missing: string[];
  warnings: string[];
  campaign: MetaObjectSummary | null;
  adset: MetaObjectSummary | null;
  existingAd: MetaObjectSummary | null;
  existingCreative: CreativeSubmissionContextResolverResult["existingCreative"];
  suggestedPromotionArgs: Record<string, unknown>;
}): string {
  const lines = [
    input.ready
      ? "入稿PRに必要な配信先情報を確認できました。"
      : "入稿PRに必要な配信先情報をまだ確認しきれていません。",
  ];
  if (input.campaign) lines.push(`キャンペーン: ${input.campaign.id}`);
  if (input.adset) lines.push(`広告セット: ${input.adset.id}`);
  if (input.existingAd) lines.push(`参照した既存広告: ${input.existingAd.id}`);
  if (input.existingCreative) {
    lines.push(
      `既存広告と同様のページ: ${input.existingCreative.pageId ?? "未確認"}`,
      `Instagramユーザー: ${input.existingCreative.instagramUserId ?? "未確認"}`,
      `Instagram actor: ${input.existingCreative.instagramActorId ?? "未確認"}`,
      `遷移先: ${input.existingCreative.linkUrl ?? "未確認"}`,
      `CTA候補: ${String(input.suggestedPromotionArgs.callToAction ?? "未確認")}`
    );
  }
  for (const warning of input.warnings) lines.push(`注意点: ${warning}`);
  if (input.missing.length > 0) {
    lines.push(`不足情報: ${input.missing.join(", ")}`);
  }
  if (input.ready) {
    lines.push(
      "この内容で入稿PRを作成してよいか確認してください。承認されたら promote_creative_submission に suggestedPromotionArgs を渡してください。"
    );
  }
  return lines.join("\n");
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    const record = parseMetaCliObjectRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return readString(current);
}

export function parseMetaCliObjectRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  const record = parseMetaCliObjectRecord(value);
  if (!record) return null;
  const child = record[key];
  return parseMetaCliObjectRecord(child);
}

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = readString(item);
      if (text) return text;
    }
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return null;
}

function isInstagramLinkUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return /(^|\/\/)(www\.)?instagram\.com\//i.test(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
