// AdDroid OSS — OAuth token persistence boundary.
//
// adapter は `oauth_tokens` テーブルを直接触らず、本 interface 越しに保存/取得する。
// 暗号化は adapter 側で実施し、Store には常に ciphertext を渡す。
//
// 実装:
//   - InMemoryOAuthTokenStore  (本ファイル) — テストとローカル simulation 用
//   - PrismaOAuthTokenStore     (apps/worker/src/lib/github-adapter-wiring.ts)

export type GithubTokenProvider = "github";

export interface OAuthTokenRecord {
  provider: GithubTokenProvider;
  /** 表示用の login (機微ではない)。 */
  accountIdentifier: string;
  scopes: string[];
  /** 暗号化済み access token (e.g. "v1.aes256gcm.iv.tag.payload")。 */
  accessTokenCiphertext: string;
  refreshTokenCiphertext?: string | null;
  /** GitHub からは expires_in のみ返るので、保存側で Date 化する。 */
  expiresAt?: Date | null;
  connectedAt: Date;
}

export interface OAuthTokenStore {
  /** provider+account 単位で upsert する。 */
  saveOAuthToken(record: OAuthTokenRecord): Promise<void>;
  /** 直近で接続された 1 件を返す。複数 account は the current implementation 範囲外。 */
  loadOAuthToken(provider: GithubTokenProvider): Promise<OAuthTokenRecord | null>;
}

/**
 * メモリ内に保持するテスト用 store。同一 provider+account は最新値で上書きされ、
 * `loadOAuthToken` は connectedAt 降順で最も新しい行を返す。
 */
export class InMemoryOAuthTokenStore implements OAuthTokenStore {
  private records = new Map<string, OAuthTokenRecord>();

  async saveOAuthToken(record: OAuthTokenRecord): Promise<void> {
    const key = `${record.provider}:${record.accountIdentifier}`;
    this.records.set(key, { ...record });
  }

  async loadOAuthToken(provider: GithubTokenProvider): Promise<OAuthTokenRecord | null> {
    let latest: OAuthTokenRecord | null = null;
    for (const rec of this.records.values()) {
      if (rec.provider !== provider) continue;
      if (!latest || rec.connectedAt.getTime() > latest.connectedAt.getTime()) {
        latest = rec;
      }
    }
    return latest ? { ...latest } : null;
  }

  /** test helper. */
  size(): number {
    return this.records.size;
  }
}
