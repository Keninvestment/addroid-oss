import type { PrismaClient } from "@addroid/db";
import { Prisma } from "@addroid/db";
import {
  evaluateAutomationRule,
  evaluateAutomationCalibrationDrift,
  buildAutomationRuleCalibration,
  extractSpendThresholdFromConditions,
  resolveExecutionMode,
  resolveDailyReportTimeZone,
  toDateStringInTimeZone,
  type AutomationDriftEvaluation,
  type AutomationMetricSubject,
  type AutomationPlannedAction,
  type AutomationRuleDsl,
  type AutomationRuleCalibration,
  type AutomationBaselineStats,
  type DailyReportInsightsProvider,
  type DailyReportInsightsRow,
  type ExecutionMode,
} from "@addroid/queue";
import {
  loadAutomationRules,
  type AutomationRuleYaml,
} from "@addroid/yaml-schemas";
import type { AutomationCliMutationExecutor } from "./automation-action-executor.js";
import {
  buildCurrentAutomationBaseline,
  readRuleCalibration,
} from "./automation-baseline-runtime.js";
import { resolveOpsRepoLocalDirForWorkspace } from "./ops-repo-local.js";

export interface RunAutomationRulesOnceOptions {
  prisma: PrismaClient;
  workspaceId: string;
  insightsProvider: DailyReportInsightsProvider;
  mutationExecutor: AutomationCliMutationExecutor | null;
  env?: NodeJS.ProcessEnv;
  fallbackTimeZone?: string | null;
}

export interface AutomationRulesRunSummary {
  status: "succeeded" | "policy_missing" | "failed";
  rulesLoaded: number;
  rulesEvaluated: number;
  actionsPlanned: number;
  actionsExecuted: number;
  actionsBlocked: number;
  errors: string[];
}

export async function runAutomationRulesOnce(
  opts: RunAutomationRulesOnceOptions
): Promise<AutomationRulesRunSummary> {
  const env = opts.env ?? process.env;
  const resolved = await resolveOpsRepoLocalDirForWorkspace({
    prisma: opts.prisma as never,
    workspaceId: opts.workspaceId,
    env,
  }).catch(() => ({ rootDir: null }));
  if (!resolved.rootDir) {
    return emptySummary("policy_missing", ["ops repo local checkout is not configured"]);
  }
  const yaml = loadAutomationRules(resolved.rootDir);
  if (!yaml) {
    return emptySummary("policy_missing", ["workflows/automation-rules.yaml is missing or invalid"]);
  }

  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { executionMode: true },
  });
  const accounts = await opts.prisma.adAccount.findMany({
    where: { workspaceId: opts.workspaceId, active: true },
    select: {
      id: true,
      key: true,
      displayName: true,
      modeOverride: true,
      currency: true,
      timezoneName: true,
    },
    orderBy: { key: "asc" },
  });

  let rulesEvaluated = 0;
  let actionsPlanned = 0;
  let actionsExecuted = 0;
  let actionsBlocked = 0;
  const errors: string[] = [];

  for (const rule of yaml.rules) {
    await upsertRuleRow(opts.prisma, opts.workspaceId, rule);
    if (!rule.enabled) continue;
    const dsl = toExecutableDsl(rule);
    if (!dsl) {
      actionsBlocked += await recordUnsupportedRule(opts.prisma, opts.workspaceId, rule);
      continue;
    }
    for (const account of accounts) {
      if (dsl.scope.accounts?.length && !dsl.scope.accounts.includes(account.key)) continue;
      rulesEvaluated += 1;
      const mode = resolveExecutionMode(workspace?.executionMode ?? null, account.modeOverride);
      const run = await opts.prisma.automationRun.create({
        data: {
          workspaceId: opts.workspaceId,
          ruleId: await automationRuleId(opts.prisma, opts.workspaceId, rule.id),
          status: "running",
        },
        select: { id: true },
      });
      try {
        const subjects = await loadSubjectsForRule({
          prisma: opts.prisma,
          account,
          rule: dsl,
          insightsProvider: opts.insightsProvider,
          fallbackTimeZone: opts.fallbackTimeZone,
        });
        const evaluation = evaluateAutomationRule(dsl, subjects);
        const calibration = readRuleCalibration(rule as unknown as Record<string, unknown>);
        const calibrationCheck = await evaluateCalibrationForRuntime({
          prisma: opts.prisma,
          account,
          rule,
          calibration,
          fallbackTimeZone: opts.fallbackTimeZone,
        });
        actionsPlanned += evaluation.plannedActions.length;
        const actionResults = [];
        let actionOrdinal = 0;
        let cumulativeDailyBudgetAffected = 0;
        for (const action of evaluation.plannedActions) {
          actionOrdinal += 1;
          const estimatedDailyBudgetAffected = estimateDailyBudgetAffected(action);
          const cooldownActive = await hasRecentAutomationAction({
            prisma: opts.prisma,
            ruleKey: rule.id,
            action,
            cooldownHours: rule.safety?.cooldownHours ?? calibration?.recommended.cooldownHours ?? null,
          });
          const gate = evaluateRuntimeGate(
            rule,
            action,
            mode,
            Boolean(opts.mutationExecutor),
            actionOrdinal,
            {
              calibration,
              drift: calibrationCheck?.drift ?? null,
              suggestedCalibration: calibrationCheck?.suggestedCalibration ?? null,
              cooldownActive,
              cumulativeDailyBudgetAffected:
                cumulativeDailyBudgetAffected + estimatedDailyBudgetAffected,
            }
          );
          const row = await opts.prisma.automationAction.create({
            data: {
              runId: run.id,
              accountId: action.accountId,
              hierarchyId: action.hierarchyId,
              level: action.level,
              targetKey: action.targetKey,
              actionType: action.actionType,
              payload: {
                ...action.payload,
                observedMetrics: action.observedMetrics,
                reasons: action.reasons,
                gate,
                mode,
                estimatedDailyBudgetAffected,
              } as Prisma.InputJsonValue,
              status: gate.allowed ? "approved" : "blocked",
            },
            select: { id: true },
          });
          if (!gate.allowed) {
            actionsBlocked += 1;
            await opts.prisma.auditLog.create({
              data: {
                workspaceId: opts.workspaceId,
                actor: "cron:automation_rules",
                action: "automation.action.blocked",
                target: `automation_action:${row.id}`,
                ref: rule.id,
                metadata: {
                  accountKey: account.key,
                  target: `${action.level}:${action.targetKey}`,
                  reason: gate.reason,
                  mode,
                  details: gate.details ?? null,
                } as Prisma.InputJsonValue,
              },
            }).catch(() => undefined);
            actionResults.push({
              actionId: row.id,
              status: "blocked",
              reason: gate.reason,
              details: gate.details ?? null,
            });
	            continue;
	          }
          cumulativeDailyBudgetAffected += estimatedDailyBudgetAffected;
          const result = await opts.mutationExecutor!.execute(action);
          const executed = result.status === "success";
          if (executed) actionsExecuted += 1;
          else actionsBlocked += 1;
          await opts.prisma.automationAction.update({
            where: { id: row.id },
            data: {
              status: executed ? "executed" : "failed",
              executedAt: new Date(),
              payload: {
                ...action.payload,
                observedMetrics: action.observedMetrics,
                reasons: action.reasons,
                gate,
                mode,
                estimatedDailyBudgetAffected,
                execution: { status: result.status, message: result.message },
              } as Prisma.InputJsonValue,
            },
          });
          await opts.prisma.auditLog.create({
            data: {
              workspaceId: opts.workspaceId,
              actor: "cron:automation_rules",
              action: executed ? "automation.action.executed" : "automation.action.failed",
              target: `automation_action:${row.id}`,
              ref: rule.id,
              metadata: {
                accountKey: account.key,
                target: `${action.level}:${action.targetKey}`,
                actionType: action.actionType,
                status: result.status,
                message: result.message,
                mode,
              } as Prisma.InputJsonValue,
            },
          }).catch(() => undefined);
          actionResults.push({
            actionId: row.id,
            status: executed ? "executed" : "failed",
            message: result.message,
          });
        }
        await opts.prisma.automationRun.update({
          where: { id: run.id },
          data: {
            status: "succeeded",
            finishedAt: new Date(),
            evaluation: {
              ruleId: rule.id,
              accountKey: account.key,
              matched: evaluation.matched,
              plannedActions: evaluation.plannedActions.length,
              skipped: evaluation.skipped,
              actionResults,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "automation rule failed";
        errors.push(`${rule.id}/${account.key}: ${message}`);
        await opts.prisma.automationRun.update({
          where: { id: run.id },
          data: { status: "failed", finishedAt: new Date(), errorMessage: message },
        }).catch(() => undefined);
      }
    }
  }

  return {
    status: errors.length ? "failed" : "succeeded",
    rulesLoaded: yaml.rules.length,
    rulesEvaluated,
    actionsPlanned,
    actionsExecuted,
    actionsBlocked,
    errors,
  };
}

function emptySummary(
  status: "policy_missing" | "failed",
  errors: string[]
): AutomationRulesRunSummary {
  return {
    status,
    rulesLoaded: 0,
    rulesEvaluated: 0,
    actionsPlanned: 0,
    actionsExecuted: 0,
    actionsBlocked: 0,
    errors,
  };
}

async function upsertRuleRow(
  prisma: PrismaClient,
  workspaceId: string,
  rule: AutomationRuleYaml
): Promise<void> {
  await prisma.automationRule.upsert({
    where: { workspaceId_key: { workspaceId, key: rule.id } },
    update: {
      displayName: rule.id,
      enabled: rule.enabled,
      schedule: rule.schedule ?? "",
      sourceText: typeof rule.sourceText === "string" ? rule.sourceText : null,
      dsl: rule as unknown as Prisma.InputJsonValue,
      safetyMode: normalizeRuleApprovalMode(rule),
    },
    create: {
      workspaceId,
      key: rule.id,
      displayName: rule.id,
      enabled: rule.enabled,
      schedule: rule.schedule ?? "",
      sourceText: typeof rule.sourceText === "string" ? rule.sourceText : null,
      dsl: rule as unknown as Prisma.InputJsonValue,
      safetyMode: normalizeRuleApprovalMode(rule),
      createdBy: "ops-repo",
    },
  });
}

async function automationRuleId(
  prisma: PrismaClient,
  workspaceId: string,
  key: string
): Promise<string> {
  const row = await prisma.automationRule.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
    select: { id: true },
  });
  if (!row) throw new Error(`automation rule ${key} was not synced`);
  return row.id;
}

function toExecutableDsl(rule: AutomationRuleYaml): AutomationRuleDsl | null {
  if (rule.action.type !== "set_status" && rule.action.type !== "adjust_budget") return null;
  return {
    id: rule.id,
    ...(rule.schedule ? { schedule: rule.schedule } : {}),
    scope: {
      level: rule.scope.level,
      ...(rule.scope.accounts ? { accounts: rule.scope.accounts } : {}),
      ...(rule.scope.includePaused !== undefined ? { includePaused: rule.scope.includePaused } : {}),
    },
    window: {
      preset: rule.window.preset ?? "today",
      ...(rule.window.since ? { since: rule.window.since } : {}),
      ...(rule.window.until ? { until: rule.window.until } : {}),
      timezone: rule.window.timezone ?? "account",
    },
    metrics: rule.metrics,
    ...(rule.computed ? { computed: rule.computed } : {}),
    when: rule.when,
    action:
      rule.action.type === "set_status"
        ? {
            type: "set_status",
            status: rule.action.status ?? "PAUSED",
            ...(rule.action.targetLevel ? { targetLevel: rule.action.targetLevel } : {}),
          }
        : {
            type: "adjust_budget",
            operation: rule.action.operation ?? "set_amount",
            ...(rule.action.percent !== undefined ? { percent: rule.action.percent } : {}),
            ...(rule.action.amount !== undefined ? { amount: rule.action.amount } : {}),
            ...(rule.action.targetBudgetLevel
              ? { targetBudgetLevel: rule.action.targetBudgetLevel }
              : {}),
          },
    safety: { ...rule.safety, mode: normalizeRuleApprovalMode(rule) },
  };
}

async function loadSubjectsForRule(input: {
  prisma: PrismaClient;
  account: { id: string; key: string; timezoneName: string | null };
  rule: AutomationRuleDsl;
  insightsProvider: DailyReportInsightsProvider;
  fallbackTimeZone?: string | null;
}): Promise<AutomationMetricSubject[]> {
  const metricDate = toDateStringInTimeZone(
    new Date(),
    resolveDailyReportTimeZone(input.account.timezoneName, input.fallbackTimeZone)
  );
  const insights = await input.insightsProvider.fetchInsights({
    accountKey: input.account.key,
    metricDate,
    includePriorPeriod: false,
    breakdownsPolicy: {
      fetchAccount: input.rule.scope.level === "account",
      fetchCampaign: input.rule.scope.level === "campaign",
      fetchAdset: input.rule.scope.level === "adset",
      fetchAd: input.rule.scope.level === "ad",
      synthesizeAccountFromCampaigns: input.rule.scope.level === "account",
    },
  });
  const rows = insights.current.filter((row) => row.nodeType === input.rule.scope.level);
  const hierarchy = await loadHierarchyIndex(input.prisma, input.account.id, rows);
  return rows.map((row) => toSubject(input.account.id, input.account.key, row, hierarchy));
}

async function loadHierarchyIndex(
  prisma: PrismaClient,
  accountId: string,
  rows: DailyReportInsightsRow[]
): Promise<Map<string, { id: string; externalId: string | null; status: string | null }>> {
  const keys = rows.map((row) => row.nodeKey);
  const nodes = await prisma.adsHierarchyNode.findMany({
    where: {
      accountId,
      nodeKey: { in: keys },
    },
    select: { id: true, nodeType: true, nodeKey: true, externalId: true, status: true },
  });
  return new Map(nodes.map((n) => [`${n.nodeType}:${n.nodeKey}`, n]));
}

function toSubject(
  accountId: string,
  accountKey: string,
  row: DailyReportInsightsRow,
  hierarchy: Map<string, { id: string; externalId: string | null; status: string | null }>
): AutomationMetricSubject {
  const node = hierarchy.get(`${row.nodeType}:${row.nodeKey}`);
  const spend = Number(row.spendMicros) / 1_000_000;
  const cv = row.conversions;
  return {
    accountId,
    accountKey,
    level: row.nodeType,
    targetKey: row.nodeKey,
    hierarchyId: node?.id ?? row.hierarchyId ?? null,
    displayName: row.displayName,
    status: node?.status ?? null,
    metrics: {
      spend,
      cv,
      conversions: cv,
      impressions: row.impressions,
      clicks: row.clicks,
      frequency: row.frequency ?? null,
      cpa: cv > 0 ? spend / cv : null,
    },
  };
}

function evaluateRuntimeGate(
  rule: AutomationRuleYaml,
  action: AutomationPlannedAction,
  mode: ExecutionMode,
  executorConfigured: boolean,
  actionOrdinal: number,
  context: {
    calibration: AutomationRuleCalibration | null;
    drift: AutomationDriftEvaluation | null;
    suggestedCalibration: AutomationRuleCalibration | null;
    cooldownActive: boolean;
    cumulativeDailyBudgetAffected: number;
  }
): { allowed: boolean; reason: string; details?: Record<string, unknown> } {
  if (!executorConfigured) return { allowed: false, reason: "automation mutation executor is not configured" };
  if (mode !== "auto_apply") return { allowed: false, reason: `cron/account mode is ${mode}` };
  if (normalizeRuleApprovalMode(rule) !== "auto_apply") {
    return { allowed: false, reason: "rule approval mode is not auto_apply" };
  }
  if (!context.calibration) {
    return { allowed: false, reason: "approved automation calibration is missing" };
  }
  if (!context.drift?.ok) {
    return {
      allowed: false,
      reason: context.drift?.reason ?? "automation calibration could not be evaluated",
      details: {
        ...(context.drift?.details ?? {}),
        suggestedCalibrationUpdate: context.suggestedCalibration,
      },
    };
  }
  if (context.cooldownActive) {
    return { allowed: false, reason: "cooldown is active for this target" };
  }
  if (action.actionType !== "set_status" || action.payload.status !== "PAUSED") {
    return { allowed: false, reason: "only PAUSED set_status is auto-applicable" };
  }
  const max = rule.limits?.maxActionsPerRun ?? rule.limits?.maxCampaignsPerRun;
  if (max !== undefined && max < 1) return { allowed: false, reason: "rule maxActionsPerRun is invalid" };
  if (max !== undefined && actionOrdinal > max) {
    return { allowed: false, reason: `rule limit exceeded: action ${actionOrdinal} > max ${max}` };
  }
  const maxDailyBudgetAffected =
    rule.limits?.maxDailyBudgetAffected ??
    context.calibration.recommended.maxDailyBudgetAffected;
  if (
    maxDailyBudgetAffected !== undefined &&
    maxDailyBudgetAffected >= 0 &&
    context.cumulativeDailyBudgetAffected > maxDailyBudgetAffected
  ) {
    return {
      allowed: false,
      reason:
        `daily budget affected limit exceeded: ` +
        `${round2(context.cumulativeDailyBudgetAffected)} > ${round2(maxDailyBudgetAffected)}`,
      details: {
        cumulativeDailyBudgetAffected: round2(context.cumulativeDailyBudgetAffected),
        maxDailyBudgetAffected: round2(maxDailyBudgetAffected),
      },
    };
  }
  return { allowed: true, reason: "pre-approved pause policy matched" };
}

async function evaluateCalibrationForRuntime(input: {
  prisma: PrismaClient;
  account: {
    id: string;
    key: string;
    currency?: string | null;
    timezoneName: string | null;
  };
  rule: AutomationRuleYaml;
  calibration: AutomationRuleCalibration | null;
  fallbackTimeZone?: string | null;
}): Promise<{
  drift: AutomationDriftEvaluation;
  current: AutomationBaselineStats | null;
  suggestedCalibration: AutomationRuleCalibration | null;
} | null> {
  if (normalizeRuleApprovalMode(input.rule) !== "auto_apply") return null;
  if (!input.calibration) {
    return {
      drift: {
        ok: false,
        status: "missing",
        reason: "automation calibration is missing",
        details: {},
      },
      current: null,
      suggestedCalibration: null,
    };
  }
  try {
    const current = await buildCurrentAutomationBaseline({
      prisma: input.prisma,
      account: {
        id: input.account.id,
        key: input.account.key,
        currency: input.account.currency ?? null,
        timezoneName: input.account.timezoneName,
      },
      level: input.rule.scope.level,
      lookbackDays: input.calibration.lookbackDays,
      minSampleDays: input.calibration.minSampleDays,
      fallbackTimeZone: input.fallbackTimeZone,
    });
    const drift = evaluateAutomationCalibrationDrift({
      calibration: input.calibration,
      current,
      now: new Date(),
    });
    return {
      drift,
      current,
      suggestedCalibration: drift.ok
        ? null
        : buildAutomationRuleCalibration({
            baseline: current,
            minSampleDays: input.calibration.minSampleDays,
            requested: {
              requestedSpendMin:
                extractSpendThresholdFromConditions(input.rule.when) ??
                input.rule.safety?.minSpend ??
                null,
              requestedMaxActionsPerRun:
                input.rule.limits?.maxActionsPerRun ??
                input.rule.limits?.maxCampaignsPerRun ??
                null,
              requestedMaxDailyBudgetAffected:
                input.rule.limits?.maxDailyBudgetAffected ?? null,
              requestedCooldownHours: input.rule.safety?.cooldownHours ?? null,
            },
            drift: input.calibration.drift,
          }),
    };
  } catch (err) {
    return {
      drift: {
        ok: false,
        status: "missing",
        reason: `automation calibration evaluation failed: ${err instanceof Error ? err.message : "unknown error"}`,
        details: {},
      },
      current: null,
      suggestedCalibration: null,
    };
  }
}

async function hasRecentAutomationAction(input: {
  prisma: PrismaClient;
  ruleKey: string;
  action: AutomationPlannedAction;
  cooldownHours: number | null;
}): Promise<boolean> {
  if (!input.cooldownHours || input.cooldownHours <= 0) return false;
  const since = new Date(Date.now() - input.cooldownHours * 3_600_000);
  const row = await input.prisma.automationAction.findFirst({
    where: {
      accountId: input.action.accountId,
      actionType: input.action.actionType,
      level: input.action.level,
      targetKey: input.action.targetKey,
      status: { in: ["approved", "executed"] },
      createdAt: { gte: since },
      run: { rule: { key: input.ruleKey } },
    },
    select: { id: true },
  });
  return Boolean(row);
}

function estimateDailyBudgetAffected(action: AutomationPlannedAction): number {
  const current = readNumber(action.payload.currentDailyBudget);
  const proposed = readNumber(action.payload.proposedDailyBudget);
  if (current !== null && proposed !== null) return Math.abs(proposed - current);
  if (current !== null) return current;
  const spend = readNumber(action.observedMetrics.spend);
  return spend ?? 0;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function recordUnsupportedRule(
  prisma: PrismaClient,
  workspaceId: string,
  rule: AutomationRuleYaml
): Promise<number> {
  const rowId = await automationRuleId(prisma, workspaceId, rule.id);
  const run = await prisma.automationRun.create({
    data: {
      workspaceId,
      ruleId: rowId,
      status: "skipped",
      finishedAt: new Date(),
      evaluation: {
        ruleId: rule.id,
        actionType: rule.action.type,
        reason: "action is stored as a pre-approved policy candidate but has no direct executor; use PR/apply path",
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.executionLog.create({
    data: {
      workspaceId,
      kind: "cron",
      refType: "automation_run",
      refId: run.id,
      level: "warn",
      message: `automation rule ${rule.id} skipped: unsupported direct executor for ${rule.action.type}`,
    },
  }).catch(() => undefined);
  return 1;
}

function normalizeRuleApprovalMode(rule: AutomationRuleYaml): "report_only" | "proposal" | "auto_apply" {
  const approval = rule.approval?.mode;
  const safety = rule.safety?.mode;
  const raw = approval ?? safety;
  return raw === "auto_apply" || raw === "auto_apply_if_policy_matched" || raw === "auto_merge_if_policy_matched"
    ? "auto_apply"
    : raw === "report_only"
      ? "report_only"
      : "proposal";
}
