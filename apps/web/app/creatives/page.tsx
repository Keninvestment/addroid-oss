// AdDroid OSS — /creatives ページ (this implementation).
//
// 生成クリエイティブの一覧。
//
// データソース:
//   - prisma.creative.findMany — Account / Status / Provider フィルタを
//     query string から受けて適用。最新 60 件を表示。
//   - prisma.adAccount.findMany — Toolbar の Account select 用。
//   - 各行の thumbnail は metadata.json (LocalDisk) の先頭 asset を
//     /api/creatives/[id]/asset/[assetId] (proxy) 経由で取得して描画する。
//     Provider の signed URL を直接 src にしない (UI design plan principle 23)。
//
// 設計:
//   - 画像 Provider 未設定でも常に 200 OK で描画する (UI design plan §0.21)。
//   - 何も無いときは EmptyState で「画像 Provider なしでも動作する (任意)」
//     と説明する (creative_copy_rules)。
//   - storageRef が無い行 (= prompt-only fallback) は thumbnail を出さず、
//     `prompt-only` ラベルを出す。metadata.json が読めない (storage 未到達) は
//     `storage 未到達` のプレースホルダに倒す。
//   - 再生成 / 編集 / Meta 直接反映の導線は **置かない** (UI design plan §0.30
//     / creative_copy_rules)。

import Link from "next/link";
import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { StatusDot } from "../../components/ui/StatusDot";
import { InlineCode } from "../../components/ui/CodeBlock";
import {
  CreativesToolbar,
  type AccountOption,
  type ProviderOption,
} from "./CreativesToolbar";
import {
  creativeStatusToState,
  findAssetForCreativeRow,
  formatTimestamp,
  isCreativeStatus,
  readCreativeMetadataByRef,
  type CreativeStatus,
} from "../../lib/creative-helpers";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  accountId?: string | string[];
  status?: string | string[];
  provider?: string | string[];
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

interface CreativeRow {
  id: string;
  key: string;
  displayName: string;
  status: string;
  mediaType: string;
  provider: string | null;
  model: string | null;
  storageRef: string | null;
  storagePath: string | null;
  pullRequestId: string | null;
  aiRunId: string | null;
  creativeQaAiRunId: string | null;
  createdAt: Date;
  account: { id: string; key: string; displayName: string } | null;
  pullRequest: { number: number; htmlUrl: string | null; state: string } | null;
}

interface ResolvedThumb {
  assetId: string | null;
  width: number | null;
  height: number | null;
  storageReachable: boolean;
}

const TAKE = 60;

export default async function CreativesPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const accountIdParam = single(searchParams?.accountId) ?? null;
  const statusParam = (single(searchParams?.status) ?? "all").trim();
  const providerParam = (single(searchParams?.provider) ?? "all").trim();

  let dbReady = true;
  let accounts: AccountOption[] = [];
  let creatives: CreativeRow[] = [];
  let totalForAccount = 0;
  let providers: ProviderOption[] = [];

  try {
    const ws = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (ws) {
      const accountRows = await prisma.adAccount.findMany({
        where: { workspaceId: ws.id, active: true },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, key: true, displayName: true },
      });
      accounts = accountRows;
    }

    const where: Record<string, unknown> = {};
    if (accountIdParam) {
      where.accountId = accountIdParam;
    }
    if (statusParam !== "all" && isCreativeStatus(statusParam)) {
      where.status = statusParam;
    }
    if (providerParam === "__none__") {
      where.provider = null;
    } else if (providerParam !== "all") {
      where.provider = providerParam;
    }

    creatives = await prisma.creative.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: {
        id: true,
        key: true,
        displayName: true,
        status: true,
        mediaType: true,
        provider: true,
        model: true,
        storageRef: true,
        storagePath: true,
        pullRequestId: true,
        aiRunId: true,
        creativeQaAiRunId: true,
        createdAt: true,
        account: { select: { id: true, key: true, displayName: true } },
        pullRequest: { select: { number: true, htmlUrl: true, state: true } },
      },
    });

    totalForAccount = await prisma.creative.count({ where });

    // Toolbar の Provider dropdown 用 (現 account scope の distinct)。
    const providerRows = await prisma.creative.findMany({
      where: accountIdParam ? { accountId: accountIdParam } : {},
      distinct: ["provider"],
      select: { provider: true },
    });
    providers = providerRows
      .map((r) => r.provider)
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .sort()
      .map((p) => ({ value: p, label: p }));
  } catch {
    dbReady = false;
  }

  // metadata.json を並列で読み出して thumbnail 用 asset_id を解決する。
  // localhost の LocalDisk read は十分高速。失敗 (= storage 未到達) は
  // プレースホルダに倒す。
  //
  // regression fix: 各 Creative 行は metadata 内の特定 variant に対応する。
  // `findAssetForCreativeRow` が `storagePath` (per-asset 相対 path) で
  // metadata.assets を引き当てる。同一 metadata.json を共有する複数行が
  // 同じ asset を盲目的に指す回路を避ける。
  const thumbs = await Promise.all(
    creatives.map(async (row): Promise<ResolvedThumb> => {
      if (!row.storageRef) {
        return { assetId: null, width: null, height: null, storageReachable: false };
      }
      const metadata = await readCreativeMetadataByRef(row.storageRef);
      if (!metadata || metadata.assets.length === 0) {
        return { assetId: null, width: null, height: null, storageReachable: false };
      }
      const matched = findAssetForCreativeRow(metadata, {
        storagePath: row.storagePath,
      });
      if (!matched) {
        return { assetId: null, width: null, height: null, storageReachable: false };
      }
      return {
        assetId: matched.assetId,
        width: matched.width,
        height: matched.height,
        storageReachable: true,
      };
    })
  );

  const showingCount = creatives.length;
  const moreCount = Math.max(totalForAccount - showingCount, 0);

  return (
    <>
      <PageHeader
        title="生成クリエイティブ"
        subtitle={
          <>
            <InlineCode>improvement_pr</InlineCode> ワークフローが生成した広告
            クリエイティブの一覧。AdDroid は画像 Provider なしでも動作します
            (テキストプロンプトのみで PR を作成します)。生成画像は{" "}
            <InlineCode>storage://</InlineCode> 配下に保存され、PR を経由してのみ
            Meta に反映されます (本ページからは Meta への直接反映 / 再生成は
            行えません)。
          </>
        }
      />

      <div className="page-body page-body--single">
        <CreativesToolbar
          accounts={accounts}
          providers={providers}
          selectedAccountId={accountIdParam}
          selectedStatus={statusParam}
          selectedProvider={providerParam}
        />

        <Panel
          title="Creatives"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `creatives テーブル · ${totalForAccount} 件 (直近 ${showingCount} を表示${
                  moreCount > 0 ? ` / 他 ${moreCount} 件` : ""
                })`
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : showingCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "warn"
                : showingCount === 0
                  ? "no records yet"
                  : `${showingCount} creatives`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="creatives を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : creatives.length === 0 ? (
            <EmptyState
              title="まだ生成クリエイティブはありません"
              description={
                <>
                  <InlineCode>/improvements</InlineCode> から{" "}
                  <InlineCode>improvement_pr</InlineCode> を起動するか、画像
                  Provider (任意) を <InlineCode>~/.addroid/.env.local</InlineCode>{" "}
                  に設定すると、生成された creative がここに一覧表示されます。
                  画像 Provider 未設定でも improvement_pr はテキストプロンプト
                  のみで PR を作成し、creative 行は{" "}
                  <InlineCode>fallback_text_only</InlineCode> 状態で記録されます。
                </>
              }
            />
          ) : (
            <div className="creative-grid" data-testid="creative-grid">
              {creatives.map((row, i) => (
                <CreativeCard
                  key={row.id}
                  row={row}
                  thumb={thumbs[i] ?? {
                    assetId: null,
                    width: null,
                    height: null,
                    storageReachable: false,
                  }}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function CreativeCard({
  row,
  thumb,
}: {
  row: CreativeRow;
  thumb: ResolvedThumb;
}) {
  const status = row.status as CreativeStatus | string;
  const statusState = creativeStatusToState(status);
  const hasStorageRef = Boolean(row.storageRef);
  const showImage = hasStorageRef && thumb.assetId !== null;
  const showStorageMissing = hasStorageRef && !thumb.storageReachable;

  return (
    <Link
      href={`/creatives/${row.id}`}
      className="creative-card"
      data-testid="creative-card"
      data-status={row.status}
    >
      <div className="creative-card__thumb">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/creatives/${row.id}/asset/${thumb.assetId}`}
            alt={`creative ${row.displayName}`}
            width={160}
            height={160}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="creative-card__placeholder" aria-hidden="true">
            <span>{showStorageMissing ? "storage 未到達" : "no image"}</span>
          </div>
        )}
        {showStorageMissing ? (
          <div className="creative-card__overlay">
            <StatusBadge state="warn">storage 未到達</StatusBadge>
          </div>
        ) : null}
        {!hasStorageRef ? (
          <div className="creative-card__overlay">
            <StatusBadge state="idle">prompt-only</StatusBadge>
          </div>
        ) : null}
      </div>
      <div className="creative-card__meta">
        <div className="creative-card__row">
          <StatusBadge state={statusState}>{row.status}</StatusBadge>
        </div>
        <div className="creative-card__title" title={row.displayName}>
          {row.displayName}
        </div>
        <div className="creative-card__provider mono">
          {row.provider && row.model ? (
            <InlineCode>
              {row.provider}/{row.model}
            </InlineCode>
          ) : (
            <span className="creative-card__optional">画像 Provider 未設定</span>
          )}
        </div>
        {thumb.width && thumb.height ? (
          <div className="creative-card__dim mono">
            <InlineCode>
              {thumb.width}×{thumb.height}
            </InlineCode>
          </div>
        ) : null}
        <div className="creative-card__footer">
          <span className="creative-card__account mono">
            {row.account ? row.account.key : "—"}
          </span>
          <span className="creative-card__pr mono">
            {row.pullRequest ? `PR #${row.pullRequest.number}` : "未添付"}
          </span>
        </div>
        <div className="creative-card__time mono">
          {formatTimestamp(row.createdAt)}
        </div>
      </div>
    </Link>
  );
}
