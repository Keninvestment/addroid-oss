import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { StatusDot } from "../../components/ui/StatusDot";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { EmptyState } from "../../components/ui/EmptyState";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { DataTable } from "../../components/ui/DataTable";
import { PageHeader } from "../../components/ui/PageHeader";
import { BootstrapOpsRepoButton } from "./BootstrapOpsRepoButton";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  oauth?: string | string[];
  bootstrap?: string | string[];
  reason?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function GithubPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
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
  let dbReady = true;
  try {
    [oauth, repos, prs] = await Promise.all([
      prisma.oAuthToken.findMany({
        where: { provider: "github" },
        select: { provider: true, accountIdentifier: true, scopes: true, connectedAt: true },
      }),
      prisma.githubRepo.findMany({
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
        orderBy: { polledAt: "desc" },
        take: 50,
        select: { id: true, number: true, title: true, state: true, headSha: true, mergedAt: true, polledAt: true },
      }),
    ]);
  } catch {
    dbReady = false;
  }

  const oauthState = !dbReady ? "warn" : oauth.length === 0 ? "warn" : "ok";
  const oauthMessage = !dbReady
    ? "Prisma スキーマが未反映です。npm run db:push を実行してください。"
    : oauth.length === 0
      ? "GitHub と未連携です。下のボタンから OAuth を開始してください。"
      : `${oauth.length} 件の GitHub OAuth トークンが暗号化境界越しに保存されています。`;

  const repo = repos[0];
  const repoState = !dbReady ? "warn" : !repo ? "warn" : repo.bootstrappedAt ? "ok" : "warn";

  const oauthQuery = single(searchParams?.oauth);
  const bootstrapQuery = single(searchParams?.bootstrap);
  const reasonQuery = single(searchParams?.reason);
  const banner = renderBanner(oauthQuery, bootstrapQuery, reasonQuery);

  return (
    <>
      <PageHeader
        title="GitHub"
        subtitle="OAuth 接続・ops repository・Pull Request ポーリングの状態。webhook は使用しません。"
      />

      <div className="page-body page-body--single">
        {banner}

        <Panel
          title="OAuth Status"
          subtitle="oauth_tokens テーブルから読み取った接続情報"
          status={<StatusDot state={oauthState}>{oauthState}</StatusDot>}
        >
          {oauth.length === 0 ? (
            <EmptyState
              title="GitHub と未連携です。"
              description={oauthMessage}
              action={
                <a className="btn btn--primary" href="/api/oauth/github/begin">
                  Connect GitHub
                </a>
              }
            />
          ) : (
            <DataTable
              rows={oauth}
              rowKey={(row) => `${row.provider}/${row.accountIdentifier}`}
              empty={null}
              columns={[
                { header: "Provider", cell: (row) => row.provider },
                { header: "Account", cell: (row) => row.accountIdentifier, className: "mono" },
                { header: "Scopes", cell: (row) => row.scopes.join(", ") || "—", className: "mono" },
                {
                  header: "Connected",
                  cell: (row) => row.connectedAt.toISOString(),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="Ops Repository"
          subtitle="github_repos テーブル + ETag ポーリング状態"
          status={<StatusDot state={repoState}>{repoState}</StatusDot>}
        >
          {!repo ? (
            <EmptyState
              title="ops リポジトリは未生成です。"
              description={
                oauth.length === 0
                  ? "GitHub と接続後、AdDroid が ops repository を bootstrap します。"
                  : "OAuth は接続済みです。下のボタンから ops repository を bootstrap してください (callback 実行時に自動 bootstrap が失敗した場合の再試行用)。"
              }
              action={oauth.length > 0 ? <BootstrapOpsRepoButton variant="primary" /> : null}
            />
          ) : (
            <KeyValueList
              items={[
                { label: "Repo", value: `${repo.owner}/${repo.name}`, mono: true },
                { label: "Default branch", value: repo.defaultBranch, mono: true },
                {
                  label: "Bootstrapped",
                  value: repo.bootstrappedAt ? repo.bootstrappedAt.toISOString() : "未実行",
                },
                {
                  label: "Last poll",
                  value: repo.pollingState?.lastPolledAt
                    ? `${repo.pollingState.lastPolledAt.toISOString()} (HTTP ${repo.pollingState.lastStatusCode ?? "?"})`
                    : "未実行",
                },
                { label: "ETag", value: repo.pollingState?.etag ?? "—", mono: true },
                {
                  label: "Next poll",
                  value: repo.pollingState?.nextPollAt
                    ? repo.pollingState.nextPollAt.toISOString()
                    : "未スケジュール",
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="Pull Requests" subtitle={`github_pull_requests · ${prs.length} 件`}>
          <DataTable
            rows={prs}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="追跡中の Pull Request はまだありません。"
                description="AdDroid が ops repo に PR を作成すると、ここに表示されます。"
              />
            }
            columns={[
              { header: "#", cell: (row) => `#${row.number}`, className: "tabular mono", headerClassName: "tabular" },
              { header: "Title", cell: (row) => row.title },
              {
                header: "State",
                cell: (row) => (
                  <StatusBadge state={row.state === "merged" ? "ok" : row.state === "closed" ? "idle" : "info"}>
                    {row.state}
                  </StatusBadge>
                ),
              },
              { header: "Head SHA", cell: (row) => row.headSha.slice(0, 12), className: "mono" },
              {
                header: "Merged",
                cell: (row) => (row.mergedAt ? row.mergedAt.toISOString() : "—"),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              {
                header: "Polled",
                cell: (row) => row.polledAt.toISOString(),
                className: "tabular mono",
                headerClassName: "tabular",
              },
            ]}
          />
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
        <span className="banner__title">GitHub OAuth に失敗しました</span>
        <span>{reason ?? "詳細不明のエラー。/setup の Doctor 結果を確認してください。"}</span>
      </div>
    );
  }
  if (oauth === "connected") {
    if (bootstrap === "ok") {
      return (
        <div className="banner" data-state="ok">
          <span className="banner__title">GitHub に接続し、ops repository を bootstrap しました。</span>
          <span>github_repos と Workspace.opsRepoId にメタデータを保存し、audit_logs に記録しました。</span>
        </div>
      );
    }
    if (bootstrap === "skipped") {
      return (
        <div className="banner" data-state="info">
          <span className="banner__title">GitHub に接続しました。</span>
          <span>ops repository は既に Workspace に紐付いていたため、bootstrap はスキップされました。</span>
        </div>
      );
    }
    if (bootstrap === "error") {
      return (
        <div className="banner" data-state="warn">
          <span className="banner__title">OAuth は接続できましたが ops repository の bootstrap に失敗しました。</span>
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
