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
  metricTimeZone: string;
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
    metricTimeZone: readString(output.metricTimeZone, "UTC"),
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

function cronStateLabel(state: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
    skipped: "スキップ",
  };
  return labels[state] ?? state;
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

function reportStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    succeeded: "取得済み",
    no_account: "対象なし",
    no_insights: "データなし",
    ai_failed: "AIコメント失敗",
  };
  return labels[status] ?? status;
}

function hierarchyLabel(nodeType: string): string {
  const labels: Record<string, string> = {
    account: "広告アカウント",
    campaign: "キャンペーン",
    adset: "広告セット",
    ad: "広告",
  };
  return labels[nodeType] ?? nodeType;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    meta_cli: "Meta",
    meta_graph: "Meta",
    mock: "テストデータ",
  };
  return labels[source] ?? source;
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

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    auto_apply: "自動反映候補",
    proposal: "提案",
    report_only: "レポートのみ",
  };
  return labels[mode] ?? mode;
}

function formatTimestamp(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
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
      header: "開始日時",
      cell: (row) => formatTimestamp(row.startedAt),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "実行状態",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>{cronStateLabel(row.state)}</StatusBadge>
      ),
    },
    {
      header: "広告アカウント",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? <InlineCode>{summary.accountKey}</InlineCode> : <span>—</span>;
      },
    },
    {
      header: "対象日",
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
      header: "取得結果",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? (
          <StatusBadge state={reportSummaryStatusToState(summary.status)}>
            {reportStatusLabel(summary.status)}
          </StatusBadge>
        ) : (
          <span>—</span>
        );
      },
    },
    {
      header: "保存データ",
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
      header: "所要時間",
      cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const snapshotColumns: DataTableColumn<SnapshotRow>[] = [
    {
      header: "日付",
      cell: (row) => formatDate(row.metricDate),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "階層",
      cell: (row) => hierarchyLabel(row.nodeType),
    },
    {
      header: "対象",
      cell: (row) => <InlineCode>{row.nodeKey}</InlineCode>,
    },
    {
      header: "表示回数",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.impressions)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "クリック",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.clicks)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "利用金額",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(microsToMajor(row.spendMicros), 2)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "成果",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.conversions)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "取得元",
      cell: (row) => sourceLabel(row.source),
    },
  ];

  const latestSummaryItems: KeyValueEntry[] = latestSucceeded
    ? [
        {
          label: "広告アカウント",
          value: <InlineCode>{latestSucceeded.summary.accountKey}</InlineCode>,
        },
        {
          label: "対象日",
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
          label: "タイムゾーン",
          value: <InlineCode>{latestSucceeded.summary.metricTimeZone}</InlineCode>,
        },
        {
          label: "通貨",
          value: latestSucceeded.summary.currency ? (
            <InlineCode>{latestSucceeded.summary.currency}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "取得元",
          value: sourceLabel(latestSucceeded.summary.insightsSource),
        },
        {
          label: "取得結果",
          value: (
            <StatusBadge state={reportSummaryStatusToState(latestSucceeded.summary.status)}>
              {reportStatusLabel(latestSucceeded.summary.status)}
            </StatusBadge>
          ),
        },
        {
          label: "実行モード",
          value: (
            <StatusBadge state={modeToState(latestSucceeded.summary.mode)}>
              {modeLabel(latestSucceeded.summary.mode)}
            </StatusBadge>
          ),
        },
        {
          label: "保存データ",
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
          label: "AI実行ID",
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
      ? reportStatusLabel(latestSucceeded.summary.status)
      : "未実行";

  return (
    <>
      <PageHeader
        title="日次レポート"
        subtitle={
          <>
            広告成果のKPIとAIコメントを確認します。この画面からMetaの広告設定は変更しません。
          </>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="最新レポート"
          subtitle="直近に取得した広告アカウント全体のKPIとAIコメント"
          status={
            <StatusDot state={latestSummaryStatus}>{latestSummaryStatusLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="日次レポートを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !latestSucceeded ? (
            <EmptyState
              title="日次レポートはまだ実行されていません"
              description="自動実行画面から日次レポートを有効化するか、ホームのチャットから依頼すると、ここに成果とAIコメントが表示されます。"
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
                    AIコメント
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
                    改善候補
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
          title="実行履歴"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `${runsCount} 件 (直近 25)`
          }
          status={
            <StatusDot state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "要確認" : runsCount === 0 ? "未実行" : `${runsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="日次レポートの実行履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={runs}
              rowKey={(row) => row.id}
              columns={runColumns}
              empty={
                <EmptyState
                  title="日次レポートはまだ実行されていません"
                  description="自動実行を有効化すると、各回の状態・対象日・所要時間がここに記録されます。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="保存された成果データ"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `直近 ${snapshotsCount} 件`
          }
          status={
            <StatusDot state={!dbReady ? "warn" : snapshotsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "要確認" : snapshotsCount === 0 ? "未保存" : `${snapshotsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="成果データを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={snapshots}
              rowKey={(row) => row.id}
              columns={snapshotColumns}
              empty={
                <EmptyState
                  title="保存された成果データはまだありません"
                  description="日次レポートが実行されると、広告アカウント、キャンペーン、広告セット、広告ごとの成果がここに保存されます。"
                />
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}
