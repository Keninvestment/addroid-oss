// AdDroid OSS — LLM Provider abstraction (the current implementation).
//
// AI ワークフロー (daily_report / budget_guard / improvement_pr / 8 agents) が
// 単一の interface 越しに LLM を呼び出すための型定義を集約する。
//
// 設計原則:
//   - access token / api key の **平文は本 interface の外に漏らさない**。
//     呼び出し側 (worker / route handler) は `complete()` だけを使い、
//     認証 material は実装内部に閉じる。
//   - 呼び出し結果は ai_runs に永続化することを前提に、provider / model /
//     usage / cost / requestId をすべて返す。
//   - 将来の image 生成 / embedding 拡張のために `generateImage` / `embed` を
//     interface 上に宣言しておく。現状の実装では `LLMNotImplementedError` を
//     投げ、呼び出し側で「未対応」と判別できるようにする。
//   - エラーは sanitize 済みのメッセージのみを露出する。実装側は token を
//     ログ / Error.message / payload に **絶対に含めない**。

export type LLMProviderName = "codex" | "openai" | "anthropic" | "mock";

/** Provider 認証方式。`app_server` は provider 側が login/token を管理し、AdDroid には保存しない。 */
export type LLMAuthKind = "oauth" | "api_key" | "app_server" | "none";

export type LLMRole = "system" | "user" | "assistant";

export type LLMContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      dataBase64?: string;
      url?: string;
      localPath?: string;
      sourceRef?: string;
    };

export interface LLMMessage {
  role: LLMRole;
  content: string | LLMContentPart[];
}

export interface LLMCompletionRequest {
  /** Model identifier (e.g. "gpt-5.5", "claude-opus-4-7"). 既定は provider の defaultModel。 */
  model?: string;
  messages: LLMMessage[];
  /** 上限トークン数 (応答)。指定が無ければ provider 既定。 */
  maxOutputTokens?: number;
  /** 0.0–2.0。指定が無ければ provider 既定。 */
  temperature?: number;
  /**
   * AI 呼び出しの起点 (例: "agent:analyst", "workflow:daily_report")。
   * provider には送らず、ai_runs / 監査ログ用にメタとして残す。
   */
  purpose?: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponseMeta {
  provider: LLMProviderName;
  /** 実際に応答を返した model id (request.model または default)。 */
  model: string;
  /** Provider が返す request id (OpenAI 系の `x-request-id` 相当)。失敗時 null。 */
  requestId: string | null;
  /** Provider 接続時の表示用 identifier (例: ChatGPT account id)。機微ではない。 */
  accountIdentifier: string;
}

export interface LLMCompletionResult {
  /** Assistant の応答文字列 (single message を前提とする最小契約)。 */
  content: string;
  finishReason: "stop" | "length" | "content_filter" | "error" | "other";
  usage: LLMUsage;
  meta: LLMResponseMeta;
  /** 概算 USD コスト。詳細は pricing.ts。0 = 不明 (未登録 model)。 */
  costUsd: number;
}

// ---- 将来拡張: 画像生成 ---------------------------------------------------

export interface LLMImageRequest {
  model?: string;
  prompt: string;
  /** "1024x1024" / "512x512" 等。 */
  size?: string;
  /** purpose と同じ意味 (記録用)。 */
  purpose?: string;
}

export interface LLMImageResult {
  /** base64-encoded PNG/JPEG。Provider が URL を返す場合でも、本 interface では
   *  bytes に正規化することで「外部 URL を UI に露出しない」原則を守る。 */
  imageBase64: string;
  mimeType: "image/png" | "image/jpeg";
  meta: LLMResponseMeta;
  costUsd: number;
}

// ---- 将来拡張: Embedding --------------------------------------------------

export interface LLMEmbedRequest {
  model?: string;
  /** 1 件以上の入力テキスト。 */
  inputs: string[];
  purpose?: string;
}

export interface LLMEmbedResult {
  /** 入力と同じ並びで embedding ベクトルを返す。次元数は model 依存。 */
  vectors: number[][];
  meta: LLMResponseMeta;
  costUsd: number;
}

// ---- OAuth 接続メタ -------------------------------------------------------

export interface LLMConnectionMeta {
  provider: LLMProviderName;
  /** 表示用 identifier (例: OAuth account email / org slug)。機微ではない。 */
  accountIdentifier: string;
  scopes: string[];
  /** ISO 8601 string. */
  connectedAt: string;
  /** ISO 8601 string. null = 期限が分からない場合。 */
  expiresAt: string | null;
  /** Provider 既定 model (UI 表示と request.model 省略時のフォールバック)。 */
  defaultModel: string;
}

export interface LLMRefreshResult {
  provider: LLMProviderName;
  accountIdentifier: string;
  refreshedAt: string;
  expiresAt: string | null;
}

export interface LLMBeginOAuthResult {
  authorizationUrl: string;
  state: string;
  // PKCE の code_verifier は機微 (credential-bearing) のため、本 interface には
  // 含めない。Provider 実装が内部 (pending state ストア) で保持し、completeOAuth
  // で token exchange に再送する。UI / 呼び出し側には絶対に渡さない。
}

// ---- インタフェース -------------------------------------------------------

export interface LLMProvider {
  /** 静的メタ。UI / factory / audit log で利用。 */
  readonly name: LLMProviderName;
  readonly authKind: LLMAuthKind;
  readonly defaultModel: string;

  /** 認証フロー開始 (authKind="oauth" / "app_server" のみ)。それ以外は LLMNotImplementedError。 */
  beginOAuth(): Promise<LLMBeginOAuthResult>;

  /** OAuth callback 完了 (authKind="oauth" のみ)。app_server provider は token を永続化しない。 */
  completeOAuth(params: {
    code: string;
    state: string;
  }): Promise<LLMConnectionMeta>;

  /** Token 更新 (refresh_token 等)。Provider が未対応なら LLMNotImplementedError。 */
  refreshToken(): Promise<LLMRefreshResult>;

  /** 接続中の token を破棄する。記録があったかどうかを返す。 */
  disconnect(): Promise<boolean>;

  /** 既存の接続メタを返す (token 平文は含めない)。null = 未接続。 */
  getConnection(): Promise<LLMConnectionMeta | null>;

  /**
   * Chat completion を実行する。実装側は token を取り出して provider API を叩き、
   * provider/model/usage/cost をすべて填めた結果を返す。
   *
   * 失敗時は LLMProviderError 系を throw する。Error.message に token を含めない。
   */
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;

  /** 将来拡張: 画像生成。現状は LLMNotImplementedError を投げる実装が多い。 */
  generateImage(req: LLMImageRequest): Promise<LLMImageResult>;

  /** 将来拡張: Embedding。現状は LLMNotImplementedError を投げる実装が多い。 */
  embed(req: LLMEmbedRequest): Promise<LLMEmbedResult>;
}

// ---- エラー ---------------------------------------------------------------

export class LLMProviderNotConfiguredError extends Error {
  readonly providerName: LLMProviderName | "unknown";
  constructor(providerName: LLMProviderName | "unknown", method: string) {
    super(
      `LLM provider '${providerName}' is not configured. Configure it from /ai (or set ADDROID_LLM_MOCK=1 for the mock provider). [${method}]`
    );
    this.name = "LLMProviderNotConfiguredError";
    this.providerName = providerName;
  }
}

export class LLMProviderUnauthenticatedError extends Error {
  readonly providerName: LLMProviderName;
  constructor(providerName: LLMProviderName, operation: string) {
    super(
      `LLM provider '${providerName}' cannot ${operation}: no token stored. Connect the provider from /ai first.`
    );
    this.name = "LLMProviderUnauthenticatedError";
    this.providerName = providerName;
  }
}

export class LLMTokenExpiredError extends Error {
  readonly providerName: LLMProviderName;
  readonly expiresAt: Date | null;
  constructor(providerName: LLMProviderName, expiresAt: Date | null) {
    super(
      `LLM provider '${providerName}' token is expired. Re-authenticate from /ai.`
    );
    this.name = "LLMTokenExpiredError";
    this.providerName = providerName;
    this.expiresAt = expiresAt;
  }
}

export class LLMOAuthStateMismatchError extends Error {
  constructor() {
    super(
      "LLM OAuth state did not match the value issued by beginOAuth (possible CSRF)."
    );
    this.name = "LLMOAuthStateMismatchError";
  }
}

export class LLMNotImplementedError extends Error {
  readonly providerName: LLMProviderName;
  readonly capability: string;
  constructor(providerName: LLMProviderName, capability: string) {
    super(
      `LLM provider '${providerName}' does not implement '${capability}'.`
    );
    this.name = "LLMNotImplementedError";
    this.providerName = providerName;
    this.capability = capability;
  }
}

/**
 * Provider への外向き呼び出し全般のエラー。HTTP status / sanitize 済み payload を保持する。
 * `message` には絶対に access_token を含めないこと (実装側は本クラスの constructor を
 * 経由せず raw response を露出してはならない)。
 */
export class LLMProviderError extends Error {
  readonly providerName: LLMProviderName;
  readonly status?: number;
  /** Provider が返した error code 文字列 (例: "rate_limit_exceeded")。 */
  readonly code?: string;
  /** sanitize 済み body の抜粋。stringify 時に 1KB 程度を上限とする。 */
  readonly payload?: unknown;
  constructor(
    providerName: LLMProviderName,
    message: string,
    opts?: { status?: number; code?: string; payload?: unknown }
  ) {
    super(`[${providerName}] ${message}`);
    this.name = "LLMProviderError";
    this.providerName = providerName;
    this.status = opts?.status;
    this.code = opts?.code;
    this.payload = opts?.payload;
  }
}
