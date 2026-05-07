// AdDroid OSS — LLM Provider factory.
//
// 実行環境に応じて LLMProvider 実装を選択する。優先度:
//   1. ADDROID_LLM_MOCK=1                    → MockLLMProvider
//   2. OpenAI / Anthropic API key credential → ApiKeyLLMProvider
//   3. Codex app-server route                → CodexAppServerLLMProvider
//   4. それ以外                                → StubLLMProvider

import {
  CodexAppServerLLMProvider,
  type CodexAppServerLLMProviderOptions,
} from "./codex-app-server.js";
import {
  ApiKeyLLMProvider,
  type ApiKeyLLMProviderName,
  type ApiKeyCryptoBoundary,
} from "./api-key.js";
import { MockLLMProvider, type MockLLMProviderOptions } from "./mock.js";
import { StubLLMProvider } from "./stub.js";
import type { LLMProviderTokenStore } from "./token-store.js";
import type { LLMProvider, LLMProviderName } from "./types.js";

export interface SelectLLMProviderOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore: LLMProviderTokenStore;
  crypto?: ApiKeyCryptoBoundary;
  /** API key provider の既定 model。Codex app-server は local 設定を使う。 */
  defaultModel?: string;
  codexAppServer?: CodexAppServerLLMProviderOptions;
  /** API key provider を明示採用する場合。 */
  apiKeyProvider?: ApiKeyLLMProviderName | null;
  apiKeyChatCompletionsUrl?: string | null;
  mock?: Omit<MockLLMProviderOptions, "tokenStore">;
  fetchImpl?: typeof fetch;
  /** stub に渡す provider 名 (UI に「未設定」と表示する対象)。既定 "codex". */
  stubProvider?: LLMProviderName;
}

export type LLMProviderChoice = "mock" | "codex" | "openai_api_key" | "anthropic_api_key" | "stub";

export interface LLMProviderSelection {
  provider: LLMProvider;
  choice: LLMProviderChoice;
  reason: string;
}

export function selectLLMProvider(
  opts: SelectLLMProviderOptions
): LLMProviderSelection {
  const env = opts.env ?? process.env;
  if (env.ADDROID_LLM_MOCK === "1") {
    return {
      provider: new MockLLMProvider({
        tokenStore: opts.tokenStore,
        ...(opts.mock ?? {}),
      }),
      choice: "mock",
      reason: "ADDROID_LLM_MOCK=1",
    };
  }
  if (
    opts.apiKeyProvider &&
    opts.crypto &&
    opts.defaultModel
  ) {
    return {
      provider: new ApiKeyLLMProvider({
        provider: opts.apiKeyProvider,
        tokenStore: opts.tokenStore,
        crypto: opts.crypto,
        defaultModel: opts.defaultModel,
        chatCompletionsUrl: opts.apiKeyChatCompletionsUrl,
      }),
      choice: opts.apiKeyProvider === "anthropic" ? "anthropic_api_key" : "openai_api_key",
      reason: `${opts.apiKeyProvider} API key credential + crypto boundary configured`,
    };
  }
  if (opts.stubProvider !== "openai" && opts.stubProvider !== "anthropic") {
    return {
      provider: new CodexAppServerLLMProvider({
        ...(opts.codexAppServer ?? {}),
      }),
      choice: "codex",
      reason: "Codex app-server route configured",
    };
  }
  return {
    provider: new StubLLMProvider(opts.stubProvider ?? "codex", opts.defaultModel ?? "gpt-5.5"),
    choice: "stub",
    reason: missingReason(opts),
  };
}

function missingReason(opts: SelectLLMProviderOptions): string {
  const missing: string[] = [];
  if (!opts.crypto) missing.push("crypto");
  if (!opts.defaultModel) missing.push("defaultModel");
  return `LLM provider not configured (missing: ${missing.join(", ") || "n/a"})`;
}
