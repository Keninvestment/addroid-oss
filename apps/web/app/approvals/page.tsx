// AdDroid OSS — /approvals (this implementation).
//
// 承認待ち PR (state="open") の一覧。Web UI からのマージは
// `/approvals/[prNumber]` の per-row プレビューから ConfirmDialog を経て
// 実行する (caution variant)。Slack は通知 + activate 用途のみで、PR 承認の
// 主経路ではない (UI plan §0 #18, §10)。
//
// データソースは Prisma 直読 (No Placeholder Data):
//   - github_pull_requests (state="open")
//   - approval_records (PR ごとの最新決定)
//
// Slack / 外部 API への依存はなく、Slack 未設定でも本ページは描画される。

import Link from "next/link";
import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { DataTable } from "../../components/ui/DataTable";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { StatusDot } from "../../components/ui/StatusDot";
import { InlineCode } from "../../components/ui/CodeBlock";

export const dynamic = "force-dynamic";

interface PendingPrRow {
  id: string;
  number: number;
  title: string;
  state: string;
  headSha: string;
  htmlUrl: string | null;
  baseRef: string;
  polledAt: Date;
  latestDecision: string | null;
}

interface MergedPrRow {
  id: string;
  number: number;
  title: string;
  mergedAt: Date | null;
  htmlUrl: string | null;
  decisionSource: string | null;
  decision: string | null;
}

function approvalStateLabel(decision: string | null): string {
  if (decision === "approved") return "approved";
  if (decision === "auto_approved") return "auto_approved";
  if (decision === "auto_blocked") return "auto_blocked";
  if (decision === "rejected") return "rejected";
  return "pending";
}

function approvalStateBadge(decision: string | null): "ok" | "warn" | "error" | "idle" {
  if (decision === "approved" || decision === "auto_approved") return "ok";
  if (decision === "auto_blocked" || decision === "rejected") return "error";
  return "warn";
}

function readDecisionSource(metadata: unknown): string | null {
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "decisionSource" in (metadata as Record<string, unknown>)
  ) {
    const v = (metadata as Record<string, unknown>).decisionSource;
    if (typeof v === "string") return v;
  }
  return null;
}

export default async function ApprovalsPage() {
  let openPrs: PendingPrRow[] = [];
  let recentMerges: MergedPrRow[] = [];
  let dbReady = true;

  try {
    const open = await prisma.githubPullRequest.findMany({
      where: { state: "open" },
      orderBy: { polledAt: "desc" },
      take: 50,
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        headSha: true,
        htmlUrl: true,
        baseRef: true,
        polledAt: true,
        approvalRecords: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { decision: true },
        },
      },
    });
    openPrs = open.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      state: row.state,
      headSha: row.headSha,
      htmlUrl: row.htmlUrl,
      baseRef: row.baseRef,
      polledAt: row.polledAt,
      latestDecision: row.approvalRecords[0]?.decision ?? null,
    }));

    const merged = await prisma.githubPullRequest.findMany({
      where: { state: "merged" },
      orderBy: { mergedAt: "desc" },
      take: 10,
      select: {
        id: true,
        number: true,
        title: true,
        mergedAt: true,
        htmlUrl: true,
        approvalRecords: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { decision: true, metadata: true },
        },
      },
    });
    recentMerges = merged.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      mergedAt: row.mergedAt,
      htmlUrl: row.htmlUrl,
      decision: row.approvalRecords[0]?.decision ?? null,
      decisionSource: readDecisionSource(row.approvalRecords[0]?.metadata ?? null),
    }));
  } catch {
    dbReady = false;
  }

  const headerStatus = !dbReady
    ? "warn"
    : openPrs.length === 0
      ? "idle"
      : "info";
  const headerStatusLabel = !dbReady
    ? "warn"
    : openPrs.length === 0
      ? "no pending"
      : `${openPrs.length} pending`;

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={
          <>
            マージ待ちの Pull Request を Web UI から確認・マージするための承認境界。
            マージは GitHub merge と等価で、merge 成功時に{" "}
            <InlineCode>approval_records.decisionSource=web_merge</InlineCode>
            {" "}と{" "}
            <InlineCode>audit_logs.action=pr.merged_via_web</InlineCode>
            {" "}を残し、次回 <InlineCode>github_poll</InlineCode> で Apply pipeline が起動します。
          </>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="マージ待ちの PR"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `github_pull_requests (state="open") · ${openPrs.length} 件`
          }
          status={<StatusDot state={headerStatus}>{headerStatusLabel}</StatusDot>}
        >
          {!dbReady ? (
            <EmptyState
              title="承認待ち PR を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={openPrs}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="マージ待ちの PR はありません。"
                  description="improvement_pr ワークフローで PR が作成されると、ここに表示されます。Slack 通知の有無に関わらず Web UI からマージ可能です。"
                />
              }
              columns={[
                {
                  header: "#",
                  cell: (row) => (
                    <Link
                      href={`/approvals/${row.number}`}
                      className="mono"
                      style={{ color: "var(--color-accent)" }}
                    >
                      #{row.number}
                    </Link>
                  ),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "Title",
                  cell: (row) => (
                    <Link href={`/approvals/${row.number}`}>{row.title}</Link>
                  ),
                },
                {
                  header: "State",
                  cell: (row) => (
                    <StatusBadge
                      state={approvalStateBadge(row.latestDecision)}
                    >
                      {approvalStateLabel(row.latestDecision)}
                    </StatusBadge>
                  ),
                },
                {
                  header: "Base",
                  cell: (row) => row.baseRef,
                  className: "mono",
                },
                {
                  header: "Head SHA",
                  cell: (row) => row.headSha.slice(0, 12),
                  className: "mono",
                },
                {
                  header: "Polled",
                  cell: (row) => row.polledAt.toISOString(),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "Action",
                  cell: (row) => (
                    <Link href={`/approvals/${row.number}`} className="btn btn--ghost">
                      Preview
                    </Link>
                  ),
                },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="最近マージ済みの PR"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `github_pull_requests (state="merged") · 直近 ${recentMerges.length} 件`
          }
        >
          {!dbReady ? (
            <EmptyState
              title="マージ履歴を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。"
            />
          ) : (
            <DataTable
              rows={recentMerges}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="マージ済みの PR はまだありません。"
                  description="github_poll が merged 状態を検知すると履歴が記録されます。"
                />
              }
              columns={[
                {
                  header: "#",
                  cell: (row) => (
                    <Link href={`/approvals/${row.number}`} className="mono">
                      #{row.number}
                    </Link>
                  ),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                { header: "Title", cell: (row) => row.title },
                {
                  header: "Decision",
                  cell: (row) => (
                    <StatusBadge state={approvalStateBadge(row.decision)}>
                      {approvalStateLabel(row.decision)}
                    </StatusBadge>
                  ),
                },
                {
                  header: "Source",
                  cell: (row) => row.decisionSource ?? "—",
                  className: "mono",
                },
                {
                  header: "Merged",
                  cell: (row) =>
                    row.mergedAt ? row.mergedAt.toISOString() : "—",
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
              ]}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
