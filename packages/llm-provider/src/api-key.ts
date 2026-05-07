// AdDroid OSS — API-key backed LLM providers.
//
// OpenAI / Anthropic の API key 認証を、OAuth provider と同じ
// LLMProviderTokenStore + CryptoBoundary 境界に閉じ込める。API key の平文は
// complete() のスコープ内だけで復号し、URL / Error.message / ai_runs には出さない。

import { estimateCostUsd } from "./pricing.js";
import { redactPayloadForError } from "./redact.js";
import type {
  LLMProviderTokenRecord,
  LLMProviderTokenStore,
} from "./token-store.js";
import {
  LLMNotImplementedError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
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

export interface ApiKeyCryptoBoundary {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export type ApiKeyLLMProviderName = Extract<LLMProviderName, "openai" | "anthropic">;

export interface ApiKeyLLMProviderDeps {
  provider: ApiKeyLLMProviderName;
  tokenStore: LLMProviderTokenStore;
  crypto: ApiKeyCryptoBoundary;
  defaultModel: string;
  chatCompletionsUrl?: string | null;
  fetchImpl?: typeof fetch;
}

const DEFAULT_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class ApiKeyLLMProvider implements LLMProvider {
  readonly name: ApiKeyLLMProviderName;
  readonly authKind: LLMAuthKind = "api_key";
  readonly defaultModel: string;

  private readonly tokenStore: LLMProviderTokenStore;
  private readonly crypto: ApiKeyCryptoBoundary;
  private readonly chatCompletionsUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: ApiKeyLLMProviderDeps) {
    this.name = deps.provider;
    this.tokenStore = deps.tokenStore;
    this.crypto = deps.crypto;
    this.defaultModel = deps.defaultModel;
    this.chatCompletionsUrl =
      deps.chatCompletionsUrl?.trim() ||
      (deps.provider === "anthropic"
        ? DEFAULT_ANTHROPIC_MESSAGES_URL
        : DEFAULT_OPENAI_CHAT_URL);
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async beginOAuth(): Promise<LLMBeginOAuthResult> {
    throw new LLMNotImplementedError(this.name, "beginOAuth");
  }

  async completeOAuth(): Promise<LLMConnectionMeta> {
    throw new LLMNotImplementedError(this.name, "completeOAuth");
  }

  async refreshToken(): Promise<LLMRefreshResult> {
    throw new LLMNotImplementedError(this.name, "refreshToken");
  }

  async disconnect(): Promise<boolean> {
    return this.tokenStore.deleteOAuthToken(this.name);
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    const rec = await this.tokenStore.loadOAuthToken(this.name);
    if (!rec) return null;
    return {
      provider: this.name,
      accountIdentifier: rec.accountIdentifier,
      scopes: rec.scopes,
      connectedAt: rec.connectedAt.toISOString(),
      expiresAt: rec.expiresAt ? rec.expiresAt.toISOString() : null,
      defaultModel: rec.defaultModel,
    };
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new LLMProviderError(this.name, "complete: messages must be a non-empty array");
    }
    const record = await this.tokenStore.loadOAuthToken(this.name);
    if (!record) throw new LLMProviderUnauthenticatedError(this.name, "complete a request");
    const apiKey = this.crypto.decrypt(record.accessTokenCiphertext);
    if (this.name === "anthropic") {
      return this.completeAnthropic(req, record, apiKey);
    }
    return this.completeOpenAICompatible(req, record, apiKey);
  }

  async generateImage(_req: LLMImageRequest): Promise<LLMImageResult> {
    throw new LLMNotImplementedError(this.name, "generateImage");
  }

  async embed(_req: LLMEmbedRequest): Promise<LLMEmbedResult> {
    throw new LLMNotImplementedError(this.name, "embed");
  }

  private async completeOpenAICompatible(
    req: LLMCompletionRequest,
    record: LLMProviderTokenRecord,
    apiKey: string
  ): Promise<LLMCompletionResult> {
    const model = req.model ?? record.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (typeof req.maxOutputTokens === "number") body.max_tokens = req.maxOutputTokens;
    if (typeof req.temperature === "number") body.temperature = req.temperature;

    const res = await this.postJson(apiKey, body, {
      Authorization: `Bearer ${apiKey}`,
    });
    const requestId = res.headers.get("x-request-id");
    const json = (await res.json().catch(() => null)) as
      | {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
          error?: { message?: string; code?: string };
        }
      | null;
    if (!json || typeof json !== "object") {
      throw new LLMProviderError(this.name, "chat completions endpoint returned a non-JSON body");
    }
    if (json.error) {
      throw new LLMProviderError(
        this.name,
        `chat completions error: ${redactPayloadForError(json.error.message ?? "unknown")}`,
        json.error.code ? { code: redactPayloadForError(json.error.code) } : undefined
      );
    }
    const usage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
    const responseModel = json.model ?? model;
    return {
      content: json.choices?.[0]?.message?.content ?? "",
      finishReason: mapFinishReason(json.choices?.[0]?.finish_reason),
      usage,
      meta: {
        provider: this.name,
        model: responseModel,
        requestId: requestId ?? null,
        accountIdentifier: record.accountIdentifier,
      },
      costUsd: estimateCostUsd(this.name, responseModel, usage),
    };
  }

  private async completeAnthropic(
    req: LLMCompletionRequest,
    record: LLMProviderTokenRecord,
    apiKey: string
  ): Promise<LLMCompletionResult> {
    const model = req.model ?? record.defaultModel;
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxOutputTokens ?? 1024,
      messages,
    };
    if (system) body.system = system;
    if (typeof req.temperature === "number") body.temperature = req.temperature;

    const res = await this.postJson(apiKey, body, {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    });
    const requestId = res.headers.get("request-id") ?? res.headers.get("x-request-id");
    const json = (await res.json().catch(() => null)) as
      | {
          content?: Array<{ type?: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
          model?: string;
          stop_reason?: string;
          error?: { message?: string; type?: string };
        }
      | null;
    if (!json || typeof json !== "object") {
      throw new LLMProviderError(this.name, "messages endpoint returned a non-JSON body");
    }
    if (json.error) {
      throw new LLMProviderError(
        this.name,
        `messages error: ${redactPayloadForError(json.error.message ?? "unknown")}`,
        json.error.type ? { code: redactPayloadForError(json.error.type) } : undefined
      );
    }
    const usage = {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
    const responseModel = json.model ?? model;
    const content = (json.content ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    return {
      content,
      finishReason: mapFinishReason(json.stop_reason),
      usage,
      meta: {
        provider: this.name,
        model: responseModel,
        requestId: requestId ?? null,
        accountIdentifier: record.accountIdentifier,
      },
      costUsd: estimateCostUsd(this.name, responseModel, usage),
    };
  }

  private async postJson(
    apiKey: string,
    body: Record<string, unknown>,
    authHeaders: Record<string, string>
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.chatCompletionsUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LLMProviderError(
        this.name,
        `failed to reach LLM endpoint: ${redactPayloadForError((err as Error).message)}`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const safePayload = redactPayloadForError(text).replaceAll(apiKey, "[REDACTED]");
      const providerError = parseProviderErrorPayload(safePayload);
      if (providerError) {
        const opts: { status: number; payload: unknown; code?: string } = {
          status: res.status,
          payload: safePayload,
        };
        if (providerError.code) opts.code = providerError.code;
        throw new LLMProviderError(
          this.name,
          `chat completions error: ${providerError.message}`,
          opts
        );
      }
      throw new LLMProviderError(
        this.name,
        `LLM endpoint returned HTTP ${res.status}`,
        { status: res.status, payload: safePayload }
      );
    }
    return res;
  }
}

function mapFinishReason(raw: string | undefined): LLMCompletionResult["finishReason"] {
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "other";
  }
}

function parseProviderErrorPayload(text: string): { message: string; code?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.error)) return null;
  const rawMessage = parsed.error.message;
  const message =
    typeof rawMessage === "string" && rawMessage.trim()
      ? redactPayloadForError(rawMessage.trim())
      : "unknown";
  const rawCode = parsed.error.code;
  const code =
    typeof rawCode === "string" && rawCode.trim()
      ? redactPayloadForError(rawCode.trim())
      : undefined;
  return code ? { message, code } : { message };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultApiKeyChatUrl(provider: ApiKeyLLMProviderName): string {
  return provider === "anthropic"
    ? DEFAULT_ANTHROPIC_MESSAGES_URL
    : DEFAULT_OPENAI_CHAT_URL;
}
