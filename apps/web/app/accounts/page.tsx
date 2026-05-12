// AdDroid OSS — /accounts ページ.
//
// Meta 接続状態、Business 一覧 (runtime cache 由来)、登録済み Ad Account 一覧、
// デフォルトアカウント選択、再認証フロー、再認証履歴 を 1 ページに集約する。
//
// 設計原則:
//   - すべての値は Prisma クエリまたは runtime cache 由来 (No Placeholder Data)。
//   - 表示直前にトークン由来の文字列を sanitize する (二重防御)。
//   - PAUSED-by-default のため status カラムは敢えて出さない。Activate は別ページ。

import { prisma } from "../../lib/prisma";
import {
  ensureWebWorkspace,
  getActiveMetaAdapter,
  getMetaBusinessCache,
  sanitizeForDisplay,
} from "../../lib/meta-runtime";
import { Panel } from "../../components/ui/Panel";
import { StatusDot } from "../../components/ui/StatusDot";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { EmptyState } from "../../components/ui/EmptyState";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { DataTable } from "../../components/ui/DataTable";
import { Pagination } from "../../components/ui/Pagination";
import { PageHeader } from "../../components/ui/PageHeader";
import { InlineCode } from "../../components/ui/CodeBlock";
import { AddAccountForm } from "./AddAccountForm";
import { SetDefaultAccountForm } from "./SetDefaultAccountForm";
import { ReauthButton } from "./ReauthButton";
import { RefreshBusinessesButton } from "./RefreshBusinessesButton";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { getPaginationState, paginationLabel } from "../../lib/pagination";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  oauth?: string | string[];
  reason?: string | string[];
  accounts?: string | string[];
  reauthPage?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  type OAuthRow = {
    accountIdentifier: string;
    scopes: string[];
    connectedAt: Date;
    expiresAt: Date | null;
  };
  type AccountRow = {
    id: string;
    key: string;
    displayName: string;
    metaAccountId: string | null;
    active: boolean;
    createdAt: Date;
  };
  type AuditRow = {
    id: string;
    action: string;
    actor: string;
    target: string | null;
    ref: string | null;
    createdAt: Date;
  };

  let oauth: OAuthRow | null = null;
  let accounts: AccountRow[] = [];
  let defaultAdAccountId: string | null = null;
  let reauthEvents: AuditRow[] = [];
  let reauthTotal = 0;
  let dbReady = true;

  try {
    const currentWorkspace = await ensureWebWorkspace();
    const ws = await prisma.workspace.findUnique({
      where: { id: currentWorkspace.id },
      select: { defaultAdAccountId: true },
    });
    if (ws) {
      defaultAdAccountId = ws.defaultAdAccountId ?? null;
      const auditWhere = {
        workspaceId: currentWorkspace.id,
        action: {
          in: [
            "oauth.meta.connected",
            "oauth.meta.refreshed",
            "oauth.meta.reauth_required",
          ],
        },
      };
      const auditCount = await prisma.auditLog.count({ where: auditWhere });
      const reauthPagination = getPaginationState(
        resolvedSearchParams,
        "reauthPage",
        auditCount
      );
      const [oauthRow, accountRows, audits] = await Promise.all([
        prisma.oAuthToken.findFirst({
          where: { provider: "meta" },
          orderBy: { connectedAt: "desc" },
          select: {
            accountIdentifier: true,
            scopes: true,
            connectedAt: true,
            expiresAt: true,
          },
        }),
        prisma.adAccount.findMany({
          where: { workspaceId: currentWorkspace.id },
          orderBy: [{ active: "desc" }, { createdAt: "asc" }],
          select: {
            id: true,
            key: true,
            displayName: true,
            metaAccountId: true,
            active: true,
            createdAt: true,
          },
        }),
        prisma.auditLog.findMany({
          where: auditWhere,
          orderBy: { createdAt: "desc" },
          skip: reauthPagination.skip,
          take: reauthPagination.take,
          select: {
            id: true,
            action: true,
            actor: true,
            target: true,
            ref: true,
            createdAt: true,
          },
        }),
      ]);
      oauth = oauthRow ?? null;
      accounts = accountRows;
      reauthEvents = audits;
      reauthTotal = auditCount;
    }
  } catch {
    dbReady = false;
  }

  const adapterSelection = await getActiveMetaAdapter().catch(() => null);
  const adapterChoice = adapterSelection?.choice ?? "stub";
  const adapterReason = adapterSelection?.reason ?? "Meta adapter not initialised";

  const cache = getMetaBusinessCache();

  // Token expiry classification (warn 7 日前 / error 過ぎ).
  const expiry = oauth?.expiresAt ?? null;
  const now = Date.now();
  const expiryClass: "ok" | "warn" | "error" | null = expiry
    ? expiry.getTime() < now
      ? "error"
      : expiry.getTime() - now < 7 * 24 * 60 * 60 * 1000
        ? "warn"
        : "ok"
    : null;

  const oauthState: "ok" | "warn" | "error" =
    !dbReady
      ? "warn"
      : adapterChoice === "stub"
        ? "warn"
        : !oauth
          ? "warn"
          : expiryClass === "error"
            ? "error"
            : expiryClass === "warn"
              ? "warn"
              : "ok";

  const defaultAccount = accounts.find((a) => a.id === defaultAdAccountId) ?? null;

  const oauthQuery = single(resolvedSearchParams?.oauth);
  const reasonQuery = single(resolvedSearchParams?.reason);
  const accountsQuery = single(resolvedSearchParams?.accounts);
  const banner = renderBanner(oauthQuery, reasonQuery, accountsQuery);
  const pageDisplayTimeZone = resolveDisplayTimeZone();
  const reauthPagination = getPaginationState(
    resolvedSearchParams,
    "reauthPage",
    reauthTotal
  );

  return (
    <>
      <PageHeader
        title="広告アカウント"
        subtitle="Meta との接続、利用する広告アカウント、既定アカウントを確認します。"
      />

      <div className="page-body page-body--single">
        {banner}

        <Panel
          title="Meta 連携"
          subtitle="広告データを読み取るための接続状態"
          status={<StatusDot state={oauthState}>{oauthState}</StatusDot>}
        >
          {!oauth ? (
            <EmptyState
              title="Meta と未連携です。"
              description={
                adapterChoice === "stub"
                  ? `Meta 連携の準備が未完了です: ${adapterReason}。接続と健康状態を確認してください。`
                  : "Meta と接続してください。ブラウザ連携が使える場合は下のボタンから開始できます。"
              }
              action={
                adapterChoice === "real" || adapterChoice === "mock" ? (
                  <a className="btn btn--primary" href="/api/oauth/meta/begin">
                    Meta と接続
                  </a>
                ) : null
              }
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              <KeyValueList
                items={[
                  {
                    label: "接続先",
                    value: <InlineCode>{sanitizeForDisplay(oauth.accountIdentifier)}</InlineCode>,
                  },
                  {
                    label: "許可された範囲",
                    value:
                      oauth.scopes.length === 0 ? (
                        "—"
                      ) : (
                        <span className="mono">{sanitizeForDisplay(oauth.scopes.join(", "))}</span>
                      ),
                  },
                  {
                    label: "接続方式",
                    value: (
                      <StatusBadge
                        state={
                          adapterChoice === "real" || adapterChoice === "token"
                            ? "ok"
                            : adapterChoice === "mock"
                              ? "info"
                              : "warn"
                        }
                      >
                        {adapterChoice === "real" || adapterChoice === "token"
                          ? "本番"
                          : adapterChoice === "mock"
                            ? "テスト"
                            : "未設定"}
                      </StatusBadge>
                    ),
                  },
                  {
                    label: "接続日時",
                    value: (
                      <span className="tabular mono">
                        {formatDateTime(oauth.connectedAt, { timeZone: pageDisplayTimeZone })}
                      </span>
                    ),
                  },
                  {
                    label: "期限",
                    value: expiry ? (
                      <span className="tabular mono">
                        {formatDateTime(expiry, { timeZone: pageDisplayTimeZone })}
                        {expiryClass === "warn" ? " (もうすぐ期限切れ)" : ""}
                        {expiryClass === "error" ? " (期限切れ)" : ""}
                      </span>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    label: "安全性",
                    value: <>接続情報は画面やログに表示しません。</>,
                  },
                ]}
              />
              <ReauthButton
                expired={expiryClass === "error"}
                expiringSoon={expiryClass === "warn"}
                oauthRefreshAvailable={adapterChoice === "real" || adapterChoice === "mock"}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Meta Business"
          subtitle={
            cache
              ? `最終取得 ${formatDateTime(cache.fetchedAt, { timeZone: pageDisplayTimeZone })}`
              : "Meta と接続後に取得できます"
          }
          status={
            <RefreshBusinessesButton disabled={!oauth || adapterChoice === "stub"} />
          }
        >
          {!cache ? (
            <EmptyState
              title="Business 情報がまだ取得されていません。"
              description={
                !oauth
                  ? "Meta と接続すると自動で取得されます。"
                  : "右上の更新ボタンを押すと、最新の Business と広告アカウント一覧を取得します。"
              }
            />
          ) : (
            <DataTable
              rows={cache.businesses}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="取得できるBusinessはありません。"
                  description="広告アカウント一覧が取得できていれば、レポート取得や予算チェックは続行できます。Business情報が必要な場合だけ、Business側の割り当てと権限を確認してください。"
                />
              }
              columns={[
                { header: "ID", cell: (row) => row.id, className: "mono" },
                { header: "Name", cell: (row) => row.name },
                {
                  header: "Role",
                  cell: (row) => row.role ?? "—",
                  className: "mono",
                },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="利用する広告アカウント"
          subtitle={`${accounts.length} 件登録済み / 既定 = ${
            defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "未設定"
          }`}
          status={<AddAccountForm />}
        >
          {accounts.length === 0 ? (
            <EmptyState
              title="登録済みの Ad Account はありません。"
              description="Meta と連携すると、取得できた広告アカウントを自動で登録します。手動で追加するには右上の追加ボタンを使用してください。"
            />
          ) : (
            <SetDefaultAccountForm
              accounts={accounts.map((a) => ({
                id: a.id,
                key: a.key,
                displayName: a.displayName,
                metaAccountId: a.metaAccountId,
              }))}
              defaultAdAccountId={defaultAdAccountId}
            />
          )}
        </Panel>

        <Panel
          title="接続履歴"
          subtitle={`Meta への接続・更新 · ${paginationLabel(reauthPagination)}`}
        >
          <div>
            <DataTable
              rows={reauthEvents}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="再認証イベントはまだありません。"
                  description="Meta 接続・再認証・期限切れがここに記録されます。"
                />
              }
              columns={[
                {
                  header: "Time",
                  cell: (row) => formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
                  className: "tabular mono",
                  headerClassName: "tabular",
                },
                {
                  header: "Action",
                  cell: (row) => (
                    <StatusBadge
                      state={
                        row.action === "oauth.meta.refreshed"
                          ? "ok"
                          : row.action === "oauth.meta.connected"
                            ? "info"
                            : "warn"
                      }
                    >
                      {row.action}
                    </StatusBadge>
                  ),
                },
                { header: "実行者", cell: (row) => row.actor.startsWith("user:") ? "ユーザー" : row.actor },
                {
                  header: "Ref",
                  cell: (row) => row.ref ?? "—",
                  className: "mono",
                },
              ]}
            />
            <Pagination
              basePath="/accounts"
              searchParams={resolvedSearchParams}
              pageParam="reauthPage"
              state={reauthPagination}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

function renderBanner(
  oauth: string | undefined,
  reason: string | undefined,
  accounts: string | undefined
) {
  if (!oauth) return null;
  if (oauth === "error") {
    return (
      <div className="banner" data-state="error">
        <span className="banner__title">Meta 接続に失敗しました</span>
        <span>{reason ?? "詳細不明のエラー。/setup の Doctor 結果を確認してください。"}</span>
      </div>
    );
  }
  if (oauth === "connected") {
    const n = Number(accounts ?? "0");
    return (
      <div className="banner" data-state="ok">
        <span className="banner__title">Meta と接続しました。</span>
        <span>
          {Number.isFinite(n) && n > 0
            ? `${n} 件の Ad Account を新規登録しました。`
            : "新規登録された Ad Account はありませんでした (既存と一致)。"}
        </span>
      </div>
    );
  }
  return null;
}
