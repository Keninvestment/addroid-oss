// AdDroid OSS — GitHub OAuth (web / device flow) helpers.
//
// 純粋関数を集約する。authorization URL の組み立てと code-to-token 交換を分離し、
// 実装 (Octokit adapter / Mock adapter / tests) で再利用する。
//
// AdDroid は localhost-only / outbound-only。callback も `http://127.0.0.1:<port>/...`
// を受け取る前提で、external tunnel 等は要求しない。

import { randomBytes } from "node:crypto";

/** GitHub OAuth web flow の authorization endpoint。 */
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
/** GitHub OAuth web flow の token endpoint。 */
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** GitHub OAuth device flow の device code endpoint。 */
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

/** AdDroid が ops repo を作るために必要な最小スコープ。 */
export const ADDROID_REQUIRED_SCOPES = ["repo"] as const;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** 例: "http://127.0.0.1:3000/api/oauth/github/callback" */
  redirectUri: string;
  /** 既定は ADDROID_REQUIRED_SCOPES。 */
  scopes?: readonly string[];
}

export interface BuildAuthorizationUrlOptions {
  client: OAuthClientConfig;
  /** 省略時はランダム生成。 */
  state?: string;
}

export function generateOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * GitHub の authorization URL を組み立てる。`state` は CSRF 防止用にランダム生成し、
 * 呼び出し側がセッションに保存して callback と突き合わせる責任を持つ。
 */
export function buildAuthorizationUrl(
  opts: BuildAuthorizationUrlOptions
): { authorizationUrl: string; state: string } {
  const state = opts.state ?? generateOAuthState();
  const scopes = (opts.client.scopes ?? ADDROID_REQUIRED_SCOPES).join(" ");
  const params = new URLSearchParams({
    client_id: opts.client.clientId,
    redirect_uri: opts.client.redirectUri,
    scope: scopes,
    state,
    allow_signup: "false",
  });
  return {
    authorizationUrl: `${GITHUB_AUTHORIZE_URL}?${params.toString()}`,
    state,
  };
}

export interface ExchangeCodeForTokenOptions {
  client: OAuthClientConfig;
  code: string;
  /** test seam: 既定は global fetch。 */
  fetchImpl?: typeof fetch;
}

export interface ExchangedToken {
  accessToken: string;
  refreshToken?: string;
  /** GitHub returns ` `-separated scope list. */
  grantedScopes: string[];
  /** seconds, when GitHub returns expires_in. App tokens often omit this. */
  expiresInSeconds?: number;
  tokenType?: string;
}

export interface RequestDeviceCodeOptions {
  clientId: string;
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface PollDeviceTokenOptions {
  clientId: string;
  deviceCode: string;
  fetchImpl?: typeof fetch;
}

export class OAuthExchangeError extends Error {
  readonly status?: number;
  readonly payload?: unknown;
  constructor(message: string, opts?: { status?: number; payload?: unknown }) {
    super(message);
    this.name = "OAuthExchangeError";
    this.status = opts?.status;
    this.payload = opts?.payload;
  }
}

/**
 * GitHub の `/login/oauth/access_token` に対し authorization code を交換する。
 * 成功時は token 情報を返し、失敗時は OAuthExchangeError を投げる。
 *
 * このモジュールはトークンを **平文のまま返す**。呼び出し側 (adapter) が
 * `getCryptoBoundary` で暗号化してから永続化する。平文をログに出さないこと。
 */
export async function exchangeCodeForToken(
  opts: ExchangeCodeForTokenOptions
): Promise<ExchangedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.client.clientId,
    client_secret: opts.client.clientSecret,
    code: opts.code,
    redirect_uri: opts.client.redirectUri,
  });
  let res: Response;
  try {
    res = await fetchImpl(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthExchangeError(
      `failed to reach GitHub token endpoint: ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OAuthExchangeError(
      `GitHub token endpoint returned HTTP ${res.status}`,
      { status: res.status, payload: text }
    );
  }
  const json = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        refresh_token?: string;
        scope?: string;
        expires_in?: number;
        token_type?: string;
        error?: string;
        error_description?: string;
      }
    | null;
  if (!json || typeof json !== "object") {
    throw new OAuthExchangeError("GitHub token endpoint returned a non-JSON body");
  }
  if (json.error) {
    throw new OAuthExchangeError(
      `GitHub OAuth error: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`,
      { payload: json }
    );
  }
  if (!json.access_token) {
    throw new OAuthExchangeError("GitHub token endpoint did not return access_token", {
      payload: json,
    });
  }
  const grantedScopes = (json.scope ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const result: ExchangedToken = {
    accessToken: json.access_token,
    grantedScopes,
  };
  if (json.refresh_token) result.refreshToken = json.refresh_token;
  if (typeof json.expires_in === "number") result.expiresInSeconds = json.expires_in;
  if (json.token_type) result.tokenType = json.token_type;
  return result;
}

export async function requestDeviceCode(
  opts: RequestDeviceCodeOptions
): Promise<DeviceCodeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.clientId,
    scope: (opts.scopes ?? ADDROID_REQUIRED_SCOPES).join(" "),
  });
  let res: Response;
  try {
    res = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthExchangeError(
      `failed to reach GitHub device endpoint: ${(err as Error).message}`
    );
  }
  const json = (await res.json().catch(() => null)) as
    | {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      }
    | null;
  if (!res.ok) {
    throw new OAuthExchangeError(
      `GitHub device endpoint returned HTTP ${res.status}`,
      { status: res.status, payload: json }
    );
  }
  if (!json || typeof json !== "object") {
    throw new OAuthExchangeError("GitHub device endpoint returned a non-JSON body");
  }
  if (json.error) {
    throw new OAuthExchangeError(
      `GitHub device flow error: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`,
      { payload: json }
    );
  }
  if (
    !json.device_code ||
    !json.user_code ||
    !json.verification_uri ||
    typeof json.expires_in !== "number"
  ) {
    throw new OAuthExchangeError("GitHub device endpoint returned an incomplete response", {
      payload: json,
    });
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    expiresInSeconds: json.expires_in,
    intervalSeconds: typeof json.interval === "number" && json.interval > 0 ? json.interval : 5,
  };
}

export async function pollDeviceToken(
  opts: PollDeviceTokenOptions
): Promise<ExchangedToken | { pending: true; slowDownSeconds?: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.clientId,
    device_code: opts.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  let res: Response;
  try {
    res = await fetchImpl(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthExchangeError(
      `failed to reach GitHub token endpoint: ${(err as Error).message}`
    );
  }
  const json = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        refresh_token?: string;
        scope?: string;
        expires_in?: number;
        token_type?: string;
        error?: string;
        error_description?: string;
        interval?: number;
      }
    | null;
  if (!json || typeof json !== "object") {
    throw new OAuthExchangeError("GitHub token endpoint returned a non-JSON body");
  }
  if (json.error === "authorization_pending") return { pending: true };
  if (json.error === "slow_down") {
    return {
      pending: true,
      slowDownSeconds: typeof json.interval === "number" && json.interval > 0 ? json.interval : 5,
    };
  }
  if (!res.ok) {
    throw new OAuthExchangeError(
      `GitHub token endpoint returned HTTP ${res.status}`,
      { status: res.status, payload: json }
    );
  }
  if (json.error) {
    throw new OAuthExchangeError(
      `GitHub device flow error: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`,
      { payload: json }
    );
  }
  if (!json.access_token) {
    throw new OAuthExchangeError("GitHub token endpoint did not return access_token", {
      payload: json,
    });
  }
  const grantedScopes = (json.scope ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const result: ExchangedToken = {
    accessToken: json.access_token,
    grantedScopes,
  };
  if (json.refresh_token) result.refreshToken = json.refresh_token;
  if (typeof json.expires_in === "number") result.expiresInSeconds = json.expires_in;
  if (json.token_type) result.tokenType = json.token_type;
  return result;
}
