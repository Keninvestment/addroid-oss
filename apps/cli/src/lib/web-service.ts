import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  ensureAddroidPaths,
  resolveWebBinding,
} from "@addroid/config";
import { isProcessAlive, readUpState } from "./processes.js";
import { startAddroidService } from "./service.js";

export interface WebUiStartResult {
  url: string;
  running: boolean;
  started: boolean;
  logFile: string;
  error?: string;
}

export async function ensureWebUiStarted(opts: {
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
} = {}): Promise<WebUiStartResult> {
  const env = opts.env ?? process.env;
  const binding = resolveWebBinding(env);
  const url = `http://${binding.hostname}:${binding.port}`;
  const paths = await ensureAddroidPaths(env);

  if (await isWebUiReachable(binding.hostname, binding.port, 250)) {
    return { url, running: true, started: false, logFile: paths.upLogFile };
  }

  const existing = await readUpState(paths).catch(() => null);
  if (
    existing &&
    (isProcessAlive(existing.parentPid) ||
      isProcessAlive(existing.webPid) ||
      isProcessAlive(existing.workerPid))
  ) {
    return {
      url,
      running: false,
      started: false,
      logFile: paths.upLogFile,
      error:
        existing.webStatus === "failed"
          ? "Web UI startup previously failed"
          : "process is running but Web UI is not reachable yet",
    };
  }

  const started = await startWebUiInBackground(env);
  if (!started.ok) {
    return {
      url,
      running: false,
      started: false,
      logFile: paths.upLogFile,
      error: started.error,
    };
  }

  const running = await waitForWebUi(binding.hostname, binding.port, opts.waitMs ?? 30_000);
  return {
    url,
    running,
    started: true,
    logFile: paths.upLogFile,
    ...(running ? {} : { error: "timed out waiting for Web UI to become reachable" }),
  };
}

export async function isWebUiReachable(
  hostname: string,
  port: number,
  timeoutMs = 500
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForWebUi(
  hostname: string,
  port: number,
  waitMs: number
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isWebUiReachable(hostname, port, 500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startWebUiInBackground(
  env: NodeJS.ProcessEnv
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await startAddroidService();
    return { ok: true };
  } catch {
    // Fall back to the foreground runner as a detached process for dev checkouts
    // where launchd/systemd is not available (for example CI or WSL without systemd).
  }
  const entry = process.argv[1];
  if (!entry) return { ok: false, error: "cannot resolve current addroid entrypoint" };
  const child = spawn(process.execPath, [...process.execArgv, path.resolve(entry), "up"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      ...env,
      ADDROID_AUTOSTART_PARENT_PID: String(process.pid),
    },
    stdio: "ignore",
  });
  child.unref();
  return { ok: true };
}
