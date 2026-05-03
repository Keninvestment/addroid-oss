// AdDroid OSS — apps/worker LLM Provider wiring (Implementation item + regression fix).
//
// 単一の `selectLLMProviderForWorker` 経由で worker 内の AI ワークフロー
// (daily_report / 後続: budget_guard / improvement_pr) が同じ LLMProvider を
// 取得する。
//
// 選択ポリシー:
//   1. `ADDROID_LLM_MOCK=1` → MockLLMProvider (token を事前に注入し、
//      ローカル開発で daily_report の完全パイプラインを試せるようにする)。
//   2. それ以外:
//        - prisma が渡されていれば Prisma-backed store を使う (production 経路)。
//          Codex OAuth コールバックで保存された ciphertext + metadata を
//          `oauth_tokens` テーブルから読み出し、CodexLLMProvider に注入する。
//        - prisma が無ければ InMemoryLLMProviderTokenStore に倒し、Stub に落ちる
//          (CLI 単体実行や test bootstrap 用)。
//
// 設計原則:
//   - access_token / refresh_token は ciphertext のまま store に保存し、UI / log /
//     Error.message に平文を露出しない。`packages/config` の CryptoBoundary が
//     暗号化境界 (`v1.aes256gcm.iv.tag.payload` 形式) の唯一の入口。
//   - provider/model などの非機微メタは `oauth_tokens.metadata` (JSON 列) に置き、
//     UI 表示・request.model 省略時のフォールバックに使う。

import {
  InMemoryLLMProviderTokenStore,
  MockLLMProvider,
  selectLLMProvider,
  type CodexOAuthClientConfig,
  type LLMProvider,
  type LLMProviderChoice,
  type LLMProviderTokenRecord,
  type LLMProviderTokenStore,
} from "@addroid/llm-provider";
import { getCryptoBoundary, resolveWebBinding } from "@addroid/config";
import type { CryptoBoundary } from "@addroid/config";
import type { PrismaClient } from "@addroid/db";

/**
 * Prisma の `oauth_tokens` テーブルを裏に持つ `LLMProviderTokenStore`。
 *
 * Meta / GitHub の Prisma store と同じ encrypted boundary を共有する:
 *   - `accessTokenCiphertext` / `refreshTokenCiphertext` 列に ciphertext をそのまま保存。
 *   - provider 既定 model などの非機微メタは `metadata` JSON 列に置く
 *     (`{ "defaultModel": "gpt-4.1" }` 形式)。
 *
 * 書き込みは `provider+accountIdentifier` の unique 制約で upsert する。
 * 読み出しは `connectedAt` 降順の最新 1 行を返す (web で複数アカウントを切り替えた
 * 場合でも、worker 側は最後に接続されたものを採用する — Meta と同じ規約)。
 */
export function createPrismaLLMProviderTokenStore(
  prisma: PrismaClient
): LLMProviderTokenStore {
  return {
    async saveOAuthToken(record: LLMProviderTokenRecord): Promise<void> {
      const metadata = { defaultModel: record.defaultModel };
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
          metadata,
        },
        create: {
          provider: record.provider,
          accountIdentifier: record.accountIdentifier,
          scopes: record.scopes,
          accessTokenCiphertext: record.accessTokenCiphertext,
          refreshTokenCiphertext: record.refreshTokenCiphertext ?? null,
          expiresAt: record.expiresAt ?? null,
          connectedAt: record.connectedAt,
          metadata,
        },
      });
    },
    async loadOAuthToken(provider) {
      const row = await prisma.oAuthToken.findFirst({
        where: { provider },
        orderBy: { connectedAt: "desc" },
      });
      if (!row) return null;
      const defaultModel = extractDefaultModel(row.metadata);
      // defaultModel は LLMProviderTokenRecord 上で必須。ciphertext 行があるのに
      // metadata が壊れている = 不整合行なので、未接続として扱う (fail-closed)。
      if (!defaultModel) return null;
      const out: LLMProviderTokenRecord = {
        provider: row.provider as LLMProviderTokenRecord["provider"],
        accountIdentifier: row.accountIdentifier,
        scopes: row.scopes,
        accessTokenCiphertext: row.accessTokenCiphertext,
        connectedAt: row.connectedAt,
        defaultModel,
      };
      if (row.refreshTokenCiphertext !== null) {
        out.refreshTokenCiphertext = row.refreshTokenCiphertext;
      }
      if (row.expiresAt !== null) out.expiresAt = row.expiresAt;
      return out;
    },
    async deleteOAuthToken(provider) {
      const result = await prisma.oAuthToken.deleteMany({
        where: { provider },
      });
      return result.count > 0;
    },
  };
}

function extractDefaultModel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)["defaultModel"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface WorkerLLMProviderSelection {
  provider: LLMProvider;
  choice: LLMProviderChoice;
  reason: string;
}

export interface SelectLLMProviderForWorkerOptions {
  /** 渡されれば Prisma-backed token store を使う。未指定なら InMemory に倒れる。 */
  prisma?: PrismaClient;
}

/**
 * `ADDROID_CODEX_*` 系の env から `CodexOAuthClientConfig` を組み立てる。
 *
 * Codex CLI 互換 PKCE フロー (`tokenAuthMethod="pkce_s256"`) を既定とし、
 * `ADDROID_CODEX_CLIENT_SECRET` が与えられた場合は confidential client
 * (`tokenAuthMethod="client_secret_post"`) に切り替える。
 *
 * 必須キー (`clientId` / `authorizationUrl` / `tokenUrl`) のいずれかが未設定なら
 * `null` を返し、呼び出し側 (`selectLLMProviderForWorker`) は Stub に倒す
 * (fail-closed)。
 *
 * `redirectUri` は web binding から既定値を組み立てる (Meta runtime と同じ規約)。
 * Worker 自身は redirect を消費しないが、`CodexOAuthClientConfig` の必須項目で
 * あり、web 側の `/api/oauth/codex/callback` が完了後に worker が読む同じ
 * `oauth_tokens` 行に書き戻す。
 */
export function loadCodexLLMClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CodexOAuthClientConfig | null {
  const clientId = env.ADDROID_CODEX_CLIENT_ID?.trim();
  const authorizationUrl = env.ADDROID_CODEX_AUTHORIZATION_URL?.trim();
  const tokenUrl = env.ADDROID_CODEX_TOKEN_URL?.trim();
  if (!clientId || !authorizationUrl || !tokenUrl) return null;

  const binding = resolveWebBinding(env);
  const redirectUri =
    env.ADDROID_CODEX_OAUTH_REDIRECT_URI?.trim() ||
    `http://${binding.hostname}:${binding.port}/api/oauth/codex/callback`;

  const clientSecret = env.ADDROID_CODEX_CLIENT_SECRET?.trim();
  const tokenAuthMethod: CodexOAuthClientConfig["tokenAuthMethod"] = clientSecret
    ? "client_secret_post"
    : "pkce_s256";

  const scopesRaw = env.ADDROID_CODEX_SCOPES?.trim();
  const scopes = scopesRaw
    ? scopesRaw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  const out: CodexOAuthClientConfig = {
    clientId,
    redirectUri,
    authorizationUrl,
    tokenUrl,
    tokenAuthMethod,
  };
  if (clientSecret) out.clientSecret = clientSecret;
  if (scopes && scopes.length > 0) out.scopes = scopes;
  return out;
}

/**
 * `ENCRYPTION_KEY` が設定されていれば AES-256-GCM 暗号境界を返す。
 * 未設定 / 短すぎる場合は `null` を返し、呼び出し側は Stub に倒す。
 *
 * `getCryptoBoundary` は `CryptoNotConfiguredError` を throw するので、
 * Meta runtime の helper と同じく throw を吸収して null を返す。
 */
function tryGetCryptoBoundary(env: NodeJS.ProcessEnv): CryptoBoundary | null {
  try {
    return getCryptoBoundary(env);
  } catch {
    return null;
  }
}

export async function selectLLMProviderForWorker(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectLLMProviderForWorkerOptions = {}
): Promise<WorkerLLMProviderSelection> {
  const tokenStore: LLMProviderTokenStore = opts.prisma
    ? createPrismaLLMProviderTokenStore(opts.prisma)
    : new InMemoryLLMProviderTokenStore();
  if (env.ADDROID_LLM_MOCK === "1") {
    // Mock の `complete()` は事前に saveOAuthToken されている前提なので、
    // 本 helper が起動時に擬似 connect しておく。これによりローカル開発で
    // daily_report の AI 段階まで実際に走らせられる。
    const mock = new MockLLMProvider({ tokenStore });
    const begin = await mock.beginOAuth();
    await mock.completeOAuth({ code: "worker-bootstrap", state: begin.state });
    return {
      provider: mock,
      choice: "mock",
      reason: opts.prisma
        ? "ADDROID_LLM_MOCK=1 (worker auto-connected the mock provider over the Prisma-backed token store)"
        : "ADDROID_LLM_MOCK=1 (worker auto-connected the mock provider)",
    };
  }
  // Codex/OpenAI/Anthropic を production で使う場合、Prisma-backed token store が
  // 必須 (web の OAuth callback で保存された ciphertext + metadata を読む)。
  // regression fix: factory には codexClient + crypto + chatCompletionsUrl +
  //   defaultModel を全て渡す必要がある (どれか欠ければ Stub に倒れる)。
  //   web 側の `/api/oauth/codex/callback` が同じ env / `oauth_tokens` 行を共有
  //   する前提で、worker と web は同じ env から OAuth client config を組み立てる。
  // OAuth client config / chatCompletionsUrl / defaultModel が揃っていない間は
  // factory が StubLLMProvider に倒し、analyst runner が `status="failed"` の
  // ai_run を返す (snapshot は保存される — GitOps state は腐らない)。
  const codexClient = loadCodexLLMClientFromEnv(env);
  const crypto = tryGetCryptoBoundary(env);
  const chatCompletionsUrl = env.ADDROID_CODEX_CHAT_COMPLETIONS_URL?.trim() || null;
  const defaultModel = env.ADDROID_CODEX_DEFAULT_MODEL?.trim() || undefined;
  const selection = selectLLMProvider({
    env,
    tokenStore,
    codexClient,
    chatCompletionsUrl,
    ...(crypto ? { crypto } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  });
  const reason = opts.prisma
    ? `${selection.reason} (token store: prisma)`
    : `${selection.reason} (token store: in-memory)`;
  return {
    provider: selection.provider,
    choice: selection.choice,
    reason,
  };
}

