import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Prisma, type PrismaClient } from "@addroid/db";
import type {
  CreatePullRequestFile,
  GithubAdapter,
} from "@addroid/github-adapter";
import { runPlanForRoot } from "./plan-runtime.js";
import { ensureOpsRepoLocalCheckout, resolveOpsRepoLocalDirForWorkspace } from "./ops-repo-local.js";

export interface OpsChangeProposalTarget {
  level: "campaign" | "adset" | "ad";
  id: string;
}

export interface OpsChangeProposalInput {
  intent: "pause" | "activate" | "status_change" | "budget_change" | "other";
  accountKey?: string;
  targets?: OpsChangeProposalTarget[];
  targetIds?: string[];
  desiredChanges?: Record<string, unknown>;
  rationale?: string;
  urgency?: "low" | "normal" | "high";
}

export interface OpsChangeProposalResult {
  prNumber: number;
  htmlUrl: string;
  pullRequestId: string;
  headSha: string;
  filesChanged: number;
  planOk: boolean;
  planSummary: string;
}

export async function createOpsChangeProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: OpsChangeProposalInput;
  actor: string;
  source: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpsChangeProposalResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      opsRepoId: true,
      defaultAdAccount: {
        select: { key: true, displayName: true },
      },
    },
  });
  if (!workspace?.opsRepoId) {
    throw new Error("ops repo が未接続です。GitHub 接続と ops repo bootstrap を完了してください。");
  }
  const repo = await opts.prisma.githubRepo.findUnique({
    where: { id: workspace.opsRepoId },
    select: { id: true, owner: true, name: true, defaultBranch: true },
  });
  if (!repo) throw new Error(`ops repo ${workspace.opsRepoId} が github_repos に見つかりません。`);

  const accountKey = readAccountKey(opts.input, workspace.defaultAdAccount?.key ?? null);
  const account = await opts.prisma.adAccount.findUnique({
    where: { workspaceId_key: { workspaceId: opts.workspaceId, key: accountKey } },
    select: { key: true, displayName: true },
  });
  const checkout = await ensureOpsRepoLocalCheckout({
    prisma: opts.prisma as never,
    workspaceId: opts.workspaceId,
    env,
  }).catch(() => null);
  const rootDir =
    checkout?.rootDir ??
    (await resolveOpsRepoLocalDirForWorkspace({
      prisma: opts.prisma as never,
      workspaceId: opts.workspaceId,
      env,
    })).rootDir;
  if (!rootDir) throw new Error("ops repo の local checkout を解決できません。GitHub 接続と ops repo bootstrap を完了してください。");
  const brandPath = path.join(rootDir, "ads", "accounts", accountKey, "brand.yaml");
  if (!fs.existsSync(brandPath)) {
    throw new Error(`対象 account の brand.yaml が見つかりません: ads/accounts/${accountKey}/brand.yaml`);
  }

  const original = fs.readFileSync(brandPath, "utf8");
  const doc = YAML.parse(original) as unknown;
  if (!isRecord(doc)) throw new Error("brand.yaml の形式が不正です。");
  const next = structuredCloneJson(doc);
  const changes = applyProposalToBrand(next, opts.input);
  if (changes.length === 0) {
    throw new Error("PR にできる変更対象が見つかりませんでした。target id と level を確認してください。");
  }

  const nextText = YAML.stringify(next);
  const file: CreatePullRequestFile = {
    path: `ads/accounts/${accountKey}/brand.yaml`,
    action: "update",
    diff: fullFileDiff(nextText),
  };
  const baseDir = env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  const plan = validateWithTempCheckout({
    rootDir,
    baseDir,
    file,
    accountKey,
  });
  if (!plan.ok) {
    throw new Error(`dry-run で問題が見つかったため PR は作成しません: ${summarizePlan(plan)}`);
  }

  const title = proposalTitle(opts.input.intent, account?.displayName ?? accountKey, changes);
  const body = proposalBody({
    input: opts.input,
    accountKey,
    actor: opts.actor,
    source: opts.source,
    changes,
    planSummary: summarizePlan(plan),
  });
  const branchName = `addroid/ops-proposal-${Date.now().toString(36)}`;
  const created = await opts.githubAdapter.createPullRequest({
    spec: {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    },
    title,
    body,
    branchName,
    files: [file],
    baseRef: repo.defaultBranch,
  });

  const preview = {
    files: [
      {
        path: file.path,
        action: file.action,
        diffPreview: file.diff.slice(0, 4096),
        diffTruncated: file.diff.length > 4096,
        diffByteLength: Buffer.byteLength(file.diff, "utf8"),
        additions: nextText.split(/\r?\n/).length,
        deletions: 0,
      },
    ],
    truncatedFileCount: 0,
    totalFileCount: 1,
  };
  const previewUpdatedAt = new Date();
  const prRow = await opts.prisma.githubPullRequest.upsert({
    where: { repoId_number: { repoId: repo.id, number: created.number } },
    update: {
      title,
      state: "open",
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      htmlUrl: created.htmlUrl,
      body,
      filesChangedJson: preview as unknown as Prisma.InputJsonValue,
      filesChangedCount: 1,
      previewSource: "agent_ops_proposal",
      previewUpdatedAt,
    },
    create: {
      repoId: repo.id,
      number: created.number,
      title,
      state: "open",
      headSha: created.headSha,
      baseRef: repo.defaultBranch,
      htmlUrl: created.htmlUrl,
      body,
      filesChangedJson: preview as unknown as Prisma.InputJsonValue,
      filesChangedCount: 1,
      previewSource: "agent_ops_proposal",
      previewUpdatedAt,
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
      comment: "Agent-created GitOps proposal requires human PR merge.",
      metadata: {
        decisionSource: "agent_ops_proposal",
        intent: opts.input.intent,
        accountKey,
        changes,
      } as Prisma.InputJsonValue,
    },
  });
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "agent.ops_proposal.opened",
      target: `github_pull_request:${prRow.id}`,
      ref: String(created.number),
      metadata: {
        source: opts.source,
        intent: opts.input.intent,
        accountKey,
        changes,
        planSummary: summarizePlan(plan),
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    prNumber: created.number,
    htmlUrl: created.htmlUrl,
    pullRequestId: prRow.id,
    headSha: created.headSha,
    filesChanged: 1,
    planOk: plan.ok,
    planSummary: summarizePlan(plan),
  };
}

function readAccountKey(input: OpsChangeProposalInput, fallback: string | null): string {
  const key = input.accountKey?.trim() || fallback;
  if (!key) throw new Error("accountKey が未指定で、デフォルト広告アカウントも未設定です。");
  return key;
}

function applyProposalToBrand(brand: Record<string, unknown>, input: OpsChangeProposalInput): string[] {
  const changes: string[] = [];
  const targets = normalizeTargets(input);
  if (targets.length === 0) throw new Error("targets または targetIds を指定してください。");
  const desiredStatus = desiredInitialState(input);
  for (const target of targets) {
    const found = findTarget(brand, target);
    if (!found) continue;
    if (input.intent === "budget_change") {
      const updated = applyBudgetChange(found.node, input.desiredChanges ?? {});
      if (updated) changes.push(`${target.level}:${target.id} budget updated`);
      continue;
    }
    found.node.initialState = desiredStatus;
    changes.push(`${target.level}:${target.id} initialState -> ${desiredStatus}`);
  }
  return changes;
}

function normalizeTargets(input: OpsChangeProposalInput): OpsChangeProposalTarget[] {
  const out: OpsChangeProposalTarget[] = [];
  for (const item of input.targets ?? []) {
    if (!item?.id || !item.level) continue;
    if (item.level === "campaign" || item.level === "adset" || item.level === "ad") {
      out.push({ level: item.level, id: item.id });
    }
  }
  const defaultLevel = readString(input.desiredChanges?.level) as OpsChangeProposalTarget["level"] | null;
  for (const id of input.targetIds ?? []) {
    out.push({
      level:
        defaultLevel === "adset" || defaultLevel === "ad" || defaultLevel === "campaign"
          ? defaultLevel
          : "campaign",
      id,
    });
  }
  return out;
}

function desiredInitialState(input: OpsChangeProposalInput): "paused" | "active" {
  const explicit = readString(input.desiredChanges?.initialState) ?? readString(input.desiredChanges?.status);
  const normalized = explicit?.trim().toLowerCase();
  if (normalized === "active" || normalized === "active_on_meta") return "active";
  if (normalized === "paused" || normalized === "pause" || normalized === "pausing") return "paused";
  return input.intent === "activate" ? "active" : "paused";
}

function applyBudgetChange(node: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const dailyBudget = readNumber(desired.dailyBudget);
  const lifetimeBudget = readNumber(desired.lifetimeBudget);
  if (dailyBudget === null && lifetimeBudget === null) return false;
  const budget = isRecord(node.budget) ? { ...node.budget } : {};
  if (dailyBudget !== null) budget.dailyBudget = dailyBudget;
  if (lifetimeBudget !== null) budget.lifetimeBudget = lifetimeBudget;
  node.budget = budget;
  return true;
}

function findTarget(
  brand: Record<string, unknown>,
  target: OpsChangeProposalTarget
): { node: Record<string, unknown> } | null {
  const campaigns = Array.isArray(brand.campaigns) ? brand.campaigns : [];
  for (const campaign of campaigns) {
    if (!isRecord(campaign)) continue;
    if (target.level === "campaign" && campaign.id === target.id) return { node: campaign };
    const adsets = Array.isArray(campaign.adsets) ? campaign.adsets : [];
    for (const adset of adsets) {
      if (!isRecord(adset)) continue;
      if (target.level === "adset" && adset.id === target.id) return { node: adset };
      const ads = Array.isArray(adset.ads) ? adset.ads : [];
      for (const ad of ads) {
        if (!isRecord(ad)) continue;
        if (target.level === "ad" && ad.id === target.id) return { node: ad };
      }
    }
  }
  return null;
}

function validateWithTempCheckout(input: {
  rootDir: string;
  baseDir: string | null;
  file: CreatePullRequestFile;
  accountKey: string;
}): ReturnType<typeof runPlanForRoot> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-proposal-"));
  try {
    fs.cpSync(input.rootDir, tmp, { recursive: true, dereference: false });
    const dest = path.join(tmp, input.file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, extractAddedContentFromDiff(input.file.diff), "utf8");
    return runPlanForRoot({
      rootDir: tmp,
      baseDir: input.baseDir,
      accountFilter: input.accountKey,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function summarizePlan(plan: ReturnType<typeof runPlanForRoot>): string {
  const counts = plan.totalCounts;
  return `creates=${counts.creates} updates=${counts.updates} deletes=${counts.deletes} errors=${counts.errors + plan.validationErrors.length} warnings=${counts.warnings + plan.validationWarnings.length}`;
}

function proposalTitle(intent: string, accountLabel: string, changes: string[]): string {
  const label =
    intent === "pause"
      ? "Pause"
      : intent === "activate"
        ? "Activate"
        : intent === "budget_change"
          ? "Budget change"
          : "Ops change";
  return `[addroid] ${label}: ${accountLabel} (${changes.length} change${changes.length === 1 ? "" : "s"})`;
}

function proposalBody(input: {
  input: OpsChangeProposalInput;
  accountKey: string;
  actor: string;
  source: string;
  changes: string[];
  planSummary: string;
}): string {
  return [
    "## Agent proposal",
    "",
    `- Account: \`${input.accountKey}\``,
    `- Intent: \`${input.input.intent}\``,
    `- Source: \`${input.source}\``,
    `- Requested by: \`${input.actor}\``,
    `- Urgency: \`${input.input.urgency ?? "normal"}\``,
    "",
    "## Rationale",
    "",
    input.input.rationale?.trim() || "No additional rationale was provided.",
    "",
    "## Changes",
    "",
    ...input.changes.map((c) => `- ${c}`),
    "",
    "## Dry-run",
    "",
    input.planSummary,
    "",
    "Human review and PR merge are required before AdDroid applies this to Meta.",
    "",
  ].join("\n");
}

function fullFileDiff(content: string): string {
  const body = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [`--- /dev/null`, `+++ b/brand.yaml`, `@@`, body].join("\n");
}

function extractAddedContentFromDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) continue;
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) out.push(line.slice(1));
    else if (line.startsWith(" ")) out.push(line.slice(1));
    else out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function structuredCloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
