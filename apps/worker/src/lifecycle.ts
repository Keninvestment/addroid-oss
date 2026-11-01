// Process ownership is separate from runtime initialization so startup failures,
// signals, and connection loss all follow the same bounded shutdown path.
export interface WorkerProcessHandle { stop: () => Promise<void> }

// pg-boss allows active jobs 30 seconds to finish. Leave room for the
// subsequent Prisma/resource cleanup as well before forcing the process out.
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 35_000;

export function workerShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.ADDROID_WORKER_SHUTDOWN_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
}

export interface WorkerProcessDependencies {
  startWorker: (options: {
    installSignalHandlers: false;
    onFatalError: (error: Error) => void;
  }) => Promise<WorkerProcessHandle>;
  send: (type: "ready" | "heartbeat" | "fatal", message?: string) => void;
  exit: (code: number) => void;
  logError?: (error: unknown) => void;
  heartbeatIntervalMs?: number;
  shutdownTimeoutMs?: number;
  fatalShutdownTimeoutMs?: number;
}

export function runWorkerProcess(deps: WorkerProcessDependencies): {
  started: Promise<void>;
  stop: (code?: number) => Promise<void>;
} {
  let handle: WorkerProcessHandle | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  let exitCode = 0;
  let expediteFatalDrain: (() => void) | undefined;

  const stop = (code = 0): Promise<void> => {
    // A fatal error received during graceful shutdown must still exit nonzero.
    const becameFatal = exitCode === 0 && code > 0;
    exitCode = Math.max(exitCode, code);
    if (stopping) {
      if (becameFatal) expediteFatalDrain?.();
      return stopping;
    }
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    stopping = (async () => {
      const timeouts: ReturnType<typeof setTimeout>[] = [];
      try {
        await Promise.race([
          Promise.resolve().then(() => handle?.stop()).catch((error) => {
            exitCode = Math.max(exitCode, 1);
            deps.logError?.(error);
          }),
          new Promise<void>((resolve) => {
            const armDeadline = (deadlineMs: number): void => {
              timeouts.push(setTimeout(() => {
                for (const timeout of timeouts) clearTimeout(timeout);
                exitCode = Math.max(exitCode, 1);
                deps.logError?.(new Error(`[worker] shutdown drain forced after ${deadlineMs}ms`));
                resolve();
              }, deadlineMs));
            };
            // Keep the original deadline too: late fatal errors must never
            // extend an already nearly-finished graceful shutdown budget.
            expediteFatalDrain = () => armDeadline(deps.fatalShutdownTimeoutMs ?? 5_000);
            armDeadline(code === 0
              ? deps.shutdownTimeoutMs ?? workerShutdownTimeoutMs()
              : deps.fatalShutdownTimeoutMs ?? 5_000);
          }),
        ]);
      } finally {
        for (const timeout of timeouts) clearTimeout(timeout);
        expediteFatalDrain = undefined;
        deps.exit(exitCode);
      }
    })();
    return stopping;
  };
  const fatal = (error: Error): void => {
    if (!stopped) deps.send("fatal", error.message);
    void stop(1);
  };
  const started = (async () => {
    try {
      handle = await deps.startWorker({ installSignalHandlers: false, onFatalError: fatal });
      if (stopped) {
        // Initialization may finish after a fatal event or signal. Never publish
        // readiness, and consume a late cleanup rejection if exit is test-doubled.
        void handle.stop().catch(deps.logError ?? (() => undefined));
        return;
      }
      deps.send("ready");
      heartbeat = setInterval(() => deps.send("heartbeat"), deps.heartbeatIntervalMs ?? 5_000);
    } catch (error) {
      deps.logError?.(error);
      fatal(error instanceof Error ? error : new Error(String(error)));
      await stopping;
    }
  })();
  return { started, stop };
}
