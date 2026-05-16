import { prisma } from "../../../lib/prisma";
import { ensureWebWorkspace } from "../../../lib/meta-runtime";
import { PageHeader } from "../../../components/ui/PageHeader";
import { Panel } from "../../../components/ui/Panel";
import { EmptyState } from "../../../components/ui/EmptyState";
import { DashboardChatPanel } from "../../DashboardChatPanel";
import { parseCreativeSpec } from "../../../lib/creative-helpers";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  creativeId?: string | string[];
}

export default async function CreativeSubmitPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const workspace = await ensureWebWorkspace();
  const resolvedSearchParams = await searchParams;
  const selectedCreativeIds = readSelectedCreativeIds(resolvedSearchParams?.creativeId);
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId: workspace.id, active: true },
    orderBy: [{ createdAt: "asc" }],
    select: { key: true, displayName: true, currency: true },
  });
  const selectedCreatives =
    selectedCreativeIds.length > 0
      ? await prisma.creative.findMany({
          where: {
            id: { in: selectedCreativeIds },
            account: { workspaceId: workspace.id },
          },
          select: {
            id: true,
            displayName: true,
            status: true,
            mediaType: true,
            storagePath: true,
            storageRef: true,
            pullRequestId: true,
            spec: true,
            account: { select: { key: true, displayName: true } },
            pullRequest: { select: { number: true, htmlUrl: true } },
          },
        })
      : [];
  const selectedById = new Map(selectedCreatives.map((creative) => [creative.id, creative]));
  const orderedSelectedCreatives = selectedCreativeIds
    .map((id) => selectedById.get(id))
    .filter((row): row is (typeof selectedCreatives)[number] => Boolean(row));
  const selectedContext = formatSelectedCreativeContext(orderedSelectedCreatives);
  const selectedInitialInput =
    orderedSelectedCreatives.length === 1
      ? `Creative ID ${orderedSelectedCreatives[0]!.id} を入稿PRに回したい。足りない配信先情報を確認して。`
      : orderedSelectedCreatives.length > 1
        ? `選択済みの ${orderedSelectedCreatives.length} 件のCreativeをすべて入稿PRに回したい。キャンペーン・広告セットの指定、または新規作成条件を確認して。`
        : undefined;

  return (
    <>
      <PageHeader
        title="クリエイティブ入稿"
        subtitle="素材、コピー、配信先をまとめて PR 化します。Meta への反映は承認後です。"
      />
      <div className="page-body page-body--single">
        <Panel title="入稿内容" subtitle="GitOps PR と dry-run plan を作成">
          {accounts.length === 0 ? (
            <EmptyState
              title="広告アカウントがありません"
              description="先に Meta 接続とアカウント同期を完了してください。"
            />
          ) : (
            <DashboardChatPanel
              surface="creative-submit"
              title="クリエイティブ入稿チャット"
              description="キャンペーン作成、広告セット作成、既存広告セットへの広告作成を会話で進めます。足りない情報はエージェントが確認します。"
              emptyText="素材を添付して「この画像で既存広告セットに広告を作って」や「新規キャンペーンから作りたい」と入力してください。Meta への反映は GitHub PR の承認後です。"
              badge="GitOps PR"
              examples={[
                ...(orderedSelectedCreatives.length > 0
                  ? ["選択済みのCreativeをすべて既存広告セットに入稿PR化したい。足りない情報を確認して。"]
                  : []),
                "添付した画像で、既存の広告セットに新しい広告を追加したい。配信先は一緒に確認してほしい。",
                "新しいキャンペーンから作りたい。目的はサイトへのアクセス、日予算は 500 円、配信国は日本。",
                "既存キャンペーンの設定をコピーして、別クリエイティブで新規入稿したい。",
              ]}
              placeholder="例: 添付画像で春セール広告を作りたい。足りない情報は質問して"
              contextPrefix={[
                "この画面は Meta 広告クリエイティブ入稿専用です。",
                `利用可能な広告アカウント: ${accounts
                  .map((a) => `${a.key} (${[a.displayName, a.currency].filter(Boolean).join(" / ")})`)
                  .join(", ")}`,
                selectedContext,
                "/creatives の Creative ID を指定して生成済みクリエイティブをPRに回す場合は promote_creative_submission を使ってください。",
                orderedSelectedCreatives.length > 1
                  ? `複数Creativeはユーザーがすでに選択済みです。どれを使うかは質問せず、creativeIds=${JSON.stringify(orderedSelectedCreatives.map((creative) => creative.id))} を指定して、選択済みの全Creativeを同じ配信条件で入稿PR化してください。確認が必要なのは campaignId/adsetId、既存キャンペーン配下の新規adset、または新規campaign/adset 作成条件です。`
                  : null,
                "ユーザーがクリエイティブ生成、素材添付、広告作成、広告セット作成、キャンペーン作成を依頼したら propose_creative_submission を使います。",
                "添付画像を参考にして新しい画像を生成する依頼では referenceImagePaths を使い、添付画像そのものを最終広告素材にする依頼でのみ localMediaPaths を使ってください。",
                "遷移先URLが依頼文にある場合は linkUrl に入れてください。",
                "予算は広告アカウント通貨の金額として扱い、dailyBudget / lifetimeBudget に入れてください。JPY アカウントで 500 円/日なら dailyBudget: 500 です。",
                "Meta Ads CLI 2026/04/29 で反映できる範囲だけPR化します。ターゲティングは countries のみ対応です。年齢、地域半径、配信面、デバイス、Advantage audience、カスタムオーディエンス、PROFILE_VISIT、VIEW_INSTAGRAM_PROFILE はPRに含めず、ユーザーに反映できない旨を説明してください。",
                "不足している placement、campaignId/adsetId、campaignName/adsetName、objective、予算、pageId、対応済み optimizationGoal、billingEvent、コピー、対応済みCTA、国ターゲティングはツール実行前に短く質問してください。",
                "Meta へ直接変更せず、必ず GitOps PR と dry-run の経路を使ってください。",
              ].filter(Boolean).join("\n")}
              initialInput={selectedInitialInput}
              allowAttachments
            />
          )}
        </Panel>
      </div>
    </>
  );
}

function readSelectedCreativeIds(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(
    new Set(
      raw
        .flatMap((item) => item.split(","))
        .map((item) => item.trim())
        .filter((item) => /^[A-Za-z0-9-]{1,64}$/.test(item))
    )
  ).slice(0, 8);
}

function formatSelectedCreativeContext(
  creatives: Array<{
    id: string;
    displayName: string;
    status: string;
    mediaType: string;
    storagePath: string | null;
    storageRef: string | null;
    pullRequestId: string | null;
    spec: unknown;
    account: { key: string; displayName: string } | null;
    pullRequest: { number: number; htmlUrl: string | null } | null;
  }>
): string | null {
  if (creatives.length === 0) return null;
  return [
    "選択中の /creatives 候補:",
    ...creatives.map((creative, index) => {
      const spec = parseCreativeSpec(creative.spec);
      const adText = spec.adText;
      return [
        `- candidate ${index + 1}: creativeId=${creative.id}`,
        `displayName=${creative.displayName}`,
        `account=${creative.account?.key ?? "unknown"} (${creative.account?.displayName ?? "unknown"})`,
        `status=${creative.status}`,
        `mediaType=${creative.mediaType}`,
        creative.storagePath ? "hasMedia=true" : "hasMedia=false",
        creative.pullRequest
          ? `alreadyAttachedToPr=${creative.pullRequest.number}`
          : "alreadyAttachedToPr=false",
        adText?.headline ? `headline=${adText.headline}` : null,
        adText?.primaryText ? `primaryText=${adText.primaryText}` : null,
        adText?.description ? `description=${adText.description}` : null,
        adText?.callToAction ? `callToAction=${adText.callToAction}` : null,
      ]
        .filter(Boolean)
        .join("; ");
    }),
  ].join("\n");
}
