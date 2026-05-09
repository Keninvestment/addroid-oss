import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutomationBaselineStats,
  buildAutomationRuleCalibration,
  evaluateAutomationCalibrationDrift,
  recommendAutomationGuardrails,
  type AutomationBaselineSnapshot,
} from "../index.js";

function snapshots(): AutomationBaselineSnapshot[] {
  const out: AutomationBaselineSnapshot[] = [];
  for (let day = 1; day <= 10; day += 1) {
    out.push({
      nodeType: "campaign",
      nodeKey: "cmp_a",
      metricDate: `2026-05-${String(day).padStart(2, "0")}`,
      spend: 10_000 + day * 100,
      conversions: 0,
    });
    out.push({
      nodeType: "campaign",
      nodeKey: "cmp_b",
      metricDate: `2026-05-${String(day).padStart(2, "0")}`,
      spend: 4_000 + day * 100,
      conversions: 2,
    });
  }
  return out;
}

test("recommendAutomationGuardrails raises too-low user spend threshold from account history", () => {
  const baseline = buildAutomationBaselineStats({
    level: "campaign",
    accountKeys: ["act_1"],
    timezone: "Asia/Tokyo",
    currency: "JPY",
    lookbackDays: 30,
    minSampleDays: 7,
    generatedAt: "2026-05-10T00:00:00.000Z",
    snapshots: snapshots(),
  });
  assert.equal(baseline.quality, "sufficient");
  const recommended = recommendAutomationGuardrails(baseline, {
    requestedSpendMin: 5_000,
    requestedMaxActionsPerRun: 10,
  });
  assert.ok(recommended.spendMin > 5_000);
  assert.equal(recommended.maxActionsPerRun, 1);
});

test("evaluateAutomationCalibrationDrift blocks stale approved calibration", () => {
  const baseline = buildAutomationBaselineStats({
    level: "campaign",
    accountKeys: ["act_1"],
    timezone: "Asia/Tokyo",
    lookbackDays: 30,
    minSampleDays: 7,
    generatedAt: "2026-05-01T00:00:00.000Z",
    snapshots: snapshots(),
  });
  const calibration = buildAutomationRuleCalibration({
    baseline,
    minSampleDays: 7,
    requested: { requestedSpendMin: 5_000 },
    drift: { staleAfterHours: 24 },
  });
  const result = evaluateAutomationCalibrationDrift({
    calibration,
    current: baseline,
    now: new Date("2026-05-03T01:00:00.000Z"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "stale");
});

test("evaluateAutomationCalibrationDrift blocks material spend distribution drift", () => {
  const baseline = buildAutomationBaselineStats({
    level: "campaign",
    accountKeys: ["act_1"],
    timezone: "Asia/Tokyo",
    lookbackDays: 30,
    minSampleDays: 7,
    generatedAt: "2026-05-10T00:00:00.000Z",
    snapshots: snapshots(),
  });
  const current = buildAutomationBaselineStats({
    level: "campaign",
    accountKeys: ["act_1"],
    timezone: "Asia/Tokyo",
    lookbackDays: 30,
    minSampleDays: 7,
    generatedAt: "2026-05-10T01:00:00.000Z",
    snapshots: snapshots().map((row) => ({
      ...row,
      spend: row.spend * 3,
    })),
  });
  const calibration = buildAutomationRuleCalibration({
    baseline,
    minSampleDays: 7,
    drift: { maxSpendP90ChangeRatio: 1.5 },
  });
  const result = evaluateAutomationCalibrationDrift({
    calibration,
    current,
    now: new Date("2026-05-10T01:00:00.000Z"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "drifted");
});
