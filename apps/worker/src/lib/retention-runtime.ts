// AdDroid OSS — apps/worker performance_snapshots retention store wiring
// (Regression fix).
//
// `runPerformanceSnapshotRetentionOnce` (queue) が要求する 3 境界を Prisma で
// 実装する。queue パッケージは @addroid/db を直接 import しないため、本ファイルが
// PrismaClient を閉じ込めて store を組み立てる役割を担う。
//
// 契約上の保持要件:
//   - "raw" (= performance_snapshots.raw + nodeType in ('adset','ad') 行) は 90 日
//   - "campaign-or-higher" (= nodeType in ('account','campaign') 行) は 1 年
//
// 削除条件は metricDate (= 当該 KPI 行が代表する UTC 日付) ベース。createdAt は
// upsert タイミングで上書きされるため使わない。

import { Prisma, type PrismaClient } from "@addroid/db";
import type { PerformanceSnapshotRetentionStore } from "@addroid/queue";

export function createPrismaPerformanceSnapshotRetentionStore(
  prisma: PrismaClient
): PerformanceSnapshotRetentionStore {
  return {
    async clearStaleRawJson(olderThan) {
      // Prisma 5 の Json? 列 nullable filter: `Prisma.AnyNull` は SQL NULL と
      // JSON `null` の両方にマッチする。`not: Prisma.AnyNull` で「実値あり」の
      // 行のみを対象にし、すでに null の行を再書き込みしない。
      const result = await prisma.performanceSnapshot.updateMany({
        where: {
          metricDate: { lt: olderThan },
          raw: { not: Prisma.AnyNull },
        },
        data: { raw: Prisma.JsonNull },
      });
      return { updated: result.count };
    },

    async deleteStaleGranularSnapshots(olderThan) {
      const result = await prisma.performanceSnapshot.deleteMany({
        where: {
          metricDate: { lt: olderThan },
          nodeType: { in: ["adset", "ad"] },
        },
      });
      return { deleted: result.count };
    },

    async deleteStaleAggregatedSnapshots(olderThan) {
      const result = await prisma.performanceSnapshot.deleteMany({
        where: {
          metricDate: { lt: olderThan },
          nodeType: { in: ["account", "campaign"] },
        },
      });
      return { deleted: result.count };
    },
  };
}
