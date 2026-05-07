// AdDroid OSS — apps/web 側の Codex (LLM Provider) runtime cache.
//
// `/api/oauth/codex/{begin,callback}` から共通利用する。
//
// - LLMProviderSelection は `selectLLMProvider` の結果を per-process でキャッシュ
//   する。CodexLLMProvider.beginOAuth で発行した state / PKCE verifier は
//   provider インスタンス内部 (`pending`) に保持されるため、begin と callback が
//   **同じ provider インスタンス** を参照する必要がある。Next.js の HMR を跨ぐ
//   ため globalThis に保存する (Meta / GitHub と同じ規約)。
// - Token store / OAuth client config / chatCompletionsUrl / defaultModel は
//   worker 側 helper (`apps/worker/src/lib/llm-runtime`) と同じものを使う。
//   web の callback で保存された ciphertext + metadata を worker がそのまま
//   読み出せるようにするため、env と `oauth_tokens` テーブルの境界を共有する。
// - Codex OAuth に必要な runtime 設定 (ENCRYPTION_KEY / chat endpoint / model) が未設定の場合は
//   `selectLLMProvider` が StubLLMProvider に倒し、begin route は理由付きで
//   `/ai` に戻す。

import {
  selectLLMProvider,
  type LLMProviderSelection,
} from "@addroid/llm-provider";
import { getCryptoBoundary } from "@addroid/config";
import {
  createPrismaLLMProviderTokenStore,
  loadCodexLLMClientFromEnv,
} from "../../worker/src/lib/llm-runtime";
import { prisma } from "./prisma";

declare global {
  var __addroidWebCodexProviderSelection__: LLMProviderSelection | undefined;
}

/**
 * Codex / LLM Provider selection を per-process にキャッシュし、`begin` で発行した
 * state / PKCE verifier が `callback` で必ず参照できるようにする。
 *
 * `ADDROID_LLM_MOCK=1` のときは MockLLMProvider を返す (mock authorize URL は
 * `addroid.invalid` 配下の到達不能 host なので、begin route 側で内部 callback に
 * code=mock-<state> でループバックさせる)。
 */
export function getActiveCodexProviderSelection(): LLMProviderSelection {
  if (globalThis.__addroidWebCodexProviderSelection__) {
    return globalThis.__addroidWebCodexProviderSelection__;
  }
  const env = process.env;
  const tokenStore = createPrismaLLMProviderTokenStore(prisma);
  const codexClient = loadCodexLLMClientFromEnv(env);
  let crypto: ReturnType<typeof getCryptoBoundary> | undefined;
  try {
    crypto = getCryptoBoundary(env);
  } catch {
    crypto = undefined;
  }
  const chatCompletionsUrl =
    env.ADDROID_CODEX_CHAT_COMPLETIONS_URL?.trim() || null;
  const defaultModel = env.ADDROID_CODEX_DEFAULT_MODEL?.trim() || undefined;
  const selection = selectLLMProvider({
    env,
    tokenStore,
    codexClient,
    chatCompletionsUrl,
    ...(crypto ? { crypto } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  });
  globalThis.__addroidWebCodexProviderSelection__ = selection;
  return selection;
}
