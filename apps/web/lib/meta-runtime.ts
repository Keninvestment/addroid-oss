// AdDroid OSS — apps/web 側の Meta adapter / token store / runtime cache.
//
// `/api/oauth/meta/{begin,callback,refresh}` と `/accounts` ページから共通利用する。
//
// - MetaAdapter は `selectMetaAdapter` の結果を per-process でキャッシュする。
//   beginOAuth で発行した state を completeOAuth で消費する都合上、両 API 呼び出しが
//   同じ adapter インスタンスを参照する必要があるため、globalThis に保存する。
// - Business 一覧は Meta GraphQL から取得する runtime cache (ホットリロードを跨ぐ
//   ため globalThis に持つ)。
// - サニタイズ: 表示直前に access_token が万一含まれていても [REDACTED] に変換する
//   ヘルパも本ファイルから export する。

import {
  ADDROID_META_REQUIRED_SCOPES,
  type MetaAdAccount,
  type MetaAdapterSelection,
  type MetaBusiness,
  type MetaOAuthClientConfig,
  type MetaOAuthTokenRecord,
  type MetaOAuthTokenStore,
  selectMetaAdapter,
} from "@addroid/meta-adapter";
import {
  defaultAddroidConfig,
  ensureAddroidPaths,
  getCryptoBoundary,
  readAddroidConfig,
  readLocalSecrets,
  resolveWebBinding,
} from "@addroid/config";
import { ensureWorkspace } from "../../worker/src/lib/prisma-stores";
import { prisma } from "./prisma";

declare global {
  // eslint-disable-next-line no-var
  var __addroidWebMetaAdapterSelection__: MetaAdapterSelection | undefined;
  // eslint-disable-next-line no-var
  var __addroidWebMetaBusinessCache__:
    | { businesses: MetaBusiness[]; adAccounts: MetaAdAccount[]; fetchedAt: Date; accountIdentifier: string }
    | undefined;
}

const META_PROVIDER = "meta" as const;

function createPrismaMetaTokenStore(): MetaOAuthTokenStore {
  return {
    async saveOAuthToken(record: MetaOAuthTokenRecord): Promise<void> {
      await prisma.oAuthToken.upsert({
        where: {
          provider_accountIdentifier: {
            provider: record.provider,
            accountIdentifier: record.accountIdentifier,
          },
        },
        update: {
          scopes: record.scopes,
          accessTokenCiphertext: record.accessTokenCiphertext,
          refreshTokenCiphertext: record.refreshTokenCiphertext ?? null,
          expiresAt: record.expiresAt ?? null,
          connectedAt: record.connectedAt,
        },
        create: {
          provider: record.provider,
          accountIdentifier: record.accountIdentifier,
          scopes: record.scopes,
          accessTokenCiphertext: record.accessTokenCiphertext,
          refreshTokenCiphertext: record.refreshTokenCiphertext ?? null,
          expiresAt: record.expiresAt ?? null,
          connectedAt: record.connectedAt,
        },
      });
    },
    async loadOAuthToken(provider) {
      if (provider !== META_PROVIDER) return null;
      const row = await prisma.oAuthToken.findFirst({
        where: { provider },
        orderBy: { connectedAt: "desc" },
      });
      if (!row) return null;
      const out: MetaOAuthTokenRecord = {
        provider: row.provider as typeof META_PROVIDER,
        accountIdentifier: row.accountIdentifier,
        scopes: row.scopes,
        accessTokenCiphertext: row.accessTokenCiphertext,
        connectedAt: row.connectedAt,
      };
      if (row.refreshTokenCiphertext !== null) {
        out.refreshTokenCiphertext = row.refreshTokenCiphertext;
      }
      if (row.expiresAt !== null) out.expiresAt = row.expiresAt;
      return out;
    },
  };
}

async function loadMetaOAuthClient(
  env: NodeJS.ProcessEnv = process.env
): Promise<MetaOAuthClientConfig | null> {
  let secrets: Awaited<ReturnType<typeof readLocalSecrets>> = null;
  try {
    secrets = await readLocalSecrets(env);
  } catch {
    return null;
  }
  const appId = secrets?.meta?.oauth?.appId;
  const appSecret = secrets?.meta?.oauth?.appSecret;
  if (!appId || !appSecret) return null;
  const binding = resolveWebBinding(env);
  const redirectUri =
    env.ADDROID_META_OAUTH_REDIRECT_URI?.trim() ||
    `http://${binding.hostname}:${binding.port}/api/oauth/meta/callback`;
  const permissions = secrets?.meta?.oauth?.permissions;
  const scopes =
    Array.isArray(permissions) && permissions.length > 0
      ? permissions
      : Array.from(ADDROID_META_REQUIRED_SCOPES);
  return { appId, appSecret, redirectUri, scopes };
}

/**
 * Meta adapter selection を per-process にキャッシュし、`begin` で発行した state が
 * `callback` で必ず参照できるようにする。
 *
 * テスト/ローカル demo で `ADDROID_META_OAUTH_MOCK=1` の場合は MockMetaAdapter を返す。
 */
export async function getActiveMetaAdapter(): Promise<MetaAdapterSelection> {
  if (globalThis.__addroidWebMetaAdapterSelection__) {
    return globalThis.__addroidWebMetaAdapterSelection__;
  }
  const env = process.env;
  const tokenStore = createPrismaMetaTokenStore();
  const oauthClient = await loadMetaOAuthClient(env);
  let crypto: ReturnType<typeof getCryptoBoundary> | undefined;
  try {
    crypto = getCryptoBoundary(env);
  } catch {
    crypto = undefined;
  }
  const selection = selectMetaAdapter({
    env,
    tokenStore,
    ...(oauthClient !== null ? { oauthClient } : {}),
    ...(crypto !== undefined ? { crypto } : {}),
  });
  globalThis.__addroidWebMetaAdapterSelection__ = selection;
  return selection;
}

/**
 * config.yaml の slug + ensureAddroidPaths から Workspace を idempotent に upsert する。
 */
export async function ensureWebWorkspace(): Promise<{ id: string; slug: string }> {
  const paths = await ensureAddroidPaths();
  const config = (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  return ensureWorkspace(prisma, {
    slug: config.workspace.slug,
    displayName: config.workspace.displayName,
    configPath: paths.configFile,
    storageDir: paths.storageDir,
    databaseUrlRef: config.database.urlRef,
  });
}

// ---------------------------------------------------------------------
// Runtime cache for Businesses + AdAccounts (per-process, HMR-safe).
// 接続直後 (callback) と refresh-businesses で更新される。
// ---------------------------------------------------------------------
export interface MetaBusinessCache {
  businesses: MetaBusiness[];
  adAccounts: MetaAdAccount[];
  fetchedAt: Date;
  accountIdentifier: string;
}

export function getMetaBusinessCache(): MetaBusinessCache | null {
  return globalThis.__addroidWebMetaBusinessCache__ ?? null;
}

export function setMetaBusinessCache(cache: MetaBusinessCache): void {
  globalThis.__addroidWebMetaBusinessCache__ = cache;
}

export function clearMetaBusinessCache(): void {
  globalThis.__addroidWebMetaBusinessCache__ = undefined;
}

// ---------------------------------------------------------------------
// Sanitization helpers — UI layer がトークン由来の文字列を表示する直前に通す。
// access_token=... / Bearer xxx / META_*_TOKEN を [REDACTED] に置換する。
// ---------------------------------------------------------------------
const TOKEN_PATTERNS: RegExp[] = [
  /access_token=([^\s&]+)/gi,
  /Bearer\s+([A-Za-z0-9_.\-|]+)/gi,
  /(EAA[A-Za-z0-9_-]{20,})/g,
];

export function sanitizeForDisplay(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (match, group) => match.replace(group, "[REDACTED]"));
  }
  return out;
}
