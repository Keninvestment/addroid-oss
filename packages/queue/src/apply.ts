// AdDroid OSS — execute_apply enqueue ヘルパ。
//
// merged PR を検知した側 (現在は github_poll cron) からこのヘルパを呼び、
// pg-boss に execute_apply を送出すると同時に apply_jobs テーブルにも 1 行残す。
// the current implementation の execute_apply ハンドラは `state=simulated` で完了させる skeleton。

import { APPLY_JOB_NAME } from "./presets.js";
import { buildApplySingletonKey } from "./rate-limit.js";
import type { GithubPollStore } from "./store.js";

/**
 * pg-boss `send` に渡すオプション。本ヘルパは `singletonKey` だけを利用する
 * (他の retention / retry オプションは pg-boss の queue policy 側で扱う)。
 */
export interface ApplyJobSendOptions {
  singletonKey?: string;
}

/**
 * pg-boss への送出を許可する最小限の interface。テストで fake を渡しやすくする。
 *
 * pg-boss `send(name, data, options)` 互換: `options` を渡すと singletonKey を
 * 経由した重複抑止 (pending 中の同 key job がいれば追加 enqueue を弾く) が効く。
 */
export interface ApplyJobBoss {
  send(
    name: string,
    data: unknown,
    options?: ApplyJobSendOptions
  ): Promise<string | null>;
}

export interface EnqueueApplyOptions {
  boss: ApplyJobBoss;
  store: GithubPollStore;
  pullRequestId: string;
  reason?: string;
  /**
   * pg-boss singletonKey (重複 enqueue 抑止)。未指定時は `pullRequestId` から
   * 自動生成され、同一 PR の二重 enqueue を防ぐ。明示的に PR + account 単位で
   * 隔離したい呼び出し側 (例: 同一 PR が複数 account を触り、片方が rate-limit
   * 待機中でももう片方を進めたいケース) は手動で組み立てて渡す。
   */
  singletonKey?: string;
}

export interface EnqueueApplyResult {
  jobId: string | null;
  applyJobId: string;
  /** 実際に pg-boss に渡した singletonKey。観測用 (audit / 監視向け)。 */
  singletonKey: string;
}

export async function enqueueApplyJob(
  opts: EnqueueApplyOptions
): Promise<EnqueueApplyResult> {
  const singletonKey =
    opts.singletonKey ?? buildApplySingletonKey({ pullRequestId: opts.pullRequestId });
  const jobId = await opts.boss.send(
    APPLY_JOB_NAME,
    {
      pullRequestId: opts.pullRequestId,
      reason: opts.reason ?? "merged_pr_detected",
      enqueuedAt: new Date().toISOString(),
    },
    { singletonKey }
  );
  const { id } = await opts.store.recordApplyJob({
    pullRequestId: opts.pullRequestId,
    jobId: jobId ?? "",
    state: "queued",
  });
  return { jobId, applyJobId: id, singletonKey };
}
