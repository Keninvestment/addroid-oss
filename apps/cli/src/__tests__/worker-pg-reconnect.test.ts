import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { ChildProcess } from "node:child_process";
import { resolveAddroidPaths } from "../../../../packages/config/src/paths.js";
import { attachQueueErrorHandler } from "../../../../packages/queue/src/errors.js";
import { runWorkerProcess } from "../../../worker/src/lifecycle.js";
import { WorkerSupervisor, evaluateWorkerHealth, readWorkerHealth } from "../lib/worker-supervisor.js";

class FakeClock {
  nowMs = Date.parse("2026-07-26T00:00:00.000Z");
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  readonly api = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.nowMs + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      this.timers.delete(timer as unknown as number);
    },
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].callback();
    }
    this.nowMs = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}


// Both the worker process owner and supervisor run their production state
// machines. Only DB, process IPC/exit and elapsed time are doubled.
it("pg-boss connection loss exits controllably, recovers, then exhausts repeated DB failures", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-pg-reconnect-"));
  const paths = resolveAddroidPaths({ ADDROID_HOME: home });
  const clock = new FakeClock();
  let databaseAvailable = true;
  const generations: Array<{
    child: EventEmitter & { pid: number; exitCode: number | null; signalCode: null; kill: () => boolean };
    boss: EventEmitter;
    lifecycle: ReturnType<typeof runWorkerProcess>;
    exits: number[];
    stops: number;
  }> = [];
  const supervisor = new WorkerSupervisor({
    paths, repoRoot: process.cwd(), now: () => clock.nowMs, timers: clock.api,
    config: { readyTimeoutMs: 100, heartbeatTimeoutMs: 200, backoffBaseMs: 10,
      backoffMaxMs: 40, maxRestartAttempts: 2, stableResetMs: 500, shutdownTimeoutMs: 100 },
    logger: { info: () => undefined, error: () => undefined },
    spawnChild: (generation) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 20000 + generation, exitCode: null as number | null, signalCode: null,
        // Let production lifecycle own controlled shutdown and exit.
        kill: () => true,
      });
      const boss = new EventEmitter();
      const state = { child, boss, exits: [] as number[], stops: 0,
        lifecycle: undefined as unknown as ReturnType<typeof runWorkerProcess> };
      state.lifecycle = runWorkerProcess({
        startWorker: async ({ onFatalError }) => {
          attachQueueErrorHandler(boss, onFatalError);
          // A startup DB failure must never publish ready.
          if (!databaseAvailable) {
            boss.emit("error", new Error("Connection terminated unexpectedly"));
            throw new Error("database unavailable");
          }
          return { stop: async () => { state.stops += 1; } };
        },
        send: (type, message) => child.emit("message", { type, generation, message }),
        exit: (code) => { state.exits.push(code); child.exitCode = code; child.emit("exit", code, null); },
      });
      generations.push(state);
      return child as unknown as ChildProcess;
    },
  });
  const settle = async () => {
    // Flush async shutdown/late initialization and atomic snapshot persistence.
    await Promise.all(generations.map((state) => state.lifecycle.started));
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await supervisor.flush();
  };
  const health = () => evaluateWorkerHealth({
    upState: { parentPid: process.pid, mode: "separate-worker", startedAt: new Date(clock.nowMs).toISOString(),
      webUrl: "http://127.0.0.1:3000", cwd: process.cwd() },
    snapshot: supervisor.getSnapshot(), nowMs: clock.nowMs, parentAlive: true,
    workerAlive: generations.at(-1)?.child.exitCode === null,
  });
  try {
    await supervisor.start();
    await settle();
    assert.equal(supervisor.getSnapshot().phase, "ready");
    databaseAvailable = false;
    assert.doesNotThrow(() => generations[0]!.boss.emit("error", new Error("Connection terminated unexpectedly")));
    // Repeated errors during cleanup remain handled and count once.
    generations[0]!.boss.emit("error", new Error("Connection terminated unexpectedly"));
    await settle();
    assert.deepEqual(generations[0]!.exits, [1]);
    assert.equal(generations[0]!.stops, 1);
    assert.equal(supervisor.getSnapshot().phase, "backoff");
    assert.match(supervisor.getSnapshot().lastFailure!.message, /Connection terminated unexpectedly/);
    assert.equal(health().healthy, false);
    clock.advance(9);
    assert.equal(generations.length, 1);
    databaseAvailable = true;
    clock.advance(1);
    await settle();
    assert.equal(generations.length, 2);
    assert.equal(supervisor.getSnapshot().generation, 2);
    assert.equal(supervisor.getSnapshot().phase, "ready");
    assert.equal(health().healthy, true);
    databaseAvailable = false;
    generations[1]!.boss.emit("error", new Error("Connection terminated unexpectedly"));
    await settle();
    assert.equal(supervisor.getSnapshot().phase, "backoff");
    assert.equal(supervisor.getSnapshot().restartAttempts, 2);
    clock.advance(19);
    assert.equal(generations.length, 2);
    clock.advance(1);
    await settle();
    assert.equal(generations.length, 3);
    assert.deepEqual(generations[2]!.exits, [1]);
    assert.equal(supervisor.getSnapshot().phase, "exhausted");
    assert.equal(supervisor.getSnapshot().readyAt, null);
    assert.equal(health().healthy, false);
    assert.match(health().message, /exhausted/);
    assert.equal((await readWorkerHealth(paths))!.phase, "exhausted");
    clock.advance(1000);
    assert.equal(generations.length, 3);
  } finally {
    await Promise.all(generations.map((state) => state.lifecycle.stop()));
    await supervisor.stop();
    await supervisor.flush();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
