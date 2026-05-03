// AdDroid OSS — budget_guard orchestrator tests.
//
// pg-boss / Prisma / LLMProvider を一切起動せず、`runBudgetGuardOnce` の
// ロジックのみを in-memory fake で検証する。

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBudgetGuardPolicy,
  runBudgetGuardOnce,
  type BudgetGuardAuditInput,
  type BudgetGuardAuditResult,
  type BudgetGuardAuditRunner,
  type BudgetGuardPolicy,
  type BudgetGuardSpendContext,
  type BudgetGuardStore,
  type DailyReportAdAccountSnapshot,
} from "../index.js";
import type { AiRunCreateInputData } from "@addroid/llm-provider";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

class FakeBudgetGuardStore implements BudgetGuardStore {
  account: DailyReportAdAccountSnapshot | null;
  aiRunCalls: AiRunCreateInputData[] = [];
  private nextAiRunId = 1;
  constructor(account: DailyReportAdAccountSnapshot | null) {
    this.account = account;
  }
  async findAdAccount(_input: { workspaceId: string; accountKey: string }) {
    return this.account;
  }
  async createAiRun(data: AiRunCreateInputData) {
    this.aiRunCalls.push(data);
    return { id: `run-${this.nextAiRunId++}` };
  }
}

class FakeAuditRunner implements BudgetGuardAuditRunner {
  calls: BudgetGuardAuditInput[] = [];
  constructor(private readonly result: BudgetGuardAuditResult) {}
  async run(input: BudgetGuardAuditInput): Promise<BudgetGuardAuditResult> {
    this.calls.push(input);
    return this.result;
  }
}

const ACCOUNT: DailyReportAdAccountSnapshot = {
  id: "acc-1",
  key: "primary",
  displayName: "Primary",
  metaAccountId: "act_111",
  currency: "JPY",
};

function makeAiRunInput(
  overrides: Partial<AiRunCreateInputData> = {}
): AiRunCreateInputData {
  return {
    workspaceId: "ws-1",
    agent: "audit",
    workflow: "budget_guard",
    provider: "mock",
    model: "mock-small",
    status: "succeeded",
    prompt: null,
    inputs: { hello: "world" },
    outputs: { ok: true },
    decision: "auto_approved",
    confidence: 0.9,
    inputTokens: 8,
    outputTokens: 16,
    costUsd: 0,
    requestId: "mock-1",
    linkedRefType: "cron_run",
    linkedRefId: "cr-1",
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeAuditResult(
  overrides: Partial<BudgetGuardAuditResult> = {}
): BudgetGuardAuditResult {
  return {
    aiRunInput: makeAiRunInput(),
    output: {
      classification: "safe",
      dangerousCategories: [],
      rationale: "no candidate actions",
    },
    decision: "auto_approved",
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// runBudgetGuardOnce
// ---------------------------------------------------------------------

test("runBudgetGuardOnce returns no_account when ad_account is missing", async () => {
  const store = new FakeBudgetGuardStore(null);
  const runner = new FakeAuditRunner(makeAuditResult());
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "proposal",
    accountKey: "primary",
    store,
    runner,
  });
  assert.equal(summary.status, "no_account");
  assert.equal(summary.aiRunId, null);
  assert.equal(runner.calls.length, 0);
  assert.equal(store.aiRunCalls.length, 0);
});

test("runBudgetGuardOnce persists ai_runs and surfaces audit decision", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(makeAuditResult());
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "auto_apply",
    accountKey: "primary",
    // safeCategories includes the candidate.category so the deterministic
    // policy gate agrees with the AI's "auto_approved" decision.
    safeCategories: ["auto_pause"],
    candidateActions: [
      {
        hierarchy: "campaign",
        target: "cmp_1",
        category: "auto_pause",
        description: "spend exceeded daily cap",
      },
    ],
    store,
    runner,
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.aiRunId, "run-1");
  assert.equal(summary.classification, "safe");
  assert.equal(summary.decision, "auto_approved");
  assert.equal(summary.candidateCount, 1);
  assert.equal(summary.mode, "auto_apply");
  assert.deepEqual(summary.dangerousCategories, []);
  // policyReasons is populated by the deterministic gate (this implementation).
  assert.ok(summary.policyReasons.length > 0);
  // ai_runs row was created (sanitized) — exactly one
  assert.equal(store.aiRunCalls.length, 1);
  assert.equal(store.aiRunCalls[0]!.workflow, "budget_guard");
  assert.equal(store.aiRunCalls[0]!.agent, "audit");
  // runner received account + safe categories + candidates
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.accountId, "act_111");
  assert.equal(runner.calls[0]!.mode, "auto_apply");
  assert.deepEqual(runner.calls[0]!.safeCategories, ["auto_pause"]);
  assert.equal(runner.calls[0]!.candidateActions.length, 1);
});

test("runBudgetGuardOnce surfaces audit failures without losing ai_runs persistence", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const failed = makeAuditResult({
    aiRunInput: makeAiRunInput({
      status: "failed",
      outputs: null,
      decision: null,
      errorMessage: "completion failed",
    }),
    output: null,
    decision: null,
    error: "completion failed",
  });
  const runner = new FakeAuditRunner(failed);
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "proposal",
    accountKey: "primary",
    store,
    runner,
  });
  assert.equal(summary.status, "ai_failed");
  // ai_runs row is still written for forensic visibility
  assert.equal(store.aiRunCalls.length, 1);
  assert.equal(store.aiRunCalls[0]!.status, "failed");
  assert.equal(summary.aiRunId, "run-1");
  assert.equal(summary.classification, null);
  assert.equal(summary.decision, null);
  assert.match(summary.errorMessage ?? "", /completion failed/);
});

test("runBudgetGuardOnce defaults safeCategories and candidateActions to empty", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(makeAuditResult());
  await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    store,
    runner,
  });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.safeCategories, []);
  assert.deepEqual(runner.calls[0]!.candidateActions, []);
});

// ---------------------------------------------------------------------
// this implementation — fail-closed when policy is missing
// ---------------------------------------------------------------------

test("runBudgetGuardOnce fails closed (policy_missing) when policy is null", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(makeAuditResult());
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "proposal",
    accountKey: "primary",
    policy: null,
    store,
    runner,
  });
  assert.equal(summary.status, "policy_missing");
  assert.equal(summary.aiRunId, null);
  assert.equal(summary.candidateCount, 0);
  // policy_missing は AI を呼ばない (fail-closed) ので runner / store.createAiRun
  // のいずれも呼ばれてはならない。
  assert.equal(runner.calls.length, 0);
  assert.equal(store.aiRunCalls.length, 0);
  assert.match(summary.errorMessage ?? "", /policy missing/i);
});

test("runBudgetGuardOnce derives candidates+safeCategories from policy and spendContext", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(makeAuditResult());
  const policy: BudgetGuardPolicy = {
    alerts: {
      dailyBudgetAlertRatio: 0.8,
      dayOverDayRatio: 1.5,
    },
    autoPause: {
      enabled: true,
      minDailyBudgetRatio: 1.5,
      safeCategories: ["auto_pause"],
    },
  };
  const spendContext: BudgetGuardSpendContext = {
    todaySpend: 9000, // dailyBudget=5000 → ratio=1.8 → 80% alert AND auto_pause trigger
    yesterdaySpend: 3000, // dod ratio = 3.0 → 1.5 alert
    todayConversions: 5,
    monthToDateSpend: 40000,
    dailyBudget: 5000,
    monthlyBudget: 0,
    dayOfMonth: 5,
    daysInMonth: 30,
    currency: "JPY",
  };
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "auto_apply",
    accountKey: "primary",
    policy,
    spendContext,
    store,
    runner,
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.candidateCount, 1);
  // 80% / day_over_day / auto_pause_policy の 3 件
  assert.equal(summary.alerts.length, 3);
  assert.deepEqual(
    summary.alerts.map((a) => a.rule).sort(),
    ["auto_pause_policy", "daily_budget_80", "day_over_day"]
  );
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.safeCategories, ["auto_pause"]);
  assert.equal(runner.calls[0]!.candidateActions.length, 1);
  assert.equal(runner.calls[0]!.candidateActions[0]!.category, "auto_pause");
  assert.equal(runner.calls[0]!.candidateActions[0]!.hierarchy, "account");
  assert.equal(runner.calls[0]!.candidateActions[0]!.target, "act_111");
});

// ---------------------------------------------------------------------
// this implementation — pure evaluator
// ---------------------------------------------------------------------

function ctx(over: Partial<BudgetGuardSpendContext> = {}): BudgetGuardSpendContext {
  return {
    todaySpend: 0,
    yesterdaySpend: 0,
    todayConversions: 0,
    monthToDateSpend: 0,
    dailyBudget: 0,
    monthlyBudget: 0,
    dayOfMonth: 1,
    daysInMonth: 30,
    currency: "JPY",
    ...over,
  };
}

test("evaluateBudgetGuardPolicy fires daily_budget_80 when spend >= 80% of dailyBudget", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { dailyBudgetAlertRatio: 0.8 } },
    ctx({ todaySpend: 4500, dailyBudget: 5000 })
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]!.rule, "daily_budget_80");
  assert.equal(r.alerts[0]!.severity, "warn");
  assert.equal(r.alerts[0]!.threshold, 0.8);
  assert.equal(r.alerts[0]!.observedValue, 0.9);
  assert.equal(r.candidateActions.length, 0);
});

test("evaluateBudgetGuardPolicy skips daily_budget_80 when dailyBudget=0", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { dailyBudgetAlertRatio: 0.8 } },
    ctx({ todaySpend: 4500, dailyBudget: 0 })
  );
  assert.equal(r.alerts.length, 0);
});

test("evaluateBudgetGuardPolicy fires monthly_pace when MTD exceeds prorated", () => {
  // dayOfMonth=10 / daysInMonth=30 → prorated = 30000 * 10/30 = 10000
  // MTD=12000, ratio=1.2 ≥ 1.0 → alert
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { monthlyPaceRatio: 1.0 } },
    ctx({
      monthToDateSpend: 12000,
      monthlyBudget: 30000,
      dayOfMonth: 10,
      daysInMonth: 30,
    })
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]!.rule, "monthly_pace");
  assert.equal(r.alerts[0]!.observedValue, 1.2);
});

test("evaluateBudgetGuardPolicy fires day_over_day when ratio >= 1.5", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { dayOverDayRatio: 1.5 } },
    ctx({ todaySpend: 9000, yesterdaySpend: 6000 })
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]!.rule, "day_over_day");
  assert.equal(r.alerts[0]!.observedValue, 1.5);
});

test("evaluateBudgetGuardPolicy day_over_day skips when yesterday=0 (avoids divide-by-zero)", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { dayOverDayRatio: 1.5 } },
    ctx({ todaySpend: 9000, yesterdaySpend: 0 })
  );
  assert.equal(r.alerts.length, 0);
});

test("evaluateBudgetGuardPolicy fires no_conversions when CV=0 and spend >= threshold", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { noConversionsSpendMin: 5000 } },
    ctx({ todaySpend: 6000, todayConversions: 0 })
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]!.rule, "no_conversions");
  assert.equal(r.alerts[0]!.threshold, 5000);
});

test("evaluateBudgetGuardPolicy no_conversions does NOT fire when CV>0", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: { noConversionsSpendMin: 5000 } },
    ctx({ todaySpend: 6000, todayConversions: 1 })
  );
  assert.equal(r.alerts.length, 0);
});

test("evaluateBudgetGuardPolicy generates auto_pause candidate when policy enabled and triggers exceed", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    {
      alerts: {},
      autoPause: {
        enabled: true,
        minDailyBudgetRatio: 1.5,
        safeCategories: ["auto_pause"],
      },
    },
    ctx({ todaySpend: 9000, dailyBudget: 5000 })
  );
  assert.equal(r.candidateActions.length, 1);
  assert.equal(r.candidateActions[0]!.category, "auto_pause");
  assert.equal(r.candidateActions[0]!.target, "act_1");
  assert.equal(r.candidateActions[0]!.hierarchy, "account");
  assert.deepEqual(r.safeCategories, ["auto_pause"]);
  // The auto_pause_policy alert is also surfaced (severity=trigger)
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]!.rule, "auto_pause_policy");
  assert.equal(r.alerts[0]!.severity, "trigger");
});

test("evaluateBudgetGuardPolicy auto_pause is a no-op when enabled=false", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    {
      alerts: { dailyBudgetAlertRatio: 0.8 },
      autoPause: {
        enabled: false,
        minDailyBudgetRatio: 1.5,
        safeCategories: ["auto_pause"],
      },
    },
    ctx({ todaySpend: 9000, dailyBudget: 5000 })
  );
  // 80% alert は出るが auto_pause 候補は生成されない
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]!.rule, "daily_budget_80");
  assert.equal(r.candidateActions.length, 0);
  assert.deepEqual(r.safeCategories, []);
});

test("evaluateBudgetGuardPolicy returns empty result when no rule fires", () => {
  const policy: BudgetGuardPolicy = {
    alerts: {
      dailyBudgetAlertRatio: 0.8,
      monthlyPaceRatio: 1.0,
      dayOverDayRatio: 1.5,
      noConversionsSpendMin: 5000,
    },
    autoPause: { enabled: true, minDailyBudgetRatio: 1.5 },
  };
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    policy,
    ctx({
      todaySpend: 1000,
      yesterdaySpend: 1000,
      todayConversions: 5,
      monthToDateSpend: 1000,
      dailyBudget: 5000,
      monthlyBudget: 30000,
      dayOfMonth: 10,
      daysInMonth: 30,
    })
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.candidateActions.length, 0);
});

test("evaluateBudgetGuardPolicy with empty policy fires nothing (fail-closed at field level)", () => {
  const r = evaluateBudgetGuardPolicy(
    "act_1",
    { alerts: {} },
    ctx({
      todaySpend: 99999,
      yesterdaySpend: 1,
      todayConversions: 0,
      monthToDateSpend: 99999,
      dailyBudget: 5000,
      monthlyBudget: 30000,
      dayOfMonth: 10,
      daysInMonth: 30,
    })
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.candidateActions.length, 0);
  assert.deepEqual(r.safeCategories, []);
});

// ---------------------------------------------------------------------
// this implementation — deterministic approval policy gate
// ---------------------------------------------------------------------

test("runBudgetGuardOnce: report_only forces decision to auto_blocked even when AI says auto_approved", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  // AI returns its (incorrect for this mode) opinion.
  const runner = new FakeAuditRunner(
    makeAuditResult({
      output: {
        classification: "safe",
        dangerousCategories: [],
        rationale: "AI thinks the operation is safe",
      },
      decision: "auto_approved",
    })
  );
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    safeCategories: ["auto_pause"],
    candidateActions: [
      {
        hierarchy: "campaign",
        target: "cmp_1",
        category: "auto_pause",
        description: "spend exceeded daily cap",
      },
    ],
    store,
    runner,
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.decision, "auto_blocked");
  assert.equal(summary.classification, "requires_approval");
  assert.match(summary.policyReasons.join(" "), /report_only/);
});

test("runBudgetGuardOnce: auto_apply with non-safe candidate downgrades AI auto_approved → approval_required", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(
    makeAuditResult({
      output: {
        classification: "safe",
        dangerousCategories: [],
        rationale: "AI thinks the operation is safe",
      },
      decision: "auto_approved",
    })
  );
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "auto_apply",
    accountKey: "primary",
    // policy permits "copy_update" but not "auto_pause"
    safeCategories: ["copy_update"],
    candidateActions: [
      {
        hierarchy: "campaign",
        target: "cmp_1",
        category: "auto_pause",
        description: "spend exceeded daily cap",
      },
    ],
    store,
    runner,
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.decision, "approval_required");
  assert.equal(summary.classification, "requires_approval");
  assert.match(summary.policyReasons.join(" "), /auto_pause/);
});

test("runBudgetGuardOnce: dangerous candidate forces approval_required regardless of AI", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(
    makeAuditResult({
      output: {
        classification: "safe",
        dangerousCategories: [],
        rationale: "AI mistakenly thinks dangerous category is safe",
      },
      decision: "auto_approved",
    })
  );
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "auto_apply",
    accountKey: "primary",
    safeCategories: ["budget_increase"], // even if explicitly listed
    candidateActions: [
      {
        hierarchy: "campaign",
        target: "cmp_1",
        category: "budget_increase",
        description: "raise daily cap",
      },
    ],
    store,
    runner,
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.decision, "approval_required");
  assert.equal(summary.classification, "dangerous");
  assert.deepEqual(summary.dangerousCategories, ["budget_increase"]);
});

test("runBudgetGuardOnce: empty candidates → policy stays auto_approved/safe", async () => {
  const store = new FakeBudgetGuardStore(ACCOUNT);
  const runner = new FakeAuditRunner(makeAuditResult());
  const summary = await runBudgetGuardOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    store,
    runner,
  });
  assert.equal(summary.status, "succeeded");
  // No candidates → vacuously safe, AI's auto_approved is preserved.
  assert.equal(summary.decision, "auto_approved");
  assert.equal(summary.classification, "safe");
  assert.deepEqual(summary.dangerousCategories, []);
});
