// AdDroid OSS — ImageProvider factory (the current implementation).
//
// 実行環境に応じて ImageProvider 実装を選択する。優先度:
//   1. ENABLE_MOCK_IMAGE_PROVIDER=1 (or ADDROID_IMAGE_MOCK=1) → MockImageProvider
//   2. それ以外                                                → StubImageProvider
//
// openai / stability / replicate の実 adapter は本タスク (implementation item) のスコープ外
// であり、本 factory はそれらを「未実装」として stub に縮退させる。後続タスク
// で adapter を追加した際にここに分岐を増やす。
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
import { StubImageProvider } from "./image-stub.js";
import type { ImageProvider, ImageProviderName } from "./image-provider.js";

export type ImageProviderChoice = "mock" | "stub";

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
  /** Stub に表示させる provider 名。既定 "openai"。 */
  stubProvider?: ImageProviderName;
  /** Stub に表示させる model 名。既定 "gpt-image-1"。 */
  stubDefaultModel?: string;
}

export function selectImageProvider(
  opts: SelectImageProviderOptions = {}
): ImageProviderSelection {
  const env = opts.env ?? process.env;
  if (env.ENABLE_MOCK_IMAGE_PROVIDER === "1" || env.ADDROID_IMAGE_MOCK === "1") {
    return {
      provider: new MockImageProvider(opts.mock ?? {}),
      choice: "mock",
      reason: "ENABLE_MOCK_IMAGE_PROVIDER=1 (or ADDROID_IMAGE_MOCK=1)",
      optional: false,
    };
  }
  return {
    provider: new StubImageProvider({
      ...(opts.stubProvider ? { name: opts.stubProvider } : {}),
      ...(opts.stubDefaultModel ? { defaultModel: opts.stubDefaultModel } : {}),
    }),
    choice: "stub",
    reason:
      "no image provider configured (optional) — image generation falls back to prompt-only. Set ENABLE_MOCK_IMAGE_PROVIDER=1 for the mock adapter; real openai / stability / replicate adapters are wired through the encrypted oauth_tokens + CryptoBoundary path (see packages/llm-provider/src/factory.ts) and arrive in a follow-up task.",
    optional: true,
  };
}
