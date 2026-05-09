import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { DataTable } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PageHeader } from "../../../components/ui/PageHeader";
import { KeyValueList } from "../../../components/ui/KeyValueList";

export const dynamic = "force-dynamic";

export default async function AuditLogPage() {
  type Row = {
    id: string;
    createdAt: Date;
    actor: string;
    action: string;
    target: string | null;
    ref: string | null;
  };

  let rows: Row[] = [];
  let warning: string | null = null;
  try {
    rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, createdAt: true, actor: true, action: true, target: true, ref: true },
    });
  } catch {
    warning = "保存先を確認してください。";
  }

  const latest = rows[0] ?? null;
  const userActions = rows.filter((row) => row.actor.startsWith("user:")).length;
  const automatedActions = rows.filter(
    (row) => row.actor.startsWith("agent:") || row.actor.includes("cron")
  ).length;
  const approvalActions = rows.filter(
    (row) => row.action.includes("pr.") || row.action.includes("approval")
  ).length;

  return (
    <>
      <PageHeader
        title="操作履歴"
        subtitle="広告配信や予算に関わる操作を確認できます。"
      />

      <div className="page-body page-body--single">
        <Panel title="操作サマリ" subtitle={warning ?? "直近100件の概要"}>
          <KeyValueList
            items={[
              {
                label: "最新の操作",
                value: latest
                  ? `${actionLabel(latest.action)} / ${formatTimestamp(latest.createdAt)}`
                  : "まだありません",
              },
              {
                label: "ユーザー / 自動実行",
                value: `${userActions} / ${automatedActions} 件`,
              },
              {
                label: "承認関連",
                value: `${approvalActions} 件`,
              },
            ]}
          />
        </Panel>

        <Panel title="操作イベント" subtitle={warning ?? `${rows.length} 件`}>
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="操作履歴はまだありません。"
                description="AdDroid が初回 PR を生成すると記録されます。"
              />
            }
            columns={[
              {
                header: "日時",
                cell: (row) => formatTimestamp(row.createdAt),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              { header: "実行者", cell: (row) => actorLabel(row.actor) },
              { header: "内容", cell: (row) => actionLabel(row.action) },
              { header: "対象", cell: (row) => targetLabel(row.target), className: "mono" },
              { header: "関連ID", cell: (row) => row.ref ? shortId(row.ref) : "—", className: "mono" },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}

function actorLabel(actor: string): string {
  if (actor.startsWith("user:")) return "ユーザー";
  if (actor.includes("cron") || actor.startsWith("agent:")) return "自動実行";
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

function targetLabel(target: string | null): string {
  if (!target) return "—";
  return target
    .replace("ad_account:", "広告アカウント ")
    .replace("creative:", "クリエイティブ ")
    .replace("pr:", "承認待ち ")
    .replace("campaign:", "キャンペーン ");
}

function shortId(id: string): string {
  return id.length > 18 ? id.slice(0, 18) : id;
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
