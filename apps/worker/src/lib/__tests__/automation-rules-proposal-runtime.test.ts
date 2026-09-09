import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreatePullRequestInput, GithubAdapter } from "@addroid/github-adapter";
import { runAutomationRulesOnce } from "../automation-rules-runtime.js";

const NOW = new Date("2026-09-09T06:00:00.000Z");

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
    assert.match(pr.branchName, /^addroid\/automation-proposal-budget_consumption_daily-run_1$/);
    assert.equal(pr.files.length, 1);
    assert.match(pr.files[0]!.path, /^proposals\/automation\/budget_consumption_daily\//);
    assert.match(pr.files[0]!.diff, /"proposalOnly": true/);
    assert.match(pr.files[0]!.diff, /"autoApply": false/);
    assert.match(pr.files[0]!.diff, /"targetKey": "campaign_1"/);
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "proposal_created");
    const receipt = evaluation.proposal as Record<string, unknown>;
    assert.equal(receipt.repository, "Keninvestment/addroid-ops");
    assert.equal(receipt.prUrl, "https://github.example/Keninvestment/addroid-ops/pull/42");
    assert.equal(fixture.state.actions.length, 1);
    assert.equal(fixture.state.actions[0]!.status, "planned");
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
    });

    assert.equal(summary.status, "failed");
    const evaluation = fixture.state.runUpdates.at(-1)?.evaluation as Record<string, unknown>;
    assert.equal(evaluation.outcome, "proposal_failed");
    assert.match(String(evaluation.reason), /fixture github failure/);
    assert.equal(fixture.state.actionUpdates.at(-1)?.status, "failed");
  } finally {
    fixture.cleanup();
  }
});

test("proposal cooldown suppresses a duplicate target and records reasoned no_target", async () => {
  const fixture = makeFixture("proposal_pr", 1500);
  try {
    fixture.prisma.automationAction.findFirst = async () => ({ id: "prior_planned_action" });
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
    });

    assert.equal(summary.actionsPlanned, 2);
    assert.equal(summary.actionsBlocked, 1);
    assert.equal(github.created.length, 1);
    assert.equal(fixture.state.actions.length, 1);
    assert.match(github.created[0]!.files[0]!.diff, /"targetKey": "campaign_1"/);
    assert.doesNotMatch(github.created[0]!.files[0]!.diff, /"targetKey": "campaign_2"/);
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(actionType: string, spend: number) {
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
      preset: today
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
      async upsert() {
        return { id: "pr_1" };
      },
    },
    approvalRecord: { async create() { return { id: "approval_1" }; } },
    auditLog: { async create() { return { id: "audit_1" }; } },
    executionLog: { async create() { return { id: "log_1" }; } },
  };
  const insightsProvider = {
    async fetchInsights() {
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
  constructor(private readonly error?: Error) {}

  async createPullRequest(input: CreatePullRequestInput) {
    this.created.push(input);
    if (this.error) throw this.error;
    return {
      number: 42,
      htmlUrl: "https://github.example/Keninvestment/addroid-ops/pull/42",
      headSha: "abc123",
    };
  }
}
