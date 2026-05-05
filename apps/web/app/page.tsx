import Link from "next/link";
import { prisma } from "../lib/prisma";
import { loadDashboardStatus } from "../lib/status";
import { Panel } from "../components/ui/Panel";
import { StatusDot } from "../components/ui/StatusDot";
import { EmptyState } from "../components/ui/EmptyState";
import { KeyValueList } from "../components/ui/KeyValueList";
import { DataTable } from "../components/ui/DataTable";
import { InlineCode } from "../components/ui/CodeBlock";
import { PageHeader } from "../components/ui/PageHeader";

export const dynamic = "force-dynamic";

interface DailyReportSnapshot {
  metricDate: string;
  accountKey: string;
  status: string;
  spend: number | null;
  ctr: number | null;
  cpa: number | null;
  conversions: number | null;
  currency: string | null;
}

function readDailyReportSnapshot(value: unknown): DailyReportSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.status !== "string" || typeof v.accountKey !== "string") return null;
  const current = (v.current && typeof v.current === "object" && !Array.isArray(v.current)
    ? (v.current as Record<string, unknown>)
    : null) as Record<string, unknown> | null;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  return {
    metricDate: typeof v.metricDate === "string" ? v.metricDate : "",
    accountKey: v.accountKey,
    status: v.status,
    currency: typeof v.currency === "string" ? v.currency : null,
    spend: current ? num(current.spend) : null,
    ctr: current ? num(current.ctr) : null,
    cpa: current ? num(current.cpa) : null,
    conversions: current ? num(current.conversions) : null,
  };
}

export default async function DashboardPage() {
  const status = await loadDashboardStatus();

  let recentRuns: { id: string; name: string; state: string; startedAt: Date; durationMs: number | null }[] = [];
  let recentAudit: { id: string; createdAt: Date; actor: string; action: string; target: string | null }[] = [];
  let pendingPrCount = 0;
  let metaConnected = false;
  let metaAccountsCount = 0;
  let dailyReport: DailyReportSnapshot | null = null;
  try {
    recentRuns = await prisma.cronRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 5,
      select: { id: true, name: true, state: true, startedAt: true, durationMs: true },
    });
  } catch {
    /* DB 未反映時はクエリエラー → 空状態に倒す */
  }
  try {
    recentAudit = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, createdAt: true, actor: true, action: true, target: true },
    });
  } catch {
    /* same */
  }
  try {
    pendingPrCount = await prisma.githubPullRequest.count({
      where: { state: "open" },
    });
  } catch {
    /* same */
  }
  try {
    const metaToken = await prisma.oAuthToken.findFirst({
      where: { provider: "meta" },
      orderBy: { connectedAt: "desc" },
      select: { id: true },
    });
    metaConnected = !!metaToken;
    metaAccountsCount = await prisma.adAccount.count({ where: { active: true } });
  } catch {
    /* same */
  }
  try {
    const latestDailyReport = await prisma.cronRun.findFirst({
      where: { name: "daily_report", state: "success" },
      orderBy: { startedAt: "desc" },
      select: { output: true },
    });
    dailyReport = readDailyReportSnapshot(latestDailyReport?.output);
  } catch {
    /* same */
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          <>
            ローカル AdDroid プロセスの状態を 10 秒で把握するためのオペレータ用コンソール。
            UI は <InlineCode>{`${status.binding.hostname}:${status.binding.port}`}</InlineCode> でのみ listen。
          </>
        }
      />

      <div className="page-body">
        <div className="col-span-6">
          <Panel
            title="Config & Environment"
            subtitle="~/.addroid/config.yaml と DATABASE_URL の解決状況"
            status={<StatusDot state={status.config.state}>{status.config.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "Config path", value: status.config.configPath, mono: true },
                { label: "Status", value: status.config.message },
                {
                  label: "Web binding",
                  value: (
                    <InlineCode>
                      {status.binding.hostname}:{status.binding.port}
                    </InlineCode>
                  ),
                },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="Database"
            subtitle="PostgreSQL 接続と Prisma スキーマ反映"
            status={<StatusDot state={status.database.state}>{status.database.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "Driver", value: "Prisma 5 / PostgreSQL 16+" },
                { label: "Status", value: status.database.message },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="Worker / pg-boss"
            subtitle="cron プリセットの登録状況"
            status={<StatusDot state={status.worker.state}>{status.worker.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "Job runner", value: "pg-boss v10 (single PostgreSQL)" },
                { label: "Status", value: status.worker.message },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="GitHub"
            subtitle="OAuth 接続と ops repository ポーリング"
            status={<StatusDot state={status.github.state}>{status.github.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "Mode", value: "outbound-only / API ポーリング (webhook 不使用)" },
                { label: "Status", value: status.github.message },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="Meta Ads"
            subtitle="Meta Access Token と登録済み Ad Account"
            status={
              <StatusDot state={metaConnected ? "ok" : "warn"}>
                {metaConnected ? "connected" : "not connected"}
              </StatusDot>
            }
          >
            <KeyValueList
              items={[
                {
                  label: "Token",
                  value: metaConnected
                    ? "Meta と連携済み"
                    : "Meta と未連携 (CLI で接続)",
                },
                {
                  label: "Active Ad Accounts",
                  value: (
                    <span className="tabular mono">{metaAccountsCount} 件</span>
                  ),
                },
                {
                  label: "Detail",
                  value: (
                    <Link href="/accounts" style={{ color: "var(--color-accent)" }}>
                      /accounts を開く →
                    </Link>
                  ),
                },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="Approvals"
            subtitle="Web UI からの PR マージ承認境界"
            status={
              <StatusDot state={pendingPrCount === 0 ? "idle" : "info"}>
                {pendingPrCount === 0 ? "no pending" : `${pendingPrCount} pending`}
              </StatusDot>
            }
          >
            <KeyValueList
              items={[
                {
                  label: "Pending PRs",
                  value: (
                    <span className="tabular mono">{pendingPrCount} 件</span>
                  ),
                },
                {
                  label: "Detail",
                  value: (
                    <Link href="/approvals" style={{ color: "var(--color-accent)" }}>
                      /approvals を開く →
                    </Link>
                  ),
                },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="Daily Report"
            subtitle="直近の daily_report KPI スナップショット"
            status={
              <StatusDot state={dailyReport ? "ok" : "idle"}>
                {dailyReport ? dailyReport.metricDate || "succeeded" : "no runs yet"}
              </StatusDot>
            }
          >
            {!dailyReport ? (
              <KeyValueList
                items={[
                  {
                    label: "Status",
                    value: "daily_report はまだ実行されていません。",
                  },
                  {
                    label: "Detail",
                    value: (
                      <Link
                        href="/reports/daily"
                        style={{ color: "var(--color-accent)" }}
                      >
                        /reports/daily を開く →
                      </Link>
                    ),
                  },
                ]}
              />
            ) : (
              <KeyValueList
                items={[
                  {
                    label: "Account",
                    value: <InlineCode>{dailyReport.accountKey}</InlineCode>,
                  },
                  {
                    label: "Spend",
                    value: (
                      <span className="tabular mono">
                        {dailyReport.spend !== null
                          ? `${dailyReport.spend.toFixed(2)}${
                              dailyReport.currency ? ` ${dailyReport.currency}` : ""
                            }`
                          : "—"}
                      </span>
                    ),
                  },
                  {
                    label: "CTR",
                    value: (
                      <span className="tabular mono">
                        {dailyReport.ctr !== null
                          ? `${dailyReport.ctr.toFixed(2)}%`
                          : "—"}
                      </span>
                    ),
                  },
                  {
                    label: "CV / CPA",
                    value: (
                      <span className="tabular mono">
                        {dailyReport.conversions !== null
                          ? dailyReport.conversions
                          : "—"}{" "}
                        /{" "}
                        {dailyReport.cpa !== null
                          ? dailyReport.cpa.toFixed(2)
                          : "—"}
                      </span>
                    ),
                  },
                  {
                    label: "Detail",
                    value: (
                      <Link
                        href="/reports/daily"
                        style={{ color: "var(--color-accent)" }}
                      >
                        /reports/daily を開く →
                      </Link>
                    ),
                  },
                ]}
              />
            )}
          </Panel>
        </div>

        <div className="col-span-12">
          <Panel title="Recent Cron Runs" subtitle="cron_runs テーブルの直近 5 件">
            <DataTable
              rows={recentRuns}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="cron 実行履歴はまだありません。"
                  description="プリセットが起動すると記録されます。"
                />
              }
              columns={[
                {
                  header: "Started",
                  cell: (row) => row.startedAt.toISOString(),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                { header: "Name", cell: (row) => row.name },
                {
                  header: "Duration",
                  cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
                  className: "tabular",
                  headerClassName: "tabular",
                },
                { header: "State", cell: (row) => row.state },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-12">
          <Panel title="Recent Audit Events" subtitle="audit_logs テーブルの直近 5 件">
            <DataTable
              rows={recentAudit}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="監査ログはまだありません。"
                  description="AdDroid が初回 PR を生成すると記録されます。"
                />
              }
              columns={[
                {
                  header: "Time",
                  cell: (row) => row.createdAt.toISOString(),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                { header: "Actor", cell: (row) => row.actor },
                { header: "Action", cell: (row) => row.action },
                { header: "Target", cell: (row) => row.target ?? "—", className: "mono" },
              ]}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}
