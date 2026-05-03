// AdDroid OSS — Meta OAuth (Login for Business) helpers.
//
// 純粋関数を集約する。authorization URL 組み立て、code-to-token 交換、
// long-lived token 交換、debug_token (token introspection) を分離して
// 実装 (Real adapter / Mock adapter / tests) で再利用する。
//
// AdDroid は localhost-only / outbound-only。callback も
// `http://127.0.0.1:<port>/api/oauth/meta/callback` を受け取る前提。
//
// 重要 — 本モジュールは access_token を **平文のまま** 返す。呼び出し側
// (adapter) が暗号化境界経由で永続化する。平文をログに残さないこと。

import { randomBytes } from "node:crypto";

/** Meta Graph API のバージョン。Marketing API は v18+ で安定。 */
export const META_GRAPH_API_VERSION = "v19.0";

/** Meta Login for Business の authorize endpoint。 */
export const META_AUTHORIZE_URL = `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`;

/** Meta Graph API の token endpoint。 */
export const META_TOKEN_URL = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`;

/** AdDroid が広告操作のために必要とする最小スコープ。 */
export const ADDROID_META_REQUIRED_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
] as const;

export interface MetaOAuthClientConfig {
  appId: string;
  appSecret: string;
  /** 例: "http://127.0.0.1:3000/api/oauth/meta/callback" */
  redirectUri: string;
  /** 既定は ADDROID_META_REQUIRED_SCOPES。 */
  scopes?: readonly string[];
}

export interface BuildMetaAuthorizationUrlOptions {
  client: MetaOAuthClientConfig;
  /** 省略時はランダム生成。 */
  state?: string;
}

export function generateMetaOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Meta の authorization URL を組み立てる。`state` は CSRF 防止用にランダム生成し、
 * 呼び出し側が adapter インスタンスに保持して callback と突き合わせる責任を持つ。
 */
export function buildMetaAuthorizationUrl(
  opts: BuildMetaAuthorizationUrlOptions
): { authorizationUrl: string; state: string } {
  const state = opts.state ?? generateMetaOAuthState();
  const scopes = (opts.client.scopes ?? ADDROID_META_REQUIRED_SCOPES).join(",");
  const params = new URLSearchParams({
    client_id: opts.client.appId,
    redirect_uri: opts.client.redirectUri,
    state,
    scope: scopes,
    response_type: "code",
  });
  return {
    authorizationUrl: `${META_AUTHORIZE_URL}?${params.toString()}`,
    state,
  };
}

export class MetaOAuthExchangeError extends Error {
  readonly status?: number;
  readonly payload?: unknown;
  constructor(message: string, opts?: { status?: number; payload?: unknown }) {
    super(message);
    this.name = "MetaOAuthExchangeError";
    this.status = opts?.status;
    this.payload = opts?.payload;
  }
}

export interface MetaExchangedToken {
  accessToken: string;
  /** Meta は短命トークンには expires_in を返すが、long-lived では返さないことが多い。 */
  expiresInSeconds?: number;
  tokenType?: string;
}

export interface MetaExchangeCodeForTokenOptions {
  client: MetaOAuthClientConfig;
  code: string;
  /** test seam: 既定は global fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * Meta の `/oauth/access_token` に対し authorization code を交換する。
 * 短命 (1〜2時間程度) のユーザートークンが返る。続けて `exchangeForLongLivedToken` を呼ぶ。
 *
 * credential (`client_secret`, `code`) は URL ではなく POST body に置く。
 * これによりアクセスログ・プロキシ・ブラウザ履歴経由でのトークン漏洩を防ぐ。
 */
export async function exchangeCodeForToken(
  opts: MetaExchangeCodeForTokenOptions
): Promise<MetaExchangedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.client.appId,
    client_secret: opts.client.appSecret,
    redirect_uri: opts.client.redirectUri,
    code: opts.code,
  });
  return doTokenFetch(fetchImpl, META_TOKEN_URL, body, "exchangeCodeForToken");
}

export interface MetaExchangeForLongLivedTokenOptions {
  client: Pick<MetaOAuthClientConfig, "appId" | "appSecret">;
  /** 短命トークンまたは既存の long-lived トークン (再延長可)。 */
  shortLivedToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Meta の `fb_exchange_token` フローで long-lived token を取得する。
 * Meta は long-lived → long-lived 再交換も同じエンドポイントで許可しており、
 * これを利用して expiresAt を更新する。
 *
 * `fb_exchange_token` (短命または長命のユーザートークン) と `client_secret` を URL に
 * 出さないため、POST body に form-urlencoded で渡す。
 */
export async function exchangeForLongLivedToken(
  opts: MetaExchangeForLongLivedTokenOptions
): Promise<MetaExchangedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: opts.client.appId,
    client_secret: opts.client.appSecret,
    fb_exchange_token: opts.shortLivedToken,
  });
  return doTokenFetch(fetchImpl, META_TOKEN_URL, body, "exchangeForLongLivedToken");
}

async function doTokenFetch(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: URLSearchParams,
  origin: string
): Promise<MetaExchangedToken> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new MetaOAuthExchangeError(
      `${origin}: failed to reach Meta token endpoint: ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MetaOAuthExchangeError(
      `${origin}: Meta token endpoint returned HTTP ${res.status}`,
      { status: res.status, payload: text }
    );
  }
  const json = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        expires_in?: number;
        token_type?: string;
        error?: { message?: string; type?: string; code?: number };
      }
    | null;
  if (!json || typeof json !== "object") {
    throw new MetaOAuthExchangeError(
      `${origin}: Meta token endpoint returned a non-JSON body`
    );
  }
  if (json.error) {
    const msg = json.error.message ?? "unknown error";
    throw new MetaOAuthExchangeError(
      `${origin}: Meta OAuth error: ${msg}`,
      { payload: json }
    );
  }
  if (!json.access_token) {
    throw new MetaOAuthExchangeError(
      `${origin}: Meta token endpoint did not return access_token`,
      { payload: json }
    );
  }
  const out: MetaExchangedToken = { accessToken: json.access_token };
  if (typeof json.expires_in === "number") out.expiresInSeconds = json.expires_in;
  if (json.token_type) out.tokenType = json.token_type;
  return out;
}

export interface MetaDebugTokenInfo {
  /** Meta user id (`123456789`) — 当該トークンを発行したユーザー。 */
  userId: string;
  /** トークンを発行した app の id。 */
  appId: string;
  /** トークン発効済 scope。 */
  scopes: string[];
  /** トークンの絶対 expires (epoch seconds)。0 = never (System User token 等)。 */
  expiresAt: number;
  /** Meta が is_valid=false で返した場合は false。 */
  isValid: boolean;
  /** 表示用の name (取れない場合 null)。 */
  userName?: string | null;
}

export interface DebugTokenOptions {
  /** `<app_id>|<app_secret>` 形式の app access token、もしくは独立した app token。 */
  appAccessToken: string;
  /** 検査対象の user access token (短命/長命どちらでも可)。 */
  inputToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * `/debug_token` でトークンのメタ情報を取得する。Meta が is_valid:false で返した
 * 場合でも throw せず isValid:false を返し、呼び出し側が再認証 UI に誘導できる。
 */
export async function debugToken(opts: DebugTokenOptions): Promise<MetaDebugTokenInfo> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // input_token (検査対象のユーザートークン) と app access_token のいずれも URL に
  // 出さないため、POST body に form-urlencoded で送る。
  const endpoint = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/debug_token`;
  const body = new URLSearchParams({
    input_token: opts.inputToken,
    access_token: opts.appAccessToken,
  });
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new MetaOAuthExchangeError(
      `debugToken: failed to reach Meta debug_token endpoint: ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MetaOAuthExchangeError(
      `debugToken: HTTP ${res.status}`,
      { status: res.status, payload: text }
    );
  }
  const json = (await res.json().catch(() => null)) as
    | {
        data?: {
          user_id?: string;
          app_id?: string;
          scopes?: string[];
          expires_at?: number;
          data_access_expires_at?: number;
          is_valid?: boolean;
        };
      }
    | null;
  const data = json?.data;
  if (!data) {
    throw new MetaOAuthExchangeError("debugToken: response did not include data");
  }
  return {
    userId: data.user_id ?? "",
    appId: data.app_id ?? "",
    scopes: Array.isArray(data.scopes) ? data.scopes.slice() : [],
    expiresAt: typeof data.expires_at === "number" ? data.expires_at : 0,
    isValid: data.is_valid !== false,
  };
}

/**
 * `app_id|app_secret` 形式で app access token を組み立てる。Meta はこの形式を
 * `/debug_token` で受け付ける。
 */
export function buildAppAccessToken(
  client: Pick<MetaOAuthClientConfig, "appId" | "appSecret">
): string {
  return `${client.appId}|${client.appSecret}`;
}

/**
 * Long-lived token のおおよその expiresAt を Date に変換する。
 * Meta は long-lived では expires_in を返さないことが多いため、デフォルトで
 * 約 60 日 (Meta の公称) を加算する。`debugToken` で正確な expires_at が分かれば
 * そちらを優先する。
 */
export function deriveExpiresAt(
  exchanged: MetaExchangedToken,
  fallbackSeconds = 60 * 24 * 60 * 60
): Date {
  const seconds = exchanged.expiresInSeconds && exchanged.expiresInSeconds > 0
    ? exchanged.expiresInSeconds
    : fallbackSeconds;
  return new Date(Date.now() + seconds * 1000);
}
