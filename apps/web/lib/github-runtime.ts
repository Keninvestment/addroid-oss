// AdDroid OSS — apps/web 側の GitHub adapter / workspace 取り回し。
//
// `/api/oauth/github/{begin,callback}` と `/api/github/bootstrap-ops-repo` から
// 共通利用する。
//
// - GithubAdapter は `selectGithubAdapter` の結果を per-process でキャッシュする。
//   beginOAuth で発行した state を completeOAuth で消費する都合上、両 API 呼び出し
//   が同じ adapter インスタンスを参照する必要があるため、globalThis に保存して
//   Next.js の HMR を跨いでも維持する。
// - Workspace 行は worker 起動より先に web から OAuth callback が叩かれる可能性が
//   あるため、本ファイルでも `ensureWorkspace` を upsert で呼べるようにする。
// - ops repository の希望名は `~/.addroid/config.yaml` の `github.opsRepo.name` を
//   優先し、未設定なら `addroid-ops` をフォールバック
//   として使う (個人アカウントや具体プロジェクト名を literal に書かない)。

import {
  defaultAddroidConfig,
  ensureAddroidPaths,
  getCryptoBoundary,
  readAddroidConfig,
  readLocalSecrets,
  resolveWebBinding,
} from "@addroid/config";
import {
  injectGithubAdapter,
  selectGithubAdapter,
  type AdapterSelection,
  type OAuthClientConfig,
  type OAuthTokenRecord,
  type OAuthTokenStore,
} from "@addroid/github-adapter";
import {
  ensureWorkspace,
  persistOpsRepoBootstrap as workerPersistOpsRepoBootstrap,
  type PersistOpsRepoBootstrapInput,
} from "../../worker/src/lib/prisma-stores";
import { prisma } from "./prisma";

declare global {
  var __addroidWebGithubAdapterSelection__: AdapterSelection | undefined;
}

const TOKEN_GITHUB = "github" as const;

function createPrismaOAuthTokenStore(): OAuthTokenStore {
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

async function loadGithubOAuthClient(
  env: NodeJS.ProcessEnv = process.env
): Promise<OAuthClientConfig | null> {
  let secrets: Awaited<ReturnType<typeof readLocalSecrets>> = null;
  try {
    secrets = await readLocalSecrets(env);
  } catch {
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

/**
 * adapter selection を per-process にキャッシュし、`begin` で発行した state が
 * `callback` で必ず参照できるようにする。
 */
export async function getActiveGithubAdapter(): Promise<AdapterSelection> {
  if (globalThis.__addroidWebGithubAdapterSelection__) {
    return globalThis.__addroidWebGithubAdapterSelection__;
  }
  const env = process.env;
  const tokenStore = createPrismaOAuthTokenStore();
  const oauthClient = await loadGithubOAuthClient(env);
  const storedTokenAvailable = Boolean(
    await tokenStore.loadOAuthToken("github").catch(() => null)
  );
  let crypto: ReturnType<typeof getCryptoBoundary> | undefined;
  try {
    crypto = getCryptoBoundary(env);
  } catch {
    crypto = undefined;
  }
  const selection = selectGithubAdapter({
    env,
    tokenStore,
    ...(oauthClient !== null ? { oauthClient } : {}),
    storedTokenAvailable,
    ...(crypto !== undefined ? { crypto } : {}),
  });
  injectGithubAdapter(selection.adapter);
  globalThis.__addroidWebGithubAdapterSelection__ = selection;
  return selection;
}

/**
 * config.yaml の slug + ensureAddroidPaths から Workspace を idempotent に upsert する。
 * worker 未起動でも /github のフローを完遂できるようにするためのセーフネット。
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

export interface DesiredOpsRepo {
  desiredName: string;
  defaultBranch: string;
  workspaceSlug: string;
  workspaceDisplayName: string;
}

/**
 * `~/.addroid/config.yaml` から ops repo の希望名と default branch を解決する。
 * ハードコードされた個人アカウントや repo 名は使わず、未設定時は slug 由来の
 * 既定値にフォールバックする。
 */
export async function resolveDesiredOpsRepo(): Promise<DesiredOpsRepo> {
  const config = (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  const slug = config.workspace.slug;
  const desiredName = config.github?.opsRepo?.name ?? "addroid-ops";
  const defaultBranch = config.github?.opsRepo?.defaultBranch ?? "main";
  return {
    desiredName,
    defaultBranch,
    workspaceSlug: slug,
    workspaceDisplayName: config.workspace.displayName,
  };
}

export async function persistOpsRepoBootstrap(
  input: PersistOpsRepoBootstrapInput
): Promise<{ repoId: string }> {
  return workerPersistOpsRepoBootstrap(prisma, input);
}
