// AdDroid OSS — /approvals/[prNumber] (this implementation).
//
// 単一 PR のプレビュー画面。Title / body / file diff / 紐付く ai_run /
// linked improvement_pr / 承認履歴 を表示し、Web UI からのマージボタンを置く。
// マージは ConfirmDialog (caution) を経由し、merge 成功時に
// approval_records / audit_logs を `web_merge` ソース付きで記録する。

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { PageHeader } from "../../../components/ui/PageHeader";
import { KeyValueList, type KeyValueEntry } from "../../../components/ui/KeyValueList";
import { DataTable } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StatusDot, type StatusState } from "../../../components/ui/StatusDot";
import { CodeBlock, InlineCode } from "../../../components/ui/CodeBlock";
import { MergePrButton } from "./MergePrButton";
import { formatDateTime, resolveDisplayTimeZone } from "../../../lib/datetime";
import { ensureWebWorkspace } from "../../../lib/github-runtime";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ prNumber: string }>;
}

interface ApprovalRow {
  id: string;
  decision: string;
  approvedBy: string;
  comment: string | null;
  createdAt: Date;
  decisionSource: string | null;
}

// regression fix: github_pull_requests.filesChangedJson の正規化済み shape。
// publisher 側 (apps/worker/src/lib/improvement-pr-runtime.ts の
// summarizeFilesForPreview) が書き込む形と一対一で対応する。
interface FileChangePreviewEntry {
  path: string;
  action: "create" | "update" | "delete";
  diffPreview: string;
  diffTruncated: boolean;
  diffByteLength: number;
  additions: number;
  deletions: number;
}

interface FileChangePreview {
  files: FileChangePreviewEntry[];
  truncatedFileCount: number;
  totalFileCount: number;
}

function readFilesChangedJson(value: unknown): FileChangePreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const filesRaw = Array.isArray(obj["files"]) ? obj["files"] : null;
  if (!filesRaw) return null;
  const files: FileChangePreviewEntry[] = [];
  for (const entry of filesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const path = typeof e["path"] === "string" ? e["path"] : null;
    const action =
      e["action"] === "create" || e["action"] === "update" || e["action"] === "delete"
        ? (e["action"] as "create" | "update" | "delete")
        : null;
    if (!path || !action) continue;
    files.push({
      path,
      action,
      diffPreview: typeof e["diffPreview"] === "string" ? e["diffPreview"] : "",
      diffTruncated: e["diffTruncated"] === true,
      diffByteLength:
        typeof e["diffByteLength"] === "number" ? e["diffByteLength"] : 0,
      additions: typeof e["additions"] === "number" ? e["additions"] : 0,
      deletions: typeof e["deletions"] === "number" ? e["deletions"] : 0,
    });
  }
  return {
    files,
    truncatedFileCount:
      typeof obj["truncatedFileCount"] === "number"
        ? (obj["truncatedFileCount"] as number)
        : 0,
    totalFileCount:
      typeof obj["totalFileCount"] === "number"
        ? (obj["totalFileCount"] as number)
        : files.length,
  };
}

function actionBadgeState(
  action: "create" | "update" | "delete"
): "ok" | "info" | "warn" | "error" | "idle" {
  if (action === "create") return "ok";
  if (action === "update") return "info";
  return "error";
}

function approvalState(decision: string | null): StatusState {
  if (decision === "approved" || decision === "auto_approved") return "ok";
  if (decision === "auto_blocked" || decision === "rejected") return "error";
  return "warn";
}

function readDecisionSource(metadata: unknown): string | null {
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "decisionSource" in (metadata as Record<string, unknown>)
  ) {
    const v = (metadata as Record<string, unknown>).decisionSource;
    if (typeof v === "string") return v;
  }
  return null;
}

export default async function ApprovalDetailPage({ params }: PageParams) {
  const { prNumber: prNumberRaw } = await params;
  const prNumber = Number.parseInt(prNumberRaw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    notFound();
  }

  const workspace = await ensureWebWorkspace().catch(() => null);
  if (!workspace) {
    notFound();
  }

  const pr = await prisma.githubPullRequest
    .findFirst({
      where: {
        number: prNumber,
        repo: { workspace: { is: { id: workspace.id } } },
      },
      orderBy: { polledAt: "desc" },
      select: {
        id: true,
        repoId: true,
        number: true,
        title: true,
        state: true,
        headSha: true,
        baseRef: true,
        htmlUrl: true,
        mergedAt: true,
        polledAt: true,
        createdAt: true,
        updatedAt: true,
        body: true,
        filesChangedJson: true,
        filesChangedCount: true,
        previewSource: true,
        previewUpdatedAt: true,
        repo: {
          select: {
            owner: true,
            name: true,
            defaultBranch: true,
            branchProtectionApplied: true,
          },
        },
        approvalRecords: {
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            decision: true,
            approvedBy: true,
            comment: true,
            createdAt: true,
            metadata: true,
          },
        },
      },
    })
    .catch(() => null);

  if (!pr) {
    notFound();
  }

  // 関連 ai_run / improvement_pr を audit_logs から逆引きする (linked_ref=PR ID)。
  let linkedAiRunId: string | null = null;
  let linkedImprovementPrAuditAt: Date | null = null;
  try {
    const aiRun = await prisma.aiRun.findFirst({
      where: {
        workspaceId: workspace.id,
        OR: [
          { linkedRefType: "github_pull_request", linkedRefId: pr.id },
          { linkedRefType: "improvement_pr", linkedRefId: pr.id },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    if (aiRun) {
      linkedAiRunId = aiRun.id;
      linkedImprovementPrAuditAt = aiRun.createdAt;
    }
  } catch {
    /* ai_runs テーブル未反映なら無視 */
  }

  const approvals: ApprovalRow[] = pr.approvalRecords.map((row) => ({
    id: row.id,
    decision: row.decision,
    approvedBy: row.approvedBy,
    comment: row.comment,
    createdAt: row.createdAt,
    decisionSource: readDecisionSource(row.metadata),
  }));

  const latestDecision = approvals[0]?.decision ?? null;
  const latestSource = approvals[0]?.decisionSource ?? null;
  const pageDisplayTimeZone = resolveDisplayTimeZone();

  const canMerge =
    pr.state === "open" &&
    latestDecision !== "rejected" &&
    latestDecision !== "auto_blocked";

  const mergeBlockedReason = (() => {
    if (pr.state === "merged") return "この PR は既にマージ済みです。";
    if (pr.state === "closed") return "この PR は閉じられているためマージできません。";
    if (latestDecision === "rejected") {
      return "approval_records.decision=rejected が記録されているためマージできません。";
    }
    if (latestDecision === "auto_blocked") {
      return "approval_records.decision=auto_blocked が記録されているためマージできません (上流の policy が拒否)。";
    }
    return null;
  })();

  const overviewItems: KeyValueEntry[] = [
    {
      label: "PR",
      value: (
        <span className="mono">
          #{pr.number} · {pr.repo.owner}/{pr.repo.name}
        </span>
      ),
    },
    { label: "Title", value: pr.title },
    {
      label: "State",
      value: (
        <StatusBadge
          state={
            pr.state === "merged"
              ? "ok"
              : pr.state === "closed"
                ? "idle"
                : "info"
          }
        >
          {pr.state}
        </StatusBadge>
      ),
    },
    { label: "Base", value: <InlineCode>{pr.baseRef}</InlineCode> },
    { label: "変更ID", value: <InlineCode>{pr.headSha}</InlineCode> },
    {
      label: "Branch protection",
      value: (
        <StatusBadge
          state={pr.repo.branchProtectionApplied ? "ok" : "warn"}
        >
          {pr.repo.branchProtectionApplied ? "applied" : "not applied"}
        </StatusBadge>
      ),
    },
    {
      label: "Latest decision",
      value: (
        <StatusBadge state={approvalState(latestDecision)}>
          {latestDecision ?? "pending"}
        </StatusBadge>
      ),
    },
    {
      label: "Decision source",
      value: latestSource ? (
        <InlineCode>{latestSource}</InlineCode>
      ) : (
        <span className="mono">—</span>
      ),
    },
    {
      label: "Polled",
      value: (
        <span className="tabular mono">
          {formatDateTime(pr.polledAt, { timeZone: pageDisplayTimeZone })}
        </span>
      ),
    },
    {
      label: "Merged",
      value: pr.mergedAt ? (
        <span className="tabular mono">
          {formatDateTime(pr.mergedAt, { timeZone: pageDisplayTimeZone })}
        </span>
      ) : (
        <span className="mono">—</span>
      ),
    },
    {
      label: "GitHub URL",
      value: pr.htmlUrl ? (
        <a href={pr.htmlUrl} target="_blank" rel="noreferrer" className="mono">
          {pr.htmlUrl}
        </a>
      ) : (
        <span className="mono">—</span>
      ),
    },
    {
      label: "関連するAI実行",
      value: linkedAiRunId ? (
        <InlineCode>{linkedAiRunId}</InlineCode>
      ) : (
        <span className="mono">—</span>
      ),
    },
  ];

  const filesPreview = readFilesChangedJson(pr.filesChangedJson);
  const previewSource = pr.previewSource;
  const previewUpdatedAt = pr.previewUpdatedAt;
  const persistedFileCount = pr.filesChangedCount ?? null;
  const previewSubtitleParts: string[] = [];
  if (previewSource) previewSubtitleParts.push(`source=${previewSource}`);
  if (previewUpdatedAt) {
    previewSubtitleParts.push(
      `captured=${formatDateTime(previewUpdatedAt, { timeZone: pageDisplayTimeZone })}`
    );
  }
  const previewSubtitle =
    previewSubtitleParts.length > 0 ? previewSubtitleParts.join(" · ") : null;

  return (
    <>
      <PageHeader
        title={`PR #${pr.number}`}
        subtitle={
          <>
            <InlineCode>{pr.repo.owner}/{pr.repo.name}</InlineCode>{" "}
            の承認前プレビュー。内容を確認してから承認できます。
          </>
        }
        actions={
          <Link href="/approvals" className="btn">
            ← 一覧に戻る
          </Link>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="概要"
          subtitle="変更の状態と承認可否"
          status={
            <StatusDot state={approvalState(latestDecision)}>
              {latestDecision ?? "pending"}
            </StatusDot>
          }
        >
          <KeyValueList items={overviewItems} />
        </Panel>

        <Panel
          title="変更内容の説明"
          subtitle={
            previewSubtitle ?? "GitHub に作成された説明文"
          }
          status={
            <StatusDot state={pr.body ? "info" : "idle"}>
              {pr.body
                ? `${pr.body.length} chars`
                : "未収集"}
            </StatusDot>
          }
        >
          {pr.body ? (
            <CodeBlock>{pr.body}</CodeBlock>
          ) : (
            <EmptyState
              title="PR 本文は未収集です。"
              description="GitHub 側のリンクから内容を確認してください。"
            />
          )}
        </Panel>

        <Panel
          title="変更ファイル一覧"
          subtitle={
            previewSubtitle
              ? `${previewSubtitle}${
                  persistedFileCount != null
                    ? ` · ${persistedFileCount} ファイル`
                    : ""
                }`
              : "変更されたファイルの概要"
          }
          status={
            <StatusDot
              state={filesPreview && filesPreview.files.length > 0 ? "info" : "idle"}
            >
              {filesPreview
                ? `${filesPreview.files.length} / ${filesPreview.totalFileCount} 表示`
                : "未収集"}
            </StatusDot>
          }
        >
          {!filesPreview || filesPreview.files.length === 0 ? (
            <EmptyState
              title="変更ファイル情報は未収集です。"
              description="GitHub 側のリンクから変更ファイルを確認してください。"
            />
          ) : (
            <>
              <DataTable
                rows={filesPreview.files}
                rowKey={(row) => row.path}
                empty={null}
                columns={[
                  {
                    header: "変更種別",
                    cell: (row) => (
                      <StatusBadge state={actionBadgeState(row.action)}>
                        {row.action}
                      </StatusBadge>
                    ),
                  },
                  {
                    header: "ファイル",
                    cell: (row) => <InlineCode>{row.path}</InlineCode>,
                    className: "mono",
                  },
                  {
                    header: "+/-",
                    cell: (row) => (
                      <span className="tabular mono">
                        +{row.additions} / -{row.deletions}
                      </span>
                    ),
                    className: "tabular mono",
                    headerClassName: "tabular",
                  },
                  {
                    header: "差分サイズ",
                    cell: (row) => (
                      <span className="tabular mono">
                        {row.diffByteLength}
                        {row.diffTruncated ? " (切詰)" : ""}
                      </span>
                    ),
                    className: "tabular mono",
                    headerClassName: "tabular",
                  },
                ]}
              />
              {filesPreview.truncatedFileCount > 0 ? (
                <p
                  style={{
                    marginTop: "var(--space-3)",
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  他 {filesPreview.truncatedFileCount} 件があります (50 ファイルまで表示)
                </p>
              ) : null}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
                {filesPreview.files.slice(0, 5).map((file) => (
                  <details key={`diff-${file.path}`}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.8125rem",
                      }}
                    >
                      {file.action} · {file.path}
                      {file.diffTruncated ? " (diff 切詰)" : ""}
                    </summary>
                    <CodeBlock>{file.diffPreview || "(empty diff)"}</CodeBlock>
                  </details>
                ))}
                {filesPreview.files.length > 5 ? (
                  <p
                    style={{
                      fontSize: "0.8125rem",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    diff の展開は先頭 5 ファイルまで。残り {filesPreview.files.length - 5} 件はテーブルで概要を確認してください。
                  </p>
                ) : null}
              </div>
            </>
          )}
        </Panel>

        <Panel title="承認して反映待ちにする" subtitle="確認ダイアログを通して実行します">
          {!canMerge ? (
            <EmptyState
              title="この PR は Web UI からマージできません。"
              description={
                mergeBlockedReason ?? "現在のステータスではマージは許可されていません。"
              }
            />
          ) : (
            <MergePrButton
              prNumber={pr.number}
              prTitle={pr.title}
              repoFullName={`${pr.repo.owner}/${pr.repo.name}`}
              expectedHeadSha={pr.headSha}
              branchProtectionApplied={pr.repo.branchProtectionApplied}
              htmlUrl={pr.htmlUrl}
            />
          )}
        </Panel>

        <Panel
          title="承認履歴"
          subtitle={`${approvals.length} 件`}
        >
          <DataTable
            rows={approvals}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="承認・拒否の決定はまだありません。"
                description="この変更に対する承認・拒否はまだ記録されていません。"
              />
            }
            columns={[
              {
                header: "日時",
                cell: (row) => formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
                className: "tabular mono",
                headerClassName: "tabular",
              },
              {
                header: "判断",
                cell: (row) => (
                  <StatusBadge state={approvalState(row.decision)}>
                    {row.decision}
                  </StatusBadge>
                ),
              },
              { header: "実行者", cell: (row) => row.approvedBy, className: "mono" },
              {
                header: "承認元",
                cell: (row) => row.decisionSource ?? "—",
                className: "mono",
              },
              {
                header: "コメント",
                cell: (row) => row.comment ?? "—",
              },
            ]}
          />
        </Panel>

        {linkedAiRunId ? (
          <Panel
            title="関連 AI 実行"
            subtitle="この変更の作成元になったAI処理"
          >
            <KeyValueList
              items={[
                {
                  label: "AI実行ID",
                  value: <InlineCode>{linkedAiRunId}</InlineCode>,
                },
                {
                  label: "開始日時",
                    value: linkedImprovementPrAuditAt ? (
                      <span className="tabular mono">
                        {formatDateTime(linkedImprovementPrAuditAt, { timeZone: pageDisplayTimeZone })}
                      </span>
                  ) : (
                    <span className="mono">—</span>
                  ),
                },
              ]}
            />
          </Panel>
        ) : null}
      </div>
    </>
  );
}
