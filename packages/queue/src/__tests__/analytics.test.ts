// AdDroid OSS — analytics (breakdowns policy + aggregation) tests.
//
// pure helpers のみを検証する。Prisma / pg-boss / LLM Provider には依存しない。

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BREAKDOWNS_POLICY,
  aggregateInsightsByHierarchy,
  aggregateInsightsRows,
  enabledBreakdownLevels,
  mergeBreakdownsPolicy,
  selectAccountKpiSet,
  type DailyReportInsightsRow,
} from "../index.js";

function row(
  nodeType: DailyReportInsightsRow["nodeType"],
  nodeKey: string,
  overrides: Partial<DailyReportInsightsRow> = {}
): DailyReportInsightsRow {
  return {
    nodeType,
    nodeKey,
    spendMicros: 1_000_000_000n,
    impressions: 1000,
    clicks: 50,
    conversions: 5,
    frequency: 1.5,
    ...overrides,
  };
}

test("DEFAULT_BREAKDOWNS_POLICY enables all 4 levels and account synthesis", () => {
  assert.equal(DEFAULT_BREAKDOWNS_POLICY.fetchAccount, true);
  assert.equal(DEFAULT_BREAKDOWNS_POLICY.fetchCampaign, true);
  assert.equal(DEFAULT_BREAKDOWNS_POLICY.fetchAdset, true);
  assert.equal(DEFAULT_BREAKDOWNS_POLICY.fetchAd, true);
  assert.equal(DEFAULT_BREAKDOWNS_POLICY.synthesizeAccountFromCampaigns, true);
});

test("enabledBreakdownLevels returns levels in canonical order", () => {
  assert.deepEqual(enabledBreakdownLevels(DEFAULT_BREAKDOWNS_POLICY), [
    "account",
    "campaign",
    "adset",
    "ad",
  ]);
  assert.deepEqual(
    enabledBreakdownLevels({
      fetchAccount: false,
      fetchCampaign: true,
      fetchAdset: false,
      fetchAd: true,
      synthesizeAccountFromCampaigns: true,
    }),
    ["campaign", "ad"]
  );
});

test("mergeBreakdownsPolicy fills missing fields from defaults", () => {
  const p = mergeBreakdownsPolicy({ fetchAd: false });
  assert.equal(p.fetchAccount, true);
  assert.equal(p.fetchCampaign, true);
  assert.equal(p.fetchAdset, true);
  assert.equal(p.fetchAd, false);
  assert.equal(p.synthesizeAccountFromCampaigns, true);
});

test("mergeBreakdownsPolicy treats null/undefined as the default policy", () => {
  assert.deepEqual(mergeBreakdownsPolicy(null), {
    ...DEFAULT_BREAKDOWNS_POLICY,
  });
  assert.deepEqual(mergeBreakdownsPolicy(undefined), {
    ...DEFAULT_BREAKDOWNS_POLICY,
  });
});

test("aggregateInsightsRows sums spend / impressions / clicks / conversions", () => {
  const k = aggregateInsightsRows([
    row("campaign", "cmp_a", {
      spendMicros: 500_000_000n,
      impressions: 1_000,
      clicks: 10,
      conversions: 1,
      frequency: 1.0,
    }),
    row("campaign", "cmp_b", {
      spendMicros: 1_500_000_000n,
      impressions: 4_000,
      clicks: 90,
      conversions: 9,
      frequency: 2.0,
    }),
  ]);
  assert.equal(k.spend, 2000); // 500 + 1500 (major)
  assert.equal(k.impressions, 5_000);
  assert.equal(k.clicks, 100);
  assert.equal(k.conversions, 10);
  assert.equal(k.cv, 10);
  assert.equal(k.ctr, 2); // 100 / 5000 * 100
  assert.equal(k.cpc, 20); // 2000 / 100
  assert.equal(k.cpa, 200); // 2000 / 10
  // weighted average frequency: (1.0*1000 + 2.0*4000) / 5000 = 1.8
  assert.equal(k.frequency, 1.8);
});

test("aggregateInsightsRows defends against zero impressions / clicks / conversions", () => {
  const k = aggregateInsightsRows([
    row("ad", "ad_a", {
      spendMicros: 0n,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      frequency: null,
    }),
  ]);
  assert.equal(k.ctr, 0);
  assert.equal(k.cpc, 0);
  assert.equal(k.cpa, 0);
  assert.equal(k.cpm, 0);
  assert.equal(k.frequency, null);
});

test("aggregateInsightsRows ignores rows with impressions=0 when weighting frequency", () => {
  const k = aggregateInsightsRows([
    row("campaign", "cmp_a", {
      impressions: 0,
      clicks: 0,
      conversions: 0,
      frequency: 99, // should not influence the weighted average
    }),
    row("campaign", "cmp_b", {
      impressions: 1_000,
      clicks: 10,
      conversions: 1,
      frequency: 1.5,
    }),
  ]);
  assert.equal(k.frequency, 1.5);
});

test("aggregateInsightsRows returns zero KPIs for empty input", () => {
  const k = aggregateInsightsRows([]);
  assert.equal(k.spend, 0);
  assert.equal(k.impressions, 0);
  assert.equal(k.clicks, 0);
  assert.equal(k.conversions, 0);
  assert.equal(k.frequency, null);
});

test("aggregateInsightsByHierarchy groups rows by nodeType", () => {
  const result = aggregateInsightsByHierarchy([
    row("account", "act_1", { impressions: 10_000 }),
    row("campaign", "cmp_a", { impressions: 6_000 }),
    row("campaign", "cmp_b", { impressions: 4_000 }),
    row("adset", "as_1", { impressions: 5_000 }),
    row("ad", "ad_1", { impressions: 3_000 }),
  ]);
  assert.equal(result.account?.impressions, 10_000);
  assert.equal(result.campaign?.impressions, 10_000); // 6000 + 4000
  assert.equal(result.adset?.impressions, 5_000);
  assert.equal(result.ad?.impressions, 3_000);
  assert.equal(result.accountSource, "fetched");
});

test("aggregateInsightsByHierarchy synthesizes account from campaigns when no account row", () => {
  const result = aggregateInsightsByHierarchy([
    row("campaign", "cmp_a", { impressions: 6_000 }),
    row("campaign", "cmp_b", { impressions: 4_000 }),
  ]);
  assert.equal(result.account?.impressions, 10_000);
  assert.equal(result.accountSource, "synthesized_from_campaigns");
});

test("aggregateInsightsByHierarchy can disable account synthesis", () => {
  const result = aggregateInsightsByHierarchy(
    [row("campaign", "cmp_a")],
    { synthesizeAccountFromCampaigns: false }
  );
  assert.equal(result.account, null);
  assert.equal(result.accountSource, "none");
});

test("selectAccountKpiSet prefers explicit account row when available", () => {
  const sel = selectAccountKpiSet([
    row("account", "act_1", { impressions: 9_999 }),
    row("campaign", "cmp_a", { impressions: 1 }),
  ]);
  assert.equal(sel.source, "account");
  assert.equal(sel.kpis.impressions, 9_999);
});

test("selectAccountKpiSet falls back to campaign aggregation when no account row", () => {
  const sel = selectAccountKpiSet([
    row("campaign", "cmp_a", { impressions: 600 }),
    row("campaign", "cmp_b", { impressions: 400 }),
    row("ad", "ad_1", { impressions: 200 }),
  ]);
  assert.equal(sel.source, "campaign");
  assert.equal(sel.kpis.impressions, 1_000);
});

test("selectAccountKpiSet falls back to adset, then ad, when higher levels missing", () => {
  const adsetSel = selectAccountKpiSet([
    row("adset", "as_1", { impressions: 200 }),
    row("ad", "ad_1", { impressions: 50 }),
  ]);
  assert.equal(adsetSel.source, "adset");
  assert.equal(adsetSel.kpis.impressions, 200);

  const adSel = selectAccountKpiSet([row("ad", "ad_1", { impressions: 50 })]);
  assert.equal(adSel.source, "ad");
  assert.equal(adSel.kpis.impressions, 50);
});

test("selectAccountKpiSet does not synthesize when synthesizeAccountFromCampaigns=false", () => {
  const sel = selectAccountKpiSet(
    [row("campaign", "cmp_a", { impressions: 1_000 })],
    { synthesizeAccountFromCampaigns: false }
  );
  assert.equal(sel.source, "none");
  assert.equal(sel.kpis.impressions, 0);
});

test("selectAccountKpiSet returns ZERO with source='none' when input is empty", () => {
  const sel = selectAccountKpiSet([]);
  assert.equal(sel.source, "none");
  assert.equal(sel.kpis.impressions, 0);
  assert.equal(sel.kpis.spend, 0);
  assert.equal(sel.kpis.frequency, null);
});
