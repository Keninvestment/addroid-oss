// AdDroid OSS — /accounts ページ.
//
// Meta OAuth 接続状態、Business 一覧 (runtime cache 由来)、登録済み Ad Account 一覧、
// デフォルトアカウント選択、再認証フロー、再認証履歴 を 1 ページに集約する。
//
// 設計原則:
//   - すべての値は Prisma クエリまたは runtime cache 由来 (No Placeholder Data)。
//   - 表示直前にトークン由来の文字列を sanitize する (二重防御)。
//   - PAUSED-by-default のため status カラムは敢えて出さない。Activate は別ページ。

import { prisma } from "../../lib/prisma";
import {
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
import { PageHeader } from "../../components/ui/PageHeader";
import { InlineCode } from "../../components/ui/CodeBlock";
import { AddAccountForm } from "./AddAccountForm";
import { SetDefaultAccountForm } from "./SetDefaultAccountForm";
import { ReauthButton } from "./ReauthButton";
import { RefreshBusinessesButton } from "./RefreshBusinessesButton";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  oauth?: string | string[];
  reason?: string | string[];
  accounts?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
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
  let dbReady = true;

  try {
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true, defaultAdAccountId: true },
    });
    if (ws) {
      defaultAdAccountId = ws.defaultAdAccountId ?? null;
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
          where: { workspaceId: ws.id },
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
          where: {
            workspaceId: ws.id,
            action: {
              in: [
                "oauth.meta.connected",
                "oauth.meta.refreshed",
                "oauth.meta.reauth_required",
              ],
            },
          },
          orderBy: { createdAt: "desc" },
          take: 10,
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

  const oauthQuery = single(searchParams?.oauth);
  const reasonQuery = single(searchParams?.reason);
  const accountsQuery = single(searchParams?.accounts);
  const banner = renderBanner(oauthQuery, reasonQuery, accountsQuery);

  return (
    <>
      <PageHeader
        title="Meta Accounts"
        subtitle="Meta Login for Business 接続、Business 一覧、Ad Account の登録、デフォルト切替、再認証。"
      />

      <div className="page-body page-body--single">
        {banner}

        <Panel
          title="Meta Connection"
          subtitle="oauth_tokens テーブルから読み取った接続情報"
          status={<StatusDot state={oauthState}>{oauthState}</StatusDot>}
        >
          {!oauth ? (
            <EmptyState
              title="Meta と未連携です。"
              description={
                adapterChoice === "stub"
                  ? `Meta OAuth が未設定です: ${adapterReason}。addroid init で Meta App ID / App Secret を設定してください。どちらも暗号化されて保存されます。`
                  : "下のボタンから Meta OAuth を開始してください。OAuth client は ~/.addroid/secrets.local.yaml の暗号化済み設定を参照します。"
              }
              action={
                adapterChoice !== "stub" ? (
                  <a className="btn btn--primary" href="/api/oauth/meta/begin">
                    Connect Meta
                  </a>
                ) : null
              }
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              <KeyValueList
                items={[
                  {
                    label: "Account",
                    value: <InlineCode>{sanitizeForDisplay(oauth.accountIdentifier)}</InlineCode>,
                  },
                  {
                    label: "Scopes",
                    value:
                      oauth.scopes.length === 0 ? (
                        "—"
                      ) : (
                        <span className="mono">{sanitizeForDisplay(oauth.scopes.join(", "))}</span>
                      ),
                  },
                  {
                    label: "Adapter",
                    value: (
                      <StatusBadge state={adapterChoice === "real" ? "ok" : adapterChoice === "mock" ? "info" : "warn"}>
                        {adapterChoice}
                      </StatusBadge>
                    ),
                  },
                  {
                    label: "Connected",
                    value: <span className="tabular mono">{oauth.connectedAt.toISOString()}</span>,
                  },
                  {
                    label: "Expires",
                    value: expiry ? (
                      <span className="tabular mono">
                        {expiry.toISOString()}
                        {expiryClass === "warn" ? " (もうすぐ期限切れ)" : ""}
                        {expiryClass === "error" ? " (期限切れ)" : ""}
                      </span>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    label: "Token Injection",
                    value: (
                      <>
                        公式 Meta CLI 互換 ENV (<InlineCode>ACCESS_TOKEN</InlineCode> /{" "}
                        <InlineCode>AD_ACCOUNT_ID</InlineCode>) のみ。
                        コマンドライン引数・ログには出力しません。
                      </>
                    ),
                  },
                ]}
              />
              <ReauthButton
                expired={expiryClass === "error"}
                expiringSoon={expiryClass === "warn"}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Businesses"
          subtitle={
            cache
              ? `Meta GraphQL から取得 · 最終取得 ${cache.fetchedAt.toISOString()}`
              : "Meta GraphQL の runtime cache (再起動後は再取得が必要)"
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
                  : "右上の「Refresh Businesses」を押すと /me/businesses と /me/adaccounts を再取得します。"
              }
            />
          ) : (
            <DataTable
              rows={cache.businesses}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="Business は取得できませんでした。"
                  description="権限が不足している可能性があります。再認証してください。"
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
          title="Registered Ad Accounts"
          subtitle={`ad_accounts テーブル · ${accounts.length} 件 / default = ${
            defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "未設定"
          }`}
          status={<AddAccountForm />}
        >
          {accounts.length === 0 ? (
            <EmptyState
              title="登録済みの Ad Account はありません。"
              description="Meta と連携すると、Meta GraphQL から取得した Ad Account を自動で登録します。手動で追加するには右上の Add account を使用してください。"
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
          title="Reauth History"
          subtitle="audit_logs テーブル · oauth.meta.* イベントの直近 10 件"
        >
          <DataTable
            rows={reauthEvents}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="再認証イベントはまだありません。"
                description="Meta OAuth の接続・再認証・期限切れがここに記録されます。"
              />
            }
            columns={[
              {
                header: "Time",
                cell: (row) => row.createdAt.toISOString(),
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
              { header: "Actor", cell: (row) => row.actor },
              {
                header: "Ref",
                cell: (row) => row.ref ?? "—",
                className: "mono",
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
  reason: string | undefined,
  accounts: string | undefined
) {
  if (!oauth) return null;
  if (oauth === "error") {
    return (
      <div className="banner" data-state="error">
        <span className="banner__title">Meta OAuth に失敗しました</span>
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
