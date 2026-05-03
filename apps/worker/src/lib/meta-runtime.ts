// AdDroid OSS — apps/worker shared helpers for Meta adapter wiring.
//
// CLI (`addroid activate` ほか) と worker runtime の双方が同じ Prisma-backed
// `MetaOAuthTokenStore` と `selectMetaAdapter` 経路を使うために切り出した共通モジュール。
// web 側の `apps/web/lib/meta-runtime.ts` とロジックは等価だが、apps/web は
// `package.json` に `"type": "module"` を持たないため、ESM 専用の CLI / worker から
// 安全に import できる本ファイルにロジックを集約する (apply / activate 用 store 群を
// `apps/worker/src/lib/activate-runtime.ts` に集約しているのと同じ理由)。
//
// regression fix: CLI Activate は本ヘルパー経由で Prisma 永続 token を読む。
//   - token が存在しない / 期限切れ → `CliActivateExecutor` が auth_error +
//     `oauth.meta.reauth_required` notify を返し、再認証を audit に記録する。
//   - production で `InMemoryMetaTokenStore` を使う経路は廃止する (空 store だと
//     どんな永続 token があっても CLI からは見えず、毎回 auth_error になる)。

import {
  ADDROID_META_REQUIRED_SCOPES,
  selectMetaAdapter,
  type MetaAdapterSelection,
  type MetaOAuthClientConfig,
  type MetaOAuthTokenRecord,
  type MetaOAuthTokenStore,
} from "@addroid/meta-adapter";
import {
  getCryptoBoundary,
  readLocalSecrets,
  resolveWebBinding,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";

const META_PROVIDER = "meta" as const;

/**
 * Prisma の `oauth_tokens` テーブルを裏に持つ `MetaOAuthTokenStore`。
 * web 側の `/api/oauth/meta/{begin,callback,refresh}` で保存された ciphertext を
 * そのまま CLI / worker から読み出すための単一経路。
 */
export function createPrismaMetaTokenStore(prisma: PrismaClient): MetaOAuthTokenStore {
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

/**
 * `~/.addroid/secrets.local.yaml` 等から Meta OAuth クライアント設定を組み立てる。
 * App ID / Secret が揃わなければ null を返し、`selectMetaAdapter` は Stub に倒れる。
 */
export async function loadMetaOAuthClientFromEnv(
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

export interface BuildPrismaMetaAdapterOptions {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
}

/**
 * Prisma 永続 token store + Meta OAuth client + crypto boundary から
 * `selectMetaAdapter` を呼んで `MetaAdapterSelection` を返す。
 *
 * - `ADDROID_META_OAUTH_MOCK=1` → Mock
 * - OAuth client + crypto 揃う → Real (本番)
 * - それ以外 → Stub (`loadAccessTokenPlaintext` は null を返し、後段で
 *   auth_error + reauth notify に変換される — regression fix/012 共通)
 */
export async function buildPrismaMetaAdapterSelection(
  opts: BuildPrismaMetaAdapterOptions
): Promise<MetaAdapterSelection> {
  const env = opts.env ?? process.env;
  const tokenStore = createPrismaMetaTokenStore(opts.prisma);
  const oauthClient = await loadMetaOAuthClientFromEnv(env);
  let crypto: ReturnType<typeof getCryptoBoundary> | undefined;
  try {
    crypto = getCryptoBoundary(env);
  } catch {
    crypto = undefined;
  }
  return selectMetaAdapter({
    env,
    tokenStore,
    ...(oauthClient ? { oauthClient } : {}),
    ...(crypto ? { crypto } : {}),
  });
}
