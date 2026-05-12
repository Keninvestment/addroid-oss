import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { StatusDot } from "../../components/ui/StatusDot";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { EmptyState } from "../../components/ui/EmptyState";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { DataTable } from "../../components/ui/DataTable";
import { Pagination } from "../../components/ui/Pagination";
import { PageHeader } from "../../components/ui/PageHeader";
import { BootstrapOpsRepoButton } from "./BootstrapOpsRepoButton";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";
import { getPaginationState, paginationLabel } from "../../lib/pagination";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  oauth?: string | string[];
  bootstrap?: string | string[];
  reason?: string | string[];
  prsPage?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function GithubPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  type OAuthRow = { provider: string; accountIdentifier: string; scopes: string[]; connectedAt: Date };
  type RepoRow = {
    id: string;
    owner: string;
    name: string;
    defaultBranch: string;
    bootstrappedAt: Date | null;
    pollingState: { etag: string | null; lastStatusCode: number | null; lastPolledAt: Date | null; nextPollAt: Date | null } | null;
  };
  type PrRow = { id: string; number: number; title: string; state: string; headSha: string; mergedAt: Date | null; polledAt: Date };

  let oauth: OAuthRow[] = [];
  let repos: RepoRow[] = [];
  let prs: PrRow[] = [];
  let prsTotal = 0;
  let dbReady = true;
  try {
    const workspace = await ensureWebWorkspace();
    const prsWhere = { repo: { workspace: { is: { id: workspace.id } } } };
    prsTotal = await prisma.githubPullRequest.count({ where: prsWhere });
    const prsPagination = getPaginationState(resolvedSearchParams, "prsPage", prsTotal);
    [oauth, repos, prs] = await Promise.all([
      prisma.oAuthToken.findMany({
        where: { provider: "github" },
        select: { provider: true, accountIdentifier: true, scopes: true, connectedAt: true },
      }),
      prisma.githubRepo.findMany({
        where: { workspace: { is: { id: workspace.id } } },
        select: {
          id: true,
          owner: true,
          name: true,
          defaultBranch: true,
          bootstrappedAt: true,
          pollingState: {
            select: { etag: true, lastStatusCode: true, lastPolledAt: true, nextPollAt: true },
          },
        },
      }),
      prisma.githubPullRequest.findMany({
        where: prsWhere,
        orderBy: { polledAt: "desc" },
        skip: prsPagination.skip,
        take: prsPagination.take,
        select: { id: true, number: true, title: true, state: true, headSha: true, mergedAt: true, polledAt: true },
      }),
    ]);
  } catch {
    dbReady = false;
  }

  const oauthState = !dbReady ? "warn" : oauth.length === 0 ? "warn" : "ok";
  const oauthMessage = !dbReady
    ? "保存先を確認してください。"
    : oauth.length === 0
      ? "GitHub と未連携です。下のボタンから接続してください。"
      : `${oauth.length} 件のGitHub接続が保存されています。`;

  const repo = repos[0];
  const repoState = !dbReady ? "warn" : !repo ? "warn" : repo.bootstrappedAt ? "ok" : "warn";

  const oauthQuery = single(resolvedSearchParams?.oauth);
  const bootstrapQuery = single(resolvedSearchParams?.bootstrap);
  const reasonQuery = single(resolvedSearchParams?.reason);
  const banner = renderBanner(oauthQuery, bootstrapQuery, reasonQuery);
  const pageDisplayTimeZone = resolveDisplayTimeZone();
  const prsPagination = getPaginationState(resolvedSearchParams, "prsPage", prsTotal);

  return (
    <>
      <PageHeader
        title="GitHub 連携"
        subtitle="広告変更を承認フローに出すためのGitHub接続を確認します。"
      />

      <div className="page-body page-body--single">
        {banner}

        <Panel
          title="接続状態"
          subtitle="GitHub と連携できているか"
          status={<StatusDot state={oauthState}>{oauthState}</StatusDot>}
        >
          {oauth.length === 0 ? (
            <EmptyState
              title="GitHub と未連携です。"
              description={oauthMessage}
              action={
                <a className="btn btn--primary" href="/api/oauth/github/begin">
                  GitHub と接続
                </a>
              }
            />
          ) : (
            <DataTable
              rows={oauth}
              rowKey={(row) => `${row.provider}/${row.accountIdentifier}`}
              empty={null}
              columns={[
                { header: "接続先", cell: (row) => row.provider },
                { header: "アカウント", cell: (row) => row.accountIdentifier, className: "mono" },
                { header: "許可された範囲", cell: (row) => row.scopes.join(", ") || "—", className: "mono" },
                {
                    header: "接続日時",
                    cell: (row) => formatDateTime(row.connectedAt, { timeZone: pageDisplayTimeZone }),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="変更管理リポジトリ"
          subtitle="広告変更をレビューする場所"
          status={<StatusDot state={repoState}>{repoState}</StatusDot>}
        >
          {!repo ? (
            <EmptyState
              title="変更管理リポジトリは未生成です。"
              description={
                oauth.length === 0
                  ? "GitHub と接続後、AdDroid が変更管理リポジトリを準備します。"
                  : "GitHub は接続済みです。下のボタンから変更管理リポジトリを準備してください。"
              }
              action={oauth.length > 0 ? <BootstrapOpsRepoButton variant="primary" /> : null}
            />
          ) : (
            <KeyValueList
              items={[
                { label: "リポジトリ", value: `${repo.owner}/${repo.name}`, mono: true },
                { label: "既定ブランチ", value: repo.defaultBranch, mono: true },
                {
                    label: "準備日時",
                    value: repo.bootstrappedAt
                      ? formatDateTime(repo.bootstrappedAt, { timeZone: pageDisplayTimeZone })
                      : "未実行",
                  },
                  {
                    label: "前回確認",
                    value: repo.pollingState?.lastPolledAt
                      ? `${formatDateTime(repo.pollingState.lastPolledAt, { timeZone: pageDisplayTimeZone })} (HTTP ${repo.pollingState.lastStatusCode ?? "?"})`
                      : "未実行",
                  },
                  {
                    label: "次回確認",
                    value: repo.pollingState?.nextPollAt
                      ? formatDateTime(repo.pollingState.nextPollAt, { timeZone: pageDisplayTimeZone })
                      : "未スケジュール",
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="承認待ち・承認済みの変更" subtitle={paginationLabel(prsPagination)}>
          <div>
            <DataTable
              rows={prs}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="追跡中の Pull Request はまだありません。"
                  description="AdDroid がGitHubに承認待ちの変更を作成すると、ここに表示されます。"
                />
              }
              columns={[
              { header: "#", cell: (row) => `#${row.number}`, className: "tabular mono", headerClassName: "tabular" },
              { header: "内容", cell: (row) => row.title },
              {
                header: "状態",
                cell: (row) => (
                  <StatusBadge state={row.state === "merged" ? "ok" : row.state === "closed" ? "idle" : "info"}>
                    {row.state}
                  </StatusBadge>
                ),
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
              {
                  header: "確認日時",
                  cell: (row) => formatDateTime(row.polledAt, { timeZone: pageDisplayTimeZone }),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              ]}
            />
            <Pagination
              basePath="/github"
              searchParams={resolvedSearchParams}
              pageParam="prsPage"
              state={prsPagination}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

function renderBanner(
  oauth: string | undefined,
  bootstrap: string | undefined,
  reason: string | undefined
) {
  if (!oauth) return null;
  if (oauth === "error") {
    return (
      <div className="banner" data-state="error">
        <span className="banner__title">GitHub 接続に失敗しました</span>
        <span>{reason ?? "詳細不明のエラー。接続と健康状態を確認してください。"}</span>
      </div>
    );
  }
  if (oauth === "connected") {
    if (bootstrap === "ok") {
      return (
        <div className="banner" data-state="ok">
          <span className="banner__title">GitHub に接続し、変更管理リポジトリを準備しました。</span>
          <span>今後の広告変更は承認待ちとして作成できます。</span>
        </div>
      );
    }
    if (bootstrap === "skipped") {
      return (
        <div className="banner" data-state="info">
          <span className="banner__title">GitHub に接続しました。</span>
          <span>変更管理リポジトリは既に準備済みです。</span>
        </div>
      );
    }
    if (bootstrap === "error") {
      return (
        <div className="banner" data-state="warn">
          <span className="banner__title">GitHub は接続できましたが、変更管理リポジトリの準備に失敗しました。</span>
          <span>{reason ?? "下のパネルから手動で再試行してください。"}</span>
        </div>
      );
    }
    return (
      <div className="banner" data-state="ok">
        <span className="banner__title">GitHub に接続しました。</span>
      </div>
    );
  }
  return null;
}
