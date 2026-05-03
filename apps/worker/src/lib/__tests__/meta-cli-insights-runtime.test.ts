import test from "node:test";
import assert from "node:assert/strict";
import { MetaCliDailyReportInsightsProvider } from "../meta-cli-insights-runtime.js";
import type { MetaCliInvocation } from "@addroid/meta-adapter";

test("MetaCliDailyReportInsightsProvider parses CLI JSON rows into daily report rows", async () => {
  const invocations: MetaCliInvocation[] = [];
  const provider = new MetaCliDailyReportInsightsProvider({
    runner: {
      async run(invocation) {
        invocations.push(invocation);
        return {
          exitCode: 0,
          signal: null,
          exitClass: "success",
          stdout: JSON.stringify({
            data: [
              {
                campaign_id: "cmp_1",
                campaign_name: "Campaign 1",
                spend: "123.45",
                impressions: "1000",
                clicks: "50",
                actions: [{ action_type: "purchase", value: "2" }],
                frequency: "1.2",
              },
            ],
          }),
          stderr: "",
          sanitizedCommand: "meta --output json ads insights get",
          sanitizedArgs: invocation.args,
          throttleHeaders: null,
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(0).toISOString(),
          timedOut: false,
          accountKey: invocation.accountKey,
          binary: "meta",
          recommendedAction: {
            kind: "none",
            retry: false,
            notify: "none",
            logLevel: "info",
            reason: "success",
          },
        };
      },
    },
    resolveAdAccountId: async () => "act_123",
  });

  const result = await provider.fetchInsights({
    accountKey: "primary",
    metricDate: "2026-05-04",
    includePriorPeriod: false,
    breakdownsPolicy: {
      fetchAccount: false,
      fetchCampaign: true,
      fetchAdset: false,
      fetchAd: false,
      synthesizeAccountFromCampaigns: true,
    },
  });

  assert.equal(result.source, "meta_ads_cli");
  assert.equal(result.current.length, 1);
  assert.equal(result.current[0]!.nodeType, "campaign");
  assert.equal(result.current[0]!.nodeKey, "cmp_1");
  assert.equal(result.current[0]!.spendMicros, 123450000n);
  assert.equal(result.current[0]!.conversions, 2);
  assert.equal(invocations[0]!.adAccountId, "act_123");
  assert.deepEqual(invocations[0]!.args.slice(0, 5), [
    "--output",
    "json",
    "ads",
    "insights",
    "get",
  ]);
});
