// AdDroid OSS — LLM provider OAuth token persistence boundary.
//
// CodexLLMProvider は `oauth_tokens` テーブルを直接触らず、本 interface 越しに
// 保存/取得する。暗号化は provider 側で実施し、Store には常に ciphertext を渡す。
//
// 実装:
//   - InMemoryLLMProviderTokenStore  (本ファイル) — テスト/ローカル simulation 用
//   - PrismaLLMProviderTokenStore    (apps/web/lib などで Prisma にバインド予定)

import type { LLMProviderName } from "./types.js";

export interface LLMProviderTokenRecord {
  provider: LLMProviderName;
  /** 表示用 identifier。OAuth account / org slug 等。機微ではない。 */
  accountIdentifier: string;
  scopes: string[];
  /** "v1.aes256gcm.iv.tag.payload" 形式の暗号化済み access token。 */
  accessTokenCiphertext: string;
  /** Codex は refresh_token を返すため null 許容で持つ。 */
  refreshTokenCiphertext?: string | null;
  expiresAt?: Date | null;
  connectedAt: Date;
  /** Provider 既定 model (UI 表示 + completion デフォルト)。 */
  defaultModel: string;
}

export interface LLMProviderTokenStore {
  /** provider+account 単位で upsert する。 */
  saveOAuthToken(record: LLMProviderTokenRecord): Promise<void>;
  /** 直近で接続された 1 件を返す。 */
  loadOAuthToken(provider: LLMProviderName): Promise<LLMProviderTokenRecord | null>;
  /** 切断 (記録があれば削除)。削除した場合 true。 */
  deleteOAuthToken(provider: LLMProviderName): Promise<boolean>;
}

export class InMemoryLLMProviderTokenStore implements LLMProviderTokenStore {
  private records = new Map<string, LLMProviderTokenRecord>();

  async saveOAuthToken(record: LLMProviderTokenRecord): Promise<void> {
    const key = `${record.provider}:${record.accountIdentifier}`;
    this.records.set(key, { ...record });
  }

  async loadOAuthToken(
    provider: LLMProviderName
  ): Promise<LLMProviderTokenRecord | null> {
    let latest: LLMProviderTokenRecord | null = null;
    for (const rec of this.records.values()) {
      if (rec.provider !== provider) continue;
      if (!latest || rec.connectedAt.getTime() > latest.connectedAt.getTime()) {
        latest = rec;
      }
    }
    return latest ? { ...latest } : null;
  }

  async deleteOAuthToken(provider: LLMProviderName): Promise<boolean> {
    let removed = false;
    for (const [k, rec] of this.records) {
      if (rec.provider === provider) {
        this.records.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  /** test helper. */
  size(): number {
    return this.records.size;
  }
}
