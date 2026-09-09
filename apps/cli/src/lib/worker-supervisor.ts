import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AddroidPaths } from "@addroid/config";
import type { UpState } from "./processes.js";

export type WorkerSupervisorPhase =
  | "starting"
  | "ready"
  | "backoff"
  | "exhausted"
  | "stopping"
  | "stopped";

export interface WorkerFailure {
  at: string;
  reason: "exit" | "spawn-error" | "ready-timeout" | "stale-heartbeat";
  message: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkerHealthSnapshot {
  version: 1;
  phase: WorkerSupervisorPhase;
  supervisorPid: number;
  generation: number;
  workerPid: number | null;
  startedAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  readyAt: string | null;
  lastHeartbeatAt: string | null;
  restartAttempts: number;
  maxRestartAttempts: number;
  heartbeatTimeoutMs: number;
  nextRestartAt: string | null;
  lastFailure: WorkerFailure | null;
}

export interface WorkerSupervisorConfig {
  readyTimeoutMs: number;
  heartbeatTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxRestartAttempts: number;
  stableResetMs: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_WORKER_SUPERVISOR_CONFIG: WorkerSupervisorConfig = {
  readyTimeoutMs: 15_000,
  heartbeatTimeoutMs: 20_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxRestartAttempts: 5,
  stableResetMs: 60_000,
  shutdownTimeoutMs: 5_000,
};

export function resolveWorkerSupervisorConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkerSupervisorConfig {
  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const config: WorkerSupervisorConfig = {
    readyTimeoutMs: positiveInt("ADDROID_WORKER_READY_TIMEOUT_MS", DEFAULT_WORKER_SUPERVISOR_CONFIG.readyTimeoutMs),
    heartbeatTimeoutMs: positiveInt("ADDROID_WORKER_HEARTBEAT_TIMEOUT_MS", DEFAULT_WORKER_SUPERVISOR_CONFIG.heartbeatTimeoutMs),
    backoffBaseMs: positiveInt("ADDROID_WORKER_RESTART_BACKOFF_BASE_MS", DEFAULT_WORKER_SUPERVISOR_CONFIG.backoffBaseMs),
    backoffMaxMs: positiveInt("ADDROID_WORKER_RESTART_BACKOFF_MAX_MS", DEFAULT_WORKER_SUPERVISOR_CONFIG.backoffMaxMs),
    maxRestartAttempts: positiveInt("ADDROID_WORKER_MAX_RESTART_ATTEMPTS", DEFAULT_WORKER_SUPERVISOR_CONFIG.maxRestartAttempts),
    stableResetMs: positiveInt("ADDROID_WORKER_STABLE_RESET_MS", DEFAULT_WORKER_SUPERVISOR_CONFIG.stableResetMs),
    shutdownTimeoutMs: positiveInt("ADDROID_WORKER_SHUTDOWN_TIMEOUT_MS", DEFAULT_WORKER_SUPERVISOR_CONFIG.shutdownTimeoutMs),
  };
  if (config.backoffMaxMs < config.backoffBaseMs) config.backoffMaxMs = config.backoffBaseMs;
  config.heartbeatTimeoutMs = Math.max(300, config.heartbeatTimeoutMs);
  return config;
}

export interface WorkerHealthAssessment {
  healthy: boolean;
  state: "ok" | "error" | "skipped";
  message: string;
}

/** Pure evaluator shared by status and doctor. */
export function evaluateWorkerHealth(input: {
  upState: UpState | null;
  snapshot: WorkerHealthSnapshot | null;
  nowMs: number;
  parentAlive: boolean;
  workerAlive: boolean;
  heartbeatTimeoutMs?: number;
}): WorkerHealthAssessment {
  const { upState, snapshot } = input;
  if (!upState) {
    return { healthy: true, state: "skipped", message: "addroid up is not running" };
  }
  if (upState.mode !== "separate-worker") {
    return { healthy: true, state: "skipped", message: "worker runs in the parent process" };
  }
  if (!input.parentAlive) {
    return { healthy: false, state: "error", message: "supervisor parent is stopped" };
  }
  if (!snapshot) {
    return { healthy: false, state: "error", message: "worker health snapshot is missing" };
  }
  if (snapshot.supervisorPid !== upState.parentPid) {
    return { healthy: false, state: "error", message: "worker health snapshot belongs to a stale supervisor" };
  }
  if (snapshot.phase !== "ready") {
    const failure = snapshot.lastFailure ? `; ${snapshot.lastFailure.message}` : "";
    return {
      healthy: false,
      state: "error",
      message: `worker is ${snapshot.phase} (attempts=${snapshot.restartAttempts}/${snapshot.maxRestartAttempts})${failure}`,
    };
  }
  if (!snapshot.workerPid || !input.workerAlive) {
    return { healthy: false, state: "error", message: "worker runtime process is stopped" };
  }
  if (!snapshot.lastHeartbeatAt) {
    return { healthy: false, state: "error", message: "worker heartbeat has not been observed" };
  }
  const heartbeatAge = input.nowMs - Date.parse(snapshot.lastHeartbeatAt);
  const configuredTimeout = input.heartbeatTimeoutMs ?? snapshot.heartbeatTimeoutMs;
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_WORKER_SUPERVISOR_CONFIG.heartbeatTimeoutMs;
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > timeout) {
    return {
      healthy: false,
      state: "error",
      message: `worker heartbeat is stale (age=${Math.max(0, heartbeatAge)}ms, timeout=${timeout}ms)`,
    };
  }
  return {
    healthy: true,
    state: "ok",
    message: `worker runtime ready (pid=${snapshot.workerPid}, generation=${snapshot.generation}, attempts=${snapshot.restartAttempts})`,
  };
}

export async function readWorkerHealth(
  paths: AddroidPaths
): Promise<WorkerHealthSnapshot | null> {
  try {
    return JSON.parse(await fsp.readFile(paths.workerHealthFile, "utf8")) as WorkerHealthSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function writeWorkerHealthAtomic(
  snapshot: WorkerHealthSnapshot,
  paths: AddroidPaths
): Promise<void> {
  await fsp.mkdir(path.dirname(paths.workerHealthFile), { recursive: true });
  const temporary = `${paths.workerHealthFile}.${process.pid}.${snapshot.generation}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(snapshot, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsp.rename(temporary, paths.workerHealthFile);
}

export function restartBackoffMs(
  restartAttempts: number,
  config: WorkerSupervisorConfig
): number {
  return Math.min(
    config.backoffBaseMs * 2 ** Math.max(0, restartAttempts - 1),
    config.backoffMaxMs
  );
}

interface WorkerProtocolMessage {
  type: "ready" | "heartbeat" | "fatal";
  generation: number;
  message?: string;
}

interface TimerApi {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface WorkerSupervisorOptions {
  paths: AddroidPaths;
  repoRoot: string;
  config?: Partial<WorkerSupervisorConfig>;
  now?: () => number;
  timers?: TimerApi;
  spawnChild?: (generation: number) => ChildProcess;
  logger?: { info: (message: string) => void; error: (message: string) => void };
}

export class WorkerSupervisor {
  private readonly config: WorkerSupervisorConfig;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly spawnChild: (generation: number) => ChildProcess;
  private readonly logger: { info: (message: string) => void; error: (message: string) => void };
  private snapshot: WorkerHealthSnapshot;
  private child: ChildProcess | null = null;
  private retiringChild: ChildProcess | null = null;
  private retireDeadlineMs: number | null = null;
  private retireKillSent = false;
  private retireTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private failedGeneration: number | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private shutdownExit: (() => void) | null = null;

  constructor(private readonly options: WorkerSupervisorOptions) {
    this.config = { ...resolveWorkerSupervisorConfig(), ...options.config };
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    this.spawnChild = options.spawnChild ?? ((generation) =>
      spawnWorkerRuntime(options.repoRoot, generation, options.paths, this.config)
    );
    this.logger = options.logger ?? {
      info: (message) => process.stdout.write(`${message}\n`),
      error: (message) => process.stderr.write(`${message}\n`),
    };
    const now = new Date(this.now()).toISOString();
    this.snapshot = {
      version: 1,
      phase: "starting",
      supervisorPid: process.pid,
      generation: 0,
      workerPid: null,
      startedAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      readyAt: null,
      lastHeartbeatAt: null,
      restartAttempts: 0,
      maxRestartAttempts: this.config.maxRestartAttempts,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      nextRestartAt: null,
      lastFailure: null,
    };
  }

  getSnapshot(): WorkerHealthSnapshot {
    return structuredClone(this.snapshot);
  }

  async start(): Promise<void> {
    this.logger.info(
      `[addroid up] worker supervisor config: ready=${this.config.readyTimeoutMs}ms heartbeat=${this.config.heartbeatTimeoutMs}ms backoff=${this.config.backoffBaseMs}..${this.config.backoffMaxMs}ms max_attempts=${this.config.maxRestartAttempts} stable_reset=${this.config.stableResetMs}ms`
    );
    this.spawnGeneration();
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.persistQueue;
  }

  async stop(): Promise<boolean> {
    if (this.snapshot.phase === "stopped") return true;
    this.clearTimers();
    this.setSnapshot({ phase: "stopping", nextRestartAt: null });
    const active = this.child ?? this.retiringChild;
    if (active && active.exitCode === null && active.signalCode === null) {
      let exitedObserved = false;
      const exited = new Promise<void>((resolve) => {
        this.shutdownExit = () => {
          exitedObserved = true;
          resolve();
        };
      });
      try {
        active.kill("SIGTERM");
      } catch {
        this.shutdownExit?.();
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, this.config.shutdownTimeoutMs)),
      ]);
      if (active.exitCode === null && active.signalCode === null) {
        try {
          active.kill("SIGKILL");
        } catch {
          // already gone
        }
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      if (
        !exitedObserved &&
        active.exitCode === null &&
        active.signalCode === null
      ) {
        this.setSnapshot({
          phase: "exhausted",
          workerPid: active.pid ?? null,
          lastFailure: {
            at: new Date(this.now()).toISOString(),
            reason: "exit",
            message: "worker did not exit after SIGKILL during shutdown",
            exitCode: null,
            signal: "SIGKILL",
          },
        });
        this.logger.error("[addroid up] worker did not exit after SIGKILL during shutdown");
        await this.flush();
        return false;
      }
    }
    this.child = null;
    this.retiringChild = null;
    this.retireDeadlineMs = null;
    this.setSnapshot({ phase: "stopped", workerPid: null });
    await this.flush();
    return true;
  }

  private spawnGeneration(): void {
    if (this.snapshot.phase === "stopping" || this.snapshot.phase === "stopped") return;
    if (
      this.retiringChild &&
      this.retiringChild.exitCode === null &&
      this.retiringChild.signalCode === null
    ) {
      const deadline = this.retireDeadlineMs ?? this.now();
      if (this.now() < deadline) {
        const delayMs = Math.max(1, Math.min(50, deadline - this.now()));
        this.backoffTimer = this.timers.setTimeout(() => this.spawnGeneration(), delayMs);
        return;
      }
      if (!this.retireKillSent) {
        try {
          this.retiringChild.kill("SIGKILL");
        } catch {
          // already gone
        }
        this.retireKillSent = true;
        this.retireDeadlineMs = this.now() + 1_000;
        this.backoffTimer = this.timers.setTimeout(() => this.spawnGeneration(), 1_000);
        return;
      }
      this.setSnapshot({
        phase: "exhausted",
        nextRestartAt: null,
        lastFailure: {
          at: new Date(this.now()).toISOString(),
          reason: "exit",
          message: "previous worker generation could not be reaped after SIGKILL",
          exitCode: null,
          signal: "SIGKILL",
        },
      });
      this.logger.error("[addroid up] refusing to overlap worker generations: previous runtime did not exit after SIGKILL");
      return;
    }
    const generation = this.snapshot.generation + 1;
    const at = new Date(this.now()).toISOString();
    this.failedGeneration = null;
    this.setSnapshot({
      phase: "starting",
      generation,
      workerPid: null,
      lastAttemptAt: at,
      readyAt: null,
      lastHeartbeatAt: null,
      nextRestartAt: null,
    });
    let child: ChildProcess;
    try {
      child = this.spawnChild(generation);
    } catch (err) {
      this.failGeneration(generation, "spawn-error", (err as Error).message, null, null);
      return;
    }
    this.child = child;
    this.setSnapshot({ workerPid: child.pid ?? null });
    child.on("message", (raw: unknown) => this.onMessage(generation, raw));
    child.once("error", (err) => {
      try {
        if (child.pid) child.kill("SIGTERM");
      } catch {
        // spawn may have failed before a process existed
      }
      this.failGeneration(generation, "spawn-error", err.message, null, null);
    });
    child.once("exit", (code, signal) => {
      if (this.retiringChild === child) {
        if (this.retireTimer) this.timers.clearTimeout(this.retireTimer);
        this.retireTimer = null;
        this.retiringChild = null;
        this.retireDeadlineMs = null;
        this.retireKillSent = false;
      }
      if (this.snapshot.phase === "stopping" || this.snapshot.phase === "stopped") {
        this.shutdownExit?.();
        return;
      }
      this.failGeneration(
        generation,
        "exit",
        `worker exited (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        code,
        signal
      );
    });
    this.readyTimer = this.timers.setTimeout(() => {
      if (this.snapshot.generation !== generation || this.snapshot.phase !== "starting") return;
      try {
        child.kill("SIGTERM");
      } catch {
        // failure transition remains authoritative
      }
      this.failGeneration(generation, "ready-timeout", `worker did not become ready within ${this.config.readyTimeoutMs}ms`, null, "SIGTERM");
    }, this.config.readyTimeoutMs);
    this.logger.info(`[addroid up] worker generation ${generation} spawned (pid=${child.pid ?? "unknown"})`);
  }

  private onMessage(generation: number, raw: unknown): void {
    if (!isWorkerProtocolMessage(raw) || raw.generation !== generation) return;
    if (generation !== this.snapshot.generation) return;
    if (this.failedGeneration === generation) return;
    if (this.snapshot.phase === "stopping" || this.snapshot.phase === "stopped") return;
    if (raw.type === "fatal") {
      if (this.snapshot.phase !== "starting" && this.snapshot.phase !== "ready") return;
      try {
        this.child?.kill("SIGTERM");
      } catch {
        // child is already exiting
      }
      this.failGeneration(generation, "exit", raw.message ?? "worker reported a fatal error", 1, null);
      return;
    }
    const atMs = this.now();
    const at = new Date(atMs).toISOString();
    if (raw.type === "ready") {
      if (this.snapshot.phase !== "starting") return;
      this.cancelReadyTimer();
      this.setSnapshot({ phase: "ready", readyAt: at, lastHeartbeatAt: at });
      this.scheduleHeartbeatDeadline(generation);
      this.logger.info(`[addroid up] worker generation ${generation} ready`);
      return;
    }
    if (raw.type === "heartbeat" && this.snapshot.phase === "ready") {
      const readyAtMs = this.snapshot.readyAt ? Date.parse(this.snapshot.readyAt) : atMs;
      const stable = atMs - readyAtMs >= this.config.stableResetMs;
      this.setSnapshot({
        lastHeartbeatAt: at,
        ...(stable && this.snapshot.restartAttempts > 0 ? { restartAttempts: 0 } : {}),
      });
      this.scheduleHeartbeatDeadline(generation);
    }
  }

  private scheduleHeartbeatDeadline(generation: number): void {
    if (this.heartbeatTimer) this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.timers.setTimeout(() => {
      if (this.snapshot.generation !== generation || this.snapshot.phase !== "ready") return;
      const active = this.child;
      try {
        active?.kill("SIGTERM");
      } catch {
        // failure transition remains authoritative
      }
      this.failGeneration(
        generation,
        "stale-heartbeat",
        `worker heartbeat exceeded ${this.config.heartbeatTimeoutMs}ms`,
        null,
        "SIGTERM"
      );
    }, this.config.heartbeatTimeoutMs);
  }

  private failGeneration(
    generation: number,
    reason: WorkerFailure["reason"],
    message: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (generation !== this.snapshot.generation || this.failedGeneration === generation) return;
    if (this.snapshot.phase === "stopping" || this.snapshot.phase === "stopped") return;
    this.failedGeneration = generation;
    message = sanitizeFailureMessage(message);
    this.cancelReadyTimer();
    if (this.heartbeatTimer) this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const failedChild = this.child;
    if (
      failedChild &&
      failedChild.exitCode === null &&
      failedChild.signalCode === null &&
      failedChild.pid
    ) {
      this.retiringChild = failedChild;
      this.retireDeadlineMs = this.now() + this.config.shutdownTimeoutMs;
      this.retireKillSent = false;
      if (this.retireTimer) this.timers.clearTimeout(this.retireTimer);
      this.retireTimer = this.timers.setTimeout(() => {
        if (!this.retiringChild) return;
        try {
          this.retiringChild.kill("SIGKILL");
        } catch {
          // already gone
        }
        this.retireKillSent = true;
        this.retireDeadlineMs = this.now() + 1_000;
      }, this.config.shutdownTimeoutMs);
    }
    this.child = null;
    const previousAttempts = this.snapshot.restartAttempts;
    const atMs = this.now();
    const at = new Date(atMs).toISOString();
    const failure: WorkerFailure = { at, reason, message, exitCode, signal };
    this.logger.error(`[addroid up] worker generation ${generation} failed: ${message}`);
    if (previousAttempts >= this.config.maxRestartAttempts) {
      this.setSnapshot({
        phase: "exhausted",
        workerPid: null,
        restartAttempts: previousAttempts,
        nextRestartAt: null,
        lastFailure: failure,
      });
      return;
    }
    const attempts = previousAttempts + 1;
    const delayMs = restartBackoffMs(attempts, this.config);
    this.setSnapshot({
      phase: "backoff",
      workerPid: null,
      restartAttempts: attempts,
      nextRestartAt: new Date(atMs + delayMs).toISOString(),
      lastFailure: failure,
    });
    this.backoffTimer = this.timers.setTimeout(() => this.spawnGeneration(), delayMs);
  }

  private setSnapshot(patch: Partial<WorkerHealthSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const copy = this.getSnapshot();
    this.persistQueue = this.persistQueue
      .then(() => writeWorkerHealthAtomic(copy, this.options.paths))
      .catch((err) => this.logger.error(`[addroid up] worker health write failed: ${(err as Error).message}`));
  }

  private cancelReadyTimer(): void {
    if (this.readyTimer) this.timers.clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearTimers(): void {
    this.cancelReadyTimer();
    if (this.heartbeatTimer) this.timers.clearTimeout(this.heartbeatTimer);
    if (this.backoffTimer) this.timers.clearTimeout(this.backoffTimer);
    if (this.retireTimer) this.timers.clearTimeout(this.retireTimer);
    this.heartbeatTimer = null;
    this.backoffTimer = null;
    this.retireTimer = null;
  }
}

function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/:\/\/([^\s:/]+):([^\s@/]+)@/g, "://[REDACTED]@")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function isWorkerProtocolMessage(raw: unknown): raw is WorkerProtocolMessage {
  if (!raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  return (
    (record.type === "ready" || record.type === "heartbeat" || record.type === "fatal") &&
    Number.isInteger(record.generation)
  );
}

function spawnWorkerRuntime(
  repoRoot: string,
  generation: number,
  paths: AddroidPaths,
  config: WorkerSupervisorConfig
): ChildProcess {
  const logStream = fs.createWriteStream(paths.workerLogFile, { flags: "a" });
  logStream.write(`\n--- [addroid up] worker generation ${generation} started ${new Date().toISOString()} ---\n`);
  const require = createRequire(import.meta.url);
  const tsxLoader = require.resolve("tsx");
  const workerEntry = process.env.ADDROID_TEST_WORKER_ENTRY_PATH?.trim()
    ? path.resolve(process.env.ADDROID_TEST_WORKER_ENTRY_PATH)
    : path.join(repoRoot, "apps/worker/src/index.ts");
  const requestedHeartbeat = Number.parseInt(
    process.env.ADDROID_WORKER_HEARTBEAT_INTERVAL_MS ?? "",
    10
  );
  const heartbeatIntervalMs =
    Number.isInteger(requestedHeartbeat) &&
    requestedHeartbeat >= 100 &&
    requestedHeartbeat <= Math.floor(config.heartbeatTimeoutMs / 2)
      ? requestedHeartbeat
      : Math.max(100, Math.min(5_000, Math.floor(config.heartbeatTimeoutMs / 3)));
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, workerEntry],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADDROID_WORKER_SUPERVISED: "1",
        ADDROID_WORKER_GENERATION: String(generation),
        ADDROID_WORKER_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );
  const tee = (target: NodeJS.WriteStream) => (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    logStream.write(text);
    target.write(prefixLines(text, "[worker] "));
  };
  child.stdout?.on("data", tee(process.stdout));
  child.stderr?.on("data", tee(process.stderr));
  child.once("close", () => logStream.end());
  return child;
}

function prefixLines(text: string, prefix: string): string {
  if (!text) return "";
  const trailing = text.endsWith("\n");
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.map((line) => prefix + line).join("\n") + (trailing ? "\n" : "");
}
