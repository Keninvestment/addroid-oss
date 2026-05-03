// AdDroid OSS — Activate オーケストレータ (runActivate) テスト.
//
// Prisma / Meta CLI を一切起動せず、ActivateStore / ActivateExecutor を
// in-memory fake で置換して `runActivate` の挙動を検証する。the current implementation 受入要件
// (success / auth failure / rate-limit failure / dry-run/境界失敗 / activation
// approval boundaries) のうち以下を直接的にカバーする:
//   - "Activate is separate from Apply and records who triggered it."
//   - "Rate limiting enforces ad_account-level concurrency of 1."
//   - "audit_logs link ... Activate, and failure events to external IDs."

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveActivateDecisionSource,
  runActivate,
  withAccountLock,
  type ActivateApprovalInput,
  type ActivateAuditInput,
  type ActivateExecuteInput,
  type ActivateExecuteResult,
  type ActivateExecutor,
  type ActivateNodeSnapshot,
  type ActivateRequest,
  type ActivateStore,
  type ExecutionLogInput,
} from "../activate-executor.js";
import {
  buildAdAccountLockKey,
  createCrossProcessAdAccountLockProvider,
  type AdAccountLockProvider,
} from "../rate-limit.js";

// ---------------------------------------------------------------------
// in-memory fakes
// ---------------------------------------------------------------------

class FakeActivateStore implements ActivateStore {
  nodes = new Map<string, ActivateNodeSnapshot>();
  marks: string[] = [];
  logs: ExecutionLogInput[] = [];
  audits: ActivateAuditInput[] = [];
  approvals: ActivateApprovalInput[] = [];

  async findHierarchyNode(id: string): Promise<ActivateNodeSnapshot | null> {
    return this.nodes.get(id) ?? null;
  }
  async markHierarchyActive(id: string): Promise<void> {
    this.marks.push(id);
    const n = this.nodes.get(id);
    if (n) this.nodes.set(id, { ...n, status: "active" });
  }
  async recordExecutionLog(input: ExecutionLogInput): Promise<void> {
    this.logs.push(input);
  }
  async recordAudit(input: ActivateAuditInput): Promise<void> {
    this.audits.push(input);
  }
  async recordApprovalRecord(input: ActivateApprovalInput): Promise<void> {
    this.approvals.push(input);
  }
}

class ScriptedExecutor implements ActivateExecutor {
  calls: ActivateExecuteInput[] = [];
  responses: ActivateExecuteResult[];
  constructor(responses: ActivateExecuteResult[] = []) {
    this.responses = responses;
  }
  async executeActivate(input: ActivateExecuteInput): Promise<ActivateExecuteResult> {
    this.calls.push(input);
    if (this.responses.length === 0) {
      // default success simulates a CLI executor that successfully spawned the
      // Meta CLI: appliedRemotely=true tells runActivate it is safe to commit.
      return {
        status: "success",
        message: `default success for ${input.node.nodeType}`,
        logPayload: { default: true },
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    }
    if (this.responses.length === 1) return this.responses[0]!;
    return this.responses.shift()!;
  }
}

function pausedNode(overrides: Partial<ActivateNodeSnapshot> = {}): ActivateNodeSnapshot {
  return {
    hierarchyId: "node-1",
    workspaceId: "ws-1",
    accountId: "acct-1",
    accountKey: "primary",
    metaAccountId: "act_1234567890",
    nodeType: "campaign",
    nodeKey: "fall",
    displayName: "Fall",
    status: "paused",
    externalId: "cmp_999",
    ...overrides,
  };
}

function req(overrides: Partial<ActivateRequest> = {}): ActivateRequest {
  return {
    hierarchyId: "node-1",
    actor: "user:web-ui",
    source: "web",
    ...overrides,
  };
}

const noopSleep = async (_ms: number) => undefined;

// ---------------------------------------------------------------------
// 1. happy path: 成功 → markActive + activate.requested + activate.committed
// ---------------------------------------------------------------------

test("runActivate: PAUSED ノード成功で markHierarchyActive と activate.committed を記録する", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode());
  const executor = new ScriptedExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: { ok: true },
      externalId: "cmp_999",
      appliedRemotely: true,
    },
  ]);

  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "activated");
  assert.equal(summary.attempts, 1);
  assert.equal(summary.externalId, "cmp_999");
  assert.equal(summary.finalAuditAction, "activate.committed");
  assert.deepEqual(store.marks, ["node-1"]);

  const actions = store.audits.map((a) => a.action);
  assert.deepEqual(actions, ["activate.requested", "activate.committed"]);
  // actor/source/external_id がすべての audit に乗ること
  for (const a of store.audits) {
    assert.equal(a.actor, "user:web-ui");
    assert.equal(a.source, "web");
    assert.equal(a.externalId, "cmp_999");
    assert.equal(a.workspaceId, "ws-1");
  }

  // execution_logs が 1 行 (kind=activate)
  assert.equal(store.logs.length, 1);
  assert.equal(store.logs[0]!.kind, "activate");
  assert.equal(store.logs[0]!.refType, "ads_hierarchy");
  assert.equal(store.logs[0]!.refId, "node-1");

  // implementation item: 成功時は approval_records に decision="approved" + decisionSource="web_activate" が 1 行残る。
  assert.equal(store.approvals.length, 1);
  const approval = store.approvals[0]!;
  assert.equal(approval.decision, "approved");
  assert.equal(approval.decisionSource, "web_activate");
  assert.equal(approval.workspaceId, "ws-1");
  assert.equal(approval.hierarchyId, "node-1");
  assert.equal(approval.approvedBy, "user:web-ui");
});

// regression fix: defensive guard. status=success without appliedRemotely
// must NOT mark the hierarchy ACTIVE — only a verified Meta CLI success can.
test("runActivate: success without appliedRemotely は fail-closed で markActive せず activate.rejected を残す", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode());
  const executor = new ScriptedExecutor([
    {
      status: "success",
      message: "ok (mock)",
      logPayload: { mode: "mock" },
      // appliedRemotely を意図的に欠落させ、未検証 success が
      // ローカル状態を ACTIVE に進めないことを確認する。
      externalId: "cmp_999",
    },
  ]);

  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "unknown_error");
  assert.equal(summary.finalAuditAction, "activate.rejected");
  assert.equal(store.marks.length, 0);
  const actions = store.audits.map((a) => a.action);
  assert.deepEqual(actions, [
    "activate.requested",
    "meta.cli_unknown_error",
    "activate.rejected",
  ]);
});

// ---------------------------------------------------------------------
// 2. ノード未存在
// ---------------------------------------------------------------------

test("runActivate: 存在しない hierarchyId は node_not_found を返し、activate.rejected を 1 行 audit する (regression fix)", async () => {
  const store = new FakeActivateStore();
  const executor = new ScriptedExecutor();

  const summary = await runActivate({
    request: req({ hierarchyId: "missing", note: "by mistake" }),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "node_not_found");
  assert.equal(summary.finalAuditAction, "activate.rejected");
  assert.equal(executor.calls.length, 0);
  assert.equal(store.marks.length, 0);

  // regression fix: node_not_found でも actor/source/hierarchyId/reason を
  // 保持した activate.rejected が 1 行残る。workspaceId / accountKey /
  // metaAccountId / externalId は対象ノード未取得のため null で記録される。
  assert.equal(store.audits.length, 1);
  const audit = store.audits[0]!;
  assert.equal(audit.action, "activate.rejected");
  assert.equal(audit.workspaceId, null);
  assert.equal(audit.accountKey, null);
  assert.equal(audit.metaAccountId, null);
  assert.equal(audit.externalId, null);
  assert.equal(audit.hierarchyId, "missing");
  assert.equal(audit.actor, "user:web-ui");
  assert.equal(audit.source, "web");
  assert.equal(audit.ref, "ads_hierarchy:missing");
  const meta = audit.metadata as {
    reason?: string;
    requestedHierarchyId?: string;
    note?: string;
  };
  assert.equal(meta.reason, "node_not_found");
  assert.equal(meta.requestedHierarchyId, "missing");
  assert.equal(meta.note, "by mistake");

  // implementation item: node_not_found は workspace 不明のため approval_records には書かない
  // (workspace_id 非 null 制約があり、対象 ws を特定できないので fail-safe で skip)。
  assert.equal(store.approvals.length, 0);
});

// ---------------------------------------------------------------------
// 3. boundary: 既に ACTIVE
// ---------------------------------------------------------------------

test("runActivate: ACTIVE のノードは already_active で reject、executor は呼ばれない", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode({ status: "ACTIVE" }));
  const executor = new ScriptedExecutor();

  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "already_active");
  assert.equal(executor.calls.length, 0);
  assert.equal(store.marks.length, 0);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.action, "activate.rejected");

  assert.equal(
    (store.audits[0]!.metadata as { reason?: string }).reason,
    "already_active"
  );

  // implementation item: 境界拒否 (already_active) でも approval_records.decision="rejected" を残す。
  assert.equal(store.approvals.length, 1);
  assert.equal(store.approvals[0]!.decision, "rejected");
  assert.equal(store.approvals[0]!.decisionSource, "web_activate");
  assert.equal(store.approvals[0]!.workspaceId, "ws-1");
  assert.equal(store.approvals[0]!.hierarchyId, "node-1");
});

// ---------------------------------------------------------------------
// 4. boundary: PAUSED でも ACTIVE でもない (archived)
// ---------------------------------------------------------------------

test("runActivate: archived ノードは not_paused で reject", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode({ status: "archived" }));
  const executor = new ScriptedExecutor();

  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "not_paused");
  assert.equal(executor.calls.length, 0);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.action, "activate.rejected");
});

// ---------------------------------------------------------------------
// 5. boundary: external_id 未確定
// ---------------------------------------------------------------------

test("runActivate: external_id が null のノードは no_external_id で reject", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode({ externalId: null }));
  const executor = new ScriptedExecutor();

  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "no_external_id");
  assert.equal(executor.calls.length, 0);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.action, "activate.rejected");
  assert.equal(
    (store.audits[0]!.metadata as { reason?: string }).reason,
    "no_external_id"
  );
});

// ---------------------------------------------------------------------
// 6. failure: auth_error → notify (oauth.meta.reauth_required) + rejected
// ---------------------------------------------------------------------

test("runActivate: auth_error は notify audit と activate.rejected を記録、status は active に更新しない", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode());
  const executor = new ScriptedExecutor([
    {
      status: "auth_error",
      message: "token invalid",
      logPayload: { exitClass: "auth_error" },
      notify: {
        auditAction: "oauth.meta.reauth_required",
        detail: "Meta access token rejected",
      },
    },
  ]);

  const summary = await runActivate({
    request: req({ source: "cli", actor: "user:cli" }),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "auth_error");
  assert.equal(summary.finalAuditAction, "activate.rejected");
  assert.equal(store.marks.length, 0);
  // requested → reauth_required → rejected の 3 行
  const actions = store.audits.map((a) => a.action);
  assert.deepEqual(actions, [
    "activate.requested",
    "oauth.meta.reauth_required",
    "activate.rejected",
  ]);
  for (const a of store.audits) {
    assert.equal(a.actor, "user:cli");
    assert.equal(a.source, "cli");
  }

  // implementation item: 失敗時も approval_records に decision="rejected" + decisionSource="cli_activate" を 1 行残す。
  assert.equal(store.approvals.length, 1);
  assert.equal(store.approvals[0]!.decision, "rejected");
  assert.equal(store.approvals[0]!.decisionSource, "cli_activate");
  assert.equal(store.approvals[0]!.approvedBy, "user:cli");
});

// implementation item: Slack 経路の Activate 成功も Web/CLI と同じ承認境界 (approval_records) に
// 1 行記録する。`audit_logs.actor='slack:<user_id>'` と
// `approval_records.metadata.decisionSource='slack_activate'` のペアで actor 帰属が
// 監査可能になることを検証する。
test("runActivate: Slack 経路の Activate 成功で approval_records に decisionSource='slack_activate' が残る", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode());
  const executor = new ScriptedExecutor([
    {
      status: "success",
      message: "ok",
      logPayload: { ok: true },
      externalId: "cmp_999",
      appliedRemotely: true,
    },
  ]);

  const summary = await runActivate({
    request: req({ source: "slack", actor: "slack:U012ABC" }),
    store,
    executor,
    sleep: noopSleep,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "activated");
  assert.equal(summary.finalAuditAction, "activate.committed");

  // approval_records: 1 行、approved + slack_activate。
  assert.equal(store.approvals.length, 1);
  const approval = store.approvals[0]!;
  assert.equal(approval.decision, "approved");
  assert.equal(approval.decisionSource, "slack_activate");
  assert.equal(approval.approvedBy, "slack:U012ABC");
  assert.equal(approval.workspaceId, "ws-1");
  assert.equal(approval.hierarchyId, "node-1");

  // metadata に source / accountKey / outcome / externalId が含まれること。
  const meta = approval.metadata as {
    outcome?: string;
    source?: string;
    accountKey?: string;
    externalId?: string | null;
  };
  assert.equal(meta.outcome, "activated");
  assert.equal(meta.source, "slack");
  assert.equal(meta.accountKey, "primary");
  assert.equal(meta.externalId, "cmp_999");
});

// implementation item: deriveActivateDecisionSource は ActivateSource → decisionSource の
// 1:1 写像を保証する。UI design plan §0.20 のラベル一覧と同期させる回帰防止。
test("deriveActivateDecisionSource: web/slack/cli の各経路を decisionSource に正規化する", () => {
  assert.equal(deriveActivateDecisionSource("web"), "web_activate");
  assert.equal(deriveActivateDecisionSource("slack"), "slack_activate");
  assert.equal(deriveActivateDecisionSource("cli"), "cli_activate");
});

// ---------------------------------------------------------------------
// 7. retry: rate_limit_error → backoff → success
// ---------------------------------------------------------------------

test("runActivate: rate_limit_error → 再試行で成功すると activated になる", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode());
  const executor = new ScriptedExecutor([
    {
      status: "rate_limit_error",
      message: "throttled",
      logPayload: { exitClass: "rate_limit_error" },
      retry: { delayMs: 1, maxAttempts: 3 },
    },
    {
      status: "success",
      message: "ok",
      logPayload: { ok: true },
      externalId: "cmp_999",
      appliedRemotely: true,
    },
  ]);

  const sleepCalls: number[] = [];
  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "activated");
  assert.equal(summary.attempts, 2);
  assert.deepEqual(sleepCalls, [1]);
  assert.deepEqual(store.marks, ["node-1"]);
  // execution_logs が 2 行 (各 attempt)
  assert.equal(store.logs.length, 2);
});

// ---------------------------------------------------------------------
// 8. retry exhausted
// ---------------------------------------------------------------------

test("runActivate: rate_limit が上限まで続いたら rate_limit_exhausted で reject", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("node-1", pausedNode());
  const executor = new ScriptedExecutor([
    {
      status: "rate_limit_error",
      message: "throttled",
      logPayload: { exitClass: "rate_limit_error" },
      retry: { delayMs: 1, maxAttempts: 2 },
    },
  ]);

  const summary = await runActivate({
    request: req(),
    store,
    executor,
    sleep: async () => undefined,
    lockRegistry: new Map(),
  });

  assert.equal(summary.status, "rate_limit_exhausted");
  assert.equal(summary.finalAuditAction, "activate.rejected");
  assert.equal(store.marks.length, 0);
  assert.equal(executor.calls.length, 2);
  const actions = store.audits.map((a) => a.action);
  assert.deepEqual(actions, ["activate.requested", "activate.rejected"]);
});

// ---------------------------------------------------------------------
// 9. per-account concurrency lock: 同一 account は直列化、別 account は並行可
// ---------------------------------------------------------------------

test("withAccountLock: 同一 accountId の並行呼び出しを直列化する", async () => {
  const registry = new Map<string, Promise<unknown>>();
  const sequence: string[] = [];
  const start = (label: string, ms: number) =>
    withAccountLock(
      "acct-1",
      async () => {
        sequence.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, ms));
        sequence.push(`end:${label}`);
        return label;
      },
      registry
    );

  const [a, b, c] = await Promise.all([start("a", 30), start("b", 5), start("c", 1)]);
  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.equal(c, "c");
  assert.deepEqual(sequence, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
});

test("withAccountLock: 異なる accountId は並行に実行される", async () => {
  const registry = new Map<string, Promise<unknown>>();
  const events: string[] = [];
  const job = (account: string) =>
    withAccountLock(
      account,
      async () => {
        events.push(`start:${account}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`end:${account}`);
      },
      registry
    );

  await Promise.all([job("acct-A"), job("acct-B")]);
  // 並行実行のため start が両方先に出るはず
  assert.equal(events[0]?.startsWith("start:"), true);
  assert.equal(events[1]?.startsWith("start:"), true);
  assert.equal(events.filter((e) => e.startsWith("start:")).length, 2);
  assert.equal(events.filter((e) => e.startsWith("end:")).length, 2);
});

test("runActivate: 同一 ad_account の Activate 要求は直列化される (concurrency 1)", async () => {
  const store = new FakeActivateStore();
  store.nodes.set("n1", pausedNode({ hierarchyId: "n1", externalId: "cmp_1" }));
  store.nodes.set("n2", pausedNode({ hierarchyId: "n2", externalId: "cmp_2" }));
  const sequence: string[] = [];
  const slow: ActivateExecutor = {
    async executeActivate(input) {
      sequence.push(`start:${input.node.hierarchyId}`);
      await new Promise((r) => setTimeout(r, 20));
      sequence.push(`end:${input.node.hierarchyId}`);
      return {
        status: "success",
        message: "ok",
        logPayload: { ok: true },
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    },
  };
  const lockRegistry = new Map<string, Promise<unknown>>();
  const r1 = runActivate({
    request: req({ hierarchyId: "n1" }),
    store,
    executor: slow,
    sleep: noopSleep,
    lockRegistry,
  });
  const r2 = runActivate({
    request: req({ hierarchyId: "n2" }),
    store,
    executor: slow,
    sleep: noopSleep,
    lockRegistry,
  });
  await Promise.all([r1, r2]);

  // 同一 acct-1 のため n1 が完了するまで n2 は start しない
  assert.deepEqual(sequence, ["start:n1", "end:n1", "start:n2", "end:n2"]);
});

// ---------------------------------------------------------------------
// 10. Apply×Activate cross-path concurrency (regression fix)
//
// Apply 経路は `buildAdAccountLockKey({ workspaceId, accountKey })` で lock を
// 取り、Activate 経路も同じ canonical 識別子で lock を取る。両者が共有 registry
// を使う限り、同一 (workspaceId, accountKey) を指す並行操作は直列化される。
// 本テストは Apply 側を `withAccountLock` の直接利用で擬似し、Activate と Apply
// の race が `accountId` (UUID) と `accountKey` (string) の不整合で抜けて
// しまった旧実装の回帰を防ぐ。
// ---------------------------------------------------------------------

test("runActivate × Apply: 同一 (workspaceId, accountKey) の lock を共有して直列化される", async () => {
  const store = new FakeActivateStore();
  store.nodes.set(
    "node-x",
    pausedNode({
      hierarchyId: "node-x",
      workspaceId: "ws-1",
      accountId: "acct-uuid-1",
      accountKey: "primary",
      externalId: "cmp_xyz",
    })
  );
  const sequence: string[] = [];
  const slowActivateExecutor: ActivateExecutor = {
    async executeActivate(input) {
      sequence.push("start:activate");
      await new Promise((r) => setTimeout(r, 25));
      sequence.push("end:activate");
      return {
        status: "success",
        message: "ok",
        logPayload: { ok: true },
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    },
  };

  // Apply 経路と Activate 経路は同じ in-process registry を共有する想定。
  const lockRegistry = new Map<string, Promise<unknown>>();

  // Activate 側を先に起動 → lock を保持したまま 25ms 寝る。
  const activatePromise = runActivate({
    request: req({ hierarchyId: "node-x" }),
    store,
    executor: slowActivateExecutor,
    sleep: noopSleep,
    lockRegistry,
  });

  // 直後に Apply 経路を擬似する: runExecuteApply は per-account block を
  // `withAccountLock(buildAdAccountLockKey({workspaceId, accountKey}), ...)` で
  // 包む。同じ canonical 識別子を渡せば Activate が解放するまで待たされる。
  // race で Activate より先に lock が取れる可能性を排し確実に Activate を
  // 先行させるため、setImmediate で 1 tick 譲ってから Apply を発火する。
  await new Promise<void>((r) => setImmediate(r));
  const applyPromise = withAccountLock(
    buildAdAccountLockKey({ workspaceId: "ws-1", accountKey: "primary" }),
    async () => {
      sequence.push("start:apply");
      await new Promise((r) => setTimeout(r, 5));
      sequence.push("end:apply");
    },
    lockRegistry
  );

  const [activateSummary] = await Promise.all([activatePromise, applyPromise]);
  assert.equal(activateSummary.status, "activated");

  // Activate が start→end まで完了したあと Apply が start するはず (interleave しない)。
  assert.deepEqual(sequence, [
    "start:activate",
    "end:activate",
    "start:apply",
    "end:apply",
  ]);
});

test("runActivate × Apply: 異なる accountKey 同士は並行に走る", async () => {
  const store = new FakeActivateStore();
  store.nodes.set(
    "node-y",
    pausedNode({
      hierarchyId: "node-y",
      workspaceId: "ws-1",
      accountId: "acct-uuid-1",
      accountKey: "primary",
      externalId: "cmp_yyy",
    })
  );
  const sequence: string[] = [];
  const slowActivateExecutor: ActivateExecutor = {
    async executeActivate(input) {
      sequence.push("start:activate");
      await new Promise((r) => setTimeout(r, 15));
      sequence.push("end:activate");
      return {
        status: "success",
        message: "ok",
        logPayload: { ok: true },
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    },
  };
  const lockRegistry = new Map<string, Promise<unknown>>();

  const activatePromise = runActivate({
    request: req({ hierarchyId: "node-y" }),
    store,
    executor: slowActivateExecutor,
    sleep: noopSleep,
    lockRegistry,
  });
  const applyPromise = withAccountLock(
    // 別 accountKey: lock 識別子が衝突しない
    buildAdAccountLockKey({ workspaceId: "ws-1", accountKey: "secondary" }),
    async () => {
      sequence.push("start:apply");
      await new Promise((r) => setTimeout(r, 15));
      sequence.push("end:apply");
    },
    lockRegistry
  );

  await Promise.all([activatePromise, applyPromise]);
  // 並行実行: 両方の start が両方の end より先に積まれる。
  assert.equal(sequence.filter((e) => e.startsWith("start:")).length, 2);
  assert.equal(sequence.filter((e) => e.startsWith("end:")).length, 2);
  assert.ok(sequence[0]!.startsWith("start:"));
  assert.ok(sequence[1]!.startsWith("start:"));
});

// ---------------------------------------------------------------------
// 11. regression fix: lockProvider injection (cross-process serialization)
// ---------------------------------------------------------------------

test("runActivate: 注入された lockProvider を canonical lockKey で呼ぶ", async () => {
  const store = new FakeActivateStore();
  store.nodes.set(
    "node-1",
    pausedNode({
      hierarchyId: "node-1",
      workspaceId: "ws-1",
      accountKey: "primary",
      externalId: "cmp_1",
    })
  );
  const executor: ActivateExecutor = {
    async executeActivate(input) {
      return {
        status: "success",
        message: "ok",
        logPayload: {},
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    },
  };
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
  const summary = await runActivate({
    request: req({ hierarchyId: "node-1" }),
    store,
    executor,
    sleep: noopSleep,
    lockProvider: provider,
  });
  assert.equal(summary.status, "activated");
  const expectedKey = buildAdAccountLockKey({
    workspaceId: "ws-1",
    accountKey: "primary",
  });
  assert.deepEqual(acquireOrder, [expectedKey]);
  assert.deepEqual(releaseOrder, [expectedKey]);
});

test("runActivate: lockProvider が cross-process で hold していると Meta CLI 実行が遅延する", async () => {
  const store = new FakeActivateStore();
  store.nodes.set(
    "node-x",
    pausedNode({
      hierarchyId: "node-x",
      workspaceId: "ws-1",
      accountKey: "primary",
      externalId: "cmp_x",
    })
  );
  const executor: ActivateExecutor = {
    calls: [] as ActivateExecuteInput[],
    async executeActivate(input) {
      (this.calls as ActivateExecuteInput[]).push(input);
      return {
        status: "success",
        message: "ok",
        logPayload: {},
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    },
  } as ActivateExecutor & { calls: ActivateExecuteInput[] };
  const calls = (executor as ActivateExecutor & { calls: ActivateExecuteInput[] })
    .calls;

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
  const runPromise = runActivate({
    request: req({ hierarchyId: "node-x" }),
    store,
    executor,
    sleep: noopSleep,
    lockProvider: provider,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, "executor should not run until lock is acquired");
  releaseExternal();
  const summary = await runPromise;
  assert.equal(summary.status, "activated");
  assert.equal(calls.length, 1);
});

test("runActivate × Apply: 共有 lockProvider を介して別プロセスでも直列化される (cross-process simulation)", async () => {
  // 2 つの runActivate 呼び出しが同じ canonical key で走り、provider の acquire
  // が並行実行を許さない (Postgres advisory lock の semantics) シナリオを擬似する。
  // worker 側の Apply 経路と CLI/web 側の Activate 経路が同じ provider を共有
  // するなら、別プロセス間でも 1 並行が強制される。
  const store = new FakeActivateStore();
  store.nodes.set(
    "node-A",
    pausedNode({
      hierarchyId: "node-A",
      workspaceId: "ws-1",
      accountKey: "primary",
      externalId: "cmp_A",
    })
  );
  store.nodes.set(
    "node-B",
    pausedNode({
      hierarchyId: "node-B",
      workspaceId: "ws-1",
      accountKey: "primary",
      externalId: "cmp_B",
    })
  );
  const sequence: string[] = [];
  const slow: ActivateExecutor = {
    async executeActivate(input) {
      sequence.push(`start:${input.node.hierarchyId}`);
      await new Promise((r) => setTimeout(r, 20));
      sequence.push(`end:${input.node.hierarchyId}`);
      return {
        status: "success",
        message: "ok",
        logPayload: {},
        appliedRemotely: true,
        ...(input.node.externalId ? { externalId: input.node.externalId } : {}),
      };
    },
  };

  // 共有 acquire: 同一 key の同時 acquire を強制的に直列化 (= Postgres advisory
  // lock の cross-process 挙動を擬似)。in-process 段の registry とは独立に、
  // 別プロセス相当の external gate で待たせる。
  const externalHolders = new Map<string, Promise<void>>();
  const externalProvider = createCrossProcessAdAccountLockProvider({
    acquire: async (lockKey) => {
      const prev = externalHolders.get(lockKey) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      externalHolders.set(lockKey, prev.then(() => next));
      await prev;
      return {
        release: async () => {
          release();
          if (externalHolders.get(lockKey) === prev.then(() => next)) {
            externalHolders.delete(lockKey);
          }
        },
      };
    },
    // in-process registry を共有しないことで、2 つの runActivate 呼び出しが
    // 別プロセス相当として振る舞うように構成する。
    inProcessRegistry: new Map(),
  });
  // 各 runActivate に独立した in-process registry を持つ provider をラップする
  // のではなく、provider 自体を共有させる。共有 provider の in-process 段が同
  // プロセス内の race を直列化し、acquire (cross-process gate) が別経路の race
  // を直列化する。
  const r1 = runActivate({
    request: req({ hierarchyId: "node-A" }),
    store,
    executor: slow,
    sleep: noopSleep,
    lockProvider: externalProvider,
  });
  const r2 = runActivate({
    request: req({ hierarchyId: "node-B" }),
    store,
    executor: slow,
    sleep: noopSleep,
    lockProvider: externalProvider,
  });
  await Promise.all([r1, r2]);
  // 同 (workspaceId, accountKey) のため interleave しない。
  assert.deepEqual(sequence, [
    "start:node-A",
    "end:node-A",
    "start:node-B",
    "end:node-B",
  ]);
});
