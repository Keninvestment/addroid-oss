// AdDroid OSS — Meta 接続後の Ad Account 既定選択ページ。

import Link from "next/link";
import { prisma } from "../../../lib/prisma";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PageHeader } from "../../../components/ui/PageHeader";
import { Panel } from "../../../components/ui/Panel";
import { SetDefaultAccountForm } from "../SetDefaultAccountForm";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  oauth?: string | string[];
  accounts?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function SelectAccountPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const ws = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, defaultAdAccountId: true },
  });
  const accounts = ws
    ? await prisma.adAccount.findMany({
        where: { workspaceId: ws.id },
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

  const oauth = single(searchParams?.oauth);
  const count = Number(single(searchParams?.accounts) ?? "0");

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
                ? `${count} 件の Ad Account を新規登録しました。`
                : "取得済みの Ad Account を同期しました。"}
            </span>
          </div>
        ) : null}

        <Panel
          title="Default Ad Account"
          subtitle={`登録済み ${accounts.length} 件 / 現在の既定 = ${
            accounts.find((a) => a.id === ws?.defaultAdAccountId)?.metaAccountId ?? "未設定"
          }`}
          status={
            <Link className="btn btn--secondary" href="/accounts">
              Accounts
            </Link>
          }
        >
          {accounts.length === 0 ? (
            <EmptyState
              title="選択できる Ad Account がありません。"
              description="CLI で `addroid connect meta` を再実行するか、手動で Ad Account を追加してください。"
              action={
                <Link className="btn btn--primary" href="/accounts">
                  Accounts
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
