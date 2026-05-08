// AdDroid OSS — Daily Reports page (the current implementation browser regression fix).
//
// Browser test scenario `daily-report-analytics` は `/reports/daily` に直接
// アクセスし、(1) KPI フィールド spend/impressions/clicks/CTR/CPC/CV/CPA/
// frequency が表示される、(2) report run の状態または空状態が見える、
// (3) snapshot に裏付けられた analytics 状態または空状態が見える、ことを期待
// する。本ページは `cron_runs` (name="daily_report") と
// `performance_snapshots` を Prisma で直接読み出して描画する read-only な
// SSR ページ。実データが無い場合は ガードレール「No Placeholder Data」に従い
// 明示的な空状態 UI を出す。

import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { PageHeader } from "../../../components/ui/PageHeader";
import { DataTable, type DataTableColumn } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { KeyValueList, type KeyValueEntry } from "../../../components/ui/KeyValueList";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StatusDot, type StatusState } from "../../../components/ui/StatusDot";
import { InlineCode } from "../../../components/ui/CodeBlock";

export const dynamic = "force-dynamic";

interface KpiSet {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpa: number;
  cv: number;
  cpm: number;
  frequency: number | null;
}

interface ImprovementCandidate {
  hierarchy: string;
  target: string;
  rationale: string;
  expectedImpact: string;
}

interface DailyReportSummary {
  status: string;
  workspaceId: string;
  accountKey: string;
  accountId: string | null;
  currency: string | null;
  metricDate: string;
  priorMetricDate: string;
  insightsSource: string;
  current: KpiSet;
  prior: KpiSet;
  deltas: Record<string, string>;
  snapshotIds: string[];
  aiCommentary: string | null;
  topImprovements: ImprovementCandidate[];
  aiRunId: string | null;
  errorMessage?: string;
  mode: string;
}

interface CronRunRow {
  id: string;
  name: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

interface SnapshotRow {
  id: string;
  accountId: string;
  nodeType: string;
  nodeKey: string;
  metricDate: Date;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
  source: string;
  createdAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function readKpi(v: unknown): KpiSet {
  if (!isRecord(v)) {
    return {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpc: 0,
      cpa: 0,
      cv: 0,
      cpm: 0,
      frequency: null,
    };
  }
  return {
    spend: readNumber(v.spend),
    impressions: readNumber(v.impressions),
    clicks: readNumber(v.clicks),
    conversions: readNumber(v.conversions),
    ctr: readNumber(v.ctr),
    cpc: readNumber(v.cpc),
    cpa: readNumber(v.cpa),
    cv: readNumber(v.cv),
    cpm: readNumber(v.cpm),
    frequency: readNullableNumber(v.frequency),
  };
}

function parseDailyReportSummary(output: unknown): DailyReportSummary | null {
  if (!isRecord(output)) return null;
  // status / workspaceId / accountKey が欠ければ daily_report の output として扱わない。
  if (
    typeof output.status !== "string" ||
    typeof output.workspaceId !== "string" ||
    typeof output.accountKey !== "string"
  ) {
    return null;
  }
  const deltasRaw = isRecord(output.deltas) ? output.deltas : {};
  const deltas: Record<string, string> = {};
  for (const [k, v] of Object.entries(deltasRaw)) {
    if (typeof v === "string") deltas[k] = v;
  }
  const snapshotIds = Array.isArray(output.snapshotIds)
    ? output.snapshotIds.filter((x): x is string => typeof x === "string")
    : [];
  const topImprovements = Array.isArray(output.topImprovements)
    ? output.topImprovements
        .filter(isRecord)
        .map((row) => ({
          hierarchy: readString(row.hierarchy),
          target: readString(row.target),
          rationale: readString(row.rationale),
          expectedImpact: readString(row.expectedImpact),
        }))
    : [];
  return {
    status: output.status,
    workspaceId: output.workspaceId,
    accountKey: output.accountKey,
    accountId: typeof output.accountId === "string" ? output.accountId : null,
    currency: typeof output.currency === "string" ? output.currency : null,
    metricDate: readString(output.metricDate),
    priorMetricDate: readString(output.priorMetricDate),
    insightsSource: readString(output.insightsSource, "unavailable"),
    current: readKpi(output.current),
    prior: readKpi(output.prior),
    deltas,
    snapshotIds,
    aiCommentary:
      typeof output.aiCommentary === "string" ? output.aiCommentary : null,
    topImprovements,
    aiRunId: typeof output.aiRunId === "string" ? output.aiRunId : null,
    ...(typeof output.errorMessage === "string"
      ? { errorMessage: output.errorMessage }
      : {}),
    mode: readString(output.mode, "report_only"),
  };
}

function parseDailyReportSummaries(output: unknown): DailyReportSummary[] {
  if (isRecord(output) && Array.isArray(output.accounts)) {
    return output.accounts
      .map(parseDailyReportSummary)
      .filter((x): x is DailyReportSummary => x !== null);
  }
  const single = parseDailyReportSummary(output);
  return single ? [single] : [];
}

function cronStateToStatus(state: string): StatusState {
  switch (state) {
    case "success":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    default:
      return "idle";
  }
}

function reportSummaryStatusToState(status: string): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "no_account":
    case "no_insights":
      return "warn";
    case "ai_failed":
      return "error";
    default:
      return "idle";
  }
}

function modeToState(mode: string): StatusState {
  switch (mode) {
    case "auto_apply":
      return "warn";
    case "proposal":
      return "info";
    case "report_only":
    default:
      return "idle";
  }
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\..+$/, "Z");
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function microsToMajor(micros: bigint): number {
  const div = Number(micros / 1_000_000n);
  const rem = Number(micros % 1_000_000n) / 1_000_000;
  return div + rem;
}

function formatNumber(n: number, fractionDigits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatCurrency(n: number, currency: string | null): string {
  const amount = formatNumber(n, 2);
  return currency ? `${amount} ${currency}` : amount;
}

function formatPercent(n: number): string {
  return `${formatNumber(n, 2)}%`;
}

function formatFrequency(n: number | null): string {
  return n === null ? "—" : formatNumber(n, 2);
}

function formatDelta(value: string | undefined): string {
  return value && value.length > 0 ? value : "—";
}

interface KpiCellProps {
  label: string;
  value: string;
  delta: string;
  hint?: string;
}

function KpiCell({ label, value, delta, hint }: KpiCellProps) {
  return (
    <div className="kpi-cell">
      <div className="kpi-cell__label">{label}</div>
      <div
        className="kpi-cell__value tabular-nums"
        style={{ fontFamily: "var(--font-mono)", fontSize: "1.25rem", fontWeight: 600 }}
      >
        {value}
      </div>
      <div
        className="kpi-cell__delta tabular-nums"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.8125rem",
          color: "var(--color-text-secondary)",
        }}
      >
        Δ {delta}
      </div>
      {hint ? (
        <div
          className="kpi-cell__hint"
          style={{
            fontSize: "0.75rem",
            color: "var(--color-text-tertiary)",
            marginTop: "0.125rem",
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export default async function ReportsDailyPage() {
  let runs: CronRunRow[] = [];
  let snapshots: SnapshotRow[] = [];
  let dbReady = true;
  try {
    [runs, snapshots] = await Promise.all([
      prisma.cronRun.findMany({
        where: { name: "daily_report" },
        orderBy: { startedAt: "desc" },
        take: 25,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.performanceSnapshot.findMany({
        orderBy: [{ metricDate: "desc" }, { createdAt: "desc" }],
        take: 50,
        select: {
          id: true,
          accountId: true,
          nodeType: true,
          nodeKey: true,
          metricDate: true,
          impressions: true,
          clicks: true,
          spendMicros: true,
          conversions: true,
          source: true,
          createdAt: true,
        },
      }),
    ]);
  } catch {
    dbReady = false;
  }

  // 直近 succeeded run の output を拾う。なければ最新 run の output を拾う。
  const parsedSummaries = runs.flatMap((r) =>
    parseDailyReportSummaries(r.output).map((summary) => ({ run: r, summary }))
  );
  const latestSucceeded =
    parsedSummaries.find(({ summary }) => summary.status === "succeeded") ??
    parsedSummaries[0] ??
    null;

  const runsCount = runs.length;
  const snapshotsCount = snapshots.length;

  const kpiRows: { label: string; valueOf: (k: KpiSet) => string; deltaKey: string; hint?: string }[] = [
    {
      label: "Spend",
      valueOf: (k) => formatCurrency(k.spend, latestSucceeded?.summary.currency ?? null),
      deltaKey: "spend",
    },
    { label: "Impressions", valueOf: (k) => formatNumber(k.impressions), deltaKey: "impressions" },
    { label: "Clicks", valueOf: (k) => formatNumber(k.clicks), deltaKey: "clicks" },
    { label: "CTR", valueOf: (k) => formatPercent(k.ctr), deltaKey: "ctr" },
    {
      label: "CPC",
      valueOf: (k) => formatCurrency(k.cpc, latestSucceeded?.summary.currency ?? null),
      deltaKey: "cpc",
    },
    {
      label: "CV",
      valueOf: (k) => formatNumber(k.conversions),
      deltaKey: "conversions",
      hint: "= conversions",
    },
    {
      label: "CPA",
      valueOf: (k) => formatCurrency(k.cpa, latestSucceeded?.summary.currency ?? null),
      deltaKey: "cpa",
    },
    { label: "Frequency", valueOf: (k) => formatFrequency(k.frequency), deltaKey: "frequency" },
  ];

  const runColumns: DataTableColumn<CronRunRow>[] = [
    {
      header: "Started",
      cell: (row) => formatTimestamp(row.startedAt),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "State",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>{row.state}</StatusBadge>
      ),
    },
    {
      header: "Account",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? <InlineCode>{summary.accountKey}</InlineCode> : <span>—</span>;
      },
    },
    {
      header: "Metric date",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary && summary.metricDate ? (
          <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {summary.metricDate}
          </span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Status",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? (
          <StatusBadge state={reportSummaryStatusToState(summary.status)}>
            {summary.status}
          </StatusBadge>
        ) : (
          <span>—</span>
        );
      },
    },
    {
      header: "Snapshots",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? (
          <span className="tabular-nums">{summary.snapshotIds.length}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Duration",
      cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const snapshotColumns: DataTableColumn<SnapshotRow>[] = [
    {
      header: "Date",
      cell: (row) => formatDate(row.metricDate),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "Hierarchy",
      cell: (row) => <InlineCode>{row.nodeType}</InlineCode>,
    },
    {
      header: "Node key",
      cell: (row) => <InlineCode>{row.nodeKey}</InlineCode>,
    },
    {
      header: "Impressions",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.impressions)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Clicks",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.clicks)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Spend",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(microsToMajor(row.spendMicros), 2)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Conversions",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.conversions)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Source",
      cell: (row) => <InlineCode>{row.source}</InlineCode>,
    },
  ];

  const latestSummaryItems: KeyValueEntry[] = latestSucceeded
    ? [
        {
          label: "Account",
          value: <InlineCode>{latestSucceeded.summary.accountKey}</InlineCode>,
        },
        {
          label: "Metric date",
          value: (
            <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {latestSucceeded.summary.metricDate || "—"}
              {latestSucceeded.summary.priorMetricDate
                ? ` (vs ${latestSucceeded.summary.priorMetricDate})`
                : ""}
            </span>
          ),
        },
        {
          label: "Currency",
          value: latestSucceeded.summary.currency ? (
            <InlineCode>{latestSucceeded.summary.currency}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Insights source",
          value: <InlineCode>{latestSucceeded.summary.insightsSource}</InlineCode>,
        },
        {
          label: "Status",
          value: (
            <StatusBadge state={reportSummaryStatusToState(latestSucceeded.summary.status)}>
              {latestSucceeded.summary.status}
            </StatusBadge>
          ),
        },
        {
          label: "Mode",
          value: (
            <StatusBadge state={modeToState(latestSucceeded.summary.mode)}>
              {latestSucceeded.summary.mode}
            </StatusBadge>
          ),
        },
        {
          label: "Snapshot IDs",
          value:
            latestSucceeded.summary.snapshotIds.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {latestSucceeded.summary.snapshotIds.length} 件 (
                {latestSucceeded.summary.snapshotIds.slice(0, 4).join(", ")}
                {latestSucceeded.summary.snapshotIds.length > 4 ? ", …" : ""})
              </span>
            ),
        },
        {
          label: "AI run",
          value: latestSucceeded.summary.aiRunId ? (
            <InlineCode>{latestSucceeded.summary.aiRunId}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  const latestSummaryStatus: StatusState = !dbReady
    ? "warn"
    : latestSucceeded
      ? reportSummaryStatusToState(latestSucceeded.summary.status)
      : "idle";
  const latestSummaryStatusLabel = !dbReady
    ? "warn"
    : latestSucceeded
      ? latestSucceeded.summary.status
      : "no runs yet";

  return (
    <>
      <PageHeader
        title="Daily Reports"
        subtitle={
          <>
            <InlineCode>daily_report</InlineCode> ワークフローの実行結果と{" "}
            <InlineCode>performance_snapshots</InlineCode> 由来の analytics。
            AI は Meta を直接変更せず、ここに表示される KPI と AI コメントは{" "}
            <InlineCode>ai_runs</InlineCode> に永続化された出力のみ。
          </>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="Latest daily_report"
          subtitle="直近の daily_report 実行から取得した account 集計 KPI と AI コメント"
          status={
            <StatusDot state={latestSummaryStatus}>{latestSummaryStatusLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="daily_report 出力を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : !latestSucceeded ? (
            <EmptyState
              title="daily_report はまだ実行されていません"
              description="/cron から daily_report スケジュールを有効化するか、CLI から ad-hoc 実行すると、ここに spend / impressions / clicks / CTR / CPC / CV / CPA / frequency と前期比 Δ% および AI コメントが表示されます。"
            />
          ) : (
            <div style={{ display: "grid", gap: "1.25rem" }}>
              <KeyValueList items={latestSummaryItems} />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: "0.75rem",
                }}
              >
                {kpiRows.map((kpi) => (
                  <KpiCell
                    key={kpi.label}
                    label={kpi.label}
                    value={kpi.valueOf(latestSucceeded.summary.current)}
                    delta={formatDelta(latestSucceeded.summary.deltas[kpi.deltaKey])}
                    {...(kpi.hint ? { hint: kpi.hint } : {})}
                  />
                ))}
              </div>

              {latestSucceeded.summary.aiCommentary ? (
                <div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-text-secondary)",
                      marginBottom: "0.25rem",
                    }}
                  >
                    AI commentary
                  </div>
                  <p style={{ margin: 0 }}>{latestSucceeded.summary.aiCommentary}</p>
                </div>
              ) : null}

              {latestSucceeded.summary.topImprovements.length > 0 ? (
                <div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-text-secondary)",
                      marginBottom: "0.25rem",
                    }}
                  >
                    Top improvements
                  </div>
                  <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
                    {latestSucceeded.summary.topImprovements.map((imp, idx) => (
                      <li key={idx} style={{ marginBottom: "0.25rem" }}>
                        <InlineCode>{imp.hierarchy}</InlineCode>{" "}
                        <InlineCode>{imp.target}</InlineCode> — {imp.rationale}
                        {imp.expectedImpact ? (
                          <span
                            style={{
                              color: "var(--color-text-secondary)",
                              marginLeft: "0.25rem",
                            }}
                          >
                            ({imp.expectedImpact})
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {latestSucceeded.summary.errorMessage ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-status-error)",
                  }}
                >
                  {latestSucceeded.summary.errorMessage}
                </div>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="Recent daily_report runs"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `cron_runs (name="daily_report") · ${runsCount} 件 (直近 25)`
          }
          status={
            <StatusDot state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "warn" : runsCount === 0 ? "idle" : `${runsCount} runs`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="daily_report 実行履歴を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={runs}
              rowKey={(row) => row.id}
              columns={runColumns}
              empty={
                <EmptyState
                  title="daily_report はまだ実行されていません"
                  description="/cron からスケジュールを有効化するか、CLI から ad-hoc 実行すると、ここに各実行の status / metric date / snapshot 件数 / 所要時間が記録されます。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="Performance snapshots"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `performance_snapshots · 直近 ${snapshotsCount} 件`
          }
          status={
            <StatusDot state={!dbReady ? "warn" : snapshotsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "warn" : snapshotsCount === 0 ? "idle" : `${snapshotsCount} snapshots`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="performance_snapshots を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={snapshots}
              rowKey={(row) => row.id}
              columns={snapshotColumns}
              empty={
                <EmptyState
                  title="performance_snapshots はまだありません"
                  description="daily_report が実行されると、account / campaign / adset / ad の 4 階層 snapshot がここに永続化されます (raw retention 90d / aggregated retention 1y)。"
                />
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}
