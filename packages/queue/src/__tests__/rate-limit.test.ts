// AdDroid OSS — rate-limit module ユニットテスト.
//
// pg-boss / Prisma / Meta CLI を起動せず、純粋関数 + in-process mutex の挙動を
// 検証する。the current implementation 受入要件 "Rate limiting enforces ad_account-level
// concurrency of 1 and backs off on configured Meta error classes" を直接覆う。

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_META_RATE_LIMIT_POLICY,
  buildAdAccountLockKey,
  buildApplySingletonKey,
  classifyThrottleSeverity,
  computeBackoffDelayMs,
  createCrossProcessAdAccountLockProvider,
  createInProcessAdAccountLockProvider,
  extractThrottleObservation,
  withAccountLock,
} from "../rate-limit.js";

// ---------------------------------------------------------------------
// computeBackoffDelayMs
// ---------------------------------------------------------------------

test("computeBackoffDelayMs: default policy yields 5s/10s/20s for attempts 1/2/3", () => {
  assert.equal(computeBackoffDelayMs(1), 5_000);
  assert.equal(computeBackoffDelayMs(2), 10_000);
  assert.equal(computeBackoffDelayMs(3), 20_000);
  assert.equal(computeBackoffDelayMs(4), 40_000);
  // exponential capped at maxBackoffMs (60s by default)
  assert.equal(computeBackoffDelayMs(5), 60_000);
  assert.equal(computeBackoffDelayMs(99), 60_000);
});

test("computeBackoffDelayMs: zero/negative/non-finite attempt resolves to 0ms (no-op sleep)", () => {
  assert.equal(computeBackoffDelayMs(0), 0);
  assert.equal(computeBackoffDelayMs(-1), 0);
  assert.equal(computeBackoffDelayMs(Number.NaN), 0);
});

test("computeBackoffDelayMs: respects custom policy", () => {
  const policy = {
    maxAttempts: 5,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    factor: 3,
  } as const;
  assert.equal(computeBackoffDelayMs(1, policy), 100);
  assert.equal(computeBackoffDelayMs(2, policy), 300);
  assert.equal(computeBackoffDelayMs(3, policy), 900);
  // 100 * 3^3 = 2700 → capped to 1000
  assert.equal(computeBackoffDelayMs(4, policy), 1_000);
});

test("DEFAULT_META_RATE_LIMIT_POLICY: matches the cli-runner retry_with_backoff defaults", () => {
  assert.equal(DEFAULT_META_RATE_LIMIT_POLICY.maxAttempts, 3);
  assert.equal(DEFAULT_META_RATE_LIMIT_POLICY.initialBackoffMs, 5_000);
  assert.equal(DEFAULT_META_RATE_LIMIT_POLICY.maxBackoffMs, 60_000);
  assert.equal(DEFAULT_META_RATE_LIMIT_POLICY.factor, 2);
});

// ---------------------------------------------------------------------
// buildApplySingletonKey
// ---------------------------------------------------------------------

test("buildApplySingletonKey: PR id only", () => {
  assert.equal(
    buildApplySingletonKey({ pullRequestId: "pr-123" }),
    "apply:pr-pr-123"
  );
});

test("buildApplySingletonKey: PR + accountKey", () => {
  assert.equal(
    buildApplySingletonKey({ pullRequestId: "pr-123", accountKey: "primary" }),
    "apply:pr-pr-123:acct-primary"
  );
});

test("buildApplySingletonKey: sanitizes non-ASCII / unsafe chars to '-'", () => {
  const k = buildApplySingletonKey({
    pullRequestId: "pr/abc def",
    accountKey: "Acct With Space",
  });
  assert.equal(k, "apply:pr-pr-abc-def:acct-Acct-With-Space");
});

test("buildApplySingletonKey: empty pullRequestId resolves to '_' segment without crashing", () => {
  // 呼び出し側のバグでも build は通り、pg-boss に意味のある (一意ではない) key を渡す
  assert.equal(buildApplySingletonKey({ pullRequestId: "" }), "apply:pr-_");
});

// ---------------------------------------------------------------------
// classifyThrottleSeverity
// ---------------------------------------------------------------------

test("classifyThrottleSeverity: null/empty headers → normal", () => {
  assert.equal(classifyThrottleSeverity(null), "normal");
  assert.equal(classifyThrottleSeverity(undefined), "normal");
  assert.equal(classifyThrottleSeverity({}), "normal");
});

test("classifyThrottleSeverity: <80% → normal", () => {
  const headers = {
    appUsage: JSON.stringify({ call_count: 50, total_cputime: 30, total_time: 40 }),
  };
  assert.equal(classifyThrottleSeverity(headers), "normal");
});

test("classifyThrottleSeverity: 80%-94% → approaching", () => {
  const headers = {
    appUsage: JSON.stringify({ call_count: 85 }),
  };
  assert.equal(classifyThrottleSeverity(headers), "approaching");
});

test("classifyThrottleSeverity: >=95% → throttled", () => {
  const headers = {
    appUsage: JSON.stringify({ call_count: 96 }),
  };
  assert.equal(classifyThrottleSeverity(headers), "throttled");
});

test("classifyThrottleSeverity: estimated_time_to_regain_access > 0 → backoff", () => {
  const headers = {
    businessUseCase: JSON.stringify({
      "1234567": [{ call_count: 50, estimated_time_to_regain_access: 60 }],
    }),
  };
  assert.equal(classifyThrottleSeverity(headers), "backoff");
});

test("classifyThrottleSeverity: nested business-use-case usage is walked", () => {
  const headers = {
    businessUseCase: JSON.stringify({
      "1": [{ type: "ads_management", call_count: 90, total_cputime: 40 }],
    }),
  };
  assert.equal(classifyThrottleSeverity(headers), "approaching");
});

test("classifyThrottleSeverity: malformed JSON falls back to text-pattern detection", () => {
  const headers = { appUsage: "estimated_time_to_regain_access: 5" };
  assert.equal(classifyThrottleSeverity(headers), "backoff");
});

// ---------------------------------------------------------------------
// extractThrottleObservation
// ---------------------------------------------------------------------

test("extractThrottleObservation: returns null when payload has no throttleHeaders", () => {
  assert.equal(extractThrottleObservation(undefined), null);
  assert.equal(extractThrottleObservation({}), null);
  assert.equal(extractThrottleObservation({ other: 1 }), null);
});

test("extractThrottleObservation: ignores payload with throttleHeaders=null", () => {
  assert.equal(extractThrottleObservation({ throttleHeaders: null }), null);
});

test("extractThrottleObservation: returns severity + raw header strings", () => {
  const obs = extractThrottleObservation({
    throttleHeaders: {
      businessUseCase: JSON.stringify({
        "1": [{ call_count: 96 }],
      }),
      appUsage: JSON.stringify({ call_count: 10 }),
    },
  });
  assert.ok(obs);
  assert.equal(obs!.severity, "throttled");
  assert.equal(typeof obs!.businessUseCase, "string");
  assert.equal(typeof obs!.appUsage, "string");
  assert.equal(obs!.adAccountUsage, undefined);
});

// ---------------------------------------------------------------------
// withAccountLock (in-process per-account concurrency=1)
// ---------------------------------------------------------------------

test("withAccountLock: serializes concurrent calls for the same accountId", async () => {
  const registry = new Map<string, Promise<unknown>>();
  const events: string[] = [];
  const job = (label: string, durationMs: number) =>
    withAccountLock(
      "acct-shared",
      async () => {
        events.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, durationMs));
        events.push(`end:${label}`);
      },
      registry
    );
  await Promise.all([job("a", 20), job("b", 5), job("c", 1)]);
  assert.deepEqual(events, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
});

test("withAccountLock: different accountIds run concurrently", async () => {
  const registry = new Map<string, Promise<unknown>>();
  const events: string[] = [];
  const job = (account: string) =>
    withAccountLock(
      account,
      async () => {
        events.push(`start:${account}`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`end:${account}`);
      },
      registry
    );
  await Promise.all([job("acct-A"), job("acct-B"), job("acct-C")]);
  // 全 start が end より先に積まれる (= 並列)
  const startCount = events.filter((e) => e.startsWith("start:")).length;
  const endCount = events.filter((e) => e.startsWith("end:")).length;
  assert.equal(startCount, 3);
  assert.equal(endCount, 3);
  // 1 番目と 2 番目は別 account の start (並列実行された証拠)
  assert.ok(events[0]!.startsWith("start:"));
  assert.ok(events[1]!.startsWith("start:"));
});

test("withAccountLock: failure in one job does not block subsequent jobs on the same account", async () => {
  const registry = new Map<string, Promise<unknown>>();
  await assert.rejects(
    () =>
      withAccountLock(
        "acct-x",
        async () => {
          throw new Error("boom");
        },
        registry
      ),
    /boom/
  );
  const result = await withAccountLock(
    "acct-x",
    async () => "recovered",
    registry
  );
  assert.equal(result, "recovered");
});

// ---------------------------------------------------------------------
// buildAdAccountLockKey (canonical Apply/Activate lock identity)
// release readiness
// ---------------------------------------------------------------------

test("buildAdAccountLockKey: produces deterministic ASCII-safe key", () => {
  assert.equal(
    buildAdAccountLockKey({ workspaceId: "ws-1", accountKey: "primary" }),
    "ad_account:ws-ws-1:acct-primary"
  );
});

test("buildAdAccountLockKey: same (workspaceId, accountKey) yields the same key", () => {
  const a = buildAdAccountLockKey({ workspaceId: "ws-x", accountKey: "k1" });
  const b = buildAdAccountLockKey({ workspaceId: "ws-x", accountKey: "k1" });
  assert.equal(a, b);
});

test("buildAdAccountLockKey: different workspaces are isolated even with same accountKey", () => {
  const a = buildAdAccountLockKey({ workspaceId: "ws-a", accountKey: "primary" });
  const b = buildAdAccountLockKey({ workspaceId: "ws-b", accountKey: "primary" });
  assert.notEqual(a, b);
});

test("buildAdAccountLockKey: sanitizes unsafe characters to '-'", () => {
  assert.equal(
    buildAdAccountLockKey({
      workspaceId: "ws/with space",
      accountKey: "Acct With/Slash",
    }),
    "ad_account:ws-ws-with-space:acct-Acct-With-Slash"
  );
});

test("buildAdAccountLockKey: serializes Apply (accountKey) and Activate (workspaceId+accountKey) to the same identity", () => {
  // Apply 経路は (workspaceId, plan.accountKey) を、Activate 経路は
  // (node.workspaceId, node.accountKey) を canonical key に渡す。両方が同じ
  // 文字列を返すことが本 task の核となる不変条件。
  const fromApply = buildAdAccountLockKey({
    workspaceId: "workspace-uuid",
    accountKey: "primary",
  });
  const fromActivate = buildAdAccountLockKey({
    workspaceId: "workspace-uuid",
    accountKey: "primary",
  });
  assert.equal(fromApply, fromActivate);
});

// ---------------------------------------------------------------------
// AdAccountLockProvider — cross-process serialization 境界
// release readiness
// ---------------------------------------------------------------------

test("createInProcessAdAccountLockProvider: 同一 key の concurrent withLock を直列化する", async () => {
  const provider = createInProcessAdAccountLockProvider();
  const events: string[] = [];
  const job = (label: string, durationMs: number) =>
    provider.withLock("ad_account:ws-x:acct-primary", async () => {
      events.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, durationMs));
      events.push(`end:${label}`);
    });
  await Promise.all([job("a", 15), job("b", 5), job("c", 1)]);
  assert.deepEqual(events, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
});

test("createInProcessAdAccountLockProvider: 異なる key 同士は並行に走る", async () => {
  const provider = createInProcessAdAccountLockProvider();
  const events: string[] = [];
  const job = (key: string, label: string) =>
    provider.withLock(key, async () => {
      events.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${label}`);
    });
  await Promise.all([
    job("ad_account:ws-x:acct-A", "a"),
    job("ad_account:ws-x:acct-B", "b"),
  ]);
  assert.equal(events.filter((e) => e.startsWith("start:")).length, 2);
  // 並行実行: 1 番目と 2 番目は両方 start
  assert.ok(events[0]!.startsWith("start:"));
  assert.ok(events[1]!.startsWith("start:"));
});

test("createCrossProcessAdAccountLockProvider: acquire は lockKey ごとに 1 度ずつ呼ばれる (in-process 段で同 key を直列化)", async () => {
  const acquireOrder: string[] = [];
  const releaseOrder: string[] = [];
  const provider = createCrossProcessAdAccountLockProvider({
    acquire: async (lockKey) => {
      acquireOrder.push(lockKey);
      return {
        release: async () => {
          releaseOrder.push(lockKey);
        },
      };
    },
  });
  const events: string[] = [];
  const job = (label: string, durationMs: number) =>
    provider.withLock("ad_account:ws-x:acct-primary", async () => {
      events.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, durationMs));
      events.push(`end:${label}`);
    });
  await Promise.all([job("a", 10), job("b", 1)]);
  // 同 key で 2 回呼ばれる: 旧実装の Map 単段直列化と異なり、cross-process
  // 段でも 1 回ずつ acquire/release される (= 別プロセスから来た重複要求と
  // 同じ semantics)。
  assert.equal(acquireOrder.length, 2);
  assert.equal(releaseOrder.length, 2);
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
});

test("createCrossProcessAdAccountLockProvider: acquire が hold して release しないと後続 withLock は待たされる (cross-process simulation)", async () => {
  // 別プロセスが lock を保持していると acquire が late resolve するシナリオ。
  // local 側の withLock が cross-process gate を待ってから fn を実行することを
  // 検証する。
  let externalRelease!: () => void;
  const externalHeld = new Promise<void>((resolve) => {
    externalRelease = resolve;
  });
  let acquireCount = 0;
  const provider = createCrossProcessAdAccountLockProvider({
    acquire: async (_lockKey) => {
      acquireCount += 1;
      // 1 回目だけ external held を待ってから resolve する。
      if (acquireCount === 1) {
        await externalHeld;
      }
      return { release: async () => {} };
    },
  });
  const events: string[] = [];
  const callPromise = provider.withLock("ad_account:ws-x:acct-primary", async () => {
    events.push("inside-fn");
  });

  // 50ms 待っても fn は実行されないはず (acquire が pending)。
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(events, []);

  // external が release すれば acquire が resolve し、fn が走る。
  externalRelease();
  await callPromise;
  assert.deepEqual(events, ["inside-fn"]);
});

test("createCrossProcessAdAccountLockProvider: fn が throw しても release は呼ばれる", async () => {
  let releaseCount = 0;
  const provider = createCrossProcessAdAccountLockProvider({
    acquire: async () => ({
      release: async () => {
        releaseCount += 1;
      },
    }),
  });
  await assert.rejects(
    () =>
      provider.withLock("ad_account:ws-x:acct-primary", async () => {
        throw new Error("fn failed");
      }),
    /fn failed/
  );
  assert.equal(releaseCount, 1);
});

test("createCrossProcessAdAccountLockProvider: release が throw しても fn の結果は返り、後続 withLock は進む", async () => {
  const releaseErrors: Array<{ key: string; err: unknown }> = [];
  const provider = createCrossProcessAdAccountLockProvider({
    acquire: async () => ({
      release: async () => {
        throw new Error("release failed");
      },
    }),
    onReleaseError: (key, err) => releaseErrors.push({ key, err }),
  });
  // 1 回目: 結果は通常通り返る (release エラーは握りつぶされる)
  const r1 = await provider.withLock("ad_account:ws-x:acct-1", async () => "ok");
  assert.equal(r1, "ok");
  // 2 回目: 1 回目の release エラーで in-process registry が壊れていないこと
  const r2 = await provider.withLock("ad_account:ws-x:acct-1", async () => "ok2");
  assert.equal(r2, "ok2");
  assert.equal(releaseErrors.length, 2);
  assert.equal(releaseErrors[0]!.key, "ad_account:ws-x:acct-1");
});
