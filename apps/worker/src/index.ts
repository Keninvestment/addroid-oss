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

import { startWorker, type WorkerHandle } from "./runtime.js";

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

async function main(): Promise<void> {
  let handle: WorkerHandle | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let stopping = false;

  const stopAndExit = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (heartbeat) clearInterval(heartbeat);
    await handle?.stop().catch((err) => {
      console.error("[worker] shutdown error:", err);
    });
    process.exit(code);
  };

  handle = await startWorker({
    installSignalHandlers: !supervised,
    ...(supervised
      ? {
          onFatalError: (error: Error) => {
            send("fatal", error.message);
            void stopAndExit(1);
          },
        }
      : {}),
  });

  if (supervised) {
    process.on("SIGINT", () => void stopAndExit(0));
    process.on("SIGTERM", () => void stopAndExit(0));
    send("ready");
    heartbeat = setInterval(() => send("heartbeat"), heartbeatIntervalMs);
  }
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
