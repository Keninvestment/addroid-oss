// `addroid up` smoke-test 用の worker runtime mock。
//
// 本物の `apps/worker/src/runtime.ts` の代わりに `addroid up` から動的 import
// される (`ADDROID_TEST_WORKER_RUNTIME_PATH` で差し替え)。pg-boss / Prisma /
// Postgres にはまったく到達せず、以下のみを行う:
//
//   - `startWorker(opts)` 呼び出しを `ADDROID_TEST_WORKER_START_MARKER` が指す
//     ファイルに JSON で記録 (`databaseUrl` と `installSignalHandlers` の伝播確認)
//   - 返した `stop()` が呼ばれたら `ADDROID_TEST_WORKER_STOP_MARKER` を書き出す
//     (= SIGTERM 経由で `addroid up` の shutdown が worker.stop を呼んだ証跡)

import fs from "node:fs";

export async function startWorker(opts = {}) {
  const startMarker = process.env.ADDROID_TEST_WORKER_START_MARKER;
  if (startMarker) {
    fs.writeFileSync(
      startMarker,
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          databaseUrl: opts.databaseUrl ?? null,
          installSignalHandlers: opts.installSignalHandlers ?? null,
          pid: process.pid,
        },
        null,
        2
      )
    );
  }
  return {
    async stop() {
      const stopMarker = process.env.ADDROID_TEST_WORKER_STOP_MARKER;
      if (stopMarker) {
        fs.writeFileSync(
          stopMarker,
          JSON.stringify({ stoppedAt: new Date().toISOString() }, null, 2)
        );
      }
    },
  };
}
