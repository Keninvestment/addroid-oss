// AdDroid OSS — Meta APIレート制限戦略.
//
// Apply / Activate / Insights / pg-boss enqueue から共通で参照する rate-limit
// 戦略の純粋関数群。本モジュールは Prisma / pg-boss / Meta CLI を一切 import せず、
// 値の写像と少数のレジストリ ヘルパに限定する。
//
// 含まれるもの:
//   - DEFAULT_META_RATE_LIMIT_POLICY     : exponential backoff の既定パラメータ
//                                          (cli-runner の retry_with_backoff と一致)
//   - computeBackoffDelayMs              : attempt → delay の純粋関数
//   - buildApplySingletonKey             : pg-boss `send` に渡す singletonKey ビルダ
//   - classifyThrottleSeverity           : MetaThrottleHeaders → "normal/approaching/
//                                          throttled/backoff" の UI バッジ用射影
//   - extractThrottleObservation         : execution_logs payload から UI/監査向け
//                                          サマリを取り出すヘルパ
//
// per-account concurrency=1 (in-process) を保証する mutex (`withAccountLock`)
// もここで定義する — Apply / Activate 双方が同じレジストリを共有することで、
// 同一プロセス内の任意経路から発生する Meta API/CLI コールを ad_account 単位で
// 直列化できる。

import type { JsonValue } from "./store.js";

// ---------------------------------------------------------------------
// Backoff policy
// ---------------------------------------------------------------------

/**
 * Meta API/CLI の throttling に対するリトライ戦略。
 *
 * 値は cli-runner.ts の `recommendActionForExit("rate_limit_error")` と整合させる
 * — Meta CLI 側で個別に backoff を返さない場合のフォールバックとして使う。
 */
export interface MetaRateLimitPolicy {
  /** 初回試行を含む合計試行回数。 */
  maxAttempts: number;
  /** 1 回目のリトライ前に待つ ms。 */
  initialBackoffMs: number;
  /** 2^n でも超えてはならない上限 ms。 */
  maxBackoffMs: number;
  /**
   * バックオフ係数。実装は `initialBackoffMs * factor^(attempt-1)` で計算する
   * (attempt は 1 オリジン: attempt=1 のとき遅延は initialBackoffMs)。
   */
  factor: number;
}

export const DEFAULT_META_RATE_LIMIT_POLICY: MetaRateLimitPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 5_000,
  maxBackoffMs: 60_000,
  factor: 2,
};

/**
 * 試行 attempt (1 オリジン) のあとに待つべき ms を返す純粋関数。
 *
 * - attempt <= 0 の入力は 0ms を返す (後続の `await sleep(0)` を無害化)。
 * - factor^N が overflow しないよう、計算後に必ず `maxBackoffMs` で頭打ちする。
 *
 * 例 (DEFAULT で attempt=1,2,3 → 5000, 10000, 20000)。
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: MetaRateLimitPolicy = DEFAULT_META_RATE_LIMIT_POLICY
): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return 0;
  const exp = Math.pow(policy.factor, attempt - 1);
  const raw = policy.initialBackoffMs * exp;
  if (!Number.isFinite(raw) || raw < 0) return policy.maxBackoffMs;
  return Math.min(policy.maxBackoffMs, Math.floor(raw));
}

// ---------------------------------------------------------------------
// pg-boss singletonKey
// ---------------------------------------------------------------------

/**
 * pg-boss `send(name, data, { singletonKey })` に渡す key を組み立てる。
 *
 * the current implementation 受入要件:
 *   - "Rate limiting enforces ad_account-level concurrency of 1 and backs off
 *      on configured Meta error classes."
 *
 * Apply は per-PR の単位で起動するため、同じ PR に対する重複 enqueue (再 push /
 * 再ポーリング揺らぎ) を抑止するために PR id ベースの key を使うのが自然。
 *
 * 引数:
 *   - `pullRequestId` : 必須。pg-boss は同じ singletonKey で create-while-pending
 *     を弾くため、これだけで「同一 PR について同時に 2 件 queued になる」状況を
 *     防げる。
 *   - `accountKey`    : 任意。同一 PR が複数アカウントを触る場合、key に含めても
 *     PR id が同じであれば実質同等。明示的に "PR + account" 単位で隔離したい
 *     ケースのために受け取れるようにしておく。
 *
 * 出力は ASCII safe (`apply:pr-<id>` または `apply:pr-<id>:acct-<key>`)。
 */
export function buildApplySingletonKey(input: {
  pullRequestId: string;
  accountKey?: string;
}): string {
  const pr = sanitizeKeySegment(input.pullRequestId);
  if (!input.accountKey) return `apply:pr-${pr}`;
  const acct = sanitizeKeySegment(input.accountKey);
  return `apply:pr-${pr}:acct-${acct}`;
}

function sanitizeKeySegment(raw: string): string {
  // pg-boss の singletonKey は文字列ならば何でも受けるが、可観測性のため ASCII
  // safe + 短く保つ。空文字は呼び出し側のプログラムバグのため明示的に "_" に倒す。
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-");
  return cleaned.length > 0 ? cleaned.slice(0, 96) : "_";
}

// ---------------------------------------------------------------------
// Throttle observation (UI / 監査ログ向けサマリ)
// ---------------------------------------------------------------------

/**
 * `MetaThrottleHeaders` (cli-runner) を直接参照しないため、最小の構造的型を
 * 受ける (test seam)。 cli-runner.MetaThrottleHeaders と structurally 互換。
 */
export interface ThrottleHeaderShape {
  businessUseCase?: string;
  appUsage?: string;
  adAccountUsage?: string;
}

/** UI バッジで表示する throttle 重大度。 */
export type ThrottleSeverity = "normal" | "approaching" | "throttled" | "backoff";

/**
 * Meta が返す `X-Business-Use-Case-Usage` / `X-App-Usage` / `X-Ad-Account-Usage`
 * から、UI バッジで表示する severity を導出する。
 *
 * - 80% 以上 → "approaching"
 * - 95% 以上 → "throttled"
 * - estimated_time_to_regain_access > 0 (= 既に block 中) → "backoff"
 *
 * パースに失敗した場合や数値が抽出できない場合は "normal" にフォールバックする。
 * これは「throttle ヘッダが取れていない = まだ Meta API を叩いていない / 健全」
 * という defensive な扱い (API 未連携なのに warn を出すと誤誘導になる)。
 */
export function classifyThrottleSeverity(
  headers: ThrottleHeaderShape | null | undefined
): ThrottleSeverity {
  if (!headers) return "normal";
  const candidates = [headers.businessUseCase, headers.appUsage, headers.adAccountUsage];
  let maxPct = 0;
  let blocked = false;
  for (const raw of candidates) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const parsed = safeParseJson(raw);
    if (!parsed) {
      // 数値が拾えなくても、"estimated_time_to_regain_access" などの文字列ヒントを
      // 大文字小文字無視で素朴に検出する (best-effort)。
      if (/estimated_time_to_regain_access\s*[:=]\s*[1-9]/i.test(raw)) {
        blocked = true;
      }
      continue;
    }
    walkUsage(parsed, (pct, regain) => {
      if (pct > maxPct) maxPct = pct;
      if (regain > 0) blocked = true;
    });
  }
  if (blocked) return "backoff";
  if (maxPct >= 95) return "throttled";
  if (maxPct >= 80) return "approaching";
  return "normal";
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Meta の usage payload は階層形 (`{"123": [{"call_count": 80, ...}]}` 等) で
 * 戻ってくる。深さを問わず、`call_count` / `total_cputime` / `total_time` /
 * `estimated_time_to_regain_access` を拾って visit する。
 */
function walkUsage(
  node: unknown,
  visit: (pct: number, regainSeconds: number) => void
): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walkUsage(child, visit);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const keys = ["call_count", "total_cputime", "total_time"] as const;
    let pct = 0;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        pct = Math.max(pct, v);
      }
    }
    let regain = 0;
    const r = obj.estimated_time_to_regain_access;
    if (typeof r === "number" && Number.isFinite(r) && r > 0) regain = r;
    if (pct > 0 || regain > 0) visit(pct, regain);
    for (const v of Object.values(obj)) walkUsage(v, visit);
  }
}

/**
 * `execution_logs.payload` (cli-runner の `MetaCliExecutionLogInput.payload`) から
 * UI/監査ビュー向けの 1 行サマリを抽出する。
 *
 * 入力が想定構造でない場合は null を返す (例: mock executor の payload)。
 */
export interface ThrottleObservation {
  severity: ThrottleSeverity;
  businessUseCase?: string;
  appUsage?: string;
  adAccountUsage?: string;
}

export function extractThrottleObservation(
  payload: JsonValue | undefined
): ThrottleObservation | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const headers = (payload as { throttleHeaders?: JsonValue }).throttleHeaders;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const h = headers as Record<string, JsonValue>;
  const shape: ThrottleHeaderShape = {};
  if (typeof h.businessUseCase === "string") shape.businessUseCase = h.businessUseCase;
  if (typeof h.appUsage === "string") shape.appUsage = h.appUsage;
  if (typeof h.adAccountUsage === "string") shape.adAccountUsage = h.adAccountUsage;
  if (
    shape.businessUseCase === undefined &&
    shape.appUsage === undefined &&
    shape.adAccountUsage === undefined
  ) {
    return null;
  }
  const severity = classifyThrottleSeverity(shape);
  const out: ThrottleObservation = { severity };
  if (shape.businessUseCase !== undefined) out.businessUseCase = shape.businessUseCase;
  if (shape.appUsage !== undefined) out.appUsage = shape.appUsage;
  if (shape.adAccountUsage !== undefined) out.adAccountUsage = shape.adAccountUsage;
  return out;
}

// ---------------------------------------------------------------------
// Per-account concurrency lock
//
// 単一プロセス内の race を直列化する `withAccountLock` (in-process mutex) と、
// web / worker / CLI を跨いだ cross-process serialization を担う
// `AdAccountLockProvider` の 2 段で構成する。production の web / worker / CLI
// はすべて Postgres advisory lock を使う provider を注入し、テストや
// standalone 実行では in-process provider に倒す。
// ---------------------------------------------------------------------

const accountLocks = new Map<string, Promise<unknown>>();

/**
 * Apply / Activate が共有する canonical ad_account ロック識別子を組み立てる
 *。
 *
 * 受入要件:
 *   - "Rate limiting enforces ad_account-level concurrency of 1"
 *
 * 経緯: Apply 経路は YAML key (`plan.accountKey`) しか手元に持たず、Activate
 * 経路は `ads_hierarchy` 由来の `accountId` (UUID) と `accountKey` を持つ。
 * 両者が `withAccountLock` に異なる文字列を渡すと、同一 ad_account を触る
 * Apply と Activate の並行実行が直列化されず、Meta API に同一 ad_account 宛
 * のバーストを送ってしまう。Prisma `AdAccount` の `@@unique([workspaceId, key])`
 * を canonical 識別子として両経路で共有する。
 *
 * 出力は ASCII safe で `ad_account:ws-<workspaceId>:acct-<accountKey>` 形式。
 * 同一 (workspaceId, accountKey) からは常に同じ文字列が得られ、別アカウント
 * では衝突しない (sanitize は `[A-Za-z0-9_-]+` 以外を `-` に倒す + 96 文字で
 * 切り詰め — Apply singletonKey と同じ規約)。
 */
export function buildAdAccountLockKey(input: {
  workspaceId: string;
  accountKey: string;
}): string {
  const ws = sanitizeKeySegment(input.workspaceId);
  const acct = sanitizeKeySegment(input.accountKey);
  return `ad_account:ws-${ws}:acct-${acct}`;
}

/**
 * canonical lock 識別子ごとに concurrency 1 を強制する mutex。
 *
 * 同一 ad_account に対する並行 Meta API/CLI コールを Apply / Activate を
 * 跨いで直列化する (受入要件 "Rate limiting enforces ad_account-level
 * concurrency of 1")。異なる識別子は独立に並行実行できる。
 *
 * `lockKey` は `buildAdAccountLockKey({ workspaceId, accountKey })` で
 * 組み立てた canonical 識別子を渡す。レガシー呼び出し (任意の文字列) も
 * 受けられるが、Apply と Activate を同一プロセスで運用する限り必ず
 * canonical 識別子を使うこと。
 *
 * 別プロセス間の排他は本契約では要求されない (web/cli/worker は単一マシン
 * 上のローカル運用前提)。同一プロセス内の race を直列化することで、Meta CLI
 * 側の per-account throttle に意図しないバーストを送らないようにする。
 */
export async function withAccountLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
  registry: Map<string, Promise<unknown>> = accountLocks
): Promise<T> {
  const prev = registry.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(() => gate);
  registry.set(lockKey, next);
  try {
    await prev;
  } catch {
    /* 直前ジョブの失敗は次のジョブを阻害しない */
  }
  try {
    return await fn();
  } finally {
    release();
    if (registry.get(lockKey) === next) {
      registry.delete(lockKey);
    }
  }
}

// ---------------------------------------------------------------------
// AdAccountLockProvider — cross-process ad_account 直列化境界
//
// ---------------------------------------------------------------------

/**
 * Apply / Activate が共有する ad_account 単位のロック境界。
 *
 * the current implementation 受入要件:
 *   - "Rate limiting enforces ad_account-level concurrency of 1 ..."
 *
 * 旧実装 (`withAccountLock` の module-local Map) は同一 Node.js プロセス内の
 * race のみを直列化していた。本番では `apps/worker` (Apply 経路)、`apps/web`
 * (Web Activate API)、`apps/cli` (CLI Activate) が独立プロセスで動くため、
 * worker の Apply と Web/CLI の Activate が同じ ad_account の Meta CLI を
 * 並行起動するのを防げない。`AdAccountLockProvider` は Postgres advisory lock
 * 等の外部境界を介して cross-process で 1 並行を強制する射影。
 *
 * 実装は 2 種類:
 *   - `createInProcessAdAccountLockProvider` : テスト / standalone / fallback。
 *   - `createCrossProcessAdAccountLockProvider` : web/worker/CLI が共有する
 *     external boundary (production は Postgres advisory lock) を呼び出す。
 *
 * `lockKey` には `buildAdAccountLockKey({ workspaceId, accountKey })` の
 * canonical 形を渡す。Apply と Activate は同一 (workspaceId, accountKey) で
 * 同じ文字列を生成するため、別経路でも同じ lock identity に解決される。
 */
export interface AdAccountLockProvider {
  /**
   * `lockKey` を取得し、`fn` 実行中保持し、戻りで release する。実装は cross
   * -process 直列化を保証すること。`fn` が throw した場合も lock は必ず解放
   * される (caller 側で finally を書く必要なし)。
   */
  withLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * テスト / standalone 用の in-process 実装。`withAccountLock` を registry を
 * 閉じ込めた状態でラップする。`AdAccountLockProvider` の最低限の契約 (同一
 * key の serial 実行 + 異 key の並行実行) を満たすが、別プロセスとは協調
 * しないため production 経路では使わないこと。
 */
export function createInProcessAdAccountLockProvider(
  registry: Map<string, Promise<unknown>> = new Map()
): AdAccountLockProvider {
  return {
    withLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
      return withAccountLock(lockKey, fn, registry);
    },
  };
}

/**
 * Cross-process 取得/解放境界 (Postgres advisory lock 等) を受け取り、
 * 同一プロセス内の race も `withAccountLock` で先に直列化してから外部
 * 境界に投げる provider を組み立てる。
 *
 * 同一プロセス内に 2 並行の `withLock(sameKey, ...)` が来たとき、in-process
 * mutex を先に通すことで:
 *   - 外部境界 (例: `pg_advisory_xact_lock`) を 1 度ずつ順番に取りに行く
 *   - 別プロセスで保持中なら ↑ の wait は外部境界で発生し、別プロセス
 *     release 後に当プロセス側の 1 件目が進み、続いて 2 件目が進む
 * という 2 段直列化が成り立つ。
 *
 * 引数 `acquire` は lockKey を受け取り、acquire 完了時に `{ release }` を
 * resolve する関数。release 関数は冪等であるべきだが、provider は finally
 * から 1 回しか呼ばないため厳密な冪等性までは要求しない。`fn` が throw
 * しても release は必ず呼ばれる (try/finally で保証)。
 */
export function createCrossProcessAdAccountLockProvider(opts: {
  acquire: (lockKey: string) => Promise<{ release: () => Promise<void> }>;
  /**
   * test seam: in-process 段の registry を共有する。通常は省略し、provider
   * 単位で独立した Map を内蔵する。
   */
  inProcessRegistry?: Map<string, Promise<unknown>>;
  /**
   * release が throw した際の logger (任意)。release の失敗は fn の結果を
   * 上書きしない (in-process mutex は finally で必ず解放されるため、
   * 後続呼び出しは続行可能)。token を含まないこと。
   */
  onReleaseError?: (lockKey: string, error: unknown) => void;
}): AdAccountLockProvider {
  const registry = opts.inProcessRegistry ?? new Map<string, Promise<unknown>>();
  return {
    async withLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
      return withAccountLock(
        lockKey,
        async () => {
          const handle = await opts.acquire(lockKey);
          try {
            return await fn();
          } finally {
            try {
              await handle.release();
            } catch (err) {
              if (opts.onReleaseError) {
                try {
                  opts.onReleaseError(lockKey, err);
                } catch {
                  /* logger 失敗はこれ以上伝播させない */
                }
              }
            }
          }
        },
        registry
      );
    },
  };
}
