import type { PrismaClient } from "@addroid/db";
import {
  buildAutomationBaselineStats,
  buildAutomationRuleCalibration,
  extractSpendThresholdFromConditions,
  parseAutomationRuleCalibration,
  type AutomationBaselineStats,
  type AutomationLevel,
  type AutomationRuleCalibration,
} from "@addroid/queue";

export interface AutomationBaselineAccount {
  id: string;
  key: string;
  currency: string | null;
  timezoneName: string | null;
}

export interface BuildCalibrationForRuleOptions {
  prisma: PrismaClient;
  workspaceId: string;
  rule: Record<string, unknown>;
  now?: Date;
  fallbackTimeZone?: string | null;
}

export interface BuildCurrentBaselineOptions {
  prisma: PrismaClient;
  account: AutomationBaselineAccount;
  level: AutomationLevel;
  lookbackDays: number;
  minSampleDays: number;
  now?: Date;
  fallbackTimeZone?: string | null;
}

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MIN_SAMPLE_DAYS = 7;

export async function buildCalibrationForAutomationRule(
  opts: BuildCalibrationForRuleOptions
): Promise<AutomationRuleCalibration | null> {
  const level = readScopeLevel(opts.rule);
  if (!level) return null;
  const accounts = await loadRuleAccounts(opts);
  if (!accounts.length) return null;
  const now = opts.now ?? new Date();
  const timezone = resolveCalibrationTimeZone(accounts, opts.fallbackTimeZone);
  const lookbackDays = readPositiveInteger(
    readNested(opts.rule, ["calibration", "lookbackDays"])
  ) ?? DEFAULT_LOOKBACK_DAYS;
  const minSampleDays = readPositiveInteger(
    readNested(opts.rule, ["calibration", "minSampleDays"])
  ) ?? DEFAULT_MIN_SAMPLE_DAYS;
  const baseline = await buildBaselineForAccounts({
    prisma: opts.prisma,
    accounts,
    level,
    timezone,
    lookbackDays,
    minSampleDays,
    now,
  });
  return buildAutomationRuleCalibration({
    baseline,
    minSampleDays,
    requested: {
      requestedSpendMin:
        extractSpendThresholdFromConditions(opts.rule.when) ??
        readNumber(readNested(opts.rule, ["safety", "minSpend"])),
      requestedMaxActionsPerRun:
        readNumber(readNested(opts.rule, ["limits", "maxActionsPerRun"])) ??
        readNumber(readNested(opts.rule, ["limits", "maxCampaignsPerRun"])),
      requestedMaxDailyBudgetAffected: readNumber(
        readNested(opts.rule, ["limits", "maxDailyBudgetAffected"])
      ),
      requestedCooldownHours: readNumber(
        readNested(opts.rule, ["safety", "cooldownHours"])
      ),
    },
  });
}

export async function buildCurrentAutomationBaseline(
  opts: BuildCurrentBaselineOptions
): Promise<AutomationBaselineStats> {
  const now = opts.now ?? new Date();
  return buildBaselineForAccounts({
    prisma: opts.prisma,
    accounts: [opts.account],
    level: opts.level,
    timezone: opts.account.timezoneName || opts.fallbackTimeZone || "UTC",
    lookbackDays: opts.lookbackDays,
    minSampleDays: opts.minSampleDays,
    now,
  });
}

export function readRuleCalibration(
  rule: Record<string, unknown>
): AutomationRuleCalibration | null {
  return parseAutomationRuleCalibration(rule.calibration);
}

async function buildBaselineForAccounts(opts: {
  prisma: PrismaClient;
  accounts: AutomationBaselineAccount[];
  level: AutomationLevel;
  timezone: string;
  lookbackDays: number;
  minSampleDays: number;
  now: Date;
}): Promise<AutomationBaselineStats> {
  const end = utcDateOnly(opts.now);
  const start = addUtcDays(end, -Math.max(1, opts.lookbackDays) + 1);
  const rows = await opts.prisma.performanceSnapshot.findMany({
    where: {
      accountId: { in: opts.accounts.map((account) => account.id) },
      nodeType: opts.level,
      metricDate: { gte: start, lte: end },
    },
    select: {
      nodeType: true,
      nodeKey: true,
      metricDate: true,
      spendMicros: true,
      conversions: true,
      clicks: true,
      impressions: true,
    },
  });
  return buildAutomationBaselineStats({
    level: opts.level,
    accountKeys: opts.accounts.map((account) => account.key),
    timezone: opts.timezone,
    currency: firstCurrency(opts.accounts),
    lookbackDays: opts.lookbackDays,
    minSampleDays: opts.minSampleDays,
    generatedAt: opts.now.toISOString(),
    snapshots: rows.map((row) => ({
      nodeType: row.nodeType as AutomationLevel,
      nodeKey: row.nodeKey,
      metricDate: toDateString(row.metricDate),
      spend: Number(row.spendMicros) / 1_000_000,
      conversions: row.conversions,
      clicks: row.clicks,
      impressions: row.impressions,
    })),
  });
}

async function loadRuleAccounts(
  opts: BuildCalibrationForRuleOptions
): Promise<AutomationBaselineAccount[]> {
  const requested = readStringArray(readNested(opts.rule, ["scope", "accounts"]));
  return opts.prisma.adAccount.findMany({
    where: {
      workspaceId: opts.workspaceId,
      active: true,
      ...(requested.length ? { key: { in: requested } } : {}),
    },
    select: {
      id: true,
      key: true,
      currency: true,
      timezoneName: true,
    },
    orderBy: { key: "asc" },
  });
}

function resolveCalibrationTimeZone(
  accounts: AutomationBaselineAccount[],
  fallbackTimeZone?: string | null
): string {
  const zones = new Set(
    accounts.map((account) => account.timezoneName).filter(Boolean)
  );
  return zones.size === 1 ? [...zones][0]! : fallbackTimeZone || "account";
}

function firstCurrency(accounts: AutomationBaselineAccount[]): string | null {
  return accounts.find((account) => account.currency)?.currency ?? null;
}

function readScopeLevel(rule: Record<string, unknown>): AutomationLevel | null {
  const level = readNested(rule, ["scope", "level"]);
  return level === "account" ||
    level === "campaign" ||
    level === "adset" ||
    level === "ad"
    ? level
    : null;
}

function utcDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function readNested(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
    : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
