// AdDroid OSS — Prisma-backed OAuthTokenStore + GitHub adapter selection.
//
// `@addroid/github-adapter` は `oauth_tokens` テーブルを直接 import せず、
// `OAuthTokenStore` interface 越しに上書きする。本ファイルが Prisma 実装を提供し、
// `secrets.local.yaml` から OAuth client config を組み立てて
// `selectGithubAdapter` を呼ぶ。
//
// 個人 GitHub アカウント名や client secret はコードに literal を残さず、
// 環境変数または ~/.addroid/secrets.local.yaml からのみ流入させる。

import type { PrismaClient } from "@addroid/db";
import {
  getCryptoBoundary,
  readLocalSecrets,
  resolveWebBinding,
} from "@addroid/config";
import {
  selectGithubAdapter,
  type AdapterSelection,
  type OAuthClientConfig,
  type OAuthTokenRecord,
  type OAuthTokenStore,
} from "@addroid/github-adapter";

const TOKEN_GITHUB = "github" as const;

/**
 * Prisma を介して `oauth_tokens` テーブルを読み書きする TokenStore。
 * 本実装はトークン平文を見ないため、暗号化は github-adapter 側で完結する。
 */
export function createPrismaOAuthTokenStore(prisma: PrismaClient): OAuthTokenStore {
  return {
    async saveOAuthToken(record: OAuthTokenRecord): Promise<void> {
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
      if (provider !== TOKEN_GITHUB) return null;
      const row = await prisma.oAuthToken.findFirst({
        where: { provider },
        orderBy: { connectedAt: "desc" },
      });
      if (!row) return null;
      const out: OAuthTokenRecord = {
        provider: row.provider as typeof TOKEN_GITHUB,
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
 * `secrets.local.yaml` + 環境変数から OAuth client config を組み立てる。
 * client_secret が無ければ null を返し、Octokit adapter を選ばないことを示す。
 */
export async function loadGithubOAuthClient(
  env: NodeJS.ProcessEnv = process.env
): Promise<OAuthClientConfig | null> {
  let secrets: Awaited<ReturnType<typeof readLocalSecrets>> = null;
  try {
    secrets = await readLocalSecrets(env);
  } catch {
    // パース失敗時は null。doctor が別途報告する。
    return null;
  }
  const clientId = secrets?.github?.oauth?.clientId;
  const clientSecret = secrets?.github?.oauth?.clientSecret;
  if (!clientId || !clientSecret) return null;
  const binding = resolveWebBinding(env);
  const redirectUri =
    env.ADDROID_GITHUB_OAUTH_REDIRECT_URI?.trim() ||
    `http://${binding.hostname}:${binding.port}/api/oauth/github/callback`;
  return { clientId, clientSecret, redirectUri };
}

export interface ResolveGithubAdapterOptions {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
}

/**
 * worker 起動シーケンスから 1 度だけ呼ぶ。Mock / Octokit / Stub の選択結果と
 * 採用理由を返し、worker は console と監査ログに記録する。
 */
export async function resolveGithubAdapter(
  opts: ResolveGithubAdapterOptions
): Promise<AdapterSelection> {
  const env = opts.env ?? process.env;
  const tokenStore = createPrismaOAuthTokenStore(opts.prisma);
  const oauthClient = await loadGithubOAuthClient(env);
  let crypto: ReturnType<typeof getCryptoBoundary> | undefined;
  try {
    crypto = getCryptoBoundary(env);
  } catch {
    crypto = undefined;
  }
  return selectGithubAdapter({
    env,
    tokenStore,
    ...(oauthClient !== null ? { oauthClient } : {}),
    ...(crypto !== undefined ? { crypto } : {}),
  });
}
