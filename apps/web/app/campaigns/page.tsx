// AdDroid OSS — /campaigns ページ.
//
// 仕様 (UI plan §6.5):
//   - Toolbar: Account / Status / 検索フィルタ (URL クエリ同期)
//   - DataTable: ads_hierarchy ノード一覧 (campaign / adset / ad)
//   - Per-row Activate: PAUSED 行のみ。ConfirmDialog 経由で /api/campaigns/[id]/activate を呼ぶ
//   - ACTIVE 行は Activate ボタンを出さない (PAUSE への戻しは GitOps 経由のみ)
//
// 設計原則:
//   - すべての行は Prisma クエリ由来 (No Placeholder Data)。
//   - SSR 内部から /api/* を fetch しない (UI plan §6 / §7).
//   - PAUSED-by-default はバッジ色で一目で分かる。
//
// 注: Meta CLI 実呼び出し (Activate POST endpoint) は実装エージェントが結線する。
//      本ファイルはその UI scaffold を提供する。

import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { DataTable } from "../../components/ui/DataTable";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { CampaignsToolbar } from "./CampaignsToolbar";
import { ActivateButton } from "./ActivateButton";
import type { StatusState } from "../../components/ui/StatusDot";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  accountId?: string | string[];
  status?: string | string[];
  q?: string | string[];
  fromApply?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

const ALLOWED_STATUS = new Set(["PAUSED", "ACTIVE", "ARCHIVED"]);

type AccountRow = {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
};

type HierarchyRow = {
  id: string;
  nodeType: string;
  displayName: string;
  status: string;
  externalId: string | null;
  lastCommitSha: string | null;
  updatedAt: Date;
  spec: unknown;
  account: { key: string; metaAccountId: string | null } | null;
};

type ApplyJobRow = {
  id: string;
  state: string;
  enqueuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  pullRequest: { number: number; title: string; mergedAt: Date | null } | null;
};

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const accountIdParam = single(searchParams?.accountId);
  const statusParam = (single(searchParams?.status) ?? "all").toUpperCase();
  const queryParam = (single(searchParams?.q) ?? "").trim();
  const fromApply = single(searchParams?.fromApply);

  let dbReady = true;
  let accounts: AccountRow[] = [];
  let defaultAdAccountId: string | null = null;
  let hierarchy: HierarchyRow[] = [];
  let applyJobs: ApplyJobRow[] = [];

  try {
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true, defaultAdAccountId: true },
    });
    if (ws) {
      defaultAdAccountId = ws.defaultAdAccountId ?? null;
      accounts = await prisma.adAccount.findMany({
        where: { workspaceId: ws.id, active: true },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, key: true, displayName: true, metaAccountId: true },
      });
    }
    applyJobs = await prisma.applyJob.findMany({
      orderBy: { enqueuedAt: "desc" },
      take: 5,
      select: {
        id: true,
        state: true,
        enqueuedAt: true,
        startedAt: true,
        finishedAt: true,
        pullRequest: { select: { number: true, title: true, mergedAt: true } },
      },
    });
  } catch {
    dbReady = false;
  }

  const selectedAccountId =
    accountIdParam && accounts.some((a) => a.id === accountIdParam)
      ? accountIdParam
      : defaultAdAccountId && accounts.some((a) => a.id === defaultAdAccountId)
        ? defaultAdAccountId
        : accounts[0]?.id ?? null;

  const statusFilter =
    statusParam !== "ALL" && ALLOWED_STATUS.has(statusParam) ? statusParam : null;

  if (dbReady && selectedAccountId) {
    try {
      hierarchy = await prisma.adsHierarchyNode.findMany({
        where: {
          accountId: selectedAccountId,
          ...(statusFilter
            ? { status: { equals: statusFilter, mode: "insensitive" } }
            : {}),
          ...(queryParam
            ? { displayName: { contains: queryParam, mode: "insensitive" } }
            : {}),
        },
        orderBy: [{ updatedAt: "desc" }],
        take: 200,
        select: {
          id: true,
          nodeType: true,
          displayName: true,
          status: true,
          externalId: true,
          lastCommitSha: true,
          updatedAt: true,
          spec: true,
          account: { select: { key: true, metaAccountId: true } },
        },
      });
    } catch {
      dbReady = false;
    }
  }

  const totalCount = hierarchy.length;
  const pausedCount = hierarchy.filter((row) => isPaused(row.status)).length;
  const activeCount = hierarchy.filter((row) => isActive(row.status)).length;

  const fromApplyBanner = fromApply ? renderFromApplyBanner(fromApply) : null;

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="Meta 上の campaign / adset / ad の現在状態。Activate は per-row + 確認ダイアログでのみ実行できます。"
      />

      <div className="page-body page-body--single">
        {fromApplyBanner}

        <Panel
          title="Apply と Activate の境界"
          subtitle="PR-derived Apply は PAUSED で作成・更新し、Activate は別操作・別 audit"
        >
          <KeyValueList
            items={[
              {
                label: "Apply",
                value: (
                  <>
                    merged GitHub PR から enqueue される PR-derived apply jobs。
                    Meta resources はすべて <StatusBadge state="idle">PAUSED</StatusBadge>{" "}
                    で create / update されます (PAUSED creation/update is the default)。
                  </>
                ),
              },
              {
                label: "Activate",
                value: (
                  <>
                    Apply とは separate な explicit operation。
                    PAUSED → ACTIVE への遷移は per-row の確認ダイアログ経由でのみ実行され、
                    actor / source (cli | web_ui) を audit_logs に記録します
                    (audited Activate operation)。
                  </>
                ),
              },
              {
                label: "Source",
                value: (
                  <>
                    Apply は <InlineCode>apply_jobs</InlineCode> + 直近 merged{" "}
                    <InlineCode>github_pull_requests</InlineCode> から、Activate は{" "}
                    <InlineCode>POST /api/campaigns/[id]/activate</InlineCode> から。
                  </>
                ),
              },
            ]}
          />
        </Panel>

        <Panel
          title="Recent Apply Jobs"
          subtitle="apply_jobs · merged PR から enqueue された PR-derived jobs (直近 5 件)"
        >
          {!dbReady ? (
            <EmptyState
              title="DB に接続できないため Apply jobs を読み込めません。"
              description="npm run db:push を実行し、prisma スキーマを反映してください。Apply jobs は merged GitHub PR から enqueue される PR-derived ジョブで、成功時に Meta resources を PAUSED で作成・更新します。"
            />
          ) : (
            <DataTable
              rows={applyJobs}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="PR-derived apply jobs はまだありません。"
                  description="ops repository で承認された YAML 変更が main に merged されると、execute_apply ジョブが enqueue され Meta resources を PAUSED で create/update します。Activate は別操作として下の Hierarchy 表から実行してください。"
                />
              }
              columns={[
                {
                  header: "PR",
                  cell: (row) =>
                    row.pullRequest ? `#${row.pullRequest.number}` : "—",
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "Title",
                  cell: (row) => row.pullRequest?.title ?? "—",
                },
                {
                  header: "State",
                  cell: (row) => (
                    <StatusBadge state={applyStateToBadge(row.state)}>
                      {row.state}
                    </StatusBadge>
                  ),
                },
                {
                  header: "Enqueued",
                  cell: (row) => row.enqueuedAt.toISOString(),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "Finished",
                  cell: (row) =>
                    row.finishedAt ? row.finishedAt.toISOString() : "—",
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
              ]}
            />
          )}
        </Panel>

        {!dbReady ? (
          <Panel title="Database">
            <EmptyState
              title="DB に接続できません。"
              description="npm run db:push を実行し、prisma スキーマを反映してください。"
            />
          </Panel>
        ) : accounts.length === 0 ? (
          <Panel title="Ad Accounts">
            <EmptyState
              title="登録済みの Ad Account がありません。"
              description="/accounts から Meta と接続するか、Ad Account を手動で追加してください。"
            />
          </Panel>
        ) : (
          <Panel
            title="Hierarchy"
            subtitle={
              <>
                ads_hierarchy · {totalCount} ノード /{" "}
                <span data-state="idle" className="status-badge inline-status">
                  PAUSED {pausedCount}
                </span>{" "}
                <span data-state="ok" className="status-badge inline-status">
                  ACTIVE {activeCount}
                </span>
              </>
            }
          >
            <div
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
            >
              <CampaignsToolbar
                accounts={accounts}
                selectedAccountId={selectedAccountId}
                selectedStatus={statusFilter ?? "all"}
                selectedQuery={queryParam}
              />

              <DataTable
                rows={hierarchy}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState
                    title={
                      queryParam || statusFilter
                        ? "条件に合うノードはありません。"
                        : "表示できるキャンペーンはありません。"
                    }
                    description={
                      queryParam || statusFilter
                        ? "フィルタを変更するか、検索条件をリセットしてください。"
                        : "Apply が成功すると PAUSED で作成されたものが表示されます。"
                    }
                  />
                }
                columns={[
                  {
                    header: "Type",
                    cell: (row) => (
                      <span className="mono" style={{ fontSize: "var(--size-2xs)" }}>
                        {row.nodeType}
                      </span>
                    ),
                  },
                  {
                    header: "Name",
                    cell: (row) => (
                      <div className="campaigns__name-cell">
                        <span>{row.displayName}</span>
                        {row.externalId ? (
                          <InlineCode>{row.externalId}</InlineCode>
                        ) : (
                          <span className="campaigns__name-cell-pending">
                            未同期 (external_id 未確定)
                          </span>
                        )}
                      </div>
                    ),
                  },
                  {
                    header: "Status",
                    cell: (row) => (
                      <StatusBadge state={statusToBadge(row.status)}>
                        {normalizeStatus(row.status)}
                      </StatusBadge>
                    ),
                  },
                  {
                    header: "Last commit",
                    cell: (row) =>
                      row.lastCommitSha ? (
                        <InlineCode>{row.lastCommitSha.slice(0, 7)}</InlineCode>
                      ) : (
                        <span style={{ color: "var(--color-text-tertiary)" }}>—</span>
                      ),
                    className: "mono",
                  },
                  {
                    header: "Updated",
                    cell: (row) => row.updatedAt.toISOString(),
                    className: "tabular mono",
                    headerClassName: "tabular",
                  },
                  {
                    header: "Actions",
                    cell: (row) =>
                      isPaused(row.status) ? (
                        <ActivateButton
                          nodeId={row.id}
                          nodeType={
                            (row.nodeType as "campaign" | "adset" | "ad") ?? "campaign"
                          }
                          displayName={row.displayName}
                          externalId={row.externalId}
                          accountLabel={
                            row.account?.metaAccountId ?? row.account?.key ?? "—"
                          }
                          budgetLabel={extractBudgetLabel(row.spec)}
                        />
                      ) : (
                        <span style={{ color: "var(--color-text-tertiary)" }}>—</span>
                      ),
                  },
                ]}
              />
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

function renderFromApplyBanner(applyId: string) {
  return (
    <div className="banner" data-state="info">
      <span className="banner__title">Apply ジョブ由来のキャンペーンを表示中</span>
      <span>
        Apply <InlineCode>{applyId}</InlineCode>{" "}
        が作成・更新したノードはこのリストに表示されます (PAUSED で作成されています)。Activate
        は行ごとに「ACTIVE にする」ボタンから個別に実行してください。
      </span>
    </div>
  );
}

function normalizeStatus(raw: string): string {
  return raw.toUpperCase();
}

function isPaused(raw: string): boolean {
  return raw.toUpperCase() === "PAUSED";
}
function isActive(raw: string): boolean {
  return raw.toUpperCase() === "ACTIVE";
}

function applyStateToBadge(state: string): StatusState {
  switch (state) {
    case "succeeded":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "simulated":
      return "info";
    case "queued":
    default:
      return "idle";
  }
}

function statusToBadge(raw: string): StatusState {
  const normalized = raw.toUpperCase();
  if (normalized === "ACTIVE") return "ok";
  if (normalized === "ARCHIVED") return "idle";
  if (normalized === "DELETED") return "error";
  // PAUSED や未知は idle (PAUSED-by-default のため緑にしない)。
  return "idle";
}

function extractBudgetLabel(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  if (typeof s.dailyBudgetUsd === "number") {
    return `$${s.dailyBudgetUsd.toFixed(2)} / day`;
  }
  if (typeof s.lifetimeBudgetUsd === "number") {
    return `$${s.lifetimeBudgetUsd.toFixed(2)} (lifetime)`;
  }
  if (typeof s.daily_budget_usd === "number") {
    return `$${(s.daily_budget_usd as number).toFixed(2)} / day`;
  }
  return null;
}
