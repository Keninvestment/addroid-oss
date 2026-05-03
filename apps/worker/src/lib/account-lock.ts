// AdDroid OSS — Postgres-backed cross-process ad_account ロック実装
//.
//
// `@addroid/queue` の `AdAccountLockProvider` を満たす実装で、`pg_advisory_xact_lock`
// を使って web (`/api/campaigns/[id]/activate`) / worker (execute_apply) /
// CLI (`addroid activate`) の 3 経路を跨いで同一 ad_account の Meta CLI 実行を
// 直列化する。
//
// 設計:
//   - lockKey (`buildAdAccountLockKey({ workspaceId, accountKey })`) を SHA-256 で
//     8 バイトに切り詰め、signed BigInt として `pg_advisory_xact_lock` に渡す。
//     Postgres 側は BIGINT keyspace で 1 並行を強制するため、別経路でも同一
//     (workspaceId, accountKey) からは同じ key に解決され衝突しない。
//   - acquire は `prisma.$transaction(async (tx) => ...)` をバックグラウンドで
//     起動し、tx の中で `pg_advisory_xact_lock(key)` を取って acquired をシグナル。
//     その後 release プロミスを await して tx を保持し続け、release が解決した
//     瞬間に tx callback が return → tx commit → xact lock 自動解放、という
//     2 段で release を実装する。
//   - tx commit に頼らず明示 `pg_advisory_unlock` を呼ぶ session-lock 派生も
//     考えたが、Prisma の `$queryRaw` は session が pool に戻るタイミングで
//     lock state が次の caller にリークするため採用しない。xact-lock の方が
//     クラッシュ耐性 + プロセス死亡時の自動解放という点でも安全。
//   - tx の timeout は 1 時間 (`DEFAULT_LOCK_HOLD_MS`)。Apply は実運用で 10
//     分以内に収まる想定 (Meta CLI 1 回 ≤ 60s × N actions + retry backoff)。
//     1 時間で fail-closed することで、worker がデッドロック / フリーズした
//     場合も別経路 (web / CLI) が次のロック取得を進められる。
//
// 制約:
//   - production (apps/web, apps/worker, apps/cli) は本実装を必ず注入する。
//   - test seam: `createInProcessAdAccountLockProvider` (in queue) を渡してよい。
//   - 本ファイルは Prisma に直接依存する。queue パッケージは Prisma を import
//     しないため、provider 実装は app (worker) 側に置く設計。
//   - apps/web / apps/cli は package.json 上 `@addroid/worker` 依存を持たない
//     が、既存の activate-runtime.ts と同じ relative import 経路で参照する
//     (apps/cli の activate.ts が同じ pattern を採用している)。

import crypto from "node:crypto";

import {
  createCrossProcessAdAccountLockProvider,
  type AdAccountLockProvider,
} from "@addroid/queue";
import type { PrismaClient } from "@addroid/db";

/**
 * 単一の advisory lock を保持できる最大時間 (ms)。Prisma の `$transaction`
 * timeout に渡す。デフォルト 1 時間。実運用で必要なら `acquireTimeoutMs` で
 * 上書きできるが、production では 30 分〜2 時間の範囲を推奨する。
 */
export const DEFAULT_LOCK_HOLD_MS = 60 * 60 * 1000;

/**
 * Prisma の pool から lock 用 connection を奪うのに待つ最大時間 (ms)。pool が
 * 飽和している場合は fast-fail させる (Apply / Activate を待たせ続けるより、
 * 上位のリトライに任せた方が UX が良い)。
 */
export const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 30 * 1000;

export interface PostgresAdAccountLockOptions {
  /** Prisma client (`@addroid/db` の `prisma` シングルトンを渡す)。 */
  prisma: PrismaClient;
  /** ロック保持時間の上限。default: 60min。 */
  lockHoldMs?: number;
  /** pool から lock 用 connection を取るまでの最大 wait。default: 30s。 */
  acquireWaitMs?: number;
  /** release 失敗時のロガー (token を含めないこと)。 */
  onReleaseError?: (lockKey: string, error: unknown) => void;
  /** acquire 失敗時のロガー (test seam を兼ねる)。 */
  onAcquireError?: (lockKey: string, error: unknown) => void;
}

/**
 * `pg_advisory_xact_lock` を背に持つ cross-process `AdAccountLockProvider`。
 *
 * apps/worker の `runExecuteApply`、apps/web の `executeActivate`、apps/cli の
 * `runActivateCommand` のすべてが本 provider を注入する。同一 (workspaceId,
 * accountKey) からは同じ BIGINT key に解決され、Postgres 側で常に 1 並行が
 * 強制される。
 */
export function createPostgresAdAccountLockProvider(
  options: PostgresAdAccountLockOptions
): AdAccountLockProvider {
  const {
    prisma,
    lockHoldMs = DEFAULT_LOCK_HOLD_MS,
    acquireWaitMs = DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
  } = options;

  return createCrossProcessAdAccountLockProvider({
    acquire: (lockKey: string) =>
      acquirePostgresAdvisoryLock({
        prisma,
        lockKey,
        lockHoldMs,
        acquireWaitMs,
        ...(options.onAcquireError !== undefined
          ? { onAcquireError: options.onAcquireError }
          : {}),
      }),
    ...(options.onReleaseError !== undefined
      ? { onReleaseError: options.onReleaseError }
      : {}),
  });
}

interface AcquireOptions {
  prisma: PrismaClient;
  lockKey: string;
  lockHoldMs: number;
  acquireWaitMs: number;
  onAcquireError?: (lockKey: string, error: unknown) => void;
}

async function acquirePostgresAdvisoryLock(
  opts: AcquireOptions
): Promise<{ release: () => Promise<void> }> {
  const lockId = adAccountLockBigInt(opts.lockKey);

  // tx callback を保持するための制御プロミス。tx の中で lock を取った
  // 瞬間 acquired を resolve し、release が呼ばれるまで released を await する。
  let releaseSignal!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseSignal = resolve;
  });
  let acquireResolve!: () => void;
  let acquireReject!: (err: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    acquireResolve = resolve;
    acquireReject = reject;
  });

  // tx を await せずバックグラウンドで開始する。fn () の実行は本 acquire 関数
  // のスコープ外で起きるため、tx promise を caller に握らせる必要はない。
  const txPromise = opts.prisma
    .$transaction(
      async (tx) => {
        try {
          // BigInt 引数は Prisma 5 の $queryRaw で安全にバインドされる。
          // 明示的な ::bigint cast は driver 側で必要な場合の保険。
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockId}::bigint)`;
        } catch (err) {
          acquireReject(err);
          throw err;
        }
        acquireResolve();
        // release が呼ばれるまで tx を維持。tx callback が return すると
        // Prisma が COMMIT を発行し、xact-lock は自動解放される。
        await released;
      },
      {
        // pool が飽和している場合のみ wait。通常は即時に connection が取れる。
        maxWait: opts.acquireWaitMs,
        // ロック保持時間の上限。実運用上は 1 時間で打ち切ることで、worker
        // フリーズ時に web/cli が新しい lock を取得できるようにする。
        timeout: opts.lockHoldMs,
      }
    )
    .catch((err) => {
      // 取得前 (acquireResolve 前) に reject した場合は acquire 側に伝播済み。
      // 取得後 (release 前) に tx が timeout / 接続断で死んだ場合も、
      // xact-lock は Postgres 側で自動解放されている。release を呼ばれた
      // 際の `await txPromise` で再度 throw されるが、provider 側の
      // `onReleaseError` が吸収する。ここでは unhandledRejection 防止のため
      // 明示的に catch する (再 throw しない)。
      if (opts.onAcquireError) {
        try {
          opts.onAcquireError(opts.lockKey, err);
        } catch {
          /* logger 失敗はこれ以上伝播させない */
        }
      }
      // release が未呼び出しなら、release 待ちの caller を解放する。
      releaseSignal();
      throw err;
    });

  // tx 起動が acquireSignal を resolve するか reject するまで待つ。
  // acquireReject が走ったケースでは下行で throw する。
  try {
    await acquired;
  } catch (err) {
    // tx は既に reject 済みの想定 (acquireReject 経由)。tx promise の
    // settle を待ってから caller に throw を返す (handle leak 回避)。
    try {
      await txPromise;
    } catch {
      /* 既知の reject — caller に伝える前に消費する */
    }
    throw err;
  }

  return {
    release: async () => {
      releaseSignal();
      try {
        await txPromise;
      } catch {
        // tx の終端 reject は acquire / release のいずれかで観測済み。
        // ここで再 throw すると lock の使用者 (apply / activate) に
        // ロック解放失敗を伝播してしまうため吸収する。`createCrossProcessAd
        // AccountLockProvider` の `onReleaseError` が呼ばれているはず。
      }
    },
  };
}

/**
 * lockKey (canonical 文字列) → Postgres BIGINT 用の signed 64-bit BigInt。
 *
 * SHA-256 の先頭 8 バイトを big-endian で読み、>= 2^63 なら 2^64 を引いて
 * signed に正規化する。決定的なため、同じ lockKey からは常に同じ BigInt が
 * 得られる (web/worker/CLI 跨いで衝突しない)。
 *
 * export しているのはユニットテスト用 (実装詳細だが、衝突確認とハッシュ
 * 安定性の検査だけは外部から行いたい)。
 */
export function adAccountLockBigInt(lockKey: string): bigint {
  const hash = crypto.createHash("sha256").update(lockKey).digest();
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) | BigInt(hash[i]!);
  }
  // signed 64-bit に正規化
  if (value >= 1n << 63n) {
    value -= 1n << 64n;
  }
  return value;
}
