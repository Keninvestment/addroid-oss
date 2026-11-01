import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import { resolveAddroidPaths } from "@addroid/config";
import type { UpState } from "../lib/processes.js";
import { writeUpState } from "../lib/processes.js";
import { checkWorkerRuntime } from "../lib/checks.js";
import { runDown } from "../commands/down.js";
import { runStatus } from "../commands/status.js";
import { finalizeSeparateWorkerState } from "../commands/up.js";
import {
  WorkerSupervisor,
  evaluateWorkerHealth,
  readWorkerHealth,
  restartBackoffMs,
  resolveWorkerSupervisorConfig,
  type WorkerHealthSnapshot,
} from "../lib/worker-supervisor.js";

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

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = null;
  stderr = null;
  stdin = null;
  stdio = [null, null, null, null, null];
  connected = true;
  killed = false;
  killCalls: NodeJS.Signals[] = [];

  constructor(readonly pid: number) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  }

  ready(generation: number): void {
    this.emit("message", { type: "ready", generation });
  }

  heartbeat(generation: number): void {
    this.emit("message", { type: "heartbeat", generation });
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function harness(overrides: {
  maxRestartAttempts?: number;
  stableResetMs?: number;
  shutdownTimeoutMs?: number;
  spawn?: (generation: number) => FakeChild;
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-supervisor-"));
  const paths = resolveAddroidPaths({ ADDROID_HOME: home });
  fs.mkdirSync(paths.runDir, { recursive: true });
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const spawn = overrides.spawn ?? ((generation: number) => new FakeChild(10_000 + generation));
  const supervisor = new WorkerSupervisor({
    paths,
    repoRoot: process.cwd(),
    now: () => clock.nowMs,
    timers: clock.api,
    config: {
      readyTimeoutMs: 100,
      heartbeatTimeoutMs: 200,
      backoffBaseMs: 10,
      backoffMaxMs: 40,
      maxRestartAttempts: overrides.maxRestartAttempts ?? 4,
      stableResetMs: overrides.stableResetMs ?? 500,
      exhaustedRetryMs: 1_000,
      shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 100,
    },
    spawnChild: (generation) => {
      const child = spawn(generation);
      children.push(child);
      return child.asChildProcess();
    },
    logger: { info: () => undefined, error: () => undefined },
  });
  return {
    home,
    paths,
    clock,
    children,
    supervisor,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

describe("worker supervisor", () => {
  it("clears the exhausted fatal generation PID atomically and down rejects stale exhausted PIDs", async () => {
    const h = harness({ maxRestartAttempts: 1 });
    const previousHome = process.env.ADDROID_HOME;
    try {
      await h.supervisor.start();
      h.children[0]!.exit(1);
      h.clock.advance(10);
      const final = h.children[1]!;
      final.emit("message", { type: "fatal", generation: 2, message: "database unavailable" });
      assert.equal(h.supervisor.getSnapshot().workerPid, final.pid);
      final.exit(1);
      await h.supervisor.flush();
      const snapshot = (await readWorkerHealth(h.paths))!;
      assert.equal(snapshot.phase, "exhausted");
      assert.equal(snapshot.workerPid, null);
      assert.equal(fs.readdirSync(h.paths.runDir).some((name) => name.endsWith(".tmp")), false);
      process.env.ADDROID_HOME = h.home;
      await writeUpState({
        parentPid: 9998, workerPid: final.pid, mode: "separate-worker",
        startedAt: snapshot.startedAt, cwd: process.cwd(), webUrl: "http://127.0.0.1:1",
      }, h.paths);
      const signals: number[] = [];
      const run = () => runDown([], {
        isProcessAlive: (pid) => pid === final.pid,
        terminateProcess: (pid) => { signals.push(pid); return true; },
        forceKill: (pid) => { signals.push(pid); },
      });
      await run();
      // Also protect against an older persisted snapshot containing the dead PID.
      await writeUpState({
        parentPid: 9998, mode: "separate-worker", startedAt: snapshot.startedAt,
        cwd: process.cwd(), webUrl: "http://127.0.0.1:1",
      }, h.paths);
      fs.writeFileSync(h.paths.workerHealthFile, JSON.stringify({
        ...snapshot, supervisorPid: 9998, workerPid: final.pid,
      }));
      await run();
      assert.deepEqual(signals, []);
    } finally {
      if (previousHome === undefined) delete process.env.ADDROID_HOME;
      else process.env.ADDROID_HOME = previousHome;
      h.cleanup();
    }
  });

  it("keeps exhausted unhealthy through repeated probes until stable recovery", async () => {
    const h = harness({ maxRestartAttempts: 1, stableResetMs: 150 });
    try {
      await h.supervisor.start();
      h.children[0]!.exit(1);
      h.clock.advance(10);
      h.children[1]!.exit(1);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      h.clock.advance(999);
      assert.equal(h.children.length, 2);
      h.clock.advance(1);
      assert.equal(h.children.length, 3);
      h.children[2]!.exit(1); // another failed slow probe
      h.clock.advance(1_000);
      assert.equal(h.children.length, 4);
      h.children[3]!.ready(4);
      const assessment = () => evaluateWorkerHealth({
        upState: {
          parentPid: process.pid, mode: "separate-worker", cwd: process.cwd(),
          startedAt: h.supervisor.getSnapshot().startedAt, webUrl: "http://127.0.0.1:1",
        },
        snapshot: h.supervisor.getSnapshot(), nowMs: h.clock.nowMs,
        parentAlive: true, workerAlive: true,
      });
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      assert.equal(assessment().healthy, false);
      h.clock.advance(149);
      h.children[3]!.heartbeat(4);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      h.clock.advance(1);
      h.children[3]!.heartbeat(4);
      assert.equal(h.supervisor.getSnapshot().phase, "ready");
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 0);
      assert.equal(assessment().healthy, true);
      await h.supervisor.flush();
      assert.equal((await readWorkerHealth(h.paths))?.phase, "ready");
    } finally { h.cleanup(); }
  });

  it("continues slow probes without overlapping an unreaped generation", async () => {
    const h = harness({ maxRestartAttempts: 1 });
    try {
      await h.supervisor.start();
      h.children[0]!.exit(1);
      h.clock.advance(10);
      h.children[1]!.emit("message", { type: "fatal", generation: 2 });
      h.clock.advance(4_000);
      assert.equal(h.children.length, 2);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      h.children[1]!.exit(1);
      h.clock.advance(1_000);
      assert.equal(h.children.length, 3);
      assert.equal(h.supervisor.getSnapshot().workerPid, h.children[2]!.pid);
    } finally { h.cleanup(); }
  });

  it("cancels exhausted recovery probes on shutdown", async () => {
    const h = harness({ maxRestartAttempts: 1 });
    try {
      await h.supervisor.start();
      h.children[0]!.exit(1);
      h.clock.advance(10);
      h.children[1]!.exit(1);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      await h.supervisor.stop();
      h.clock.advance(10_000);
      assert.equal(h.children.length, 2);
      assert.equal(h.supervisor.getSnapshot().phase, "stopped");
      assert.equal(h.supervisor.getSnapshot().nextRestartAt, null);
    } finally { h.cleanup(); }
  });

  it("gives normal worker drain a longer supervisor deadline", async () => {
    assert.equal(resolveWorkerSupervisorConfig({}).shutdownTimeoutMs, 40_000);
    assert.equal(resolveWorkerSupervisorConfig({ ADDROID_WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }).shutdownTimeoutMs, 65_000);
    assert.equal(resolveWorkerSupervisorConfig({}).exhaustedRetryMs, 300_000);
    assert.equal(resolveWorkerSupervisorConfig({ ADDROID_WORKER_EXHAUSTED_RETRY_MS: "12345" }).exhaustedRetryMs, 12_345);
    const h = harness({ shutdownTimeoutMs: resolveWorkerSupervisorConfig({}).shutdownTimeoutMs });
    try {
      await h.supervisor.start();
      h.children[0]!.ready(1);
      const stopping = h.supervisor.stop();
      h.clock.advance(35_000); // full worker graceful deadline elapsed
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM"]);
      h.children[0]!.exit(0);
      assert.equal(await stopping, true);
    } finally { h.cleanup(); }
  });

  it("restarts a dead runtime after bounded exponential backoff", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      h.children[0]!.ready(1);
      h.children[0]!.exit(17);
      assert.equal(h.supervisor.getSnapshot().phase, "backoff");
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 1);
      assert.equal(
        restartBackoffMs(1, {
          readyTimeoutMs: 100,
          heartbeatTimeoutMs: 200,
          backoffBaseMs: 10,
          backoffMaxMs: 40,
          maxRestartAttempts: 4,
          stableResetMs: 500,
          exhaustedRetryMs: 1_000,
      shutdownTimeoutMs: 100,
        }),
        10
      );
      h.clock.advance(9);
      assert.equal(h.children.length, 1);
      h.clock.advance(1);
      assert.equal(h.children.length, 2);
      assert.equal(h.supervisor.getSnapshot().generation, 2);
    } finally {
      h.cleanup();
    }
  });

  it("treats a live wrapper without a live runtime as unhealthy", () => {
    const now = Date.parse("2026-07-26T00:00:10.000Z");
    const upState: UpState = {
      startedAt: new Date(now - 10_000).toISOString(),
      parentPid: 12,
      workerPid: 13,
      webUrl: "http://127.0.0.1:3000",
      cwd: "/fixture",
      mode: "separate-worker",
    };
    const snapshot = fixtureSnapshot({ workerPid: 13, lastHeartbeatAt: new Date(now).toISOString() });
    const result = evaluateWorkerHealth({
      upState,
      snapshot,
      nowMs: now,
      parentAlive: true,
      workerAlive: false,
    });
    assert.equal(result.state, "error");
    assert.match(result.message, /runtime process is stopped/);
    const legacy = evaluateWorkerHealth({
      upState,
      snapshot: null,
      nowMs: now,
      parentAlive: true,
      workerAlive: true,
    });
    assert.equal(legacy.state, "error");
    assert.match(legacy.message, /snapshot is missing/);
  });

  it("fails ready timeout and stale heartbeat with generation-scoped causes", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      h.clock.advance(100);
      assert.equal(h.supervisor.getSnapshot().lastFailure?.reason, "ready-timeout");
      assert.equal(h.supervisor.getSnapshot().workerPid, h.children[0]!.pid);
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM"]);
      h.children[0]!.exit(null, "SIGTERM");
      h.clock.advance(10);
      h.children[1]!.ready(2);
      h.clock.advance(200);
      assert.equal(h.supervisor.getSnapshot().lastFailure?.reason, "stale-heartbeat");
      assert.deepEqual(h.children[1]!.killCalls, ["SIGTERM"]);
    } finally {
      h.cleanup();
    }
  });

  it("fails closed instead of overlapping when a timed-out generation cannot be reaped", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      h.clock.advance(100); // ready timeout -> SIGTERM
      h.clock.advance(100); // retirement deadline -> SIGKILL
      h.clock.advance(1_000); // post-kill deadline
      assert.equal(h.children.length, 1);
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM", "SIGKILL"]);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      assert.match(h.supervisor.getSnapshot().lastFailure?.message ?? "", /could not be reaped/);
    } finally {
      h.cleanup();
    }
  });

  it("counts spawn failures once, caps backoff, and exhausts at max attempts", async () => {
    let calls = 0;
    const h = harness({
      maxRestartAttempts: 4,
      spawn: () => {
        calls += 1;
        throw new Error(`spawn-${calls}`);
      },
    });
    try {
      await h.supervisor.start();
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 1);
      h.clock.advance(10);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 2);
      h.clock.advance(20);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 3);
      h.clock.advance(40);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 4);
      h.clock.advance(40);
      const state = h.supervisor.getSnapshot();
      assert.equal(state.phase, "exhausted");
      assert.equal(state.restartAttempts, 4);
      assert.equal(state.lastFailure?.message, "spawn-5");
      assert.equal(calls, 5);
      assert.equal(h.clock.pending, 1); // slow recovery continues indefinitely
    } finally {
      h.cleanup();
    }
  });

  it("does not double-count a child error followed by exit", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      h.children[0]!.emit("error", new Error("spawn channel failed"));
      h.children[0]!.exit(1);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 1);
      h.clock.advance(10);
      assert.equal(h.children.length, 2);
    } finally {
      h.cleanup();
    }
  });

  it("resets consecutive attempts only after a stable heartbeat", async () => {
    const h = harness({ stableResetMs: 150 });
    try {
      await h.supervisor.start();
      h.children[0]!.ready(1);
      h.children[0]!.exit(1);
      h.clock.advance(10);
      h.children[1]!.ready(2);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 1);
      h.clock.advance(150);
      h.children[1]!.heartbeat(2);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 0);
      h.children[1]!.exit(1);
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 1);
    } finally {
      h.cleanup();
    }
  });

  it("cancels pending restart during shutdown and ignores late generations", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      const first = h.children[0]!;
      first.ready(1);
      first.exit(1);
      await h.supervisor.stop();
      h.clock.advance(1_000);
      first.ready(1);
      first.heartbeat(1);
      assert.equal(h.children.length, 1);
      assert.equal(h.supervisor.getSnapshot().phase, "stopped");
    } finally {
      h.cleanup();
    }
  });

  it("ignores late messages and exit from an older generation after recovery", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      const first = h.children[0]!;
      first.ready(1);
      first.exit(1);
      h.clock.advance(10);
      const second = h.children[1]!;
      second.ready(2);
      first.ready(1);
      first.heartbeat(1);
      first.emit("exit", 1, null);
      const state = h.supervisor.getSnapshot();
      assert.equal(state.generation, 2);
      assert.equal(state.phase, "ready");
      assert.equal(state.workerPid, second.pid);
      assert.equal(state.restartAttempts, 1);
    } finally {
      h.cleanup();
    }
  });

  it("never resurrects an exhausted current generation from late ready or heartbeat", async () => {
    const h = harness({ maxRestartAttempts: 1 });
    try {
      await h.supervisor.start();
      h.children[0]!.ready(1);
      h.children[0]!.exit(1);
      h.clock.advance(10);
      const finalChild = h.children[1]!;
      finalChild.ready(2);
      finalChild.exit(1);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      finalChild.ready(2);
      finalChild.heartbeat(2);
      const state = h.supervisor.getSnapshot();
      assert.equal(state.phase, "exhausted");
      assert.equal(state.workerPid, null);
      assert.equal(state.restartAttempts, 1);
    } finally {
      h.cleanup();
    }
  });

  it("doctor's pure runtime check reports stale heartbeat as error", async () => {
    const h = harness();
    try {
      const now = h.clock.nowMs;
      await writeUpState(
        {
          startedAt: new Date(now - 1_000).toISOString(),
          parentPid: process.pid,
          webUrl: "http://127.0.0.1:3000",
          cwd: process.cwd(),
          mode: "separate-worker",
        },
        h.paths
      );
      const stale = fixtureSnapshot({
        supervisorPid: process.pid,
        workerPid: process.pid,
        heartbeatTimeoutMs: 10,
        lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(),
      });
      fs.writeFileSync(h.paths.workerHealthFile, JSON.stringify(stale), { mode: 0o600 });
      const result = await checkWorkerRuntime(h.paths);
      assert.equal(result.state, "error");
      assert.match(result.message, /heartbeat is stale/);
    } finally {
      h.cleanup();
    }
  });

  it("status returns nonzero for a live parent with stale worker heartbeat", async () => {
    const h = harness();
    const previousHome = process.env.ADDROID_HOME;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdout = "";
    try {
      process.env.ADDROID_HOME = h.home;
      delete process.env.DATABASE_URL;
      await writeUpState(
        {
          startedAt: new Date(Date.now() - 1_000).toISOString(),
          parentPid: process.pid,
          webUrl: "http://127.0.0.1:1",
          cwd: process.cwd(),
          mode: "separate-worker",
        },
        h.paths
      );
      const stale = fixtureSnapshot({
        supervisorPid: process.pid,
        workerPid: process.pid,
        heartbeatTimeoutMs: 10,
        lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
      });
      fs.writeFileSync(h.paths.workerHealthFile, JSON.stringify(stale), { mode: 0o600 });
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stdout.write;
      assert.equal(await runStatus([], {
        getServiceStatus: async () => ({ platform: "unsupported", installed: false, running: false }),
        canConnectToWeb: async () => false,
      }), 1);
      assert.match(stdout, /worker health\s+: \[error\].*heartbeat is stale/);
    } finally {
      process.stdout.write = originalWrite;
      if (previousHome === undefined) delete process.env.ADDROID_HOME;
      else process.env.ADDROID_HOME = previousHome;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      h.cleanup();
    }
  });

  it("SIGTERM shutdown does not restart when the child exits", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      h.children[0]!.ready(1);
      const stopping = h.supervisor.stop();
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM"]);
      h.children[0]!.exit(0, "SIGTERM");
      await stopping;
      assert.equal(h.supervisor.getSnapshot().phase, "stopped");
      assert.equal(h.supervisor.getSnapshot().restartAttempts, 0);
    } finally {
      h.cleanup();
    }
  });

  it("shutdown while starting cancels ready timeout and ignores the late exit race", async () => {
    const h = harness();
    try {
      await h.supervisor.start();
      const stopping = h.supervisor.stop();
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM"]);
      h.children[0]!.exit(0, "SIGTERM");
      await stopping;
      h.clock.advance(1_000);
      assert.equal(h.children.length, 1);
      assert.equal(h.supervisor.getSnapshot().phase, "stopped");
      assert.equal(h.supervisor.getSnapshot().lastFailure, null);
    } finally {
      h.cleanup();
    }
  });

  it("unkillable shutdown preserves owner state and returns nonzero", async () => {
    const h = harness();
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = "";
    try {
      await h.supervisor.start();
      const initialPid = h.children[0]!.pid;
      await writeUpState(
        {
          startedAt: new Date().toISOString(),
          parentPid: process.pid,
          workerPid: initialPid,
          webUrl: "http://127.0.0.1:3000",
          cwd: process.cwd(),
          mode: "separate-worker",
        },
        h.paths
      );
      let stopSettled = false;
      const stopping = h.supervisor.stop().then((stopped) => {
        stopSettled = true;
        return stopped;
      });
      h.clock.advance(99);
      await Promise.resolve();
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM"]);
      assert.equal(stopSettled, false);
      h.clock.advance(1);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM", "SIGKILL"]);
      h.clock.advance(999);
      await Promise.resolve();
      assert.equal(stopSettled, false);
      h.clock.advance(1);
      const stopped = await stopping;
      assert.equal(stopped, false);
      assert.equal(h.clock.pending, 0);
      assert.deepEqual(h.children[0]!.killCalls, ["SIGTERM", "SIGKILL"]);
      assert.equal(h.supervisor.getSnapshot().phase, "exhausted");
      assert.equal(h.supervisor.getSnapshot().workerPid, initialPid);

      const retainedHealth = fixtureSnapshot({
        supervisorPid: process.pid,
        generation: 2,
        workerPid: process.pid,
        phase: "exhausted",
      });
      fs.writeFileSync(h.paths.workerHealthFile, JSON.stringify(retainedHealth), { mode: 0o600 });

      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stderr.write;
      assert.equal(await finalizeSeparateWorkerState(h.paths, stopped, 0), 1);
      assert.equal(fs.existsSync(h.paths.pidFile), true);
      const retainedState = JSON.parse(fs.readFileSync(h.paths.pidFile, "utf8")) as {
        workerPid?: number;
      };
      assert.equal(retainedState.workerPid, process.pid);
      assert.match(stderr, /preserving pid\/health state/);
    } finally {
      process.stderr.write = originalWrite;
      h.cleanup();
    }
  });

  it("writes an atomic readable snapshot and preserves fixture scheduled-job exactly-once evidence", async () => {
    const h = harness();
    try {
      const completed = new Set<string>();
      const evidence: Array<{ jobId: string; generation: number }> = [];
      const completeFixtureJob = (jobId: string, generation: number) => {
        if (completed.has(jobId)) return;
        completed.add(jobId);
        evidence.push({ jobId, generation });
      };

      await h.supervisor.start();
      h.children[0]!.exit(1); // death before fixture acquisition
      h.clock.advance(10);
      h.children[1]!.ready(2);
      completeFixtureJob("scheduled-fixture-1", 2);
      completeFixtureJob("scheduled-fixture-1", 2); // deterministic duplicate delivery
      await h.supervisor.flush();

      assert.deepEqual(evidence, [{ jobId: "scheduled-fixture-1", generation: 2 }]);
      assert.equal((await readWorkerHealth(h.paths))?.generation, 2);
      assert.equal(fs.readdirSync(h.paths.runDir).some((name) => name.endsWith(".tmp")), false);
    } finally {
      h.cleanup();
    }
  });
});

function fixtureSnapshot(patch: Partial<WorkerHealthSnapshot>): WorkerHealthSnapshot {
  return {
    version: 1,
    phase: "ready",
    supervisorPid: 12,
    generation: 1,
    workerPid: 13,
    startedAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    lastAttemptAt: "2026-07-26T00:00:00.000Z",
    readyAt: "2026-07-26T00:00:00.000Z",
    lastHeartbeatAt: "2026-07-26T00:00:00.000Z",
    restartAttempts: 0,
    maxRestartAttempts: 4,
    heartbeatTimeoutMs: 20_000,
    nextRestartAt: null,
    lastFailure: null,
    ...patch,
  };
}
