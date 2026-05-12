import {
  toDateStringInTimeZone,
  type DailyReportInsightsProvider,
  type DailyReportInsightsRow,
  type DailyReportSnapshotStore,
  type JsonValue,
} from "@addroid/queue";

export interface ImprovementPrInsightsRefreshSummary {
  status: "succeeded" | "partial" | "failed";
  periodStart: string;
  periodEnd: string;
  priorPeriodStart: string;
  priorPeriodEnd: string;
  datesRequested: string[];
  datesSucceeded: string[];
  rowsUpserted: number;
  snapshotIds: string[];
  sources: string[];
  errors: string[];
}

export async function refreshLatestInsightsForManualImprovementPr(input: {
  accountId: string;
  accountKey: string;
  timeZone: string;
  insightsProvider: DailyReportInsightsProvider;
  store: DailyReportSnapshotStore;
  now?: Date;
}): Promise<ImprovementPrInsightsRefreshSummary> {
  const today = toDateStringInTimeZone(input.now ?? new Date(), input.timeZone);
  const periodEnd = today;
  const periodStart = addDateDays(periodEnd, -6);
  const priorPeriodEnd = addDateDays(periodStart, -1);
  const priorPeriodStart = addDateDays(priorPeriodEnd, -6);
  const datesRequested = enumerateDates(priorPeriodStart, periodEnd);
  const datesSucceeded: string[] = [];
  const snapshotIds: string[] = [];
  const sources = new Set<string>();
  const errors: string[] = [];
  let rowsUpserted = 0;

  for (const metricDate of datesRequested) {
    try {
      const insights = await input.insightsProvider.fetchInsights({
        accountKey: input.accountKey,
        metricDate,
        includePriorPeriod: false,
      });
      sources.add(insights.source);
      if (insights.source === "unavailable") {
        errors.push(
          `${metricDate}: ${insights.detail ?? "insights provider unavailable"}`
        );
        continue;
      }
      for (const row of insights.current) {
        const snap = await input.store.upsertPerformanceSnapshot({
          accountId: input.accountId,
          hierarchyId: row.hierarchyId ?? null,
          nodeType: row.nodeType,
          nodeKey: row.nodeKey,
          metricDate,
          impressions: row.impressions,
          clicks: row.clicks,
          spendMicros: row.spendMicros,
          conversions: row.conversions,
          source: insights.source,
          raw: insightsRowToRaw(row, {
            refreshReason: "manual_improvement_pr",
            sourceDetail: insights.detail ?? null,
          }),
        });
        snapshotIds.push(snap.id);
        rowsUpserted += 1;
      }
      datesSucceeded.push(metricDate);
      if (insights.detail?.includes("partial failure")) {
        errors.push(`${metricDate}: ${insights.detail}`);
      }
    } catch (err) {
      errors.push(`${metricDate}: ${(err as Error).message}`);
    }
  }

  const status =
    datesSucceeded.length === 0
      ? "failed"
      : errors.length > 0
        ? "partial"
        : "succeeded";
  return {
    status,
    periodStart,
    periodEnd,
    priorPeriodStart,
    priorPeriodEnd,
    datesRequested,
    datesSucceeded,
    rowsUpserted,
    snapshotIds,
    sources: [...sources],
    errors,
  };
}

function insightsRowToRaw(
  row: DailyReportInsightsRow,
  extra: { refreshReason: string; sourceDetail: string | null }
): JsonValue {
  return {
    nodeType: row.nodeType,
    nodeKey: row.nodeKey,
    displayName: row.displayName ?? null,
    spendMicros: row.spendMicros.toString(),
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    frequency:
      typeof row.frequency === "number" && Number.isFinite(row.frequency)
        ? row.frequency
        : null,
    refreshReason: extra.refreshReason,
    sourceDetail: extra.sourceDetail,
  };
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    dates.push(cursor);
    cursor = addDateDays(cursor, 1);
  }
  return dates;
}

function addDateDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
