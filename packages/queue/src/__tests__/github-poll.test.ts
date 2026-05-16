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
};

async function seedApprovedPr(
  store: FakeGithubPollStore,
  number: number,
  headSha: string,
  source = "web_merge"
) {
  await store.upsertPullRequest({
    repoId: BASE_REPO.repoId,
    number,
    title: `approved ${number}`,
    state: "open",
    headSha,
    baseRef: "main",
    htmlUrl: `https://example.invalid/${number}`,
    mergedAt: null,
  });
  const seeded = store.prs.get(`${BASE_REPO.repoId}#${number}`)!;
  await store.recordPrApproval({
    workspaceId: "ws-1",
    pullRequestId: seeded.id,
    approvedBy: source === "slack_merge" ? "slack:U123" : "user:web-ui",
    decision: "approved",
    comment: "interactive approval",
    metadata: { decisionSource: source, headSha, prNumber: number },
  });
}

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
  await seedApprovedPr(store, 2, "sha-2");
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
  // approval_records: the original interactive approval is preserved.
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.workspaceId, "ws-1");
  assert.equal(store.prApprovals[0]!.decision, "approved");
  assert.equal(store.prApprovals[0]!.approvedBy, "user:web-ui");
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
  await seedApprovedPr(store, 9, "sha-9");
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

test("runGithubPollOnce treats direct GitHub merge as approval when AdDroid approval is missing", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
  const boss = new FakeBoss();
  boss.defaultJobId = "pgboss-github-merge";
  const adapter = new FakeGithubAdapter({
    results: [
      {
        notModified: false,
        pullRequests: [
          {
            number: 42,
            title: "merged without addroid approval",
            state: "merged",
            headSha: "sha-42",
            baseRef: "main",
            htmlUrl: "https://example.invalid/42",
            mergedAt: "2026-05-01T00:00:00.000Z",
            mergedBy: "octo-user",
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
  assert.deepEqual(summary.enqueuedJobIds, ["pgboss-github-merge"]);
  assert.equal(boss.sent.length, 1);
  assert.equal(store.applyJobs.length, 1);
  assert.equal(store.mergeAudits.length, 1);
  assert.equal(store.blockedApplies.length, 0);
  // approval_records: GitHub direct merge is recorded as an approved boundary.
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.workspaceId, "ws-1");
  assert.equal(store.prApprovals[0]!.decision, "approved");
  assert.equal(store.prApprovals[0]!.approvedBy, "github:octo-user");
  const approvalMeta = store.prApprovals[0]!.metadata as {
    decisionSource: string;
    headSha: string;
    mergedBy: string;
  };
  assert.equal(approvalMeta.decisionSource, "github_merge");
  assert.equal(approvalMeta.headSha, "sha-42");
  assert.equal(approvalMeta.mergedBy, "octo-user");
});

// 上流 (improvement_pr の policy / audit、UI/CLI 拒否) が当該 PR に対して既に
// `auto_blocked` (or `rejected`) を残している場合、merge 検出時点で enqueue を
// 拒否し、新規 approval も書き込まずに上流決定を保存する。
test("runGithubPollOnce blocks enqueue and preserves prior auto_blocked approval across merge", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
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
  assert.equal(store.prApprovals.length, 1);
  assert.equal(store.prApprovals[0]!.decision, "auto_blocked");
});

// Web UI 経路の "web_merge" approval (decisionSource=web_merge) は GitHub merge 前に
// 書き込まれ、`approval_records.decision="approved"` として永続化される。後段の
// github_poll は同じ headSha の承認を確認したときだけ execute_apply を enqueue する。
test("runGithubPollOnce enqueues from prior approved web_merge with matching headSha", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
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
    metadata: {
      decisionSource: "web_merge",
      phase: "pre_merge",
      prNumber: 31,
      headSha: "sha-31",
    },
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
  // Critical: 新規 approval は被せない。latest は web_merge の `approved` のまま。
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
  store.setOpsRepo({ ...BASE_REPO });
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
  store.setOpsRepo({ ...BASE_REPO });
  await seedApprovedPr(store, 73, "sha-73");
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
  assert.equal(store.prApprovals[0]!.decision, "approved");
});

test("runGithubPollOnce records github_merge when previous approval headSha differs from merged PR headSha", async () => {
  const store = new FakeGithubPollStore();
  store.setOpsRepo({ ...BASE_REPO });
  await seedApprovedPr(store, 7, "old-sha");
  const boss = new FakeBoss();
  boss.defaultJobId = "pgboss-direct-current";

  const summary = await runGithubPollOnce({
    boss,
    store,
    adapter: new FakeGithubAdapter({
      results: [
        {
          notModified: false,
          pullRequests: [
            {
              number: 7,
              title: "m",
              state: "merged",
              headSha: "sha-7",
              baseRef: "main",
              htmlUrl: "https://example.invalid/7",
              mergedAt: "2026-05-01T00:00:00.000Z",
              mergedBy: "octo-user",
            },
          ],
        },
      ],
    }),
    workspaceId: "ws-1",
  });

  assert.equal(summary.blockedUnapproved, 0);
  assert.deepEqual(summary.enqueuedJobIds, ["pgboss-direct-current"]);
  assert.equal(store.applyJobs.length, 1);
  assert.equal(store.blockedApplies.length, 0);
  assert.equal(store.prApprovals.length, 2);
  assert.equal(store.prApprovals.at(-1)!.decision, "approved");
  assert.equal(store.prApprovals.at(-1)!.approvedBy, "github:octo-user");
  const meta = store.prApprovals.at(-1)!.metadata as {
    decisionSource: string;
    previousApprovalHeadSha: string;
  };
  assert.equal(meta.decisionSource, "github_merge");
  assert.equal(meta.previousApprovalHeadSha, "old-sha");
});
