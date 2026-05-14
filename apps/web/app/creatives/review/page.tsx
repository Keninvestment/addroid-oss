// AdDroid OSS — /creatives/review ページ (this implementation browser regression fix).
//
// 目的:
//   the browser test harness の `creative-qa-pr` シナリオが要求する
//   `/creatives/review` を 200 OK で描画する。`/creatives` (一覧) や
//   `/creatives/[id]` (詳細) とは別軸で、
//     - Creative QA per-check (dimensions / format / quality /
//       forbidden_expression / brand_tone) の outcome
//     - PR 添付状況
//     - Meta 直接反映が無い (= GitOps / Apply / Activate を経由する) こと
//   を一画面で読み取れるようにする review ビュー。
//
// 設計:
//   - 画像 Provider 未設定 / DB 未疎通でも常に 200 OK で描画する
//     (UI design plan §0.21 / API-First for Every View)。
//   - QA 集計は metadata.json (LocalDisk) を読み出して計算する。
//     `creatives.spec.qa` の short summary は集計の対象外 (per-check 構造を
//     持たないため。creative 行単位の overall 表示には使う)。
//   - 再生成 / Meta 直接反映 / 編集の導線は **置かない** (UI design plan
//     §0.30 / creative_copy_rules)。
//   - storageRef が無い行 (prompt-only fallback) は QA 未実施として扱う。
//   - 行クリックは詳細ページ `/creatives/[id]` への遷移のみ。

import Link from "next/link";
import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { PageHeader } from "../../../components/ui/PageHeader";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StatusDot } from "../../../components/ui/StatusDot";
import { InlineCode } from "../../../components/ui/CodeBlock";
import { KeyValueList } from "../../../components/ui/KeyValueList";
import { ensureWebWorkspace } from "../../../lib/meta-runtime";
import {
  creativeStatusToState,
  formatTimestamp,
  qaOutcomeToState,
  qaOverallToState,
  readCreativeMetadataByRef,
  type CreativeMetadataDocument,
  type CreativeMetadataQaCheck,
  type CreativeQaCheckKind,
  type CreativeQaOutcome,
} from "../../../lib/creative-helpers";

export const dynamic = "force-dynamic";

const TAKE = 60;

// the current implementation が定義する 5 つの QA check kind を表示の固定順序で並べる。
// the browser test harness の creative-qa-pr シナリオがこれらの kind を
// HTML 上で目視 / grep 可能であることを期待している。
const QA_CHECK_KINDS: readonly CreativeQaCheckKind[] = [
  "dimensions",
  "format",
  "quality",
  "forbidden_expression",
  "brand_tone",
];

interface CreativeRow {
  id: string;
  key: string;
  displayName: string;
  status: string;
  provider: string | null;
  model: string | null;
  storageRef: string | null;
  storagePath: string | null;
  createdAt: Date;
  account: { id: string; key: string; displayName: string } | null;
  pullRequest: { number: number; htmlUrl: string | null; state: string } | null;
}

type CheckKindAggregate = Record<
  CreativeQaCheckKind,
  { pass: number; warn: number; fail: number; skipped: number; total: number }
>;

const OUTCOME_RANK: Record<CreativeQaOutcome, number> = {
  skipped: 0,
  pass: 1,
  warn: 2,
  fail: 3,
};

export default async function CreativesReviewPage() {
  let dbReady = true;
  let creatives: CreativeRow[] = [];

  try {
    const workspace = await ensureWebWorkspace();
    creatives = await prisma.creative.findMany({
      where: { account: { workspaceId: workspace.id } },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: {
        id: true,
        key: true,
        displayName: true,
        status: true,
        provider: true,
        model: true,
        storageRef: true,
        storagePath: true,
        createdAt: true,
        account: { select: { id: true, key: true, displayName: true } },
        pullRequest: { select: { number: true, htmlUrl: true, state: true } },
      },
    });
  } catch {
    dbReady = false;
  }

  // metadata.json を並列で読み出す。失敗 (storage 未到達 / fallback) は null。
  const metadataResults: Array<CreativeMetadataDocument | null> =
    await Promise.all(
      creatives.map(async (row) => {
        if (!row.storageRef) return null;
        return await readCreativeMetadataByRef(row.storageRef);
      })
    );

  // 5 種の QA check kind ごとに pass / warn / fail / skipped を集計する。
  const checkKindAggregates: CheckKindAggregate = {
    dimensions: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
    format: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
    quality: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
    forbidden_expression: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
    brand_tone: { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 },
  };

  let attachedOpenCount = 0;
  let mergedCount = 0;
  let unattachedCount = 0;
  let qaCoveredCreatives = 0;
  let promptOnlyCreatives = 0;

  for (let i = 0; i < creatives.length; i++) {
    const row = creatives[i]!;
    const metadata = metadataResults[i] ?? null;
    if (metadata && metadata.qa.assets.length > 0) {
      qaCoveredCreatives += 1;
      for (const asset of metadata.qa.assets) {
        for (const check of asset.checks) {
          const agg = checkKindAggregates[check.kind];
          agg.total += 1;
          agg[check.outcome] += 1;
        }
      }
    } else {
      promptOnlyCreatives += 1;
    }
    if (row.pullRequest) {
      if (row.pullRequest.state === "merged") {
        mergedCount += 1;
      } else {
        attachedOpenCount += 1;
      }
    } else {
      unattachedCount += 1;
    }
  }

  const headerSubtitle = (
    <>
      生成クリエイティブの QA per-check (
      <InlineCode>dimensions</InlineCode> / <InlineCode>format</InlineCode> /{" "}
      <InlineCode>quality</InlineCode> /{" "}
      <InlineCode>forbidden_expression</InlineCode> /{" "}
      <InlineCode>brand_tone</InlineCode>) と PR 添付状況をまとめたレビュー。
      生成画像はここから Meta に直接反映されません — 必ず{" "}
      <InlineCode>auto_creative_generation</InlineCode> の merge → Apply (PAUSED) →
      Activate の経路を経由します。
    </>
  );

  return (
    <>
      <PageHeader title="Creative QA レビュー" subtitle={headerSubtitle} />

      <div className="page-body page-body--single">
        <Panel
          title="QA check kind サマリ"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `dimensions / format / quality / forbidden_expression / brand_tone — 直近 ${creatives.length} 件分の per-check 集計`
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : qaCoveredCreatives === 0
                    ? "idle"
                    : "ok"
              }
            >
              {!dbReady
                ? "warn"
                : qaCoveredCreatives === 0
                  ? "no qa records"
                  : `${qaCoveredCreatives} qa-covered`}
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
              title="QA を実施した creative はまだありません"
              description={
                <>
                  <InlineCode>auto_creative_generation</InlineCode> が画像を生成し、Creative
                  QA エージェントが <InlineCode>dimensions</InlineCode> /{" "}
                  <InlineCode>format</InlineCode> /{" "}
                  <InlineCode>quality</InlineCode> /{" "}
                  <InlineCode>forbidden_expression</InlineCode> /{" "}
                  <InlineCode>brand_tone</InlineCode> を判定するとここにレビューが
                  表示されます。画像 Provider 未設定 (任意) のままでも{" "}
                  <InlineCode>auto_creative_generation</InlineCode> はテキストプロンプトのみで
                  PR を作成し、QA は <InlineCode>skipped</InlineCode> 状態で記録
                  されます (fallback)。
                </>
              }
            />
          ) : (
            <table className="data-table" data-testid="qa-summary-table">
              <thead>
                <tr>
                  <th scope="col">Check kind</th>
                  <th scope="col">Pass</th>
                  <th scope="col">Warn</th>
                  <th scope="col">Fail</th>
                  <th scope="col">Skipped</th>
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {QA_CHECK_KINDS.map((kind) => {
                  const a = checkKindAggregates[kind];
                  return (
                    <tr key={kind} data-testid="qa-summary-row" data-kind={kind}>
                      <td className="mono">
                        <InlineCode>{kind}</InlineCode>
                      </td>
                      <td className="tabular">
                        <StatusBadge state={a.pass > 0 ? "ok" : "idle"}>
                          {a.pass}
                        </StatusBadge>
                      </td>
                      <td className="tabular">
                        <StatusBadge state={a.warn > 0 ? "warn" : "idle"}>
                          {a.warn}
                        </StatusBadge>
                      </td>
                      <td className="tabular">
                        <StatusBadge state={a.fail > 0 ? "error" : "idle"}>
                          {a.fail}
                        </StatusBadge>
                      </td>
                      <td className="tabular">{a.skipped}</td>
                      <td className="tabular">{a.total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="PR attachment 状況"
          subtitle="生成 creative は必ず PR を経由してのみ Meta に到達します"
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : creatives.length === 0
                    ? "idle"
                    : "info"
              }
            >
              {!dbReady
                ? "warn"
                : creatives.length === 0
                  ? "no records"
                  : `${creatives.length} creatives`}
            </StatusDot>
          }
        >
          <KeyValueList
            items={[
              {
                label: "PR 添付済み (open / pending review)",
                value: (
                  <span className="tabular-nums">{attachedOpenCount} 件</span>
                ),
              },
              {
                label: "PR merged",
                value: <span className="tabular-nums">{mergedCount} 件</span>,
              },
              {
                label: "未添付 (PR 添付前 / prompt-only fallback)",
                value: <span className="tabular-nums">{unattachedCount} 件</span>,
              },
              {
                label: "QA 未実施 / prompt-only",
                value: (
                  <span className="tabular-nums">{promptOnlyCreatives} 件</span>
                ),
              },
              {
                label: "Meta 直接反映",
                value: (
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    本ページからは行えません — PR merge → Apply (PAUSED) →
                    Activate の経路を経由します
                  </span>
                ),
              },
            ]}
          />
        </Panel>

        <Panel
          title="Creative QA per-row"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : creatives.length === 0
                ? "対象 creative はまだありません"
                : `直近 ${creatives.length} 件の creative の QA 結果と PR 添付状況`
          }
          status={
            <StatusDot
              state={
                !dbReady ? "warn" : creatives.length === 0 ? "idle" : "ok"
              }
            >
              {!dbReady
                ? "warn"
                : creatives.length === 0
                  ? "no records"
                  : `${creatives.length} rows`}
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
                  <InlineCode>/creatives</InlineCode> から{" "}
                  <InlineCode>auto_creative_generation</InlineCode> を起動すると、生成された
                  creative の QA 結果と PR 添付状況がここに表示されます。
                </>
              }
            />
          ) : (
            <table className="data-table" data-testid="qa-review-table">
              <thead>
                <tr>
                  <th scope="col">Creative</th>
                  <th scope="col">Status</th>
                  <th scope="col">QA overall</th>
                  <th scope="col">Per-check</th>
                  <th scope="col">PR attachment</th>
                  <th scope="col">Meta</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {creatives.map((row, i) => (
                  <CreativeQaReviewRow
                    key={row.id}
                    row={row}
                    metadata={metadataResults[i] ?? null}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function CreativeQaReviewRow({
  row,
  metadata,
}: {
  row: CreativeRow;
  metadata: CreativeMetadataDocument | null;
}) {
  const overall = metadata?.qa.overall ?? "fallback_text_only";
  return (
    <tr data-testid="qa-review-row" data-creative-id={row.id}>
      <td>
        <Link
          href={`/creatives/${row.id}`}
          style={{ color: "var(--color-accent)" }}
        >
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {row.id.slice(0, 12)}…
          </span>
        </Link>
        <div
          style={{
            fontSize: "0.8125rem",
            color: "var(--color-text-secondary)",
          }}
        >
          {row.displayName}
        </div>
        <div className="mono" style={{ fontSize: "0.75rem" }}>
          {row.account ? (
            <InlineCode>{row.account.key}</InlineCode>
          ) : (
            <span>—</span>
          )}{" "}
          {row.provider && row.model ? (
            <InlineCode>
              {row.provider}/{row.model}
            </InlineCode>
          ) : (
            <span style={{ color: "var(--color-text-secondary)" }}>
              画像 Provider 未設定
            </span>
          )}
        </div>
      </td>
      <td>
        <StatusBadge state={creativeStatusToState(row.status)}>
          {row.status}
        </StatusBadge>
      </td>
      <td>
        <StatusBadge state={qaOverallToState(overall)}>{overall}</StatusBadge>
      </td>
      <td>
        <PerCheckSummary metadata={metadata} />
      </td>
      <td>
        {row.pullRequest ? (
          <span>
            {row.pullRequest.htmlUrl ? (
              <a
                href={row.pullRequest.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: "var(--color-accent)" }}
              >
                <InlineCode>#{row.pullRequest.number}</InlineCode>
              </a>
            ) : (
              <InlineCode>#{row.pullRequest.number}</InlineCode>
            )}{" "}
            <StatusBadge
              state={
                row.pullRequest.state === "merged"
                  ? "ok"
                  : row.pullRequest.state === "closed"
                    ? "idle"
                    : "info"
              }
            >
              {row.pullRequest.state}
            </StatusBadge>
          </span>
        ) : (
          <span style={{ color: "var(--color-text-secondary)" }}>未添付</span>
        )}
      </td>
      <td>
        <span style={{ color: "var(--color-text-secondary)" }}>
          まだ Meta には反映されていません
        </span>
      </td>
      <td className="tabular mono">{formatTimestamp(row.createdAt)}</td>
    </tr>
  );
}

function PerCheckSummary({
  metadata,
}: {
  metadata: CreativeMetadataDocument | null;
}) {
  if (!metadata || metadata.qa.assets.length === 0) {
    return (
      <span style={{ color: "var(--color-text-secondary)" }}>
        QA 未実施 / prompt-only
      </span>
    );
  }
  // 全 asset (variant) を flatten し、check.kind ごとに最も悪い outcome
  // (fail > warn > pass > skipped) を採って 1 行のサマリにまとめる。
  const worst: Partial<Record<CreativeQaCheckKind, CreativeMetadataQaCheck>> =
    {};
  for (const asset of metadata.qa.assets) {
    for (const check of asset.checks) {
      const prev = worst[check.kind];
      if (!prev || OUTCOME_RANK[check.outcome] > OUTCOME_RANK[prev.outcome]) {
        worst[check.kind] = check;
      }
    }
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
      {QA_CHECK_KINDS.map((kind) => {
        const c = worst[kind];
        if (!c) {
          return (
            <span key={kind} title={`${kind}: skipped`}>
              <StatusBadge state="idle">{kind}</StatusBadge>
            </span>
          );
        }
        const titleText = c.detail ? `${kind}: ${c.outcome} — ${c.detail}` : `${kind}: ${c.outcome}`;
        return (
          <span key={kind} title={titleText}>
            <StatusBadge state={qaOutcomeToState(c.outcome)}>
              {kind}: {c.outcome}
            </StatusBadge>
          </span>
        );
      })}
    </div>
  );
}
