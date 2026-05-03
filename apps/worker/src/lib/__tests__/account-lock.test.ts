// AdDroid OSS — apps/worker/src/lib/account-lock.ts unit test
//.
//
// 目的:
//   - `adAccountLockBigInt` が同一文字列に対して決定的に同じ BigInt を返し、
//     別文字列に対して異なる BigInt を返す (衝突しない) こと。
//   - `createPostgresAdAccountLockProvider` が `$transaction` の中で
//     `pg_advisory_xact_lock` を呼び、acquire 後に fn を実行し、release で
//     transaction を終端させる (= xact-lock の自動解放に乗る) こと。
//   - fn が throw しても transaction が終端し、provider が caller に再 throw
//     すること。

import test from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@addroid/db";
import {
  adAccountLockBigInt,
  createPostgresAdAccountLockProvider,
} from "../account-lock.js";

// ---------------------------------------------------------------------
// adAccountLockBigInt
// ---------------------------------------------------------------------

test("adAccountLockBigInt: 同一 lockKey からは決定的に同じ BigInt が返る", () => {
  const a = adAccountLockBigInt("ad_account:ws-1:acct-primary");
  const b = adAccountLockBigInt("ad_account:ws-1:acct-primary");
  assert.equal(a, b);
});

test("adAccountLockBigInt: 異なる lockKey からは異なる BigInt が返る", () => {
  const a = adAccountLockBigInt("ad_account:ws-1:acct-primary");
  const b = adAccountLockBigInt("ad_account:ws-1:acct-secondary");
  const c = adAccountLockBigInt("ad_account:ws-2:acct-primary");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test("adAccountLockBigInt: signed 64-bit BIGINT 範囲に収まる", () => {
  // signed BIGINT range: -2^63 .. 2^63 - 1
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  const samples = [
    "ad_account:ws-1:acct-primary",
    "ad_account:ws-1:acct-secondary",
    "ad_account:ws-2:acct-primary",
    "",
    "x".repeat(1024),
  ];
  for (const s of samples) {
    const v = adAccountLockBigInt(s);
    assert.ok(v >= min, `${s} -> ${v} < min`);
    assert.ok(v <= max, `${s} -> ${v} > max`);
  }
});

// ---------------------------------------------------------------------
// createPostgresAdAccountLockProvider — fake Prisma $transaction
// ---------------------------------------------------------------------

interface TransactionEvent {
  sql: string;
  params: unknown[];
}

interface FakeTxState {
  events: TransactionEvent[];
  txOpened: number;
  txClosed: number;
}

/**
 * Prisma の `$transaction(async (tx) => ...)` を最小限に擬似する fake。
 * 内部で 1 個の "session" を表すオブジェクトを cb に渡し、cb の return /
 * throw をそのまま伝播する。実際の DB / pg_advisory_xact_lock は呼ばないが、
 * cb が `tx.$queryRaw\`SELECT pg_advisory_xact_lock(...)\`` を実行したことを
 * 記録する。
 */
function makeFakePrisma(state: FakeTxState): PrismaClient {
  return {
    async $transaction<T>(
      cb: (tx: { $queryRaw: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]> }) => Promise<T>,
      _opts?: { maxWait?: number; timeout?: number }
    ): Promise<T> {
      state.txOpened += 1;
      try {
        const tx = {
          $queryRaw: async (
            strings: TemplateStringsArray,
            ...vals: unknown[]
          ): Promise<unknown[]> => {
            const sql = strings.join("?");
            state.events.push({ sql, params: vals });
            return [];
          },
        };
        const result = await cb(tx);
        return result;
      } finally {
        state.txClosed += 1;
      }
    },
  } as unknown as PrismaClient;
}

test("createPostgresAdAccountLockProvider: $transaction を開き pg_advisory_xact_lock を BigInt 引数で呼ぶ", async () => {
  const state: FakeTxState = { events: [], txOpened: 0, txClosed: 0 };
  const prisma = makeFakePrisma(state);
  const provider = createPostgresAdAccountLockProvider({ prisma });

  let fnRan = false;
  const result = await provider.withLock("ad_account:ws-1:acct-primary", async () => {
    fnRan = true;
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(fnRan, true);
  assert.equal(state.txOpened, 1, "exactly one transaction is opened");
  assert.equal(state.txClosed, 1, "the transaction is closed (lock auto-released)");
  assert.equal(state.events.length, 1);
  const ev = state.events[0]!;
  assert.match(ev.sql, /pg_advisory_xact_lock/);
  assert.equal(ev.params.length, 1);
  assert.equal(typeof ev.params[0], "bigint");
  assert.equal(
    ev.params[0],
    adAccountLockBigInt("ad_account:ws-1:acct-primary")
  );
});

test("createPostgresAdAccountLockProvider: fn が throw しても transaction が終端する", async () => {
  const state: FakeTxState = { events: [], txOpened: 0, txClosed: 0 };
  const prisma = makeFakePrisma(state);
  const provider = createPostgresAdAccountLockProvider({ prisma });

  await assert.rejects(
    () =>
      provider.withLock("ad_account:ws-1:acct-primary", async () => {
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(state.txOpened, 1);
  assert.equal(state.txClosed, 1, "transaction must close even on fn failure");
});

test("createPostgresAdAccountLockProvider: 同一プロセス内の同 key は in-process 段で直列化される (acquire 重複なし)", async () => {
  const state: FakeTxState = { events: [], txOpened: 0, txClosed: 0 };
  const prisma = makeFakePrisma(state);
  const provider = createPostgresAdAccountLockProvider({ prisma });

  const events: string[] = [];
  await Promise.all([
    provider.withLock("ad_account:ws-1:acct-primary", async () => {
      events.push("start:a");
      await new Promise((r) => setTimeout(r, 10));
      events.push("end:a");
    }),
    provider.withLock("ad_account:ws-1:acct-primary", async () => {
      events.push("start:b");
      events.push("end:b");
    }),
  ]);
  // 直列化: a が完了してから b が start する
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
  // tx は 2 回開かれて 2 回閉じる (= advisory lock も 2 回取る)
  assert.equal(state.txOpened, 2);
  assert.equal(state.txClosed, 2);
});

test("createPostgresAdAccountLockProvider: acquire 失敗 (advisory lock query が throw) を caller に伝播する", async () => {
  // $queryRaw を throw に倒した fake transaction
  const prisma = {
    async $transaction<T>(
      cb: (tx: { $queryRaw: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]> }) => Promise<T>
    ): Promise<T> {
      const tx = {
        $queryRaw: async (): Promise<unknown[]> => {
          throw new Error("connection lost");
        },
      };
      return cb(tx);
    },
  } as unknown as PrismaClient;
  const acquireErrors: Array<{ key: string; err: unknown }> = [];
  const provider = createPostgresAdAccountLockProvider({
    prisma,
    onAcquireError: (key, err) => acquireErrors.push({ key, err }),
  });
  await assert.rejects(
    () => provider.withLock("ad_account:ws-1:acct-primary", async () => "ok"),
    /connection lost/
  );
  assert.equal(acquireErrors.length, 1);
  assert.equal(acquireErrors[0]!.key, "ad_account:ws-1:acct-primary");
});
