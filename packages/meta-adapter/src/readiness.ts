// AdDroid OSS — Meta asset readiness checks.
//
// This module performs read-only Graph API checks used by init / account sync /
// chat / Slack / apply preflight. It intentionally returns only public object
// identifiers, display names, usernames, and error summaries. It never returns
// or logs access tokens.

import { META_GRAPH_API_VERSION } from "./oauth.js";

export interface FetchMetaAssetReadinessOptions {
  accessToken: string;
  adAccountId: string;
  pageId?: string | null;
  instagramUserId?: string | null;
  fetchImpl?: typeof fetch;
  limit?: number;
}

export interface MetaAssetIdentityCandidate {
  source: "instagram_accounts" | "page" | "adset_promoted_object" | "creative_object_story_spec";
  pageId: string | null;
  pageName?: string | null;
  instagramUserId: string | null;
  instagramUsername?: string | null;
  creativeId?: string | null;
  adsetId?: string | null;
}

export interface MetaAssetReadinessCheck {
  ok: boolean | null;
  status?: number | null;
  errorCode?: number | string | null;
  message?: string | null;
}

export interface MetaAssetReadinessReport {
  ok: boolean;
  status: "ready" | "warning" | "blocked";
  adAccountId: string;
  pageId: string | null;
  instagramUserId: string | null;
  checks: {
    adAccountReadable: MetaAssetReadinessCheck;
    instagramAccountsReadable: MetaAssetReadinessCheck;
    instagramUserVisible: boolean | null;
    pageReadable: MetaAssetReadinessCheck | null;
    pageSeenInAdsetPromotedObject: boolean | null;
    pageSeenInCreativeObjectStorySpec: boolean | null;
    identityPairSeenInCreativeObjectStorySpec: boolean | null;
  };
  candidates: MetaAssetIdentityCandidate[];
  messages: string[];
}

interface SoftGraphResult {
  ok: boolean;
  status: number | null;
  json: unknown;
  errorCode: number | string | null;
  message: string | null;
}

const DEFAULT_LIMIT = 100;

export async function fetchMetaAssetReadiness(
  opts: FetchMetaAssetReadinessOptions
): Promise<MetaAssetReadinessReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const adAccountId = normalizeAdAccountId(opts.adAccountId);
  const pageId = nonEmpty(opts.pageId);
  const instagramUserId = nonEmpty(opts.instagramUserId);
  const candidates: MetaAssetIdentityCandidate[] = [];

  const [account, igAccounts, adsets, creatives, page] = await Promise.all([
    readGraphSoft(fetchImpl, adAccountId, { fields: "id,name,account_id" }, opts.accessToken),
    readGraphSoft(
      fetchImpl,
      `${adAccountId}/instagram_accounts`,
      { fields: "id,username,ig_id", limit: String(limit) },
      opts.accessToken
    ),
    readGraphSoft(
      fetchImpl,
      `${adAccountId}/adsets`,
      { fields: "id,name,promoted_object", limit: String(limit) },
      opts.accessToken
    ),
    readGraphSoft(
      fetchImpl,
      `${adAccountId}/adcreatives`,
      { fields: "id,name,object_story_spec", limit: String(limit) },
      opts.accessToken
    ),
    pageId
      ? readGraphSoft(
          fetchImpl,
          pageId,
          {
            fields:
              "id,name,instagram_business_account{id,username,ig_id},connected_instagram_account{id,username}",
          },
          opts.accessToken
        )
      : Promise.resolve(null),
  ]);

  const igRows = rowsFromData(igAccounts.json);
  for (const row of igRows) {
    candidates.push({
      source: "instagram_accounts",
      pageId: null,
      instagramUserId: stringProp(row, "id"),
      instagramUsername: stringProp(row, "username"),
    });
  }

  let pageConnectedInstagramUserId: string | null = null;
  if (page?.ok && isRecord(page.json)) {
    const businessIg = recordProp(page.json, "instagram_business_account");
    const connectedIg = recordProp(page.json, "connected_instagram_account");
    pageConnectedInstagramUserId = stringProp(businessIg, "id") ?? stringProp(connectedIg, "id");
    candidates.push({
      source: "page",
      pageId: stringProp(page.json, "id") ?? pageId,
      pageName: stringProp(page.json, "name"),
      instagramUserId: pageConnectedInstagramUserId,
      instagramUsername: stringProp(businessIg, "username") ?? stringProp(connectedIg, "username"),
    });
  }

  const adsetRows = rowsFromData(adsets.json);
  let pageSeenInAdsetPromotedObject = pageId ? false : null;
  for (const row of adsetRows) {
    const promoted = recordProp(row, "promoted_object");
    const promotedPageId = stringProp(promoted, "page_id");
    const promotedInstagramUserId = stringProp(promoted, "instagram_user_id");
    if (promotedPageId || promotedInstagramUserId) {
      candidates.push({
        source: "adset_promoted_object",
        pageId: promotedPageId,
        instagramUserId: promotedInstagramUserId,
        adsetId: stringProp(row, "id"),
      });
    }
    if (pageId && promotedPageId === pageId) pageSeenInAdsetPromotedObject = true;
  }

  const creativeRows = rowsFromData(creatives.json);
  let pageSeenInCreativeObjectStorySpec = pageId ? false : null;
  let identityPairSeenInCreativeObjectStorySpec = pageId && instagramUserId ? false : null;
  for (const row of creativeRows) {
    const spec = recordProp(row, "object_story_spec");
    const creativePageId = stringProp(spec, "page_id");
    const creativeInstagramUserId = stringProp(spec, "instagram_user_id");
    if (creativePageId || creativeInstagramUserId) {
      candidates.push({
        source: "creative_object_story_spec",
        pageId: creativePageId,
        instagramUserId: creativeInstagramUserId,
        creativeId: stringProp(row, "id"),
      });
    }
    if (pageId && creativePageId === pageId) pageSeenInCreativeObjectStorySpec = true;
    if (
      pageId &&
      instagramUserId &&
      creativePageId === pageId &&
      creativeInstagramUserId === instagramUserId
    ) {
      identityPairSeenInCreativeObjectStorySpec = true;
    }
  }

  const instagramUserVisible = instagramUserId
    ? igRows.some((row) => stringProp(row, "id") === instagramUserId) ||
      pageConnectedInstagramUserId === instagramUserId ||
      identityPairSeenInCreativeObjectStorySpec === true
    : null;
  const pageUsable =
    !pageId ||
    page?.ok === true ||
    pageSeenInAdsetPromotedObject === true ||
    pageSeenInCreativeObjectStorySpec === true;
  const instagramUsable = !instagramUserId || instagramUserVisible === true;
  const blocked = !account.ok || !igAccounts.ok || !pageUsable || !instagramUsable;
  const status: MetaAssetReadinessReport["status"] = blocked
    ? "blocked"
    : page?.ok === false || creatives.ok === false || adsets.ok === false
      ? "warning"
      : "ready";

  const report: MetaAssetReadinessReport = {
    ok: !blocked,
    status,
    adAccountId,
    pageId,
    instagramUserId,
    checks: {
      adAccountReadable: toCheck(account),
      instagramAccountsReadable: toCheck(igAccounts),
      instagramUserVisible,
      pageReadable: page ? toCheck(page) : null,
      pageSeenInAdsetPromotedObject,
      pageSeenInCreativeObjectStorySpec,
      identityPairSeenInCreativeObjectStorySpec,
    },
    candidates: dedupeCandidates(candidates),
    messages: [],
  };
  report.messages = buildReadinessMessages(report);
  return report;
}

export function buildReadinessMessages(report: MetaAssetReadinessReport): string[] {
  const messages: string[] = [];
  if (!report.checks.adAccountReadable.ok) {
    messages.push(
      "広告アカウントを読み取れません。system user に ad account を割り当て、ads_read / ads_management を確認してください。"
    );
  }
  if (!report.checks.instagramAccountsReadable.ok) {
    messages.push(
      "広告アカウント配下の Instagram アカウント一覧を読み取れません。business_management と対象アセットの割り当てを確認してください。"
    );
  }
  if (report.pageId && !report.checks.pageReadable?.ok) {
    if (
      report.checks.pageSeenInAdsetPromotedObject ||
      report.checks.pageSeenInCreativeObjectStorySpec
    ) {
      messages.push(
        "ページ単体の読み取りはできませんが、既存の広告設定から対象ページを確認できています。apply 前の証跡としては利用できます。"
      );
    } else {
      messages.push(
        "対象ページを確認できません。Business Settings で system user に Facebook Page をアセット割り当てしてください。"
      );
    }
  }
  if (report.instagramUserId && report.checks.instagramUserVisible !== true) {
    messages.push(
      "対象 Instagram アカウントを広告アカウントまたはページ接続から確認できません。Instagram アカウントの Business 連携と system user への割り当てを確認してください。"
    );
  }
  if (messages.length === 0) {
    messages.push("Meta の広告アカウント、Facebookページ、Instagram アカウントの読み取り証跡を確認できています。");
  }
  return messages;
}

export function formatMetaAssetReadinessSummary(report: MetaAssetReadinessReport): string {
  const mark = report.ok ? "OK" : "要確認";
  const page =
    report.pageId && report.checks.pageReadable?.ok
      ? `page=${report.pageId}:readable`
      : report.pageId &&
          (report.checks.pageSeenInAdsetPromotedObject ||
            report.checks.pageSeenInCreativeObjectStorySpec)
        ? `page=${report.pageId}:evidence`
        : report.pageId
          ? `page=${report.pageId}:missing`
          : "page=未指定";
  const instagram = report.instagramUserId
    ? `ig=${report.instagramUserId}:${report.checks.instagramUserVisible ? "visible" : "missing"}`
    : "ig=未指定";
  return `${mark} ${report.adAccountId} ${page} ${instagram}`;
}

async function readGraphSoft(
  fetchImpl: typeof fetch,
  path: string,
  params: Record<string, string>,
  accessToken: string
): Promise<SoftGraphResult> {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const json = (await res.json().catch(() => null)) as unknown;
    const graphError = isRecord(json) ? recordProp(json, "error") : null;
    const message = stringProp(graphError, "message");
    const code = stringOrNumberProp(graphError, "code");
    return {
      ok: res.ok && !graphError,
      status: res.status,
      json,
      errorCode: code,
      message: message ?? (res.ok ? null : `Meta Graph HTTP ${res.status}`),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, json: null, errorCode: "fetch_failed", message };
  }
}

function toCheck(result: SoftGraphResult): MetaAssetReadinessCheck {
  return {
    ok: result.ok,
    status: result.status,
    errorCode: result.errorCode,
    message: result.message,
  };
}

function normalizeAdAccountId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  const out = value?.trim();
  return out ? out : null;
}

function rowsFromData(json: unknown): Record<string, unknown>[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data.filter(isRecord);
}

function dedupeCandidates(candidates: MetaAssetIdentityCandidate[]): MetaAssetIdentityCandidate[] {
  const seen = new Set<string>();
  const out: MetaAssetIdentityCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.source,
      candidate.pageId ?? "",
      candidate.instagramUserId ?? "",
      candidate.creativeId ?? "",
      candidate.adsetId ?? "",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out.slice(0, 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordProp(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const prop = value[key];
  return isRecord(prop) ? prop : null;
}

function stringProp(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const prop = value[key];
  return typeof prop === "string" && prop.trim() ? prop : null;
}

function stringOrNumberProp(value: unknown, key: string): string | number | null {
  if (!isRecord(value)) return null;
  const prop = value[key];
  return typeof prop === "string" || typeof prop === "number" ? prop : null;
}
