import { Prisma, type PrismaClient } from "@addroid/db";
import type {
  CreatePullRequestInput,
  CreatePullRequestFile,
  GithubAdapter,
} from "@addroid/github-adapter";
import { createHash } from "node:crypto";
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

interface AutomationProposalCheckpoint {
  prNumber: number;
  headSha: string;
  baseRef: string;
  branchName: string;
  filePath: string;
  artifactDigest: string;
}

export async function createAutomationProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  runId: string;
  operationKey: string;
  rule: AutomationRuleYaml;
  accountKey: string;
  targets: AutomationProposalTarget[];
  now?: Date;
  createIfMissing?: boolean;
}): Promise<AutomationProposalReceipt | null> {
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
  const safeOperationKey = safeSegment(opts.operationKey);
  const branchName = `addroid/automation-proposal-${safeRuleId}-${safeOperationKey}`;
  const filePath =
    `proposals/automation/${safeRuleId}/` +
    `${now.toISOString().replace(/[:.]/g, "-")}-${safeAccountKey}-${safeOperationKey}.json`;
  const proposal = {
    version: 1,
    kind: "automation_proposal",
    proposalOnly: true,
    autoApply: false,
    autoMerge: false,
    operationKey: opts.operationKey,
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
  const artifactDigest = createHash("sha256").update(content).digest("hex").slice(0, 20);
  const diff = fullFileDiff(content);
  const file: CreatePullRequestFile = { path: filePath, action: "create", diff };
  const title = proposalTitle(opts.rule, opts.accountKey, opts.operationKey, artifactDigest);
  const request: CreatePullRequestInput = {
    spec: {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    },
    title,
    body: proposalBody(opts.rule, opts.accountKey, opts.targets, filePath),
    branchName,
    files: [file],
    baseRef: repo.defaultBranch,
  };
  const filesChangedCount = request.files.length;
  const checkpointTarget = `automation_proposal_operation:${opts.operationKey}`;
  let acceptedCheckpoint = await loadOperationCheckpoint({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    ruleId: opts.rule.id,
    target: checkpointTarget,
  });
  if (acceptedCheckpoint) {
    validateCheckpointExpectation(acceptedCheckpoint, {
      baseRef: repo.defaultBranch,
      branchName,
      filePath,
      artifactDigest,
    });
  }
  const existing = await findExistingProposal(
    opts.githubAdapter,
    request.spec,
    opts.operationKey,
    title,
    branchName,
    filePath,
    content,
    acceptedCheckpoint,
  );
  if (!existing && opts.createIfMissing === false) return null;
  let createdFresh = false;
  let created = existing ?? await opts.githubAdapter.createPullRequest(request)
    .then((result) => {
      createdFresh = true;
      return result;
    })
    .catch(async (error) => {
      acceptedCheckpoint = await loadOperationCheckpoint({
        prisma: opts.prisma,
        workspaceId: opts.workspaceId,
        ruleId: opts.rule.id,
        target: checkpointTarget,
      });
      if (acceptedCheckpoint) {
        validateCheckpointExpectation(acceptedCheckpoint, {
          baseRef: repo.defaultBranch,
          branchName,
          filePath,
          artifactDigest,
        });
      }
      const recovered = await findExistingProposal(
        opts.githubAdapter,
        request.spec,
        opts.operationKey,
        title,
        branchName,
        filePath,
        content,
        acceptedCheckpoint,
      );
      if (recovered) return recovered;
      throw error;
    });

  if (createdFresh) {
    acceptedCheckpoint = {
      prNumber: created.number,
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      branchName,
      filePath,
      artifactDigest,
    };
    await opts.prisma.auditLog.create({
      data: {
        workspaceId: opts.workspaceId,
        actor: "cron:automation_rules",
        action: "automation.proposal.remote_created",
        target: checkpointTarget,
        ref: opts.rule.id,
        metadata: acceptedCheckpoint as unknown as Prisma.InputJsonValue,
      },
    });
    const verified = await findExistingProposal(
      opts.githubAdapter,
      request.spec,
      opts.operationKey,
      title,
      branchName,
      filePath,
      content,
      acceptedCheckpoint,
    );
    if (!verified || verified.number !== created.number || verified.headSha !== created.headSha) {
      throw new Error("automation proposal newly created PR failed exact remote verification");
    }
    created = verified;
  }

  const stored = await opts.prisma.githubPullRequest.findUnique({
    where: { repoId_number: { repoId: repo.id, number: created.number } },
    select: { headSha: true },
  });
  if (stored?.headSha && stored.headSha !== created.headSha) {
    throw new Error(
      `automation proposal existing PR head changed: expected ${stored.headSha}, got ${created.headSha}`,
    );
  }
  if (!createdFresh) {
    acceptedCheckpoint ??= await loadOperationCheckpoint({
      prisma: opts.prisma,
      workspaceId: opts.workspaceId,
      ruleId: opts.rule.id,
      target: checkpointTarget,
    });
    if (!acceptedCheckpoint && !stored?.headSha) {
      throw new Error("automation proposal existing PR has no accepted remote-creation checkpoint");
    }
    if (acceptedCheckpoint && (
      acceptedCheckpoint.prNumber !== created.number ||
      acceptedCheckpoint.headSha !== created.headSha
    )) {
      throw new Error("automation proposal existing PR differs from accepted remote-creation checkpoint");
    }
  }

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
    totalFileCount: filesChangedCount,
  };
  const prRow = await opts.prisma.githubPullRequest.upsert({
    where: { repoId_number: { repoId: repo.id, number: created.number } },
    update: {
      title,
      state: "open",
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      htmlUrl: created.htmlUrl,
      body: proposalBody(opts.rule, opts.accountKey, opts.targets, filePath),
      filesChangedJson: preview as unknown as Prisma.InputJsonValue,
      filesChangedCount,
      previewSource: "automation_proposal",
      previewUpdatedAt: now,
    },
    create: {
      repoId: repo.id,
      number: created.number,
      title,
      state: "open",
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      htmlUrl: created.htmlUrl,
      body: proposalBody(opts.rule, opts.accountKey, opts.targets, filePath),
      filesChangedJson: preview as unknown as Prisma.InputJsonValue,
      filesChangedCount,
      previewSource: "automation_proposal",
      previewUpdatedAt: now,
    },
    select: { id: true },
  });
  return {
    repository: `${repo.owner}/${repo.name}`,
    branchName,
    prNumber: created.number,
    prUrl: created.htmlUrl,
    pullRequestId: prRow.id,
    headSha: created.headSha,
    filePath,
    filesChanged: filesChangedCount,
    targets: opts.targets.map((target) => ({
      level: target.level,
      targetKey: target.targetKey,
    })),
    diff,
  };
}

async function loadOperationCheckpoint(input: {
  prisma: PrismaClient;
  workspaceId: string;
  ruleId: string;
  target: string;
}): Promise<AutomationProposalCheckpoint | null> {
  const row = await input.prisma.auditLog.findFirst({
    where: {
      workspaceId: input.workspaceId,
      action: "automation.proposal.remote_created",
      target: input.target,
      ref: input.ruleId,
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  if (!row) return null;
  const value = row.metadata;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("automation proposal remote-creation checkpoint is malformed");
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata["prNumber"] !== "number" || !Number.isInteger(metadata["prNumber"]) ||
    typeof metadata["headSha"] !== "string" || !metadata["headSha"].trim() ||
    typeof metadata["baseRef"] !== "string" || !metadata["baseRef"].trim() ||
    typeof metadata["branchName"] !== "string" || !metadata["branchName"].trim() ||
    typeof metadata["filePath"] !== "string" || !metadata["filePath"].trim() ||
    typeof metadata["artifactDigest"] !== "string" || !metadata["artifactDigest"].trim()
  ) {
    throw new Error("automation proposal remote-creation checkpoint is malformed");
  }
  return metadata as unknown as AutomationProposalCheckpoint;
}

function validateCheckpointExpectation(
  checkpoint: AutomationProposalCheckpoint,
  expected: Omit<AutomationProposalCheckpoint, "prNumber" | "headSha">,
): void {
  if (
    checkpoint.baseRef !== expected.baseRef ||
    checkpoint.branchName !== expected.branchName ||
    checkpoint.filePath !== expected.filePath ||
    checkpoint.artifactDigest !== expected.artifactDigest
  ) {
    throw new Error("automation proposal checkpoint does not match current evaluation");
  }
}

function proposalTitle(
  rule: AutomationRuleYaml,
  accountKey: string,
  operationKey: string,
  artifactDigest: string,
): string {
  return `[addroid] Automation proposal: ${rule.id} (${accountKey}) [op:${operationKey}] [artifact:${artifactDigest}]`;
}

async function findExistingProposal(
  adapter: GithubAdapter,
  spec: { owner: string; name: string; defaultBranch: string },
  operationKey: string,
  expectedTitle: string,
  expectedBranch: string,
  filePath: string,
  expectedContent: string,
  acceptedCheckpoint: AutomationProposalCheckpoint | null,
): Promise<{ number: number; htmlUrl: string; headSha: string } | null> {
  const result = await adapter.pollPullRequests(spec, {});
  const operationMarker = `[op:${operationKey}]`;
  const match = selectExistingProposal(result.pullRequests, operationMarker, {
    expectedTitle,
    expectedBranch,
    expectedBase: spec.defaultBranch,
    expectedNumber: acceptedCheckpoint?.prNumber,
    expectedHeadSha: acceptedCheckpoint?.headSha,
  });
  if (!match) return null;
  if (!adapter.readPullRequestSnapshot) {
    throw new Error("automation proposal existing PR snapshot capability is unavailable");
  }
  const snapshot = await adapter.readPullRequestSnapshot({
    spec,
    number: match.number,
    artifactPath: filePath,
    expectedHeadSha: match.headSha,
  });
  if (snapshot.headSha !== match.headSha) {
    throw new Error("automation proposal existing PR content HEAD does not match polled HEAD");
  }
  if (
    snapshot.changedFiles.length !== 1 ||
    snapshot.changedFiles[0]?.path !== filePath ||
    snapshot.changedFiles[0]?.status !== "added" ||
    snapshot.changedFiles[0]?.previousPath !== undefined
  ) {
    throw new Error("automation proposal existing PR changed-file set is not exactly one added proposal artifact");
  }
  const actualDigest = createHash("sha256").update(snapshot.artifactContent).digest("hex").slice(0, 20);
  const expectedDigest = createHash("sha256").update(expectedContent).digest("hex").slice(0, 20);
  if (snapshot.artifactContent !== expectedContent || actualDigest !== expectedDigest) {
    throw new Error("automation proposal existing PR file content does not match current evaluation");
  }

  // Re-read after fetching bytes so a concurrent close, retarget, or force-push
  // cannot be accepted using the earlier summary.
  const reread = await adapter.pollPullRequests(spec, {});
  const verified = selectExistingProposal(reread.pullRequests, operationMarker, {
    expectedTitle,
    expectedBranch,
    expectedBase: spec.defaultBranch,
    expectedNumber: acceptedCheckpoint?.prNumber,
    expectedHeadSha: acceptedCheckpoint?.headSha,
  });
  if (!verified || verified.number !== match.number || verified.headSha !== match.headSha) {
    throw new Error("automation proposal existing PR changed during content verification");
  }
  return verified;
}

function selectExistingProposal(
  pullRequests: Awaited<ReturnType<GithubAdapter["pollPullRequests"]>>["pullRequests"],
  operationMarker: string,
  expected: {
    expectedTitle: string;
    expectedBranch: string;
    expectedBase: string;
    expectedNumber?: number;
    expectedHeadSha?: string;
  },
) {
  const markerMatches = pullRequests.filter((pr) => pr.title.includes(operationMarker));
  const matches = expected.expectedNumber === undefined
    ? markerMatches
    : pullRequests.filter((pr) => pr.number === expected.expectedNumber);
  if (matches.length === 0) {
    if (expected.expectedNumber !== undefined) {
      throw new Error("automation proposal checkpoint-bound PR is missing");
    }
    return null;
  }
  if (matches.length !== 1) {
    throw new Error(`automation proposal operation has ${matches.length} matching PRs`);
  }
  const [match] = matches;
  if (
    expected.expectedNumber !== undefined &&
    markerMatches.some((candidate) => candidate.number !== expected.expectedNumber)
  ) {
    throw new Error("automation proposal operation has multiple matching PRs");
  }
  if (!match || match.state !== "open") {
    throw new Error("automation proposal existing PR is not open");
  }
  if (match.title !== expected.expectedTitle) {
    throw new Error("automation proposal existing PR artifact does not match current evaluation");
  }
  if (match.baseRef !== expected.expectedBase) {
    throw new Error("automation proposal existing PR base does not match configured default branch");
  }
  if (match.headRef !== expected.expectedBranch) {
    throw new Error("automation proposal existing PR branch does not match deterministic branch");
  }
  if (!match.headSha.trim()) {
    throw new Error("automation proposal existing PR has no head SHA");
  }
  if (expected.expectedHeadSha !== undefined && match.headSha !== expected.expectedHeadSha) {
    throw new Error("automation proposal checkpoint-bound PR head changed");
  }
  return match;
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
