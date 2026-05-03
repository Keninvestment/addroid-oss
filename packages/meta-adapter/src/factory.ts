// AdDroid OSS — Meta adapter factory.
//
// 実行環境に応じて MetaAdapter 実装を選択する。優先度:
//   1. ADDROID_META_OAUTH_MOCK=1   → MockMetaAdapter
//   2. OAuth client config が揃う + crypto → RealMetaAdapter
//   3. それ以外                       → StubMetaAdapter
//
// Meta App ID / Secret はこの関数の引数 / 環境変数からのみ流入し、
// コード内に literal を残さない。

import { MockMetaAdapter, type MockMetaAdapterOptions } from "./mock.js";
import { RealMetaAdapter, type CryptoEncryptDecrypt } from "./real.js";
import { StubMetaAdapter } from "./stub.js";
import type { MetaOAuthClientConfig } from "./oauth.js";
import type { MetaOAuthTokenStore } from "./token-store.js";
import type { MetaAdapter } from "./types.js";

export interface SelectMetaAdapterOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore: MetaOAuthTokenStore;
  crypto?: CryptoEncryptDecrypt;
  oauthClient?: MetaOAuthClientConfig | null;
  mock?: Omit<MockMetaAdapterOptions, "tokenStore">;
  fetchImpl?: typeof fetch;
}

export type MetaAdapterChoice = "mock" | "real" | "stub";

export interface MetaAdapterSelection {
  adapter: MetaAdapter;
  choice: MetaAdapterChoice;
  reason: string;
}

export function selectMetaAdapter(opts: SelectMetaAdapterOptions): MetaAdapterSelection {
  const env = opts.env ?? process.env;
  if (env.ADDROID_META_OAUTH_MOCK === "1") {
    return {
      adapter: new MockMetaAdapter({ tokenStore: opts.tokenStore, ...(opts.mock ?? {}) }),
      choice: "mock",
      reason: "ADDROID_META_OAUTH_MOCK=1",
    };
  }
  if (opts.oauthClient && opts.crypto) {
    return {
      adapter: new RealMetaAdapter({
        oauthClient: opts.oauthClient,
        tokenStore: opts.tokenStore,
        crypto: opts.crypto,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
      choice: "real",
      reason: "Meta OAuth client + crypto boundary configured",
    };
  }
  return {
    adapter: new StubMetaAdapter(),
    choice: "stub",
    reason: missingReason(opts),
  };
}

function missingReason(opts: SelectMetaAdapterOptions): string {
  const missing: string[] = [];
  if (!opts.oauthClient) missing.push("oauthClient");
  if (!opts.crypto) missing.push("crypto");
  return `Meta OAuth not configured (missing: ${missing.join(", ") || "n/a"})`;
}
