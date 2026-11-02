import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { resolveAddroidPaths } from "@addroid/config";
import { checkWorkerRuntime } from "../lib/checks.js";
import { writeUpState } from "../lib/processes.js";
import { writeWorkerHealthAtomic, type WorkerHealthSnapshot } from "../lib/worker-supervisor.js";

it("doctor reports recovered ready generation as healthy and backoff/exhausted as errors", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "addroid-worker-check-"));
  const paths = resolveAddroidPaths({ ADDROID_HOME: home });
  const now = new Date().toISOString();
  try {
    await writeUpState({
      startedAt: now,
      parentPid: process.pid,
      workerPid: 1, // An obsolete pid must not override the supervisor's current generation.
      webUrl: "http://127.0.0.1:1",
      cwd: process.cwd(),
      mode: "separate-worker",
    }, paths);
    const snapshot: WorkerHealthSnapshot = {
      version: 1,
      supervisorPid: process.pid,
      generation: 2,
      phase: "ready",
      workerPid: process.pid,
      startedAt: now,
      updatedAt: now,
      lastAttemptAt: now,
      readyAt: now,
      lastHeartbeatAt: now,
      restartAttempts: 1,
      maxRestartAttempts: 2,
      heartbeatTimeoutMs: 60_000,
      nextRestartAt: null,
      lastFailure: {
        at: now,
        reason: "exit",
        message: "Connection terminated unexpectedly",
        exitCode: 1,
        signal: null,
      },
    };
    await writeWorkerHealthAtomic(snapshot, paths);
    const ready = await checkWorkerRuntime(paths);
    assert.equal(ready.state, "ok");
    assert.match(ready.message, /generation=2/);
    assert.equal(ready.hint, undefined);

    for (const phase of ["backoff", "exhausted"] as const) {
      await writeWorkerHealthAtomic({
        ...snapshot,
        phase,
        workerPid: null,
        restartAttempts: 2,
      }, paths);
      const failure = await checkWorkerRuntime(paths);
      assert.equal(failure.state, "error");
      assert.match(failure.message, new RegExp(`worker is ${phase}`));
      assert.match(failure.message, /attempts=2\/2/);
      assert.match(failure.message, /Connection terminated unexpectedly/);
      assert.match(failure.hint!, /addroid status/);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
