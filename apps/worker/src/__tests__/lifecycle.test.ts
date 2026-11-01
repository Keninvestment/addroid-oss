import test from "node:test";
import assert from "node:assert/strict";
import PgBoss from "pg-boss";
import { prisma } from "@addroid/db";
import { runWorkerProcess } from "../lifecycle.js";
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
    shutdownTimeoutMs: 100,
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
