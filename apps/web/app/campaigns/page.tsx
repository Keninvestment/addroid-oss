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
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  const accountIdParam = single(resolvedSearchParams?.accountId);
  const statusParam = (single(resolvedSearchParams?.status) ?? "all").toUpperCase();
  const queryParam = (single(resolvedSearchParams?.q) ?? "").trim();
  const fromApply = single(resolvedSearchParams?.fromApply);

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
        title="配信中の広告"
        subtitle="Meta 上のキャンペーン、広告セット、広告の状態を確認します。停止中のものを有効化する時は確認ダイアログを必ず通します。"
      />

      <div className="page-body page-body--single">
        {fromApplyBanner}

        <Panel
          title="反映と有効化の安全ルール"
          subtitle="変更はまず停止状態で反映され、配信開始は別操作で確認します"
        >
          <KeyValueList
            items={[
              {
                label: "反映",
                value: (
                  <>
                    承認済みの変更は、まず <StatusBadge state="idle">停止中</StatusBadge>{" "}
                    として Meta に作成・更新されます。
                  </>
                ),
              },
              {
                label: "有効化",
                value: (
                  <>
                    停止中から配信中へ切り替える時は、行ごとの確認ダイアログで実行します。
                    操作履歴にも記録されます。
                  </>
                ),
              },
              {
                label: "確認",
                value: (
                  <>
                    予期しない配信開始を避けるため、反映と有効化は分けて扱います。
                  </>
                ),
              },
            ]}
          />
        </Panel>

        <Panel
          title="最近の反映処理"
          subtitle="承認済み変更から作成された直近 5 件"
        >
          {!dbReady ? (
            <EmptyState
              title="反映処理を読み込めません。"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={applyJobs}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="反映処理はまだありません。"
                  description="承認された変更があると、停止状態でMetaへ反映されます。有効化は下の一覧から別途実行します。"
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
                  header: "内容",
                  cell: (row) => row.pullRequest?.title ?? "—",
                },
                {
                  header: "状態",
                  cell: (row) => (
                    <StatusBadge state={applyStateToBadge(row.state)}>
                      {row.state}
                    </StatusBadge>
                  ),
                },
                {
                  header: "受付日時",
                  cell: (row) => row.enqueuedAt.toISOString(),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "完了日時",
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
          <Panel title="保存先">
            <EmptyState
              title="DB に接続できません。"
              description="接続と健康状態を確認してください。"
            />
          </Panel>
        ) : accounts.length === 0 ? (
          <Panel title="広告アカウント">
            <EmptyState
              title="登録済みの広告アカウントがありません。"
              description="広告アカウント画面からMetaと接続するか、手動で追加してください。"
            />
          </Panel>
        ) : (
          <Panel
            title="広告一覧"
            subtitle={
              <>
                {totalCount} 件 /{" "}
                <span data-state="idle" className="status-badge inline-status">
                  停止中 {pausedCount}
                </span>{" "}
                <span data-state="ok" className="status-badge inline-status">
                  配信中 {activeCount}
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
                        : "表示できる広告はありません。"
                    }
                    description={
                      queryParam || statusFilter
                        ? "フィルタを変更するか、検索条件をリセットしてください。"
                        : "承認済み変更が反映されると、停止中として作成されたものが表示されます。"
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
      <span className="banner__title">反映処理で更新された広告を表示中</span>
      <span>
        反映処理 <InlineCode>{applyId}</InlineCode>{" "}
        が作成・更新した広告はこのリストに表示されます。停止中で作成されているため、
        配信開始は行ごとに「配信開始」ボタンから実行してください。
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
