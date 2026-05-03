// AdDroid OSS — performance_snapshots retention sweeper (Regression fix).
//
// 契約上の保持要件:
//   - 「Raw performance data retention is 90 days」
//   - 「aggregated campaign-or-higher retention is 1 year」
//
// 解釈:
//   - "raw" = `performance_snapshots.raw` JSON 列 (Meta API レスポンスの保管庫)
//     と、"campaign-or-higher" よりも粒度の細かい行 (`nodeType in
//     ('adset', 'ad')`)。これらは 90 日経過後に削除する。
//   - "campaign-or-higher" = `nodeType in ('account', 'campaign')`。これは
//     1 年経過後に削除する。
//
// 設計原則:
//   - Prisma を直接 import しない。`PerformanceSnapshotRetentionStore` を介して
//     呼び出し側 (apps/worker) が Prisma 実装を注入する。テストは in-memory fake
//     で完結する。
//   - 実行は `retention_sweep` cron preset から 1 ティック単位で行う。
//   - 失敗時はその種類だけ failed カウントに計上し、他の種類は続行する
//     (= 1 つの DELETE がエラーになっても残りの保持枠は通す)。
//
// 拡張点:
//   - 将来的に `ai_runs` / `execution_logs` / `audit_logs` の保持期間を契約で
//     決めた場合、本ファイルの store 境界を増やして同じ cron で sweep する。

export interface PerformanceSnapshotRetentionStore {
  /**
   * `raw` JSON が non-null かつ `metricDate < olderThan` の
   * `performance_snapshots` 行について `raw` を NULL に上書きする。
   * 行自体は残す (KPI 数値は集計用に活きる)。
   */
  clearStaleRawJson(olderThan: Date): Promise<{ updated: number }>;

  /**
   * `nodeType in ('adset', 'ad')` かつ `metricDate < olderThan` の
   * `performance_snapshots` 行を削除する。
   */
  deleteStaleGranularSnapshots(olderThan: Date): Promise<{ deleted: number }>;

  /**
   * `nodeType in ('account', 'campaign')` かつ `metricDate < olderThan` の
   * `performance_snapshots` 行を削除する。
   */
  deleteStaleAggregatedSnapshots(olderThan: Date): Promise<{ deleted: number }>;
}

export interface RetentionPolicyDays {
  /**
   * 90 日 (raw column と adset/ad 行の保持上限)。
   * 契約で「Raw performance data retention is 90 days」と定められている。
   */
  rawDays: number;
  /**
   * 365 日 (account/campaign 行の保持上限)。
   * 契約で「aggregated campaign-or-higher retention is 1 year」と定められている。
   */
  aggregateDays: number;
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicyDays> = Object.freeze({
  rawDays: 90,
  aggregateDays: 365,
});

export interface RunPerformanceSnapshotRetentionOptions {
  store: PerformanceSnapshotRetentionStore;
  /** 既定値からの上書き (テスト/将来の契約変更用)。 */
  policy?: Partial<RetentionPolicyDays>;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

export type RetentionSweepStatus = "succeeded" | "partial_failure" | "failed";

export interface RetentionSweepStepResult {
  /** 影響行数。失敗時は 0。 */
  affected: number;
  /** sanitized エラーメッセージ (失敗時のみ非 null)。 */
  error: string | null;
}

export interface RetentionSweepSummary {
  status: RetentionSweepStatus;
  /** policy.rawDays を遡った日時 (UTC, ISO8601)。 */
  rawCutoff: string;
  /** policy.aggregateDays を遡った日時 (UTC, ISO8601)。 */
  aggregateCutoff: string;
  policy: RetentionPolicyDays;
  rawCleared: RetentionSweepStepResult;
  granularDeleted: RetentionSweepStepResult;
  aggregatedDeleted: RetentionSweepStepResult;
}

/**
 * `runPerformanceSnapshotRetentionOnce` — retention_sweep cron handler の純粋
 * オーケストレータ。pg-boss handler は本関数を 1 回呼び、戻り値を
 * `cron_runs.output` + `execution_logs.payload` に書く。
 *
 * 3 ステップを順に試みる:
 *   1. `raw` 列の NULL 化 (90 日超え)
 *   2. adset/ad 行の削除 (90 日超え)
 *   3. account/campaign 行の削除 (365 日超え)
 *
 * いずれかが throw しても残りは続行し、全体ステータスは:
 *   - 全成功         → "succeeded"
 *   - 一部失敗       → "partial_failure"
 *   - 全失敗         → "failed"
 */
export async function runPerformanceSnapshotRetentionOnce(
  opts: RunPerformanceSnapshotRetentionOptions
): Promise<RetentionSweepSummary> {
  const policy: RetentionPolicyDays = {
    rawDays: opts.policy?.rawDays ?? DEFAULT_RETENTION_POLICY.rawDays,
    aggregateDays:
      opts.policy?.aggregateDays ?? DEFAULT_RETENTION_POLICY.aggregateDays,
  };
  if (!Number.isFinite(policy.rawDays) || policy.rawDays <= 0) {
    throw new Error(
      `retention policy.rawDays must be a positive finite number; received ${policy.rawDays}`
    );
  }
  if (!Number.isFinite(policy.aggregateDays) || policy.aggregateDays <= 0) {
    throw new Error(
      `retention policy.aggregateDays must be a positive finite number; received ${policy.aggregateDays}`
    );
  }
  const now = (opts.now ?? (() => new Date()))();
  const rawCutoff = new Date(now.getTime() - policy.rawDays * 86_400_000);
  const aggregateCutoff = new Date(
    now.getTime() - policy.aggregateDays * 86_400_000
  );

  const rawCleared = await runStep(() =>
    opts.store.clearStaleRawJson(rawCutoff).then((r) => r.updated)
  );
  const granularDeleted = await runStep(() =>
    opts.store.deleteStaleGranularSnapshots(rawCutoff).then((r) => r.deleted)
  );
  const aggregatedDeleted = await runStep(() =>
    opts.store
      .deleteStaleAggregatedSnapshots(aggregateCutoff)
      .then((r) => r.deleted)
  );

  const failures = [rawCleared, granularDeleted, aggregatedDeleted].filter(
    (s) => s.error !== null
  ).length;
  const status: RetentionSweepStatus =
    failures === 0
      ? "succeeded"
      : failures === 3
        ? "failed"
        : "partial_failure";

  return {
    status,
    rawCutoff: rawCutoff.toISOString(),
    aggregateCutoff: aggregateCutoff.toISOString(),
    policy,
    rawCleared,
    granularDeleted,
    aggregatedDeleted,
  };
}

async function runStep(
  fn: () => Promise<number>
): Promise<RetentionSweepStepResult> {
  try {
    const affected = await fn();
    return { affected, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { affected: 0, error: message };
  }
}
