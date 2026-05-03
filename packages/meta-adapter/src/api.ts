// AdDroid OSS — Meta Graph API 呼び出し (read-only / OAuth flow 用).
//
// 本ファイルは `Real adapter` から呼ばれる。token は引数で受け取り、レスポンスを
// 正規化された `MetaBusiness` / `MetaAdAccount` に変換して返す。
//
// 重要: token はこのモジュールでは **直接ログ出力しない**。エラー文も token を
// 含めずに組み立てる。

import { META_GRAPH_API_VERSION } from "./oauth.js";
import type { MetaAdAccount, MetaBusiness } from "./types.js";

export interface FetchAccountsOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
  /** 既定 25。Meta はデフォルトで page size 25。1 アカウントが個人で持つ範囲では十分。 */
  limit?: number;
}

export interface FetchInsightsOptions {
  accessToken: string;
  adAccountId: string;
  fields: string[];
  level?: "account" | "campaign" | "adset" | "ad";
  timeRange?: { since: string; until: string };
  datePreset?: string;
  timeIncrement?: string;
  breakdowns?: string[];
  actionAttributionWindows?: string[];
  limit?: number;
  fetchImpl?: typeof fetch;
}

const ME_FIELDS = "id,name";
const BUSINESS_FIELDS = "id,name";
const ADACCOUNT_FIELDS =
  "id,account_id,name,account_status,currency,timezone_name,business{id,name}";

export interface MetaMeProfile {
  id: string;
  name: string;
}

export class MetaApiError extends Error {
  readonly status?: number;
  readonly payload?: unknown;
  constructor(message: string, opts?: { status?: number; payload?: unknown }) {
    super(message);
    this.name = "MetaApiError";
    this.status = opts?.status;
    this.payload = opts?.payload;
  }
}

async function fetchGraph<T>(
  fetchImpl: typeof fetch,
  path: string,
  params: Record<string, string>,
  accessToken: string,
  origin: string
): Promise<T> {
  // access_token は Authorization ヘッダで送る。URL に含めない (アクセスログ漏洩防止)。
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    throw new MetaApiError(
      `${origin}: Meta Graph fetch failed: ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MetaApiError(`${origin}: Meta Graph HTTP ${res.status}`, {
      status: res.status,
      payload: text,
    });
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | T | null;
  if (!json || typeof json !== "object") {
    throw new MetaApiError(`${origin}: Meta Graph returned non-JSON body`);
  }
  if ((json as { error?: { message?: string } }).error) {
    const msg = (json as { error?: { message?: string } }).error?.message ?? "unknown";
    throw new MetaApiError(`${origin}: Meta Graph error: ${msg}`, { payload: json });
  }
  return json as T;
}

export async function fetchMeProfile(opts: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<MetaMeProfile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const json = await fetchGraph<MetaMeProfile>(
    fetchImpl,
    "me",
    { fields: ME_FIELDS },
    opts.accessToken,
    "fetchMeProfile"
  );
  return { id: String(json.id ?? ""), name: String(json.name ?? "") };
}

export async function fetchBusinesses(opts: FetchAccountsOptions): Promise<MetaBusiness[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 25;
  type RawBusiness = { id: string; name: string };
  type Page = { data?: RawBusiness[] };
  const out: MetaBusiness[] = [];
  let path = "me/businesses";
  let params: Record<string, string> = {
    fields: BUSINESS_FIELDS,
    limit: String(limit),
  };
  // 1 ページのみ取得 (個人開発者の Business 数は通常 1〜数件)。next ページは省略。
  const page = await fetchGraph<Page>(
    fetchImpl,
    path,
    params,
    opts.accessToken,
    "fetchBusinesses"
  );
  for (const b of page.data ?? []) {
    if (!b?.id) continue;
    out.push({ id: String(b.id), name: String(b.name ?? ""), role: null });
  }
  return out;
}

export async function fetchAdAccounts(opts: FetchAccountsOptions): Promise<MetaAdAccount[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 25;
  type RawAdAccount = {
    id: string;
    account_id: string;
    name: string;
    account_status?: number;
    currency?: string;
    timezone_name?: string;
    business?: { id: string; name?: string };
  };
  type Page = { data?: RawAdAccount[] };
  const params: Record<string, string> = {
    fields: ADACCOUNT_FIELDS,
    limit: String(limit),
  };
  const page = await fetchGraph<Page>(
    fetchImpl,
    "me/adaccounts",
    params,
    opts.accessToken,
    "fetchAdAccounts"
  );
  const out: MetaAdAccount[] = [];
  for (const a of page.data ?? []) {
    if (!a?.account_id) continue;
    const accountId = String(a.account_id);
    out.push({
      accountId,
      metaAccountId: a.id ? String(a.id) : `act_${accountId}`,
      name: String(a.name ?? ""),
      currency: a.currency ?? null,
      timezoneName: a.timezone_name ?? null,
      businessId: a.business?.id ? String(a.business.id) : null,
      businessName: a.business?.name ? String(a.business.name) : null,
      accountStatus: typeof a.account_status === "number" ? a.account_status : null,
    });
  }
  return out;
}

export async function fetchInsights(opts: FetchInsightsOptions): Promise<unknown[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 100;
  const fields = opts.fields.filter((f) => f.trim().length > 0);
  if (fields.length === 0) {
    throw new MetaApiError("fetchInsights: fields is required");
  }
  const params: Record<string, string> = {
    fields: fields.join(","),
    limit: String(limit),
  };
  if (opts.level) params.level = opts.level;
  if (opts.timeRange) params.time_range = JSON.stringify(opts.timeRange);
  if (opts.datePreset) params.date_preset = opts.datePreset;
  if (opts.timeIncrement) params.time_increment = opts.timeIncrement;
  if (opts.breakdowns?.length) params.breakdowns = opts.breakdowns.join(",");
  if (opts.actionAttributionWindows?.length) {
    params.action_attribution_windows = opts.actionAttributionWindows.join(",");
  }
  type Page = { data?: unknown[] };
  const accountPath = opts.adAccountId.startsWith("act_")
    ? opts.adAccountId
    : `act_${opts.adAccountId}`;
  const page = await fetchGraph<Page>(
    fetchImpl,
    `${accountPath}/insights`,
    params,
    opts.accessToken,
    "fetchInsights"
  );
  return Array.isArray(page.data) ? page.data : [];
}
