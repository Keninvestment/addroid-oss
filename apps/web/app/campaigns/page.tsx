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
import Link from "next/link";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { DataTable, type DataTableColumn } from "../../components/ui/DataTable";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { CampaignsToolbar } from "./CampaignsToolbar";
import { ActivateButton } from "./ActivateButton";
import { SyncCampaignsButton } from "./SyncCampaignsButton";
import type { StatusState } from "../../components/ui/StatusDot";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/meta-runtime";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  accountId?: string | string[];
  status?: string | string[];
  q?: string | string[];
  fromApply?: string | string[];
  tab?: string | string[];
  campaignId?: string | string[];
  adsetId?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

const ALLOWED_STATUS = new Set(["PAUSED", "ACTIVE", "ARCHIVED"]);
const ALLOWED_TABS = new Set(["campaign", "adset", "ad"]);
type CampaignsTab = "campaign" | "adset" | "ad";

type AccountRow = {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
  currency: string | null;
  timezoneName: string | null;
};

type HierarchyRow = {
  id: string;
  nodeType: string;
  nodeKey: string;
  parentId: string | null;
  displayName: string;
  status: string;
  externalId: string | null;
  lastCommitSha: string | null;
  updatedAt: Date;
  spec: unknown;
  account: { key: string; metaAccountId: string | null; timezoneName: string | null } | null;
  parent: HierarchyParentRow | null;
};

type HierarchyParentRow = {
  id: string;
  nodeType: string;
  parentId: string | null;
  displayName: string;
  externalId: string | null;
  parent: {
    id: string;
    nodeType: string;
    parentId: string | null;
    displayName: string;
    externalId: string | null;
  } | null;
};

type ApplyJobRow = {
  id: string;
  state: string;
  enqueuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  pullRequest: { number: number; title: string; mergedAt: Date | null } | null;
};

type PerformanceMetricRow = {
  hierarchyId: string | null;
  nodeType: string;
  nodeKey: string;
  metricDate: Date;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
  source: string;
};

type CampaignMetrics = {
  metricDate: Date;
  source: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number | null;
  cpa: number | null;
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
  const tabParam = single(resolvedSearchParams?.tab) ?? "campaign";
  const campaignIdParam = single(resolvedSearchParams?.campaignId);
  const adsetIdParam = single(resolvedSearchParams?.adsetId);
  const activeTab = (ALLOWED_TABS.has(tabParam) ? tabParam : "campaign") as CampaignsTab;

  let dbReady = true;
  let accounts: AccountRow[] = [];
  let defaultAdAccountId: string | null = null;
  let allHierarchy: HierarchyRow[] = [];
  let applyJobs: ApplyJobRow[] = [];
  let latestMetricDate: Date | null = null;
  let metricRows: PerformanceMetricRow[] = [];

  try {
    const currentWorkspace = await ensureWebWorkspace();
    const ws = await prisma.workspace.findUnique({
      where: { id: currentWorkspace.id },
      select: { defaultAdAccountId: true },
    });
    if (ws) {
      defaultAdAccountId = ws.defaultAdAccountId ?? null;
      accounts = await prisma.adAccount.findMany({
        where: { workspaceId: currentWorkspace.id, active: true },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          key: true,
          displayName: true,
          metaAccountId: true,
          currency: true,
          timezoneName: true,
        },
      });
    }
    applyJobs = await prisma.applyJob.findMany({
      where: {
        pullRequest: { repo: { workspace: { is: { id: currentWorkspace.id } } } },
      },
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
      const [hierarchyRows, latestMetric] = await Promise.all([
        prisma.adsHierarchyNode.findMany({
          where: {
            accountId: selectedAccountId,
          },
          orderBy: [{ updatedAt: "desc" }],
          take: 1000,
          select: {
            id: true,
            nodeType: true,
            nodeKey: true,
            parentId: true,
            displayName: true,
            status: true,
            externalId: true,
            lastCommitSha: true,
            updatedAt: true,
            spec: true,
            account: { select: { key: true, metaAccountId: true, timezoneName: true } },
            parent: {
              select: {
                id: true,
                nodeType: true,
                parentId: true,
                displayName: true,
                externalId: true,
                parent: {
                  select: {
                    id: true,
                    nodeType: true,
                    parentId: true,
                    displayName: true,
                    externalId: true,
                  },
                },
              },
            },
          },
        }),
        prisma.performanceSnapshot.findFirst({
          where: {
            accountId: selectedAccountId,
            nodeType: { in: ["campaign", "adset", "ad"] },
          },
          orderBy: [{ metricDate: "desc" }, { createdAt: "desc" }],
          select: { metricDate: true },
        }),
      ]);
      allHierarchy = hierarchyRows;
      latestMetricDate = latestMetric?.metricDate ?? null;
      if (latestMetricDate) {
        metricRows = await prisma.performanceSnapshot.findMany({
          where: {
            accountId: selectedAccountId,
            metricDate: latestMetricDate,
            nodeType: { in: ["campaign", "adset", "ad"] },
          },
          select: {
            hierarchyId: true,
            nodeType: true,
            nodeKey: true,
            metricDate: true,
            impressions: true,
            clicks: true,
            spendMicros: true,
            conversions: true,
            source: true,
          },
        });
      }
    } catch {
      dbReady = false;
    }
  }

  const campaignRows = allHierarchy.filter((row) => row.nodeType === "campaign");
  const adsetRows = allHierarchy.filter((row) => row.nodeType === "adset");
  const adRows = allHierarchy.filter((row) => row.nodeType === "ad");
  const campaignMap = new Map(campaignRows.map((row) => [row.id, row]));
  const adsetMap = new Map(adsetRows.map((row) => [row.id, row]));
  const selectedAdset = adsetIdParam ? adsetMap.get(adsetIdParam) ?? null : null;
  const selectedCampaignFromParam = campaignIdParam
    ? campaignMap.get(campaignIdParam) ?? null
    : null;
  const selectedCampaign =
    selectedAdset?.parentId
      ? campaignMap.get(selectedAdset.parentId) ?? selectedCampaignFromParam
      : selectedCampaignFromParam;
  const visibleBaseRows =
    activeTab === "campaign"
      ? campaignRows
      : activeTab === "adset"
        ? adsetRows.filter((row) => !selectedCampaign || row.parentId === selectedCampaign.id)
        : adRows.filter((row) => {
            if (selectedAdset) return row.parentId === selectedAdset.id;
            if (selectedCampaign) return row.parent?.parentId === selectedCampaign.id;
            return true;
          });
  const hierarchy = visibleBaseRows.filter((row) =>
    matchesCampaignFilters(row, { statusFilter, query: queryParam })
  );
  const tabCounts = {
    campaign: campaignRows.filter((row) =>
      matchesCampaignFilters(row, { statusFilter, query: queryParam })
    ).length,
    adset: adsetRows.filter(
      (row) =>
        (!selectedCampaign || row.parentId === selectedCampaign.id) &&
        matchesCampaignFilters(row, { statusFilter, query: queryParam })
    ).length,
    ad: adRows.filter(
      (row) =>
        (selectedAdset
          ? row.parentId === selectedAdset.id
          : selectedCampaign
            ? row.parent?.parentId === selectedCampaign.id
            : true) &&
        matchesCampaignFilters(row, { statusFilter, query: queryParam })
    ).length,
  };
  const totalCount = hierarchy.length;
  const pausedCount = hierarchy.filter((row) => isPaused(row.status)).length;
  const activeCount = hierarchy.filter((row) => isActive(row.status)).length;
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
  const pageDisplayTimeZone = resolveDisplayTimeZone(selectedAccount?.timezoneName);
  const currency = selectedAccount?.currency ?? "JPY";
  const metricsByHierarchyId = new Map<string, CampaignMetrics>();
  const metricsByNodeKey = new Map<string, CampaignMetrics>();
  for (const row of metricRows) {
    const metrics = normalizeMetricRow(row);
    if (row.hierarchyId) metricsByHierarchyId.set(row.hierarchyId, metrics);
    metricsByNodeKey.set(metricKey(row.nodeType, row.nodeKey), metrics);
  }
  const metricsForRow = (row: HierarchyRow): CampaignMetrics | null =>
    metricsByHierarchyId.get(row.id) ??
    metricsByNodeKey.get(metricKey(row.nodeType, row.nodeKey)) ??
    (row.externalId
      ? metricsByNodeKey.get(metricKey(row.nodeType, row.externalId)) ?? null
      : null);
  const metricDateLabel = latestMetricDate
    ? formatMetricDate(latestMetricDate)
    : null;
  const makeHref = (updates: Partial<CampaignsHrefInput>) =>
    buildCampaignsHref({
      accountId: selectedAccountId,
      status: statusFilter,
      q: queryParam,
      tab: activeTab,
      campaignId: selectedCampaign?.id ?? null,
      adsetId: selectedAdset?.id ?? null,
      ...updates,
    });
  const columns = buildCampaignColumns({
    activeTab,
    makeHref,
    pageDisplayTimeZone,
    currency,
    metricsForRow,
  });
  const activeTabLabel = tabLabel(activeTab);

  const fromApplyBanner = fromApply ? renderFromApplyBanner(fromApply) : null;

  return (
    <>
      <PageHeader
        title="配信中の広告"
        subtitle="Meta 上のキャンペーン、広告セット、広告の状態を確認します。配信開始は GitOps PR を作成し、承認後に反映します。"
        actions={<SyncCampaignsButton accountId={selectedAccountId} />}
      />

      <div className="page-body page-body--single">
        {fromApplyBanner}

        <Panel
          title="反映と有効化の安全ルール"
          subtitle="変更はまず停止状態で反映され、配信開始は PR 承認後に反映します"
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
                    停止中から配信中へ切り替える時は、行ごとの確認ダイアログから
                    GitOps PR を作成します。merge 後に反映されます。
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
                  description="承認された変更があると、停止状態でMetaへ反映されます。配信開始は下の一覧からPRを作成します。"
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
                  cell: (row) =>
                    formatDateTime(row.enqueuedAt, { timeZone: pageDisplayTimeZone }),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "完了日時",
                  cell: (row) =>
                    row.finishedAt
                      ? formatDateTime(row.finishedAt, { timeZone: pageDisplayTimeZone })
                      : "—",
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
            title={activeTabLabel}
            subtitle={
              <>
                {totalCount} 件 /{" "}
                <span data-state="idle" className="status-badge inline-status">
                  停止中 {pausedCount}
                </span>{" "}
                <span data-state="ok" className="status-badge inline-status">
                  配信中 {activeCount}
                </span>
                {" "}
                {metricDateLabel ? (
                  <span className="campaigns__metric-date">
                    指標日 {metricDateLabel}
                  </span>
                ) : (
                  <span className="campaigns__metric-date">指標未取得</span>
                )}
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

              <div className="campaigns__tabs" role="tablist" aria-label="広告階層">
                {(["campaign", "adset", "ad"] as CampaignsTab[]).map((tab) => (
                  <Link
                    key={tab}
                    role="tab"
                    aria-selected={activeTab === tab}
                    className="campaigns__tab"
                    data-active={activeTab === tab}
                    href={makeHref({
                      tab,
                      ...(tab === "campaign" ? { campaignId: null, adsetId: null } : {}),
                      ...(tab === "adset" ? { adsetId: null } : {}),
                    })}
                  >
                    <span>{tabLabel(tab)}</span>
                    <span className="campaigns__tab-count">{tabCounts[tab]}</span>
                  </Link>
                ))}
              </div>

              {(selectedCampaign || selectedAdset) && (
                <div className="campaigns__selection-bar" aria-label="選択中の階層">
                  {selectedCampaign && (
                    <span className="campaigns__selection-chip">
                      <span className="campaigns__selection-label">キャンペーン</span>
                      <span className="campaigns__selection-name">
                        {selectedCampaign.displayName}
                      </span>
                    </span>
                  )}
                  {selectedAdset && (
                    <span className="campaigns__selection-chip">
                      <span className="campaigns__selection-label">広告セット</span>
                      <span className="campaigns__selection-name">
                        {selectedAdset.displayName}
                      </span>
                    </span>
                  )}
                  <Link
                    className="campaigns__clear-link"
                    href={makeHref({ tab: "campaign", campaignId: null, adsetId: null })}
                  >
                    選択解除
                  </Link>
                </div>
              )}

              <DataTable
                rows={hierarchy}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState
                    title={
                      queryParam || statusFilter
                        ? "条件に合う項目はありません。"
                        : `${activeTabLabel}はありません。`
                    }
                    description={
                      queryParam || statusFilter
                        ? "フィルタを変更するか、検索条件をリセットしてください。"
                        : "Metaから更新すると、現在のキャンペーン、広告セット、広告が表示されます。承認済み変更が反映されたものもここに表示されます。"
                    }
                  />
                }
                columns={columns}
              />
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

type CampaignsHrefInput = {
  accountId: string | null;
  status: string | null;
  q: string | null;
  tab: CampaignsTab | null;
  campaignId: string | null;
  adsetId: string | null;
};

function buildCampaignsHref(input: CampaignsHrefInput): string {
  const params = new URLSearchParams();
  if (input.accountId) params.set("accountId", input.accountId);
  if (input.status) params.set("status", input.status);
  if (input.q) params.set("q", input.q);
  if (input.tab && input.tab !== "campaign") params.set("tab", input.tab);
  if (input.campaignId) params.set("campaignId", input.campaignId);
  if (input.adsetId) params.set("adsetId", input.adsetId);
  const search = params.toString();
  return search ? `/campaigns?${search}` : "/campaigns";
}

function tabLabel(tab: CampaignsTab): string {
  switch (tab) {
    case "adset":
      return "広告セット";
    case "ad":
      return "広告";
    case "campaign":
    default:
      return "キャンペーン";
  }
}

function matchesCampaignFilters(
  row: HierarchyRow,
  filters: { statusFilter: string | null; query: string }
): boolean {
  if (
    filters.statusFilter &&
    row.status.toUpperCase() !== filters.statusFilter.toUpperCase()
  ) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  return (
    row.displayName.toLowerCase().includes(query) ||
    (row.externalId?.toLowerCase().includes(query) ?? false)
  );
}

function buildCampaignColumns(input: {
  activeTab: CampaignsTab;
  makeHref: (updates: Partial<CampaignsHrefInput>) => string;
  pageDisplayTimeZone: string;
  currency: string;
  metricsForRow: (row: HierarchyRow) => CampaignMetrics | null;
}): DataTableColumn<HierarchyRow>[] {
  const deliveryColumn: DataTableColumn<HierarchyRow> = {
    header: "配信",
    cell: (row) => (
      <StatusBadge state={statusToBadge(row.status)}>
        {normalizeStatus(row.status)}
      </StatusBadge>
    ),
  };
  const idColumn: DataTableColumn<HierarchyRow> = {
    header: "ID",
    cell: (row) =>
      row.externalId ? (
        <InlineCode>{row.externalId}</InlineCode>
      ) : (
        <span className="campaigns__name-cell-pending">未同期</span>
      ),
    className: "mono",
  };
  const updatedColumn: DataTableColumn<HierarchyRow> = {
    header: "更新日時",
    cell: (row) =>
      formatDateTime(row.updatedAt, {
        timeZone: resolveDisplayTimeZone(
          row.account?.timezoneName,
          input.pageDisplayTimeZone
        ),
      }),
    className: "tabular mono",
    headerClassName: "tabular",
  };
  const actionsColumn: DataTableColumn<HierarchyRow> = {
    header: "操作",
    cell: (row) => renderActions(row),
  };
  const metricColumns = buildMetricColumns(input);

  if (input.activeTab === "campaign") {
    return [
      deliveryColumn,
      {
        header: "キャンペーン名",
        cell: (row) =>
          renderNodeName(
            row,
            input.makeHref({ tab: "adset", campaignId: row.id, adsetId: null })
          ),
      },
      ...metricColumns,
      idColumn,
      updatedColumn,
      actionsColumn,
    ];
  }

  if (input.activeTab === "adset") {
    return [
      deliveryColumn,
      {
        header: "広告セット名",
        cell: (row) =>
          renderNodeName(
            row,
            input.makeHref({
              tab: "ad",
              campaignId: row.parentId,
              adsetId: row.id,
            })
          ),
      },
      {
        header: "キャンペーン",
        cell: (row) => renderParentLink(row.parent, input.makeHref),
      },
      ...metricColumns,
      idColumn,
      updatedColumn,
      actionsColumn,
    ];
  }

  return [
    deliveryColumn,
    {
      header: "広告名",
      cell: (row) => renderNodeName(row, null),
    },
    {
      header: "広告セット",
      cell: (row) =>
        renderParentLink(row.parent, input.makeHref, {
          tab: "ad",
          adsetId: row.parent?.id ?? null,
          campaignId: row.parent?.parentId ?? null,
        }),
    },
    {
      header: "キャンペーン",
      cell: (row) => renderParentLink(row.parent?.parent ?? null, input.makeHref),
    },
    ...metricColumns,
    idColumn,
    updatedColumn,
    actionsColumn,
  ];
}

function buildMetricColumns(input: {
  currency: string;
  metricsForRow: (row: HierarchyRow) => CampaignMetrics | null;
}): DataTableColumn<HierarchyRow>[] {
  return [
    {
      header: "消化",
      cell: (row) => {
        const metrics = input.metricsForRow(row);
        return metrics ? formatCurrency(metrics.spend, input.currency) : renderMutedDash();
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "表示 / クリック",
      cell: (row) => {
        const metrics = input.metricsForRow(row);
        return metrics
          ? renderMetricStack(
              formatInteger(metrics.impressions),
              `${formatInteger(metrics.clicks)} クリック`
            )
          : renderMutedDash();
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "CTR / CPC",
      cell: (row) => {
        const metrics = input.metricsForRow(row);
        return metrics
          ? renderMetricStack(
              formatPercent(metrics.ctr),
              metrics.cpc === null ? "CPC —" : `CPC ${formatCurrency(metrics.cpc, input.currency)}`
            )
          : renderMutedDash();
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "CV / CPA",
      cell: (row) => {
        const metrics = input.metricsForRow(row);
        return metrics
          ? renderMetricStack(
              `${formatInteger(metrics.conversions)} CV`,
              metrics.cpa === null ? "CPA —" : `CPA ${formatCurrency(metrics.cpa, input.currency)}`
            )
          : renderMutedDash();
      },
      className: "tabular",
      headerClassName: "tabular",
    },
  ];
}

function renderMetricStack(primary: string, secondary: string) {
  return (
    <span className="campaigns__metric-cell">
      <span>{primary}</span>
      <span className="campaigns__metric-subtext">{secondary}</span>
    </span>
  );
}

function renderNodeName(row: HierarchyRow, href: string | null) {
  const name = href ? (
    <Link className="campaigns__entity-link" href={href}>
      {row.displayName}
    </Link>
  ) : (
    <span>{row.displayName}</span>
  );
  return (
    <div className="campaigns__name-cell">
      {name}
      {row.lastCommitSha ? (
        <span className="campaigns__subtext">
          commit <InlineCode>{row.lastCommitSha.slice(0, 7)}</InlineCode>
        </span>
      ) : null}
    </div>
  );
}

function renderParentLink(
  parent: HierarchyParentRow["parent"] | HierarchyParentRow | null,
  makeHref: (updates: Partial<CampaignsHrefInput>) => string,
  overrides?: Partial<CampaignsHrefInput>
) {
  if (!parent) return renderMutedDash();
  const tab = parent.nodeType === "campaign" ? "adset" : "ad";
  return (
    <Link
      className="campaigns__entity-link campaigns__entity-link--muted"
      href={makeHref({
        tab,
        campaignId: parent.nodeType === "campaign" ? parent.id : parent.parentId,
        adsetId: parent.nodeType === "adset" ? parent.id : null,
        ...overrides,
      })}
    >
      {parent.displayName}
    </Link>
  );
}

function renderActions(row: HierarchyRow) {
  if (!isPaused(row.status)) return renderMutedDash();
  if (isMetaGraphOnlyRow(row)) {
    return <span className="campaigns__name-cell-pending">GitOps未管理</span>;
  }
  return (
    <ActivateButton
      nodeId={row.id}
      nodeType={(row.nodeType as "campaign" | "adset" | "ad") ?? "campaign"}
      displayName={row.displayName}
      externalId={row.externalId}
      accountLabel={row.account?.metaAccountId ?? row.account?.key ?? "—"}
      budgetLabel={extractBudgetLabel(row.spec)}
    />
  );
}

function renderMutedDash() {
  return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
}

function normalizeMetricRow(row: PerformanceMetricRow): CampaignMetrics {
  const spend = Number(row.spendMicros) / 1_000_000;
  const impressions = Math.max(0, row.impressions);
  const clicks = Math.max(0, row.clicks);
  const conversions = Math.max(0, row.conversions);
  return {
    metricDate: row.metricDate,
    source: row.source,
    spend,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : null,
    cpa: conversions > 0 ? spend / conversions : null,
  };
}

function metricKey(nodeType: string, nodeKey: string): string {
  return `${nodeType}:${nodeKey}`;
}

function formatMetricDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("ja-JP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function formatCurrency(value: number, rawCurrency: string): string {
  const currency = rawCurrency.trim().toUpperCase() || "JPY";
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(value);
  } catch {
    return `${formatInteger(value)} ${currency}`;
  }
}

function isMetaGraphOnlyRow(row: HierarchyRow): boolean {
  if (row.lastCommitSha) return false;
  const spec = isRecord(row.spec) ? row.spec : null;
  if (spec?.source === "meta_graph_sync") return true;
  return Boolean(row.externalId && row.externalId === row.nodeKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderFromApplyBanner(applyId: string) {
  return (
    <div className="banner" data-state="info">
      <span className="banner__title">反映処理で更新された広告を表示中</span>
      <span>
        反映処理 <InlineCode>{applyId}</InlineCode>{" "}
        が作成・更新した広告はこのリストに表示されます。停止中で作成されているため、
        配信開始は行ごとに「配信開始PR」から提案してください。
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
