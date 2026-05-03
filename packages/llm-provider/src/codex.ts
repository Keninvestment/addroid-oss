// AdDroid OSS — CodexLLMProvider (OAuth-backed, OpenAI 互換 chat completion).
//
// Codex CLI / OpenAI 互換 OAuth 経由で認証した access token を使い、
// chat completion を行う本実装。設計方針:
//   - access_token / refresh_token は LLMProviderTokenStore から ciphertext を
//     取り出し、`CryptoEncryptDecrypt` で都度復号する。プロセスメモリには
//     メソッド呼び出しのスコープでのみ存在させる。
//   - access_token は Authorization: Bearer ヘッダ経由でのみ送信し、URL クエリには
//     **絶対に置かない**。Error.message / payload にも含めない。
//   - 期限切れ時は refresh_token を使って自動再交換し、新しい
//     access_token / refresh_token を ciphertext で保存する。
//   - completion 結果には provider/model/usage/cost を必ず填める。

import {
  buildCodexAuthorizationUrl,
  deriveCodexExpiresAt,
  exchangeCodexCodeForToken,
  redactPayloadForError,
  refreshCodexAccessToken,
  type CodexOAuthClientConfig,
} from "./oauth.js";
import { estimateCostUsd } from "./pricing.js";
import type {
  LLMProviderTokenRecord,
  LLMProviderTokenStore,
} from "./token-store.js";
import {
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
  LLMTokenExpiredError,
  type LLMAuthKind,
  type LLMBeginOAuthResult,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMConnectionMeta,
  type LLMEmbedRequest,
  type LLMEmbedResult,
  type LLMImageRequest,
  type LLMImageResult,
  type LLMProvider,
  type LLMProviderName,
  type LLMRefreshResult,
} from "./types.js";

/**
 * `@addroid/config` の `CryptoBoundary` と structurally 互換。
 * llm-provider から config への依存を増やさないため、呼び出し側が値を渡す。
 */
export interface CryptoEncryptDecrypt {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface CodexLLMProviderDeps {
  oauthClient: CodexOAuthClientConfig;
  tokenStore: LLMProviderTokenStore;
  crypto: CryptoEncryptDecrypt;
  /** Chat completions を叩く endpoint。例: "https://api.openai.com/v1/chat/completions"。 */
  chatCompletionsUrl: string;
  /**
   * Provider 既定 model。OAuth 完了時に保存し、UI / request.model 省略時の
   * フォールバックに使う。
   */
  defaultModel: string;
  /** test seam: 既定は global fetch。 */
  fetchImpl?: typeof fetch;
  /** 期限切れ閾値 (ms 単位の grace)。既定 30s — clock skew への余裕。 */
  expiryGraceMs?: number;
}

const DEFAULT_EXPIRY_GRACE_MS = 30_000;

export class CodexLLMProvider implements LLMProvider {
  readonly name: LLMProviderName = "codex";
  readonly authKind: LLMAuthKind = "oauth";
  readonly defaultModel: string;

  private readonly client: CodexOAuthClientConfig;
  private readonly tokenStore: LLMProviderTokenStore;
  private readonly crypto: CryptoEncryptDecrypt;
  private readonly chatCompletionsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly expiryGraceMs: number;

  /** 直近の beginOAuth で発行した state + verifier。callback で照合する。 */
  private pending: { state: string; codeVerifier?: string } | null = null;

  constructor(deps: CodexLLMProviderDeps) {
    this.client = deps.oauthClient;
    this.tokenStore = deps.tokenStore;
    this.crypto = deps.crypto;
    this.chatCompletionsUrl = deps.chatCompletionsUrl;
    this.defaultModel = deps.defaultModel;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.expiryGraceMs = deps.expiryGraceMs ?? DEFAULT_EXPIRY_GRACE_MS;
  }

  async beginOAuth(): Promise<LLMBeginOAuthResult> {
    const built = buildCodexAuthorizationUrl({ client: this.client });
    this.pending = { state: built.state };
    if (built.codeVerifier) this.pending.codeVerifier = built.codeVerifier;
    return {
      authorizationUrl: built.authorizationUrl,
      state: built.state,
    };
  }

  async completeOAuth(params: {
    code: string;
    state: string;
  }): Promise<LLMConnectionMeta> {
    // Fail closed: persisted pending state must exist AND match.
    if (!this.pending || this.pending.state !== params.state) {
      this.pending = null;
      throw new LLMOAuthStateMismatchError();
    }
    const verifier = this.pending.codeVerifier;
    this.pending = null;

    const exchangeOpts: {
      client: CodexOAuthClientConfig;
      code: string;
      fetchImpl: typeof fetch;
      codeVerifier?: string;
    } = {
      client: this.client,
      code: params.code,
      fetchImpl: this.fetchImpl,
    };
    if (verifier) exchangeOpts.codeVerifier = verifier;
    const exchanged = await exchangeCodexCodeForToken(exchangeOpts);

    const expiresAt = deriveCodexExpiresAt(exchanged);
    const connectedAt = new Date();
    const accountIdentifier = this.deriveAccountIdentifier(exchanged.idToken);
    const scopes =
      exchanged.grantedScopes.length > 0
        ? exchanged.grantedScopes
        : (this.client.scopes ? Array.from(this.client.scopes) : []);

    const record: LLMProviderTokenRecord = {
      provider: "codex",
      accountIdentifier,
      scopes,
      accessTokenCiphertext: this.crypto.encrypt(exchanged.accessToken),
      refreshTokenCiphertext: exchanged.refreshToken
        ? this.crypto.encrypt(exchanged.refreshToken)
        : null,
      expiresAt,
      connectedAt,
      defaultModel: this.defaultModel,
    };
    await this.tokenStore.saveOAuthToken(record);

    return {
      provider: "codex",
      accountIdentifier,
      scopes,
      connectedAt: connectedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      defaultModel: this.defaultModel,
    };
  }

  async refreshToken(): Promise<LLMRefreshResult> {
    const existing = await this.tokenStore.loadOAuthToken("codex");
    if (!existing) throw new LLMProviderUnauthenticatedError("codex", "refresh token");
    if (!existing.refreshTokenCiphertext) {
      throw new LLMProviderError(
        "codex",
        "no refresh_token stored; re-authenticate from /ai"
      );
    }
    const refreshTokenPlain = this.crypto.decrypt(existing.refreshTokenCiphertext);
    const exchanged = await refreshCodexAccessToken({
      client: this.client,
      refreshToken: refreshTokenPlain,
      fetchImpl: this.fetchImpl,
    });
    const expiresAt = deriveCodexExpiresAt(exchanged);
    const refreshedAt = new Date();
    const next: LLMProviderTokenRecord = {
      ...existing,
      accessTokenCiphertext: this.crypto.encrypt(exchanged.accessToken),
      refreshTokenCiphertext: exchanged.refreshToken
        ? this.crypto.encrypt(exchanged.refreshToken)
        : existing.refreshTokenCiphertext,
      expiresAt,
    };
    await this.tokenStore.saveOAuthToken(next);
    return {
      provider: "codex",
      accountIdentifier: existing.accountIdentifier,
      refreshedAt: refreshedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async disconnect(): Promise<boolean> {
    this.pending = null;
    return this.tokenStore.deleteOAuthToken("codex");
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    const rec = await this.tokenStore.loadOAuthToken("codex");
    if (!rec) return null;
    return {
      provider: "codex",
      accountIdentifier: rec.accountIdentifier,
      scopes: rec.scopes,
      connectedAt: rec.connectedAt.toISOString(),
      expiresAt: rec.expiresAt ? rec.expiresAt.toISOString() : null,
      defaultModel: rec.defaultModel,
    };
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new LLMProviderError("codex", "complete: messages must be a non-empty array");
    }
    const { plaintext, record } = await this.requireUsableAccessToken();
    const model = req.model ?? record.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (typeof req.maxOutputTokens === "number") body.max_tokens = req.maxOutputTokens;
    if (typeof req.temperature === "number") body.temperature = req.temperature;

    let res: Response;
    try {
      res = await this.fetchImpl(this.chatCompletionsUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${plaintext}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LLMProviderError(
        "codex",
        `failed to reach chat completions endpoint: ${(err as Error).message}`
      );
    }
    const requestId = res.headers.get("x-request-id");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMProviderError(
        "codex",
        `chat completions endpoint returned HTTP ${res.status}`,
        { status: res.status, payload: redactPayloadForError(text) }
      );
    }
    const json = (await res.json().catch(() => null)) as
      | {
          choices?: Array<{
            message?: { role?: string; content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
          error?: { message?: string; code?: string };
        }
      | null;
    if (!json || typeof json !== "object") {
      throw new LLMProviderError("codex", "chat completions endpoint returned a non-JSON body");
    }
    if (json.error) {
      // provider が誤って access_token / authorization header / OAuth credential を
      // error.message や error.code に echo back する事故への二重防御。oauth.ts の
      // token endpoint エラー処理と同じく、Error.message へ補間する前と opts に詰める
      // 前の双方で sanitize する。
      const safeMessage =
        typeof json.error.message === "string" && json.error.message.length > 0
          ? redactPayloadForError(json.error.message)
          : "unknown";
      const opts: { code?: string } = {};
      if (typeof json.error.code === "string" && json.error.code.length > 0) {
        opts.code = redactPayloadForError(json.error.code);
      }
      throw new LLMProviderError(
        "codex",
        `chat completions error: ${safeMessage}`,
        opts
      );
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    const content = choice?.message?.content ?? "";
    const finishReason = mapFinishReason(choice?.finish_reason);
    const usage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
    const responseModel = json.model ?? model;
    return {
      content,
      finishReason,
      usage,
      meta: {
        provider: "codex",
        model: responseModel,
        requestId: requestId ?? null,
        accountIdentifier: record.accountIdentifier,
      },
      costUsd: estimateCostUsd("codex", responseModel, usage),
    };
  }

  async generateImage(_req: LLMImageRequest): Promise<LLMImageResult> {
    throw new LLMNotImplementedError("codex", "generateImage");
  }

  async embed(_req: LLMEmbedRequest): Promise<LLMEmbedResult> {
    throw new LLMNotImplementedError("codex", "embed");
  }

  // -------- internals --------

  private deriveAccountIdentifier(idToken?: string): string {
    if (!idToken) return "codex-user";
    // id_token は base64url(JSON).base64url(JSON).signature 形式の JWT。
    // 署名検証は本タスクのスコープ外 (OAuth provider が TLS 経由で発行済み)。
    // payload 部分から sub / email を取り出すだけに留める。失敗したら fallback。
    try {
      const parts = idToken.split(".");
      if (parts.length < 2) return "codex-user";
      const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
      const payload = JSON.parse(payloadJson) as { sub?: string; email?: string };
      return payload.email || payload.sub || "codex-user";
    } catch {
      return "codex-user";
    }
  }

  /**
   * 接続済み token を取得する。期限切れ (grace 込み) で refresh_token がある
   * 場合は自動で再交換し、新しい token を保存する。
   */
  private async requireUsableAccessToken(): Promise<{
    plaintext: string;
    record: LLMProviderTokenRecord;
  }> {
    let rec = await this.tokenStore.loadOAuthToken("codex");
    if (!rec) throw new LLMProviderUnauthenticatedError("codex", "complete a request");

    const isExpired =
      !!rec.expiresAt && rec.expiresAt.getTime() - this.expiryGraceMs < Date.now();
    if (isExpired) {
      if (!rec.refreshTokenCiphertext) {
        throw new LLMTokenExpiredError("codex", rec.expiresAt ?? null);
      }
      // 自動 refresh。失敗したら呼び出し側に LLMTokenExpiredError を返して再認証を促す。
      try {
        await this.refreshToken();
      } catch (err) {
        if (err instanceof LLMProviderError || err instanceof LLMTokenExpiredError) {
          throw new LLMTokenExpiredError("codex", rec.expiresAt ?? null);
        }
        throw err;
      }
      rec = await this.tokenStore.loadOAuthToken("codex");
      if (!rec) throw new LLMProviderUnauthenticatedError("codex", "complete a request");
    }
    const plaintext = this.crypto.decrypt(rec.accessTokenCiphertext);
    return { plaintext, record: rec };
  }
}

function mapFinishReason(raw: string | undefined): LLMCompletionResult["finishReason"] {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "other";
  }
}
