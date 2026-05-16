// AdDroid OSS — POST /api/approvals/[prNumber]/merge (this implementation).
//
// Web UI の "PR をマージする (Web UI)" ボタン (ConfirmDialog 通過後) から呼ばれる。
//
// 受入基準 (the current implementation):
//   - Web UI からのマージは GitHub merge と等価で、approval_records と
//     audit_logs に "web_merge" ソースを記録する。
//   - actor は サーバー側で固定する (`user:web-ui`)。クライアントから渡される
//     actor は無視する (the current implementation activate と同じ regression fix 方針)。
//   - PR が "open" でない、もしくは approval_records に既に rejected /
//     auto_blocked が記録されている場合は 409 で拒否する。
//   - CSRF 防止のため、信頼済み Web UI ヘッダー付きの同一オリジン JSON POST だけを
//     受け付け、UI が表示した expectedHeadSha を必須にする。
//   - 失敗時はエラー詳細を返し、UI が Toast + inline error で再試行可能にする。
//
// regression fix: Web UI マージは GitHub への副作用が走る前に fail-closed する。
// `approval_records` (decisionSource="web_merge") と `audit_logs`
// (`pr.merge_via_web_attempted`) を 1 トランザクションで先に書き込み、書き込みに
// 失敗した場合は GitHub merge 自体を呼ばない。後段の `github_poll` は同 PR の
// merge 検知時に prior `approved` 行 (= web_merge 由来) を見つけ、そこに新しい
// `auto_approved` を被せず attribution を保存する (github-poll.ts 側の対応)。
// この設計により「監査が欠けたまま GitHub だけ merge されてしまい、後段で
// `addroid` が auto_approve してしまう」経路を遮断する。
//
// Apply pipeline の起動は次回 github_poll cron が merged 状態を検知する経路に
// 委ねる (Web 経路から pg-boss を直接叩かない)。github_poll は branch
// protection と approval_records をチェックしてから execute_apply を enqueue する。

import { NextResponse } from "next/server";
import {
  GithubAdapterUnauthenticatedError,
  GithubMergeFailedError,
} from "@addroid/github-adapter";
import { Prisma } from "@addroid/db";
import { prisma } from "../../../../../lib/prisma";
import { ensureWebWorkspace, getActiveGithubAdapter } from "../../../../../lib/github-runtime";
import { requireTrustedJsonWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  expectedHeadSha?: unknown;
  mergeMethod?: unknown;
  // actor / decisionSource は意図的に受け取らない。サーバー側で固定する。
}

const WEB_MERGE_ACTOR = "user:web-ui" as const;
const WEB_MERGE_DECISION_SOURCE = "web_merge" as const;
const VALID_MERGE_METHODS = new Set(["merge", "squash", "rebase"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ prNumber: string }> }
) {
  const untrustedResponse = requireTrustedJsonWebAction(request);
  if (untrustedResponse) return untrustedResponse;

  const { prNumber: prNumberRaw } = await params;
  const prNumber = Number.parseInt(prNumberRaw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid PR number." },
      { status: 400 }
    );
  }

  let payload: Body;
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    payload = parsed as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Merge requests must include a valid JSON body." },
      { status: 400 }
    );
  }
  const expectedHeadSha =
    typeof payload.expectedHeadSha === "string" && payload.expectedHeadSha.trim().length > 0
      ? payload.expectedHeadSha.trim()
      : undefined;
  if (expectedHeadSha === undefined) {
    return NextResponse.json(
      { ok: false, error: "Merge requests must include expectedHeadSha." },
      { status: 400 }
    );
  }
  const mergeMethodRaw =
    typeof payload.mergeMethod === "string" ? payload.mergeMethod.trim() : "";
  const mergeMethod = VALID_MERGE_METHODS.has(mergeMethodRaw)
    ? (mergeMethodRaw as "merge" | "squash" | "rebase")
    : "merge";
  const workspace = await ensureWebWorkspace();

  // PR と repo / workspace を 1 回で取得。
  const pr = await prisma.githubPullRequest
    .findFirst({
      where: {
        number: prNumber,
        repo: { workspace: { is: { id: workspace.id } } },
      },
      orderBy: { polledAt: "desc" },
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        headSha: true,
        baseRef: true,
        htmlUrl: true,
        repo: {
          select: {
            id: true,
            owner: true,
            name: true,
            defaultBranch: true,
          },
        },
      },
    })
    .catch(() => null);

  if (!pr) {
    return NextResponse.json(
      { ok: false, error: `PR #${prNumber} is not tracked locally yet.` },
      { status: 404 }
    );
  }

  if (pr.state !== "open") {
    return NextResponse.json(
      {
        ok: false,
        error: `PR #${prNumber} is not open (current state: ${pr.state}).`,
      },
      { status: 409 }
    );
  }

  if (expectedHeadSha !== pr.headSha) {
    return NextResponse.json(
      {
        ok: false,
        error: `Local HEAD sha (${pr.headSha}) does not match expected (${expectedHeadSha}). Refresh and retry.`,
      },
      { status: 409 }
    );
  }

  // 上流 (improvement_pr の audit / 過去の web_merge) が rejected / auto_blocked を
  // 残している場合は merge を拒否する (UI 側の latestDecision と二段防御)。
  const latest = await prisma.approvalRecord
    .findFirst({
      where: { workspaceId: workspace.id, pullRequestId: pr.id },
      orderBy: { createdAt: "desc" },
      select: { decision: true },
    })
    .catch(() => null);
  if (latest?.decision === "rejected" || latest?.decision === "auto_blocked") {
    return NextResponse.json(
      {
        ok: false,
        error: `PR #${prNumber} is blocked by approval_records.decision="${latest.decision}".`,
      },
      { status: 409 }
    );
  }

  // regression fix: GitHub merge を呼ぶ前に approval_records (decision="approved",
  // decisionSource="web_merge") と audit_logs (action="pr.merge_via_web_attempted")
  // を 1 トランザクションで先に書き込む。
  //
  // ここで失敗すれば adapter.mergePullRequest を呼ばずに 500 を返す
  // (= GitHub に対する副作用は起きない)。成功すれば、後段の `github_poll` が
  // 当該 PR の merge transition を検知した時点で `github_poll` が同じ headSha の
  // web_merge 承認を確認し、execute_apply を enqueue する。
  //
  // 監査・承認の永続化が GitHub merge の前段にあることで、「audit が無いまま
  // GitHub だけ merge され、AdDroid 承認なしに Apply pipeline が走ってしまう」
  // 失敗モードを遮断する。
  let preMergeApprovalId: string;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRecord.create({
        data: {
          workspaceId: workspace.id,
          pullRequestId: pr.id,
          approvedBy: WEB_MERGE_ACTOR,
          decision: "approved",
          comment: "Web UI からマージ要求を受け付けました (GitHub merge を呼び出します)。",
          metadata: {
            decisionSource: WEB_MERGE_DECISION_SOURCE,
            mergeMethod,
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            phase: "pre_merge",
          } satisfies Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actor: WEB_MERGE_ACTOR,
          action: "pr.merge_via_web_attempted",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: WEB_MERGE_DECISION_SOURCE,
            mergeMethod,
            approvalRecordId: approval.id,
          } satisfies Prisma.InputJsonValue,
        },
      });
      return approval;
    });
    preMergeApprovalId = result.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to persist web_merge approval/audit before GitHub merge: ${message}. GitHub merge は呼び出していません。`,
      },
      { status: 500 }
    );
  }

  // adapter.mergePullRequest を呼ぶ。
  // 失敗時は audit_logs に web merge failed を残す (approval_records は phase="pre_merge"
  // のまま残るが、GitHub 側に副作用は出ていない。再試行は新しい approval row を
  // 重ねて書く想定で、UI には actionable error を返す)。
  let mergeResult: { sha: string; merged: boolean; message: string };
  try {
    const { adapter } = await getActiveGithubAdapter();
    mergeResult = await adapter.mergePullRequest({
      spec: {
        owner: pr.repo.owner,
        name: pr.repo.name,
        defaultBranch: pr.repo.defaultBranch,
      },
      number: pr.number,
      expectedHeadSha,
      mergeMethod,
    });
  } catch (err) {
    const status =
      err instanceof GithubMergeFailedError ? err.status : 502;
    const message =
      err instanceof GithubAdapterUnauthenticatedError
        ? "GitHub adapter is not authenticated. Connect from /github first."
        : err instanceof Error
          ? err.message
          : String(err);
    // 失敗も audit に残す (UI 監査ビュー / Slack 通知 / debug の起点)。
    await prisma.auditLog
      .create({
        data: {
          workspaceId: workspace.id,
          actor: WEB_MERGE_ACTOR,
          action: "pr.merge_via_web_failed",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: WEB_MERGE_DECISION_SOURCE,
            mergeMethod,
            error: message,
            httpStatus: status,
            preMergeApprovalRecordId: preMergeApprovalId,
          } satisfies Prisma.InputJsonValue,
        },
      })
      .catch(() => {
        /* audit が落ちても merge エラーレスポンスは返す */
      });
    return NextResponse.json(
      { ok: false, error: message, status },
      { status }
    );
  }

  if (!mergeResult.merged) {
    // GitHub から merged=false が返るケース (mergeable=false 等)。
    // approval_records は phase="pre_merge" のまま残るが、GitHub 側に副作用は出ていない。
    await prisma.auditLog
      .create({
        data: {
          workspaceId: workspace.id,
          actor: WEB_MERGE_ACTOR,
          action: "pr.merge_via_web_failed",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: WEB_MERGE_DECISION_SOURCE,
            mergeMethod,
            error: mergeResult.message,
            githubMerged: false,
            preMergeApprovalRecordId: preMergeApprovalId,
          } satisfies Prisma.InputJsonValue,
        },
      })
      .catch(() => {
        /* best-effort */
      });
    return NextResponse.json(
      {
        ok: false,
        error: `GitHub returned merged=false: ${mergeResult.message}`,
      },
      { status: 502 }
    );
  }

  // GitHub merge が成功した。pr.merged_via_web を audit_logs に残す
  // (approval_records は pre-merge transaction で既に書かれており、attribution
  // は github_poll の auto_approved 上書きから守られる)。
  //
  // この audit 書き込みが失敗しても、approval_records (decisionSource=web_merge)
  // は既に永続化されているため後段の github_poll は web_merge attribution を
  // 保存する。ここでは best-effort の audit_logs 補完のみ行い、UI には成功を
  // 返す (= GitHub merge は完了している)。
  let postMergeAuditError: string | null = null;
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: WEB_MERGE_ACTOR,
        action: "pr.merged_via_web",
        target: `github_pull_request:${pr.id}`,
        ref: `pr#${pr.number}@${pr.headSha}`,
        metadata: {
          prNumber: pr.number,
          headSha: pr.headSha,
          mergeSha: mergeResult.sha,
          htmlUrl: pr.htmlUrl,
          decisionSource: WEB_MERGE_DECISION_SOURCE,
          mergeMethod,
          preMergeApprovalRecordId: preMergeApprovalId,
        } satisfies Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    postMergeAuditError = err instanceof Error ? err.message : String(err);
    // 二重監査の意味で、補完監査の失敗自体も audit に残す試みをする (best-effort)。
    await prisma.auditLog
      .create({
        data: {
          workspaceId: workspace.id,
          actor: WEB_MERGE_ACTOR,
          action: "pr.merge_via_web_audit_failed",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            mergeSha: mergeResult.sha,
            htmlUrl: pr.htmlUrl,
            decisionSource: WEB_MERGE_DECISION_SOURCE,
            mergeMethod,
            preMergeApprovalRecordId: preMergeApprovalId,
            error: postMergeAuditError,
          } satisfies Prisma.InputJsonValue,
        },
      })
      .catch(() => {
        /* この audit すら失敗しても、attribution は pre-merge approval 行で保存されている */
      });
  }

  return NextResponse.json(
    {
      ok: true,
      merged: true,
      sha: mergeResult.sha,
      message: mergeResult.message,
      decisionSource: WEB_MERGE_DECISION_SOURCE,
      approvalRecordId: preMergeApprovalId,
      ...(postMergeAuditError ? { postMergeAuditError } : {}),
    },
    { status: 200 }
  );
}
