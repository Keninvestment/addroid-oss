import test from "node:test";
import assert from "node:assert/strict";
import {
  APPLY_JOB_NAME,
  CRON_PRESETS,
  RUNTIME_QUEUE_NAMES,
  SLACK_COMMAND_JOB_NAME,
  ensureRuntimeQueues,
  registerCronPresets,
} from "../index.js";

class FakeQueueBoss {
  created: string[] = [];
  scheduled: { name: string; cron: string }[] = [];

  async createQueue(name: string): Promise<void> {
    this.created.push(name);
  }

  async schedule(name: string, cron: string): Promise<void> {
    this.scheduled.push({ name, cron });
  }
}

test("RUNTIME_QUEUE_NAMES covers cron presets and async job queues", () => {
  for (const preset of CRON_PRESETS) {
    assert.ok(
      RUNTIME_QUEUE_NAMES.includes(preset.name),
      `${preset.name} must be created before pg-boss schedule/work/send`
    );
  }
  assert.ok(RUNTIME_QUEUE_NAMES.includes(APPLY_JOB_NAME));
  assert.ok(RUNTIME_QUEUE_NAMES.includes(SLACK_COMMAND_JOB_NAME));
});

test("ensureRuntimeQueues creates every runtime queue in stable order", async () => {
  const boss = new FakeQueueBoss();

  await ensureRuntimeQueues(boss);

  assert.deepEqual(boss.created, [...RUNTIME_QUEUE_NAMES]);
});

test("registerCronPresets creates queues before scheduling enabled presets", async () => {
  const boss = new FakeQueueBoss();

  await registerCronPresets(boss, { enableNonEssential: false });

  const expected = CRON_PRESETS.filter((preset) => preset.enabledByDefault);
  assert.deepEqual(
    boss.created,
    expected.map((preset) => preset.name)
  );
  assert.deepEqual(
    boss.scheduled,
    expected.map((preset) => ({ name: preset.name, cron: preset.cron }))
  );
});
