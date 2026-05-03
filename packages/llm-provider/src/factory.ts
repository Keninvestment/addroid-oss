// AdDroid OSS — LLM Provider factory.
//
// 実行環境に応じて LLMProvider 実装を選択する。優先度:
//   1. ADDROID_LLM_MOCK=1                    → MockLLMProvider
//   2. Codex OAuth client + crypto + tokenStore が揃う → CodexLLMProvider
//   3. それ以外                                → StubLLMProvider
//
// Codex OAuth client / chat completions URL は本関数の引数 / 環境変数からのみ
// 流入し、コード内に literal を残さない。

import {
  CodexLLMProvider,
  type CodexLLMProviderDeps,
  type CryptoEncryptDecrypt,
} from "./codex.js";
import { MockLLMProvider, type MockLLMProviderOptions } from "./mock.js";
import { StubLLMProvider } from "./stub.js";
import type { CodexOAuthClientConfig } from "./oauth.js";
import type { LLMProviderTokenStore } from "./token-store.js";
import type { LLMProvider, LLMProviderName } from "./types.js";

export interface SelectLLMProviderOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore: LLMProviderTokenStore;
  crypto?: CryptoEncryptDecrypt;
  codexClient?: CodexOAuthClientConfig | null;
  /** Codex chat completions endpoint (e.g., "https://api.openai.com/v1/chat/completions"). */
  chatCompletionsUrl?: string | null;
  /** Codex 既定 model。 */
  defaultModel?: string;
  mock?: Omit<MockLLMProviderOptions, "tokenStore">;
  fetchImpl?: typeof fetch;
  /** stub に渡す provider 名 (UI に「未設定」と表示する対象)。既定 "codex". */
  stubProvider?: LLMProviderName;
}

export type LLMProviderChoice = "mock" | "codex" | "stub";

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
    opts.codexClient &&
    opts.crypto &&
    opts.chatCompletionsUrl &&
    opts.defaultModel
  ) {
    const deps: CodexLLMProviderDeps = {
      oauthClient: opts.codexClient,
      tokenStore: opts.tokenStore,
      crypto: opts.crypto,
      chatCompletionsUrl: opts.chatCompletionsUrl,
      defaultModel: opts.defaultModel,
    };
    if (opts.fetchImpl) deps.fetchImpl = opts.fetchImpl;
    return {
      provider: new CodexLLMProvider(deps),
      choice: "codex",
      reason: "Codex OAuth client + crypto boundary + chatCompletionsUrl configured",
    };
  }
  return {
    provider: new StubLLMProvider(opts.stubProvider ?? "codex", opts.defaultModel ?? "gpt-4.1"),
    choice: "stub",
    reason: missingReason(opts),
  };
}

function missingReason(opts: SelectLLMProviderOptions): string {
  const missing: string[] = [];
  if (!opts.codexClient) missing.push("codexClient");
  if (!opts.crypto) missing.push("crypto");
  if (!opts.chatCompletionsUrl) missing.push("chatCompletionsUrl");
  if (!opts.defaultModel) missing.push("defaultModel");
  return `Codex OAuth not configured (missing: ${missing.join(", ") || "n/a"})`;
}
