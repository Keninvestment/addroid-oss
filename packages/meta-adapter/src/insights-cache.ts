// AdDroid OSS — Meta Insights / read-only API in-memory cache
//.
//
// Meta Marketing API のレート制限戦略の一部として、`/campaigns` UI / Account 表示
// / Plan サマリ等が同じ tick 内で繰り返し叩く Insights / list / get 系の応答を
// per-account TTL キャッシュで覆う。短時間の重複呼び出しによる x-business-use-case-usage
// 消費を抑え、throttle 入りを遅らせる。
//
// 設計方針:
//   - process-local in-memory のみ (web / cli / worker は単一マシン上のローカル運用)。
//   - mutate 系 (apply / activate / create / update) は **キャッシュしない**。
//     呼び出し側が `bypass: true` を渡せば fetcher を直接実行する。
//   - 同一 key への並行 fetch は 1 つにまとめる (in-flight dedupe)。
//   - 失敗 (fetcher が throw) は **キャッシュしない**: 次回呼び出し時に再試行する。
//   - クロックは `Date.now` を default で使い、テストは `clock` を注入できる。

export interface MetaInsightsCacheOptions {
  /** 1 entry の存続 ms。既定 5 分。0 以下を渡すと "TTL なし" 扱いはせず、最低 1ms に倒す。 */
  defaultTtlMs?: number;
  /** test seam: 現在時刻を返す関数。 */
  clock?: () => number;
  /** test seam: キャッシュエントリ数の上限 (LRU 風の単純な FIFO で頭打ち)。既定 256。 */
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface InsightsCacheGetOptions<T> {
  /**
   * このキーの値を取得する fetcher。キャッシュミス時にのみ呼ばれる。
   *
   * 失敗 (throw) はキャッシュされない — 次回 get で再実行される。
   * これは Meta API の transient エラー (5xx / network 切断) を recovery 不能な
   * 「成功扱い」に倒さないための fail-safe。
   */
  fetch: () => Promise<T>;
  /** このエントリ専用の TTL ms。省略時は `defaultTtlMs`。 */
  ttlMs?: number;
  /**
   * true のとき、キャッシュを完全にバイパスして fetcher を実行する。
   * 結果はキャッシュにも書かない。mutate 経路から「直近 read を無視したい」
   * 場合に使う。
   */
  bypass?: boolean;
  /**
   * true のとき、エントリが存在しても無視して fetcher を実行し、結果でキャッシュを
   * 上書きする。Insights 強制再取得 (UI の "更新" ボタン等) で使う。
   */
  refresh?: boolean;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

/**
 * Per-account / per-query の TTL 付き値キャッシュ。
 *
 * - `key`: 呼び出し側 (`buildInsightsCacheKey` を推奨) が組み立てる安定キー。
 * - 同一 key に対する並行 `get` は in-flight Promise を共有 (= dedupe)。
 *
 * 本クラスは Prisma / fetch / Meta CLI を一切 import しないため、ユニットテストは
 * 任意の同期/非同期 fetcher を渡して挙動を検証できる。
 */
export class MetaInsightsCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;
  private readonly maxEntries: number;

  constructor(opts: MetaInsightsCacheOptions = {}) {
    const ttl = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.defaultTtlMs = ttl > 0 ? ttl : 1;
    this.clock = opts.clock ?? Date.now;
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /**
   * 値を取得する。キャッシュにあれば即返し、無ければ fetcher を呼ぶ。
   *
   * - `bypass: true` → fetcher を呼び、結果を返すがキャッシュには書かない。
   * - `refresh: true` → 既存エントリを破棄し fetcher で再計算 + キャッシュ。
   *
   * 同一 key への並行 get は in-flight Promise を共有する (dedupe)。
   */
  async get<T>(key: string, opts: InsightsCacheGetOptions<T>): Promise<T> {
    if (opts.bypass) {
      return opts.fetch();
    }
    const now = this.clock();
    if (!opts.refresh) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        return cached.value as T;
      }
      // 期限切れエントリは即削除 (size accounting を素直にする)
      if (cached) this.entries.delete(key);
    } else {
      this.entries.delete(key);
    }
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<T>;

    const ttl = opts.ttlMs ?? this.defaultTtlMs;
    const promise = (async () => {
      try {
        const value = await opts.fetch();
        this.evictIfFull();
        this.entries.set(key, { value, expiresAt: this.clock() + Math.max(1, ttl) });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** key に対するキャッシュを無効化する (mutate 後に呼ぶ想定)。 */
  invalidate(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  /** prefix にマッチする全 key を無効化する (例: account 単位の一括 invalidate)。 */
  invalidateByPrefix(prefix: string): number {
    let removed = 0;
    for (const k of Array.from(this.entries.keys())) {
      if (k.startsWith(prefix)) {
        this.entries.delete(k);
        removed++;
      }
    }
    for (const k of Array.from(this.inflight.keys())) {
      if (k.startsWith(prefix)) {
        this.inflight.delete(k);
      }
    }
    return removed;
  }

  /** 全エントリ削除 (テスト / shutdown 用)。 */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /** デバッグ / 監視用: 現在のエントリ件数。 */
  size(): number {
    return this.entries.size;
  }

  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    // 単純な FIFO eviction: Map は挿入順を保つので最初の key を捨てる。
    const firstKey = this.entries.keys().next().value;
    if (typeof firstKey === "string") this.entries.delete(firstKey);
  }
}

/**
 * Insights 等のキャッシュキーを安定的に組み立てる。
 *
 * 形式: `<scope>:<accountKey>:<query>` (query は必要に応じて呼び出し側で
 * `:` 区切りで追加する)。
 *
 * 例:
 *   buildInsightsCacheKey({ scope: "campaigns_list", accountKey: "primary" })
 *     → "insights:campaigns_list:primary"
 *   buildInsightsCacheKey({ scope: "insights", accountKey: "primary", query: "campaign:cmp_1:30d" })
 *     → "insights:insights:primary:campaign:cmp_1:30d"
 */
export function buildInsightsCacheKey(input: {
  scope: string;
  accountKey: string;
  query?: string;
}): string {
  const parts = ["insights", input.scope, input.accountKey];
  if (input.query) parts.push(input.query);
  return parts
    .map((p) => p.replace(/[^A-Za-z0-9_:.-]+/g, "-"))
    .join(":");
}
