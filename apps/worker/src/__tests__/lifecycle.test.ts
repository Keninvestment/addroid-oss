import test from "node:test";
import assert from "node:assert/strict";
import PgBoss from "pg-boss";
import { prisma } from "@addroid/db";
import { runWorkerProcess, workerShutdownTimeoutMs } from "../lifecycle.js";
import { startWorker } from "../runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a connection error during startup exits once and never publishes ready", async () => {
  const startup = deferred<{ stop: () => Promise<void> }>();
  let onFatal!: (error: Error) => void;
  const messages: string[] = [];
  const exits: number[] = [];
  let stops = 0;
  const worker = runWorkerProcess({
    startWorker: async ({ onFatalError }) => { onFatal = onFatalError; return startup.promise; },
    send: (type) => messages.push(type),
    exit: (code) => exits.push(code),
  });
  onFatal(new Error("Connection terminated unexpectedly"));
  onFatal(new Error("second connection failure"));
  await worker.stop();
  startup.resolve({ stop: async () => { stops++; } });
  await worker.started;
  assert.deepEqual(messages, ["fatal"]);
  assert.deepEqual(exits, [1]);
  assert.equal(stops, 1);
});

test("fatal shutdown is bounded even if the database cannot drain", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let onFatal!: (error: Error) => void;
  const messages: string[] = [];
  const exits: number[] = [];
  let stops = 0;
  const worker = runWorkerProcess({
    startWorker: async ({ onFatalError }) => {
      onFatal = onFatalError;
      return { stop: () => { stops++; return new Promise(() => undefined); } };
    },
    send: (type) => messages.push(type),
    exit: (code) => exits.push(code),
    fatalShutdownTimeoutMs: 100,
    heartbeatIntervalMs: 20,
  });
  await worker.started;
  onFatal(new Error("Connection terminated unexpectedly"));
  await Promise.resolve();
  assert.equal(stops, 1);
  t.mock.timers.tick(100);
  await worker.stop();
  assert.deepEqual(messages, ["ready", "fatal"]);
  assert.deepEqual(exits, [1]);
});

test("normal shutdown allows a slow active job to drain beyond the fatal deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const drain = deferred<void>();
  const exits: number[] = [];
  const errors: unknown[] = [];
  const worker = runWorkerProcess({
    startWorker: async () => ({ stop: () => drain.promise }),
    send: () => undefined,
    exit: (code) => exits.push(code),
    logError: (error) => errors.push(error),
  });
  await worker.started;
  const stopped = worker.stop(0);
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  assert.deepEqual(exits, [], "normal drain must not be cut at the fatal 5s deadline");
  drain.resolve();
  await stopped;
  assert.deepEqual(exits, [0]);
  assert.deepEqual(errors, []);
});

test("normal shutdown that exceeds its configured deadline logs a forced drain and exits nonzero", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const exits: number[] = [];
  const errors: unknown[] = [];
  const worker = runWorkerProcess({
    startWorker: async () => ({ stop: () => new Promise(() => undefined) }),
    send: () => undefined,
    exit: (code) => exits.push(code),
    logError: (error) => errors.push(error),
    shutdownTimeoutMs: 40_000,
  });
  await worker.started;
  const stopped = worker.stop();
  t.mock.timers.tick(39_999);
  assert.deepEqual(exits, []);
  t.mock.timers.tick(1);
  await stopped;
  assert.deepEqual(exits, [1]);
  assert.match(String(errors[0]), /shutdown drain forced after 40000ms/);
});

test("normal shutdown deadline reads its environment override and rejects invalid values", () => {
  assert.equal(workerShutdownTimeoutMs({}), 35_000);
  assert.equal(workerShutdownTimeoutMs({ ADDROID_WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }), 60_000);
  for (const value of ["", "0", "-1", "garbage", "1.5", "Infinity"]) {
    assert.equal(workerShutdownTimeoutMs({ ADDROID_WORKER_SHUTDOWN_TIMEOUT_MS: value }), 35_000);
  }
});

test("a fatal error during normal shutdown shortens the remaining drain deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let onFatal!: (error: Error) => void;
  const exits: number[] = [];
  const worker = runWorkerProcess({
    startWorker: async ({ onFatalError }) => {
      onFatal = onFatalError;
      return { stop: () => new Promise(() => undefined) };
    },
    send: () => undefined,
    exit: (code) => exits.push(code),
  });
  await worker.started;
  const stopped = worker.stop();
  t.mock.timers.tick(1_000);
  onFatal(new Error("connection lost during drain"));
  t.mock.timers.tick(4_999);
  assert.deepEqual(exits, []);
  t.mock.timers.tick(1);
  await stopped;
  assert.deepEqual(exits, [1]);
});

test("a rejected startup is reported fatal and exits without readiness", async () => {
  const messages: string[] = [];
  const exits: number[] = [];
  const worker = runWorkerProcess({
    startWorker: async () => { throw new Error("Prisma cannot connect"); },
    send: (type) => messages.push(type),
    exit: (code) => exits.push(code),
  });
  await worker.started;
  assert.deepEqual(messages, ["fatal"]);
  assert.deepEqual(exits, [1]);
});

test("startWorker without a fatal callback exits after the deadline if cleanup hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failure = new Error("Connection terminated unexpectedly");
  const exits: number[] = [];
  t.mock.method(process, "exit", (code?: number | string | null): never => {
    exits.push(Number(code));
    return undefined as never;
  });
  t.mock.method(PgBoss.prototype, "start", async function (this: PgBoss) {
    this.emit("error", failure);
    // A repeated pool error must not schedule another fatal shutdown.
    this.emit("error", failure);
    throw failure;
  });
  t.mock.method(PgBoss.prototype, "stop", async () => undefined);
  const disconnect = t.mock.method(prisma, "$disconnect", () => new Promise<void>(() => undefined));

  const startup = assert.rejects(startWorker({
    databaseUrl: "postgresql://test:test@127.0.0.1:5432/test",
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }), (error) => error === failure);
  // Let the startup rejection reach its bounded cleanup wait before advancing time.
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  assert.equal(disconnect.mock.callCount(), 1);
  t.mock.timers.tick(4_999);
  assert.deepEqual(exits, []);
  t.mock.timers.tick(1);
  await startup;
  assert.deepEqual(exits, [1]);
});
