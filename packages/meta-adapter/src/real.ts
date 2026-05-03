// AdDroid OSS — RealMetaAdapter (本番経路).
//
// Meta Login for Business + Marketing Graph API を実呼び出しする実装。
// 取扱方針:
//   - access token は `MetaOAuthTokenStore` から取り出した ciphertext を
//     `CryptoEncryptDecrypt` で都度復号する。プロセスメモリにはメソッド呼び出しの
//     スコープでのみ存在させる。
//   - access token は HTTP ヘッダ (Authorization: Bearer …) または POST body 経由でのみ
//     送信し、URL クエリには **絶対に置かない**。これによりプロキシ・アクセスログ・
//     ブラウザ履歴経由でのトークン漏洩を防ぐ。ログ出力もしない。
//   - long-lived token は完成後に保存し、短命 token は破棄する。

import {
  fetchAdAccounts as fetchAdAccountsApi,
  fetchBusinesses as fetchBusinessesApi,
  fetchMeProfile,
} from "./api.js";
import {
  buildMetaAuthorizationUrl,
  debugToken,
  deriveExpiresAt,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  buildAppAccessToken,
  type MetaOAuthClientConfig,
} from "./oauth.js";
import type { MetaOAuthTokenRecord, MetaOAuthTokenStore } from "./token-store.js";
import {
  MetaAdapterUnauthenticatedError,
  MetaOAuthStateMismatchError,
  MetaTokenExpiredError,
  type MetaAccessTokenLease,
  type MetaAdAccount,
  type MetaAdapter,
  type MetaBeginOAuthResult,
  type MetaBusiness,
  type MetaOAuthConnection,
  type MetaRefreshResult,
} from "./types.js";

/**
 * Encryption boundary — `@addroid/config` の `CryptoBoundary` と structurally 互換。
 * 直接 import せず `getCryptoBoundary()` 由来の値を渡してもらうことで、
 * meta-adapter から config への依存を増やさない。
 */
export interface CryptoEncryptDecrypt {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface RealMetaAdapterDeps {
  oauthClient: MetaOAuthClientConfig;
  tokenStore: MetaOAuthTokenStore;
  crypto: CryptoEncryptDecrypt;
  /** test seam: 既定は global fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * `debugToken` で取得した accurate expires_at を採用するかどうか。既定 true。
   * Meta は long-lived token に expires_in を返さないが、debug_token は返す。
   */
  useDebugTokenExpiry?: boolean;
}

export class RealMetaAdapter implements MetaAdapter {
  private readonly client: MetaOAuthClientConfig;
  private readonly tokenStore: MetaOAuthTokenStore;
  private readonly crypto: CryptoEncryptDecrypt;
  private readonly fetchImpl: typeof fetch;
  private readonly useDebugTokenExpiry: boolean;
  private pendingState: string | null = null;

  constructor(deps: RealMetaAdapterDeps) {
    this.client = deps.oauthClient;
    this.tokenStore = deps.tokenStore;
    this.crypto = deps.crypto;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.useDebugTokenExpiry = deps.useDebugTokenExpiry !== false;
  }

  async beginOAuth(): Promise<MetaBeginOAuthResult> {
    const built = buildMetaAuthorizationUrl({ client: this.client });
    this.pendingState = built.state;
    return built;
  }

  async completeOAuth(params: {
    code: string;
    state: string;
  }): Promise<MetaOAuthConnection> {
    // Fail closed: persisted pending state must exist AND match. null pendingState
    // (no prior beginOAuth, or already-consumed state) is treated as CSRF.
    if (!this.pendingState || params.state !== this.pendingState) {
      this.pendingState = null;
      throw new MetaOAuthStateMismatchError();
    }
    this.pendingState = null;

    // 1) short-lived 交換
    const shortLived = await exchangeCodeForToken({
      client: this.client,
      code: params.code,
      fetchImpl: this.fetchImpl,
    });

    // 2) long-lived 交換
    const longLived = await exchangeForLongLivedToken({
      client: this.client,
      shortLivedToken: shortLived.accessToken,
      fetchImpl: this.fetchImpl,
    });

    // 3) `me` から表示用の identifier を取得
    const me = await fetchMeProfile({
      accessToken: longLived.accessToken,
      fetchImpl: this.fetchImpl,
    });

    // 4) /debug_token で正確な expiresAt と scopes を取得
    let scopes: string[] = this.client.scopes
      ? Array.from(this.client.scopes)
      : ["ads_management", "ads_read", "business_management"];
    let expiresAt = deriveExpiresAt(longLived);
    if (this.useDebugTokenExpiry) {
      try {
        const info = await debugToken({
          appAccessToken: buildAppAccessToken(this.client),
          inputToken: longLived.accessToken,
          fetchImpl: this.fetchImpl,
        });
        if (info.scopes.length > 0) scopes = info.scopes;
        if (info.expiresAt > 0) {
          expiresAt = new Date(info.expiresAt * 1000);
        } else if (info.expiresAt === 0) {
          // 0 = never (System User token 等)。null にする。
          expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        }
      } catch {
        /* debug_token は best-effort。失敗しても接続自体は成功扱い。 */
      }
    }

    const connectedAt = new Date();
    const accountIdentifier = me.id || me.name || "meta-user";
    await this.tokenStore.saveOAuthToken({
      provider: "meta",
      accountIdentifier,
      scopes,
      accessTokenCiphertext: this.crypto.encrypt(longLived.accessToken),
      expiresAt,
      connectedAt,
    });

    // 5) Businesses + Ad Accounts を取得 (long-lived token を使う)
    const [businesses, adAccounts] = await Promise.all([
      fetchBusinessesApi({
        accessToken: longLived.accessToken,
        fetchImpl: this.fetchImpl,
      }).catch(() => [] as MetaBusiness[]),
      fetchAdAccountsApi({
        accessToken: longLived.accessToken,
        fetchImpl: this.fetchImpl,
      }).catch(() => [] as MetaAdAccount[]),
    ]);

    return {
      provider: "meta",
      accountIdentifier,
      scopes,
      connectedAt: connectedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      businesses,
      adAccounts,
    };
  }

  async refreshLongLivedToken(): Promise<MetaRefreshResult> {
    const existing = await this.tokenStore.loadOAuthToken("meta");
    if (!existing) throw new MetaAdapterUnauthenticatedError("refresh long-lived token");
    const current = this.crypto.decrypt(existing.accessTokenCiphertext);

    const refreshed = await exchangeForLongLivedToken({
      client: this.client,
      shortLivedToken: current,
      fetchImpl: this.fetchImpl,
    });

    let expiresAt = deriveExpiresAt(refreshed);
    if (this.useDebugTokenExpiry) {
      try {
        const info = await debugToken({
          appAccessToken: buildAppAccessToken(this.client),
          inputToken: refreshed.accessToken,
          fetchImpl: this.fetchImpl,
        });
        if (info.expiresAt > 0) {
          expiresAt = new Date(info.expiresAt * 1000);
        }
      } catch {
        /* best effort */
      }
    }

    const refreshedAt = new Date();
    await this.tokenStore.saveOAuthToken({
      ...existing,
      accessTokenCiphertext: this.crypto.encrypt(refreshed.accessToken),
      expiresAt,
    });
    return {
      provider: "meta",
      accountIdentifier: existing.accountIdentifier,
      scopes: existing.scopes,
      refreshedAt: refreshedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
    const rec = await this.tokenStore.loadOAuthToken("meta");
    if (!rec) return null;
    if (rec.expiresAt && rec.expiresAt.getTime() < Date.now()) {
      throw new MetaTokenExpiredError(rec.expiresAt);
    }
    return {
      accessToken: this.crypto.decrypt(rec.accessTokenCiphertext),
      scopes: rec.scopes,
      expiresAt: rec.expiresAt ?? null,
      accountIdentifier: rec.accountIdentifier,
    };
  }

  async fetchBusinesses(): Promise<MetaBusiness[]> {
    const lease = await this.requireLease("fetch businesses");
    return fetchBusinessesApi({
      accessToken: lease.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }

  async fetchAdAccounts(): Promise<MetaAdAccount[]> {
    const lease = await this.requireLease("fetch ad accounts");
    return fetchAdAccountsApi({
      accessToken: lease.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }

  private async requireLease(op: string): Promise<MetaAccessTokenLease> {
    const rec = await this.tokenStore.loadOAuthToken("meta");
    if (!rec) throw new MetaAdapterUnauthenticatedError(op);
    if (rec.expiresAt && rec.expiresAt.getTime() < Date.now()) {
      throw new MetaTokenExpiredError(rec.expiresAt);
    }
    return {
      accessToken: this.crypto.decrypt(rec.accessTokenCiphertext),
      scopes: rec.scopes,
      expiresAt: rec.expiresAt ?? null,
      accountIdentifier: rec.accountIdentifier,
    };
  }
}

// 型を export 経路に通すための無参照参照。
export type _RecordRef = MetaOAuthTokenRecord;
