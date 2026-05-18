import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { MetaCliOperationAction } from "@addroid/queue";
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
  operations?: OperationProposalAction[];
}

export interface OperationProposalAction {
  resource: string;
  verb: string;
  args: string[];
  entity?: MetaCliOperationAction["entity"];
  externalIdRequired?: boolean;
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
  const manifest = buildOperationManifest({
    input: opts.input,
    accountKey,
    actor: opts.actor,
    source: opts.source,
  });
  const changes = manifest.actions.map(formatOperationChange);
  if (changes.length === 0) {
    throw new Error("PR にできる操作が見つかりませんでした。target id、level、desiredChanges を確認してください。");
  }

  const nextText = `${JSON.stringify(manifest, null, 2)}\n`;
  const operationPath = `operations/${accountKey}/${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.input.intent}.json`;
  const file: CreatePullRequestFile = {
    path: operationPath,
    action: "create",
    diff: fullFileDiff(nextText),
  };
  const planSummary = summarizeOperationManifest(manifest);

  const title = proposalTitle(opts.input.intent, account?.displayName ?? accountKey, changes);
  const body = proposalBody({
    input: opts.input,
    accountKey,
    actor: opts.actor,
    source: opts.source,
    changes,
    planSummary,
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
        operationPath,
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
        operationPath,
        changes,
        planSummary,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    prNumber: created.number,
    htmlUrl: created.htmlUrl,
    pullRequestId: prRow.id,
    headSha: created.headSha,
    filesChanged: 1,
    planOk: true,
    planSummary,
  };
}

interface OperationManifest {
  version: 1;
  accountKey: string;
  intent: OpsChangeProposalInput["intent"];
  source: string;
  actor: string;
  rationale: string | null;
  createdAt: string;
  actions: Array<Omit<MetaCliOperationAction, "kind" | "account">>;
}

function buildOperationManifest(input: {
  input: OpsChangeProposalInput;
  accountKey: string;
  actor: string;
  source: string;
}): OperationManifest {
  const actions = normalizeOperationActions(input.input, input.accountKey);
  return {
    version: 1,
    accountKey: input.accountKey,
    intent: input.input.intent,
    source: input.source,
    actor: input.actor,
    rationale: input.input.rationale?.trim() || null,
    createdAt: new Date().toISOString(),
    actions,
  };
}

function normalizeOperationActions(
  input: OpsChangeProposalInput,
  accountKey: string
): Array<Omit<MetaCliOperationAction, "kind" | "account">> {
  if (Array.isArray(input.operations) && input.operations.length > 0) {
    return input.operations.map((op) => ({
      resource: normalizeResourceName(op.resource),
      verb: op.verb,
      args: op.args,
      ...(op.entity ? { entity: op.entity } : {}),
      ...(op.externalIdRequired ? { externalIdRequired: true } : {}),
    }));
  }
  const targets = normalizeTargetsFromInput(input);
  if (targets.length === 0) throw new Error("targets または operations を指定してください。");
  return targets.map((target) => operationFromTarget(input, target, accountKey));
}

function operationFromTarget(
  input: OpsChangeProposalInput,
  target: OpsChangeProposalTarget,
  _accountKey: string
): Omit<MetaCliOperationAction, "kind" | "account"> {
  const desired = input.desiredChanges ?? {};
  if (input.intent === "budget_change") {
    if (target.level === "ad") {
      throw new Error("予算変更の対象は campaign または adset を指定してください。ad には budget を設定できません。");
    }
    const flags = budgetChangeFlags(desired);
    if (flags.length === 0) throw new Error("予算変更には dailyBudget または lifetimeBudget が必要です。");
    const resource = target.level === "campaign" ? "campaigns" : "adsets";
    const cliResource = target.level === "campaign" ? "campaign" : "adset";
    return {
      resource,
      verb: "update",
      args: ["ads", cliResource, "update", target.id, ...flags],
      entity: {
        nodeType: target.level,
        nodeKey: target.id,
      },
    };
  }
  const status = desiredStatus(input);
  const cliResource = target.level;
  const resource = target.level === "campaign" ? "campaigns" : target.level === "adset" ? "adsets" : "ads";
  return {
    resource,
    verb: "update",
    args: ["ads", cliResource, "update", target.id, "--status", status],
    entity: {
      nodeType: target.level,
      nodeKey: target.id,
      status,
    },
  };
}

function normalizeTargetsFromInput(input: OpsChangeProposalInput): OpsChangeProposalTarget[] {
  const out: OpsChangeProposalTarget[] = [];
  for (const item of input.targets ?? []) {
    if (!item?.id || !item.level) continue;
    if (item.level === "campaign" || item.level === "adset" || item.level === "ad") out.push(item);
  }
  const explicitLevel = readString(input.desiredChanges?.level);
  for (const id of input.targetIds ?? []) {
    const level =
      explicitLevel === "campaign" || explicitLevel === "adset" || explicitLevel === "ad"
        ? explicitLevel
        : input.intent === "budget_change"
          ? null
          : "campaign";
    if (!level) {
      throw new Error(`targetIds だけでは対象階層を確定できません: ${id}。targets に level を指定してください。`);
    }
    out.push({ level, id });
  }
  return out;
}

function budgetChangeFlags(desired: Record<string, unknown>): string[] {
  const out: string[] = [];
  const dailyBudget = readNumber(desired.dailyBudget);
  const lifetimeBudget = readNumber(desired.lifetimeBudget);
  if (dailyBudget !== null) out.push("--daily-budget", String(Math.round(dailyBudget)));
  if (lifetimeBudget !== null) out.push("--lifetime-budget", String(Math.round(lifetimeBudget)));
  return out;
}

function desiredStatus(input: OpsChangeProposalInput): "active" | "paused" | "archived" {
  const explicit = readString(input.desiredChanges?.status) ?? readString(input.desiredChanges?.initialState);
  const normalized = explicit?.toLowerCase();
  if (normalized === "active" || normalized === "activate") return "active";
  if (normalized === "archived" || normalized === "archive") return "archived";
  if (normalized === "paused" || normalized === "pause") return "paused";
  if (input.intent === "activate") return "active";
  return "paused";
}

function normalizeResourceName(resource: string): string {
  switch (resource) {
    case "campaign":
      return "campaigns";
    case "adset":
      return "adsets";
    case "ad":
      return "ads";
    case "creative":
      return "creatives";
    case "catalog":
      return "catalogs";
    case "dataset":
      return "datasets";
    case "page":
      return "pages";
    case "product-feed":
      return "product-feeds";
    case "product-item":
      return "product-items";
    case "product-set":
      return "product-sets";
    default:
      return resource;
  }
}

function formatOperationChange(action: Omit<MetaCliOperationAction, "kind" | "account">): string {
  return `${action.resource}:${action.verb} ${action.args.join(" ")}`;
}

function summarizeOperationManifest(manifest: OperationManifest): string {
  return `operation_manifest=ok actions=${manifest.actions.length} account=${manifest.accountKey}`;
}

function readAccountKey(input: OpsChangeProposalInput, fallback: string | null): string {
  const key = input.accountKey?.trim() || fallback;
  if (!key) throw new Error("accountKey が未指定で、デフォルト広告アカウントも未設定です。");
  return key;
}

function applyProposalToBrand(brand: Record<string, unknown>, input: OpsChangeProposalInput): string[] {
  const changes: string[] = [];
  const targets = normalizeTargets(input, brand);
  if (targets.length === 0) throw new Error("targets または targetIds を指定してください。");
  const desiredStatus = desiredInitialState(input);
  for (const target of targets) {
    const found = findTarget(brand, target);
    if (!found) continue;
    if (input.intent === "budget_change") {
      if (target.level === "ad") {
        throw new Error("予算変更の対象は campaign または adset を指定してください。ad には budget を設定できません。");
      }
      const updated = applyBudgetChange(found.node, input.desiredChanges ?? {});
      if (updated) changes.push(formatBudgetChange(target, input.desiredChanges ?? {}));
      continue;
    }
    found.node.initialState = desiredStatus;
    changes.push(`${target.level}:${target.id} initialState -> ${desiredStatus}`);
  }
  return changes;
}

function normalizeTargets(
  input: OpsChangeProposalInput,
  brand: Record<string, unknown>
): OpsChangeProposalTarget[] {
  const out: OpsChangeProposalTarget[] = [];
  for (const item of input.targets ?? []) {
    if (!item?.id || !item.level) continue;
    if (item.level === "campaign" || item.level === "adset" || item.level === "ad") {
      out.push({ level: item.level, id: item.id });
    }
  }
  const defaultLevel = readString(input.desiredChanges?.level) as OpsChangeProposalTarget["level"] | null;
  for (const id of input.targetIds ?? []) {
    const inferredLevel = inferTargetLevel(brand, id);
    const level =
      defaultLevel === "adset" || defaultLevel === "ad" || defaultLevel === "campaign"
        ? defaultLevel
        : inferredLevel;
    if (!level && input.intent === "budget_change") {
      throw new Error(
        `予算変更では targetIds だけから対象階層を campaign/adset に確定できません: ${id}。Meta の現在値を確認し、targets: [{ level: "campaign" または "adset", id }] を指定してください。`
      );
    }
    out.push({
      level: level ?? "campaign",
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

function formatBudgetChange(
  target: OpsChangeProposalTarget,
  desired: Record<string, unknown>
): string {
  const parts: string[] = [];
  const dailyBudget = readNumber(desired.dailyBudget);
  const lifetimeBudget = readNumber(desired.lifetimeBudget);
  if (dailyBudget !== null) parts.push(`dailyBudget -> ${dailyBudget}`);
  if (lifetimeBudget !== null) parts.push(`lifetimeBudget -> ${lifetimeBudget}`);
  return `${target.level}:${target.id} budget.${parts.join(", budget.")}`;
}

function findTarget(
  brand: Record<string, unknown>,
  target: OpsChangeProposalTarget
): { node: Record<string, unknown> } | null {
  const campaigns = Array.isArray(brand.campaigns) ? brand.campaigns : [];
  for (const campaign of campaigns) {
    if (!isRecord(campaign)) continue;
    if (target.level === "campaign" && nodeMatchesId(campaign, target.id)) return { node: campaign };
    const adsets = Array.isArray(campaign.adsets) ? campaign.adsets : [];
    for (const adset of adsets) {
      if (!isRecord(adset)) continue;
      if (target.level === "adset" && nodeMatchesId(adset, target.id)) return { node: adset };
      const ads = Array.isArray(adset.ads) ? adset.ads : [];
      for (const ad of ads) {
        if (!isRecord(ad)) continue;
        if (target.level === "ad" && nodeMatchesId(ad, target.id)) return { node: ad };
      }
    }
  }
  return null;
}

function inferTargetLevel(
  brand: Record<string, unknown>,
  id: string
): OpsChangeProposalTarget["level"] | null {
  const matched = new Set<OpsChangeProposalTarget["level"]>();
  const campaigns = Array.isArray(brand.campaigns) ? brand.campaigns : [];
  for (const campaign of campaigns) {
    if (!isRecord(campaign)) continue;
    if (nodeMatchesId(campaign, id)) matched.add("campaign");
    const adsets = Array.isArray(campaign.adsets) ? campaign.adsets : [];
    for (const adset of adsets) {
      if (!isRecord(adset)) continue;
      if (nodeMatchesId(adset, id)) matched.add("adset");
      const ads = Array.isArray(adset.ads) ? adset.ads : [];
      for (const ad of ads) {
        if (isRecord(ad) && nodeMatchesId(ad, id)) matched.add("ad");
      }
    }
  }
  return matched.size === 1 ? Array.from(matched)[0]! : null;
}

function nodeMatchesId(node: Record<string, unknown>, id: string): boolean {
  return node.id === id || node.externalId === id;
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
      baseDir: input.baseDir ?? input.rootDir,
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

function formatDryRunFailure(plan: ReturnType<typeof runPlanForRoot>): string {
  const details = dryRunFailureDetails(plan);
  return [
    `dry-run で問題が見つかったため PR は作成しません: ${summarizePlan(plan)}`,
    "この dry-run は Meta CLI ではなく、ops repo の一時コピーにPR差分を当てて YAML 検証と実行計画生成だけを行います。Meta には接続・反映していません。",
    ...(details.length > 0 ? ["原因:", ...details.map((line) => `- ${line}`)] : []),
  ].join("\n");
}

function dryRunFailureDetails(plan: ReturnType<typeof runPlanForRoot>): string[] {
  const lines: string[] = [];
  for (const err of plan.validationErrors.slice(0, 8)) {
    lines.push(`${err.file}${err.pointer ? ` ${err.pointer}` : ""}: ${err.message}`);
  }
  for (const account of plan.perAccount) {
    for (const finding of account.findings.filter((f) => f.level === "error").slice(0, 8)) {
      lines.push(
        `${account.account}${finding.pointer ? ` ${finding.pointer}` : ""}: ${finding.message}`
      );
    }
  }
  const total =
    plan.validationErrors.length +
    plan.perAccount.reduce(
      (sum, account) => sum + account.findings.filter((f) => f.level === "error").length,
      0
    );
  if (total > lines.length) {
    lines.push(`ほか ${total - lines.length} 件のエラーがあります。`);
  }
  return lines;
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
  const budgetTargetSection =
    input.input.intent === "budget_change"
      ? [
          "## Budget target",
          "",
          "このPRは Changes に表示された階層の budget だけを変更します。",
          "キャンペーン予算と広告セット予算は別物です。対象階層が依頼内容と違う場合は承認せず、campaign/adset のどちらの予算を変更するか確認してください。",
          "",
        ]
      : [];
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
    ...budgetTargetSection,
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
  return [`--- /dev/null`, `+++ b/operation.json`, `@@`, body].join("\n");
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
