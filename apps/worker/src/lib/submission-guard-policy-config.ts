// AdDroid OSS — submission guard policy configuration helpers.
//
// Web UI / chat surfaces write the same ops-repo file:
// `workflows/guards.yaml`. The plan/validate layer reads this file and applies
// deterministic pre-submit guardrails.

import fs from "node:fs/promises";
import path from "node:path";
import { Prisma, type PrismaClient } from "@addroid/db";
import {
  loadSubmissionGuardsPolicy,
  type SubmissionGuardsYaml,
} from "@addroid/ops-schemas";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "./ops-repo-local.js";

export interface SubmissionGuardPolicyConfigInput {
  warnOverRatio: number;
  blockOverRatio: number;
}

export interface SubmissionGuardPolicyConfigState {
  rootDir: string | null;
  yamlPath: string | null;
  policy: SubmissionGuardsYaml;
  exists: boolean;
}

export interface SaveSubmissionGuardPolicyConfigResult {
  rootDir: string;
  yamlPath: string;
  policy: SubmissionGuardsYaml;
}

export const DEFAULT_SUBMISSION_GUARDS_POLICY: SubmissionGuardsYaml = {
  version: 1,
  guards: {
    budgetIncrease: {
      warnOverRatio: 2,
      blockOverRatio: 5,
    },
  },
};

const SUBMISSION_GUARDS_YAML = path.join("workflows", "guards.yaml");

export async function loadSubmissionGuardPolicyConfig(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SubmissionGuardPolicyConfigState> {
  const rootDir = await resolveSubmissionGuardRoot(opts);
  const yamlPath = rootDir ? path.join(rootDir, SUBMISSION_GUARDS_YAML) : null;
  const exists = yamlPath ? await fileExists(yamlPath) : false;
  const policy = rootDir
    ? (loadSubmissionGuardsPolicy(rootDir) ?? DEFAULT_SUBMISSION_GUARDS_POLICY)
    : DEFAULT_SUBMISSION_GUARDS_POLICY;
  return { rootDir, yamlPath, policy, exists };
}

export async function saveSubmissionGuardPolicyConfig(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  input: SubmissionGuardPolicyConfigInput;
  actor: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SaveSubmissionGuardPolicyConfigResult> {
  const warnOverRatio = readPositiveNumber(opts.input.warnOverRatio, "warnOverRatio");
  const blockOverRatio = readPositiveNumber(opts.input.blockOverRatio, "blockOverRatio");
  if (warnOverRatio >= blockOverRatio) {
    throw new Error("警告ラインはブロックラインより小さくしてください。");
  }

  const rootDir = await resolveSubmissionGuardRoot(opts);
  if (!rootDir) {
    throw new Error("ops repo のローカル checkout が見つかりません。GitHub 連携を確認してください。");
  }

  const policy: SubmissionGuardsYaml = {
    version: 1,
    guards: {
      budgetIncrease: {
        warnOverRatio,
        blockOverRatio,
      },
    },
  };
  const yamlPath = path.join(rootDir, SUBMISSION_GUARDS_YAML);
  await fs.mkdir(path.dirname(yamlPath), { recursive: true });
  await fs.writeFile(yamlPath, renderSubmissionGuardsYaml(policy), "utf8");
  await opts.prisma.auditLog
    .create({
      data: {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        action: "submission_guards.policy_saved",
        target: "submission_guards_policy",
        ref: SUBMISSION_GUARDS_YAML,
        metadata: {
          warnOverRatio,
          blockOverRatio,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return { rootDir, yamlPath, policy };
}

async function resolveSubmissionGuardRoot(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const checkout = await ensureOpsRepoLocalCheckout({
    prisma: opts.prisma as never,
    workspaceId: opts.workspaceId,
    env: opts.env,
  }).catch(() => null);
  const resolved =
    checkout ??
    (await resolveOpsRepoLocalDirForWorkspace({
      prisma: opts.prisma as never,
      workspaceId: opts.workspaceId,
      env: opts.env,
    }));
  return resolved.rootDir && resolved.exists ? resolved.rootDir : null;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false);
}

function readPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} は 0 より大きい数値で指定してください。`);
  }
  return value;
}

function renderSubmissionGuardsYaml(policy: SubmissionGuardsYaml): string {
  const budget = policy.guards.budgetIncrease;
  return [
    "version: 1",
    "guards:",
    "  budgetIncrease:",
    `    warnOverRatio: ${formatNumber(budget.warnOverRatio)}`,
    `    blockOverRatio: ${formatNumber(budget.blockOverRatio)}`,
    "",
  ].join("\n");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
