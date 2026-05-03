import test from "node:test";
import assert from "node:assert/strict";
import { CRON_PRESETS, mirrorPresetsToCronSchedules } from "../index.js";
import { FakeCronOpsStore } from "./fakes.js";

test("mirrorPresetsToCronSchedules upserts every preset and returns id map", async () => {
  const store = new FakeCronOpsStore();
  const result = await mirrorPresetsToCronSchedules({ store, workspaceId: "ws-1" });

  assert.equal(store.upserts.length, CRON_PRESETS.length);
  for (const preset of CRON_PRESETS) {
    const row = store.upserts.find((u) => u.name === preset.name);
    assert.ok(row, `${preset.name} should be upserted`);
    assert.equal(row.workspaceId, "ws-1");
    assert.equal(row.cron, preset.cron);
    assert.equal(row.enabled, preset.enabledByDefault);
  }
  assert.deepEqual(
    Object.keys(result.scheduleIdByName).sort(),
    CRON_PRESETS.map((p) => p.name).sort()
  );
});

test("mirrorPresetsToCronSchedules with enableNonEssential=true marks every preset enabled", async () => {
  const store = new FakeCronOpsStore();
  await mirrorPresetsToCronSchedules({
    store,
    workspaceId: "ws-1",
    enableNonEssential: true,
  });
  for (const u of store.upserts) {
    assert.equal(u.enabled, true, `${u.name} should be enabled when enableNonEssential=true`);
  }
});

test("mirrorPresetsToCronSchedules: github_poll is enabled by default but daily_report is not", async () => {
  const store = new FakeCronOpsStore();
  await mirrorPresetsToCronSchedules({ store, workspaceId: "ws-1" });
  const githubPoll = store.upserts.find((u) => u.name === "github_poll");
  const dailyReport = store.upserts.find((u) => u.name === "daily_report");
  assert.equal(githubPoll?.enabled, true);
  assert.equal(dailyReport?.enabled, false);
});
