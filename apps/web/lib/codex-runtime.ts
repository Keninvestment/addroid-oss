// AdDroid OSS — apps/web 側の Codex app-server runtime cache.
//
// Codex は AdDroid DB に OAuth token を保存せず、local app-server が Codex CLI /
// ChatGPT の認証状態を管理する。Web からの接続開始も同じ app-server instance を
// per-process で再利用する。

import {
  selectLLMProvider,
  type LLMProviderSelection,
} from "@addroid/llm-provider";
import { InMemoryLLMProviderTokenStore } from "@addroid/llm-provider";

declare global {
  var __addroidWebCodexProviderSelection__: LLMProviderSelection | undefined;
}

/**
 * Codex / LLM Provider selection を per-process にキャッシュし、Web UI と API route から
 * 同じ local app-server 接続を再利用できるようにする。
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
  const tokenStore = new InMemoryLLMProviderTokenStore();
  const selection = selectLLMProvider({
    env,
    tokenStore,
    codexAppServer: {
      externalServerUrl:
        env.ADDROID_CODEX_APP_SERVER_URL?.trim() ||
        env.CODEX_APP_SERVER_URL?.trim() ||
        null,
      codexBin: env.CODEX_BIN?.trim() || "codex",
      cwd: env.ADDROID_CODEX_CWD?.trim() || process.cwd(),
    },
  });
  globalThis.__addroidWebCodexProviderSelection__ = selection;
  return selection;
}
