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
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";

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
  if (decision === "approved") return "承認済み";
  if (decision === "auto_approved") return "自動承認済み";
  if (decision === "auto_blocked") return "自動ブロック";
  if (decision === "rejected") return "却下";
  return "確認待ち";
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
    const workspace = await ensureWebWorkspace();
    const open = await prisma.githubPullRequest.findMany({
      where: { state: "open", repo: { workspace: { is: { id: workspace.id } } } },
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
      where: { state: "merged", repo: { workspace: { is: { id: workspace.id } } } },
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
  const pageDisplayTimeZone = resolveDisplayTimeZone();

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
        title="承認待ち"
        subtitle={
          <>
            広告へ反映する前に、人の確認が必要な変更を確認します。
            承認しても即時配信ではなく、安全な反映処理に進みます。
          </>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="マージ待ちの PR"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `${openPrs.length} 件`
          }
          status={<StatusDot state={headerStatus}>{headerStatusLabel}</StatusDot>}
        >
          {!dbReady ? (
            <EmptyState
              title="承認待ち PR を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={openPrs}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="マージ待ちの PR はありません。"
                  description="改善提案や入稿変更が作成されると、ここに表示されます。"
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
                  header: "内容",
                  cell: (row) => (
                    <Link href={`/approvals/${row.number}`}>{row.title}</Link>
                  ),
                },
                {
                  header: "状態",
                  cell: (row) => (
                    <StatusBadge
                      state={approvalStateBadge(row.latestDecision)}
                    >
                      {approvalStateLabel(row.latestDecision)}
                    </StatusBadge>
                  ),
                },
                {
                  header: "反映先",
                  cell: (row) => row.baseRef,
                  className: "mono",
                },
                {
                  header: "変更ID",
                  cell: (row) => row.headSha.slice(0, 12),
                  className: "mono",
                },
                {
                    header: "確認日時",
                    cell: (row) => formatDateTime(row.polledAt, { timeZone: pageDisplayTimeZone }),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "操作",
                  cell: (row) => (
                    <Link href={`/approvals/${row.number}`} className="btn btn--ghost">
                      内容を確認
                    </Link>
                  ),
                },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="最近承認した変更"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `直近 ${recentMerges.length} 件`
          }
        >
          {!dbReady ? (
            <EmptyState
              title="マージ履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={recentMerges}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="マージ済みの PR はまだありません。"
                  description="承認した変更があると履歴に表示されます。"
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
                { header: "内容", cell: (row) => row.title },
                {
                  header: "判断",
                  cell: (row) => (
                    <StatusBadge state={approvalStateBadge(row.decision)}>
                      {approvalStateLabel(row.decision)}
                    </StatusBadge>
                  ),
                },
                {
                  header: "承認元",
                  cell: (row) => row.decisionSource ?? "—",
                  className: "mono",
                },
                {
                    header: "承認日時",
                    cell: (row) =>
                      row.mergedAt
                        ? formatDateTime(row.mergedAt, { timeZone: pageDisplayTimeZone })
                        : "—",
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
