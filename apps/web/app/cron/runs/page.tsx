import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { DataTable } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { PageHeader } from "../../../components/ui/PageHeader";
import type { StatusState } from "../../../components/ui/StatusDot";

export const dynamic = "force-dynamic";

export default async function CronRunsPage() {
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
  let executionLogs: ExecutionLogRow[] = [];
  let warning: string | null = null;
  try {
    [cronRuns, executionLogs] = await Promise.all([
      prisma.cronRun.findMany({
        orderBy: { startedAt: "desc" },
        take: 100,
        select: { id: true, startedAt: true, name: true, durationMs: true, state: true, jobId: true },
      }),
      prisma.executionLog.findMany({
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
    warning = "Prisma スキーマが未反映です。npm run db:push を実行してください。";
  }

  const levelToState = (level: string): StatusState => {
    if (level === "error") return "error";
    if (level === "warn") return "warn";
    if (level === "info") return "info";
    return "idle";
  };

  return (
    <>
      <PageHeader
        title="Cron Runs & Execution Log"
        subtitle="cron_runs と execution_logs の直近 100 件。worker が起動すると逐次追記されます。"
      />

      <div className="page-body page-body--single">
        <Panel title="Cron runs" subtitle={warning ?? `${cronRuns.length} 件 (cron_runs)`}>
          <DataTable
            rows={cronRuns}
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
              { header: "Name", cell: (row) => row.name, className: "mono" },
              {
                header: "Duration",
                cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
                className: "tabular",
                headerClassName: "tabular",
              },
              {
                header: "State",
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
                    {row.state}
                  </StatusBadge>
                ),
              },
              { header: "Job ID", cell: (row) => row.jobId ?? "—", className: "mono" },
            ]}
          />
        </Panel>

        <Panel title="Execution log" subtitle={warning ?? `${executionLogs.length} 件 (execution_logs)`}>
          <DataTable
            rows={executionLogs}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="実行ログはまだありません。"
                description="cron / apply / ai_run / github_poll / doctor が動作すると execution_logs に追記されます。"
              />
            }
            columns={[
              {
                header: "Time",
                cell: (row) => row.createdAt.toISOString(),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              { header: "Kind", cell: (row) => row.kind, className: "mono" },
              {
                header: "Level",
                cell: (row) => (
                  <StatusBadge state={levelToState(row.level)}>{row.level}</StatusBadge>
                ),
              },
              { header: "Message", cell: (row) => row.message },
              {
                header: "Ref",
                cell: (row) => {
                  if (row.cronRunId) return `cron_run:${row.cronRunId}`;
                  if (row.refType && row.refId) return `${row.refType}:${row.refId}`;
                  return "—";
                },
                className: "mono",
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
