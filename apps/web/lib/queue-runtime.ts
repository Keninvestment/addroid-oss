// AdDroid OSS — Web 側 pg-boss クライアント (this implementation).
//
// /cron の Web UI 操作 (toggle / schedule / run) は pg-boss schedule と job キューを
// 触る。worker と同じ Postgres 上の pg-boss を共有するため、Web プロセス内で
// `bootPgBoss` を 1 回だけ起動して singleton を返す。
//
// 設計上の注意:
//   - lazy: Web の他のページ (rate-limit が無い `/`, `/setup` 等) ではこのモジュールが
//     呼ばれず、pg-boss 接続も張らない。`/cron` の API ハンドラだけが触る。
//   - 失敗ソフト: 接続に失敗した場合は `null` を返し、Slack のような任意統合と同様に
//     UI 側でハンドラ無効化 + Toast エラーで fail-soft。`Slack and Web UI failures
//     do not block core GitOps polling, Apply, or Cron execution` を守るため、
//     この pg-boss 接続が無くても他のページは描画され続ける。
//   - 重複起動防止: Next.js の dev mode は module を再評価するため `globalThis` に
//     キャッシュする (lib/meta-runtime, lib/github-runtime と同パターン)。

import type PgBoss from "pg-boss";
import { bootPgBoss } from "@addroid/queue";

declare global {
  var __addroidWebQueueBoss__: Promise<PgBoss> | undefined;
}

/**
 * pg-boss の singleton を返す。`DATABASE_URL` 未設定や接続失敗時は throw する。
 * 呼び出し側は try/catch でハンドリングし、Toast + 503 を返してユーザに伝える。
 */
export function getQueueBoss(): Promise<PgBoss> {
  if (globalThis.__addroidWebQueueBoss__) {
    return globalThis.__addroidWebQueueBoss__;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return Promise.reject(
      new Error(
        "DATABASE_URL is not set. /cron actions require pg-boss connectivity."
      )
    );
  }
  const promise = bootPgBoss({ databaseUrl }).catch((err) => {
    // 失敗時は cache をクリアして次回再試行を許す。
    globalThis.__addroidWebQueueBoss__ = undefined;
    throw err;
  });
  globalThis.__addroidWebQueueBoss__ = promise;
  return promise;
}
