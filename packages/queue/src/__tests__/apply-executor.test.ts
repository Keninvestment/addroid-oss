// AdDroid OSS — execute_apply orchestrator テスト。
//
// pg-boss / Prisma / Meta CLI / GitHub API を一切起動せず、`runExecuteApply` の
// ロジックのみを in-memory fake で検証する。the current implementation 受入基準のうち以下を
// 直接的にカバーする:
//   - 「Apply a valid YAML change as PAUSED resources or a mocked equivalent」
//   - 「New campaigns must be created PAUSED by default」
//   - 「Tests or local simulations cover success, auth failure, rate-limit
//      failure, dry-run failure, and activation approval boundaries」

import test from "node:test";
import assert from "node:assert/strict";
import type { BrandYaml } from "@addroid/yaml-schemas";
import {
  buildAdAccountLockKey,
  createCrossProcessAdAccountLockProvider,
  enforcePausedOnPlanAction,
  runExecuteApply,
  type AccountAdsState,
  type AdsLoadResult,
  type AdAccountLockProvider,
  type ApplyJobContext,
} from "../index.js";
import {
  FakeAdsLoader,
  FakeApplyJobStore,
  FakeMetaActionExecutor,
} from "./fakes.js";

const APPLY_JOB_ID = "apply-1";
const WORKSPACE_ID = "ws-1";

function ctx(): ApplyJobContext {
  return {
    applyJobId: APPLY_JOB_ID,
    pullRequestId: "pr-row-1",
    prNumber: 42,
    headSha: "deadbeefcafebabe",
    htmlUrl: "https://github.example/owner/repo/pull/42",
    repoId: "repo-1",
  };
}

function brand(initialState: "paused" | "active" = "paused"): BrandYaml {
  // BrandYaml shape is provided by @addroid/yaml-schemas; we build a literal
  // that the schema would have accepted (we don't re-validate here).
  return {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState,
        budget: { dailyUsd: 100 },
        adsets: [],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;
}

function loadResult(accounts: AccountAdsState[], source: AdsLoadResult["source"] = "fixture"): AdsLoadResult {
  return { source, accounts };
}

// ---------------------------------------------------------------------
// enforcePausedOnPlanAction (pure)
// ---------------------------------------------------------------------

test("enforcePausedOnPlanAction rewrites create_campaign initialState=active to paused", () => {
  const r = enforcePausedOnPlanAction({
    kind: "create_campaign",
    account: "primary",
    campaignId: "c1",
    name: "C1",
    objective: "OUTCOME_TRAFFIC",
    initialState: "active",
    budget: { dailyUsd: 50 },
  });
  assert.equal(r.rewritten, true);
  assert.equal((r.action as { initialState: string }).initialState, "paused");
});

test("enforcePausedOnPlanAction leaves already-paused create unchanged", () => {
  const action = {
    kind: "create_campaign" as const,
    account: "primary",
    campaignId: "c1",
    name: "C1",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused" as const,
    budget: { dailyUsd: 50 },
  };
  const r = enforcePausedOnPlanAction(action);
  assert.equal(r.rewritten, false);
  assert.strictEqual(r.action, action);
});

test("enforcePausedOnPlanAction drops initialState changes from update_campaign", () => {
  const r = enforcePausedOnPlanAction({
    kind: "update_campaign",
    account: "primary",
    campaignId: "c1",
    changes: {
      initialState: { from: "paused", to: "active" },
      name: { from: "Old", to: "New" },
    },
  });
  assert.equal(r.rewritten, true);
  const after = r.action as { changes: Record<string, unknown> };
  assert.equal(after.changes.initialState, undefined);
  assert.deepEqual(after.changes.name, { from: "Old", to: "New" });
});

// ---------------------------------------------------------------------
// runExecuteApply — happy path
// ---------------------------------------------------------------------

test("runExecuteApply: success path forces PAUSED, records logs, emits apply.executed audit", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // YAML 上は active で宣言されていても apply 経路で paused に強制されること。
  const loader = new FakeAdsLoader(
    loadResult([
      { accountKey: "primary", next: brand("active"), previous: null },
    ])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "created campaign",
      logPayload: { sanitizedCommand: "meta-ads-cli campaigns create [REDACTED]" },
      externalId: "act_1/cmp_1",
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "succeeded");
  assert.equal(summary.totalActions, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.pausedRewrites, 1, "create_* with active should be rewritten to paused");

  // executor に渡された action は paused 化されているはず (PAUSED-by-default)。
  assert.equal(executor.calls.length, 1);
  const passed = executor.calls[0]!.action;
  assert.equal(passed.kind, "create_campaign");
  assert.equal((passed as { initialState: string }).initialState, "paused");

  // apply_jobs 遷移
  assert.equal(store.runningCalls.length, 1);
  assert.equal(store.finishedCalls.length, 1);
  assert.equal(store.finishedCalls[0]!.state, "succeeded");

  // audit_logs 終端は apply.executed
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.action, "apply.executed");
  assert.equal(store.audits[0]!.applyJobId, APPLY_JOB_ID);
  assert.equal(store.audits[0]!.prNumber, 42);

  // execution_logs に少なくとも start + per-action + (optional finish) が入る
  assert.ok(store.executionLogs.length >= 2, "at least start + 1 action log");
  assert.ok(
    store.executionLogs.some((l) => l.message.includes("starting")),
    "start log should be present"
  );
  assert.ok(
    store.executionLogs.some((l) => l.message.includes("create_campaign")),
    "per-action log should be present"
  );
});

// ---------------------------------------------------------------------
// regression fix: approvalRecordId propagation from snapshot to executor
// ---------------------------------------------------------------------

test("runExecuteApply: snapshot.approvalRecordId is propagated into ExecuteActionInput.context", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "merged",
    branchProtectionApplied: true,
    latestApprovalDecision: "auto_approved",
    approvalRecordId: "appr-from-snapshot-123",
    mergedAt: new Date("2026-05-01T00:00:00Z"),
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "succeeded");
  assert.equal(executor.calls.length, 1);
  // executor が受け取る ApplyJobContext には snapshot 由来の approvalRecordId が
  // 焼き付けられているべき (Apply 経路の Meta CLI invocation refs.approvalRecordId
  // としてそのまま使われる情報)。
  assert.equal(
    executor.calls[0]!.context.approvalRecordId,
    "appr-from-snapshot-123",
    "executor.context.approvalRecordId must come from loadApplyApprovalSnapshot"
  );
});

test("runExecuteApply: snapshot without approvalRecordId leaves context.approvalRecordId null (not undefined)", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  // snapshot 自体は revalidation を通過する happy-path 構成だが、approvalRecordId は
  // null (= 取得側がまだ approvalRecordId を埋めていない後方互換ケース)。
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "merged",
    branchProtectionApplied: true,
    latestApprovalDecision: "auto_approved",
    approvalRecordId: null,
    mergedAt: new Date("2026-05-01T00:00:00Z"),
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(executor.calls.length, 1);
  assert.equal(
    executor.calls[0]!.context.approvalRecordId,
    null,
    "missing approvalRecordId in snapshot should surface as null on context"
  );
});

// ---------------------------------------------------------------------
// runExecuteApply — no source → simulated
// ---------------------------------------------------------------------

test("runExecuteApply: empty AdsLoader result records simulated state and apply.simulated audit", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader({
    source: "unavailable",
    detail: "ADDROID_OPS_REPO_LOCAL_DIR not set",
    accounts: [],
  });
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "simulated");
  assert.equal(summary.source, "unavailable");
  assert.equal(executor.calls.length, 0, "executor should not be called when source is missing");
  assert.equal(store.finishedCalls[0]!.state, "simulated");
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.action, "apply.simulated");
});

// ---------------------------------------------------------------------
// runExecuteApply — plan error finding (e.g. guardrail violation)
// ---------------------------------------------------------------------

test("runExecuteApply: plan with error finding fails before executor runs", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // ad.creativeRef が creatives[] に無い → buildExecutionPlan が error finding を出す
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "c1",
        name: "C1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [
          {
            id: "as1",
            name: "AS1",
            initialState: "paused",
            targeting: {
              countries: ["JP"],
              interests: [],
              customAudiences: [],
            },
            ads: [
              {
                id: "ad1",
                name: "Ad1",
                creativeRef: "missing-creative",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "plan_error");
  assert.equal(executor.calls.length, 0, "executor must not run when plan has errors");
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.action, "apply.failed");
  assert.equal(
    (store.audits[0]!.metadata as { reason: string }).reason,
    "plan_error"
  );
});

// ---------------------------------------------------------------------
// runExecuteApply — auth_error: aborts and emits reauth audit
// ---------------------------------------------------------------------

test("runExecuteApply: auth_error aborts apply and emits oauth.meta.reauth_required audit", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // Two campaigns so we can verify that the second action is skipped after the abort.
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "c1",
        name: "C1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
      {
        id: "c2",
        name: "C2",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "auth_error",
      message: "Meta token expired",
      logPayload: { exitClass: "auth_error" },
    },
    // 2 件目は呼ばれない想定。呼ばれたらここを fall back に当てる。
    {
      status: "success",
      message: "should not be reached",
      logPayload: {},
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "auth_error");
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1, "remaining action must be skipped");
  assert.equal(executor.calls.length, 1, "executor is called only for the first action");

  // audit には re-auth 要求と apply.failed の両方が乗る。
  const auditActions = store.audits.map((a) => a.action);
  assert.ok(auditActions.includes("oauth.meta.reauth_required"));
  assert.ok(auditActions.includes("apply.failed"));
});

// ---------------------------------------------------------------------
// runExecuteApply — api_error: aborts and emits notify-driven audit
// ---------------------------------------------------------------------

test("runExecuteApply: api_error aborts apply and emits meta.api_error audit driven by executor.notify", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "c1",
        name: "C1",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
      {
        id: "c2",
        name: "C2",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "api_error",
      message: "Meta rejected the request: Invalid parameter",
      logPayload: { exitClass: "api_error" },
      notify: {
        auditAction: "meta.api_error",
        detail: "Meta rejected the request: Invalid parameter",
      },
    },
    // 2 件目は呼ばれない想定
    {
      status: "success",
      message: "should not be reached",
      logPayload: {},
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "api_error");
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1, "remaining action must be skipped");
  assert.equal(executor.calls.length, 1);

  const auditActions = store.audits.map((a) => a.action);
  assert.ok(
    auditActions.includes("meta.api_error"),
    "orchestrator must emit meta.api_error notification audit driven by result.notify"
  );
  assert.ok(auditActions.includes("apply.failed"));
});

// ---------------------------------------------------------------------
// runExecuteApply — unknown_error with notify drives meta.cli_unknown_error audit
// ---------------------------------------------------------------------

test("runExecuteApply: unknown_error with notify hint emits meta.cli_unknown_error audit", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "unknown_error",
      message: "meta-cli crashed (exit 139)",
      logPayload: { exitClass: "unknown_error" },
      notify: {
        auditAction: "meta.cli_unknown_error",
        detail: "Meta CLI crashed unexpectedly",
      },
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unknown_error");

  const auditActions = store.audits.map((a) => a.action);
  assert.ok(
    auditActions.includes("meta.cli_unknown_error"),
    "orchestrator must emit meta.cli_unknown_error audit driven by result.notify"
  );
  assert.ok(auditActions.includes("apply.failed"));
});

// ---------------------------------------------------------------------
// runExecuteApply — rate_limit retry then success
// ---------------------------------------------------------------------

test("runExecuteApply: rate_limit_error retries with backoff before succeeding", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "rate_limit_error",
      message: "throttled",
      logPayload: { exitClass: "rate_limit_error" },
      retry: { delayMs: 10, maxAttempts: 3 },
    },
    {
      status: "rate_limit_error",
      message: "throttled again",
      logPayload: { exitClass: "rate_limit_error" },
      retry: { delayMs: 10, maxAttempts: 3 },
    },
    {
      status: "success",
      message: "ok after backoff",
      logPayload: { exitClass: "success" },
      externalId: "act_1/cmp_fall",
    },
  ]);

  const sleeps: number[] = [];
  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(summary.state, "succeeded");
  assert.equal(executor.calls.length, 3, "two retries + final success");
  assert.equal(sleeps.length, 2, "two sleeps between three attempts");
  assert.equal(sleeps[0], 10);
  assert.equal(sleeps[1], 10);
  assert.equal(summary.outcomes[0]!.attempts, 3);
});

test("runExecuteApply: rate_limit_error exhausts retries and fails", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const repeatedThrottle = {
    status: "rate_limit_error" as const,
    message: "throttled",
    logPayload: { exitClass: "rate_limit_error" },
    retry: { delayMs: 1, maxAttempts: 2 },
  };
  const executor = new FakeMetaActionExecutor([
    repeatedThrottle,
    repeatedThrottle,
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "rate_limit_exhausted");
  assert.equal(executor.calls.length, 2, "stops after maxAttempts=2");
  assert.equal(store.finishedCalls[0]!.state, "failed");
  assert.equal(store.audits.at(-1)!.action, "apply.failed");
});

// ---------------------------------------------------------------------
// runExecuteApply — context not found
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// release readiness: per-account concurrency=1 across runExecuteApply
// ---------------------------------------------------------------------

test("runExecuteApply: serializes concurrent applies that touch the same ad_account", async () => {
  const APPLY_A = "apply-conc-a";
  const APPLY_B = "apply-conc-b";

  const storeA = new FakeApplyJobStore();
  storeA.setContext(APPLY_A, { ...ctx(), applyJobId: APPLY_A });
  const storeB = new FakeApplyJobStore();
  storeB.setContext(APPLY_B, { ...ctx(), applyJobId: APPLY_B });

  const loaderA = new FakeAdsLoader(
    loadResult([{ accountKey: "shared-acct", next: brand("paused"), previous: null }])
  );
  const loaderB = new FakeAdsLoader(
    loadResult([{ accountKey: "shared-acct", next: brand("paused"), previous: null }])
  );

  // 1 つのスケジューラを共有: action ごとに sleep を入れて並行実行を観測する。
  const sequence: string[] = [];
  const slowExecutor = (label: string): FakeMetaActionExecutor => {
    const exec = new FakeMetaActionExecutor();
    const original = exec.executeAction.bind(exec);
    exec.executeAction = async (input) => {
      sequence.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 25));
      sequence.push(`end:${label}`);
      return original(input);
    };
    return exec;
  };

  const lockRegistry = new Map<string, Promise<unknown>>();

  const runA = runExecuteApply({
    applyJobId: APPLY_A,
    workspaceId: WORKSPACE_ID,
    store: storeA,
    loader: loaderA,
    executor: slowExecutor("a"),
    sleep: async () => {},
    lockRegistry,
  });
  const runB = runExecuteApply({
    applyJobId: APPLY_B,
    workspaceId: WORKSPACE_ID,
    store: storeB,
    loader: loaderB,
    executor: slowExecutor("b"),
    sleep: async () => {},
    lockRegistry,
  });

  const [sumA, sumB] = await Promise.all([runA, runB]);
  assert.equal(sumA.state, "succeeded");
  assert.equal(sumB.state, "succeeded");
  // 同一 ad_account のため A 完了後に B が start するはず (interleave しない)。
  assert.deepEqual(sequence, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
  ]);
});

test("runExecuteApply: different ad_accounts run concurrently (lock is per-account)", async () => {
  const APPLY_A = "apply-acct-a";
  const APPLY_B = "apply-acct-b";

  const storeA = new FakeApplyJobStore();
  storeA.setContext(APPLY_A, { ...ctx(), applyJobId: APPLY_A });
  const storeB = new FakeApplyJobStore();
  storeB.setContext(APPLY_B, { ...ctx(), applyJobId: APPLY_B });

  const loaderA = new FakeAdsLoader(
    loadResult([{ accountKey: "acct-A", next: brand("paused"), previous: null }])
  );
  const loaderB = new FakeAdsLoader(
    loadResult([{ accountKey: "acct-B", next: brand("paused"), previous: null }])
  );

  const sequence: string[] = [];
  const slowExecutor = (label: string): FakeMetaActionExecutor => {
    const exec = new FakeMetaActionExecutor();
    const original = exec.executeAction.bind(exec);
    exec.executeAction = async (input) => {
      sequence.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 15));
      sequence.push(`end:${label}`);
      return original(input);
    };
    return exec;
  };

  const lockRegistry = new Map<string, Promise<unknown>>();

  const [sumA, sumB] = await Promise.all([
    runExecuteApply({
      applyJobId: APPLY_A,
      workspaceId: WORKSPACE_ID,
      store: storeA,
      loader: loaderA,
      executor: slowExecutor("a"),
      sleep: async () => {},
      lockRegistry,
    }),
    runExecuteApply({
      applyJobId: APPLY_B,
      workspaceId: WORKSPACE_ID,
      store: storeB,
      loader: loaderB,
      executor: slowExecutor("b"),
      sleep: async () => {},
      lockRegistry,
    }),
  ]);

  assert.equal(sumA.state, "succeeded");
  assert.equal(sumB.state, "succeeded");
  // 別 account のため interleave 可能: 最初の 2 件は両方 start:* (= 並列起動)。
  assert.equal(sequence.filter((e) => e.startsWith("start:")).length, 2);
  assert.equal(sequence.filter((e) => e.startsWith("end:")).length, 2);
  assert.ok(sequence[0]!.startsWith("start:"));
  assert.ok(sequence[1]!.startsWith("start:"));
});

test("runExecuteApply: missing apply_job context fails fast with no_context reason", async () => {
  const store = new FakeApplyJobStore();
  // intentionally no setContext

  const loader = new FakeAdsLoader(loadResult([]));
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(store.runningCalls.length, 0, "must not flip to running without context");
  assert.equal(store.finishedCalls.length, 1);
  assert.equal(store.finishedCalls[0]!.state, "failed");
  // audit はこのケースでは記録しない (PR 外なので ref が立たない)。
  assert.equal(store.audits.length, 0);
});

// ---------------------------------------------------------------------
// regression fix: execute-time GitOps revalidation
//
// enqueue 時に branch protection を経由して auto_approved になっていても、
// 実行段階で「PR が merged ではない / protection が外れた / approval_records が
// 無い / 最新 approval が rejected/auto_blocked」のいずれかに該当する場合、
// Meta mutation 経路に到達する前に fail-closed して audit に残すこと。
// ---------------------------------------------------------------------

test("runExecuteApply: stale apply_job whose PR is no longer merged is blocked before executor runs", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "closed",
    branchProtectionApplied: true,
    latestApprovalDecision: "auto_approved",
    approvalRecordId: "appr-stale-pr",
    mergedAt: null,
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unapproved_state");
  assert.equal(executor.calls.length, 0, "executor must not run on stale PR state");
  assert.equal(store.runningCalls.length, 0, "must not flip to running on revalidation failure");
  assert.equal(store.finishedCalls.length, 1);
  assert.equal(store.finishedCalls[0]!.state, "failed");
  const result = store.finishedCalls[0]!.result as { reason: string; revalidation: string };
  assert.equal(result.reason, "unapproved_state");
  assert.equal(result.revalidation, "pr_not_merged");

  const auditActions = store.audits.map((a) => a.action);
  assert.deepEqual(auditActions, ["apply.blocked_unapproved"]);
  const auditMeta = store.audits[0]!.metadata as { reason: string };
  assert.equal(auditMeta.reason, "pr_not_merged");
  // execution_logs に level=error の revalidation 行が残ること
  assert.ok(
    store.executionLogs.some(
      (l) => l.level === "error" && l.message.includes("blocked")
    ),
    "execution log must include blocked entry at error level"
  );
});

test("runExecuteApply: ops repo without branch protection at execution time blocks the apply", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "merged",
    branchProtectionApplied: false,
    latestApprovalDecision: "auto_approved",
    approvalRecordId: "appr-no-protection",
    mergedAt: new Date("2026-05-01T00:00:00Z"),
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unapproved_state");
  assert.equal(executor.calls.length, 0);
  assert.equal(store.runningCalls.length, 0);
  const auditMeta = store.audits[0]!.metadata as { reason: string };
  assert.equal(auditMeta.reason, "branch_protection_revoked");
  assert.equal(store.audits[0]!.action, "apply.blocked_unapproved");
});

test("runExecuteApply: manually inserted apply_job without an approval_record fails closed", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "merged",
    branchProtectionApplied: true,
    latestApprovalDecision: null,
    approvalRecordId: null,
    mergedAt: new Date("2026-05-01T00:00:00Z"),
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unapproved_state");
  assert.equal(executor.calls.length, 0);
  const auditMeta = store.audits[0]!.metadata as { reason: string };
  assert.equal(auditMeta.reason, "no_approval_record");
});

test("runExecuteApply: latest approval_records.decision='auto_blocked' blocks execute time", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "merged",
    branchProtectionApplied: true,
    latestApprovalDecision: "auto_blocked",
    approvalRecordId: "appr-blocked",
    mergedAt: new Date("2026-05-01T00:00:00Z"),
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unapproved_state");
  assert.equal(executor.calls.length, 0);
  const auditMeta = store.audits[0]!.metadata as { reason: string };
  assert.equal(auditMeta.reason, "approval_rejected");
});

test("runExecuteApply: snapshot returning null (apply_job missing in approval boundary) blocks execution", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  // 明示的に snapshot を null に倒す (= PR 行が消えている / repo 紐付けが壊れた等)。
  store.setApprovalSnapshot(APPLY_JOB_ID, null);

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unapproved_state");
  assert.equal(executor.calls.length, 0);
  const auditMeta = store.audits[0]!.metadata as { reason: string };
  assert.equal(auditMeta.reason, "snapshot_unavailable");
});

// ---------------------------------------------------------------------
// regression fix: per-account execution mode revalidation at execute time
//
// `runGithubPollOnce` の hard-lock を擦り抜けた apply_job (= override 経由で
// 一部 ad_account のみ mutate 可能だった workspace、または mode が PR merge と
// 実行の間に書き換えられた workspace) に対し、AdsLoader が返した accountKey
// 集合のうち 1 件でも `report_only` に解決されれば、Meta executor を呼ばずに
// `apply.blocked_unapproved` audit に倒すこと。
// ---------------------------------------------------------------------

test("runExecuteApply: report_only workspace mode blocks all touched accounts before executor runs", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setExecutionModeContext({
    workspaceMode: "report_only",
    overrideByAccountKey: { primary: null },
  });

  const loader = new FakeAdsLoader(
    loadResult([
      { accountKey: "primary", next: brand("paused"), previous: null },
    ])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "report_only_mode");
  assert.equal(executor.calls.length, 0, "executor must not run under report_only");
  // markApplyRunning は revalidation 失敗で先行する unapproved_state と
  // 同じく走らないが、report_only_mode は AdsLoader 後に評価するため
  // running 遷移が既に通過している。startedAt は markApplyRunning が打つ。
  assert.equal(store.runningCalls.length, 1);
  assert.equal(store.finishedCalls.length, 1);
  assert.equal(store.finishedCalls[0]!.state, "failed");
  const result = store.finishedCalls[0]!.result as {
    reason: string;
    workspaceMode: string;
  };
  assert.equal(result.reason, "report_only_mode");
  assert.equal(result.workspaceMode, "report_only");

  // audit_logs に apply.blocked_unapproved が 1 行残ること。
  const blocked = store.audits.find(
    (a) => a.action === "apply.blocked_unapproved"
  );
  assert.ok(blocked, "blocked audit row required");
  const meta = blocked!.metadata as {
    reason: string;
    reportOnlyAccounts: Array<{ accountKey: string; effectiveMode: string }>;
  };
  assert.equal(meta.reason, "report_only_mode");
  assert.equal(meta.reportOnlyAccounts.length, 1);
  assert.equal(meta.reportOnlyAccounts[0]!.accountKey, "primary");
  assert.equal(meta.reportOnlyAccounts[0]!.effectiveMode, "report_only");

  // execution_logs に level=error の mode_revalidation 行が残ること。
  assert.ok(
    store.executionLogs.some(
      (l) =>
        l.level === "error" &&
        typeof l.message === "string" &&
        l.message.includes("report_only_mode")
    ),
    "execution log must include report_only_mode entry at error level"
  );

  // store.loadAccountExecutionModes に AdsLoader の accountKeys が渡されたこと。
  assert.equal(store.loadAccountExecutionModesCalls.length, 1);
  assert.deepEqual(store.loadAccountExecutionModesCalls[0]!.accountKeys, [
    "primary",
  ]);
});

test("runExecuteApply: per-account modeOverride=report_only blocks even if workspace mode allows mutation", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setExecutionModeContext({
    workspaceMode: "auto_apply",
    overrideByAccountKey: { primary: "report_only" },
  });

  const loader = new FakeAdsLoader(
    loadResult([
      { accountKey: "primary", next: brand("paused"), previous: null },
    ])
  );
  const executor = new FakeMetaActionExecutor();

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "report_only_mode");
  assert.equal(executor.calls.length, 0);
  const blocked = store.audits.find(
    (a) => a.action === "apply.blocked_unapproved"
  );
  assert.ok(blocked, "blocked audit row required");
  const meta = blocked!.metadata as {
    reportOnlyAccounts: Array<{
      accountKey: string;
      override: string | null;
      effectiveMode: string;
    }>;
  };
  assert.equal(meta.reportOnlyAccounts.length, 1);
  assert.equal(meta.reportOnlyAccounts[0]!.accountKey, "primary");
  assert.equal(meta.reportOnlyAccounts[0]!.override, "report_only");
  assert.equal(meta.reportOnlyAccounts[0]!.effectiveMode, "report_only");
});

test("runExecuteApply: workspace=report_only with per-account override=proposal proceeds for that account", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setExecutionModeContext({
    workspaceMode: "report_only",
    overrideByAccountKey: { primary: "proposal" },
  });

  const loader = new FakeAdsLoader(
    loadResult([
      { accountKey: "primary", next: brand("paused"), previous: null },
    ])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "created campaign",
      logPayload: { ok: true },
      externalId: "act_1/cmp_1",
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
  });

  assert.equal(summary.state, "succeeded");
  assert.equal(summary.abortReason, undefined);
  assert.equal(executor.calls.length, 1);
  // mode_revalidation は走るが、effective mode が "proposal" のため block 行は出ない。
  assert.equal(
    store.audits.filter((a) => a.action === "apply.blocked_unapproved").length,
    0
  );
});

// ---------------------------------------------------------------------
// regression fix: ads_hierarchy persistence on Apply success
//
// Apply の成功 action は finalResult.externalId と context.headSha を ads_hierarchy
// に PAUSED で焼き付けないと、後続の Activate が "external_id 未確定" で永久に
// 拒否される。本セクションは campaign / adset / ad の create_*/update_* で
// store.upsertAppliedAdsNode が externalId + headSha を含めて呼ばれること、
// および失敗 action では呼ばれないことを保証する。
// ---------------------------------------------------------------------

test("runExecuteApply: persists campaign/adset/ad PAUSED hierarchy nodes with externalId and headSha on success", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // 親子関係 (campaign → adset → ad) を 1 アカウント分構築する。
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "cmp-fall",
        name: "Fall Campaign",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [
          {
            id: "as-jp",
            name: "JP Adset",
            initialState: "paused",
            targeting: { countries: ["JP"], interests: [], customAudiences: [] },
            ads: [
              {
                id: "ad-banner",
                name: "Banner Ad",
                creativeRef: "cr-1",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [{ id: "cr-1", name: "Creative 1", mediaType: "image" }],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous: null }])
  );

  // 各 action 呼び出しで kind ごとに固有の externalId を返す executor を組む。
  const executor = new FakeMetaActionExecutor();
  executor.executeAction = async (input) => {
    return {
      status: "success",
      message: `meta-applied ${input.action.kind}`,
      logPayload: { kind: input.action.kind },
      externalId: `ext-${input.action.kind}`,
    };
  };

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "succeeded");
  // creative + campaign + adset + ad = 4 actions, all success
  assert.equal(summary.succeeded, 4);

  // creative は ads_hierarchy 対象外 (creatives テーブル管轄)。campaign/adset/ad の 3 行のみ。
  assert.equal(
    store.appliedAdsNodes.length,
    3,
    "only campaign/adset/ad are persisted to ads_hierarchy (creative is separate)"
  );

  const campaignNode = store.appliedAdsNodes.find(
    (n) => n.nodeType === "campaign" && n.nodeKey === "cmp-fall"
  );
  assert.ok(campaignNode, "campaign hierarchy row must be persisted");
  assert.equal(campaignNode.workspaceId, WORKSPACE_ID);
  assert.equal(campaignNode.accountKey, "primary");
  assert.equal(campaignNode.displayName, "Fall Campaign");
  assert.equal(campaignNode.externalId, "ext-create_campaign");
  assert.equal(campaignNode.lastCommitSha, "deadbeefcafebabe");
  assert.equal(campaignNode.status, "paused");
  assert.equal(campaignNode.parentNodeKey, undefined);

  const adsetNode = store.appliedAdsNodes.find(
    (n) => n.nodeType === "adset" && n.nodeKey === "as-jp"
  );
  assert.ok(adsetNode, "adset hierarchy row must be persisted");
  assert.equal(adsetNode.parentNodeType, "campaign");
  assert.equal(adsetNode.parentNodeKey, "cmp-fall");
  assert.equal(adsetNode.externalId, "ext-create_adset");
  assert.equal(adsetNode.lastCommitSha, "deadbeefcafebabe");
  assert.equal(adsetNode.status, "paused");

  const adNode = store.appliedAdsNodes.find(
    (n) => n.nodeType === "ad" && n.nodeKey === "ad-banner"
  );
  assert.ok(adNode, "ad hierarchy row must be persisted");
  assert.equal(adNode.parentNodeType, "adset");
  assert.equal(adNode.parentNodeKey, "as-jp");
  assert.equal(adNode.externalId, "ext-create_ad");
  assert.equal(adNode.lastCommitSha, "deadbeefcafebabe");
  assert.equal(adNode.status, "paused");
});

test("runExecuteApply: update_* actions update existing nodes without insert defaults (no displayName unless renamed)", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // previous と next の差分で update_campaign / update_adset / update_ad を発生させる。
  const adset = {
    id: "as-1",
    name: "AS-1",
    initialState: "paused" as const,
    targeting: { countries: ["JP"], interests: [], customAudiences: [] },
    ads: [
      {
        id: "ad-1",
        name: "Ad 1",
        creativeRef: "cr-1",
        initialState: "paused" as const,
      },
    ],
  };
  const previous: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "cmp-1",
        name: "Old Name",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [adset],
      },
    ],
    creatives: [{ id: "cr-1", name: "C1", mediaType: "image" }],
    experiments: [],
  } as BrandYaml;
  // next は campaign の name を変更し、adset の budget を追加 (name 不変),
  // ad の creativeRef を別 creative に切り替える (name 不変)。
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "cmp-1",
        name: "New Name",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [
          {
            ...adset,
            budget: { dailyUsd: 50 },
            ads: [{ ...adset.ads[0]!, creativeRef: "cr-2" }],
          },
        ],
      },
    ],
    creatives: [
      { id: "cr-1", name: "C1", mediaType: "image" },
      { id: "cr-2", name: "C2", mediaType: "image" },
    ],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous }])
  );
  const executor = new FakeMetaActionExecutor();
  executor.executeAction = async (input) => ({
    status: "success",
    message: `meta-applied ${input.action.kind}`,
    logPayload: {},
    externalId: `ext-${input.action.kind}`,
  });

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });
  assert.equal(summary.state, "succeeded");

  const campaignNode = store.appliedAdsNodes.find(
    (n) => n.nodeType === "campaign" && n.nodeKey === "cmp-1"
  );
  assert.ok(campaignNode);
  assert.equal(
    campaignNode.displayName,
    "New Name",
    "renamed campaign should propagate displayName"
  );
  assert.equal(campaignNode.externalId, "ext-update_campaign");
  assert.equal(campaignNode.lastCommitSha, "deadbeefcafebabe");

  const adsetNode = store.appliedAdsNodes.find(
    (n) => n.nodeType === "adset" && n.nodeKey === "as-1"
  );
  assert.ok(adsetNode);
  assert.equal(
    adsetNode.displayName,
    undefined,
    "adset name unchanged → displayName must be undefined to avoid clobbering existing row"
  );
  assert.equal(adsetNode.externalId, "ext-update_adset");

  const adNode = store.appliedAdsNodes.find(
    (n) => n.nodeType === "ad" && n.nodeKey === "ad-1"
  );
  assert.ok(adNode);
  assert.equal(adNode.displayName, undefined);
  assert.equal(adNode.externalId, "ext-update_ad");
});

test("runExecuteApply: failed actions do not persist hierarchy rows", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "auth_error",
      message: "token expired",
      logPayload: {},
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });
  assert.equal(summary.state, "failed");
  assert.equal(
    store.appliedAdsNodes.length,
    0,
    "ads_hierarchy must not record failed Meta operations"
  );
});

test("runExecuteApply: hierarchy upsert failure logs warn execution_log but does not abort apply", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.failNextAppliedAdsNodeUpsert = new Error("simulated DB outage");

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "created campaign",
      logPayload: {},
      externalId: "act_1/cmp_1",
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });
  // Meta 反映自体は成功なので apply は succeeded 終端。
  assert.equal(summary.state, "succeeded");
  assert.equal(summary.succeeded, 1);
  // upsert 失敗が warn として残る。
  const warnLogs = store.executionLogs.filter(
    (l) => l.level === "warn" && l.message.includes("ads_hierarchy upsert failed")
  );
  assert.equal(warnLogs.length, 1);
  const payload = warnLogs[0]!.payload as { errorMessage: string; nodeType: string };
  assert.equal(payload.nodeType, "campaign");
  assert.match(payload.errorMessage, /simulated DB outage/);
});

test("runExecuteApply: revalidation passes when PR is merged + protected + auto_approved (happy path stays succeeded)", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  store.setApprovalSnapshot(APPLY_JOB_ID, {
    pullRequestState: "merged",
    branchProtectionApplied: true,
    latestApprovalDecision: "auto_approved",
    approvalRecordId: "appr-happy",
    mergedAt: new Date("2026-05-01T00:00:00Z"),
  });

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: {},
      externalId: "act_1/cmp_fall",
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "succeeded");
  assert.equal(summary.abortReason, undefined);
  assert.equal(executor.calls.length, 1);
  // revalidation 失敗時の audit は出ない
  assert.equal(
    store.audits.filter((a) => a.action === "apply.blocked_unapproved").length,
    0
  );
});

// ---------------------------------------------------------------------
// regression fix: create_* success WITHOUT externalId must fail closed
//
// Activate (PAUSED → ACTIVE) は ads_hierarchy.externalId を読んで Meta CLI
// を叩くため、Apply の create_* が external_id 無しに success を受け入れて
// しまうと、Meta 側に作成されたかも知れない PAUSED ノードが local では永遠に
// activatable にならない。本テストはその境界を実装が fail-closed にし続ける
// ことを保証する (audit に missing_external_id を残し、PAUSED ads_hierarchy
// 行は決して挿入しない)。
// ---------------------------------------------------------------------

test("runExecuteApply: create_* success without externalId fails closed and emits meta.cli_unknown_error audit", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  // executor は status=success を返すが externalId を欠落させる (旧 mock や
  // CLI stdout から id が抽出できないケースのシミュレーション)。
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok but no id returned",
      logPayload: { stdout: "ok\n" },
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  // 全体は failed にロールアップされる
  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "unknown_error");
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 0);

  // null externalId の PAUSED 行は決して書かれない
  assert.equal(
    store.appliedAdsNodes.length,
    0,
    "must not persist a PAUSED ads_hierarchy row when externalId is missing"
  );

  // audit_logs に missing_external_id 由来の meta.cli_unknown_error が残る
  const cliAudits = store.audits.filter(
    (a) => a.action === "meta.cli_unknown_error"
  );
  assert.equal(cliAudits.length, 1);
  const meta = cliAudits[0]!.metadata as { reason: string; actionKind: string };
  assert.equal(meta.reason, "missing_external_id");
  assert.equal(meta.actionKind, "create_campaign");

  // 終端 audit も apply.failed
  assert.ok(store.audits.some((a) => a.action === "apply.failed"));

  // execution_logs に fail-closed 痕跡 (level=error, reason=missing_external_id)
  const errLogs = store.executionLogs.filter(
    (l) =>
      l.level === "error" &&
      typeof l.message === "string" &&
      l.message.includes("missing_external_id")
  );
  assert.equal(errLogs.length, 1);
});

test("runExecuteApply: update_* success WITHOUT externalId still persists hierarchy update (existing row keeps its externalId)", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // update_campaign を発生させるため previous と next で name を変える。
  const previous: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall Old",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "fall",
        name: "Fall New",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: {},
      // update_* は既存 ads_hierarchy 行が externalId を保持するため、
      // executor が externalId を返さなくても fail-closed にならない。
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  assert.equal(summary.state, "succeeded");
  assert.equal(summary.succeeded, 1);
  assert.equal(store.appliedAdsNodes.length, 1);
  const node = store.appliedAdsNodes[0]!;
  assert.equal(node.nodeType, "campaign");
  assert.equal(node.nodeKey, "fall");
  // externalId 未指定で upsert に入り、実装側 (Prisma store) は既存行の
  // externalId を保持する責務になる。
  assert.equal(node.externalId, undefined);
});

// ---------------------------------------------------------------------
// regression fix: lockProvider injection (cross-process serialization)
// ---------------------------------------------------------------------

test("runExecuteApply: 注入された lockProvider を canonical lockKey で呼ぶ (cross-process gate)", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: {},
      externalId: "act_1/cmp_1",
    },
  ]);

  const acquireOrder: string[] = [];
  const releaseOrder: string[] = [];
  const provider: AdAccountLockProvider = {
    async withLock(lockKey, fn) {
      acquireOrder.push(lockKey);
      try {
        return await fn();
      } finally {
        releaseOrder.push(lockKey);
      }
    },
  };

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
    lockProvider: provider,
  });
  assert.equal(summary.state, "succeeded");
  // canonical key (= buildAdAccountLockKey({ workspaceId, accountKey })) で
  // 1 度だけ lock が取られたこと
  const expectedKey = buildAdAccountLockKey({
    workspaceId: WORKSPACE_ID,
    accountKey: "primary",
  });
  assert.deepEqual(acquireOrder, [expectedKey]);
  assert.deepEqual(releaseOrder, [expectedKey]);
});

test("runExecuteApply: lockProvider が cross-process で hold していると Meta CLI 実行が遅延する", async () => {
  // 別プロセスが lock を保持しているシナリオをシミュレート: provider の withLock
  // は acquire を 30ms 遅らせる。runExecuteApply は acquire 完了まで Meta CLI を
  // 起動しない (= executor.calls は acquire 完了まで増えない) ことを観測する。
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());
  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: {},
      externalId: "act_1/cmp_1",
    },
  ]);
  let releaseExternal!: () => void;
  const externalHeld = new Promise<void>((resolve) => {
    releaseExternal = resolve;
  });
  const provider = createCrossProcessAdAccountLockProvider({
    acquire: async () => {
      await externalHeld;
      return { release: async () => {} };
    },
  });
  const runPromise = runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
    lockProvider: provider,
  });
  // 50ms 経っても executor は呼ばれていないはず (lock 待ち)。
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(executor.calls.length, 0);
  releaseExternal();
  const summary = await runPromise;
  assert.equal(summary.state, "succeeded");
  assert.equal(executor.calls.length, 1);
});

// ---------------------------------------------------------------------
// regression fix: terminal Apply audit must carry external_id / hierarchy.id
// evidence for successful actions and failing-action identification on abort.
// ---------------------------------------------------------------------

test("runExecuteApply: apply.executed audit metadata carries external_id and hierarchy.id for every success", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // campaign + adset + ad の create_* を 1 アカウント分作る。creative も含めて
  // affectedNodes に乗ることを確認する (creative は ads_hierarchy 対象外なので
  // hierarchyId は null)。
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "cmp-fall",
        name: "Fall",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [
          {
            id: "as-jp",
            name: "JP",
            initialState: "paused",
            targeting: { countries: ["JP"], interests: [], customAudiences: [] },
            ads: [
              {
                id: "ad-banner",
                name: "Banner",
                creativeRef: "cr-1",
                initialState: "paused",
              },
            ],
          },
        ],
      },
    ],
    creatives: [{ id: "cr-1", name: "Creative 1", mediaType: "image" }],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous: null }])
  );
  const executor = new FakeMetaActionExecutor();
  executor.executeAction = async (input) => ({
    status: "success",
    message: `meta-applied ${input.action.kind}`,
    logPayload: {},
    externalId: `ext-${input.action.kind}`,
  });

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });
  assert.equal(summary.state, "succeeded");
  assert.equal(summary.succeeded, 4);

  const executedAudit = store.audits.find((a) => a.action === "apply.executed");
  assert.ok(executedAudit, "apply.executed audit row must exist");
  const meta = executedAudit.metadata as {
    succeeded: number;
    affectedNodes: Array<{
      accountKey: string;
      actionKind: string;
      nodeType: string;
      nodeKey: string;
      externalId: string | null;
      hierarchyId: string | null;
    }>;
  };
  // aggregate counts はそのまま残ること
  assert.equal(meta.succeeded, 4);
  // affectedNodes に 4 action 全部が乗ること
  assert.equal(meta.affectedNodes.length, 4);

  const byNodeType = (t: string) => meta.affectedNodes.find((n) => n.nodeType === t)!;
  const campaignRow = byNodeType("campaign");
  assert.equal(campaignRow.actionKind, "create_campaign");
  assert.equal(campaignRow.nodeKey, "cmp-fall");
  assert.equal(campaignRow.accountKey, "primary");
  assert.equal(campaignRow.externalId, "ext-create_campaign");
  assert.ok(
    typeof campaignRow.hierarchyId === "string" && campaignRow.hierarchyId.length > 0,
    "campaign hierarchy.id must be carried into apply.executed audit metadata"
  );
  const adsetRow = byNodeType("adset");
  assert.equal(adsetRow.nodeKey, "as-jp");
  assert.equal(adsetRow.externalId, "ext-create_adset");
  assert.ok(typeof adsetRow.hierarchyId === "string");
  const adRow = byNodeType("ad");
  assert.equal(adRow.nodeKey, "ad-banner");
  assert.equal(adRow.externalId, "ext-create_ad");
  assert.ok(typeof adRow.hierarchyId === "string");
  // creative は ads_hierarchy 対象外なので hierarchyId は null だが、external_id
  // と nodeKey は audit に残ること。
  const creativeRow = byNodeType("creative");
  assert.equal(creativeRow.nodeKey, "cr-1");
  assert.equal(creativeRow.externalId, "ext-create_creative");
  assert.equal(creativeRow.hierarchyId, null);
});

test("runExecuteApply: apply.executed audit metadata reuses ads_hierarchy.id evidence written via upsertAppliedAdsNode", async () => {
  // regression fix acceptance: 「ads_hierarchy externalId evidence is collected
  // and carried forward into the terminal Apply audit row」。
  // upsertAppliedAdsNode が返す local 行 id (= 後段 Activate が `ads_hierarchy.id`
  // で参照する識別子) と、Meta 側の externalId が両方 audit に残ることを確認する。
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: {},
      externalId: "act_42/cmp_fall_real",
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });
  assert.equal(summary.state, "succeeded");

  // ads_hierarchy 永続化が 1 回起きていること
  assert.equal(store.appliedAdsNodes.length, 1);
  const audit = store.audits.find((a) => a.action === "apply.executed")!;
  const meta = audit.metadata as {
    affectedNodes: Array<{ externalId: string | null; hierarchyId: string | null }>;
  };
  assert.equal(meta.affectedNodes.length, 1);
  assert.equal(
    meta.affectedNodes[0]!.externalId,
    "act_42/cmp_fall_real",
    "Meta external_id evidence must be carried into apply.executed audit"
  );
  assert.ok(
    typeof meta.affectedNodes[0]!.hierarchyId === "string" &&
      meta.affectedNodes[0]!.hierarchyId.length > 0,
    "ads_hierarchy.id evidence must be carried into apply.executed audit"
  );
});

test("runExecuteApply: apply.failed audit metadata identifies the failing action and includes succeeded-before-abort affectedNodes", async () => {
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  // 2 つの campaign を入れて、1 つ目だけ Meta 反映に成功し、2 つ目で auth_error
  // が起きるようにする。abort 後の 2 つ目は failingAction、1 つ目は affectedNodes に乗る。
  const next: BrandYaml = {
    version: 1,
    account: { key: "primary", displayName: "Primary" },
    campaigns: [
      {
        id: "cmp-ok",
        name: "Ok",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
      {
        id: "cmp-fail",
        name: "Fail",
        objective: "OUTCOME_TRAFFIC",
        initialState: "paused",
        budget: { dailyUsd: 100 },
        adsets: [],
      },
    ],
    creatives: [],
    experiments: [],
  } as BrandYaml;

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next, previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "first ok",
      logPayload: {},
      externalId: "ext-first-ok",
    },
    {
      status: "auth_error",
      message: "Meta token expired mid-apply",
      logPayload: { exitClass: "auth_error" },
    },
  ]);

  const summary = await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });
  assert.equal(summary.state, "failed");
  assert.equal(summary.abortReason, "auth_error");
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);

  const failedAudit = store.audits.find((a) => a.action === "apply.failed");
  assert.ok(failedAudit, "apply.failed terminal audit row must exist");
  const meta = failedAudit.metadata as {
    reason: string;
    affectedNodes: Array<{
      nodeKey: string;
      externalId: string | null;
      hierarchyId: string | null;
    }>;
    failingAction: {
      accountKey: string;
      actionKind: string;
      nodeType: string;
      nodeKey: string;
      attemptedExternalId: string | null;
    } | null;
  };
  assert.equal(meta.reason, "auth_error");
  // 1 つ目 (cmp-ok) は affectedNodes として残ること
  assert.equal(meta.affectedNodes.length, 1);
  assert.equal(meta.affectedNodes[0]!.nodeKey, "cmp-ok");
  assert.equal(meta.affectedNodes[0]!.externalId, "ext-first-ok");
  assert.ok(
    typeof meta.affectedNodes[0]!.hierarchyId === "string",
    "succeeded-before-abort hierarchy.id must remain in apply.failed audit"
  );
  // 2 つ目 (cmp-fail) は failingAction として識別されること
  assert.ok(meta.failingAction);
  assert.equal(meta.failingAction!.accountKey, "primary");
  assert.equal(meta.failingAction!.actionKind, "create_campaign");
  assert.equal(meta.failingAction!.nodeType, "campaign");
  assert.equal(meta.failingAction!.nodeKey, "cmp-fail");
  assert.equal(
    meta.failingAction!.attemptedExternalId,
    null,
    "auth_error path has no Meta-confirmed externalId"
  );
});

test("runExecuteApply: oauth.meta.reauth_required notification audit also carries failingAction evidence", async () => {
  // 通知系 audit (auth_error / api_error / unknown_error) も abort 元の action を
  // 識別できるよう failingAction を持つこと。
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "auth_error",
      message: "Meta token expired",
      logPayload: { exitClass: "auth_error" },
    },
  ]);

  await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  const reauth = store.audits.find((a) => a.action === "oauth.meta.reauth_required");
  assert.ok(reauth, "auth_error must emit oauth.meta.reauth_required notification audit");
  const meta = reauth.metadata as {
    failingAction: { actionKind: string; nodeKey: string };
  };
  assert.ok(meta.failingAction, "notification audit must carry failingAction evidence");
  assert.equal(meta.failingAction.actionKind, "create_campaign");
  assert.equal(meta.failingAction.nodeKey, "fall");
});

test("runExecuteApply: missing_external_id fail-closed records failingAction in meta.cli_unknown_error and apply.failed audits", async () => {
  // regression fix fail-closed 経路でも failingAction が残ること。
  const store = new FakeApplyJobStore();
  store.setContext(APPLY_JOB_ID, ctx());

  const loader = new FakeAdsLoader(
    loadResult([{ accountKey: "primary", next: brand("paused"), previous: null }])
  );
  const executor = new FakeMetaActionExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: {},
      // intentionally no externalId
    },
  ]);

  await runExecuteApply({
    applyJobId: APPLY_JOB_ID,
    workspaceId: WORKSPACE_ID,
    store,
    loader,
    executor,
    sleep: async () => {},
  });

  const cliAudit = store.audits.find((a) => a.action === "meta.cli_unknown_error");
  assert.ok(cliAudit);
  const cliMeta = cliAudit.metadata as {
    reason: string;
    failingAction: { actionKind: string; nodeKey: string };
  };
  assert.equal(cliMeta.reason, "missing_external_id");
  assert.equal(cliMeta.failingAction.actionKind, "create_campaign");
  assert.equal(cliMeta.failingAction.nodeKey, "fall");

  const failedAudit = store.audits.find((a) => a.action === "apply.failed");
  assert.ok(failedAudit);
  const failedMeta = failedAudit.metadata as {
    affectedNodes: Array<unknown>;
    failingAction: { actionKind: string; nodeKey: string } | null;
  };
  // success-but-no-externalId なので affectedNodes には乗らない (= 永続化拒否)。
  assert.equal(failedMeta.affectedNodes.length, 0);
  // 失敗 action の identification は terminal audit に残る。
  assert.ok(failedMeta.failingAction);
  assert.equal(failedMeta.failingAction!.actionKind, "create_campaign");
  assert.equal(failedMeta.failingAction!.nodeKey, "fall");
});
