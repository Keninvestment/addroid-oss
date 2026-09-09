import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CreatePullRequestInput,
  GithubAdapter,
  PullRequestSummary,
} from "@addroid/github-adapter";
import {
  runAutomationRulesOnce,
  scheduleAutomationRuleNextRun,
} from "../automation-rules-runtime.js";

const NOW = new Date("2026-09-09T06:00:00.000Z");

test("scheduler persists the exact planned slot in the retry payload", async () => {
  const sends: Array<{ payload: Record<string, unknown>; startAfter: Date }> = [];
  const prisma = {
    automationRule: {
      async findFirst() {
        return {
          id: "rule_1",
          key: "rule_key",
          enabled: true,
          schedule: "*/15 * * * *",
          scheduledJobId: null,
        };
      },
      async update() {},
    },
  };
  const boss = {
    async send(_name: string, payload: Record<string, unknown>, options: { startAfter: Date }) {
      sends.push({ payload, startAfter: options.startAfter });
      return "job_1";
    },
    async cancel() {},
  };

  const result = await scheduleAutomationRuleNextRun({
    prisma: prisma as never,
    boss: boss as never,
    workspaceId: "ws_1",
    ruleId: "rule_1",
    now: new Date("2026-09-09T06:07:12.000Z"),
  });

  assert.ok(result);
  assert.equal(sends[0]?.payload.scheduledFor, result.nextRunAt.toISOString());
  assert.equal(sends[0]?.startAfter.toISOString(), result.nextRunAt.toISOString());
});

test("proposal rule creates one proposal-only GitOps PR and stores a receipt", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter();
    let metaCalls = 0;
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: {
        async execute() {
          metaCalls += 1;
          return { status: "success", message: "must not be called" } as const;
        },
      },
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "succeeded");
    assert.equal(metaCalls, 0);
    assert.equal(github.created.length, 1);
    const pr = github.created[0]!;
    assert.deepEqual(pr.spec, {
      owner: "Keninvestment",
      name: "addroid-ops",
      defaultBranch: "main",
    });
    assert.match(pr.branchName, /^addroid\/automation-proposal-budget_consumption_daily-[a-f0-9]{20}$/);
    assert.equal(pr.files.length, 1);
    assert.match(pr.files[0]!.path, /^proposals\/automation\/budget_consumption_daily\//);
    assert.match(pr.files[0]!.diff, /"proposalOnly": true/);
    assert.match(pr.files[0]!.diff, /"autoApply": false/);
    assert.match(pr.files[0]!.diff, /"targetKey": "campaign_1"/);
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "proposal_created");
    const receipt = evaluation.proposal as Record<string, unknown>;
    assert.equal(receipt.repository, "Keninvestment/addroid-ops");
    assert.equal(receipt.prUrl, "https://github.com/Keninvestment/addroid-ops/pull/42");
    assert.equal(fixture.state.actions.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("proposal rule with no matching target records valid no_target without a PR", async () => {
  const fixture = makeFixture("improvement_pr", 100);
  try {
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "succeeded");
    assert.equal(github.created.length, 0);
    assert.equal(fixture.state.actions.length, 0);
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "no_target");
    assert.match(String(evaluation.reason), /matched no targets/);
  } finally {
    fixture.cleanup();
  }
});

test("unknown action remains an audited unsupported skipped run", async () => {
  const fixture = makeFixture("send_email", 1500);
  try {
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "succeeded");
    assert.equal(github.created.length, 0);
    assert.equal(fixture.state.runCreates.at(-1)?.status, "skipped");
    const evaluation = fixture.state.runCreates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "unsupported");
  } finally {
    fixture.cleanup();
  }
});

test("GitHub failure is proposal_failed and never becomes false success", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter(new Error("fixture github failure"));
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "failed");
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "proposal_failed");
    assert.match(String(evaluation.reason), /fixture github failure/);
    assert.equal(fixture.state.actions.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("proposal cooldown suppresses a duplicate target and records reasoned no_target", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    fixture.prisma.auditLog.findFirst = async () => ({ id: "prior_proposal_target" });
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "succeeded");
    assert.equal(summary.actionsBlocked, 1);
    assert.equal(github.created.length, 0);
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "no_target");
    assert.match(String(evaluation.reason), /within cooldown/);
  } finally {
    fixture.cleanup();
  }
});

test("proposal target limit is applied before creating the single PR", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const rulePath = path.join(fixture.rootDir, "workflows/automation-rules.yaml");
    fs.writeFileSync(
      rulePath,
      fs.readFileSync(rulePath, "utf8").replace("maxActionsPerRun: 5", "maxActionsPerRun: 1"),
      "utf8",
    );
    fixture.insightsProvider.fetchInsights = async () => ({
      current: [
        insightRow("campaign_1", 1500),
        insightRow("campaign_2", 2000),
      ],
      prior: [],
    });
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.actionsPlanned, 2);
    assert.equal(summary.actionsBlocked, 1);
    assert.equal(github.created.length, 1);
    assert.equal(fixture.state.actions.length, 0);
    assert.match(github.created[0]!.files[0]!.diff, /"targetKey": "campaign_1"/);
    assert.doesNotMatch(github.created[0]!.files[0]!.diff, /"targetKey": "campaign_2"/);
  } finally {
    fixture.cleanup();
  }
});

test("report_only proposal action never opens a GitHub PR", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const rulePath = path.join(fixture.rootDir, "workflows/automation-rules.yaml");
    fs.writeFileSync(
      rulePath,
      fs.readFileSync(rulePath, "utf8").replace("mode: proposal", "mode: report_only"),
      "utf8",
    );
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "succeeded");
    assert.equal(github.created.length, 0);
    const evaluation = fixture.state.runCreates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "unsupported");
    assert.match(String(evaluation.reason), /requires proposal mode/);
  } finally {
    fixture.cleanup();
  }
});

test("last_7d fetches and aggregates all seven dates before proposing", async () => {
  const fixture = makeFixture("proposal_pr", 200, "last_7d");
  try {
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    });

    assert.equal(summary.status, "succeeded");
    assert.equal(fixture.state.requestedDates.length, 7);
    assert.equal(new Set(fixture.state.requestedDates).size, 7);
    assert.equal(github.created.length, 1);
    assert.match(github.created[0]!.files[0]!.diff, /"spend": 1400/);
  } finally {
    fixture.cleanup();
  }
});

test("stable operation key recovers GitHub success after DB receipt failure without duplicate PR", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    let failUpsert = true;
    fixture.prisma.githubPullRequest.upsert = async () => {
      if (failUpsert) {
        failUpsert = false;
        throw new Error("fixture DB receipt failure");
      }
      return { id: "pr_1" };
    };
    const github = new FakeGithubAdapter();
    const options = {
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: "2026-09-09T06:00:00.000Z",
    };

    const first = await runAutomationRulesOnce(options);
    const second = await runAutomationRulesOnce(options);

    assert.equal(first.status, "failed");
    assert.equal(second.status, "succeeded");
    assert.equal(github.created.length, 1);
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "proposal_created");
  } finally {
    fixture.cleanup();
  }
});

test("scheduled slot keeps recovery identity stable when retry time crosses a minute", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    let failUpsert = true;
    fixture.prisma.githubPullRequest.upsert = async () => {
      if (failUpsert) {
        failUpsert = false;
        throw new Error("fixture DB receipt failure");
      }
      return { id: "pr_1" };
    };
    const github = new FakeGithubAdapter();
    const base = {
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      scheduledFor: "2026-09-09T06:00:00.000Z",
    };

    const first = await runAutomationRulesOnce({ ...base, now: new Date("2026-09-09T06:00:00.000Z") });
    const second = await runAutomationRulesOnce({ ...base, now: new Date("2026-09-09T06:01:01.000Z") });

    assert.equal(first.status, "failed");
    assert.equal(second.status, "succeeded");
    assert.equal(github.created.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("existing operation PR with different proposal artifact fails closed", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter();
    const options = {
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    };
    assert.equal((await runAutomationRulesOnce(options)).status, "succeeded");
    fixture.insightsProvider.fetchInsights = async () => ({
      current: [insightRow("campaign_1", 2500)],
      prior: [],
    });

    const retry = await runAutomationRulesOnce(options);

    assert.equal(retry.status, "failed");
    assert.match(retry.errors.join("\n"), /artifact does not match/);
    assert.equal(github.created.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("closed or merged operation PR cannot be recovered as an open proposal", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter();
    const options = {
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    };
    assert.equal((await runAutomationRulesOnce(options)).status, "succeeded");
    for (const state of ["closed", "merged"] as const) {
      github.state = state;
      const retry = await runAutomationRulesOnce(options);
      assert.equal(retry.status, "failed");
      assert.match(retry.errors.join("\n"), /existing PR is not open/);
    }
    assert.equal(github.created.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("proposal execution without a persisted scheduled slot fails closed", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
    });

    assert.equal(summary.status, "failed");
    assert.match(summary.errors.join("\n"), /scheduledFor is required for retry identity/);
    assert.equal(github.created.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("existing operation PR head drift from stored receipt fails closed", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter();
    const options = {
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    };
    assert.equal((await runAutomationRulesOnce(options)).status, "succeeded");
    fixture.prisma.githubPullRequest.findUnique = async () => ({ headSha: "old-head-sha" });

    const retry = await runAutomationRulesOnce(options);

    assert.equal(retry.status, "failed");
    assert.match(retry.errors.join("\n"), /existing PR head changed/);
  } finally {
    fixture.cleanup();
  }
});

test("multi-day frequency rule fails closed instead of aggregating daily frequency", async () => {
  const fixture = makeFixture("proposal_pr", 1500, "last_7d");
  try {
    const rulePath = path.join(fixture.rootDir, "workflows/automation-rules.yaml");
    fs.writeFileSync(
      rulePath,
      fs.readFileSync(rulePath, "utf8")
        .replace("field: spend", "field: frequency")
        .replace("metric: spend", "metric: spend"),
      "utf8",
    );
    const github = new FakeGithubAdapter();
    const summary = await runAutomationRulesOnce({
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
    });

    assert.equal(summary.status, "failed");
    assert.match(summary.errors.join("\n"), /non-additive metric: frequency/);
    assert.equal(fixture.state.requestedDates.length, 0);
    assert.equal(github.created.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("concurrent runs for the same scheduled slot converge on one proposal PR", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    const github = new FakeGithubAdapter();
    const options = {
      prisma: fixture.prisma as never,
      workspaceId: "ws_1",
      insightsProvider: fixture.insightsProvider as never,
      mutationExecutor: null,
      githubAdapter: github as unknown as GithubAdapter,
      env: { ADDROID_OPS_REPO_LOCAL_DIR: fixture.rootDir },
      now: NOW,
      scheduledFor: NOW.toISOString(),
    };

    const [left, right] = await Promise.all([
      runAutomationRulesOnce(options),
      runAutomationRulesOnce(options),
    ]);

    assert.equal(left.status, "succeeded");
    assert.equal(right.status, "succeeded");
    assert.equal(github.created.length, 1);
    const receipts = fixture.state.runUpdates
      .map((update) => update.evaluation as Record<string, unknown> | undefined)
      .filter((evaluation) => evaluation?.outcome === "proposal_created");
    assert.equal(receipts.length, 2);
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(actionType: string, spend: number, windowPreset = "today") {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-automation-proposal-"));
  fs.mkdirSync(path.join(rootDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "workflows/automation-rules.yaml"),
    `version: 1
rules:
  - id: budget_consumption_daily
    enabled: true
    schedule: "0 9 * * *"
    intent: review high spend
    scope:
      level: campaign
    window:
      preset: ${windowPreset}
      timezone: account
    metrics:
      spend:
        field: spend
        unit: currency
    when:
      all:
        - metric: spend
          gte: 1000
    action:
      type: ${actionType}
      proposal: budget_review
    safety:
      mode: proposal
      cooldownHours: 24
    limits:
      maxActionsPerRun: 5
`,
    "utf8",
  );
  const state = {
    runCreates: [] as Array<Record<string, unknown>>,
    runUpdates: [] as Array<Record<string, unknown>>,
    actions: [] as Array<Record<string, unknown>>,
    actionUpdates: [] as Array<Record<string, unknown>>,
    requestedDates: [] as string[],
  };
  const prisma = {
    workspace: {
      async findUnique() {
        return {
          opsRepoId: "repo_1",
          opsRepo: { owner: "Keninvestment", name: "addroid-ops", defaultBranch: "main" },
        };
      },
    },
    githubRepo: {
      async findUnique() {
        return { id: "repo_1", owner: "Keninvestment", name: "addroid-ops", defaultBranch: "main" };
      },
    },
    adAccount: {
      async findMany() {
        return [{ id: "acct_1", key: "primary", displayName: "Primary", currency: "JPY", timezoneName: "Asia/Tokyo" }];
      },
    },
    automationRule: {
      async upsert() {},
      async findUnique() {
        return { id: "rule_1" };
      },
    },
    automationRun: {
      async create(args: { data: Record<string, unknown> }) {
        state.runCreates.push(args.data);
        return { id: `run_${state.runCreates.length}` };
      },
      async update(args: { data: Record<string, unknown> }) {
        state.runUpdates.push(args.data);
      },
    },
    automationAction: {
      async findFirst(): Promise<{ id: string } | null> {
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        state.actions.push(args.data);
        return { id: `action_${state.actions.length}` };
      },
      async updateMany(args: { data: Record<string, unknown> }) {
        state.actionUpdates.push(args.data);
      },
    },
    adsHierarchyNode: {
      async findMany() {
        return [{ id: "hierarchy_1", nodeType: "campaign", nodeKey: "campaign_1", externalId: "123", status: "ACTIVE" }];
      },
    },
    githubPullRequest: {
      async findUnique(): Promise<{ headSha: string } | null> {
        return null;
      },
      async upsert() {
        return { id: "pr_1" };
      },
    },
    approvalRecord: { async create() { return { id: "approval_1" }; } },
    auditLog: {
      async findFirst(): Promise<{ id: string } | null> { return null; },
      async create() { return { id: "audit_1" }; },
    },
    executionLog: { async create() { return { id: "log_1" }; } },
  };
  const insightsProvider = {
    async fetchInsights(input?: { metricDate?: string }) {
      if (input?.metricDate) state.requestedDates.push(input.metricDate);
      return {
        current: [insightRow("campaign_1", spend)],
        prior: [],
      };
    },
  };
  return {
    rootDir,
    prisma,
    insightsProvider,
    state,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function insightRow(nodeKey: string, spend: number) {
  return {
    nodeType: "campaign",
    nodeKey,
    displayName: nodeKey,
    spendMicros: spend * 1_000_000,
    impressions: 1000,
    clicks: 10,
    conversions: 1,
  };
}

class FakeGithubAdapter {
  readonly created: CreatePullRequestInput[] = [];
  state: PullRequestSummary["state"] = "open";
  constructor(private readonly error?: Error) {}

  async pollPullRequests() {
    return {
      notModified: false,
      pullRequests: this.created.map((pr, index) => ({
        number: 42 + index,
        title: pr.title,
        state: this.state,
        headSha: `abc${index}`,
        baseRef: pr.baseRef ?? pr.spec.defaultBranch,
        htmlUrl: `https://github.com/${pr.spec.owner}/${pr.spec.name}/pull/${42 + index}`,
        mergedAt: null,
      })),
    };
  }

  async createPullRequest(input: CreatePullRequestInput) {
    if (this.error) throw this.error;
    if (this.created.some((pr) => pr.branchName === input.branchName)) {
      throw new Error("branch already exists");
    }
    this.created.push(input);
    return {
      number: 42,
      htmlUrl: "https://github.com/Keninvestment/addroid-ops/pull/42",
      headSha: "abc123",
    };
  }
}
