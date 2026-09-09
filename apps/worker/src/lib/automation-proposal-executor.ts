import { Prisma, type PrismaClient } from "@addroid/db";
import type {
  CreatePullRequestFile,
  GithubAdapter,
} from "@addroid/github-adapter";
import type { AutomationMetricSubject } from "@addroid/queue";
import type { AutomationRuleYaml } from "@addroid/ops-schemas";

export interface AutomationProposalTarget {
  accountId: string;
  level: AutomationMetricSubject["level"];
  targetKey: string;
  hierarchyId: string | null;
  displayName?: string;
  observedMetrics: Record<string, number | null>;
  reasons: string[];
}

export interface AutomationProposalReceipt {
  repository: string;
  branchName: string;
  prNumber: number;
  prUrl: string;
  pullRequestId: string;
  headSha: string;
  filePath: string;
  filesChanged: number;
  targets: Array<{ level: string; targetKey: string }>;
  diff: string;
}

export async function createAutomationProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  runId: string;
  rule: AutomationRuleYaml;
  accountKey: string;
  targets: AutomationProposalTarget[];
  now?: Date;
}): Promise<AutomationProposalReceipt> {
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { opsRepoId: true },
  });
  if (!workspace?.opsRepoId) {
    throw new Error("automation proposal: workspace has no ops repository connected");
  }
  const repo = await opts.prisma.githubRepo.findUnique({
    where: { id: workspace.opsRepoId },
    select: { id: true, owner: true, name: true, defaultBranch: true },
  });
  if (!repo) {
    throw new Error(`automation proposal: ops repo ${workspace.opsRepoId} not found`);
  }

  const now = opts.now ?? new Date();
  const safeRuleId = safeSegment(opts.rule.id);
  const safeAccountKey = safeSegment(opts.accountKey);
  const safeRunId = safeSegment(opts.runId);
  const branchName = `addroid/automation-proposal-${safeRuleId}-${safeRunId}`;
  const filePath =
    `proposals/automation/${safeRuleId}/` +
    `${now.toISOString().replace(/[:.]/g, "-")}-${safeAccountKey}-${safeRunId}.json`;
  const proposal = {
    version: 1,
    kind: "automation_proposal",
    proposalOnly: true,
    autoApply: false,
    autoMerge: false,
    runId: opts.runId,
    ruleId: opts.rule.id,
    actionType: opts.rule.action.type,
    accountKey: opts.accountKey,
    generatedAt: now.toISOString(),
    intent: opts.rule.intent ?? null,
    sourceText: opts.rule.sourceText ?? null,
    action: opts.rule.action,
    targets: opts.targets.map((target) => ({
      level: target.level,
      targetKey: target.targetKey,
      hierarchyId: target.hierarchyId,
      displayName: target.displayName ?? null,
      observedMetrics: target.observedMetrics,
      reasons: target.reasons,
    })),
  };
  const content = `${JSON.stringify(proposal, null, 2)}\n`;
  const diff = fullFileDiff(content);
  const file: CreatePullRequestFile = { path: filePath, action: "create", diff };
  const created = await opts.githubAdapter.createPullRequest({
    spec: {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    },
    title: `[addroid] Automation proposal: ${opts.rule.id} (${opts.accountKey})`,
    body: proposalBody(opts.rule, opts.accountKey, opts.targets, filePath),
    branchName,
    files: [file],
    baseRef: repo.defaultBranch,
  });

  const preview = {
    files: [
      {
        path: filePath,
        action: "create",
        diffPreview: diff.slice(0, 4096),
        diffTruncated: diff.length > 4096,
        diffByteLength: Buffer.byteLength(diff, "utf8"),
        additions: content.split(/\r?\n/).length,
        deletions: 0,
      },
    ],
    truncatedFileCount: 0,
    totalFileCount: 1,
  };
  const prRow = await opts.prisma.githubPullRequest.upsert({
    where: { repoId_number: { repoId: repo.id, number: created.number } },
    update: {
      title: `[addroid] Automation proposal: ${opts.rule.id} (${opts.accountKey})`,
      state: "open",
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      htmlUrl: created.htmlUrl,
      body: proposalBody(opts.rule, opts.accountKey, opts.targets, filePath),
      filesChangedJson: preview as unknown as Prisma.InputJsonValue,
      filesChangedCount: 1,
      previewSource: "automation_proposal",
      previewUpdatedAt: now,
    },
    create: {
      repoId: repo.id,
      number: created.number,
      title: `[addroid] Automation proposal: ${opts.rule.id} (${opts.accountKey})`,
      state: "open",
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      htmlUrl: created.htmlUrl,
      body: proposalBody(opts.rule, opts.accountKey, opts.targets, filePath),
      filesChangedJson: preview as unknown as Prisma.InputJsonValue,
      filesChangedCount: 1,
      previewSource: "automation_proposal",
      previewUpdatedAt: now,
    },
    select: { id: true },
  });
  await opts.prisma.approvalRecord.create({
    data: {
      workspaceId: opts.workspaceId,
      pullRequestId: prRow.id,
      targetType: "github_pull_request",
      targetId: prRow.id,
      approvedBy: "addroid",
      decision: "approval_required",
      comment: "Automation proposal requires human review and merge; it is never auto-applied.",
      metadata: {
        source: "automation_proposal",
        ruleId: opts.rule.id,
        runId: opts.runId,
        proposalOnly: true,
        autoApply: false,
      } as Prisma.InputJsonValue,
    },
  });

  return {
    repository: `${repo.owner}/${repo.name}`,
    branchName,
    prNumber: created.number,
    prUrl: created.htmlUrl,
    pullRequestId: prRow.id,
    headSha: created.headSha,
    filePath,
    filesChanged: 1,
    targets: opts.targets.map((target) => ({
      level: target.level,
      targetKey: target.targetKey,
    })),
    diff,
  };
}

function proposalBody(
  rule: AutomationRuleYaml,
  accountKey: string,
  targets: AutomationProposalTarget[],
  filePath: string,
): string {
  return [
    "## Automation proposal",
    "",
    `- Rule: \`${rule.id}\``,
    `- Action: \`${rule.action.type}\``,
    `- Account: \`${accountKey}\``,
    `- Targets: ${targets.length}`,
    `- Artifact: \`${filePath}\``,
    "- Safety: proposal-only; auto-apply and auto-merge are disabled.",
    "",
    "Merging this PR records the review artifact only. It does not call Meta APIs.",
  ].join("\n");
}

function fullFileDiff(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

function safeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}
