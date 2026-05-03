import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { DataTable } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PageHeader } from "../../../components/ui/PageHeader";

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
    warning = "Prisma スキーマが未反映です。npm run db:push を実行してください。";
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="広告配信や予算を変更し得るすべての操作を記録します (audit_logs)。"
      />

      <div className="page-body page-body--single">
        <Panel title="Audit events" subtitle={warning ?? `${rows.length} 件`}>
          <DataTable
            rows={rows}
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
              { header: "Actor", cell: (row) => row.actor, className: "mono" },
              { header: "Action", cell: (row) => row.action, className: "mono" },
              { header: "Target", cell: (row) => row.target ?? "—", className: "mono" },
              { header: "Ref", cell: (row) => row.ref ?? "—", className: "mono" },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
