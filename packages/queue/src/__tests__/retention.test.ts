// AdDroid OSS — performance_snapshots retention sweeper tests.
//
// pg-boss / Prisma を一切起動せず、`runPerformanceSnapshotRetentionOnce` の
// 純粋オーケストレーションを in-memory fake で検証する。

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RETENTION_POLICY,
  runPerformanceSnapshotRetentionOnce,
  type PerformanceSnapshotRetentionStore,
} from "../index.js";

class FakeRetentionStore implements PerformanceSnapshotRetentionStore {
  rawCalls: Date[] = [];
  granularCalls: Date[] = [];
  aggregatedCalls: Date[] = [];

  rawUpdated = 0;
  granularDeleted = 0;
  aggregatedDeleted = 0;

  rawError: Error | null = null;
  granularError: Error | null = null;
  aggregatedError: Error | null = null;

  async clearStaleRawJson(olderThan: Date): Promise<{ updated: number }> {
    this.rawCalls.push(olderThan);
    if (this.rawError) throw this.rawError;
    return { updated: this.rawUpdated };
  }
  async deleteStaleGranularSnapshots(
    olderThan: Date
  ): Promise<{ deleted: number }> {
    this.granularCalls.push(olderThan);
    if (this.granularError) throw this.granularError;
    return { deleted: this.granularDeleted };
  }
  async deleteStaleAggregatedSnapshots(
    olderThan: Date
  ): Promise<{ deleted: number }> {
    this.aggregatedCalls.push(olderThan);
    if (this.aggregatedError) throw this.aggregatedError;
    return { deleted: this.aggregatedDeleted };
  }
}

const FIXED_NOW = new Date("2026-05-02T12:00:00.000Z");

test("DEFAULT_RETENTION_POLICY matches the contract (90d raw / 365d aggregate)", () => {
  assert.equal(DEFAULT_RETENTION_POLICY.rawDays, 90);
  assert.equal(DEFAULT_RETENTION_POLICY.aggregateDays, 365);
});

test("runPerformanceSnapshotRetentionOnce — succeeds with default cutoffs", async () => {
  const store = new FakeRetentionStore();
  store.rawUpdated = 12;
  store.granularDeleted = 7;
  store.aggregatedDeleted = 3;

  const summary = await runPerformanceSnapshotRetentionOnce({
    store,
    now: () => FIXED_NOW,
  });

  assert.equal(summary.status, "succeeded");
  assert.equal(summary.policy.rawDays, 90);
  assert.equal(summary.policy.aggregateDays, 365);

  // raw + granular share the 90-day cutoff
  const ninetyDaysAgo = new Date(
    FIXED_NOW.getTime() - 90 * 86_400_000
  ).toISOString();
  const yearAgo = new Date(
    FIXED_NOW.getTime() - 365 * 86_400_000
  ).toISOString();
  assert.equal(summary.rawCutoff, ninetyDaysAgo);
  assert.equal(summary.aggregateCutoff, yearAgo);

  assert.equal(store.rawCalls.length, 1);
  assert.equal(store.granularCalls.length, 1);
  assert.equal(store.aggregatedCalls.length, 1);
  assert.equal(store.rawCalls[0]?.toISOString(), ninetyDaysAgo);
  assert.equal(store.granularCalls[0]?.toISOString(), ninetyDaysAgo);
  assert.equal(store.aggregatedCalls[0]?.toISOString(), yearAgo);

  assert.deepEqual(summary.rawCleared, { affected: 12, error: null });
  assert.deepEqual(summary.granularDeleted, { affected: 7, error: null });
  assert.deepEqual(summary.aggregatedDeleted, { affected: 3, error: null });
});

test("runPerformanceSnapshotRetentionOnce — overrides policy days", async () => {
  const store = new FakeRetentionStore();
  const summary = await runPerformanceSnapshotRetentionOnce({
    store,
    policy: { rawDays: 30, aggregateDays: 180 },
    now: () => FIXED_NOW,
  });
  assert.equal(summary.policy.rawDays, 30);
  assert.equal(summary.policy.aggregateDays, 180);
  assert.equal(
    summary.rawCutoff,
    new Date(FIXED_NOW.getTime() - 30 * 86_400_000).toISOString()
  );
  assert.equal(
    summary.aggregateCutoff,
    new Date(FIXED_NOW.getTime() - 180 * 86_400_000).toISOString()
  );
});

test("runPerformanceSnapshotRetentionOnce — partial failure isolates errors", async () => {
  const store = new FakeRetentionStore();
  store.rawUpdated = 5;
  store.aggregatedDeleted = 2;
  store.granularError = new Error("connection terminated");

  const summary = await runPerformanceSnapshotRetentionOnce({
    store,
    now: () => FIXED_NOW,
  });

  assert.equal(summary.status, "partial_failure");
  assert.equal(summary.rawCleared.affected, 5);
  assert.equal(summary.rawCleared.error, null);
  assert.equal(summary.granularDeleted.affected, 0);
  assert.equal(summary.granularDeleted.error, "connection terminated");
  assert.equal(summary.aggregatedDeleted.affected, 2);
  assert.equal(summary.aggregatedDeleted.error, null);
});

test("runPerformanceSnapshotRetentionOnce — all-failed surfaces failed status", async () => {
  const store = new FakeRetentionStore();
  store.rawError = new Error("e1");
  store.granularError = new Error("e2");
  store.aggregatedError = new Error("e3");

  const summary = await runPerformanceSnapshotRetentionOnce({
    store,
    now: () => FIXED_NOW,
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.rawCleared.error, "e1");
  assert.equal(summary.granularDeleted.error, "e2");
  assert.equal(summary.aggregatedDeleted.error, "e3");
});

test("runPerformanceSnapshotRetentionOnce — rejects non-positive policy days", async () => {
  const store = new FakeRetentionStore();
  await assert.rejects(
    () =>
      runPerformanceSnapshotRetentionOnce({
        store,
        policy: { rawDays: 0 },
        now: () => FIXED_NOW,
      }),
    /policy\.rawDays/
  );
  await assert.rejects(
    () =>
      runPerformanceSnapshotRetentionOnce({
        store,
        policy: { aggregateDays: -1 },
        now: () => FIXED_NOW,
      }),
    /policy\.aggregateDays/
  );
});
