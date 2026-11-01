// AdDroid OSS — pg-boss worker entry (standalone process).
//
// 通常 (= `addroid up` の既定モード) では CLI が `startWorker()` を直接呼んで
// web と worker を 1 プロセスで併走させる。本ファイルが起動されるのは:
//   - `addroid up --separate-worker` で worker 単独子プロセスを spawn したとき
//   - 直接 `npm run dev:worker` / `npm run start --workspace apps/worker` を叩いたとき
//
// ポリシー:
//   - GitHub Webhook は使わない。merged PR は github_poll で検知する。
//   - report / improvement / retention presets are registered by pg-boss cron.
//   - SIGINT/SIGTERM で graceful shutdown。

import { startWorker } from "./runtime.js";
import { runWorkerProcess } from "./lifecycle.js";

const supervised = process.env.ADDROID_WORKER_SUPERVISED === "1";
const generation = Number.parseInt(process.env.ADDROID_WORKER_GENERATION ?? "0", 10);
const heartbeatIntervalMs = Math.max(
  100,
  Number.parseInt(process.env.ADDROID_WORKER_HEARTBEAT_INTERVAL_MS ?? "5000", 10) || 5_000
);

function send(type: "ready" | "heartbeat" | "fatal", message?: string): void {
  if (!supervised || !process.send || !process.connected) return;
  try {
    process.send(
      { type, generation, ...(message ? { message } : {}) },
      () => undefined
    );
  } catch {
    // The supervisor may close IPC while graceful shutdown is in progress.
  }
}

const lifecycle = runWorkerProcess({
  startWorker,
  send,
  exit: (code) => process.exit(code),
  logError: (error) => console.error("[worker] fatal or shutdown error:", error),
  heartbeatIntervalMs,
});
process.on("SIGINT", () => void lifecycle.stop(0));
process.on("SIGTERM", () => void lifecycle.stop(0));
await lifecycle.started;
