import test from "node:test";
import assert from "node:assert/strict";
import { APPLY_JOB_NAME, enqueueApplyJob } from "../index.js";
import { FakeBoss, FakeGithubPollStore } from "./fakes.js";

test("enqueueApplyJob sends an execute_apply job and records an apply_jobs row", async () => {
  const boss = new FakeBoss();
  boss.defaultJobId = "pgboss-job-42";
  const store = new FakeGithubPollStore();

  const r = await enqueueApplyJob({
    boss,
    store,
    pullRequestId: "pr-1",
    reason: "merged_pr_7",
  });

  assert.equal(r.jobId, "pgboss-job-42");
  assert.equal(boss.sent.length, 1);
  assert.equal(boss.sent[0]!.name, APPLY_JOB_NAME);
  const data = boss.sent[0]!.data as Record<string, unknown>;
  assert.equal(data.pullRequestId, "pr-1");
  assert.equal(data.reason, "merged_pr_7");

  assert.equal(store.applyJobs.length, 1);
  assert.equal(store.applyJobs[0]!.pullRequestId, "pr-1");
  assert.equal(store.applyJobs[0]!.jobId, "pgboss-job-42");
  assert.equal(store.applyJobs[0]!.state, "queued");
});

test("enqueueApplyJob handles a null pg-boss return without crashing", async () => {
  const boss = new FakeBoss();
  boss.defaultJobId = null;
  const store = new FakeGithubPollStore();

  const r = await enqueueApplyJob({ boss, store, pullRequestId: "pr-2" });
  assert.equal(r.jobId, null);
  assert.equal(store.applyJobs[0]!.jobId, "");
});

// ---------------------------------------------------------------------
// release readiness: pg-boss singletonKey 経路
// ---------------------------------------------------------------------

test("enqueueApplyJob: passes a deterministic singletonKey derived from pullRequestId", async () => {
  const boss = new FakeBoss();
  const store = new FakeGithubPollStore();

  const r = await enqueueApplyJob({ boss, store, pullRequestId: "pr-row-7" });

  assert.equal(boss.sent.length, 1);
  const opts = boss.sent[0]!.options;
  assert.ok(opts, "send options must be passed to pg-boss");
  assert.equal(opts!.singletonKey, "apply:pr-pr-row-7");
  assert.equal(r.singletonKey, "apply:pr-pr-row-7");
});

test("enqueueApplyJob: caller can override singletonKey for PR+account scope", async () => {
  const boss = new FakeBoss();
  const store = new FakeGithubPollStore();

  const r = await enqueueApplyJob({
    boss,
    store,
    pullRequestId: "pr-1",
    singletonKey: "apply:pr-pr-1:acct-primary",
  });

  assert.equal(boss.sent[0]!.options!.singletonKey, "apply:pr-pr-1:acct-primary");
  assert.equal(r.singletonKey, "apply:pr-pr-1:acct-primary");
});

test("enqueueApplyJob: pg-boss returning null for a duplicate singletonKey is propagated as jobId=null", async () => {
  // pg-boss は同 singletonKey で pending 中の job が既に居る場合、追加 send は null を返す。
  const boss = new FakeBoss();
  boss.rejectDuplicateSingletons = true;
  const store = new FakeGithubPollStore();

  const first = await enqueueApplyJob({ boss, store, pullRequestId: "pr-9" });
  const second = await enqueueApplyJob({ boss, store, pullRequestId: "pr-9" });

  assert.notEqual(first.jobId, null, "first send must succeed");
  assert.equal(second.jobId, null, "second send for the same PR must be rejected by singletonKey");
  // apply_jobs 行は両方の試行で残る (2 件目は jobId="" として記録され、UI はそれを
  // 'pg-boss が dedupe した試行' として表示できる)。
  assert.equal(store.applyJobs.length, 2);
  assert.equal(store.applyJobs[1]!.jobId, "");
});
