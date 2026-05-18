import type { PrismaClient } from "@addroid/db";
import { runMetaAdsReadOnlyQuery } from "./meta-ads-readonly-runtime.js";

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
  const linkUrl = existingCreative?.linkUrl ?? null;
  const cta = normalizeSupportedCta(existingCreative?.callToAction, warnings);
  if (!campaign) missing.push("campaignId");
  if (!adset) missing.push("adsetId");
  if (!pageId) missing.push("pageId");
  if (!instagramUserId) missing.push("instagramUserId");
  if (!linkUrl) missing.push("linkUrl");

  const suggestedPromotionArgs: Record<string, unknown> = {
    creativeId: opts.input.creativeId,
    ...(accountKey ? { accountKey } : {}),
    ...(campaign ? { campaignId: campaign.id } : {}),
    ...(adset ? { adsetId: adset.id } : {}),
    ...(pageId ? { pageId } : {}),
    ...(instagramUserId ? { instagramUserId } : {}),
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
      linkUrl
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
  });
  const summarized = rows.map(summarizeMetaObject).filter((row): row is MetaObjectSummary =>
    Boolean(row)
  );
  const active = summarized.find(isActiveMetaObject);
  const selected = active ?? summarized[0] ?? null;
  if (!selected) missing.push("existingAd");
  return selected;
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
  const creativeId = extractCreativeId(adRows[0]) ?? extractCreativeId(ad);
  if (!creativeId) {
    warnings.push("既存広告からクリエイティブIDを確認できませんでした。");
    return null;
  }
  const rows = await readMetaRows(opts, accountKey, env, {
    resource: "creative",
    action: "get",
    creativeId,
  });
  return summarizeCreative(rows[0], creativeId);
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

function summarizeCreative(
  value: unknown,
  fallbackId: string
): CreativeSubmissionContextResolverResult["existingCreative"] {
  if (!isRecord(value)) {
    return {
      id: fallbackId,
      name: null,
      pageId: null,
      instagramUserId: null,
      linkUrl: null,
      callToAction: null,
    };
  }
  const storySpec = recordAt(value, "object_story_spec");
  const linkData = recordAt(storySpec, "link_data");
  const videoData = recordAt(storySpec, "video_data");
  const templateData = recordAt(storySpec, "template_data");
  return {
    id: readString(value.id) ?? fallbackId,
    name: readString(value.name),
    pageId: readString(storySpec?.page_id ?? value.page_id),
    instagramUserId: readString(
      storySpec?.instagram_user_id ??
        value.instagram_user_id ??
        recordAt(value, "asset_feed_spec")?.instagram_user_ids
    ),
    linkUrl:
      readString(value.object_url) ??
      readString(value.template_url) ??
      readNestedString(linkData, ["call_to_action", "value", "link"]) ??
      readNestedString(videoData, ["call_to_action", "value", "link"]) ??
      readNestedString(templateData, ["call_to_action", "value", "link"]) ??
      readString(linkData?.link) ??
      readString(templateData?.link),
    callToAction:
      readNestedString(linkData, ["call_to_action", "type"]) ??
      readNestedString(videoData, ["call_to_action", "type"]) ??
      readNestedString(templateData, ["call_to_action", "type"]) ??
      readString(value.call_to_action_type),
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

function extractCreativeId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return (
    readString(value.creative_id ?? value.creativeId) ??
    readString(recordAt(value, "creative")?.id) ??
    readString(recordAt(value, "creative")?.creative_id)
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
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return readString(current);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
