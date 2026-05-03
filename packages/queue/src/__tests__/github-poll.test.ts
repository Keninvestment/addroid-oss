import test from "node:test";
import assert from "node:assert/strict";
import { runGithubPollOnce } from "../index.js";
import {
  FakeBoss,
  FakeGithubAdapter,
  FakeGithubPollStore,
} from "./fakes.js";

const BASE_REPO = {
  repoId: "repo-1",
  owner: "addroid",
  name: "ops-fixture",
  defaultBranch: "main",
  etag: null as string | null,
  lastModified: null as string | null,
  // 既定 protected: 既存のテストはこの状態で書かれている。protection 不在ケースは
  // 専用テストで `branchProtectionApplied: false` に上書きする (regression fix)。
  branchProtectionApplied: true,
};

test("runGithubPollOnce returns no_repo when ops repo is not registered", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo(null);
  const adapter = new FakeGithubAdapter({ results: [] });
  const summary = await runGithubPollOnce({
    boss: new FakeBoss(),
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "no_repo");
  assert.equal(adapter.calls.length, 0);
});

test("runGithubPollOnce records 304 not_modified and persists polling state", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO, etag: "etag-prev" });
  const adapter = new FakeGithubAdapter({
    results: [{ notModified: true, pullRequests: [] }],
  });
  const summary = await runGithubPollOnce({
    boss: new FakeBoss(),
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "not_modified");
  assert.equal(store.pollingStates.length, 1);
  assert.equal(store.pollingStates[0]!.lastStatusCode, 304);
  assert.equal(store.pollingStates[0]!.etag, "etag-prev");
  // adapter was called with the prev etag
  assert.equal(adapter.calls[0]!.prev.etag, "etag-prev");
});

test("runGithubPollOnce upserts PRs and enqueues execute_apply only for newly merged PRs", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
  const boss = new FakeBoss();
  boss.defaultJobId = "pgboss-7";
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        etag: "etag-1",
        pullRequests: [
          {
            number: 1,
            title: "open one",
            state: "open",
            headSha: "sha-1",
            baseRef: "main",
            htmlUrl: "https://example.invalid/1",
            mergedAt: null,
          },
          {
            number: 2,
            title: "merged one",
            state: "merged",
            headSha: "sha-2",
            baseRef: "main",
            htmlUrl: "https://example.invalid/2",
            mergedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
    ],
  });

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "polled");
  assert.equal(summary.prCount, 2);
  assert.equal(summary.newlyMerged, 1);
  assert.deepEqual(summary.enqueuedJobIds, ["pgboss-7"]);
  // execute_apply was sent exactly once (for #2)
  assert.equal(boss.sent.length, 1);
  // apply_jobs row recorded once
  assert.equal(store.applyJobs.length, 1);
  // audit_logs row recorded once for the merge → enqueue transition
  assert.equal(store.mergeAudits.length, 1);
  assert.equal(store.mergeAudits[0]!.workspaceId, "ws-1");
  assert.equal(store.mergeAudits[0]!.prNumber, 2);
  assert.equal(store.mergeAudits[0]!.headSha, "sha-2");
  assert.equal(store.mergeAudits[0]!.jobId, "pgboss-7");
  // approval_records: auto_approved row alongside the merge audit (implementation item).
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.workspaceId, "ws-1");
  assert.equal(store.prApprovals[0]!.decision, "auto_approved");
  assert.equal(store.prApprovals[0]!.approvedBy, "addroid");
  assert.equal(
    (store.prApprovals[0]!.metadata as { prNumber: number }).prNumber,
    2
  );
  // polling state advanced to 200
  assert.equal(store.pollingStates[0]!.lastStatusCode, 200);
  assert.equal(store.pollingStates[0]!.etag, "etag-1");
});

test("runGithubPollOnce does not re-enqueue already-merged PRs on subsequent polls", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
  const boss = new FakeBoss();
  // first poll: PR is merged → enqueue
  // second poll: same PR still merged → no enqueue
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 9,
            title: "m",
            state: "merged",
            headSha: "sha-9",
            baseRef: "main",
            htmlUrl: "https://example.invalid/9",
            mergedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
      {
        notModified: false,
        pullRequests: [
          {
            number: 9,
            title: "m",
            state: "merged",
            headSha: "sha-9",
            baseRef: "main",
            htmlUrl: "https://example.invalid/9",
            mergedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
    ],
  });

  const first = await runGithubPollOnce({ boss, store, adapter, workspaceId: "ws-1" });
  const second = await runGithubPollOnce({ boss, store, adapter, workspaceId: "ws-1" });
  assert.equal(first.newlyMerged, 1);
  assert.equal(second.newlyMerged, 0);
  assert.equal(boss.sent.length, 1);
  assert.equal(store.applyJobs.length, 1);
  // audit_logs must not be re-stamped on the second poll (no merge transition).
  assert.equal(store.mergeAudits.length, 1);
  // approval_records も同様、merge transition 1 回につき 1 行のみ。
  assert.equal(store.prApprovals.length, 1);
});

test("runGithubPollOnce returns adapter_unavailable when the adapter throws", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
  const adapter = new FakeGithubAdapter({
    results: [new Error("not implemented in skeleton")],
  });
  const summary = await runGithubPollOnce({
    boss: new FakeBoss(),
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "adapter_unavailable");
  assert.match(summary.detail ?? "", /not implemented/);
  // polling state still recorded with status 0 so UI knows we attempted a poll
  assert.equal(store.pollingStates[0]!.lastStatusCode, 0);
});

// regression fix: branch protection (= approval-enforcement) が ops repo に
// 適用されていない状態では、merged PR を検知しても execute_apply を起動せず、
// audit_logs / execution_logs に block を残す。
test("runGithubPollOnce blocks execute_apply when branch protection is not applied", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: false });
  const boss = new FakeBoss();
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 42,
            title: "merged without protection",
            state: "merged",
            headSha: "sha-42",
            baseRef: "main",
            htmlUrl: "https://example.invalid/42",
            mergedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
    ],
  });

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "polled");
  assert.equal(summary.newlyMerged, 1);
  assert.equal(summary.blockedUnapproved, 1);
  assert.deepEqual(summary.enqueuedJobIds, []);
  // execute_apply must NOT be enqueued
  assert.equal(boss.sent.length, 0);
  // No apply_jobs row, no merge audit (success path artifacts)
  assert.equal(store.applyJobs.length, 0);
  assert.equal(store.mergeAudits.length, 0);
  // The block is recorded
  assert.equal(store.blockedApplies.length, 1);
  assert.equal(store.blockedApplies[0]!.reason, "unprotected_branch");
  assert.equal(store.blockedApplies[0]!.prNumber, 42);
  assert.equal(store.blockedApplies[0]!.headSha, "sha-42");
  assert.equal(store.blockedApplies[0]!.workspaceId, "ws-1");
  // approval_records: auto_blocked row alongside the block audit (implementation item).
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.workspaceId, "ws-1");
  assert.equal(store.prApprovals[0]!.decision, "auto_blocked");
  assert.equal(store.prApprovals[0]!.approvedBy, "addroid");
  assert.equal(
    (store.prApprovals[0]!.metadata as { reason: string }).reason,
    "unprotected_branch"
  );
});

// regression fix: 上流 (improvement_pr の policy / audit、UI/CLI 拒否) が当該 PR
// に対して既に `auto_blocked` (or `rejected`) を残している場合、merge 検出時点で
// 新規 `auto_approved` を書き込むと latestApprovalDecision が反転して
// execute_apply が承認境界を迂回するため、enqueue を拒否し、新規 approval も
// 書き込まずに上流決定を保存する。
test("runGithubPollOnce blocks enqueue and preserves prior auto_blocked approval across merge", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: true });
  const boss = new FakeBoss();
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 21,
            title: "auto_blocked proposal merged",
            state: "merged",
            headSha: "sha-21",
            baseRef: "main",
            htmlUrl: "https://example.invalid/21",
            mergedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
    ],
  });
  // Pre-existing approval_records row left by improvement_pr workflow audit.
  // FakeGithubPollStore は upsert 時に決定的な PR id を `pr-<n>` で割り当てるが、
  // 今回はまだ upsert していないため、PR upsert 後に発行される id を予測できない。
  // 代わりに「最初に呼ばれた upsertPullRequest」の id を返した直後に
  // recordPrApproval を仕込むのではなく、あらかじめ id を seed する。
  await store.upsertPullRequest({
    repoId: BASE_REPO.repoId,
    number: 21,
    title: "auto_blocked proposal",
    state: "open",
    headSha: "sha-21",
    baseRef: "main",
    htmlUrl: "https://example.invalid/21",
    mergedAt: null,
  });
  const seeded = store.prs.get(`${BASE_REPO.repoId}#21`)!;
  await store.recordPrApproval({
    workspaceId: "ws-1",
    pullRequestId: seeded.id,
    approvedBy: "addroid",
    decision: "auto_blocked",
    comment: "improvement_pr policy auto_blocked",
    metadata: { source: "improvement_pr" },
  });

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "polled");
  assert.equal(summary.newlyMerged, 1);
  assert.equal(summary.blockedUnapproved, 1);
  assert.deepEqual(summary.enqueuedJobIds, []);
  // execute_apply must NOT be enqueued for an auto_blocked PR.
  assert.equal(boss.sent.length, 0);
  assert.equal(store.applyJobs.length, 0);
  // No success-path merge audit row.
  assert.equal(store.mergeAudits.length, 0);
  // The block is recorded with the new reason.
  assert.equal(store.blockedApplies.length, 1);
  assert.equal(
    store.blockedApplies[0]!.reason,
    "prior_blocked_approval"
  );
  assert.equal(store.blockedApplies[0]!.prNumber, 21);
  // Critical: the prior auto_blocked row must remain the latest decision.
  // No fresh auto_approved row may be written.
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.decision, "auto_blocked");
});

// regression fix: Web UI 経路の "web_merge" approval (decisionSource=web_merge)
// は GitHub merge 前に書き込まれ、`approval_records.decision="approved"` として
// 永続化される。後段の github_poll が同 PR の merge transition を検知したとき
// (= branch protection を経た merged PR) に新たな `auto_approved` を上書きする
// と web_merge attribution が失われ、「audit が無いまま GitHub だけ merge され
// 後段で `addroid` が auto_approve してしまう」失敗モードを再現できてしまう。
// したがって、prior `approved` が存在する場合は execute_apply を enqueue しつつ
// 新規 approval は書かず、上流の approval 行を latest として保存する。
test("runGithubPollOnce preserves prior approved (web_merge) attribution and does not overwrite with auto_approved", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: true });
  const boss = new FakeBoss();
  boss.defaultJobId = "pgboss-web-merge-1";
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 31,
            title: "web_merge approved PR merged on github",
            state: "merged",
            headSha: "sha-31",
            baseRef: "main",
            htmlUrl: "https://example.invalid/31",
            mergedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
      },
    ],
  });
  // Web UI からの merge 経路は GitHub merge 呼び出し前に approval_records
  // (decisionSource=web_merge, decision=approved) を書き込む。ここでは
  // FakeGithubPollStore が upsert 時に発行する PR id を seed してから approval を
  // 仕込む (実環境と同様に PR は当初 "open" で永続化される)。
  await store.upsertPullRequest({
    repoId: BASE_REPO.repoId,
    number: 31,
    title: "web_merge approved PR",
    state: "open",
    headSha: "sha-31",
    baseRef: "main",
    htmlUrl: "https://example.invalid/31",
    mergedAt: null,
  });
  const seeded = store.prs.get(`${BASE_REPO.repoId}#31`)!;
  await store.recordPrApproval({
    workspaceId: "ws-1",
    pullRequestId: seeded.id,
    approvedBy: "user:web-ui",
    decision: "approved",
    comment: "Web UI からマージ要求 (pre_merge)",
    metadata: { decisionSource: "web_merge", phase: "pre_merge", prNumber: 31 },
  });

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter,
    workspaceId: "ws-1",
  });

  assert.equal(summary.status, "polled");
  assert.equal(summary.newlyMerged, 1);
  assert.equal(summary.blockedUnapproved, 0);
  // execute_apply は enqueue される (上流 approval が成立しているため)。
  assert.deepEqual(summary.enqueuedJobIds, ["pgboss-web-merge-1"]);
  assert.equal(boss.sent.length, 1);
  assert.equal(store.applyJobs.length, 1);
  // merge audit も従来通り 1 行残す。
  assert.equal(store.mergeAudits.length, 1);
  assert.equal(store.mergeAudits[0]!.prNumber, 31);
  // Critical: 新規の auto_approved を被せない。latest は web_merge の `approved` のまま。
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.decision, "approved");
  assert.equal(store.prApprovals[0]!.approvedBy, "user:web-ui");
  assert.equal(
    (store.prApprovals[0]!.metadata as { decisionSource: string }).decisionSource,
    "web_merge"
  );
});

// regression fix: workspace.executionMode=report_only かつ override が無い (= 全
// active ad_account が報告のみ) workspace では、merge 検出時点で execute_apply
// を起動せず、`report_only_mode` を理由に block を残す。
test("runGithubPollOnce blocks enqueue when workspace mode is report_only and no override allows mutation", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: true });
  store.setExecutionModeContext({
    workspaceMode: "report_only",
    accountOverrides: [null, null],
  });
  const boss = new FakeBoss();
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 51,
            title: "merged in report_only mode",
            state: "merged",
            headSha: "sha-51",
            baseRef: "main",
            htmlUrl: "https://example.invalid/51",
            mergedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
      },
    ],
  });

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "polled");
  assert.equal(summary.newlyMerged, 1);
  assert.equal(summary.blockedUnapproved, 1);
  assert.deepEqual(summary.enqueuedJobIds, []);
  // execute_apply must NOT be enqueued under report_only.
  assert.equal(boss.sent.length, 0);
  assert.equal(store.applyJobs.length, 0);
  assert.equal(store.mergeAudits.length, 0);
  // The block is recorded with the new reason.
  assert.equal(store.blockedApplies.length, 1);
  assert.equal(store.blockedApplies[0]!.reason, "report_only_mode");
  assert.equal(store.blockedApplies[0]!.prNumber, 51);
  // approval_records: auto_blocked row alongside the block audit.
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.decision, "auto_blocked");
  const meta = store.prApprovals[0]!.metadata as {
    reason: string;
    workspaceMode: string;
  };
  assert.equal(meta.reason, "report_only_mode");
  assert.equal(meta.workspaceMode, "report_only");
});

// regression fix: workspace mode が report_only でも、いずれかの ad_account が
// modeOverride で `proposal` / `auto_apply` を要求している場合は github-poll
// では fail-closed しない (= apply-executor の per-account 再評価に委ねる)。
test("runGithubPollOnce enqueues when at least one account override allows mutation under report_only workspace", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: true });
  store.setExecutionModeContext({
    workspaceMode: "report_only",
    accountOverrides: [null, "auto_apply"],
  });
  const boss = new FakeBoss();
  boss.defaultJobId = "pgboss-99";
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 73,
            title: "merged with override",
            state: "merged",
            headSha: "sha-73",
            baseRef: "main",
            htmlUrl: "https://example.invalid/73",
            mergedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
      },
    ],
  });

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter,
    workspaceId: "ws-1",
  });
  assert.equal(summary.status, "polled");
  assert.equal(summary.newlyMerged, 1);
  assert.equal(summary.blockedUnapproved, 0);
  assert.deepEqual(summary.enqueuedJobIds, ["pgboss-99"]);
  assert.equal(boss.sent.length, 1);
  assert.equal(store.applyJobs.length, 1);
  assert.equal(store.blockedApplies.length, 0);
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.decision, "auto_approved");
});

// regression fix: protection が適用された ops repo では、従来どおり enqueue する。
// (既存の "upserts PRs and enqueues" テストを補強する gate コントロール用テスト)
test("runGithubPollOnce enqueues only when branchProtectionApplied is true", async () => {
  const protectedStore = new FakeGithubPollStore();
  protectedStore.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: true });
  const unprotectedStore = new FakeGithubPollStore();
  unprotectedStore.setOpsRepo({ ...BASE_REPO, branchProtectionApplied: false });

  const merged = {
    notModified: false as const,
    pullRequests: [
      {
        number: 7,
        title: "m",
        state: "merged" as const,
        headSha: "sha-7",
        baseRef: "main",
        htmlUrl: "https://example.invalid/7",
        mergedAt: "2026-05-01T00:00:00.000Z",
      },
    ],
  };

  const protectedSummary = await runGithubPollOnce({
    boss: new FakeBoss(),
    store: protectedStore,
    adapter: new FakeGithubAdapter({ results: [merged] }),
    workspaceId: "ws-1",
  });
  const unprotectedSummary = await runGithubPollOnce({
    boss: new FakeBoss(),
    store: unprotectedStore,
    adapter: new FakeGithubAdapter({ results: [merged] }),
    workspaceId: "ws-1",
  });

  assert.equal(protectedSummary.blockedUnapproved, 0);
  assert.equal(protectedStore.applyJobs.length, 1);
  assert.equal(protectedStore.blockedApplies.length, 0);
  assert.equal(protectedStore.prApprovals.length, 1);
  assert.equal(protectedStore.prApprovals[0]!.decision, "auto_approved");

  assert.equal(unprotectedSummary.blockedUnapproved, 1);
  assert.equal(unprotectedStore.applyJobs.length, 0);
  assert.equal(unprotectedStore.blockedApplies.length, 1);
  assert.equal(unprotectedStore.prApprovals.length, 1);
  assert.equal(unprotectedStore.prApprovals[0]!.decision, "auto_blocked");
});
