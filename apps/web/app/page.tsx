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
import { DashboardChatPanel } from "./DashboardChatPanel";

export const dynamic = "force-dynamic";

interface DailyReportSnapshot {
  metricDate: string;
  metricTimeZone: string;
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
    metricTimeZone: typeof v.metricTimeZone === "string" ? v.metricTimeZone : "UTC",
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
        title="ホーム"
        subtitle={
          <>
            広告運用の状態確認、レポート取得、入稿前チェックをここから始められます。
            この画面は手元の端末だけで開けます。
          </>
        }
      />

      <div className="page-body">
        <div className="col-span-12">
          <DashboardChatPanel />
        </div>

        <div className="col-span-6">
          <Panel
            title="基本設定"
            subtitle="AdDroid を使う準備ができているか"
            status={<StatusDot state={status.config.state}>{status.config.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "状態", value: status.config.message },
                {
                  label: "設定ファイル",
                  value: status.config.configPath,
                  mono: true,
                },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="保存先"
            subtitle="履歴や連携状態を保存できるか"
            status={<StatusDot state={status.database.state}>{status.database.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "状態", value: status.database.message },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="自動実行"
            subtitle="定期レポートやチェックを動かせるか"
            status={<StatusDot state={status.worker.state}>{status.worker.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "状態", value: status.worker.message },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="GitHub 連携"
            subtitle="入稿変更をレビューに出せるか"
            status={<StatusDot state={status.github.state}>{status.github.state}</StatusDot>}
          >
            <KeyValueList
              items={[
                { label: "状態", value: status.github.message },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="Meta 広告"
            subtitle="広告アカウントが接続されているか"
            status={
              <StatusDot state={metaConnected ? "ok" : "warn"}>
                {metaConnected ? "接続済み" : "未接続"}
              </StatusDot>
            }
          >
            <KeyValueList
              items={[
                {
                  label: "接続",
                  value: metaConnected
                    ? "Meta と連携済み"
                    : "Meta と未連携です",
                },
                {
                  label: "利用できる広告アカウント",
                  value: (
                    <span className="tabular mono">{metaAccountsCount} 件</span>
                  ),
                },
                {
                  label: "次に見る画面",
                  value: (
                    <Link href="/accounts" style={{ color: "var(--color-accent)" }}>
                      広告アカウントを確認
                    </Link>
                  ),
                },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="承認待ち"
            subtitle="人の確認が必要な入稿変更"
            status={
              <StatusDot state={pendingPrCount === 0 ? "idle" : "info"}>
                {pendingPrCount === 0 ? "なし" : `${pendingPrCount} 件`}
              </StatusDot>
            }
          >
            <KeyValueList
              items={[
                {
                  label: "確認待ち",
                  value: (
                    <span className="tabular mono">{pendingPrCount} 件</span>
                  ),
                },
                {
                  label: "次に見る画面",
                  value: (
                    <Link href="/approvals" style={{ color: "var(--color-accent)" }}>
                      承認待ちを確認
                    </Link>
                  ),
                },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-6">
          <Panel
            title="日次レポート"
            subtitle="直近の広告成果"
            status={
              <StatusDot state={dailyReport ? "ok" : "idle"}>
                {dailyReport ? dailyReport.metricDate || "取得済み" : "未取得"}
              </StatusDot>
            }
          >
            {!dailyReport ? (
              <KeyValueList
                items={[
                  {
                    label: "状態",
                    value: "日次レポートはまだ実行されていません。",
                  },
                  {
                    label: "次に見る画面",
                    value: (
                      <Link
                        href="/reports/daily"
                        style={{ color: "var(--color-accent)" }}
                      >
                        日次レポートを確認
                      </Link>
                    ),
                  },
                ]}
              />
            ) : (
              <KeyValueList
                items={[
                  {
                    label: "広告アカウント",
                    value: <InlineCode>{dailyReport.accountKey}</InlineCode>,
                  },
                  {
                    label: "Timezone",
                    value: <InlineCode>{dailyReport.metricTimeZone}</InlineCode>,
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
                    label: "次に見る画面",
                    value: (
                      <Link
                        href="/reports/daily"
                        style={{ color: "var(--color-accent)" }}
                      >
                        日次レポートを確認
                      </Link>
                    ),
                  },
                ]}
              />
            )}
          </Panel>
        </div>

        <div className="col-span-12">
          <Panel title="最近の自動実行" subtitle="直近に動いたレポート・チェック">
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
                { header: "内容", cell: (row) => workflowLabel(row.name) },
                {
                  header: "所要時間",
                  cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
                  className: "tabular",
                  headerClassName: "tabular",
                },
                { header: "状態", cell: (row) => stateLabel(row.state) },
              ]}
            />
          </Panel>
        </div>

        <div className="col-span-12">
          <Panel title="最近の操作履歴" subtitle="人や自動実行が行った主な操作">
            <DataTable
              rows={recentAudit}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="操作履歴はまだありません。"
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
                { header: "実行者", cell: (row) => actorLabel(row.actor) },
                { header: "内容", cell: (row) => actionLabel(row.action) },
                { header: "対象", cell: (row) => row.target ?? "—", className: "mono" },
              ]}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}

function workflowLabel(name: string): string {
  const labels: Record<string, string> = {
    daily_report: "日次レポート",
    budget_guard: "予算チェック",
    improvement_pr: "改善提案",
    github_poll: "承認済み変更の確認",
    retention_cleanup: "古い履歴の整理",
  };
  return labels[name] ?? name;
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    ok: "成功",
    failed: "失敗",
    error: "失敗",
    running: "実行中",
    queued: "待機中",
    skipped: "スキップ",
  };
  return labels[state] ?? state;
}

function actorLabel(actor: string): string {
  if (actor.startsWith("user:")) return "ユーザー";
  if (actor.startsWith("agent:")) return "自動実行";
  if (actor.includes("cron")) return "自動実行";
  return actor;
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "account.default_changed": "既定アカウントを変更",
    "ad_account.registered": "広告アカウントを登録",
    "oauth.meta.connected": "Meta と接続",
    "oauth.meta.refreshed": "Meta 接続を更新",
    "pr.merged_via_web": "承認して反映待ちにした",
  };
  return labels[action] ?? action.replaceAll("_", " ").replaceAll(".", " / ");
}
