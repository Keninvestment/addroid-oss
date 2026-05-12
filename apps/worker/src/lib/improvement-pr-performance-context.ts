import { toDateStringInTimeZone, type ImprovementPrAnalysisWindow } from "@addroid/queue";
import type { PrismaClient } from "@addroid/db";

export interface ImprovementPrPerformanceContext {
  snapshotIds: string[];
  analysisWindow: ImprovementPrAnalysisWindow;
}

interface PerformanceSnapshotMetricRow {
  id: string;
  nodeType: string;
  metricDate: Date;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
  createdAt: Date;
}

export async function loadRecentPerformanceSnapshotContext(
  prisma: PrismaClient,
  input: {
    accountId: string;
    timeZone: string;
    now?: Date;
    includeToday?: boolean;
  }
): Promise<ImprovementPrPerformanceContext> {
  const today = toDateStringInTimeZone(input.now ?? new Date(), input.timeZone);
  const periodEnd = input.includeToday ? today : addDateDays(today, -1);
  const periodStart = addDateDays(periodEnd, -6);
  const priorPeriodEnd = addDateDays(periodStart, -1);
  const priorPeriodStart = addDateDays(priorPeriodEnd, -6);
  const rows = await prisma.performanceSnapshot.findMany({
    where: {
      accountId: input.accountId,
      metricDate: {
        gte: dateOnlyUtc(priorPeriodStart),
        lte: dateOnlyUtc(periodEnd),
      },
    },
    select: {
      id: true,
      nodeType: true,
      metricDate: true,
      impressions: true,
      clicks: true,
      spendMicros: true,
      conversions: true,
      createdAt: true,
    },
    orderBy: [{ metricDate: "asc" }, { createdAt: "asc" }],
  });
  const currentRows = rows.filter((row) => {
    const metricDate = dateOnlyString(row.metricDate);
    return metricDate >= periodStart && metricDate <= periodEnd;
  });
  const priorRows = rows.filter((row) => {
    const metricDate = dateOnlyString(row.metricDate);
    return metricDate >= priorPeriodStart && metricDate <= priorPeriodEnd;
  });
  return {
    snapshotIds: currentRows.map((row) => row.id),
    analysisWindow: {
      periodStart,
      periodEnd,
      priorPeriodStart,
      priorPeriodEnd,
      current: aggregateSnapshotMetrics(currentRows),
      prior: aggregateSnapshotMetrics(priorRows),
    },
  };
}

function aggregateSnapshotMetrics(rows: PerformanceSnapshotMetricRow[]) {
  const selectedRows = selectNonOverlappingSnapshotRows(rows);
  let spendMicros = 0n;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  for (const row of selectedRows) {
    spendMicros += row.spendMicros;
    impressions += row.impressions;
    clicks += row.clicks;
    conversions += row.conversions;
  }
  const spend = Number(spendMicros) / 1_000_000;
  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
  };
}

function selectNonOverlappingSnapshotRows(rows: PerformanceSnapshotMetricRow[]) {
  for (const nodeType of ["account", "campaign", "adset", "ad"]) {
    const selected = rows.filter((row) => row.nodeType === nodeType);
    if (selected.length > 0) return selected;
  }
  return [];
}

function addDateDays(date: string, days: number): string {
  const d = dateOnlyUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return dateOnlyString(d);
}

function dateOnlyUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
