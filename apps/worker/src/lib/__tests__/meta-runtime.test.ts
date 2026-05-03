// AdDroid OSS — apps/worker/src/lib/meta-runtime.ts unit test (regression fix).
//
// 目的:
//   - createPrismaMetaTokenStore が `oauth_tokens` テーブルを upsert / findFirst で
//     正しく扱い、provider != "meta" の問い合わせには null を返すこと。
//   - buildPrismaMetaAdapterSelection が OAuth 設定の有無で Real / Stub を切り替え、
//     `ADDROID_META_OAUTH_MOCK=1` で Mock に倒れること (CLI / web / worker が
//     共通利用するため、mode 切替が一貫して動くことが acceptance を支える)。
//   - production の `InMemoryMetaTokenStore` 経路廃止後でも、空 store + Stub adapter
//     の組み合わせは `loadAccessTokenPlaintext` が null を返し、後段で auth_error +
//     reauth notify として fail-closed する経路に乗ること (CliActivateExecutor に
//     委譲する側のコントラクトとして守っておく)。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type { PrismaClient } from "@addroid/db";
import type { MetaOAuthTokenRecord } from "@addroid/meta-adapter";
import { getCryptoBoundary } from "@addroid/config";

import {
  buildPrismaMetaAdapterSelection,
  createPrismaMetaTokenStore,
  loadMetaOAuthClientFromEnv,
} from "../meta-runtime.js";

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
    },
  } as unknown as PrismaClient;
  return { client, rows };
}

// ---------------------------------------------------------------------
// createPrismaMetaTokenStore
// ---------------------------------------------------------------------

test("createPrismaMetaTokenStore.saveOAuthToken は ciphertext + expiresAt を upsert する", async () => {
  const { client, rows } = makeFakePrisma();
  const store = createPrismaMetaTokenStore(client);
  const record: MetaOAuthTokenRecord = {
    provider: "meta",
    accountIdentifier: "primary-user",
    scopes: ["ads_management", "business_management"],
    accessTokenCiphertext: "v1.aes256gcm.iv.tag.payload",
    refreshTokenCiphertext: null,
    expiresAt: new Date("2026-06-01T00:00:00Z"),
    connectedAt: new Date("2026-05-02T10:00:00Z"),
  };
  await store.saveOAuthToken(record);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provider, "meta");
  assert.equal(rows[0]!.accountIdentifier, "primary-user");
  assert.deepEqual(rows[0]!.scopes, [
    "ads_management",
    "business_management",
  ]);
  assert.equal(rows[0]!.accessTokenCiphertext, "v1.aes256gcm.iv.tag.payload");
  assert.equal(rows[0]!.refreshTokenCiphertext, null);
  assert.equal(rows[0]!.expiresAt?.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("createPrismaMetaTokenStore.loadOAuthToken は connectedAt 降順で最新行を返す", async () => {
  const older: OAuthTokenRow = {
    provider: "meta",
    accountIdentifier: "primary-user",
    scopes: ["ads_management"],
    accessTokenCiphertext: "v1.aes256gcm.older",
    refreshTokenCiphertext: null,
    expiresAt: null,
    connectedAt: new Date("2026-04-01T00:00:00Z"),
  };
  const newer: OAuthTokenRow = {
    provider: "meta",
    accountIdentifier: "primary-user-2",
    scopes: ["ads_management", "business_management"],
    accessTokenCiphertext: "v1.aes256gcm.newer",
    refreshTokenCiphertext: null,
    expiresAt: new Date("2026-07-01T00:00:00Z"),
    connectedAt: new Date("2026-05-01T00:00:00Z"),
  };
  const { client } = makeFakePrisma([older, newer]);
  const store = createPrismaMetaTokenStore(client);
  const got = await store.loadOAuthToken("meta");
  assert.ok(got);
  assert.equal(got!.accessTokenCiphertext, "v1.aes256gcm.newer");
  assert.equal(got!.accountIdentifier, "primary-user-2");
  assert.equal(got!.expiresAt?.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("createPrismaMetaTokenStore.loadOAuthToken は meta 以外の provider に null を返す", async () => {
  const { client } = makeFakePrisma([
    {
      provider: "meta",
      accountIdentifier: "primary",
      scopes: [],
      accessTokenCiphertext: "v1.aes256gcm.x",
      refreshTokenCiphertext: null,
      expiresAt: null,
      connectedAt: new Date(),
    },
  ]);
  const store = createPrismaMetaTokenStore(client);
  // @ts-expect-error — runtime guard exists for non-meta providers.
  const got = await store.loadOAuthToken("github");
  assert.equal(got, null);
});

test("createPrismaMetaTokenStore.loadOAuthToken は token row が無いとき null を返す (CLI Activate fail-closed の前提)", async () => {
  const { client } = makeFakePrisma();
  const store = createPrismaMetaTokenStore(client);
  const got = await store.loadOAuthToken("meta");
  assert.equal(got, null);
});

// ---------------------------------------------------------------------
// loadMetaOAuthClientFromEnv
// ---------------------------------------------------------------------

async function tempHome(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addroid-meta-runtime-"));
  return { env: { ADDROID_HOME: dir }, dir };
}

test("loadMetaOAuthClientFromEnv は secrets が無ければ null を返す", async () => {
  const { env, dir } = await tempHome();
  try {
    const got = await loadMetaOAuthClientFromEnv(env);
    assert.equal(got, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// buildPrismaMetaAdapterSelection
// ---------------------------------------------------------------------

test("buildPrismaMetaAdapterSelection: ADDROID_META_OAUTH_MOCK=1 → Mock", async () => {
  const { client } = makeFakePrisma();
  const sel = await buildPrismaMetaAdapterSelection({
    prisma: client,
    env: { ADDROID_META_OAUTH_MOCK: "1" } as NodeJS.ProcessEnv,
  });
  assert.equal(sel.choice, "mock");
});

test("buildPrismaMetaAdapterSelection: OAuth 未設定 → Stub にフォールバック (loadAccessTokenPlaintext は null)", async () => {
  const { env, dir } = await tempHome();
  try {
    const { client } = makeFakePrisma();
    const sel = await buildPrismaMetaAdapterSelection({
      prisma: client,
      env,
    });
    assert.equal(sel.choice, "stub");
    // Stub adapter は token を持たないので loadAccessTokenPlaintext は null。
    // CLI Activate 経路はこの null を起点に MetaCliMissingTokenError → auth_error +
    // oauth.meta.reauth_required へ変換する (regression fix/012)。
    const lease = await sel.adapter.loadAccessTokenPlaintext();
    assert.equal(lease, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildPrismaMetaAdapterSelection: OAuth client + crypto 揃う → Real adapter (空 store でも load は null)", async () => {
  const { env, dir } = await tempHome();
  try {
    const encryptionKey = randomBytes(32).toString("base64");
    const appIdCiphertext = getCryptoBoundary({
      ...env,
      ENCRYPTION_KEY: encryptionKey,
    } as NodeJS.ProcessEnv).encrypt("100000000000001");
    const appSecretCiphertext = getCryptoBoundary({
      ...env,
      ENCRYPTION_KEY: encryptionKey,
    } as NodeJS.ProcessEnv).encrypt("shh-meta");
    // secrets.local.yaml に Meta OAuth client を書き込む
    await fs.writeFile(
      path.join(dir, "secrets.local.yaml"),
      `meta:\n  oauth:\n    appIdCiphertext: '${appIdCiphertext}'\n    appSecretCiphertext: '${appSecretCiphertext}'\n    permissions:\n      - ads_management\n      - business_management\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const { client } = makeFakePrisma();
    const sel = await buildPrismaMetaAdapterSelection({
      prisma: client,
      env: {
        ...env,
        ENCRYPTION_KEY: encryptionKey,
        // 127.0.0.1:3000 デフォルトを採用する binding 経路 (resolveWebBinding) は
        // 環境変数なしで通るため、ここでは追加設定不要。
      } as NodeJS.ProcessEnv,
    });
    assert.equal(sel.choice, "real");
    // 空 store なので、Real adapter の loadAccessTokenPlaintext も null を返す
    // (production で InMemoryMetaTokenStore を使っていたときと違い、CLI からも
    //  本物の Prisma を引いてくれる ⇒ token を入れれば見える、入っていなければ null)。
    const lease = await sel.adapter.loadAccessTokenPlaintext();
    assert.equal(lease, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
