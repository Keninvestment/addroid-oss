import type { AutomationLevel } from "./automation-rules.js";

export type AutomationCalibrationMode =
  | "static"
  | "adaptive_with_bounds";

export type AutomationBaselineQuality =
  | "sufficient"
  | "insufficient"
  | "empty";

export interface AutomationBaselineSnapshot {
  nodeType: AutomationLevel;
  nodeKey: string;
  metricDate: string;
  spend: number;
  conversions: number;
  clicks?: number;
  impressions?: number;
}

export interface AutomationBaselineInput {
  level: AutomationLevel;
  accountKeys: string[];
  timezone: string;
  currency?: string | null;
  lookbackDays: number;
  minSampleDays?: number;
  generatedAt: string;
  snapshots: readonly AutomationBaselineSnapshot[];
}

export interface AutomationBaselineStats {
  level: AutomationLevel;
  accountKeys: string[];
  timezone: string;
  currency: string | null;
  lookbackDays: number;
  sampleDays: number;
  rowCount: number;
  entityCount: number;
  spendP50: number;
  spendP75: number;
  spendP90: number;
  zeroCvSpendP50: number;
  zeroCvSpendP75: number;
  zeroCvSpendP90: number;
  dailySpendP50: number;
  dailySpendP75: number;
  dailySpendP90: number;
  quality: AutomationBaselineQuality;
  generatedAt: string;
}

export interface AutomationGuardrailRecommendation {
  spendMin: number;
  maxActionsPerRun: number;
  maxDailyBudgetAffected: number;
  cooldownHours: number;
  reasons: string[];
}

export interface AutomationCalibrationDriftPolicy {
  staleAfterHours: number;
  maxSpendP90ChangeRatio: number;
  maxEntityCountChangeRatio: number;
  action: "block_auto_apply" | "open_pr_and_block_auto_apply";
}

export interface AutomationRuleCalibration {
  mode: AutomationCalibrationMode;
  source: "account_history";
  generatedAt: string;
  timezone: string;
  lookbackDays: number;
  minSampleDays: number;
  quality: AutomationBaselineQuality;
  baseline: AutomationBaselineStats;
  recommended: AutomationGuardrailRecommendation;
  bounds: {
    spendMin: { min: number; max: number };
    maxActionsPerRun: { max: number };
    maxDailyBudgetAffected: { max: number };
  };
  drift: AutomationCalibrationDriftPolicy;
}

export interface AutomationGuardrailInput {
  requestedSpendMin?: number | null;
  requestedMaxActionsPerRun?: number | null;
  requestedMaxDailyBudgetAffected?: number | null;
  requestedCooldownHours?: number | null;
}

export interface AutomationDriftEvaluation {
  ok: boolean;
  status: "fresh" | "stale" | "drifted" | "insufficient_data" | "missing";
  reason: string;
  details: Record<string, number | string | null>;
}

const DEFAULT_MIN_SAMPLE_DAYS = 7;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_STALE_AFTER_HOURS = 168;
const DEFAULT_MAX_SPEND_P90_CHANGE_RATIO = 1.5;
const DEFAULT_MAX_ENTITY_COUNT_CHANGE_RATIO = 1.5;

export function buildAutomationBaselineStats(
  input: AutomationBaselineInput
): AutomationBaselineStats {
  const minSampleDays = input.minSampleDays ?? DEFAULT_MIN_SAMPLE_DAYS;
  const rows = input.snapshots.filter(
    (row) =>
      row.nodeType === input.level &&
      Number.isFinite(row.spend) &&
      row.spend >= 0 &&
      Number.isFinite(row.conversions)
  );
  const dates = new Set(rows.map((row) => row.metricDate));
  const entities = new Set(rows.map((row) => row.nodeKey));
  const spendValues = rows.map((row) => row.spend).filter((v) => v > 0);
  const zeroCvSpendValues = rows
    .filter((row) => row.conversions === 0 && row.spend > 0)
    .map((row) => row.spend);
  const dailyTotals = new Map<string, number>();
  for (const row of rows) {
    dailyTotals.set(row.metricDate, (dailyTotals.get(row.metricDate) ?? 0) + row.spend);
  }
  const dailySpendValues = [...dailyTotals.values()].filter((v) => v > 0);
  const quality: AutomationBaselineQuality =
    rows.length === 0
      ? "empty"
      : dates.size >= minSampleDays
        ? "sufficient"
        : "insufficient";

  return {
    level: input.level,
    accountKeys: [...new Set(input.accountKeys)].sort(),
    timezone: input.timezone,
    currency: input.currency ?? null,
    lookbackDays: input.lookbackDays || DEFAULT_LOOKBACK_DAYS,
    sampleDays: dates.size,
    rowCount: rows.length,
    entityCount: entities.size,
    spendP50: roundCurrency(quantile(spendValues, 0.5)),
    spendP75: roundCurrency(quantile(spendValues, 0.75)),
    spendP90: roundCurrency(quantile(spendValues, 0.9)),
    zeroCvSpendP50: roundCurrency(quantile(zeroCvSpendValues, 0.5)),
    zeroCvSpendP75: roundCurrency(quantile(zeroCvSpendValues, 0.75)),
    zeroCvSpendP90: roundCurrency(quantile(zeroCvSpendValues, 0.9)),
    dailySpendP50: roundCurrency(quantile(dailySpendValues, 0.5)),
    dailySpendP75: roundCurrency(quantile(dailySpendValues, 0.75)),
    dailySpendP90: roundCurrency(quantile(dailySpendValues, 0.9)),
    quality,
    generatedAt: input.generatedAt,
  };
}

export function recommendAutomationGuardrails(
  baseline: AutomationBaselineStats,
  input: AutomationGuardrailInput = {}
): AutomationGuardrailRecommendation {
  const reasons: string[] = [];
  const baselineSpendFloor = Math.max(
    baseline.zeroCvSpendP75,
    baseline.spendP50 * 0.5
  );
  const requestedSpendMin = positiveOrZero(input.requestedSpendMin);
  const spendMin = roundCurrency(Math.max(requestedSpendMin, baselineSpendFloor));
  if (requestedSpendMin > 0) reasons.push(`requested spend minimum ${requestedSpendMin}`);
  if (baseline.zeroCvSpendP75 > 0) {
    reasons.push(`zero-CV spend p75 ${baseline.zeroCvSpendP75}`);
  }
  if (baseline.spendP50 > 0) reasons.push(`spend p50 ${baseline.spendP50}`);

  const entityBasedActionCap = Math.max(1, Math.ceil(baseline.entityCount * 0.1));
  const requestedActionCap = positiveIntegerOrNull(input.requestedMaxActionsPerRun);
  const maxActionsPerRun = requestedActionCap
    ? Math.max(1, Math.min(requestedActionCap, entityBasedActionCap, 3))
    : Math.max(1, Math.min(entityBasedActionCap, 3));

  const baselineImpactCap = baseline.dailySpendP90 > 0
    ? baseline.dailySpendP90 * 1.5
    : spendMin * maxActionsPerRun;
  const requestedImpactCap = positiveOrZero(input.requestedMaxDailyBudgetAffected);
  const maxDailyBudgetAffected = roundCurrency(
    requestedImpactCap > 0
      ? Math.min(requestedImpactCap, baselineImpactCap)
      : baselineImpactCap
  );

  return {
    spendMin,
    maxActionsPerRun,
    maxDailyBudgetAffected,
    cooldownHours: positiveIntegerOrNull(input.requestedCooldownHours) ?? 24,
    reasons,
  };
}

export function buildAutomationRuleCalibration(input: {
  baseline: AutomationBaselineStats;
  requested?: AutomationGuardrailInput;
  minSampleDays?: number;
  drift?: Partial<AutomationCalibrationDriftPolicy>;
}): AutomationRuleCalibration {
  const recommended = recommendAutomationGuardrails(
    input.baseline,
    input.requested
  );
  const drift: AutomationCalibrationDriftPolicy = {
    staleAfterHours:
      input.drift?.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS,
    maxSpendP90ChangeRatio:
      input.drift?.maxSpendP90ChangeRatio ??
      DEFAULT_MAX_SPEND_P90_CHANGE_RATIO,
    maxEntityCountChangeRatio:
      input.drift?.maxEntityCountChangeRatio ??
      DEFAULT_MAX_ENTITY_COUNT_CHANGE_RATIO,
    action: input.drift?.action ?? "open_pr_and_block_auto_apply",
  };
  return {
    mode: "adaptive_with_bounds",
    source: "account_history",
    generatedAt: input.baseline.generatedAt,
    timezone: input.baseline.timezone,
    lookbackDays: input.baseline.lookbackDays,
    minSampleDays: input.minSampleDays ?? DEFAULT_MIN_SAMPLE_DAYS,
    quality: input.baseline.quality,
    baseline: input.baseline,
    recommended,
    bounds: {
      spendMin: {
        min: recommended.spendMin,
        max: roundCurrency(Math.max(recommended.spendMin, input.baseline.zeroCvSpendP90 || recommended.spendMin) * 1.5),
      },
      maxActionsPerRun: { max: recommended.maxActionsPerRun },
      maxDailyBudgetAffected: { max: recommended.maxDailyBudgetAffected },
    },
    drift,
  };
}

export function evaluateAutomationCalibrationDrift(input: {
  calibration: AutomationRuleCalibration | null;
  current: AutomationBaselineStats | null;
  now: Date;
}): AutomationDriftEvaluation {
  if (!input.calibration) {
    return {
      ok: false,
      status: "missing",
      reason: "automation calibration is missing",
      details: {},
    };
  }
  if (!input.current || input.current.quality !== "sufficient") {
    return {
      ok: false,
      status: "insufficient_data",
      reason: "current baseline has insufficient data",
      details: {
        currentQuality: input.current?.quality ?? null,
        sampleDays: input.current?.sampleDays ?? null,
      },
    };
  }
  if (input.calibration.quality !== "sufficient") {
    return {
      ok: false,
      status: "insufficient_data",
      reason: "approved calibration was created with insufficient data",
      details: {
        calibrationQuality: input.calibration.quality,
      },
    };
  }
  const generatedAtMs = Date.parse(input.calibration.generatedAt);
  const ageHours = Number.isFinite(generatedAtMs)
    ? (input.now.getTime() - generatedAtMs) / 3_600_000
    : Number.POSITIVE_INFINITY;
  if (ageHours > input.calibration.drift.staleAfterHours) {
    return {
      ok: false,
      status: "stale",
      reason: `automation calibration is stale (${round2(ageHours)}h old)`,
      details: {
        ageHours: round2(ageHours),
        staleAfterHours: input.calibration.drift.staleAfterHours,
      },
    };
  }
  const spendRatio = ratioOrOne(
    input.current.zeroCvSpendP90 || input.current.spendP90,
    input.calibration.baseline.zeroCvSpendP90 ||
      input.calibration.baseline.spendP90
  );
  if (spendRatio > input.calibration.drift.maxSpendP90ChangeRatio) {
    return {
      ok: false,
      status: "drifted",
      reason: `spend distribution changed ${round2(spendRatio)}x`,
      details: {
        spendRatio: round2(spendRatio),
        maxSpendP90ChangeRatio:
          input.calibration.drift.maxSpendP90ChangeRatio,
      },
    };
  }
  const entityRatio = ratioOrOne(
    input.current.entityCount,
    input.calibration.baseline.entityCount
  );
  if (entityRatio > input.calibration.drift.maxEntityCountChangeRatio) {
    return {
      ok: false,
      status: "drifted",
      reason: `active entity count changed ${round2(entityRatio)}x`,
      details: {
        entityRatio: round2(entityRatio),
        maxEntityCountChangeRatio:
          input.calibration.drift.maxEntityCountChangeRatio,
      },
    };
  }
  return {
    ok: true,
    status: "fresh",
    reason: "automation calibration is fresh",
    details: {
      ageHours: round2(ageHours),
      spendRatio: round2(spendRatio),
      entityRatio: round2(entityRatio),
    },
  };
}

export function parseAutomationRuleCalibration(
  value: unknown
): AutomationRuleCalibration | null {
  if (!isRecord(value)) return null;
  if (value.mode !== "adaptive_with_bounds") return null;
  if (!isRecord(value.baseline) || !isRecord(value.recommended)) return null;
  const generatedAt = readString(value.generatedAt);
  const timezone = readString(value.timezone);
  if (!generatedAt || !timezone) return null;
  return value as unknown as AutomationRuleCalibration;
}

export function extractSpendThresholdFromConditions(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const all = Array.isArray(value.all) ? value.all : [];
  const any = Array.isArray(value.any) ? value.any : [];
  const thresholds = [...all, ...any]
    .filter(isRecord)
    .filter((cond) => cond.metric === "spend")
    .map((cond) => numeric(cond.gte) ?? numeric(cond.gt))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return thresholds.length ? Math.min(...thresholds) : null;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const left = sorted[base] ?? 0;
  const right = sorted[base + 1] ?? left;
  return left + rest * (right - left);
}

function ratioOrOne(current: number, baseline: number): number {
  if (!Number.isFinite(current) || current <= 0) return 1;
  if (!Number.isFinite(baseline) || baseline <= 0) return current > 0 ? Number.POSITIVE_INFINITY : 1;
  return current / baseline;
}

function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}

function positiveOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
