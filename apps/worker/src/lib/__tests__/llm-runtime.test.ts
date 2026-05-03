// AdDroid OSS — apps/worker/src/lib/llm-runtime.ts unit test (regression fix).
//
// 目的:
//   - `createPrismaLLMProviderTokenStore` が `oauth_tokens` テーブルを upsert /
//     findFirst / deleteMany で正しく扱い、Codex の `defaultModel` を `metadata`
//     JSON 列に保存・復元できること (acceptance: provider/model metadata 永続化)。
//   - 平文 token が **絶対に** Store / 戻り値経由で漏れないこと
//     (constraint: encrypted boundary 経由のみ)。
//   - metadata が壊れている / 欠落している行は `loadOAuthToken` で null を返す
//     fail-closed 経路に乗ること。
//   - `selectLLMProviderForWorker` が prisma 注入時に Prisma-backed store を使い、
//     未注入時は InMemory に倒れること。

import test from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@addroid/db";
import type { LLMProviderTokenRecord } from "@addroid/llm-provider";

import { CodexLLMProvider } from "@addroid/llm-provider";

import {
  createPrismaLLMProviderTokenStore,
  loadCodexLLMClientFromEnv,
  selectLLMProviderForWorker,
} from "../llm-runtime.js";

// 32 byte base64 random — テスト中だけ ENCRYPTION_KEY を有効化するための定数。
// 本物の credential ではない。
const TEST_ENCRYPTION_KEY = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMA==";

// production Codex 経路を有効化するための完全な env セット。
function fullCodexEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ADDROID_CODEX_CLIENT_ID: "addroid-codex-cli",
    ADDROID_CODEX_AUTHORIZATION_URL: "https://auth.example.test/oauth/authorize",
    ADDROID_CODEX_TOKEN_URL: "https://auth.example.test/oauth/token",
    ADDROID_CODEX_CHAT_COMPLETIONS_URL:
      "https://api.example.test/v1/chat/completions",
    ADDROID_CODEX_DEFAULT_MODEL: "gpt-4.1",
    ...extra,
  } as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------
// Fake Prisma client — only the methods our store calls.
// ---------------------------------------------------------------------

interface OAuthTokenRow {
  provider: string;
  accountIdentifier: string;
  scopes: string[];
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string | null;
  expiresAt: Date | null;
  connectedAt: Date;
  metadata: unknown;
}

function makeFakePrisma(initial: OAuthTokenRow[] = []): {
  client: PrismaClient;
  rows: OAuthTokenRow[];
} {
  const rows: OAuthTokenRow[] = [...initial];
  const client = {
    oAuthToken: {
      async upsert({
        where,
        update,
        create,
      }: {
        where: {
          provider_accountIdentifier: {
            provider: string;
            accountIdentifier: string;
          };
        };
        update: Partial<OAuthTokenRow>;
        create: OAuthTokenRow;
      }) {
        const idx = rows.findIndex(
          (r) =>
            r.provider === where.provider_accountIdentifier.provider &&
            r.accountIdentifier ===
              where.provider_accountIdentifier.accountIdentifier
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx]!, ...update } as OAuthTokenRow;
          return rows[idx];
        }
        rows.push({ ...create });
        return rows[rows.length - 1];
      },
      async findFirst({
        where,
        orderBy,
      }: {
        where: { provider: string };
        orderBy?: { connectedAt: "desc" | "asc" };
      }) {
        const matches = rows.filter((r) => r.provider === where.provider);
        if (matches.length === 0) return null;
        const sorted = [...matches].sort((a, b) => {
          const cmp = a.connectedAt.getTime() - b.connectedAt.getTime();
          return orderBy?.connectedAt === "desc" ? -cmp : cmp;
        });
        return sorted[0] ?? null;
      },
      async deleteMany({ where }: { where: { provider: string } }) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]!.provider === where.provider) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  } as unknown as PrismaClient;
  return { client, rows };
}

// ---------------------------------------------------------------------
// createPrismaLLMProviderTokenStore — save / load round-trip
// ---------------------------------------------------------------------

test("createPrismaLLMProviderTokenStore.saveOAuthToken は ciphertext と defaultModel を upsert する", async () => {
  const { client, rows } = makeFakePrisma();
  const store = createPrismaLLMProviderTokenStore(client);
  const record: LLMProviderTokenRecord = {
    provider: "codex",
    accountIdentifier: "user@example.test",
    scopes: ["openai.completions"],
    accessTokenCiphertext: "v1.aes256gcm.iv.tag.access",
    refreshTokenCiphertext: "v1.aes256gcm.iv.tag.refresh",
    expiresAt: new Date("2026-06-01T00:00:00Z"),
    connectedAt: new Date("2026-05-02T10:00:00Z"),
    defaultModel: "gpt-4.1",
  };
  await store.saveOAuthToken(record);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.provider, "codex");
  assert.equal(row.accountIdentifier, "user@example.test");
  assert.deepEqual(row.scopes, ["openai.completions"]);
  assert.equal(row.accessTokenCiphertext, "v1.aes256gcm.iv.tag.access");
  assert.equal(row.refreshTokenCiphertext, "v1.aes256gcm.iv.tag.refresh");
  assert.equal(row.expiresAt?.toISOString(), "2026-06-01T00:00:00.000Z");
  // metadata 列に defaultModel が JSON で入る (provider/model 永続化)。
  assert.deepEqual(row.metadata, { defaultModel: "gpt-4.1" });
  // 平文 token が混入していないこと (constraint: encrypted boundary)。
  const dump = JSON.stringify(row);
  assert.equal(dump.includes("plaintext-access"), false);
  assert.equal(dump.includes("plaintext-refresh"), false);
});

test("createPrismaLLMProviderTokenStore.loadOAuthToken は defaultModel を含む最新行を返す", async () => {
  const older: OAuthTokenRow = {
    provider: "codex",
    accountIdentifier: "user-old@example.test",
    scopes: ["openai.completions"],
    accessTokenCiphertext: "v1.aes256gcm.older",
    refreshTokenCiphertext: null,
    expiresAt: null,
    connectedAt: new Date("2026-04-01T00:00:00Z"),
    metadata: { defaultModel: "gpt-4.0" },
  };
  const newer: OAuthTokenRow = {
    provider: "codex",
    accountIdentifier: "user-new@example.test",
    scopes: ["openai.completions", "openai.org.read"],
    accessTokenCiphertext: "v1.aes256gcm.newer",
    refreshTokenCiphertext: "v1.aes256gcm.newer.refresh",
    expiresAt: new Date("2026-07-01T00:00:00Z"),
    connectedAt: new Date("2026-05-01T00:00:00Z"),
    metadata: { defaultModel: "gpt-4.1" },
  };
  const { client } = makeFakePrisma([older, newer]);
  const store = createPrismaLLMProviderTokenStore(client);
  const got = await store.loadOAuthToken("codex");
  assert.ok(got);
  assert.equal(got!.accountIdentifier, "user-new@example.test");
  assert.equal(got!.accessTokenCiphertext, "v1.aes256gcm.newer");
  assert.equal(got!.refreshTokenCiphertext, "v1.aes256gcm.newer.refresh");
  assert.equal(got!.expiresAt?.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.deepEqual(got!.scopes, ["openai.completions", "openai.org.read"]);
  assert.equal(got!.defaultModel, "gpt-4.1");
});

test("createPrismaLLMProviderTokenStore.loadOAuthToken は token 行が無いとき null を返す", async () => {
  const { client } = makeFakePrisma();
  const store = createPrismaLLMProviderTokenStore(client);
  const got = await store.loadOAuthToken("codex");
  assert.equal(got, null);
});

test("createPrismaLLMProviderTokenStore.loadOAuthToken は metadata が壊れている行に null を返す (fail-closed)", async () => {
  const { client } = makeFakePrisma([
    {
      provider: "codex",
      accountIdentifier: "user@example.test",
      scopes: [],
      accessTokenCiphertext: "v1.aes256gcm.x",
      refreshTokenCiphertext: null,
      expiresAt: null,
      connectedAt: new Date(),
      metadata: null, // defaultModel 欠落 → 不整合行
    },
  ]);
  const store = createPrismaLLMProviderTokenStore(client);
  const got = await store.loadOAuthToken("codex");
  assert.equal(got, null);
});

test("createPrismaLLMProviderTokenStore.loadOAuthToken は metadata.defaultModel が string でない場合も null を返す", async () => {
  const { client } = makeFakePrisma([
    {
      provider: "codex",
      accountIdentifier: "user@example.test",
      scopes: [],
      accessTokenCiphertext: "v1.aes256gcm.x",
      refreshTokenCiphertext: null,
      expiresAt: null,
      connectedAt: new Date(),
      metadata: { defaultModel: 123 },
    },
  ]);
  const store = createPrismaLLMProviderTokenStore(client);
  const got = await store.loadOAuthToken("codex");
  assert.equal(got, null);
});

test("createPrismaLLMProviderTokenStore.saveOAuthToken は同一 provider+account を upsert (二重 insert にならない)", async () => {
  const { client, rows } = makeFakePrisma();
  const store = createPrismaLLMProviderTokenStore(client);
  const base: LLMProviderTokenRecord = {
    provider: "codex",
    accountIdentifier: "user@example.test",
    scopes: [],
    accessTokenCiphertext: "v1.aes256gcm.first",
    refreshTokenCiphertext: null,
    connectedAt: new Date("2026-05-02T10:00:00Z"),
    defaultModel: "gpt-4.1",
  };
  await store.saveOAuthToken(base);
  await store.saveOAuthToken({
    ...base,
    accessTokenCiphertext: "v1.aes256gcm.second",
    defaultModel: "gpt-4.1-mini",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.accessTokenCiphertext, "v1.aes256gcm.second");
  assert.deepEqual(rows[0]!.metadata, { defaultModel: "gpt-4.1-mini" });
});

test("createPrismaLLMProviderTokenStore.deleteOAuthToken は該当 provider 行を消し true を返す", async () => {
  const { client, rows } = makeFakePrisma([
    {
      provider: "codex",
      accountIdentifier: "user@example.test",
      scopes: [],
      accessTokenCiphertext: "v1.aes256gcm.x",
      refreshTokenCiphertext: null,
      expiresAt: null,
      connectedAt: new Date(),
      metadata: { defaultModel: "gpt-4.1" },
    },
    {
      provider: "meta",
      accountIdentifier: "ad-account",
      scopes: [],
      accessTokenCiphertext: "v1.aes256gcm.meta",
      refreshTokenCiphertext: null,
      expiresAt: null,
      connectedAt: new Date(),
      metadata: null,
    },
  ]);
  const store = createPrismaLLMProviderTokenStore(client);
  const removed = await store.deleteOAuthToken("codex");
  assert.equal(removed, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provider, "meta"); // meta 行は残す (provider scoping)
});

test("createPrismaLLMProviderTokenStore.deleteOAuthToken は該当行が無いとき false を返す", async () => {
  const { client } = makeFakePrisma();
  const store = createPrismaLLMProviderTokenStore(client);
  const removed = await store.deleteOAuthToken("codex");
  assert.equal(removed, false);
});

// ---------------------------------------------------------------------
// selectLLMProviderForWorker — wiring
// ---------------------------------------------------------------------

test("selectLLMProviderForWorker: prisma 注入時は Prisma-backed store 経路 (reason に表記)", async () => {
  const { client } = makeFakePrisma();
  const sel = await selectLLMProviderForWorker(
    {} as NodeJS.ProcessEnv,
    { prisma: client }
  );
  // 既定 OAuth 設定が無い → Stub に倒れるが、reason に "prisma" マーカーが入る。
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /prisma/);
});

test("selectLLMProviderForWorker: prisma 未注入 (default) は InMemory 経路", async () => {
  const sel = await selectLLMProviderForWorker({} as NodeJS.ProcessEnv);
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /in-memory/);
});

test("selectLLMProviderForWorker: ADDROID_LLM_MOCK=1 + prisma 注入 → Mock + Prisma store", async () => {
  const { client, rows } = makeFakePrisma();
  const sel = await selectLLMProviderForWorker(
    { ADDROID_LLM_MOCK: "1" } as NodeJS.ProcessEnv,
    { prisma: client }
  );
  assert.equal(sel.choice, "mock");
  // Mock の auto-connect が Prisma 経由で実行され、`oauth_tokens` に
  // provider="mock" + metadata.defaultModel が永続化される。
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provider, "mock");
  assert.ok(
    rows[0]!.metadata &&
      typeof (rows[0]!.metadata as Record<string, unknown>).defaultModel ===
        "string"
  );
});

// ---------------------------------------------------------------------
// loadCodexLLMClientFromEnv — env-driven OAuth client config
// ---------------------------------------------------------------------

test("loadCodexLLMClientFromEnv: 必須 env 揃うと PKCE client config を返す", () => {
  const cfg = loadCodexLLMClientFromEnv(fullCodexEnv());
  assert.ok(cfg);
  assert.equal(cfg!.clientId, "addroid-codex-cli");
  assert.equal(cfg!.authorizationUrl, "https://auth.example.test/oauth/authorize");
  assert.equal(cfg!.tokenUrl, "https://auth.example.test/oauth/token");
  assert.equal(cfg!.tokenAuthMethod, "pkce_s256");
  assert.equal(cfg!.clientSecret, undefined);
  // redirectUri は web binding の既定値を採用する。
  assert.match(cfg!.redirectUri, /\/api\/oauth\/codex\/callback$/);
});

test("loadCodexLLMClientFromEnv: CLIENT_SECRET があれば confidential client に切替", () => {
  const cfg = loadCodexLLMClientFromEnv(
    fullCodexEnv({ ADDROID_CODEX_CLIENT_SECRET: "shhh" })
  );
  assert.ok(cfg);
  assert.equal(cfg!.tokenAuthMethod, "client_secret_post");
  assert.equal(cfg!.clientSecret, "shhh");
});

test("loadCodexLLMClientFromEnv: SCOPES env をパースして scopes に渡す", () => {
  const cfg = loadCodexLLMClientFromEnv(
    fullCodexEnv({ ADDROID_CODEX_SCOPES: "openai, offline_access" })
  );
  assert.ok(cfg);
  assert.deepEqual(Array.from(cfg!.scopes ?? []), ["openai", "offline_access"]);
});

test("loadCodexLLMClientFromEnv: REDIRECT_URI env が override される", () => {
  const cfg = loadCodexLLMClientFromEnv(
    fullCodexEnv({
      ADDROID_CODEX_OAUTH_REDIRECT_URI: "http://127.0.0.1:9999/cb",
    })
  );
  assert.ok(cfg);
  assert.equal(cfg!.redirectUri, "http://127.0.0.1:9999/cb");
});

test("loadCodexLLMClientFromEnv: 必須キーが欠けると null を返す (fail-closed)", () => {
  const baseline = fullCodexEnv();
  for (const key of [
    "ADDROID_CODEX_CLIENT_ID",
    "ADDROID_CODEX_AUTHORIZATION_URL",
    "ADDROID_CODEX_TOKEN_URL",
  ] as const) {
    const env = { ...baseline };
    delete env[key];
    assert.equal(
      loadCodexLLMClientFromEnv(env),
      null,
      `expected null when ${key} is missing`
    );
  }
});

// ---------------------------------------------------------------------
// selectLLMProviderForWorker — production Codex wiring (regression fix)
// ---------------------------------------------------------------------

test("selectLLMProviderForWorker: 全 env + ENCRYPTION_KEY + prisma → CodexLLMProvider", async () => {
  const { client } = makeFakePrisma();
  const sel = await selectLLMProviderForWorker(fullCodexEnv(), {
    prisma: client,
  });
  assert.equal(sel.choice, "codex");
  assert.ok(sel.provider instanceof CodexLLMProvider);
  assert.equal(sel.provider.defaultModel, "gpt-4.1");
  assert.match(sel.reason, /prisma/);
});

test("selectLLMProviderForWorker: ENCRYPTION_KEY 未設定 → Stub (crypto 欠落理由)", async () => {
  const { client } = makeFakePrisma();
  const env = fullCodexEnv();
  delete env.ENCRYPTION_KEY;
  const sel = await selectLLMProviderForWorker(env, { prisma: client });
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /crypto/);
});

test("selectLLMProviderForWorker: CHAT_COMPLETIONS_URL 未設定 → Stub", async () => {
  const { client } = makeFakePrisma();
  const env = fullCodexEnv();
  delete env.ADDROID_CODEX_CHAT_COMPLETIONS_URL;
  const sel = await selectLLMProviderForWorker(env, { prisma: client });
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /chatCompletionsUrl/);
});

test("selectLLMProviderForWorker: DEFAULT_MODEL 未設定 → Stub", async () => {
  const { client } = makeFakePrisma();
  const env = fullCodexEnv();
  delete env.ADDROID_CODEX_DEFAULT_MODEL;
  const sel = await selectLLMProviderForWorker(env, { prisma: client });
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /defaultModel/);
});

test("selectLLMProviderForWorker: CODEX env 不足 → Stub (codexClient 欠落)", async () => {
  const { client } = makeFakePrisma();
  const env = fullCodexEnv();
  delete env.ADDROID_CODEX_CLIENT_ID;
  const sel = await selectLLMProviderForWorker(env, { prisma: client });
  assert.equal(sel.choice, "stub");
  assert.match(sel.reason, /codexClient/);
});

test("selectLLMProviderForWorker: ADDROID_LLM_MOCK=1 は Codex env が揃っていても Mock を優先", async () => {
  const { client } = makeFakePrisma();
  const sel = await selectLLMProviderForWorker(
    fullCodexEnv({ ADDROID_LLM_MOCK: "1" }),
    { prisma: client }
  );
  assert.equal(sel.choice, "mock");
});
