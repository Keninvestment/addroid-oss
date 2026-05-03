// AdDroid OSS — Codex / OpenAI 系 OAuth 2.0 + PKCE helpers.
//
// 純粋関数を集約する。authorization URL の組み立て、PKCE verifier/challenge 生成、
// code-to-token 交換、refresh token 交換、token introspection を分離して
// 実装 (CodexLLMProvider / Mock / tests) で再利用する。
//
// AdDroid は localhost-only / outbound-only。callback も
// `http://127.0.0.1:<port>/api/oauth/codex/callback` を受け取る前提。
//
// 重要 — 本モジュールは access_token / refresh_token を **平文のまま** 返す。
// 呼び出し側 (provider) が暗号化境界経由で永続化する。平文をログに残さないこと。

import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.0 client config。
 *
 * Codex CLI 互換の PKCE フロー (`tokenAuthMethod: "pkce_s256"`) と、
 * client_secret を持つ confidential client の両方をサポートする。
 * URL は実装ごとに異なる (Codex / OpenAI / 自前 OAuth proxy) ため、設定値として渡す。
 * クライアント識別情報をコード内に literal で残さない。
 */
export interface CodexOAuthClientConfig {
  clientId: string;
  /** confidential client のときのみ。`tokenAuthMethod: "pkce_s256"` では省略する。 */
  clientSecret?: string;
  /** 例: "http://127.0.0.1:3000/api/oauth/codex/callback" */
  redirectUri: string;
  /** `https://auth.openai.com/oauth/authorize` 等。 */
  authorizationUrl: string;
  /** `https://auth.openai.com/oauth/token` 等。 */
  tokenUrl: string;
  /** 既定: ["openai", "offline_access"]。Provider 仕様に合わせて上書き可。 */
  scopes?: readonly string[];
  /** "pkce_s256" (PKCE) | "client_secret_post" (confidential)。既定は PKCE。 */
  tokenAuthMethod?: "pkce_s256" | "client_secret_post";
  /** authorize URL に渡す追加パラメータ (audience, prompt 等)。 */
  extraAuthorizeParams?: Record<string, string>;
}

export const ADDROID_CODEX_DEFAULT_SCOPES = ["openai", "offline_access"] as const;

export interface BuildCodexAuthorizationUrlOptions {
  client: CodexOAuthClientConfig;
  /** 省略時はランダム生成。 */
  state?: string;
  /** PKCE 利用時のみ。省略時はランダム生成し戻り値に含める。 */
  codeVerifier?: string;
}

export interface BuiltCodexAuthorizationUrl {
  authorizationUrl: string;
  state: string;
  /** PKCE のみ。callback で同値を再送するため呼び出し側が保持する責任を持つ。 */
  codeVerifier?: string;
}

export function generateCodexOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * RFC 7636 準拠の PKCE code_verifier (43–128 chars, base64url-safe)。
 */
export function generatePkceCodeVerifier(): string {
  // 32 bytes → 43 chars base64url, RFC 7636 が要求する範囲に収まる。
  return randomBytes(32).toString("base64url");
}

/**
 * S256 method: code_challenge = base64url(sha256(code_verifier))
 */
export function deriveS256CodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest().toString("base64url");
}

/**
 * Codex/OpenAI の authorization URL を組み立てる。`state` は CSRF 防止用、
 * `code_verifier` は PKCE 用にランダム生成し、呼び出し側が callback まで保持する。
 */
export function buildCodexAuthorizationUrl(
  opts: BuildCodexAuthorizationUrlOptions
): BuiltCodexAuthorizationUrl {
  const state = opts.state ?? generateCodexOAuthState();
  const usePkce = (opts.client.tokenAuthMethod ?? "pkce_s256") === "pkce_s256";
  const verifier = usePkce ? opts.codeVerifier ?? generatePkceCodeVerifier() : undefined;
  const scopes = (opts.client.scopes ?? ADDROID_CODEX_DEFAULT_SCOPES).join(" ");
  const params = new URLSearchParams({
    client_id: opts.client.clientId,
    redirect_uri: opts.client.redirectUri,
    response_type: "code",
    scope: scopes,
    state,
  });
  if (usePkce && verifier) {
    params.set("code_challenge", deriveS256CodeChallenge(verifier));
    params.set("code_challenge_method", "S256");
  }
  if (opts.client.extraAuthorizeParams) {
    for (const [k, v] of Object.entries(opts.client.extraAuthorizeParams)) {
      // client_secret 系の機微パラメータは authorize URL に出してはならない。
      if (/secret/i.test(k) || /token/i.test(k)) continue;
      params.set(k, v);
    }
  }
  const authorizationUrl = `${opts.client.authorizationUrl}?${params.toString()}`;
  const out: BuiltCodexAuthorizationUrl = { authorizationUrl, state };
  if (verifier) out.codeVerifier = verifier;
  return out;
}

export class CodexOAuthExchangeError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly payload?: unknown;
  constructor(
    message: string,
    opts?: { status?: number; code?: string; payload?: unknown }
  ) {
    super(message);
    this.name = "CodexOAuthExchangeError";
    this.status = opts?.status;
    this.code = opts?.code;
    this.payload = opts?.payload;
  }
}

export interface CodexExchangedToken {
  accessToken: string;
  refreshToken?: string;
  /** seconds. provider によっては omit される。 */
  expiresInSeconds?: number;
  tokenType?: string;
  /** provider が返した granted scope 列。 */
  grantedScopes: string[];
  /** id_token (OpenID Connect) を返す provider もある。表示用に取れる場合のみ。 */
  idToken?: string;
}

export interface CodexExchangeCodeForTokenOptions {
  client: CodexOAuthClientConfig;
  code: string;
  /** PKCE 利用時に必須。 */
  codeVerifier?: string;
  fetchImpl?: typeof fetch;
}

/**
 * authorization code を access/refresh token に交換する。
 *
 * 機微パラメータ (`client_secret`, `code`, `code_verifier`, `refresh_token`) は
 * 必ず POST body に置く。URL クエリには **絶対に置かない**。これによりプロキシ・
 * アクセスログ・ブラウザ履歴経由でのトークン漏洩を防ぐ。
 */
export async function exchangeCodexCodeForToken(
  opts: CodexExchangeCodeForTokenOptions
): Promise<CodexExchangedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.client.clientId,
    redirect_uri: opts.client.redirectUri,
    code: opts.code,
  });
  applyAuthMethod(params, opts.client, opts.codeVerifier);
  return doCodexTokenFetch(fetchImpl, opts.client.tokenUrl, params, "exchangeCodexCodeForToken");
}

export interface CodexRefreshTokenOptions {
  client: CodexOAuthClientConfig;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * `refresh_token` グラントで access token を再発行する。
 * provider によっては refresh_token そのものもローテートされる (新しい
 * `refresh_token` が返ってきた場合は呼び出し側で必ず保存し直すこと)。
 */
export async function refreshCodexAccessToken(
  opts: CodexRefreshTokenOptions
): Promise<CodexExchangedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.client.clientId,
    refresh_token: opts.refreshToken,
  });
  applyAuthMethod(params, opts.client);
  return doCodexTokenFetch(fetchImpl, opts.client.tokenUrl, params, "refreshCodexAccessToken");
}

function applyAuthMethod(
  body: URLSearchParams,
  client: CodexOAuthClientConfig,
  codeVerifier?: string
): void {
  const method = client.tokenAuthMethod ?? "pkce_s256";
  if (method === "pkce_s256") {
    if (codeVerifier) body.set("code_verifier", codeVerifier);
    return;
  }
  if (method === "client_secret_post") {
    if (!client.clientSecret) {
      throw new CodexOAuthExchangeError(
        "client_secret_post requires clientSecret in CodexOAuthClientConfig"
      );
    }
    body.set("client_secret", client.clientSecret);
  }
}

async function doCodexTokenFetch(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: URLSearchParams,
  origin: string
): Promise<CodexExchangedToken> {
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
    throw new CodexOAuthExchangeError(
      `${origin}: failed to reach token endpoint: ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CodexOAuthExchangeError(
      `${origin}: token endpoint returned HTTP ${res.status}`,
      { status: res.status, payload: redactPayloadForError(text) }
    );
  }
  const json = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
        id_token?: string;
        error?: string;
        error_description?: string;
      }
    | null;
  if (!json || typeof json !== "object") {
    throw new CodexOAuthExchangeError(
      `${origin}: token endpoint returned a non-JSON body`
    );
  }
  if (json.error) {
    // error は OAuth 規格の固定 token (invalid_grant 等) を想定するが、provider が
    // 規格外の文字列を返した場合に備えて redactor を通す。error_description は自由
    // 記述で、provider によっては送信した authorization code / code_verifier /
    // client_secret / token を echo back する事故が報告されているため、Error.message
    // へ補間する前と payload に詰める前の双方でサニタイズする。
    const safeError = redactPayloadForError(String(json.error));
    const safeDescription =
      typeof json.error_description === "string" && json.error_description.length > 0
        ? redactPayloadForError(json.error_description)
        : undefined;
    throw new CodexOAuthExchangeError(
      `${origin}: OAuth error: ${safeError}${safeDescription ? ` — ${safeDescription}` : ""}`,
      {
        code: safeError,
        payload: { error: safeError, error_description: safeDescription },
      }
    );
  }
  if (!json.access_token) {
    throw new CodexOAuthExchangeError(
      `${origin}: token endpoint did not return access_token`
    );
  }
  const grantedScopes = (json.scope ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: CodexExchangedToken = {
    accessToken: json.access_token,
    grantedScopes,
  };
  if (json.refresh_token) out.refreshToken = json.refresh_token;
  if (typeof json.expires_in === "number") out.expiresInSeconds = json.expires_in;
  if (json.token_type) out.tokenType = json.token_type;
  if (json.id_token) out.idToken = json.id_token;
  return out;
}

/**
 * Error.payload や Error.message に詰める raw body から機微文字列を除去する。
 * provider が誤って token / authorization code / client_secret / code_verifier
 * を error body に echo back する事故 (実例あり) への二重防御。
 *
 * 対象:
 * - 発行済み token (sk-..., Bearer ヘッダ, JSON の access_token/refresh_token/id_token)
 * - OAuth リクエストパラメータの echo back (authorization code, code_verifier,
 *   client_secret) — JSON 形 (`"code":"..."`) と form-encoded 形 (`code=...`) の両方
 */
export function redactPayloadForError(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let out = raw;
  // OpenAI sk-... / OAuth EAA... / Bearer ヘッダ的な文字列を [REDACTED] に置換。
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  // JSON で echo back された token / OAuth credential / PKCE 値。
  const jsonFields = [
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "code_verifier",
    "code",
  ];
  for (const field of jsonFields) {
    const re = new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, "g");
    out = out.replace(re, `"${field}":"[REDACTED]"`);
  }
  // form-encoded で echo back されたケース (provider が request body をそのまま
  // error body に貼り付ける事故)。区切りは & または改行 / 空白 / 引用符。
  out = out.replace(
    /\b(access_token|refresh_token|id_token|client_secret|code_verifier|code)=([^&\s"'<>]+)/gi,
    "$1=[REDACTED]"
  );
  // 1KB 超は切り詰める (Error の payload は短くても良い)。
  if (out.length > 1024) out = out.slice(0, 1024) + "…[truncated]";
  return out;
}

/**
 * Long-lived な access token の Date を求める。expires_in が無い provider 向けに
 * 既定 1 時間を採用 (Codex CLI は 60 分の access_token + 長命 refresh_token)。
 */
export function deriveCodexExpiresAt(
  exchanged: CodexExchangedToken,
  fallbackSeconds = 60 * 60
): Date {
  const seconds =
    exchanged.expiresInSeconds && exchanged.expiresInSeconds > 0
      ? exchanged.expiresInSeconds
      : fallbackSeconds;
  return new Date(Date.now() + seconds * 1000);
}
