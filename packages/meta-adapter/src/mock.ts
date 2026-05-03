// AdDroid OSS — MockMetaAdapter.
//
// `ADDROID_META_OAUTH_MOCK=1` のときに採用される、ネットワークを一切使わない実装。
// /accounts ページの開発、UI のスナップショットテスト、後続契約 (Apply/Activate) の
// 統合テストで再利用する。
//
// 重要 — ハードコードされた Meta App ID や access_token 文字列は使わない。
// 既定値は generic な mock-app-id / mock-user-* 等で、テスト/UI から上書き可能。

import {
  ADDROID_META_REQUIRED_SCOPES,
  generateMetaOAuthState,
} from "./oauth.js";
import type { MetaOAuthTokenStore } from "./token-store.js";
import {
  MetaAdapterUnauthenticatedError,
  MetaOAuthStateMismatchError,
  type MetaAccessTokenLease,
  type MetaAdAccount,
  type MetaAdapter,
  type MetaBeginOAuthResult,
  type MetaBusiness,
  type MetaOAuthConnection,
  type MetaRefreshResult,
} from "./types.js";

const MOCK_AUTH_BASE = "https://addroid.invalid/mock-meta-oauth/authorize";

export interface MockMetaAdapterOptions {
  tokenStore: MetaOAuthTokenStore;
  /** 表示用の Meta user id。既定 "mock-meta-user". */
  mockUserId?: string;
  /** Mock Business 一覧 (固定)。 */
  businesses?: MetaBusiness[];
  /** Mock Ad Account 一覧 (固定)。 */
  adAccounts?: MetaAdAccount[];
  /** mock 暗号化シード (test seam)。 */
  fakeCiphertext?: string;
  /**
   * `completeOAuth` 時の expiresAt 計算用 (秒)。既定 60 日。
   */
  expiresInSeconds?: number;
  /**
   * オプション: completeOAuth/refresh が常に失敗するように切替えるテスト用フラグ。
   * 失敗モードは "auth_failed" — Meta 側 invalid grant を表現する。
   */
  failureMode?: "auth_failed" | null;
}

const DEFAULTS = {
  userId: "mock-meta-user",
  businesses: [
    { id: "1000000000000001", name: "Mock Business Alpha", role: "ADMIN" },
    { id: "1000000000000002", name: "Mock Business Beta", role: "EMPLOYEE" },
  ] satisfies MetaBusiness[],
  adAccounts: [
    {
      accountId: "1234567890",
      metaAccountId: "act_1234567890",
      name: "Mock Ad Account A",
      currency: "JPY",
      timezoneName: "Asia/Tokyo",
      businessId: "1000000000000001",
      accountStatus: 1,
    },
    {
      accountId: "9876543210",
      metaAccountId: "act_9876543210",
      name: "Mock Ad Account B",
      currency: "USD",
      timezoneName: "America/Los_Angeles",
      businessId: "1000000000000002",
      accountStatus: 1,
    },
  ] satisfies MetaAdAccount[],
} as const;

export class MockMetaAdapter implements MetaAdapter {
  private readonly tokenStore: MetaOAuthTokenStore;
  private readonly mockUserId: string;
  private readonly businesses: MetaBusiness[];
  private readonly adAccounts: MetaAdAccount[];
  private readonly fakeCiphertextSeed: string;
  private readonly expiresInSeconds: number;
  private failureMode: "auth_failed" | null;
  private pendingState: string | null = null;

  constructor(opts: MockMetaAdapterOptions) {
    this.tokenStore = opts.tokenStore;
    this.mockUserId = opts.mockUserId ?? DEFAULTS.userId;
    this.businesses = opts.businesses ?? [...DEFAULTS.businesses];
    this.adAccounts = opts.adAccounts ?? [...DEFAULTS.adAccounts];
    this.fakeCiphertextSeed = opts.fakeCiphertext ?? "mock-meta-encrypted";
    this.expiresInSeconds = opts.expiresInSeconds ?? 60 * 24 * 60 * 60;
    this.failureMode = opts.failureMode ?? null;
  }

  async beginOAuth(): Promise<MetaBeginOAuthResult> {
    const state = generateMetaOAuthState();
    this.pendingState = state;
    const params = new URLSearchParams({
      state,
      user: this.mockUserId,
      scope: ADDROID_META_REQUIRED_SCOPES.join(","),
    });
    return {
      authorizationUrl: `${MOCK_AUTH_BASE}?${params.toString()}`,
      state,
    };
  }

  async completeOAuth(params: { code: string; state: string }): Promise<MetaOAuthConnection> {
    if (this.pendingState && params.state !== this.pendingState) {
      throw new MetaOAuthStateMismatchError();
    }
    this.pendingState = null;
    if (this.failureMode === "auth_failed") {
      throw new Error("Meta OAuth error: invalid_grant (mock failure_mode=auth_failed)");
    }
    const connectedAt = new Date();
    const ciphertext = `${this.fakeCiphertextSeed}::${params.code}`;
    const expiresAt = new Date(connectedAt.getTime() + this.expiresInSeconds * 1000);
    await this.tokenStore.saveOAuthToken({
      provider: "meta",
      accountIdentifier: this.mockUserId,
      scopes: [...ADDROID_META_REQUIRED_SCOPES],
      accessTokenCiphertext: ciphertext,
      expiresAt,
      connectedAt,
    });
    return {
      provider: "meta",
      accountIdentifier: this.mockUserId,
      scopes: [...ADDROID_META_REQUIRED_SCOPES],
      connectedAt: connectedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      businesses: [...this.businesses],
      adAccounts: [...this.adAccounts],
    };
  }

  async refreshLongLivedToken(): Promise<MetaRefreshResult> {
    const existing = await this.tokenStore.loadOAuthToken("meta");
    if (!existing) throw new MetaAdapterUnauthenticatedError("refresh long-lived token");
    if (this.failureMode === "auth_failed") {
      throw new Error("Meta OAuth error: invalid_token (mock failure_mode=auth_failed)");
    }
    const refreshedAt = new Date();
    const expiresAt = new Date(refreshedAt.getTime() + this.expiresInSeconds * 1000);
    await this.tokenStore.saveOAuthToken({
      ...existing,
      accessTokenCiphertext: `${this.fakeCiphertextSeed}::refreshed-${refreshedAt.getTime()}`,
      expiresAt,
      connectedAt: existing.connectedAt,
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
    // mock では ciphertext 自体を擬似平文として返す。本番経路は Real adapter を使う。
    return {
      accessToken: rec.accessTokenCiphertext,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt ?? null,
      accountIdentifier: rec.accountIdentifier,
    };
  }

  async fetchBusinesses(): Promise<MetaBusiness[]> {
    const rec = await this.tokenStore.loadOAuthToken("meta");
    if (!rec) throw new MetaAdapterUnauthenticatedError("fetch businesses");
    return [...this.businesses];
  }

  async fetchAdAccounts(): Promise<MetaAdAccount[]> {
    const rec = await this.tokenStore.loadOAuthToken("meta");
    if (!rec) throw new MetaAdapterUnauthenticatedError("fetch ad accounts");
    return [...this.adAccounts];
  }

  // ---- test helpers ----

  /** 後続呼び出しの失敗モードを切替える。 */
  setFailureMode(mode: "auth_failed" | null): void {
    this.failureMode = mode;
  }
}
