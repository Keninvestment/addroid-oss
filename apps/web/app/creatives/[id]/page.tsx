// AdDroid OSS — /creatives/[id] ページ (this implementation).
//
// 単一 creative の詳細。プレビュー + 全 metadata + QA per-check breakdown +
// 関連 PR / improvement_run / ai_run / audit_logs を表示する。
//
// 設計:
//   - 画像バイナリは /api/creatives/[id]/asset/[assetId] proxy 経由でのみ表示する
//     (UI design plan principle 23)。
//   - storage://* ref は mono inline-code 表示。絶対 fs path は出さない (principle 24)。
//   - QA per-check (dimensions / format / quality / forbidden_expression /
//     brand_tone) を **必ず展開表示** する (principle 25 / creative_copy_rules)。
//   - 再生成 / 編集 / Meta 直接反映ボタンは置かない (principle 30)。
//   - metadata.json が読めない (storage 未到達) 場合は creatives テーブル単独の
//     情報を表示するフォールバックに倒す (principle 23)。

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { PageHeader } from "../../../components/ui/PageHeader";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StatusDot } from "../../../components/ui/StatusDot";
import { InlineCode, CodeBlock } from "../../../components/ui/CodeBlock";
import {
  KeyValueList,
  type KeyValueEntry,
} from "../../../components/ui/KeyValueList";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import {
  creativeStatusToState,
  formatBytes,
  formatDimensions,
  formatTimestamp,
  parseCreativeMetadata,
  parseCreativeParameters,
  parseCreativeSpec,
  qaOutcomeToState,
  qaOverallToState,
  readCreativeMetadataByRef,
  type CreativeMetadataDocument,
  type CreativeMetadataQaAsset,
  type CreativeMetadataQaCheck,
} from "../../../lib/creative-helpers";
import { sanitizeForDisplay } from "../../../lib/meta-runtime";

export const dynamic = "force-dynamic";

const CREATIVE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export default async function CreativeDetailPage({
  params,
}: {
  params: { id: string };
}) {
  if (!CREATIVE_ID_PATTERN.test(params.id)) {
    notFound();
  }

  let row;
  try {
    row = await prisma.creative.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        accountId: true,
        hierarchyId: true,
        aiRunId: true,
        creativeQaAiRunId: true,
        pullRequestId: true,
        key: true,
        displayName: true,
        mediaType: true,
        status: true,
        prompt: true,
        provider: true,
        model: true,
        parameters: true,
        storagePath: true,
        storageRef: true,
        externalId: true,
        spec: true,
        createdAt: true,
        updatedAt: true,
        account: {
          select: { id: true, key: true, displayName: true, metaAccountId: true },
        },
        hierarchy: {
          select: {
            id: true,
            nodeType: true,
            displayName: true,
            externalId: true,
          },
        },
        aiRun: {
          select: {
            id: true,
            agent: true,
            workflow: true,
            provider: true,
            model: true,
            status: true,
            decision: true,
            confidence: true,
            inputTokens: true,
            outputTokens: true,
            costUsd: true,
            createdAt: true,
          },
        },
        creativeQa: {
          select: {
            id: true,
            agent: true,
            workflow: true,
            provider: true,
            model: true,
            status: true,
            decision: true,
            confidence: true,
            inputTokens: true,
            outputTokens: true,
            costUsd: true,
            createdAt: true,
          },
        },
        pullRequest: {
          select: {
            id: true,
            number: true,
            title: true,
            state: true,
            htmlUrl: true,
            mergedAt: true,
            createdAt: true,
          },
        },
      },
    });
  } catch {
    return (
      <>
        <PageHeader title="Creative" />
        <div className="page-body page-body--single">
          <EmptyState
            title="creatives を読み出せません"
            description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
          />
        </div>
      </>
    );
  }

  if (!row) {
    notFound();
  }

  const metadata: CreativeMetadataDocument | null = row.storageRef
    ? await readCreativeMetadataByRef(row.storageRef)
    : null;

  // 関連 audit_logs (target = "creative:<id>") を引く。
  let auditRows: Array<{
    id: string;
    actor: string;
    action: string;
    target: string | null;
    ref: string | null;
    metadata: unknown;
    createdAt: Date;
  }> = [];
  try {
    auditRows = await prisma.auditLog.findMany({
      where: { target: `creative:${row.id}` },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        actor: true,
        action: true,
        target: true,
        ref: true,
        metadata: true,
        createdAt: true,
      },
    });
  } catch {
    /* noop — audit が無くても detail は描画する */
  }

  const spec = parseCreativeSpec(row.spec);
  const params2 = parseCreativeParameters(row.parameters);
  const statusState = creativeStatusToState(row.status);
  const overallQa = metadata?.qa.overall ?? null;
  const hasStorage = Boolean(row.storageRef);
  const storageReachable = metadata !== null;

  const overviewItems: KeyValueEntry[] = [
    { label: "Creative ID", value: <InlineCode>{row.id}</InlineCode>, mono: true },
    { label: "Key", value: <InlineCode>{row.key}</InlineCode>, mono: true },
    { label: "Display name", value: <span>{row.displayName}</span> },
    {
      label: "Status",
      value: <StatusBadge state={statusState}>{row.status}</StatusBadge>,
    },
    { label: "Media type", value: <InlineCode>{row.mediaType}</InlineCode>, mono: true },
    {
      label: "Account",
      value: row.account ? (
        <span>
          <InlineCode>{row.account.key}</InlineCode> — {row.account.displayName}
          {row.account.metaAccountId ? (
            <>
              {" "}
              <span style={{ color: "var(--color-text-secondary)" }}>
                (<InlineCode>{row.account.metaAccountId}</InlineCode>)
              </span>
            </>
          ) : null}
        </span>
      ) : (
        <span>—</span>
      ),
    },
    {
      label: "Hierarchy node",
      value: row.hierarchy ? (
        <span>
          <InlineCode>{row.hierarchy.nodeType}</InlineCode> · {row.hierarchy.displayName}
          {row.hierarchy.externalId ? (
            <>
              {" "}
              <InlineCode>{row.hierarchy.externalId}</InlineCode>
            </>
          ) : null}
        </span>
      ) : (
        <span>—</span>
      ),
    },
    {
      label: "Provider / model",
      value:
        row.provider && row.model ? (
          <InlineCode>
            {row.provider}/{row.model}
          </InlineCode>
        ) : (
          <span style={{ color: "var(--color-text-secondary)" }}>
            画像 Provider 未設定 (任意) — prompt-only
          </span>
        ),
    },
    {
      label: "Storage ref",
      value: row.storageRef ? (
        <InlineCode>{row.storageRef}</InlineCode>
      ) : (
        <span style={{ color: "var(--color-text-secondary)" }}>
          未保存 (prompt-only fallback)
        </span>
      ),
      mono: true,
    },
    {
      label: "Created",
      value: (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatTimestamp(row.createdAt)}
        </span>
      ),
    },
    {
      label: "Updated",
      value: (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatTimestamp(row.updatedAt)}
        </span>
      ),
    },
    {
      label: "External ID (Meta)",
      value: row.externalId ? (
        <InlineCode>{row.externalId}</InlineCode>
      ) : (
        <span style={{ color: "var(--color-text-secondary)" }}>
          まだ Meta には反映されていません
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={
          <span>
            Creative · <span style={{ fontFamily: "var(--font-mono)" }}>{row.id.slice(0, 12)}…</span>
          </span>
        }
        subtitle={
          <>
            <Link
              href="/creatives"
              style={{ color: "var(--color-accent)" }}
            >
              ← 一覧に戻る
            </Link>
            {"  ·  "}
            生成画像は PR を経由してのみ Meta に反映されます。本ページからは
            Meta への直接反映 / 再生成は行えません (再生成は{" "}
            <InlineCode>/improvements</InlineCode> から{" "}
            <InlineCode>improvement_pr</InlineCode> を起動)。
          </>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="Preview"
          subtitle={
            !hasStorage
              ? "prompt-only fallback — 画像 Provider 未設定 / 失敗のため画像はありません"
              : !storageReachable
                ? "storage 未到達 — metadata.json が見つかりません"
                : `${metadata?.assets.length ?? 0} variant`
          }
          status={
            <StatusDot
              state={
                !hasStorage
                  ? "idle"
                  : !storageReachable
                    ? "warn"
                    : qaOverallToState(overallQa ?? "fallback_text_only")
              }
            >
              {!hasStorage
                ? "prompt-only"
                : !storageReachable
                  ? "storage 未到達"
                  : (overallQa ?? "—")}
            </StatusDot>
          }
        >
          {!hasStorage ? (
            <EmptyState
              title="画像はありません (prompt-only fallback)"
              description={
                <>
                  画像 Provider 未設定 / 失敗のため、improvement_pr は
                  テキストプロンプトのみで PR を作成しました。GitOps polling /
                  Apply / Cron は通常通り稼働しています。
                </>
              }
            />
          ) : !storageReachable ? (
            <EmptyState
              title="storage 上に metadata.json が見つかりません"
              description={
                <>
                  storage ref:{" "}
                  <InlineCode>{row.storageRef ?? ""}</InlineCode>
                  。Storage Adapter (LocalDisk) から metadata.json を読み出せません。
                  生成バイナリが削除された / 別ホストで生成された可能性があります。
                </>
              }
            />
          ) : (
            <div className="creative-detail__previews">
              {metadata!.assets.map((asset) => (
                <figure key={asset.assetId} className="creative-detail__preview">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/creatives/${row.id}/asset/${asset.assetId}`}
                    alt={`creative ${row.displayName} variant ${asset.variantKey}`}
                    width={asset.width || 360}
                    height={asset.height || 360}
                    loading="lazy"
                    decoding="async"
                    style={{
                      maxWidth: "100%",
                      height: "auto",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  />
                  <figcaption className="creative-detail__preview-caption">
                    <div>
                      <StatusBadge state={qaOverallToState(asset.qaOverall)}>
                        {asset.qaOverall}
                      </StatusBadge>
                    </div>
                    <div className="mono">
                      <InlineCode>variantKey={asset.variantKey}</InlineCode>
                    </div>
                    <div className="mono">
                      <InlineCode>{asset.mimeType}</InlineCode> ·{" "}
                      <InlineCode>{formatDimensions(asset.width, asset.height)}</InlineCode>{" "}
                      · {formatBytes(asset.byteSize)}
                    </div>
                    <div className="mono" style={{ wordBreak: "break-all" }}>
                      <InlineCode>{asset.storageRef}</InlineCode>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Overview"
          subtitle="creatives テーブル + linkage"
          status={<StatusDot state={statusState}>{row.status}</StatusDot>}
        >
          <KeyValueList items={overviewItems} />
        </Panel>

        <Panel
          title="Prompt"
          subtitle="image_prompt エージェントが生成したプロンプト本文 + 補足"
        >
          {spec.prompt || row.prompt || metadata?.prompt ? (
            <CodeBlock>
              {sanitizeForDisplay(
                spec.prompt ?? row.prompt ?? metadata?.prompt ?? ""
              )}
            </CodeBlock>
          ) : (
            <EmptyState
              title="プロンプトは記録されていません"
              description="creatives.spec.prompt にも metadata.json にもプロンプト本文がありません。"
            />
          )}
          {spec.negativePrompt ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.25rem",
                }}
              >
                Negative prompt
              </div>
              <CodeBlock>{sanitizeForDisplay(spec.negativePrompt)}</CodeBlock>
            </div>
          ) : null}
          {spec.styleNotes ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.25rem",
                }}
              >
                Style notes
              </div>
              <p style={{ margin: 0 }}>{spec.styleNotes}</p>
            </div>
          ) : null}
          {spec.rationale ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.25rem",
                }}
              >
                Rationale
              </div>
              <p style={{ margin: 0 }}>{spec.rationale}</p>
            </div>
          ) : null}
        </Panel>

        <Panel
          title="Generation parameters"
          subtitle="image_prompt 出力 + image-Provider 渡しパラメータ"
        >
          {params2.purpose || params2.variationConditions.length > 0 ? (
            <KeyValueList
              items={[
                {
                  label: "Purpose",
                  value: params2.purpose ? (
                    <span>{params2.purpose}</span>
                  ) : (
                    <span>—</span>
                  ),
                },
                {
                  label: "Variant count",
                  value: (
                    <span className="tabular-nums">
                      {metadata?.variantCount ?? params2.variationConditions.length}
                    </span>
                  ),
                },
                {
                  label: "Variation conditions",
                  value:
                    params2.variationConditions.length === 0 ? (
                      <span>—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                        {params2.variationConditions.map((c, i) => {
                          const dims = formatDimensions(
                            c.width ?? 0,
                            c.height ?? 0
                          );
                          const fmt = c.format ?? "png";
                          const label = c.variantKey ?? `variant-${i + 1}`;
                          return (
                            <li key={i}>
                              <InlineCode>{label}</InlineCode>
                              <span className="tabular-nums">
                                {" "}
                                — {dims} {fmt}
                              </span>
                              {c.styleNotes ? (
                                <div
                                  style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.8125rem",
                                  }}
                                >
                                  style: {c.styleNotes}
                                </div>
                              ) : null}
                              {c.negativePrompt ? (
                                <div
                                  style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.8125rem",
                                  }}
                                >
                                  negative: {c.negativePrompt}
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ),
                },
                ...(metadata
                  ? [
                      {
                        label: "Cost (USD)",
                        value: (
                          <span
                            className="tabular-nums"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            ${metadata.costUsd.toFixed(6)}
                          </span>
                        ),
                      },
                      {
                        label: "Generated at",
                        value: (
                          <span
                            className="tabular-nums"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            {formatTimestamp(metadata.generatedAt)}
                          </span>
                        ),
                      },
                      {
                        label: "Provider request ID",
                        value: metadata.requestId ? (
                          <InlineCode>{metadata.requestId}</InlineCode>
                        ) : (
                          <span>—</span>
                        ),
                        mono: true,
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <EmptyState
              title="生成パラメータは記録されていません"
              description="creatives.parameters が空のため、画像 Provider に渡された variation conditions / purpose がありません (prompt-only fallback の典型)。"
            />
          )}
        </Panel>

        <Panel
          title="Creative QA"
          subtitle={
            metadata
              ? `dimensions / format / quality / forbidden_expression / brand_tone — overall: ${metadata.qa.overall}`
              : spec.qa
                ? "creatives.spec.qa の short summary"
                : "QA 結果は記録されていません"
          }
          status={
            <StatusDot
              state={
                metadata
                  ? qaOverallToState(metadata.qa.overall)
                  : spec.qa
                    ? "info"
                    : "idle"
              }
            >
              {metadata
                ? metadata.qa.overall
                : spec.qa
                  ? spec.qa.recommendation ?? "summary"
                  : "no qa"}
            </StatusDot>
          }
        >
          {metadata && metadata.qa.assets.length > 0 ? (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList
                items={[
                  {
                    label: "Overall",
                    value: (
                      <StatusBadge state={qaOverallToState(metadata.qa.overall)}>
                        {metadata.qa.overall}
                      </StatusBadge>
                    ),
                  },
                  {
                    label: "Passing assets",
                    value: (
                      <span className="tabular-nums">
                        {metadata.qa.passingCount} / {metadata.qa.assets.length}
                      </span>
                    ),
                  },
                  {
                    label: "Failing assets",
                    value: (
                      <span className="tabular-nums">
                        {metadata.qa.failingCount}
                      </span>
                    ),
                  },
                ]}
              />
              {metadata.qa.assets.map((asset) => (
                <QaAssetBlock key={asset.variantKey} asset={asset} />
              ))}
            </div>
          ) : spec.qa ? (
            <KeyValueList
              items={[
                {
                  label: "Recommendation",
                  value: spec.qa.recommendation ? (
                    <InlineCode>{spec.qa.recommendation}</InlineCode>
                  ) : (
                    <span>—</span>
                  ),
                },
                {
                  label: "Issues",
                  value:
                    spec.qa.issues.length === 0 ? (
                      <span>—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                        {spec.qa.issues.map((issue, i) => (
                          <li key={i}>
                            <StatusBadge
                              state={
                                issue.severity === "blocking"
                                  ? "error"
                                  : issue.severity === "non_blocking"
                                    ? "warn"
                                    : "info"
                              }
                            >
                              {issue.severity}
                            </StatusBadge>{" "}
                            <InlineCode>{issue.category}</InlineCode> —{" "}
                            {issue.message}
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  label: "Rationale",
                  value: spec.qa.rationale ? (
                    <span>{spec.qa.rationale}</span>
                  ) : (
                    <span>—</span>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState
              title="QA 結果は記録されていません"
              description="creatives.spec.qa にも metadata.json にも QA breakdown がありません (storage 未到達 / prompt-only fallback)。"
            />
          )}
        </Panel>

        <Panel
          title="Linked records"
          subtitle="ai_run / improvement_run / pull_request / hierarchy"
        >
          <KeyValueList
            items={[
              {
                label: "Image Prompt ai_run",
                value: row.aiRun ? (
                  <span>
                    <InlineCode>{row.aiRun.id}</InlineCode>{" "}
                    <StatusBadge state="info">{row.aiRun.agent}</StatusBadge>{" "}
                    <InlineCode>
                      {row.aiRun.provider}/{row.aiRun.model}
                    </InlineCode>{" "}
                    <StatusBadge
                      state={
                        row.aiRun.status === "succeeded"
                          ? "ok"
                          : row.aiRun.status === "failed"
                            ? "error"
                            : row.aiRun.status === "running"
                              ? "info"
                              : "idle"
                      }
                    >
                      {row.aiRun.status}
                    </StatusBadge>{" "}
                    <span
                      className="tabular-nums"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      ${row.aiRun.costUsd.toFixed(6)}
                    </span>
                  </span>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
              {
                label: "Creative QA ai_run",
                value: row.creativeQa ? (
                  <span>
                    <InlineCode>{row.creativeQa.id}</InlineCode>{" "}
                    <StatusBadge state="info">{row.creativeQa.agent}</StatusBadge>{" "}
                    <InlineCode>
                      {row.creativeQa.provider}/{row.creativeQa.model}
                    </InlineCode>{" "}
                    <StatusBadge
                      state={
                        row.creativeQa.status === "succeeded"
                          ? "ok"
                          : row.creativeQa.status === "failed"
                            ? "error"
                            : row.creativeQa.status === "running"
                              ? "info"
                              : "idle"
                      }
                    >
                      {row.creativeQa.status}
                    </StatusBadge>{" "}
                    <span
                      className="tabular-nums"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      ${row.creativeQa.costUsd.toFixed(6)}
                    </span>
                  </span>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
              {
                label: "Pull request",
                value: row.pullRequest ? (
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
                    </StatusBadge>{" "}
                    {row.pullRequest.title}
                  </span>
                ) : (
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    未添付 (PR 添付前)
                  </span>
                ),
              },
              {
                label: "Improvement run",
                value: metadata?.links.improvementRunId ? (
                  <InlineCode>{metadata.links.improvementRunId}</InlineCode>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
              {
                label: "Storage path (internal)",
                value: row.storagePath ? (
                  <InlineCode>{row.storagePath}</InlineCode>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
            ]}
          />
        </Panel>

        <Panel
          title="Audit trail"
          subtitle={`audit_logs (target="creative:${row.id}") · ${auditRows.length} 件`}
          status={
            <StatusDot state={auditRows.length === 0 ? "idle" : "ok"}>
              {auditRows.length === 0 ? "no records" : `${auditRows.length} records`}
            </StatusDot>
          }
        >
          <DataTable
            rows={auditRows}
            rowKey={(r) => r.id}
            columns={auditColumns}
            empty={
              <EmptyState
                title="この creative に紐付く audit はまだありません"
                description="creative.generated / creative.qa_passed / creative.qa_failed / creative.attached_to_pr 等の audit_log が書かれるとここに表示されます。"
              />
            }
          />
        </Panel>
      </div>
    </>
  );
}

const auditColumns: DataTableColumn<{
  id: string;
  actor: string;
  action: string;
  target: string | null;
  ref: string | null;
  metadata: unknown;
  createdAt: Date;
}>[] = [
  {
    header: "Created",
    cell: (r) => (
      <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
        {formatTimestamp(r.createdAt)}
      </span>
    ),
    className: "tabular mono",
    headerClassName: "tabular",
  },
  {
    header: "Actor",
    cell: (r) => <InlineCode>{sanitizeForDisplay(r.actor)}</InlineCode>,
  },
  {
    header: "Action",
    cell: (r) => <InlineCode>{r.action}</InlineCode>,
  },
  {
    header: "Ref",
    cell: (r) =>
      r.ref ? <InlineCode>{sanitizeForDisplay(r.ref)}</InlineCode> : <span>—</span>,
  },
];

function QaAssetBlock({ asset }: { asset: CreativeMetadataQaAsset }) {
  return (
    <details
      className="qa-asset"
      open
      style={{
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        padding: "0.875rem 1rem",
        background: "var(--color-bg-subtle)",
      }}
      data-testid="qa-asset"
      data-variant-key={asset.variantKey}
    >
      <summary
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          cursor: "pointer",
          fontSize: "0.9375rem",
          fontWeight: 500,
        }}
      >
        <StatusBadge state={qaOverallToState(asset.overall)}>
          {asset.overall}
        </StatusBadge>
        <InlineCode>variantKey={asset.variantKey}</InlineCode>
        <span style={{ color: "var(--color-text-secondary)", fontSize: "0.8125rem" }}>
          {asset.checks.length} check{asset.checks.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div style={{ marginTop: "0.75rem" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Severity</th>
              <th scope="col">Outcome</th>
              <th scope="col">Detail</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {asset.checks.map((c) => (
              <QaCheckRow key={c.kind} check={c} />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function QaCheckRow({ check }: { check: CreativeMetadataQaCheck }) {
  return (
    <tr data-testid="qa-check" data-kind={check.kind} data-outcome={check.outcome}>
      <td className="mono">
        <InlineCode>{check.kind}</InlineCode>
      </td>
      <td>
        <StatusBadge
          state={
            check.severity === "blocking"
              ? "error"
              : check.severity === "non_blocking"
                ? "warn"
                : "info"
          }
        >
          {check.severity}
        </StatusBadge>
      </td>
      <td>
        <StatusBadge state={qaOutcomeToState(check.outcome)}>
          {check.outcome}
        </StatusBadge>
      </td>
      <td>{check.detail || <span>—</span>}</td>
      <td className="mono">
        {check.evidence ? (
          <InlineCode>{sanitizeForDisplay(check.evidence)}</InlineCode>
        ) : (
          <span>—</span>
        )}
      </td>
    </tr>
  );
}
