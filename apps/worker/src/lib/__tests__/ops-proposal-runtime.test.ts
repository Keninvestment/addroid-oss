import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreatePullRequestInput, GithubAdapter } from "@addroid/github-adapter";
import { createOpsChangeProposal } from "../ops-proposal-runtime.js";

test("createOpsChangeProposal creates an operation manifest for adset budget_change", async () => {
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
        targets: [{ level: "adset", id: "as_existing" }],
        desiredChanges: { dailyBudget: 500 },
        rationale: "adset budget change",
      },
    });

    assert.equal(result.planOk, true);
    assert.equal(github.created.length, 1);
    const pr = github.created[0]!;
    assert.match(pr.body, /adset\.update/);
    assert.match(pr.body, /Campaign budgets and adset budgets are separate|キャンペーン予算と広告セット予算は別物/);
    assert.equal(pr.files[0]!.path.startsWith("operations/primary/"), true);
    assert.match(pr.files[0]!.diff, /"version": 2/);
    assert.match(pr.files[0]!.diff, /"kind": "adset\.update"[\s\S]*"dailyBudget": 500/);
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
      /対象階層/
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createOpsChangeProposal accepts raw Graph operations", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-raw-"));
  try {
    writeOpsFixture(rootDir);
    const github = new FakeGithubAdapter();
    const result = await createOpsChangeProposal({
      prisma: fakePrisma() as never,
      githubAdapter: github as unknown as GithubAdapter,
      workspaceId: "ws_1",
      actor: "test",
      source: "slack-chat",
      env: { ADDROID_OPS_REPO_LOCAL_DIR: rootDir },
      input: {
        intent: "other",
        accountKey: "primary",
        operations: [
          {
            kind: "creative.delete",
            payload: { creativeId: "cr_123" },
            entity: { nodeType: "creative", nodeKey: "cr_123", status: "archived" },
          },
        ],
        rationale: "delete obsolete creative",
      },
    });

    assert.equal(result.planOk, true);
    const pr = github.created[0]!;
    assert.match(pr.body, /creative\.delete/);
    assert.equal(pr.files[0]!.path.startsWith("operations/primary/"), true);
    assert.match(pr.files[0]!.diff, /"kind": "creative\.delete"[\s\S]*"creativeId": "cr_123"/);
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
