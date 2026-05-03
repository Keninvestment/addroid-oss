// AdDroid OSS — MetaInsightsCache ユニットテスト.
//
// Meta Marketing API レート制限戦略の一部として、Insights / list / get 系の
// 読み取り応答を per-account TTL でキャッシュし、同じ tick 内の重複呼び出しから
// x-business-use-case-usage の浪費を抑える。

import test from "node:test";
import assert from "node:assert/strict";
import {
  MetaInsightsCache,
  buildInsightsCacheKey,
} from "../insights-cache.js";

// ---------------------------------------------------------------------
// buildInsightsCacheKey
// ---------------------------------------------------------------------

test("buildInsightsCacheKey: scope + accountKey", () => {
  assert.equal(
    buildInsightsCacheKey({ scope: "campaigns_list", accountKey: "primary" }),
    "insights:campaigns_list:primary"
  );
});

test("buildInsightsCacheKey: scope + accountKey + query", () => {
  assert.equal(
    buildInsightsCacheKey({
      scope: "insights",
      accountKey: "primary",
      query: "campaign:cmp_1:30d",
    }),
    "insights:insights:primary:campaign:cmp_1:30d"
  );
});

test("buildInsightsCacheKey: sanitizes unsafe chars", () => {
  const k = buildInsightsCacheKey({
    scope: "ads list",
    accountKey: "acct/spaced",
  });
  assert.equal(k, "insights:ads-list:acct-spaced");
});

// ---------------------------------------------------------------------
// MetaInsightsCache.get — basic hit / miss
// ---------------------------------------------------------------------

test("get: cache miss runs fetcher and caches value", async () => {
  const now = { value: 1_000 };
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000, clock: () => now.value });
  let calls = 0;
  const v1 = await cache.get("k1", {
    fetch: async () => {
      calls++;
      return { ok: true };
    },
  });
  assert.deepEqual(v1, { ok: true });
  assert.equal(calls, 1);

  // Second call within TTL → cache hit, fetcher not called again.
  const v2 = await cache.get("k1", {
    fetch: async () => {
      calls++;
      return { ok: false };
    },
  });
  assert.deepEqual(v2, { ok: true });
  assert.equal(calls, 1);
  assert.equal(cache.size(), 1);
});

test("get: cache miss after TTL expiry re-runs fetcher", async () => {
  const now = { value: 0 };
  const cache = new MetaInsightsCache({ defaultTtlMs: 100, clock: () => now.value });
  let calls = 0;
  await cache.get("k", {
    fetch: async () => {
      calls++;
      return calls;
    },
  });
  // Advance past TTL
  now.value = 200;
  const v = await cache.get("k", {
    fetch: async () => {
      calls++;
      return calls;
    },
  });
  assert.equal(v, 2);
  assert.equal(calls, 2);
});

test("get: refresh=true bypasses existing entry but re-caches the new value", async () => {
  const now = { value: 0 };
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000, clock: () => now.value });
  let calls = 0;
  await cache.get("k", {
    fetch: async () => {
      calls++;
      return "v1";
    },
  });
  const v = await cache.get("k", {
    fetch: async () => {
      calls++;
      return "v2";
    },
    refresh: true,
  });
  assert.equal(v, "v2");
  assert.equal(calls, 2);
  // The refreshed value is now in cache; another get returns it without calling fetch.
  const v3 = await cache.get("k", {
    fetch: async () => {
      calls++;
      return "v3";
    },
  });
  assert.equal(v3, "v2");
  assert.equal(calls, 2);
});

test("get: bypass=true runs fetcher but does NOT write cache", async () => {
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000 });
  await cache.get("k", { fetch: async () => "cached" });
  const v = await cache.get("k", { fetch: async () => "live", bypass: true });
  assert.equal(v, "live");
  // cache untouched
  const v2 = await cache.get("k", { fetch: async () => "should not run" });
  assert.equal(v2, "cached");
});

test("get: failed fetch is NOT cached and is retried on next call", async () => {
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000 });
  let calls = 0;
  await assert.rejects(
    () =>
      cache.get("k", {
        fetch: async () => {
          calls++;
          throw new Error("network down");
        },
      }),
    /network down/
  );
  assert.equal(cache.size(), 0);
  // 2 回目: 再び fetcher が走り、今度は成功する
  const v = await cache.get("k", {
    fetch: async () => {
      calls++;
      return "ok";
    },
  });
  assert.equal(v, "ok");
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------
// In-flight dedupe
// ---------------------------------------------------------------------

test("get: concurrent gets for the same key share a single in-flight fetcher", async () => {
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000 });
  let calls = 0;
  let resolveFetch!: (v: number) => void;
  const fetcher = () =>
    new Promise<number>((r) => {
      calls++;
      resolveFetch = r;
    });
  const p1 = cache.get("k", { fetch: fetcher });
  const p2 = cache.get("k", { fetch: fetcher });
  const p3 = cache.get("k", { fetch: fetcher });
  assert.equal(calls, 1, "fetcher must be invoked exactly once for concurrent gets");
  resolveFetch(42);
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(c, 42);
});

// ---------------------------------------------------------------------
// invalidate / invalidateByPrefix / clear
// ---------------------------------------------------------------------

test("invalidate: removes a single key", async () => {
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000 });
  await cache.get("k1", { fetch: async () => 1 });
  await cache.get("k2", { fetch: async () => 2 });
  cache.invalidate("k1");
  assert.equal(cache.size(), 1);
  let calls = 0;
  await cache.get("k1", {
    fetch: async () => {
      calls++;
      return 99;
    },
  });
  assert.equal(calls, 1);
});

test("invalidateByPrefix: removes all matching keys", async () => {
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000 });
  await cache.get("insights:campaigns:primary", { fetch: async () => 1 });
  await cache.get("insights:campaigns:secondary", { fetch: async () => 2 });
  await cache.get("insights:adsets:primary", { fetch: async () => 3 });
  const removed = cache.invalidateByPrefix("insights:campaigns:");
  assert.equal(removed, 2);
  assert.equal(cache.size(), 1);
});

test("clear: empties the cache", async () => {
  const cache = new MetaInsightsCache();
  await cache.get("k1", { fetch: async () => 1 });
  await cache.get("k2", { fetch: async () => 2 });
  cache.clear();
  assert.equal(cache.size(), 0);
});

// ---------------------------------------------------------------------
// LRU-ish eviction
// ---------------------------------------------------------------------

test("eviction: maxEntries caps the cache size by FIFO", async () => {
  const cache = new MetaInsightsCache({ defaultTtlMs: 1_000, maxEntries: 2 });
  await cache.get("k1", { fetch: async () => 1 });
  await cache.get("k2", { fetch: async () => 2 });
  await cache.get("k3", { fetch: async () => 3 });
  assert.equal(cache.size(), 2);
  // k1 should have been evicted (FIFO). Re-fetching it triggers the fetcher.
  let calls = 0;
  await cache.get("k1", {
    fetch: async () => {
      calls++;
      return 11;
    },
  });
  assert.equal(calls, 1);
});
