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
import { AutomationModeControl } from "./AutomationModeControl";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";

export const dynamic = "force-dynamic";

export default async function CronSchedulesPage() {
  const pageDisplayTimeZone = resolveDisplayTimeZone();
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
  let executionMode = "proposal";
  try {
    const workspace = await ensureWebWorkspace();
    const workspaceRow = await prisma.workspace.findUnique({
      where: { id: workspace.id },
      select: { executionMode: true },
    });
    executionMode = workspaceRow?.executionMode ?? executionMode;
    registered = await prisma.cronSchedule.findMany({
      where: { workspaceId: workspace.id },
      select: { name: true, cron: true, enabled: true, lastRunState: true, nextRunAt: true },
    });
    const taskRows = await prisma.agentTask.findMany({
      where: { workspaceId: workspace.id },
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
      nextRunAt: task.nextRunAt
        ? formatDateTime(task.nextRunAt, { timeZone: pageDisplayTimeZone })
        : null,
      lastRunAt: task.lastRunAt
        ? formatDateTime(task.lastRunAt, { timeZone: pageDisplayTimeZone })
        : null,
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
        title="自動実行"
        subtitle="日次レポート、予算チェック、改善提案などを定期的に実行します。文章で新しい依頼も保存できます。"
        actions={
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Link href="/cron/runs" className="btn btn--ghost btn--sm">
              実行履歴
            </Link>
            <Link href="/cron/audit" className="btn btn--ghost btn--sm">
              操作履歴
            </Link>
          </div>
        }
      />

      <div className="page-body page-body--single">
        <CronRateLimitSummary />

        <Panel
          title="文章で追加する自動実行"
          subtitle="例: 毎朝、日次レポートを取得して問題があれば改善提案も作る。"
        >
          <AgentTaskForm tasks={agentTasks} />
        </Panel>

        <Panel
          title="自動承認モード"
          subtitle="workspace全体の実行モードを制御します。ONでも自動運用は承認済みYAMLと安全ゲートに一致した操作だけ実行します。"
        >
          <AutomationModeControl initialMode={executionMode} />
        </Panel>

        <Panel
          title="標準の自動実行"
          subtitle={
            dbReady
              ? `${registered.length} 件登録 / ${CRON_PRESETS.length} 件利用可能`
              : "保存先を確認してください。"
          }
        >
          <DataTable
            rows={rows}
            rowKey={(row) => row.name}
            empty={
              <EmptyState
                title="登録済みのスケジュールはまだありません。"
                description="AdDroid を開始すると標準の自動実行が登録されます。"
              />
            }
            columns={[
              { header: "内容", cell: (row) => presetLabel(row.name) },
              {
                header: "実行タイミング",
                cell: (row) => row.cron,
                className: "mono tabular",
                headerClassName: "tabular",
              },
              { header: "説明", cell: (row) => row.description },
              {
                header: "状態",
                cell: (row) => (
                  <StatusBadge state={row.enabled ? "ok" : "idle"}>
                    {row.enabled ? "有効" : "停止中"}
                  </StatusBadge>
                ),
              },
              {
                header: "前回",
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
                header: "次回",
                cell: (row) =>
                  row.nextRunAt
                    ? formatDateTime(row.nextRunAt, { timeZone: pageDisplayTimeZone })
                    : "—",
                className: "tabular mono",
                headerClassName: "tabular",
              },
              {
                header: "操作",
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

function presetLabel(name: string): string {
  const labels: Record<string, string> = {
    daily_report: "日次レポート",
    budget_guard: "予算チェック",
    automation_rules: "自動運用ルール",
    improvement_pr: "改善提案",
    github_poll: "承認済み変更の確認",
    retention_cleanup: "古い履歴の整理",
  };
  return labels[name] ?? name;
}
