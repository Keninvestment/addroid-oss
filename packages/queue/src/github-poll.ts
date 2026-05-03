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
import type { GithubPollStore, QueueGithubAdapter } from "./store.js";

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
  /**
   * merged PR を検知したが branch protection 不在のため execute_apply enqueue を
   * 拒否した件数 (regression fix)。`newlyMerged - blockedUnapproved = enqueue 件数`。
   */
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
      // regression fix: 上流ワークフロー (improvement_pr の policy / audit、
      // または UI/CLI からの拒否) が当該 PR に対して既に `auto_blocked` /
      // `rejected` の approval_records を残している場合、merge 検出時点で
      // 新規 `auto_approved` を書き込むと `loadApplyApprovalSnapshot` の
      // `latestApprovalDecision` が反転し execute_apply が承認境界を迂回する。
      // 上流決定を merge を跨いで保存するため、ここで fail-closed する。
      const priorDecision = await opts.store.findLatestPrApprovalDecision({
        pullRequestId: upsert.id,
      });
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
        // 新規 `auto_approved` は書き込まない: latestApprovalDecision が
        // 反転して execute_apply が承認境界を迂回するため。
        continue;
      }
      // regression fix: workspace + 全 active ad_account が `report_only` に
      // 解決される場合、Meta mutation 経路自体が契約上禁止されている。merge
      // 検出時点で execute_apply を enqueue させず、`unprotected_branch` /
      // `prior_blocked_approval` と同じ三段監査 (apply_blocked + execution_log
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
      // regression fix: branch protection (= approval-enforcement 境界) が ops repo
      // に適用されていない場合、PR が "merged" でも人間レビューを経た保証がない。
      // the current implementation 制約「All Meta mutation must originate from approved GitOps state」
      // を満たすため、execute_apply の enqueue を拒否し audit_logs に残す。
      if (!repo.branchProtectionApplied) {
        blockedUnapproved++;
        await opts.store.recordApplyBlocked({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          prNumber: pr.number,
          headSha: pr.headSha,
          htmlUrl: pr.htmlUrl,
          reason: "unprotected_branch",
          detail:
            "ops repo の branch protection が未適用のため、approval enforcement なしで merge された PR から execute_apply を起動しません。",
        });
        // approval_records にも 1 行残す (audit_logs / execution_logs と三段で
        // PR の承認境界を追跡可能にする — this implementation)。
        await opts.store.recordPrApproval({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          approvedBy: "addroid",
          decision: "auto_blocked",
          comment:
            "ops repo の branch protection 未適用のため execute_apply を拒否しました。",
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            reason: "unprotected_branch",
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
      // approval_records:
      //   - 既に `approved` (= Web UI の web_merge / 将来的な CLI の cli_merge 由来)
      //     が記録されている PR には、新しい `auto_approved` を被せない。
      //     `latestApprovalDecision` を `addroid` 由来の auto_approved に上書きすると
      //     web_merge attribution が失われ、「audit が無いまま GitHub だけ merge され
      //     後段の github_poll が auto_approve してしまう」失敗モードを再現できて
      //     しまう (regression fix)。上流の approval 行をそのまま latest に保つ。
      //   - prior decision が存在しない場合 (= 純粋な GitHub merge 経由) は従来どおり
      //     branch protection を「approval enforcement を満たした」自動承認として
      //     記録する。audit_logs (apply.enqueued) / execution_logs (github_poll) と
      //     三段で残す。
      if (priorDecision === "approved") {
        // 上流 approval (web_merge 等) を保存する。新しい auto_approved は書かない。
      } else {
        await opts.store.recordPrApproval({
          workspaceId: opts.workspaceId,
          pullRequestId: upsert.id,
          approvedBy: "addroid",
          decision: "auto_approved",
          comment:
            "branch protection を経た merged PR を検知し、execute_apply を enqueue しました。",
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            jobId: enqueued.jobId,
            applyJobId: enqueued.applyJobId,
          },
        });
      }
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
