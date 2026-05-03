// AdDroid OSS — StubMetaAdapter.
//
// OAuth client / 暗号化境界が未設定のときに使う最小実装。
// すべてのメソッドが `MetaAdapterNotImplementedError` を投げ、UI / runtime 側で
// 「設定が未完了」を検知して setup ガイドへ誘導する。

import {
  MetaAdapterNotImplementedError,
  type MetaAdapter,
  type MetaAccessTokenLease,
  type MetaAdAccount,
  type MetaBeginOAuthResult,
  type MetaBusiness,
  type MetaOAuthConnection,
  type MetaRefreshResult,
} from "./types.js";

export class StubMetaAdapter implements MetaAdapter {
  async beginOAuth(): Promise<MetaBeginOAuthResult> {
    throw new MetaAdapterNotImplementedError("beginOAuth");
  }
  async completeOAuth(): Promise<MetaOAuthConnection> {
    throw new MetaAdapterNotImplementedError("completeOAuth");
  }
  async refreshLongLivedToken(): Promise<MetaRefreshResult> {
    throw new MetaAdapterNotImplementedError("refreshLongLivedToken");
  }
  async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
    return null;
  }
  async fetchBusinesses(): Promise<MetaBusiness[]> {
    throw new MetaAdapterNotImplementedError("fetchBusinesses");
  }
  async fetchAdAccounts(): Promise<MetaAdAccount[]> {
    throw new MetaAdapterNotImplementedError("fetchAdAccounts");
  }
}
