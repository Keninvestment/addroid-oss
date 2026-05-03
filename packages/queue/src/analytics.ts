// AdDroid OSS — Analytics: breakdowns policy + aggregation logic
// (Implementation item).
//
// 本モジュールは `performance_snapshots` の analytics 層を 2 つの軸で固定する:
//
//   1. **Breakdowns policy** — 日次 cron / Adhoc から `DailyReportInsightsProvider`
//      に渡す「どの階層を取得するか」の方針。account / campaign / adset / ad の
//      4 階層は契約で要求されており、既定では 4 階層すべてフェッチする。
//      provider が account-level pre-aggregated row を返さない場合、本モジュールの
//      集計関数で campaign 行から合成する (`synthesizeAccountFromCampaigns`).
//
//   2. **Aggregation logic** — 取得済み行 (= insights provider の戻り値、または
//      `performance_snapshots` から読んだ行) を、上位階層の単一 KPI セットに
//      集計する pure helper。Prisma / pg-boss / LLM Provider に依存しない。
//      `daily-report` / `budget-guard` / `improvement-pr` / 将来の analytics
//      ページが共通して利用する。
//
// 設計原則:
//   - 数値合算は BigInt-safe (spend は micros の BigInt、その他は number)。
//   - frequency は加重平均 (impressions ベース) で合成する。impressions=0 の
//     行しかなければ null。frequency は Meta が "平均露出回数" を float で返す
//     値で、単純加算では意味を失うため。
//   - すべての関数は同期 / pure (=副作用なし)。テストは in-memory の配列で完結。
//   - 既存の `toKpiSet` (daily-report.ts) を再利用し、CTR/CPC/CPA/CPM の計算式
//     を二重定義しない。

import {
  toKpiSet,
  type DailyReportInsightsRow,
  type DailyReportKpiSet,
  type DailyReportNodeType,
} from "./daily-report.js";

// ---------------------------------------------------------------------
// Breakdowns policy
// ---------------------------------------------------------------------

/**
 * `BreakdownsPolicy` — Meta insights / Mock provider に対し「どの階層を
 * 取得するか」を表明する設定。account / campaign / adset / ad の 4 階層
 * いずれか 1 つ以上が必須 (= 全部 false にすると insights は空になり、KPI
 * は ZERO 扱いになる)。
 *
 * 契約 (the current implementation):
 *   - daily_report は account / campaign / adset / ad の 4 階層を取得する。
 *   - aggregated campaign-or-higher は 1 年保持される (retention で使用)。
 *   - 90 日経過後は adset/ad 行が削除されるため、長期 trend 分析を出すには
 *     account/campaign 行のみで集計可能なロジックが必要 (本モジュールの
 *     `aggregateInsightsRows` がこれを満たす)。
 *
 * 既定は `DEFAULT_BREAKDOWNS_POLICY` (4 階層すべて true、account 合成も有効)。
 */
export interface BreakdownsPolicy {
  /** account 階層を実フェッチする。 */
  fetchAccount: boolean;
  /** campaign 階層を実フェッチする。 */
  fetchCampaign: boolean;
  /** adset 階層を実フェッチする。 */
  fetchAdset: boolean;
  /** ad 階層を実フェッチする。 */
  fetchAd: boolean;
  /**
   * provider が account 行を返さない場合、campaign 行を合算して account を
   * 合成するか。既定 true。`fetchAccount=false` のときに意味を持つ。
   */
  synthesizeAccountFromCampaigns: boolean;
}

export const DEFAULT_BREAKDOWNS_POLICY: Readonly<BreakdownsPolicy> = Object.freeze({
  fetchAccount: true,
  fetchCampaign: true,
  fetchAdset: true,
  fetchAd: true,
  synthesizeAccountFromCampaigns: true,
});

/** 列挙されている階層 (取得対象) を昇順で返す: account → campaign → adset → ad。 */
export function enabledBreakdownLevels(
  policy: BreakdownsPolicy
): DailyReportNodeType[] {
  const levels: DailyReportNodeType[] = [];
  if (policy.fetchAccount) levels.push("account");
  if (policy.fetchCampaign) levels.push("campaign");
  if (policy.fetchAdset) levels.push("adset");
  if (policy.fetchAd) levels.push("ad");
  return levels;
}

/**
 * `mergeBreakdownsPolicy` — 部分的な上書きを default に重ねて完全な policy を
 * 返す。caller (cron handler / Adhoc CLI / web Server Action) で使う。
 */
export function mergeBreakdownsPolicy(
  override?: Partial<BreakdownsPolicy> | null
): BreakdownsPolicy {
  if (!override) return { ...DEFAULT_BREAKDOWNS_POLICY };
  return {
    fetchAccount: override.fetchAccount ?? DEFAULT_BREAKDOWNS_POLICY.fetchAccount,
    fetchCampaign:
      override.fetchCampaign ?? DEFAULT_BREAKDOWNS_POLICY.fetchCampaign,
    fetchAdset: override.fetchAdset ?? DEFAULT_BREAKDOWNS_POLICY.fetchAdset,
    fetchAd: override.fetchAd ?? DEFAULT_BREAKDOWNS_POLICY.fetchAd,
    synthesizeAccountFromCampaigns:
      override.synthesizeAccountFromCampaigns ??
      DEFAULT_BREAKDOWNS_POLICY.synthesizeAccountFromCampaigns,
  };
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

/**
 * `aggregateInsightsRows` — 同一階層の複数行 (例: account 1 行のみでも、
 * campaign 5 行でも) を 1 つの KPI セットに合算する。
 *
 * 合算ルール:
 *   - spendMicros / impressions / clicks / conversions は単純加算。
 *   - frequency は impressions ベースの加重平均 (impressions=0 の行は無視)。
 *     全行で impressions=0 または frequency 未提供なら null。
 *   - 派生指標 (CTR/CPC/CPA/CPM) は合算後の総量から `toKpiSet` で導出する。
 */
export function aggregateInsightsRows(
  rows: ReadonlyArray<DailyReportInsightsRow>
): DailyReportKpiSet {
  if (rows.length === 0) return ZERO_KPIS_REF;
  let totalSpendMicros = 0n;
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;
  let weightedFrequencyNumerator = 0;
  let weightedFrequencyDenominator = 0;
  for (const row of rows) {
    totalSpendMicros += row.spendMicros;
    totalImpressions += Math.max(0, Math.floor(row.impressions));
    totalClicks += Math.max(0, Math.floor(row.clicks));
    totalConversions += Math.max(0, Math.floor(row.conversions));
    if (
      typeof row.frequency === "number" &&
      Number.isFinite(row.frequency) &&
      row.impressions > 0
    ) {
      weightedFrequencyNumerator += row.frequency * row.impressions;
      weightedFrequencyDenominator += row.impressions;
    }
  }
  const frequency =
    weightedFrequencyDenominator > 0
      ? weightedFrequencyNumerator / weightedFrequencyDenominator
      : null;
  return toKpiSet({
    nodeType: rows[0]!.nodeType,
    nodeKey: "_aggregate",
    spendMicros: totalSpendMicros,
    impressions: totalImpressions,
    clicks: totalClicks,
    conversions: totalConversions,
    frequency,
  });
}

/** ZERO 値の参照 (toKpiSet がゼロ入力で返すのと同等)。  */
const ZERO_KPIS_REF: DailyReportKpiSet = Object.freeze({
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  ctr: 0,
  cpc: 0,
  cpa: 0,
  cv: 0,
  cpm: 0,
  frequency: null,
}) as DailyReportKpiSet;

/**
 * `aggregateInsightsByHierarchy` — 行配列を nodeType ごとに分割し、それぞれ
 * `aggregateInsightsRows` で合算した KPI を返す。analytics ページ /
 * /reports/[id] の "hierarchy 別 breakdown" 表示に使える形。
 *
 * `synthesizeAccountFromCampaigns=true` で `account=null` のとき、campaign
 * 集計から account を合成する (`fetchAccount=false` の policy で daily_report
 * が account-level KPI を欠かないために必要)。
 */
export function aggregateInsightsByHierarchy(
  rows: ReadonlyArray<DailyReportInsightsRow>,
  options?: { synthesizeAccountFromCampaigns?: boolean }
): {
  account: DailyReportKpiSet | null;
  campaign: DailyReportKpiSet | null;
  adset: DailyReportKpiSet | null;
  ad: DailyReportKpiSet | null;
  /** account が直接フェッチされた値か、合成されたか。 */
  accountSource: "fetched" | "synthesized_from_campaigns" | "none";
} {
  const byType: Record<DailyReportNodeType, DailyReportInsightsRow[]> = {
    account: [],
    campaign: [],
    adset: [],
    ad: [],
  };
  for (const r of rows) {
    byType[r.nodeType]?.push(r);
  }
  const account =
    byType.account.length > 0 ? aggregateInsightsRows(byType.account) : null;
  const campaign =
    byType.campaign.length > 0 ? aggregateInsightsRows(byType.campaign) : null;
  const adset =
    byType.adset.length > 0 ? aggregateInsightsRows(byType.adset) : null;
  const ad = byType.ad.length > 0 ? aggregateInsightsRows(byType.ad) : null;

  let finalAccount = account;
  let accountSource: "fetched" | "synthesized_from_campaigns" | "none" =
    account ? "fetched" : "none";
  if (
    !finalAccount &&
    (options?.synthesizeAccountFromCampaigns ?? true) &&
    campaign
  ) {
    finalAccount = campaign;
    accountSource = "synthesized_from_campaigns";
  }
  return {
    account: finalAccount,
    campaign,
    adset,
    ad,
    accountSource,
  };
}

/**
 * `selectAccountKpiSet` — daily_report が KPI deltas を計算する際に使う
 * 「最も信頼できる account-level 集計」を 1 つだけ返す convenience wrapper。
 *
 * 優先順位:
 *   1. 明示的な account 行 (= provider が pre-aggregated を返した)
 *   2. campaign 行を policy.synthesizeAccountFromCampaigns に従って合算
 *   3. adset 行を合算 (campaign すら無い場合のフォールバック)
 *   4. ad 行を合算 (最終フォールバック)
 *   5. それも無ければ ZERO
 *
 * 4 → 5 のフォールバックは Meta が稀に返す「ad 行のみ」のケースで KPI が 0
 * になるのを防ぐため。budget_guard の "fail-closed" とは別レイヤの責務。
 */
export function selectAccountKpiSet(
  rows: ReadonlyArray<DailyReportInsightsRow>,
  options?: { synthesizeAccountFromCampaigns?: boolean }
): {
  kpis: DailyReportKpiSet;
  source: "account" | "campaign" | "adset" | "ad" | "none";
} {
  if (rows.length === 0) return { kpis: ZERO_KPIS_REF, source: "none" };
  const synthesize = options?.synthesizeAccountFromCampaigns ?? true;
  const account = rows.filter((r) => r.nodeType === "account");
  if (account.length > 0) {
    return { kpis: aggregateInsightsRows(account), source: "account" };
  }
  if (synthesize) {
    const campaign = rows.filter((r) => r.nodeType === "campaign");
    if (campaign.length > 0) {
      return { kpis: aggregateInsightsRows(campaign), source: "campaign" };
    }
    const adset = rows.filter((r) => r.nodeType === "adset");
    if (adset.length > 0) {
      return { kpis: aggregateInsightsRows(adset), source: "adset" };
    }
    const ad = rows.filter((r) => r.nodeType === "ad");
    if (ad.length > 0) {
      return { kpis: aggregateInsightsRows(ad), source: "ad" };
    }
  }
  return { kpis: ZERO_KPIS_REF, source: "none" };
}
