import Link from "next/link";
import { prisma } from "../../lib/prisma";
import { CRON_PRESETS } from "@addroid/queue";
import { Panel } from "../../components/ui/Panel";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { DataTable } from "../../components/ui/DataTable";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { CronControls } from "./CronControls";
import { CronRateLimitSummary } from "./CronRateLimitSummary";
import { AgentTaskForm, type AgentTaskRow } from "./AgentTaskForm";

export const dynamic = "force-dynamic";

export default async function CronSchedulesPage() {
  type Row = {
    name: string;
    cron: string;
    enabled: boolean;
    lastRunState: string | null;
    nextRunAt: Date | null;
    description: string;
    persistedFromDb: boolean;
  };

  let registered: {
    name: string;
    cron: string;
    enabled: boolean;
    lastRunState: string | null;
    nextRunAt: Date | null;
  }[] = [];
  let dbReady = true;
  let agentTasks: AgentTaskRow[] = [];
  try {
    registered = await prisma.cronSchedule.findMany({
      select: { name: true, cron: true, enabled: true, lastRunState: true, nextRunAt: true },
    });
    const taskRows = await prisma.agentTask.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        prompt: true,
        cron: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        lastState: true,
      },
    });
    agentTasks = taskRows.map((task) => ({
      ...task,
      nextRunAt: task.nextRunAt ? task.nextRunAt.toISOString() : null,
      lastRunAt: task.lastRunAt ? task.lastRunAt.toISOString() : null,
    }));
  } catch {
    dbReady = false;
  }

  const presetByName = new Map(CRON_PRESETS.map((p) => [p.name, p]));
  const dbByName = new Map(registered.map((r) => [r.name, r]));
  const allNames = Array.from(new Set([...presetByName.keys(), ...dbByName.keys()]));
  const rows: Row[] = allNames.map((name) => {
    const persisted = dbByName.get(name);
    const preset = presetByName.get(name as (typeof CRON_PRESETS)[number]["name"]);
    return {
      name,
      cron: persisted?.cron ?? preset?.cron ?? "",
      enabled: persisted?.enabled ?? false,
      lastRunState: persisted?.lastRunState ?? null,
      nextRunAt: persisted?.nextRunAt ?? null,
      description: preset?.description ?? "(unknown preset)",
      persistedFromDb: Boolean(persisted),
    };
  });

  return (
    <>
      <PageHeader
        title="Cron Schedules"
        subtitle="pg-boss schedule と cron_schedules ミラーを Web UI から ON/OFF・schedule 編集・即時実行できます。書き込みは audit_logs に web: 接頭辞で記録されます。"
        actions={
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Link href="/cron/runs" className="btn btn--ghost btn--sm">
              Cron / Execution logs
            </Link>
            <Link href="/cron/audit" className="btn btn--ghost btn--sm">
              Audit logs
            </Link>
            <Link href="/logs" className="btn btn--ghost btn--sm">
              Operational logs
            </Link>
          </div>
        }
      />

      <div className="page-body page-body--single">
        <CronRateLimitSummary />

        <Panel
          title="Natural Language Agent Tasks"
          subtitle="OpenClaw と同様に自然言語のまま保存し、実行時に Dashboard chat と同じ LLM agent runtime で tool call を選びます。"
        >
          <AgentTaskForm tasks={agentTasks} />
        </Panel>

        <Panel
          title="Registered Schedules"
          subtitle={
            dbReady
              ? `cron_schedules · ${registered.length} 件登録 / プリセット定義 ${CRON_PRESETS.length} 件`
              : "Prisma スキーマ未反映 — npm run db:push を実行してください。"
          }
        >
          <DataTable
            rows={rows}
            rowKey={(row) => row.name}
            empty={
              <EmptyState
                title="登録済みのスケジュールはまだありません。"
                description="addroid start でデフォルトプリセットが登録されます。"
              />
            }
            columns={[
              { header: "Name", cell: (row) => row.name, className: "mono" },
              {
                header: "Cron",
                cell: (row) => row.cron,
                className: "mono tabular",
                headerClassName: "tabular",
              },
              { header: "Description", cell: (row) => row.description },
              {
                header: "Enabled",
                cell: (row) => (
                  <StatusBadge state={row.enabled ? "ok" : "idle"}>
                    {row.enabled ? "on" : "off"}
                  </StatusBadge>
                ),
              },
              {
                header: "Last run",
                cell: (row) => (
                  <StatusBadge
                    state={
                      row.lastRunState === "ok"
                        ? "ok"
                        : row.lastRunState === "warn"
                          ? "warn"
                          : row.lastRunState === "error"
                            ? "error"
                            : "idle"
                    }
                  >
                    {row.lastRunState ?? (row.persistedFromDb ? "未実行" : "未登録")}
                  </StatusBadge>
                ),
              },
              {
                header: "Next run",
                cell: (row) => (row.nextRunAt ? row.nextRunAt.toISOString() : "—"),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              {
                header: "Actions",
                cell: (row) => (
                  <CronControls
                    presetName={row.name}
                    description={row.description}
                    initialEnabled={row.enabled}
                    initialCron={row.cron}
                    persistedFromDb={row.persistedFromDb}
                  />
                ),
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
