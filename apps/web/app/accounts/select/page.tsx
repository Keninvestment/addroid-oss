// AdDroid OSS — Meta 接続後の Ad Account 既定選択ページ。

import Link from "next/link";
import { prisma } from "../../../lib/prisma";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PageHeader } from "../../../components/ui/PageHeader";
import { Panel } from "../../../components/ui/Panel";
import { SetDefaultAccountForm } from "../SetDefaultAccountForm";
import { ensureWebWorkspace } from "../../../lib/meta-runtime";
import { firstSearchParam } from "../../../lib/search-params";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  oauth?: string | string[];
  accounts?: string | string[];
}

export default async function SelectAccountPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  const currentWorkspace = await ensureWebWorkspace();
  const ws = await prisma.workspace.findUnique({
    where: { id: currentWorkspace.id },
    select: { defaultAdAccountId: true },
  });
  const accounts = ws
    ? await prisma.adAccount.findMany({
        where: { workspaceId: currentWorkspace.id },
        orderBy: [{ active: "desc" }, { displayName: "asc" }, { key: "asc" }],
        select: {
          id: true,
          key: true,
          displayName: true,
          metaAccountId: true,
          businessName: true,
          currency: true,
          timezoneName: true,
        },
      })
    : [];

  const oauth = firstSearchParam(resolvedSearchParams?.oauth);
  const count = Number(firstSearchParam(resolvedSearchParams?.accounts) ?? "0");

  return (
    <>
      <PageHeader
        title="Select Meta Ad Account"
        subtitle="Meta Access Token で取得できた Ad Account から、実行時に使う既定アカウントを選択します。"
      />
      <div className="page-body page-body--single">
        {oauth === "connected" ? (
          <div className="banner" data-state="ok">
            <span className="banner__title">Meta と接続しました。</span>
            <span>
              {Number.isFinite(count) && count > 0
                ? `${count} 件の広告アカウントを新規登録しました。`
                : "取得済みの広告アカウントを同期しました。"}
            </span>
          </div>
        ) : null}

        <Panel
          title="既定の広告アカウント"
          subtitle={`登録済み ${accounts.length} 件 / 現在の既定 = ${
            accounts.find((a) => a.id === ws?.defaultAdAccountId)?.metaAccountId ?? "未設定"
          }`}
          status={
            <Link className="btn btn--secondary" href="/accounts">
              広告アカウント
            </Link>
          }
        >
          {accounts.length === 0 ? (
            <EmptyState
              title="選択できる広告アカウントがありません。"
              description="Meta と再接続するか、手動で広告アカウントを追加してください。"
              action={
                <Link className="btn btn--primary" href="/accounts">
                  広告アカウント
                </Link>
              }
            />
          ) : (
            <SetDefaultAccountForm
              accounts={accounts.map((a) => ({
                id: a.id,
                key: a.key,
                displayName: [
                  a.displayName,
                  a.businessName ? `(${a.businessName})` : null,
                  a.currency ? `[${a.currency}]` : null,
                  a.timezoneName ? a.timezoneName : null,
                ]
                  .filter(Boolean)
                  .join(" "),
                metaAccountId: a.metaAccountId,
              }))}
              defaultAdAccountId={ws?.defaultAdAccountId ?? null}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
