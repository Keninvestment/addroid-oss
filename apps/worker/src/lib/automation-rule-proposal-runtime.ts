import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Prisma, type PrismaClient } from "@addroid/db";
import {
  AutomationRulesYamlSchema,
  type AutomationRulesYaml,
} from "@addroid/ops-schemas";
import type { AutomationRuleCalibration } from "@addroid/queue";
import type {
  CreatePullRequestFile,
  GithubAdapter,
} from "@addroid/github-adapter";
import { buildCalibrationForAutomationRule } from "./automation-baseline-runtime.js";
import { ensureOpsRepoLocalCheckout, resolveOpsRepoLocalDirForWorkspace } from "./ops-repo-local.js";

export interface AutomationRuleProposalInput {
  sourceText?: string;
  rule?: Record<string, unknown>;
  rationale?: string;
  title?: string;
}

export interface AutomationRuleCalibrationUpdateInput {
  ruleId: string;
  rationale?: string;
  title?: string;
}

export interface AutomationRuleProposalResult {
  prNumber: number;
  htmlUrl: string;
  pullRequestId: string;
  headSha: string;
  ruleId: string;
}

export async function createAutomationRuleProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: AutomationRuleProposalInput;
  actor: string;
  source: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AutomationRuleProposalResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { opsRepoId: true },
  });
  if (!workspace?.opsRepoId) {
    throw new Error("ops repo が未接続です。GitHub 接続と ops repo bootstrap を完了してください。");
  }
  const repo = await opts.prisma.githubRepo.findUnique({
    where: { id: workspace.opsRepoId },
    select: { id: true, owner: true, name: true, defaultBranch: true },
  });
  if (!repo) throw new Error(`ops repo ${workspace.opsRepoId} が github_repos に見つかりません。`);

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
  if (!rootDir) {
    throw new Error("ops repo の local checkout を解決できません。GitHub 接続と ops repo bootstrap を完了してください。");
  }

  const relPath = "workflows/automation-rules.yaml";
  const abs = path.join(rootDir, relPath);
  const current = loadCurrentAutomationRules(abs);
  const nextRule = normalizeAutomationRuleDraft(opts.input);
  const calibration = await buildCalibrationForAutomationRule({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    rule: nextRule,
  }).catch(() => null);
  if (calibration) applyCalibrationToRule(nextRule, calibration);
  const next = upsertRule(current, nextRule);
  const parsed = AutomationRulesYamlSchema.safeParse(next);
  if (!parsed.success) {
    throw new Error(`automation rule の形式が不正です: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const nextText = YAML.stringify(parsed.data);
  const file: CreatePullRequestFile = {
    path: relPath,
    action: fs.existsSync(abs) ? "update" : "create",
    diff: fullFileDiff(relPath, nextText),
  };
  const action = isRecord(nextRule.action) ? readString(nextRule.action.type) : null;
  const title =
    opts.input.title?.trim() ||
    `[addroid] Automation rule: ${String(nextRule.id)} (${String(nextRule.intent ?? action ?? "change")})`;
  const body = proposalBody({
    sourceText: opts.input.sourceText,
    rationale: opts.input.rationale,
    actor: opts.actor,
    source: opts.source,
    rule: nextRule,
    calibration,
  });
  const created = await opts.githubAdapter.createPullRequest({
    spec: {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    },
    title,
    body,
    branchName: `addroid/automation-rule-${Date.now().toString(36)}`,
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
      previewSource: "agent_automation_rule",
      previewUpdatedAt: new Date(),
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
      previewSource: "agent_automation_rule",
      previewUpdatedAt: new Date(),
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
      comment: "Agent-created automation rule requires human PR merge before it can run.",
      metadata: {
        decisionSource: "agent_automation_rule",
        ruleId: nextRule.id,
        sourceText: opts.input.sourceText ?? null,
      } as Prisma.InputJsonValue,
    },
  });
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "agent.automation_rule_proposal.opened",
      target: `github_pull_request:${prRow.id}`,
      ref: String(created.number),
      metadata: {
        source: opts.source,
        ruleId: nextRule.id,
        sourceText: opts.input.sourceText ?? null,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    prNumber: created.number,
    htmlUrl: created.htmlUrl,
    pullRequestId: prRow.id,
    headSha: created.headSha,
    ruleId: String(nextRule.id),
  };
}

export async function createAutomationRuleCalibrationUpdateProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: AutomationRuleCalibrationUpdateInput;
  actor: string;
  source: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AutomationRuleProposalResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { opsRepoId: true },
  });
  if (!workspace?.opsRepoId) {
    throw new Error("ops repo が未接続です。GitHub 接続と ops repo bootstrap を完了してください。");
  }
  const repo = await opts.prisma.githubRepo.findUnique({
    where: { id: workspace.opsRepoId },
    select: { id: true, owner: true, name: true, defaultBranch: true },
  });
  if (!repo) throw new Error(`ops repo ${workspace.opsRepoId} が github_repos に見つかりません。`);

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
  if (!rootDir) {
    throw new Error("ops repo の local checkout を解決できません。GitHub 接続と ops repo bootstrap を完了してください。");
  }

  const ruleId = opts.input.ruleId.trim();
  if (!ruleId) throw new Error("更新する automation rule id が必要です。");
  const relPath = "workflows/automation-rules.yaml";
  const abs = path.join(rootDir, relPath);
  const current = loadCurrentAutomationRules(abs);
  const existing = current.rules.find((rule) => rule.id === ruleId);
  if (!existing) throw new Error(`automation rule '${ruleId}' が workflows/automation-rules.yaml に見つかりません。`);

  const nextRule = { ...(existing as unknown as Record<string, unknown>) };
  const calibration = await buildCalibrationForAutomationRule({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    rule: nextRule,
  });
  if (!calibration) {
    throw new Error(`automation rule '${ruleId}' の校正に必要なアカウント実績が見つかりません。`);
  }
  applyCalibrationToRule(nextRule, calibration);
  const next = upsertRule(current, nextRule);
  const parsed = AutomationRulesYamlSchema.safeParse(next);
  if (!parsed.success) {
    throw new Error(`automation rule の更新後形式が不正です: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const nextText = YAML.stringify(parsed.data);
  const file: CreatePullRequestFile = {
    path: relPath,
    action: fs.existsSync(abs) ? "update" : "create",
    diff: fullFileDiff(relPath, nextText),
  };
  const title =
    opts.input.title?.trim() ||
    `[addroid] Recalibrate automation rule: ${ruleId}`;
  const body = calibrationUpdateBody({
    ruleId,
    rationale: opts.input.rationale,
    actor: opts.actor,
    source: opts.source,
    calibration,
  });
  const created = await opts.githubAdapter.createPullRequest({
    spec: {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    },
    title,
    body,
    branchName: `addroid/automation-rule-recalibrate-${Date.now().toString(36)}`,
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
      previewSource: "agent_automation_rule_recalibration",
      previewUpdatedAt: new Date(),
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
      previewSource: "agent_automation_rule_recalibration",
      previewUpdatedAt: new Date(),
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
      comment: "Agent-created automation rule recalibration requires human PR merge before it can run.",
      metadata: {
        decisionSource: "agent_automation_rule_recalibration",
        ruleId,
        calibration,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "agent.automation_rule_recalibration.opened",
      target: `github_pull_request:${prRow.id}`,
      ref: String(created.number),
      metadata: {
        source: opts.source,
        ruleId,
        calibration,
      } as unknown as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    prNumber: created.number,
    htmlUrl: created.htmlUrl,
    pullRequestId: prRow.id,
    headSha: created.headSha,
    ruleId,
  };
}

function loadCurrentAutomationRules(abs: string): AutomationRulesYaml {
  if (!fs.existsSync(abs)) return { version: 1, rules: [] };
  const parsed = AutomationRulesYamlSchema.safeParse(YAML.parse(fs.readFileSync(abs, "utf8")));
  if (!parsed.success) {
    throw new Error("既存の workflows/automation-rules.yaml が不正なため更新できません。");
  }
  return parsed.data;
}

function normalizeAutomationRuleDraft(input: AutomationRuleProposalInput): Record<string, unknown> {
  const sourceText = input.sourceText?.trim();
  const rule = isRecord(input.rule) ? { ...input.rule } : {};
  rule.id = readString(rule.id) ?? deriveRuleId(sourceText ?? "automation rule");
  rule.enabled = typeof rule.enabled === "boolean" ? rule.enabled : true;
  if (sourceText && !readString(rule.sourceText)) rule.sourceText = sourceText;
  if (!isRecord(rule.window)) rule.window = { preset: "today", timezone: "account" };
  if (!isRecord(rule.scope)) rule.scope = { level: inferLevel(sourceText ?? "") };
  if (!isRecord(rule.when)) {
    throw new Error("automation rule には when 条件が必要です。");
  }
  if (!isRecord(rule.action)) {
    rule.action = inferAction(rule.intent, sourceText ?? "");
  }
  if (!isRecord(rule.approval)) rule.approval = { mode: "proposal" };
  if (!isRecord(rule.safety)) rule.safety = { mode: approvalToSafetyMode(rule.approval) };
  return rule;
}

function upsertRule(current: AutomationRulesYaml, rule: Record<string, unknown>): AutomationRulesYaml {
  const rules = [...current.rules];
  const idx = rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) rules[idx] = rule as never;
  else rules.push(rule as never);
  return { ...current, version: 1, rules };
}

function inferAction(intent: unknown, sourceText: string): Record<string, unknown> {
  const normalized = `${String(intent ?? "")} ${sourceText}`.toLowerCase();
  if (/停止|pause|paused|止め/.test(normalized)) {
    return { type: "set_status", status: "PAUSED", targetLevel: inferLevel(sourceText) };
  }
  if (/予算|budget/.test(normalized)) return { type: "adjust_budget", operation: "set_amount" };
  return { type: "proposal_only" };
}

function inferLevel(sourceText: string): "campaign" | "adset" | "ad" {
  if (/広告グループ|ad\s*set|adset/.test(sourceText)) return "adset";
  if (/広告|ad\b/.test(sourceText)) return "ad";
  return "campaign";
}

function approvalToSafetyMode(approval: unknown): "report_only" | "proposal" | "auto_apply" {
  const mode = isRecord(approval) ? readString(approval.mode) : null;
  return mode === "auto_apply" || mode === "auto_apply_if_policy_matched" || mode === "auto_merge_if_policy_matched"
    ? "auto_apply"
    : mode === "report_only"
      ? "report_only"
      : "proposal";
}

function proposalBody(input: {
  sourceText?: string;
  rationale?: string;
  actor: string;
  source: string;
  rule: Record<string, unknown>;
  calibration?: AutomationRuleCalibration | null;
}): string {
  const calibration = input.calibration;
  const calibrationLines = calibration
    ? [
        `- Calibration: \`${calibration.quality}\` (${calibration.baseline.sampleDays} sample days, ${calibration.baseline.entityCount} ${calibration.baseline.level} entities).`,
        `- Recommended spend guardrail: \`${calibration.recommended.spendMin}\`; max actions/run: \`${calibration.recommended.maxActionsPerRun}\`; max daily budget affected: \`${calibration.recommended.maxDailyBudgetAffected}\`.`,
        `- Drift policy: block auto-apply after \`${calibration.drift.staleAfterHours}h\` or material baseline drift.`,
      ]
    : ["- Calibration: unavailable. Runtime auto-apply will fail closed if no approved calibration is present."];
  return [
    "## Automation rule proposal",
    "",
    `- Rule: \`${String(input.rule.id)}\``,
    `- Source: \`${input.source}\``,
    `- Requested by: \`${input.actor}\``,
    "",
    "## Natural-language request",
    "",
    input.sourceText?.trim() || "No source text was provided.",
    "",
    "## Rationale",
    "",
    input.rationale?.trim() || "The agent translated this request into a structured automation rule. Human PR review is required before the rule can run.",
    "",
    "## Safety",
    "",
    "- This PR only changes `workflows/automation-rules.yaml`.",
    "- Runtime execution still passes through cron mode, rule approval mode, limits, and deterministic policy checks.",
    "- Unsupported or unsafe actions remain proposal-only or blocked at runtime.",
    ...calibrationLines,
    "",
  ].join("\n");
}

function calibrationUpdateBody(input: {
  ruleId: string;
  rationale?: string;
  actor: string;
  source: string;
  calibration: AutomationRuleCalibration;
}): string {
  const calibration = input.calibration;
  return [
    "## Automation rule recalibration",
    "",
    `- Rule: \`${input.ruleId}\``,
    `- Source: \`${input.source}\``,
    `- Requested by: \`${input.actor}\``,
    "",
    "## Rationale",
    "",
    input.rationale?.trim() ||
      "Runtime drift detection blocked auto-apply. This PR updates only the approved guardrail calibration from current account history.",
    "",
    "## New Guardrails",
    "",
    `- Quality: \`${calibration.quality}\``,
    `- Sample days: \`${calibration.baseline.sampleDays}\``,
    `- Entities: \`${calibration.baseline.entityCount}\` ${calibration.baseline.level}`,
    `- Spend minimum: \`${calibration.recommended.spendMin}\``,
    `- Max actions/run: \`${calibration.recommended.maxActionsPerRun}\``,
    `- Max daily budget affected: \`${calibration.recommended.maxDailyBudgetAffected}\``,
    `- Cooldown hours: \`${calibration.recommended.cooldownHours}\``,
    "",
    "## Safety",
    "",
    "- This PR only recalibrates `workflows/automation-rules.yaml`.",
    "- Meta is not mutated by this PR.",
    "- The updated rule still requires PR merge before runtime auto-apply can resume.",
    "",
  ].join("\n");
}

function applyCalibrationToRule(
  rule: Record<string, unknown>,
  calibration: AutomationRuleCalibration
): void {
  rule.calibration = calibration;
  const safety = isRecord(rule.safety) ? { ...rule.safety } : {};
  const limits = isRecord(rule.limits) ? { ...rule.limits } : {};
  const approval = isRecord(rule.approval) ? { ...rule.approval } : {};
  safety.minSpend = Math.max(
    readNumber(safety.minSpend) ?? 0,
    calibration.recommended.spendMin
  );
  safety.cooldownHours =
    readNumber(safety.cooldownHours) ?? calibration.recommended.cooldownHours;
  limits.maxActionsPerRun = Math.min(
    readNumber(limits.maxActionsPerRun) ??
      readNumber(limits.maxCampaignsPerRun) ??
      calibration.recommended.maxActionsPerRun,
    calibration.recommended.maxActionsPerRun
  );
  limits.maxDailyBudgetAffected = Math.min(
    readNumber(limits.maxDailyBudgetAffected) ??
      calibration.recommended.maxDailyBudgetAffected,
    calibration.recommended.maxDailyBudgetAffected
  );
  if (calibration.quality !== "sufficient" && isAutoApplyMode(approval.mode)) {
    approval.mode = "proposal";
    safety.mode = "proposal";
  }
  rule.safety = safety;
  rule.limits = limits;
  rule.approval = approval;
}

function fullFileDiff(relPath: string, content: string): string {
  const body = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [`--- /dev/null`, `+++ b/${relPath}`, `@@`, body].join("\n");
}

function deriveRuleId(text: string): string {
  const ascii = text
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (ascii || "automation_rule").slice(0, 48) + "_" + Date.now().toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAutoApplyMode(value: unknown): boolean {
  return value === "auto_apply" ||
    value === "auto_apply_if_policy_matched" ||
    value === "auto_merge_if_policy_matched";
}
