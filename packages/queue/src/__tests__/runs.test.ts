import test from "node:test";
import assert from "node:assert/strict";
import { failCronRun, finishCronRun, startCronRun } from "../index.js";
import { FakeCronOpsStore } from "./fakes.js";

test("startCronRun + finishCronRun records the cron run lifecycle", async () => {
  const store = new FakeCronOpsStore();
  const handle = await startCronRun(store, {
    scheduleId: "sch-1",
    name: "github_poll",
    jobId: "job-1",
  });
  assert.equal(handle.scheduleName, "github_poll");
  assert.equal(store.starts.length, 1);

  await finishCronRun(store, handle, { ok: true });
  assert.equal(store.finishes.length, 1);
  assert.equal(store.finishes[0]!.cronRunId, handle.cronRunId);
  assert.equal(store.finishes[0]!.scheduleName, "github_poll");
  assert.deepEqual(store.finishes[0]!.output, { ok: true });
  assert.equal(store.scheduleStates.get("github_poll"), "ok");
});

test("failCronRun normalizes errors into a string message and rolls up state to error", async () => {
  const store = new FakeCronOpsStore();
  const handle = await startCronRun(store, {
    scheduleId: null,
    name: "github_poll",
    jobId: "job-2",
  });
  await failCronRun(store, handle, new Error("boom"));
  assert.equal(store.fails.length, 1);
  assert.equal(store.fails[0]!.error, "boom");
  assert.equal(store.scheduleStates.get("github_poll"), "error");

  await failCronRun(store, handle, "string-error");
  assert.equal(store.fails[1]!.error, "string-error");

  await failCronRun(store, handle, { foo: 1 });
  // 最後は JSON.stringify されている
  assert.equal(store.fails[2]!.error, JSON.stringify({ foo: 1 }));
});

test("durationMs is a non-negative integer derived from monotonic time", async () => {
  const store = new FakeCronOpsStore();
  const handle = await startCronRun(store, {
    scheduleId: null,
    name: "github_poll",
    jobId: "job-3",
  });
  await new Promise((r) => setTimeout(r, 5));
  await finishCronRun(store, handle);
  assert.ok(store.finishes[0]!.durationMs >= 0);
});
