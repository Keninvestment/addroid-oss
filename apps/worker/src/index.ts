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

async function main(): Promise<void> {
  await startWorker({ installSignalHandlers: true });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
