import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreatePullRequestInput, GithubAdapter } from "@addroid/github-adapter";
import { createOpsChangeProposal } from "../ops-proposal-runtime.js";

test("createOpsChangeProposal infers adset level for budget_change targetIds instead of defaulting to campaign", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-budget-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createOpsChangeProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "cli-chat",
      env: { ADDROID_OPS_REPO_LOCAL_DIR: rootDir },
      input: {
        intent: "budget_change",
        accountKey: "primary",
        targetIds: ["as_existing"],
        desiredChanges: { dailyBudget: 500 },
        rationale: "adset budget change",
      },
    });

    assert.equal(result.planOk, true);
    assert.equal(github.created.length, 1);
    const pr = github.created[0]!;
    assert.match(pr.body, /adset:as_existing budget\.dailyBudget -> 500/);
    assert.match(pr.body, /Campaign budgets and adset budgets are separate|キャンペーン予算と広告セット予算は別物/);
    assert.match(pr.files[0]!.diff, /id: as_existing[\s\S]*budget:\n\+\s+dailyBudget: 500/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createOpsChangeProposal rejects unresolved budget_change targetIds", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-budget-missing-"));
  try {
    writeOpsFixture(rootDir);
    await assert.rejects(
      () =>
        createOpsChangeProposal({
          prisma: fakePrisma() as never,
          githubAdapter: new FakeGithubAdapter() as unknown as GithubAdapter,
          workspaceId: "ws_1",
          actor: "test",
          source: "cli-chat",
          env: { ADDROID_OPS_REPO_LOCAL_DIR: rootDir },
          input: {
            intent: "budget_change",
            accountKey: "primary",
            targetIds: ["not_in_yaml"],
            desiredChanges: { dailyBudget: 500 },
          },
        }),
      /campaign\/adset/
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeOpsFixture(rootDir: string): void {
  const files: Record<string, string> = {
    ".addroid/project.yaml": `version: 1
workspace:
  slug: default
  displayName: "Default"
`,
    "workflows/cron.yaml": `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: true
`,
    "ads/accounts/primary/brand.yaml": `version: 1
account:
  key: primary
  displayName: "Primary"
creatives: []
campaigns:
  - id: cmp_existing
    name: Existing Campaign
    objective: OUTCOME_TRAFFIC
    initialState: paused
    budget:
      dailyBudget: 10
    adsets:
      - id: as_existing
        name: Existing Adset
        initialState: paused
        targeting:
          countries: [JP]
          interests: []
          customAudiences: []
        ads: []
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
}

function fakePrisma() {
  return {
    workspace: {
      async findUnique() {
        return {
          opsRepoId: "repo_1",
          defaultAdAccount: { id: "acct_1", key: "primary", displayName: "Primary" },
          opsRepo: { owner: "octo", name: "ops", defaultBranch: "main" },
        };
      },
    },
    githubRepo: {
      async findUnique() {
        return { id: "repo_1", owner: "octo", name: "ops", defaultBranch: "main" };
      },
    },
    adAccount: {
      async findUnique() {
        return { id: "acct_1", key: "primary", displayName: "Primary" };
      },
    },
    githubPullRequest: {
      async upsert() {
        return { id: "pr_1" };
      },
    },
    approvalRecord: {
      async create() {
        return { id: "approval_1" };
      },
    },
    auditLog: {
      async create() {
        return { id: "audit_1" };
      },
    },
  };
}

class FakeGithubAdapter {
  readonly created: CreatePullRequestInput[] = [];

  async createPullRequest(input: CreatePullRequestInput) {
    this.created.push(input);
    return {
      number: 42,
      htmlUrl: "https://github.example/octo/ops/pull/42",
      headSha: "abc123",
    };
  }
}
