// AdDroid OSS — budget_guard policy configuration helpers.
//
// Web UI / CLI chat / Web chat all write the same ops-repo file:
// `workflows/budget-guard.yaml`.  This module intentionally does not schedule
// pg-boss jobs; callers update schedule state through their own UI/CLI boundary.

import fs from "node:fs/promises";
import path from "node:path";
import { Prisma, type PrismaClient } from "@addroid/db";
import {
  loadBudgetGuardPolicy,
  type BudgetGuardPolicyYaml,
} from "@addroid/yaml-schemas";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "./ops-repo-local.js";

export interface BudgetGuardPolicyFormAccount {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
  currency: string | null;
}

export interface BudgetGuardPolicyConfigInput {
  accountKey?: string | null;
  dailyBudget: number;
  monthlyBudget: number;
  currency?: string | null;
  dailyBudgetAlertRatio?: number | null;
  monthlyPaceRatio?: number | null;
  dayOverDayRatio?: number | null;
  noConversionsSpendMin?: number | null;
  autoPauseEnabled?: boolean | null;
  autoPauseMinDailyBudgetRatio?: number | null;
  autoPauseMinDayOverDayRatio?: number | null;
  safeCategories?: string[] | string | null;
}

export interface BudgetGuardPolicyConfigState {
  rootDir: string | null;
  yamlPath: string | null;
  policy: BudgetGuardPolicyYaml | null;
  accounts: BudgetGuardPolicyFormAccount[];
}

export interface SaveBudgetGuardPolicyConfigResult {
  rootDir: string;
  yamlPath: string;
  accountKey: string;
  policy: BudgetGuardPolicyYaml;
}

const DEFAULT_POLICY: BudgetGuardPolicyYaml = {
  version: 1,
  alerts: {
    dailyBudgetAlertRatio: 0.8,
    monthlyPaceRatio: 1,
    dayOverDayRatio: 1.5,
    noConversionsSpendMin: 0,
  },
  autoPause: {
    enabled: false,
    minDailyBudgetRatio: 1.2,
    minDayOverDayRatio: 2,
    safeCategories: [],
  },
  accounts: {},
};

const BUDGET_GUARD_YAML = path.join("workflows", "budget-guard.yaml");

export async function loadBudgetGuardPolicyConfig(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BudgetGuardPolicyConfigState> {
  const [root, accounts] = await Promise.all([
    resolveBudgetGuardRoot(opts),
    opts.prisma.adAccount.findMany({
      where: { workspaceId: opts.workspaceId, active: true },
      orderBy: { key: "asc" },
      select: {
        id: true,
        key: true,
        displayName: true,
        metaAccountId: true,
        currency: true,
      },
    }),
  ]);
  const yamlPath = root ? path.join(root, BUDGET_GUARD_YAML) : null;
  return {
    rootDir: root,
    yamlPath,
    policy: root ? loadBudgetGuardPolicy(root) : null,
    accounts,
  };
}

export async function saveBudgetGuardPolicyConfig(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  input: BudgetGuardPolicyConfigInput;
  actor: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SaveBudgetGuardPolicyConfigResult> {
  const accountKey = opts.input.accountKey?.trim();
  const account = accountKey
    ? await opts.prisma.adAccount.findUnique({
        where: {
          workspaceId_key: {
            workspaceId: opts.workspaceId,
            key: accountKey,
          },
        },
        select: { key: true, displayName: true, currency: true, active: true },
      })
    : await opts.prisma.adAccount.findFirst({
        where: { workspaceId: opts.workspaceId, active: true },
        orderBy: { key: "asc" },
        select: { key: true, displayName: true, currency: true, active: true },
      });
  if (!account || !account.active) {
    throw new Error("有効な広告アカウントが見つかりません。先に account で同期・選択してください。");
  }

  const dailyBudget = readNonNegativeNumber(opts.input.dailyBudget, "dailyBudget");
  const monthlyBudget = readNonNegativeNumber(opts.input.monthlyBudget, "monthlyBudget");
  if (dailyBudget === 0 && monthlyBudget === 0) {
    throw new Error("dailyBudget または monthlyBudget のどちらかを 0 より大きくしてください。");
  }

  const rootDir = await resolveBudgetGuardRoot(opts);
  if (!rootDir) {
    throw new Error("ops repo のローカル checkout が見つかりません。GitHub 連携を確認してください。");
  }

  const current = loadBudgetGuardPolicy(rootDir) ?? DEFAULT_POLICY;
  const next: BudgetGuardPolicyYaml = {
    version: 1,
    alerts: {
      dailyBudgetAlertRatio: readOptionalNonNegativeNumber(
        opts.input.dailyBudgetAlertRatio,
        current.alerts.dailyBudgetAlertRatio ?? 0.8,
        "dailyBudgetAlertRatio"
      ),
      monthlyPaceRatio: readOptionalNonNegativeNumber(
        opts.input.monthlyPaceRatio,
        current.alerts.monthlyPaceRatio ?? 1,
        "monthlyPaceRatio"
      ),
      dayOverDayRatio: readOptionalNonNegativeNumber(
        opts.input.dayOverDayRatio,
        current.alerts.dayOverDayRatio ?? 1.5,
        "dayOverDayRatio"
      ),
      noConversionsSpendMin:
        opts.input.noConversionsSpendMin === null
          ? 0
          : readOptionalNonNegativeNumber(
              opts.input.noConversionsSpendMin,
              current.alerts.noConversionsSpendMin ?? 0,
              "noConversionsSpendMin"
            ),
    },
    autoPause: {
      enabled: opts.input.autoPauseEnabled ?? current.autoPause?.enabled ?? false,
      minDailyBudgetRatio: readOptionalNonNegativeNumber(
        opts.input.autoPauseMinDailyBudgetRatio,
        current.autoPause?.minDailyBudgetRatio ?? 1.2,
        "autoPauseMinDailyBudgetRatio"
      ),
      minDayOverDayRatio: readOptionalNonNegativeNumber(
        opts.input.autoPauseMinDayOverDayRatio,
        current.autoPause?.minDayOverDayRatio ?? 2,
        "autoPauseMinDayOverDayRatio"
      ),
      safeCategories: normalizeSafeCategories(
        opts.input.safeCategories ?? current.autoPause?.safeCategories ?? []
      ),
    },
    accounts: {
      ...current.accounts,
      [account.key]: {
        dailyBudget,
        monthlyBudget,
        currency: (opts.input.currency?.trim() || account.currency || "JPY").toUpperCase(),
      },
    },
  };

  const yamlPath = path.join(rootDir, BUDGET_GUARD_YAML);
  await fs.mkdir(path.dirname(yamlPath), { recursive: true });
  await fs.writeFile(yamlPath, renderBudgetGuardYaml(next), "utf8");
  await opts.prisma.auditLog
    .create({
      data: {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        action: "budget_guard.policy_saved",
        target: "budget_guard_policy",
        ref: BUDGET_GUARD_YAML,
        metadata: {
          accountKey: account.key,
          dailyBudget,
          monthlyBudget,
          currency: next.accounts[account.key]?.currency ?? null,
          autoPauseEnabled: next.autoPause?.enabled ?? false,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);

  return { rootDir, yamlPath, accountKey: account.key, policy: next };
}

async function resolveBudgetGuardRoot(opts: {
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

function readNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} は 0 以上の数値で指定してください。`);
  }
  return value;
}

function readOptionalNonNegativeNumber(
  value: unknown,
  fallback: number,
  field: string
): number {
  if (value === null || value === undefined || value === "") return fallback;
  return readNonNegativeNumber(value, field);
}

function normalizeSafeCategories(value: string[] | string): string[] {
  const raw = Array.isArray(value) ? value : value.split(",");
  return Array.from(
    new Set(raw.map((item) => item.trim()).filter((item) => item.length > 0))
  );
}

function renderBudgetGuardYaml(policy: BudgetGuardPolicyYaml): string {
  const lines = [
    "version: 1",
    "alerts:",
    `  dailyBudgetAlertRatio: ${formatNumber(policy.alerts.dailyBudgetAlertRatio ?? 0)}`,
    `  monthlyPaceRatio: ${formatNumber(policy.alerts.monthlyPaceRatio ?? 0)}`,
    `  dayOverDayRatio: ${formatNumber(policy.alerts.dayOverDayRatio ?? 0)}`,
    `  noConversionsSpendMin: ${formatNumber(policy.alerts.noConversionsSpendMin ?? 0)}`,
    "autoPause:",
    `  enabled: ${policy.autoPause?.enabled ? "true" : "false"}`,
    `  minDailyBudgetRatio: ${formatNumber(policy.autoPause?.minDailyBudgetRatio ?? 0)}`,
    `  minDayOverDayRatio: ${formatNumber(policy.autoPause?.minDayOverDayRatio ?? 0)}`,
    ...(policy.autoPause?.safeCategories?.length
      ? [
          "  safeCategories:",
          ...policy.autoPause.safeCategories.map(
            (category) => `    - ${quoteYaml(category)}`
          ),
        ]
      : ["  safeCategories: []"]),
    "accounts:",
  ];
  const entries = Object.entries(policy.accounts).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  if (entries.length === 0) {
    lines.push("  {}");
  } else {
    for (const [key, value] of entries) {
      lines.push(`  ${quoteYaml(key)}:`);
      lines.push(`    dailyBudget: ${formatNumber(value.dailyBudget)}`);
      lines.push(`    monthlyBudget: ${formatNumber(value.monthlyBudget)}`);
      if (value.currency) lines.push(`    currency: ${quoteYaml(value.currency)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
