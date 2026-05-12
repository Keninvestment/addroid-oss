import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { DataTable } from "../../../components/ui/DataTable";
import { Pagination } from "../../../components/ui/Pagination";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { PageHeader } from "../../../components/ui/PageHeader";
import { KeyValueList } from "../../../components/ui/KeyValueList";
import type { StatusState } from "../../../components/ui/StatusDot";
import { formatDateTime, resolveDisplayTimeZone } from "../../../lib/datetime";
import { ensureWebWorkspace } from "../../../lib/github-runtime";
import { getPaginationState, paginationLabel } from "../../../lib/pagination";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  runsPage?: string | string[];
  logsPage?: string | string[];
}

export default async function CronRunsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  type CronRunRow = {
    id: string;
    startedAt: Date;
    name: string;
    durationMs: number | null;
    state: string;
    jobId: string | null;
  };

  type ExecutionLogRow = {
    id: string;
    createdAt: Date;
    kind: string;
    level: string;
    message: string;
    refType: string | null;
    refId: string | null;
    cronRunId: string | null;
  };

  let cronRuns: CronRunRow[] = [];
  let latestCronRuns: CronRunRow[] = [];
  let executionLogs: ExecutionLogRow[] = [];
  let latestExecutionLogs: ExecutionLogRow[] = [];
  let cronRunsTotal = 0;
  let executionLogsTotal = 0;
  let warning: string | null = null;
  try {
    const workspace = await ensureWebWorkspace();
    const cronRunsWhere = {
      OR: [
        { schedule: { is: { workspaceId: workspace.id } } },
        { executionLogs: { some: { workspaceId: workspace.id } } },
      ],
    };
    const executionLogsWhere = { workspaceId: workspace.id };
    [cronRunsTotal, executionLogsTotal] = await Promise.all([
      prisma.cronRun.count({ where: cronRunsWhere }),
      prisma.executionLog.count({ where: executionLogsWhere }),
    ]);
    const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", cronRunsTotal);
    const logsPagination = getPaginationState(resolvedSearchParams, "logsPage", executionLogsTotal);
    [cronRuns, latestCronRuns, executionLogs, latestExecutionLogs] = await Promise.all([
      prisma.cronRun.findMany({
        where: cronRunsWhere,
        orderBy: { startedAt: "desc" },
        skip: runsPagination.skip,
        take: runsPagination.take,
        select: { id: true, startedAt: true, name: true, durationMs: true, state: true, jobId: true },
      }),
      prisma.cronRun.findMany({
        where: cronRunsWhere,
        orderBy: { startedAt: "desc" },
        take: 100,
        select: { id: true, startedAt: true, name: true, durationMs: true, state: true, jobId: true },
      }),
      prisma.executionLog.findMany({
        where: executionLogsWhere,
        orderBy: { createdAt: "desc" },
        skip: logsPagination.skip,
        take: logsPagination.take,
        select: {
          id: true,
          createdAt: true,
          kind: true,
          level: true,
          message: true,
          refType: true,
          refId: true,
          cronRunId: true,
        },
      }),
      prisma.executionLog.findMany({
        where: executionLogsWhere,
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          createdAt: true,
          kind: true,
          level: true,
          message: true,
          refType: true,
          refId: true,
          cronRunId: true,
        },
      }),
    ]);
  } catch {
    warning = "保存先を確認してください。";
  }

  const levelToState = (level: string): StatusState => {
    if (level === "error") return "error";
    if (level === "warn") return "warn";
    if (level === "info") return "info";
    return "idle";
  };

  const succeededRuns = latestCronRuns.filter((row) => row.state === "success").length;
  const failedRuns = latestCronRuns.filter((row) => row.state === "failed").length;
  const runningRuns = latestCronRuns.filter((row) => row.state === "running" || row.state === "queued").length;
  const latestRun = latestCronRuns[0] ?? null;
  const latestLog = latestExecutionLogs[0] ?? null;
  const errorLogs = latestExecutionLogs.filter((row) => row.level === "error").length;
  const warnLogs = latestExecutionLogs.filter((row) => row.level === "warn").length;
  const pageDisplayTimeZone = resolveDisplayTimeZone();
  const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", cronRunsTotal);
  const logsPagination = getPaginationState(resolvedSearchParams, "logsPage", executionLogsTotal);

  return (
    <>
      <PageHeader
        title="実行履歴"
        subtitle="レポート取得、入稿前チェック、自動実行の結果を確認します。"
      />

      <div className="page-body page-body--single">
        <Panel title="実行サマリ" subtitle={warning ?? "直近100件の状況"}>
          <KeyValueList
            items={[
              {
                label: "最新の実行",
                value: latestRun
                  ? `${workflowLabel(latestRun.name)} / ${statusLabel(latestRun.state)} / ${formatDateTime(latestRun.startedAt, { timeZone: pageDisplayTimeZone })}`
                  : "まだありません",
              },
              {
                label: "成功 / 失敗 / 実行中",
                value: `${succeededRuns} / ${failedRuns} / ${runningRuns} 件`,
              },
              {
                label: "注意が必要なログ",
                value: `${errorLogs} 件のエラー / ${warnLogs} 件の警告`,
              },
              {
                label: "最新メッセージ",
                value: latestLog ? friendlyMessage(latestLog.message) : "まだありません",
              },
            ]}
          />
        </Panel>

        <Panel title="自動実行の履歴" subtitle={warning ?? paginationLabel(runsPagination)}>
          <div>
            <DataTable
              rows={cronRuns}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="自動実行の履歴はまだありません。"
                  description="自動実行が動くと記録されます。"
                />
              }
              columns={[
              {
                header: "開始日時",
                cell: (row) => formatDateTime(row.startedAt, { timeZone: pageDisplayTimeZone }),
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
              {
                header: "状態",
                cell: (row) => (
                  <StatusBadge
                    state={
                      row.state === "success"
                        ? "ok"
                        : row.state === "failed"
                          ? "error"
                          : row.state === "running"
                            ? "info"
                            : "idle"
                    }
                  >
                    {statusLabel(row.state)}
                  </StatusBadge>
                ),
              },
              { header: "詳細", cell: (row) => row.jobId ? `受付ID ${shortId(row.jobId)}` : "—", className: "mono" },
              ]}
            />
            <Pagination
              basePath="/cron/runs"
              searchParams={resolvedSearchParams}
              pageParam="runsPage"
              state={runsPagination}
            />
          </div>
        </Panel>

        <Panel title="処理ログ" subtitle={warning ?? paginationLabel(logsPagination)}>
          <div>
            <DataTable
              rows={executionLogs}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="実行ログはまだありません。"
                  description="レポート取得、チェック、承認済み変更の確認などが動くと記録されます。"
                />
              }
              columns={[
              {
                header: "日時",
                cell: (row) => formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              { header: "種類", cell: (row) => workflowLabel(row.kind) },
              {
                header: "状態",
                cell: (row) => (
                  <StatusBadge state={levelToState(row.level)}>{levelLabel(row.level)}</StatusBadge>
                ),
              },
              { header: "メッセージ", cell: (row) => friendlyMessage(row.message) },
              {
                header: "関連ID",
                cell: (row) => {
                  if (row.cronRunId) return `実行 ${shortId(row.cronRunId)}`;
                  if (row.refType && row.refId) return `${refTypeLabel(row.refType)} ${shortId(row.refId)}`;
                  return "—";
                },
                className: "mono",
              },
              ]}
            />
            <Pagination
              basePath="/cron/runs"
              searchParams={resolvedSearchParams}
              pageParam="logsPage"
              state={logsPagination}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

function workflowLabel(name: string): string {
  const labels: Record<string, string> = {
    daily_report: "日次レポート",
    today_report: "当日レポート",
    budget_guard: "予算チェック",
    automation_rules: "自動運用ルール",
    improvement_pr: "改善提案",
    github_poll: "承認済み変更の確認",
    retention_cleanup: "古い履歴の整理",
    plan: "入稿前チェック",
  };
  return labels[name] ?? name;
}

function statusLabel(state: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
    skipped: "スキップ",
    ok: "成功",
    warn: "警告",
    error: "失敗",
    info: "情報",
  };
  return labels[state] ?? state;
}

function levelLabel(level: string): string {
  const labels: Record<string, string> = {
    info: "情報",
    warn: "警告",
    error: "エラー",
    debug: "詳細",
  };
  return labels[level] ?? level;
}

function refTypeLabel(refType: string): string {
  const labels: Record<string, string> = {
    cron_run: "実行",
    pr: "承認待ち",
    pull_request: "承認待ち",
    account: "広告アカウント",
    ad_account: "広告アカウント",
    ai_run: "AI実行",
  };
  return labels[refType] ?? refType;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function friendlyMessage(message: string): string {
  return message
    .replaceAll("daily_report", "日次レポート")
    .replaceAll("today_report", "当日レポート")
    .replaceAll("budget_guard", "予算チェック")
    .replaceAll("automation_rules", "自動運用ルール")
    .replaceAll("improvement_pr", "改善提案")
    .replaceAll("github_poll", "承認済み変更の確認")
    .replaceAll("retention_cleanup", "古い履歴の整理")
    .replaceAll("cron", "自動実行")
    .replaceAll("ai_run", "AI実行")
    .replaceAll("execution_logs", "処理ログ");
}
