import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMetaAdsReadOnlyRows,
  runMetaAdsReadOnlyQuery,
} from "../meta-ads-readonly-runtime.js";

test("extractMetaAdsReadOnlyRows keeps list-style array payloads", () => {
  assert.deepEqual(extractMetaAdsReadOnlyRows([{ id: "1" }, { id: "2" }]), [
    { id: "1" },
    { id: "2" },
  ]);
  assert.deepEqual(extractMetaAdsReadOnlyRows({ data: [{ id: "1" }] }), [{ id: "1" }]);
  assert.deepEqual(extractMetaAdsReadOnlyRows({ rows: [{ id: "2" }] }), [{ id: "2" }]);
  assert.deepEqual(extractMetaAdsReadOnlyRows({ results: [{ id: "3" }] }), [{ id: "3" }]);
});

test("extractMetaAdsReadOnlyRows treats get/current object payloads as one row", () => {
  assert.deepEqual(
    extractMetaAdsReadOnlyRows({
      id: "120228334025200756",
      creative: { id: "1740324726689527" },
    }),
    [
      {
        id: "120228334025200756",
        creative: { id: "1740324726689527" },
      },
    ]
  );
});

test("extractMetaAdsReadOnlyRows ignores empty or unparsable payloads", () => {
  assert.deepEqual(extractMetaAdsReadOnlyRows({}), []);
  assert.deepEqual(extractMetaAdsReadOnlyRows(null), []);
});

test("runMetaAdsReadOnlyQuery resolves local hierarchy IDs before Graph get", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalMock = process.env.ADDROID_META_OAUTH_MOCK;
  process.env.ADDROID_META_OAUTH_MOCK = "1";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer test-token");
    if (url.pathname.endsWith("/cmp_meta")) {
      return jsonResponse({
        id: "cmp_meta",
        name: "Active campaign",
        status: "ACTIVE",
        effective_status: "ACTIVE",
      });
    }
    return jsonResponse({ error: { message: "unexpected path" } }, 404);
  }) as typeof fetch;
  try {
    const result = await runMetaAdsReadOnlyQuery({
      prisma: fakeReadOnlyPrisma(),
      workspaceId: "ws",
      env: process.env,
      args: { resource: "campaign", action: "get", campaignId: "local-campaign" },
    });
    assert.equal(result.rowCount, 1);
    assert.deepEqual(calls, ["/v25.0/cmp_meta"]);
    assert.deepEqual(result.rows[0], {
      id: "cmp_meta",
      name: "Active campaign",
      status: "ACTIVE",
      effective_status: "ACTIVE",
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ADDROID_META_OAUTH_MOCK", originalMock);
  }
});

test("runMetaAdsReadOnlyQuery lists ads under a local adset ID and keeps nested creative", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalMock = process.env.ADDROID_META_OAUTH_MOCK;
  process.env.ADDROID_META_OAUTH_MOCK = "1";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(url.searchParams.get("fields")?.includes("creative{"), true);
    if (url.pathname.endsWith("/as_meta/ads")) {
      return jsonResponse({
        data: [
          {
            id: "ad_meta",
            name: "Existing ad",
            status: "ACTIVE",
            effective_status: "ACTIVE",
            creative: {
              id: "creative_meta",
              object_story_spec: {
                page_id: "281900655012835",
                instagram_user_id: "17841465387326763",
              },
            },
          },
        ],
      });
    }
    return jsonResponse({ error: { message: "unexpected path" } }, 404);
  }) as typeof fetch;
  try {
    const result = await runMetaAdsReadOnlyQuery({
      prisma: fakeReadOnlyPrisma(),
      workspaceId: "ws",
      env: process.env,
      args: { resource: "ad", action: "list", adsetId: "local-adset" },
    });
    assert.equal(result.rowCount, 1);
    assert.deepEqual(calls, ["/v25.0/as_meta/ads"]);
    assert.deepEqual((result.rows[0] as Record<string, unknown>).creative, {
      id: "creative_meta",
      object_story_spec: {
        page_id: "281900655012835",
        instagram_user_id: "17841465387326763",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ADDROID_META_OAUTH_MOCK", originalMock);
  }
});

test("runMetaAdsReadOnlyQuery reads ad creative detail from Graph", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalMock = process.env.ADDROID_META_OAUTH_MOCK;
  process.env.ADDROID_META_OAUTH_MOCK = "1";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/creative_meta")) {
      return jsonResponse({
        id: "creative_meta",
        name: "Existing creative",
        object_story_spec: {
          page_id: "281900655012835",
          instagram_user_id: "17841465387326763",
          link_data: {
            link: "https://example.com/lp",
            call_to_action: {
              type: "LEARN_MORE",
              value: { link: "https://example.com/lp" },
            },
          },
        },
      });
    }
    return jsonResponse({ error: { message: "unexpected path" } }, 404);
  }) as typeof fetch;
  try {
    const result = await runMetaAdsReadOnlyQuery({
      prisma: fakeReadOnlyPrisma(),
      workspaceId: "ws",
      env: process.env,
      args: { resource: "creative", action: "get", creativeId: "creative_meta" },
    });
    assert.equal(result.rowCount, 1);
    assert.deepEqual(calls, ["/v25.0/creative_meta"]);
    assert.deepEqual((result.rows[0] as Record<string, unknown>).object_story_spec, {
      page_id: "281900655012835",
      instagram_user_id: "17841465387326763",
      link_data: {
        link: "https://example.com/lp",
        call_to_action: {
          type: "LEARN_MORE",
          value: { link: "https://example.com/lp" },
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ADDROID_META_OAUTH_MOCK", originalMock);
  }
});

function fakeReadOnlyPrisma() {
  return {
    adAccount: {
      findFirst: async () => ({
        id: "db-account",
        key: "primary",
        metaAccountId: "123",
        active: true,
        workspaceId: "ws",
      }),
    },
    oAuthToken: {
      findFirst: async () => ({
        provider: "meta",
        accountIdentifier: "test",
        scopes: [],
        accessTokenCiphertext: "test-token",
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
    adsHierarchyNode: {
      findFirst: async (query: { where?: { nodeType?: string; OR?: Array<Record<string, string>> } }) => {
        const raw = query.where?.OR?.flatMap((item) => Object.values(item)).find((value) =>
          value === "local-campaign" || value === "local-adset" || value === "local-ad"
        );
        const externalId =
          raw === "local-campaign"
            ? "cmp_meta"
            : raw === "local-adset"
              ? "as_meta"
              : raw === "local-ad"
                ? "ad_meta"
                : null;
        return externalId ? { externalId } : null;
      },
    },
  } as any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
