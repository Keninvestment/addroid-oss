// AdDroid OSS — ImageProvider factory (the current implementation).
//
// 実行環境に応じて ImageProvider 実装を選択する。優先度:
//   1. ENABLE_MOCK_IMAGE_PROVIDER=1 (or ADDROID_IMAGE_MOCK=1) → MockImageProvider
//   2. ADDROID_IMAGE_PROVIDER=codex / preferCodex=true        → Codex app-server
//   3. encrypted OpenAI API key + crypto boundary             → OpenAI GPT Image
//   4. それ以外                                                → StubImageProvider
//
// Credential boundary (the current implementation constraint: "Provider credentials must use
// existing encrypted config/secrets patterns"):
//   - 本 factory は **どんな plaintext API key も env から読まない**。`IMAGE_*_API_KEY`
//     系の値を直接インスペクトすることは the current implementation 原則 29 (UI に paste しない)
//     と同じ理由で禁止する: 平文資格情報が select() の判定経路に紛れ込むと、
//     ログ / reason 文字列 / Error.message に漏出する経路を生むため。
//   - 実 adapter (openai / stability / replicate) を追加するときは、
//     `factory.ts` (LLMProvider) と同じ形式で `crypto: CryptoEncryptDecrypt` +
//     ciphertext-backed token store を呼び出し側から注入する。資格情報は
//     `oauth_tokens.accessTokenCiphertext` 由来のみで、`@addroid/config` の
//     `getCryptoBoundary()` を通って復号する。
//   - factory が stub を返すこと自体は失敗ではない (画像生成は任意)。reason 文字列
//     を UI / health check に提示することで、operator が必要なら接続できる。

import {
  MockImageProvider,
  type MockImageProviderOptions,
} from "./image-mock.js";
import {
  CodexAppServerImageProvider,
  type CodexAppServerImageProviderOptions,
} from "./image-codex.js";
import {
  OpenAIImageProvider,
  type OpenAIImageProviderOptions,
} from "./image-openai.js";
import { StubImageProvider } from "./image-stub.js";
import type { ImageProvider, ImageProviderName } from "./image-provider.js";
import type { ApiKeyCryptoBoundary } from "./api-key.js";
import type { LLMProviderTokenStore } from "./token-store.js";

export type ImageProviderChoice = "mock" | "codex" | "openai_api_key" | "stub";

export interface ImageProviderSelection {
  provider: ImageProvider;
  choice: ImageProviderChoice;
  /** Stub が選ばれた理由 / Mock を選んだ env 変数名など。UI 表示用。 */
  reason: string;
  /**
   * UI / `/api/health` で "未設定 (任意)" を出すかどうか。stub は true。
   * `enabled=false` と等価だが、選択側で明示的に readable にしておく。
   */
  optional: boolean;
}

export interface SelectImageProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Mock provider の上書き設定 (test seam)。 */
  mock?: MockImageProviderOptions;
  /** OpenAI API key / OAuth token store。実 provider 選択時のみ使う。 */
  tokenStore?: LLMProviderTokenStore;
  /** `oauth_tokens.accessTokenCiphertext` を復号する境界。 */
  crypto?: ApiKeyCryptoBoundary;
  /** 保存済み OpenAI key があることを呼び出し側が確認済みなら true。 */
  openaiCredentialAvailable?: boolean;
  /** Codex OAuth / local mode などから Codex app-server を優先する場合 true。 */
  preferCodex?: boolean;
  openai?: Partial<Omit<OpenAIImageProviderOptions, "tokenStore" | "crypto">>;
  codex?: CodexAppServerImageProviderOptions;
  /** Stub に表示させる provider 名。既定 "openai"。 */
  stubProvider?: ImageProviderName;
  /** Stub に表示させる model 名。既定 "gpt-image-2"。 */
  stubDefaultModel?: string;
}

export function selectImageProvider(
  opts: SelectImageProviderOptions = {}
): ImageProviderSelection {
  const env = opts.env ?? process.env;
  const explicit = normalizeImageProvider(env.ADDROID_IMAGE_PROVIDER);
  if (env.ENABLE_MOCK_IMAGE_PROVIDER === "1" || env.ADDROID_IMAGE_MOCK === "1" || explicit === "mock") {
    return {
      provider: new MockImageProvider(opts.mock ?? {}),
      choice: "mock",
      reason: explicit === "mock" ? "ADDROID_IMAGE_PROVIDER=mock" : "ENABLE_MOCK_IMAGE_PROVIDER=1 (or ADDROID_IMAGE_MOCK=1)",
      optional: false,
    };
  }
  if (explicit === "openai" || opts.openaiCredentialAvailable) {
    if (opts.tokenStore && opts.crypto && opts.openaiCredentialAvailable !== false) {
      return {
        provider: new OpenAIImageProvider({
          tokenStore: opts.tokenStore,
          crypto: opts.crypto,
          ...(opts.openai ?? {}),
        }),
        choice: "openai_api_key",
        reason: explicit === "openai"
          ? "ADDROID_IMAGE_PROVIDER=openai + encrypted OpenAI API key credential"
          : "encrypted OpenAI API key credential found; using GPT Image provider",
        optional: false,
      };
    }
    return {
      provider: new StubImageProvider({
        name: "openai",
        defaultModel: opts.stubDefaultModel ?? "gpt-image-2",
      }),
      choice: "stub",
      reason: "OpenAI image provider requested but encrypted token store / crypto boundary is not configured",
      optional: true,
    };
  }
  if (explicit === "codex" || opts.preferCodex) {
    return {
      provider: new CodexAppServerImageProvider(opts.codex ?? {}),
      choice: "codex",
      reason: explicit === "codex" ? "ADDROID_IMAGE_PROVIDER=codex" : "Codex LLM/OAuth selected; using Codex app-server image provider",
      optional: false,
    };
  }
  return {
    provider: new StubImageProvider({
      ...(opts.stubProvider ? { name: opts.stubProvider } : {}),
      defaultModel: opts.stubDefaultModel ?? "gpt-image-2",
    }),
    choice: "stub",
    reason:
      "no image provider configured (optional) — image generation falls back to prompt-only. Set ADDROID_IMAGE_MOCK=1 for the mock adapter, ADDROID_IMAGE_PROVIDER=codex for Codex app-server, or register an OpenAI API key with `addroid auth llm --provider openai`.",
    optional: true,
  };
}

function normalizeImageProvider(value: string | undefined): "openai" | "codex" | "mock" | null {
  const v = value?.trim().toLowerCase();
  if (v === "openai" || v === "codex" || v === "mock") return v;
  return null;
}
