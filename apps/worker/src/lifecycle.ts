// Process ownership is separate from runtime initialization so startup failures,
// signals, and connection loss all follow the same bounded shutdown path.
export interface WorkerProcessHandle { stop: () => Promise<void> }

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

  const stop = (code = 0): Promise<void> => {
    // A fatal error received during graceful shutdown must still exit nonzero.
    exitCode = Math.max(exitCode, code);
    if (stopping) return stopping;
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    stopping = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => handle?.stop()).catch(deps.logError ?? (() => undefined)),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, deps.shutdownTimeoutMs ?? 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
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
