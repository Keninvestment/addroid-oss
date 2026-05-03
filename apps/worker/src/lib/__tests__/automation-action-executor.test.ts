import test from "node:test";
import assert from "node:assert/strict";
import {
  AutomationCliMutationExecutor,
  buildAutomationCliArgs,
  type AutomationTargetResolver,
} from "../automation-action-executor.js";
import type { AutomationPlannedAction } from "@addroid/queue";

const PAUSE_ACTION: AutomationPlannedAction = {
  ruleId: "rule-1",
  accountId: "acc-db-1",
  accountKey: "primary",
  level: "campaign",
  targetKey: "cmp_1",
  hierarchyId: "h-1",
  actionType: "set_status",
  payload: { status: "PAUSED" },
  reasons: ["spend matched"],
  observedMetrics: { spend: 6000, cv: 0 },
  safetyMode: "proposal",
};

test("buildAutomationCliArgs maps set_status to campaign update", () => {
  assert.deepEqual(buildAutomationCliArgs(PAUSE_ACTION, "1200"), [
    "ads",
    "campaign",
    "update",
    "1200",
    "--status",
    "PAUSED",
    "--no-input",
    "--force",
  ]);
});

test("buildAutomationCliArgs maps budget adjustment to update changes", () => {
  const action: AutomationPlannedAction = {
    ...PAUSE_ACTION,
    level: "adset",
    actionType: "adjust_budget",
    payload: { proposedDailyBudget: 12000 },
  };
  assert.deepEqual(buildAutomationCliArgs(action, "2200"), [
    "ads",
    "adset",
    "update",
    "2200",
    "--changes",
    JSON.stringify({ daily_budget: 12000 }),
    "--no-input",
    "--force",
  ]);
});

test("AutomationCliMutationExecutor resolves external id before running CLI", async () => {
  const calls: unknown[] = [];
  const resolver: AutomationTargetResolver = {
    async resolveExternalId(input) {
      assert.equal(input.hierarchyId, "h-1");
      return "1200";
    },
  };
  const executor = new AutomationCliMutationExecutor({
    resolver,
    runner: {
      async run(invocation) {
        calls.push(invocation);
        return {
          exitCode: 0,
          signal: null,
          exitClass: "success",
          stdout: "{}",
          stderr: "",
          sanitizedCommand: "meta ads campaign update",
          sanitizedArgs: invocation.args,
          throttleHeaders: null,
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(0).toISOString(),
          timedOut: false,
          accountKey: invocation.accountKey,
          binary: "meta",
          recommendedAction: {
            kind: "none",
            retry: false,
            notify: "none",
            logLevel: "info",
            reason: "success",
          },
        };
      },
    },
  });
  const result = await executor.execute(PAUSE_ACTION);
  assert.equal(result.status, "success");
  assert.equal(calls.length, 1);
});
