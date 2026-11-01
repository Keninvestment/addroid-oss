// `addroid down` — `addroid up` で起動した web/worker を停止する。

import { resolveAddroidPaths } from "@addroid/config";
import { setTimeout as delay } from "node:timers/promises";
import {
  clearUpState,
  isProcessAlive,
  readUpState,
  readProcessIdentity,
  terminateProcess,
} from "../lib/processes.js";
import {
  discardObsoleteWorkerOwnership,
  readWorkerHealth,
  writeWorkerHealthAtomic,
  DEFAULT_WORKER_SUPERVISOR_CONFIG,
} from "../lib/worker-supervisor.js";

const FORCE_STOP_TIMEOUT_MS = 2_000;

interface DownDependencies {
  isProcessAlive: typeof isProcessAlive;
  terminateProcess: (pid: number) => boolean;
  forceKill: (pid: number) => void;
  readProcessIdentity?: typeof readProcessIdentity;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readUpState?: typeof readUpState;
  readWorkerHealth?: typeof readWorkerHealth;
  writeWorkerHealth?: typeof writeWorkerHealthAtomic;
  clearUpState?: typeof clearUpState;
}

export async function runDown(
  args: string[],
  deps: DownDependencies = {
    isProcessAlive,
    terminateProcess,
    forceKill: (pid) => { process.kill(pid, "SIGKILL"); },
  }
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "addroid stop — 起動中の Web UI と自動処理を停止",
        "",
        "Usage:",
        "  addroid stop",
        "",
      ].join("\n")
    );
    return 0;
  }
  const paths = resolveAddroidPaths();
  let state = await (deps.readUpState ?? readUpState)(paths);
  const recordedHealth = !state || state.mode === "separate-worker"
    ? await (deps.readWorkerHealth ?? readWorkerHealth)(paths) : null;
  const health = await discardObsoleteWorkerOwnership(
    recordedHealth, paths, deps.isProcessAlive, deps.readProcessIdentity ?? readProcessIdentity,
    deps.writeWorkerHealth ?? writeWorkerHealthAtomic
  );
  if (!state && health && (health.supervisorPid || health.workerPid)) {
    state = {
      parentPid: health.supervisorPid, parentIdentity: health.supervisorIdentity,
      startedAt: health.startedAt, cwd: "", webUrl: "", mode: "separate-worker",
      shutdownTimeoutMs: health.shutdownTimeoutMs,
    };
  }
  if (!state) {
    process.stdout.write(
      `[addroid down] pid file が見つかりません (${paths.pidFile})。起動中のプロセスはありません。\n`
    );
    return 0;
  }

  // Pruning an obsolete supervisor must not break its recorded worker link.
  const owner = recordedHealth?.supervisorPid === state.parentPid &&
    recordedHealth.supervisorIdentity === state.parentIdentity;
  // An explicitly cleared owner can also come from a previous up preflight;
  // the worker's own identity must still be verified before any signal.
  const clearedOwner = health?.supervisorPid === 0 && health.supervisorIdentity === null;
  const ownedHealth = owner || clearedOwner || (health?.supervisorPid === state.parentPid &&
    health.supervisorIdentity === state.parentIdentity) ? health : null;
  const targets: Array<{ label: string; pid: number; identity: string | null | undefined }> = [];
  if (state.webPid && state.webPid !== state.parentPid) {
    targets.push({ label: "web", pid: state.webPid, identity: state.webIdentity });
  }
  // Ownership survives exhausted/backoff while a recovery probe or retiring child lives.
  if (ownedHealth?.workerPid) {
    targets.push({ label: "worker", pid: ownedHealth.workerPid, identity: ownedHealth.workerIdentity });
  } else if (health?.workerPid) {
    // A broken owner link is not authority to signal or discard a live worker.
    targets.push({ label: "unverified health worker", pid: health.workerPid, identity: null });
  }
  if (!ownedHealth && state.workerPid && state.workerPid !== health?.workerPid) {
    targets.push({ label: "worker", pid: state.workerPid, identity: state.workerIdentity });
  }
  targets.push({ label: "addroid up parent", pid: state.parentPid, identity: state.parentIdentity });
  const identityLookup = deps.readProcessIdentity ?? readProcessIdentity;
  const verified = (target: typeof targets[number]): boolean => {
    if (target.identity && identityLookup(target.pid) === target.identity) return true;
    process.stderr.write(`[addroid down] ${target.label} (pid ${target.pid}) identity mismatch or unverifiable; not signalling.\n`);
    return false;
  };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const persistedTimeout = ownedHealth?.shutdownTimeoutMs ?? state.shutdownTimeoutMs;
  const shutdownTimeoutMs = typeof persistedTimeout === "number" && Number.isFinite(persistedTimeout) && persistedTimeout > 0
    ? persistedTimeout : DEFAULT_WORKER_SUPERVISOR_CONFIG.shutdownTimeoutMs;

  let actedOn = 0;
  const seenPids = new Set<number>();
  const signalledPids = new Set<number>();
  for (const t of targets) {
    if (!t.pid) continue;
    if (seenPids.has(t.pid)) continue;
    seenPids.add(t.pid);
    if (!deps.isProcessAlive(t.pid)) {
      process.stdout.write(`[addroid down] ${t.label} (pid ${t.pid}) は既に停止済み。\n`);
      continue;
    }
    if (!verified(t)) continue;
    if (deps.terminateProcess(t.pid)) {
      actedOn += 1;
      signalledPids.add(t.pid);
      process.stdout.write(`[addroid down] ${t.label} (pid ${t.pid}) に SIGTERM を送信。\n`);
    } else {
      process.stderr.write(
        `[addroid down] ${t.label} (pid ${t.pid}) に SIGTERM を送信できませんでした。\n`
      );
    }
  }

  if (signalledPids.size > 0) {
    // Allow the supervisor to finish the worker drain before forcing the parent.
    await waitForTargetsToStop(signalledPids, shutdownTimeoutMs + 2_000, deps.isProcessAlive, now, sleep);
    const stillAlive = [...signalledPids].filter((pid) => deps.isProcessAlive(pid));
    for (const pid of stillAlive) {
      if (pid === process.pid) continue;
      const target = targets.find((t) => t.pid === pid)!;
      if (!verified(target)) continue;
      try {
        deps.forceKill(pid);
        process.stdout.write(
          `[addroid down] pid ${pid} が終了しないため SIGKILL を送信。\n`
        );
      } catch {
        /* ignore */
      }
    }
    if (stillAlive.length > 0) {
      await waitForTargetsToStop(new Set(stillAlive), FORCE_STOP_TIMEOUT_MS, deps.isProcessAlive, now, sleep);
    }
  }

  // 親プロセスが上 (= addroid up) で稼働中なら、shutdown ハンドラが pid file を消すはず。
  // 親もすでに死んでいたケースのために pid file を念のため掃除する。
  if (![...seenPids].some((pid) => deps.isProcessAlive(pid))) {
    await (deps.clearUpState ?? clearUpState)(paths);
  }

  process.stdout.write(
    `[addroid down] ${actedOn} 件のプロセスへ停止を要求しました。pid file: ${paths.pidFile}\n`
  );
  return 0;
}

async function waitForTargetsToStop(
  pids: Set<number>,
  timeoutMs: number,
  alive: typeof isProcessAlive,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (![...pids].some((pid) => alive(pid))) return;
    await sleep(100);
  }
}
