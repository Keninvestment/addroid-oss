// `addroid down` — `addroid up` で起動した web/worker を停止する。

import { resolveAddroidPaths } from "@addroid/config";
import { setTimeout as delay } from "node:timers/promises";
import {
  clearUpState,
  isProcessAlive,
  readUpState,
  terminateProcess,
} from "../lib/processes.js";

const GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;

export async function runDown(args: string[]): Promise<number> {
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
  const state = await readUpState(paths);
  if (!state) {
    process.stdout.write(
      `[addroid down] pid file が見つかりません (${paths.pidFile})。起動中のプロセスはありません。\n`
    );
    return 0;
  }

  // shared モードでは web/worker は parent 内で動くので個別の pid は無い。
  // separate-worker モードでも web は parent 内、worker のみ child。
  const targets: Array<{ label: string; pid: number | undefined }> = [];
  if (state.mode === "separate-worker") {
    if (state.webPid && state.webPid !== state.parentPid) {
      targets.push({ label: "web", pid: state.webPid });
    }
    if (state.workerPid) {
      targets.push({ label: "worker", pid: state.workerPid });
    }
  }
  targets.push({ label: "addroid up parent", pid: state.parentPid });

  let actedOn = 0;
  const seenPids = new Set<number>();
  for (const t of targets) {
    if (!t.pid) continue;
    if (seenPids.has(t.pid)) continue;
    seenPids.add(t.pid);
    if (!isProcessAlive(t.pid)) {
      process.stdout.write(`[addroid down] ${t.label} (pid ${t.pid}) は既に停止済み。\n`);
      continue;
    }
    if (terminateProcess(t.pid)) {
      actedOn += 1;
      process.stdout.write(`[addroid down] ${t.label} (pid ${t.pid}) に SIGTERM を送信。\n`);
    } else {
      process.stderr.write(
        `[addroid down] ${t.label} (pid ${t.pid}) に SIGTERM を送信できませんでした。\n`
      );
    }
  }

  if (seenPids.size > 0) {
    await waitForTargetsToStop(seenPids, GRACEFUL_STOP_TIMEOUT_MS);
    const stillAlive = [...seenPids].filter((pid) => isProcessAlive(pid));
    for (const pid of stillAlive) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
        process.stdout.write(
          `[addroid down] pid ${pid} が終了しないため SIGKILL を送信。\n`
        );
      } catch {
        /* ignore */
      }
    }
    if (stillAlive.length > 0) {
      await waitForTargetsToStop(new Set(stillAlive), FORCE_STOP_TIMEOUT_MS);
    }
  }

  // 親プロセスが上 (= addroid up) で稼働中なら、shutdown ハンドラが pid file を消すはず。
  // 親もすでに死んでいたケースのために pid file を念のため掃除する。
  if (![...seenPids].some((pid) => isProcessAlive(pid))) {
    await clearUpState(paths);
  }

  process.stdout.write(
    `[addroid down] ${actedOn} 件のプロセスへ停止を要求しました。pid file: ${paths.pidFile}\n`
  );
  return 0;
}

async function waitForTargetsToStop(
  pids: Set<number>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (![...pids].some((pid) => isProcessAlive(pid))) return;
    await delay(100);
  }
}
