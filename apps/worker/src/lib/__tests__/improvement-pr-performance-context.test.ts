import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@addroid/db";
import { loadRecentPerformanceSnapshotContext } from "../improvement-pr-performance-context.js";

test("loadRecentPerformanceSnapshotContext uses yesterday-based 7d window and avoids double counting hierarchy levels", async () => {
  let queryArgs: unknown = null;
  const rows = [
    row("cur-account-1", "account", "2026-05-04", 1_000_000n, 100, 10, 1),
    row("cur-campaign-1", "campaign", "2026-05-04", 9_000_000n, 900, 90, 9),
    row("cur-account-2", "account", "2026-05-10", 2_000_000n, 200, 20, 2),
    row("prior-account-1", "account", "2026-05-03", 4_000_000n, 400, 40, 4),
    row("today-account", "account", "2026-05-11", 8_000_000n, 800, 80, 8),
  ];
  const prisma = {
    performanceSnapshot: {
      async findMany(args: unknown) {
        queryArgs = args;
        return rows;
      },
    },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.deepEqual(context.snapshotIds, [
    "cur-account-1",
    "cur-campaign-1",
    "cur-account-2",
  ]);
  assert.equal(context.analysisWindow.periodStart, "2026-05-04");
  assert.equal(context.analysisWindow.periodEnd, "2026-05-10");
  assert.equal(context.analysisWindow.priorPeriodStart, "2026-04-27");
  assert.equal(context.analysisWindow.priorPeriodEnd, "2026-05-03");
  assert.equal(context.analysisWindow.current.spend, 3);
  assert.equal(context.analysisWindow.current.impressions, 300);
  assert.equal(context.analysisWindow.current.clicks, 30);
  assert.equal(context.analysisWindow.current.conversions, 3);
  assert.equal(context.analysisWindow.prior?.spend, 4);
  assert.match(JSON.stringify(queryArgs), /2026-04-27T00:00:00.000Z/);
  assert.match(JSON.stringify(queryArgs), /2026-05-10T00:00:00.000Z/);
});

test("loadRecentPerformanceSnapshotContext can include today for manual improvement runs", async () => {
  let queryArgs: unknown = null;
  const prisma = {
    performanceSnapshot: {
      async findMany(args: unknown) {
        queryArgs = args;
        return [
          row("today-account", "account", "2026-05-11", 8_000_000n, 800, 80, 8),
          row("prior-account", "account", "2026-05-04", 2_000_000n, 200, 20, 2),
        ];
      },
    },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
    includeToday: true,
  });

  assert.deepEqual(context.snapshotIds, ["today-account"]);
  assert.equal(context.analysisWindow.periodStart, "2026-05-05");
  assert.equal(context.analysisWindow.periodEnd, "2026-05-11");
  assert.equal(context.analysisWindow.priorPeriodStart, "2026-04-28");
  assert.equal(context.analysisWindow.priorPeriodEnd, "2026-05-04");
  assert.equal(context.analysisWindow.current.spend, 8);
  assert.equal(context.analysisWindow.prior?.spend, 2);
  assert.match(JSON.stringify(queryArgs), /2026-04-28T00:00:00.000Z/);
  assert.match(JSON.stringify(queryArgs), /2026-05-11T00:00:00.000Z/);
});

function row(
  id: string,
  nodeType: string,
  metricDate: string,
  spendMicros: bigint,
  impressions: number,
  clicks: number,
  conversions: number
) {
  return {
    id,
    nodeType,
    metricDate: new Date(`${metricDate}T00:00:00.000Z`),
    spendMicros,
    impressions,
    clicks,
    conversions,
    createdAt: new Date(`${metricDate}T01:00:00.000Z`),
  };
}
