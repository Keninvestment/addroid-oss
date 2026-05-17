// AdDroid OSS — github_poll cron の 1 ティック分の実装。
//
// 動作:
//   1. workspace に紐付いた ops repo を Store から探す。未登録なら no_repo。
//   2. adapter.pollPullRequests を ETag 付きで呼ぶ。
//      adapter が未実装 (the current implementation の Stub) であれば adapter_unavailable で抜ける。
//      worker は落とさず execution_logs/cron_runs に warn として残す想定。
//   3. 304 (notModified=true) なら polling state だけ更新。
//   4. 200 なら全 PR を upsert。直前は merged ではなかった PR が今回 merged に
//      遷移した場合、execute_apply を enqueue する (apply_jobs にも記録)。
//
// 重要: GitHub Webhook には依存しない。merged 検出は本ポーリングのみで完結する。

import { enqueueApplyJob, type ApplyJobBoss } from "./apply.js";
import { resolveExecutionMode } from "./execution-mode.js";
import type {
  GithubPollStore,
  PrApprovalEvidence,
  QueueGithubAdapter,
} from "./store.js";

export interface RunGithubPollOptions {
  boss: ApplyJobBoss;
  store: GithubPollStore;
  adapter: QueueGithubAdapter;
  workspaceId: string;
}

export type GithubPollStatus =
  | "no_repo"
  | "not_modified"
  | "polled"
  | "adapter_unavailable";

export interface GithubPollSummary {
  status: GithubPollStatus;
  repoId?: string;
  prCount?: number;
  newlyMerged?: number;
  enqueuedJobIds?: string[];
  /** merged PR を検知したが AdDroid 承認境界を満たさず enqueue を拒否した件数。 */
  blockedUnapproved?: number;
  detail?: string;
}

export async function runGithubPollOnce(
  opts: RunGithubPollOptions
): Promise<GithubPollSummary> {
  const repo = await opts.store.findOpsRepo(opts.workspaceId);
  if (!repo) {
    return {
      status: "no_repo",
      detail: "ops repo 未登録 — /github から OAuth・bootstrap を実行してください。",
    };
  }

  let result;
  try {
    result = await opts.adapter.pollPullRequests(
      { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch },
      repo.etag ? { etag: repo.etag } : {}
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await opts.store.recordPollingState({
      repoId: repo.repoId,
      lastStatusCode: 0,
    });
    return {
      status: "adapter_unavailable",
      repoId: repo.repoId,
      detail: message,
    };
  }

  if (result.notModified) {
    await opts.store.recordPollingState({
      repoId: repo.repoId,
      etag: repo.etag,
      lastModified: repo.lastModified,
      lastStatusCode: 304,
    });
    return { status: "not_modified", repoId: repo.repoId };
  }

  await opts.store.recordPollingState({
    repoId: repo.repoId,
    etag: result.etag ?? null,
    lastModified: result.lastModified ?? null,
    lastStatusCode: 200,
  });

  // regression fix: workspace 全体の `executionMode` と active ad_accounts の
  // `modeOverride` をこのティック開始時点で 1 度だけ取得する。merge 検出時に
  // すべての候補が `report_only` に解決される場合は execute_apply を enqueue
  // しない (= acceptance "report_only never mutates Meta")。1 件でも override
  // で `proposal` / `auto_apply` を要求している ad_account があれば、PR が
  // 触る accountKey が分からない時点では enqueue を許し、Meta CLI 直前の
  // per-account 再評価 (`runExecuteApply`) に判断を委ねる。
  const modeContext = await opts.store.loadWorkspaceExecutionModeContext({
    workspaceId: opts.workspaceId,
  });
  const isWorkspaceReportOnlyHardLock = computeReportOnlyHardLock(modeContext);

  const enqueuedJobIds: string[] = [];
  let newlyMerged = 0;
  let blockedUnapproved = 0;
  for (const pr of result.pullRequests) {
    const upsert = await opts.store.upsertPullRequest({
      repoId: repo.repoId,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      htmlUrl: pr.htmlUrl,
      mergedAt: pr.mergedAt,
    });
    if (upsert.transitionedToMerged) {
      newlyMerged++;
      const approval = await opts.store.findLatestPrApproval({
        pullRequestId: upsert.id,
      });
      const priorDecision = approval?.decision ?? null;
      if (
        priorDecision === "auto_blocked" ||
        priorDecision === "rejected"
      ) {
        blockedUnapproved++;
        await opts.store.recordApplyBlocked({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          prNumber: pr.number,
          headSha: pr.headSha,
          htmlUrl: pr.htmlUrl,
          reason: "prior_blocked_approval",
          detail: `当該 PR には既に approval_records.decision="${priorDecision}" が存在するため、merge 検出時点で execute_apply を起動しません (上流の承認決定を保存)。`,
        });
        continue;
      }
      // regression fix: workspace + 全 active ad_account が `report_only` に
      // 解決される場合、Meta mutation 経路自体が契約上禁止されている。merge
      // 検出時点で execute_apply を enqueue させず、他の未承認ブロックと同じ
      // 三段監査 (apply_blocked + execution_log
      // + approval_records=auto_blocked) を残す。1 件でも mutate 可能な
      // override があるときは executor 側 per-account ガードに任せる。
      if (isWorkspaceReportOnlyHardLock) {
        blockedUnapproved++;
        await opts.store.recordApplyBlocked({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          prNumber: pr.number,
          headSha: pr.headSha,
          htmlUrl: pr.htmlUrl,
          reason: "report_only_mode",
          detail:
            "workspace.executionMode=report_only かつ全 active ad_account が報告のみのため、merge 検出時点で execute_apply を起動しません。",
        });
        await opts.store.recordPrApproval({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          approvedBy: "addroid",
          decision: "auto_blocked",
          comment:
            "execution mode が report_only のため execute_apply を拒否しました。",
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            reason: "report_only_mode",
            workspaceMode: modeContext.workspaceMode,
            accountOverrides: modeContext.accountOverrides,
          },
        });
        continue;
      }
      const approvalToUse = await ensureApprovalForMergedPr({
        store: opts.store,
        workspaceId: opts.workspaceId,
        pullRequestId: upsert.id,
        prNumber: pr.number,
        headSha: pr.headSha,
        mergeSha: pr.mergeSha ?? null,
        htmlUrl: pr.htmlUrl,
        mergedBy: pr.mergedBy ?? null,
        approval,
      });
      if (!approvalToUse.ok) {
        blockedUnapproved++;
        await opts.store.recordPrApproval({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          approvedBy: "addroid",
          decision: "auto_blocked",
          comment: "AdDroid の承認境界を確認できないため execute_apply を拒否しました。",
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            reason: approvalToUse.reason,
            approvalRecordId: approval?.id ?? null,
            approvalHeadSha: approval?.headSha ?? null,
            approvalDecisionSource: approval?.decisionSource ?? null,
          },
        });
        continue;
      }
      const enqueued = await enqueueApplyJob({
        boss: opts.boss,
        store: opts.store,
        pullRequestId: upsert.id,
        reason: `merged_pr_${pr.number}`,
      });
      if (enqueued.jobId) enqueuedJobIds.push(enqueued.jobId);
      // GitOps 経由で広告配信を変えうるすべての操作は監査対象。
      // merge 検出時点で audit_logs に 1 行残し、UI 監査ビューから追跡できるようにする。
      await opts.store.recordMergeAudit({
        workspaceId: opts.workspaceId,
        pullRequestId: upsert.id,
        prNumber: pr.number,
        headSha: pr.headSha,
        htmlUrl: pr.htmlUrl,
        jobId: enqueued.jobId,
        applyJobId: enqueued.applyJobId,
      });
    }
  }

  return {
    status: "polled",
    repoId: repo.repoId,
    prCount: result.pullRequests.length,
    newlyMerged,
    enqueuedJobIds,
    blockedUnapproved,
  };
}

type EnsureApprovalResult =
  | { ok: true }
  | {
      ok: false;
      reason: "approval_record_failed";
    };

async function ensureApprovalForMergedPr(input: {
  store: GithubPollStore;
  workspaceId: string;
  pullRequestId: string;
  prNumber: number;
  headSha: string;
  mergeSha: string | null;
  htmlUrl: string;
  mergedBy: string | null;
  approval: PrApprovalEvidence | null;
}): Promise<EnsureApprovalResult> {
  if (
    input.approval?.decision === "approved" &&
    input.approval.headSha === input.headSha &&
    (input.approval.mergeSha || !input.mergeSha) &&
    isAcceptedApprovalSource(input.approval.decisionSource)
  ) {
    return { ok: true };
  }
  const actor = input.mergedBy ? `github:${input.mergedBy}` : "github:unknown";
  try {
    await input.store.recordPrApproval({
      workspaceId: input.workspaceId,
      pullRequestId: input.pullRequestId,
      approvedBy: actor,
      decision: "approved",
      comment: "GitHub で merged になった PR を承認として記録しました。",
      metadata: {
        decisionSource: "github_merge",
        prNumber: input.prNumber,
        headSha: input.headSha,
        mergeSha: input.mergeSha,
        htmlUrl: input.htmlUrl,
        mergedBy: input.mergedBy,
        previousApprovalRecordId: input.approval?.id ?? null,
        previousApprovalDecision: input.approval?.decision ?? null,
        previousApprovalHeadSha: input.approval?.headSha ?? null,
        previousApprovalMergeSha: input.approval?.mergeSha ?? null,
        previousApprovalDecisionSource: input.approval?.decisionSource ?? null,
      },
    });
    return { ok: true };
  } catch {
    await input.store.recordApplyBlocked({
      workspaceId: input.workspaceId,
      pullRequestId: input.pullRequestId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      htmlUrl: input.htmlUrl,
      reason: "approval_record_failed",
      detail:
        "GitHub merge を承認として記録できなかったため、execute_apply を起動しません。",
    });
    return { ok: false, reason: "approval_record_failed" };
  }
}

function isAcceptedApprovalSource(source: string | null): boolean {
  return (
    source === "web_merge" ||
    source === "cli_merge" ||
    source === "slack_merge" ||
    source === "github_merge"
  );
}

/**
 * regression fix: workspace mode + active ad_account.modeOverride を
 * `resolveExecutionMode` で 1 つずつ展開し、すべて `report_only` に解決される
 * かを判定する。
 *
 * - active ad_account が登録されていない workspace では override 集合が空
 *   になる。その場合は workspace mode 単独で判定する (= override 無し)。
 * - 1 件でも `proposal` / `auto_apply` に解決される候補があれば、merge 検出
 *   時点では fail-closed しない。Meta CLI 直前の `runExecuteApply` 側
 *   per-account 再評価が、PR が実際に触る accountKey に対して決定的に
 *   `report_only` 判定を行う。
 */
function computeReportOnlyHardLock(context: {
  workspaceMode: string | null;
  accountOverrides: Array<string | null>;
}): boolean {
  if (context.accountOverrides.length === 0) {
    return resolveExecutionMode(context.workspaceMode, null) === "report_only";
  }
  return context.accountOverrides.every(
    (override) =>
      resolveExecutionMode(context.workspaceMode, override) === "report_only"
  );
}
